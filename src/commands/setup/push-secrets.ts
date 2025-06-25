import { confirm, input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import * as yaml from 'js-yaml'
import { exec, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { YAML_DUMP_OPTIONS } from '../../config/constants.js'

const execAsync = promisify(exec)

interface SecretService {
  pushSecrets(cubesignerOnly?: boolean): Promise<void>
}

class AWSSecretService implements SecretService {
  private overrideAll: boolean = false

  constructor(private region: string, private prefixName: string, private debug: boolean) { }

  async pushSecrets(cubesignerOnly: boolean = false): Promise<void> {
    const secretsDir = path.join(process.cwd(), 'secrets');

    if (cubesignerOnly) {
      // Only process cubesigner-signer-N-session.json files
      const sessionFiles = fs.readdirSync(secretsDir).filter((file) =>
        file.match(/^cubesigner-signer-\d+-session\.json$/)
      );

      if (sessionFiles.length === 0) {
        console.log(chalk.yellow('No cubesigner-signer-N-session.json files found in secrets directory'))
        return
      }

      for (const file of sessionFiles) {
        const secretName = path.basename(file, '.json')
        console.log(chalk.cyan(`Processing CubeSigner session secret: ${secretName}`))
        const content = await fs.promises.readFile(path.join(secretsDir, file), 'utf8')
        await this.createOrUpdateSecret({ 'session.json': content }, secretName)
      }
      return
    }

    // Process JSON files
    const jsonFiles = fs.readdirSync(secretsDir).filter((file) => file.endsWith('.json'));
    for (const file of jsonFiles) {
      const secretName = path.basename(file, '.json')

      console.log(chalk.cyan(`Processing JSON secret: ${secretName}`))
      const content = await fs.promises.readFile(path.join(secretsDir, file), 'utf8')

      let propertyName: string;
      if (secretName.endsWith('-session')) {
        propertyName = 'session.json'
      } else if (secretName.endsWith('-migrate-db')) {
        propertyName = 'migrate-db.json'
      } else if (secretName == 'rollup-explorer-backend-secret') {
        propertyName = "config.json";
      }
      else {
        // Fallback or error for unknown JSON file types if necessary
        // For now, we assume other JSONs might not follow this specific property naming
        console.warn(chalk.yellow(`Unknown JSON file type for property naming: ${secretName}. Using file name as property.`));
        propertyName = file; // Or handle as an error
      }
      await this.createOrUpdateSecret({ [propertyName]: content }, secretName)
    }

    // Process ENV files
    const envFiles = fs.readdirSync(secretsDir).filter((file) => file.endsWith('.env'))
    const l2SequencerSecrets: Record<string, string> = {}

    for (const file of envFiles) {
      const baseName = path.basename(file, '.env')
      const secretName = `${baseName}-env`
      console.log(chalk.cyan(`Processing ENV secret: ${secretName}`))
      const data = await this.convertEnvToDict(path.join(secretsDir, file))
      await this.createOrUpdateSecret(data, secretName)

      // Special handling for l2-sequencer-N-secret.env files
      // if (/^l2-sequencer-\d+-secret$/.test(baseName)) {
      //   const sequencerIndex = baseName.match(/l2-sequencer-(\d+)-secret/)?.[1] || '0'

      //   // we should use unified secret name for all sequencer instances like CHARTNAME-N-SECRET-ENV for mutilple instances
      //   const secretName = `l2-sequencer-${sequencerIndex}-secret-env`

      //   console.log(chalk.cyan(`Processing L2 Sequencer secret: ${secretName}`))
      //   const data = await this.convertEnvToDict(path.join(secretsDir, file))
      //   await this.createOrUpdateSecret(data, secretName)

      //   // Also add to combined secret with index suffix for backward compatibility
      //   for (const [key, value] of Object.entries(data)) {
      //     // If key already has index suffix, use it as is, otherwise add index suffix
      //     if (key.endsWith(`_${sequencerIndex}`)) {
      //       l2SequencerSecrets[key] = value
      //     } else {
      //       l2SequencerSecrets[`${key}_${sequencerIndex}`] = value
      //     }
      //   }
      // } else 
      // {
      //   //`secretName` is env file name. And the path of this secret is prefix/secretName
      //   // foo.env
      //   // prefix: hello
      //   // external manager file path: hello/foo-env

      //   const secretName = `${baseName}-env`
      //   console.log(chalk.cyan(`Processing ENV secret: ${secretName}`))
      //   const data = await this.convertEnvToDict(path.join(secretsDir, file))
      //   await this.createOrUpdateSecret(data, secretName)
      // }

    }

    // Push combined L2 Sequencer secrets
    // if (Object.keys(l2SequencerSecrets).length > 0) {
    //   console.log(chalk.cyan(`Processing combined L2 Sequencer secrets: l2-sequencer-secret-env`))
    //   await this.createOrUpdateSecret(l2SequencerSecrets, 'l2-sequencer-secret-env')
    // }
  }

  private async convertEnvToDict(filePath: string): Promise<Record<string, string>> {
    const content = await fs.promises.readFile(filePath, 'utf8')
    const result: Record<string, string> = {}

    const lines = content.split('\n')
    for (const line of lines) {
      const match = line.match(/^([^=]+)=(.*)$/)
      if (match) {
        const key = match[1].trim()
        let value = match[2].trim()
        value = value.replace(/^["'](.*)["']$/, '$1')
        result[key] = value
      }
    }

    return result
  }

  private async createOrUpdateSecret(content: Record<string, string>, secretName: string): Promise<void> {
    const fullSecretName = `${this.prefixName}/${secretName}`
    const jsonContent = JSON.stringify(content)
    const escapedJsonContent = jsonContent.replaceAll("'", "'\\''")
    if (!jsonContent) {
      console.log(chalk.red(`Skipping secret: ${secretName} because it is empty`))
      return
    }

    if (await this.secretExists(secretName)) {
      if (this.overrideAll) {
        console.log(chalk.yellow(`Overriding existing secret: ${fullSecretName} (ALL mode)`))
      } else {
        const shouldOverride = await select({
          choices: [
            { name: 'Yes', value: 'yes' },
            { name: 'No', value: 'no' },
            { name: 'Yes to ALL', value: 'all' },
          ],
          message: chalk.yellow(`Secret ${fullSecretName} already exists. Do you want to override it?`),
        })

        if (shouldOverride === 'no') {
          console.log(chalk.yellow(`Skipping secret: ${fullSecretName}`))
          return
        }

        if (shouldOverride === 'all') {
          this.overrideAll = true
          console.log(chalk.yellow('Will override all existing secrets from now on.'))
        }
      }

      const command = `aws secretsmanager put-secret-value --secret-id "${fullSecretName}" --secret-string '${escapedJsonContent}' --region ${this.region}`
      if (this.debug) {
        console.log(chalk.yellow('--- Debug Output ---'))
        console.log(chalk.cyan(`Command: ${command}`))
        console.log(chalk.yellow('-------------------'))
      }

      try {
        await execAsync(command)
        console.log(chalk.green(`Successfully updated secret: ${fullSecretName}`))
      } catch (error) {
        console.error(chalk.red(`Failed to update secret: ${fullSecretName}`))
        console.error(chalk.red(`Error details: ${error}`))
        throw error
      }
    } else {
      const command = `aws secretsmanager create-secret --name "${fullSecretName}" --secret-string '${escapedJsonContent}' --region ${this.region}`
      if (this.debug) {
        console.log(chalk.yellow('--- Debug Output ---'))
        console.log(chalk.cyan(`Command: ${command}`))
        console.log(chalk.yellow('-------------------'))
      }

      try {
        await execAsync(command)
        console.log(chalk.green(`Successfully created secret: ${fullSecretName}`))
      } catch (error) {
        console.error(chalk.red(`Failed to create secret: ${fullSecretName}`))
        console.error(chalk.red(`Error details: ${error}`))
        throw error
      }
    }
  }

  private async secretExists(secretName: string): Promise<boolean> {
    const fullSecretName = `${this.prefixName}/${secretName}`
    try {
      await execAsync(`aws secretsmanager describe-secret --secret-id "${fullSecretName}" --region ${this.region}`)
      return true
    } catch (error: any) {
      if (error.message.includes('ResourceNotFoundException')) {
        return false
      }

      throw error
    }
  }

  // private async processRollupExplorerBackendConfigSecret(secretsDir: string): Promise<void> {
  //   const fileName = 'rollup-explorer-backend.json';
  //   const filePath = path.join(secretsDir, fileName);

  //   if (fs.existsSync(filePath)) {
  //     const propertyKey = 'config.json';
  //     const secretManagerName = 'rollup-explorer-backend';
  //     console.log(chalk.cyan(`Processing special JSON secret: ${this.prefixName}/${secretManagerName} from ${fileName}`));
  //     const contentString = await fs.promises.readFile(filePath, 'utf8');

  //     if (!contentString.trim()) {
  //       console.log(chalk.red(`Skipping secret: ${secretManagerName} from ${fileName} because it is empty`));
  //       return;
  //     }
  //     await this.createOrUpdateSecret({ [propertyKey]: contentString }, secretManagerName);
  //   } else {
  //     if (this.debug) {
  //       console.log(chalk.yellow(`File ${fileName} not found in secrets directory. Skipping its specific processing.`));
  //     }
  //   }
  // }
}

class HashicorpVaultDevService implements SecretService {
  private debug: boolean
  private pathPrefix: string
  private overrideAll: boolean = false

  constructor(debug: boolean, pathPrefix: string = 'scroll') {
    this.debug = debug
    this.pathPrefix = pathPrefix
  }

  async pushSecrets(cubesignerOnly: boolean = false): Promise<void> {
    if (!(await this.isVaultPodRunning())) {
      console.log(chalk.yellow('Vault pod is not running. Please install Vault using the following commands:'))
      console.log(chalk.cyan('helm repo add hashicorp https://helm.releases.hashicorp.com'))
      console.log(chalk.cyan('helm repo update'))
      console.log(chalk.cyan('helm install vault hashicorp/vault --set "server.dev.enabled=true"'))
      console.log(chalk.yellow('After installing Vault, please run this command again.'))
      return
    }

    // Check if the KV secrets engine is already enabled
    const isEnabled = await this.isSecretEngineEnabled(this.pathPrefix)
    if (isEnabled) {
      console.log(chalk.yellow(`KV secrets engine already enabled at path '${this.pathPrefix}'`))
    } else {
      // Enable the KV secrets engine only if it's not already enabled
      try {
        await this.runCommand(`vault secrets enable -path=${this.pathPrefix} kv-v2`)
        console.log(chalk.green(`KV secrets engine enabled at path '${this.pathPrefix}'`))
      } catch (error: unknown) {
        if (error instanceof Error) {
          // If the error is about the path already in use, we can ignore it
          if (!error.message.includes(`path is already in use at ${this.pathPrefix}/`)) {
            throw error
          }

          console.log(chalk.yellow(`KV secrets engine already enabled at path '${this.pathPrefix}'`))
        } else {
          // If it's not an Error instance, rethrow it
          throw error
        }
      }
    }

    const secretsDir = path.join(process.cwd(), 'secrets');

    if (cubesignerOnly) {
      // Only process cubesigner-signer-N-session.json files
      const sessionFiles = fs.readdirSync(secretsDir).filter((file) =>
        file.match(/^cubesigner-signer-\d+-session\.json$/)
      );

      if (sessionFiles.length === 0) {
        console.log(chalk.yellow('No cubesigner-signer-N-session.json files found in secrets directory'))
        return
      }

      for (const file of sessionFiles) {
        const secretName = path.basename(file, '.json')
        console.log(chalk.cyan(`Processing CubeSigner session secret: ${this.pathPrefix}/${secretName}`))
        const content = await fs.promises.readFile(path.join(secretsDir, file), 'utf8')
        await this.pushJsonToVault(secretName, content, 'session.json')
      }

      console.log(chalk.green('All CubeSigner session secrets have been processed and populated in Vault.'))
      return
    }

    await this.processRollupExplorerBackendConfigSecret(secretsDir);

    // Process JSON files
    const jsonFiles = fs.readdirSync(secretsDir).filter((file) => file.endsWith('.json') && file !== 'rollup-explorer-backend-secret.json');
    for (const file of jsonFiles) {
      const secretName = path.basename(file, '.json')

      console.log(chalk.cyan(`Processing JSON secret: ${this.pathPrefix}/${secretName}`))
      const content = await fs.promises.readFile(path.join(secretsDir, file), 'utf8')

      let propertyName: string;
      if (secretName.endsWith('-session')) {
        propertyName = 'session.json'
      } else if (secretName.endsWith('-migrate-db')) {
        propertyName = 'migrate-db.json'
      } else {
        // Fallback or error for unknown JSON file types if necessary
        console.warn(chalk.yellow(`Unknown JSON file type for property naming: ${secretName}. Using file name as property.`));
        propertyName = file; // Or handle as an error
      }
      await this.pushJsonToVault(secretName, content, propertyName)
    }

    // Process ENV files
    const envFiles = fs.readdirSync(secretsDir).filter((file) => file.endsWith('.env'))
    // const l2SequencerSecrets: Record<string, string> = {}

    for (const file of envFiles) {
      const baseName = path.basename(file, '.env')
      const secretName = `${baseName}-env`
      console.log(chalk.cyan(`Processing ENV secret: ${this.pathPrefix}/${secretName}`))
      const data = await this.convertEnvToDict(path.join(secretsDir, file))
      await this.pushToVault(secretName, data)

      // I don't know why combine all sequencer secrets, but it is not safe to do so, so I just comment it out
      // Special handling for l2-sequencer-N-secret.env files
      // if (/^l2-sequencer-\d+-secret$/.test(baseName)) {
      //   const sequencerIndex = baseName.match(/l2-sequencer-(\d+)-secret/)?.[1] || '0'
      //   const secretName = `l2-sequencer-${sequencerIndex}-secret-env`

      //   console.log(chalk.cyan(`Processing L2 Sequencer secret: ${this.pathPrefix}/${secretName}`))
      //   const data = await this.convertEnvToDict(path.join(secretsDir, file))
      //   await this.pushToVault(secretName, data)

      //   // Also add to combined secret with index suffix for backward compatibility
      //   for (const [key, value] of Object.entries(data)) {
      //     // If key already has index suffix, use it as is, otherwise add index suffix
      //     if (key.endsWith(`_${sequencerIndex}`)) {
      //       l2SequencerSecrets[key] = value
      //     } else {
      //       l2SequencerSecrets[`${key}_${sequencerIndex}`] = value
      //     }
      //   }
      // } else {
      //   const secretName = `${baseName}-env`
      //   console.log(chalk.cyan(`Processing ENV secret: ${this.pathPrefix}/${secretName}`))
      //   const data = await this.convertEnvToDict(path.join(secretsDir, file))
      //   await this.pushToVault(secretName, data)
      // }
    }

    // Push combined L2 Sequencer secrets for backward compatibility
    // if (Object.keys(l2SequencerSecrets).length > 0) {
    //   console.log(chalk.cyan(`Processing combined L2 Sequencer secrets: ${this.pathPrefix}/l2-sequencer-secret-env`))
    //   await this.pushToVault('l2-sequencer-secret-env', l2SequencerSecrets)
    // }

    console.log(chalk.green('All secrets have been processed and populated in Vault.'))
  }

  private async convertEnvToDict(filePath: string): Promise<Record<string, string>> {
    const content = await fs.promises.readFile(filePath, 'utf8')
    const result: Record<string, string> = {}

    const lines = content.split('\n')
    for (const line of lines) {
      const match = line.match(/^([^=]+)=(.*)$/)
      if (match) {
        const key = match[1].trim()
        let value = match[2].trim()

        // Remove surrounding quotes if present
        value = value.replace(/^["'](.*)["']$/, '$1')

        result[key] = value
      }
    }

    return result
  }

  private async isSecretEngineEnabled(path: string): Promise<boolean> {
    try {
      const output = await this.runCommand(`vault secrets list -format=json`)
      const secretsList = JSON.parse(output)
      return path + '/' in secretsList
    } catch (error) {
      console.error(chalk.red(`Error checking if secret engine is enabled: ${error}`))
      return false
    }
  }

  private async isVaultPodRunning(): Promise<boolean> {
    try {
      await execAsync('kubectl get pod vault-0')
      return true
    } catch {
      return false
    }
  }

  private async processRollupExplorerBackendConfigSecret(secretsDir: string): Promise<void> {
    const fileName = 'rollup-explorer-backend-secret.json';
    const filePath = path.join(secretsDir, fileName);

    if (fs.existsSync(filePath)) {
      const secretManagerName = 'rollup-explorer-backend-secret';
      const propertyKey = 'config.json';
      console.log(chalk.cyan(`Processing special JSON secret: ${this.pathPrefix}/${secretManagerName} from ${fileName}`));
      const contentString = await fs.promises.readFile(filePath, 'utf8');

      if (!contentString.trim()) {
        console.log(chalk.red(`Skipping secret: ${secretManagerName} from ${fileName} because it is empty`));
        return;
      }
      await this.pushJsonToVault(secretManagerName, contentString, propertyKey);
    } else {
      if (this.debug) {
        console.log(chalk.yellow(`File ${fileName} not found in secrets directory. Skipping its specific processing.`));
      }
    }
  }

  private async pushJsonToVault(secretName: string, content: string, propertyName: string): Promise<void> {
    try {
      const jsonContent = JSON.parse(content)
      const escapedJson = JSON.stringify(jsonContent).replaceAll("'", "'\\''")
      const command = `vault kv put ${this.pathPrefix}/${secretName} ${propertyName}='${escapedJson}'`

      if (this.debug) {
        console.log(chalk.yellow('--- Debug Output ---'))
        console.log(chalk.cyan(`Secret Name: ${secretName}`))
        console.log(chalk.cyan(`Command: ${command}`))
        console.log(chalk.yellow('-------------------'))
      }

      if (!jsonContent) {
        console.log(chalk.red(`Skipping secret: ${secretName} because it is empty`))
        return
      }

      // Check if secret exists
      try {
        await this.runCommand(`vault kv get ${this.pathPrefix}/${secretName}`)
        // Secret exists, ask for override
        if (this.overrideAll) {
          console.log(chalk.yellow(`Overriding existing secret: ${this.pathPrefix}/${secretName} (ALL mode)`))
        } else {
          const shouldOverride = await select({
            choices: [
              { name: 'Yes', value: 'yes' },
              { name: 'No', value: 'no' },
              { name: 'Yes to ALL', value: 'all' },
            ],
            message: chalk.yellow(`Secret ${this.pathPrefix}/${secretName} already exists. Do you want to override it?`),
          })

          if (shouldOverride === 'no') {
            console.log(chalk.yellow(`Skipping secret: ${this.pathPrefix}/${secretName}`))
            return
          }

          if (shouldOverride === 'all') {
            this.overrideAll = true
            console.log(chalk.yellow('Will override all existing secrets from now on.'))
          }
        }
      } catch {
        // Secret doesn't exist, continue with creation
      }

      await this.runCommand(command)
      console.log(
        chalk.green(`Successfully pushed JSON secret: ${this.pathPrefix}/${secretName} with property ${propertyName}`),
      )
    } catch (error) {
      console.error(chalk.red(`Failed to push JSON secret: ${this.pathPrefix}/${secretName}`))
      console.error(chalk.red(`Error: ${error}`))
    }
  }

  private async pushToVault(secretName: string, data: Record<string, string>): Promise<void> {
    const kvPairs = Object.entries(data)
      .map(([key, value]) => `${key}='${value.replaceAll("'", "'\\''")}'`)
      .join(' ')

    if (!kvPairs) {
      console.log(chalk.red(`Skipping secret: ${secretName} because it is empty`))
      return
    }

    const command = `vault kv put ${this.pathPrefix}/${secretName} ${kvPairs}`

    if (this.debug) {
      console.log(chalk.yellow('--- Debug Output ---'))
      console.log(chalk.cyan(`Secret Name: ${secretName}`))
      console.log(chalk.cyan(`Command: ${command}`))
      console.log(chalk.yellow('-------------------'))
    }

    try {
      // Check if secret exists
      try {
        await this.runCommand(`vault kv get ${this.pathPrefix}/${secretName}`)
        // Secret exists, ask for override
        if (this.overrideAll) {
          console.log(chalk.yellow(`Overriding existing secret: ${this.pathPrefix}/${secretName} (ALL mode)`))
        } else {
          const shouldOverride = await select({
            choices: [
              { name: 'Yes', value: 'yes' },
              { name: 'No', value: 'no' },
              { name: 'Yes to ALL', value: 'all' },
            ],
            message: chalk.yellow(`Secret ${this.pathPrefix}/${secretName} already exists. Do you want to override it?`),
          })

          if (shouldOverride === 'no') {
            console.log(chalk.yellow(`Skipping secret: ${this.pathPrefix}/${secretName}`))
            return
          }

          if (shouldOverride === 'all') {
            this.overrideAll = true
            console.log(chalk.yellow('Will override all existing secrets from now on.'))
          }
        }
      } catch {
        // Secret doesn't exist, continue with creation
      }

      await this.runCommand(command)
      console.log(chalk.green(`Successfully pushed secret: ${this.pathPrefix}/${secretName}`))
    } catch (error) {
      console.error(chalk.red(`Failed to push secret: ${this.pathPrefix}/${secretName}`))
      console.error(chalk.red(`Error: ${error}`))
    }
  }

  private async runCommand(command: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`kubectl exec vault-0 -- ${command}`)
      return stdout.trim()
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`))
      throw error
    }
  }
}

export default class SetupPushSecrets extends Command {
  static override description = 'Push secrets to the selected secret service'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --debug',
    '<%= config.bin %> <%= command.id %> --values-dir custom-values',
    '<%= config.bin %> <%= command.id %> --cubesigner-only',
    '<%= config.bin %> <%= command.id %> -c --debug',
  ]

  static override flags = {
    debug: Flags.boolean({
      char: 'd',
      default: false,
      description: 'Show debug output',
    }),
    'values-dir': Flags.string({
      default: 'values',
      description: 'Directory containing the values files',
    }),
    'cubesigner-only': Flags.boolean({
      char: 'c',
      default: false,
      description: 'Only push CubeSigner related secrets (cubesigner-signer-* files)',
    }),
  }

  private flags: any


  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupPushSecrets)
    this.flags = flags

    this.log(chalk.blue('Starting secret push process...'))

    if (flags['cubesigner-only']) {
      this.log(chalk.yellow('🔑 CubeSigner only mode: Will only process cubesigner-signer-* files'))
    }

    const secretService = await select({
      choices: [
        { name: 'AWS', value: 'aws' },
        { name: 'Hashicorp Vault - Dev', value: 'vault' },
      ],
      message: chalk.cyan('Select a secret service:'),
    })

    let service: SecretService
    let provider: string
    let credentials: Record<string, string>

    if (secretService === 'aws') {
      credentials = await this.getAWSCredentials()
      service = new AWSSecretService(credentials.secretRegion, credentials.prefixName, flags.debug)
      provider = 'aws'
    } else if (secretService === 'vault') {
      credentials = await this.getVaultCredentials()
      service = new HashicorpVaultDevService(flags.debug, credentials.path)
      provider = 'vault'
    } else {
      this.error(chalk.red('Invalid secret service selected'))
    }

    try {
      await service.pushSecrets(flags['cubesigner-only'])
      this.log(chalk.green('Secrets pushed successfully'))

      if (flags['cubesigner-only']) {
        this.log(chalk.blue('CubeSigner secret push process completed.'))
        return;
      }

      const shouldUpdateYaml = await confirm({
        message: chalk.cyan('Do you want to update the production YAML files with the new secret provider?'),
      })

      if (shouldUpdateYaml) {
        await this.updateProductionYaml(provider, credentials)
        this.log(chalk.green('Production YAML files updated successfully'))
      } else {
        this.log(chalk.yellow('Skipped updating production YAML files'))
      }

      this.log(chalk.blue('Secret push process completed.'))
    } catch (error) {
      this.error(chalk.red(`Failed to push secrets: ${error}`))
    }
  }

  private async getAWSCredentials(): Promise<Record<string, string>> {
    return {
      prefixName: await input({
        default: 'dogeos',
        message: chalk.cyan('Enter a path prefix for AWS Secrets Manager (e.g., my-app/staging or dogeos/testnet):'),
      }),
      secretRegion: await input({
        default: '',
        message: chalk.cyan('Enter AWS secret region(e.g.,us-east-1):'),
      }),
      serviceAccount: await input({
        message: chalk.cyan('Enter AWS iam service account:'),
        default: 'external-secrets'
      }),
    }
  }

  private async getVaultCredentials(): Promise<Record<string, string>> {
    return {
      path: await input({
        default: 'scroll',
        message: chalk.cyan('Enter Vault path:'),
        validate(value: string) {
          if (/^\d+$/.test(value)) {
            return 'Path cannot be all numeric'
          }

          return true
        },
      }),
      server: await input({
        default: 'http://vault.default.svc.cluster.local:8200',
        message: chalk.cyan('Enter Vault server URL:'),
      }),
      tokenSecretKey: await input({
        default: 'token',
        message: chalk.cyan('Enter Vault token secret key:'),
      }),
      tokenSecretName: await input({
        default: 'vault-token',
        message: chalk.cyan('Enter Vault token secret name:'),
      }),
      version: await input({
        default: 'v2',
        message: chalk.cyan('Enter Vault version:'),
      }),
    }
  }

  private async readCubeSignerConfigFromYaml(): Promise<Record<string, string>> {
    const valuesDir = path.join(process.cwd(), 'values', 'values')
    if (!fs.existsSync(valuesDir)) {
      this.error(chalk.red(`Values directory not found at ${valuesDir}`))
    }

    // Find cubesigner-signer-production-N.yaml files
    const cubesignerFiles = fs
      .readdirSync(valuesDir)
      .filter((file) => file.match(/^cubesigner-signer-production-\d+\.yaml$/))

    if (cubesignerFiles.length === 0) {
      this.error(chalk.red('No cubesigner-signer-production-N.yaml files found in values/values directory'))
    }

    // Read the first found file
    const yamlFile = cubesignerFiles[0]
    const yamlPath = path.join(valuesDir, yamlFile)
    this.log(chalk.cyan(`Reading configuration from ${yamlFile}`))

    const content = fs.readFileSync(yamlPath, 'utf8')
    const yamlContent = yaml.load(content) as any

    if (!yamlContent.externalSecrets) {
      this.error(chalk.red(`No externalSecrets found in ${yamlFile}`))
    }

    // Find cubesigner-signer-N-session configuration
    const sessionSecretKey = Object.keys(yamlContent.externalSecrets).find(key =>
      key.match(/^cubesigner-signer-\d+-session$/)
    )

    if (!sessionSecretKey) {
      this.error(chalk.red(`No cubesigner-signer-N-session found in externalSecrets of ${yamlFile}`))
    }

    const sessionSecret = yamlContent.externalSecrets[sessionSecretKey]

    // Parse configuration
    const config: Record<string, string> = {
      provider: sessionSecret.provider
    }

    if (sessionSecret.provider === 'aws') {
      config.serviceAccount = sessionSecret.serviceAccount || 'external-secrets'
      config.secretRegion = sessionSecret.secretRegion || 'us-west-2'

      // Parse prefixName from remoteRef.key
      const data = sessionSecret.data?.[0]
      if (data?.remoteRef?.key) {
        const keyParts = data.remoteRef.key.split('/')
        if (keyParts.length > 1) {
          config.prefixName = keyParts[0]
        } else {
          config.prefixName = 'dogeos'
        }
      } else {
        config.prefixName = 'dogeos'
      }
    } else if (sessionSecret.provider === 'vault') {
      config.server = sessionSecret.server || 'http://vault.default.svc.cluster.local:8200'
      config.path = sessionSecret.path || 'scroll'
      config.version = sessionSecret.version || 'v2'
      config.tokenSecretName = sessionSecret.tokenSecretName || 'vault-token'
      config.tokenSecretKey = sessionSecret.tokenSecretKey || 'token'
    }

    return config
  }

  private async updateProductionYaml(provider: string, credentials: Record<string, string>): Promise<void> {
    const valuesDir = path.join(process.cwd(), this.flags['values-dir'])
    if (!fs.existsSync(valuesDir)) {
      this.error(chalk.red(`Values directory not found at ${valuesDir}`))
    }

    let prefixName: string | undefined
    prefixName = provider === 'vault' ? credentials.path : credentials.prefixName

    const yamlFiles = fs
      .readdirSync(valuesDir)
      .filter((file) => file.endsWith('-production.yaml') || file.match(/-production-\d+\.yaml$/))

    for (const yamlFile of yamlFiles) {
      const yamlPath = path.join(valuesDir, yamlFile)
      this.log(chalk.cyan(`Processing ${yamlFile}`))

      // Extract sequencer index from filename if it matches the pattern
      // const sequencerMatch = yamlFile.match(/l2-sequencer-production-(\d+)\.yaml$/)
      // const sequencerIndex = sequencerMatch ? sequencerMatch[1] : null

      const content = fs.readFileSync(yamlPath, 'utf8')
      const yamlContent = yaml.load(content) as any

      let updated = false
      if (yamlContent.externalSecrets) {
        for (const [secretName, secret] of Object.entries(yamlContent.externalSecrets) as [string, any][]) {
          if (secret.provider !== provider) {
            secret.provider = provider
            updated = true
          }

          if (provider === 'vault') {
            secret.server = credentials.server
            secret.path = credentials.path
            secret.version = credentials.version
            secret.tokenSecretName = credentials.tokenSecretName
            secret.tokenSecretKey = credentials.tokenSecretKey
            delete secret.serviceAccount
            delete secret.secretRegion
            updated = true
          } else {
            secret.serviceAccount = credentials.serviceAccount
            secret.secretRegion = credentials.secretRegion
            delete secret.server
            delete secret.path
            delete secret.version
            delete secret.tokenSecretName
            delete secret.tokenSecretKey
            updated = true
          }

          // Update remoteRef for migrate-db secrets
          if (secretName.endsWith('-migrate-db')) {
            for (const data of secret.data) {
              if (data.remoteRef && data.remoteRef.key && data.secretKey === 'migrate-db.json') {
                data.remoteRef.property = 'migrate-db.json'
                updated = true
              }
            }
          }

          // Update remoteRef.key
          for (const dataItem of secret.data) {
            if (dataItem.remoteRef && dataItem.remoteRef.key) {
              const updatedKey = prefixName ? `${prefixName}/${secretName}` : secretName
              /*
                externalSecrets:
                  YOUR_SECRET_NAME:
                    provider: "aws"
                    data:
                      - remoteRef:
                          key: "prefix/SECRET_PATH_OF_EXTERNAL_MANAGER"
                          property: "property_KEY"
                        secretKey: "SECRET_KEY"
            */
              if (/^cubesigner-signer-\d+-session$/.test(secretName)) {
                if (dataItem.secretKey === 'session.json') {
                  dataItem.remoteRef.property = 'session.json'
                  updated = true
                }
              }

              // Only update if the key has changed
              if (dataItem.remoteRef.key !== updatedKey) {
                dataItem.remoteRef.key = updatedKey
                updated = true
              }
            }
          }
        }
      }

      if (updated) {
        const newContent = yaml.dump(yamlContent, YAML_DUMP_OPTIONS)
        fs.writeFileSync(yamlPath, newContent)
        this.log(chalk.green(`Updated externalSecrets provider in ${chalk.cyan(yamlFile)}`))
      } else {
        this.log(chalk.yellow(`No changes needed in ${chalk.cyan(yamlFile)}`))
      }
    }
  }
}
