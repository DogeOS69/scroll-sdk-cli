import { confirm, input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import * as yaml from 'js-yaml'
import { exec, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

interface SecretService {
  pushSecrets(): Promise<void>
}

class AWSSecretService implements SecretService {
  constructor(private region: string, private prefixName: string, private debug: boolean) { }

  async pushSecrets(): Promise<void> {
    const secretsDir = path.join(process.cwd(), 'secrets')

    // Process JSON files
    const jsonFiles = fs.readdirSync(secretsDir).filter((file) => file.endsWith('.json'))
    for (const file of jsonFiles) {
      const secretName = path.basename(file, '.json')
      console.log(chalk.cyan(`Processing JSON secret: ${secretName}`))
      const content = await fs.promises.readFile(path.join(secretsDir, file), 'utf8')

      let propertyName = 'migrate-db.json' // Default for existing behavior
      if (secretName.endsWith('-session')) {
        propertyName = 'session.json'
      } else if (secretName.endsWith('-migrate-db')) {
        propertyName = 'migrate-db.json'
      }
      // Add more specific cases if other JSON types arise with different property needs

      await this.createOrUpdateSecret({ [propertyName]: content }, secretName)
    }

    // Process ENV files
    const envFiles = fs.readdirSync(secretsDir).filter((file) => file.endsWith('.env'))
    const l2SequencerSecrets: Record<string, string> = {}

    for (const file of envFiles) {
      const baseName = path.basename(file, '.env')

      // Special handling for l2-sequencer-N-secret.env files
      if (/^l2-sequencer-\d+-secret$/.test(baseName)) {
        const sequencerIndex = baseName.match(/l2-sequencer-(\d+)-secret/)?.[1] || '0'
        const secretName = `l2-sequencer-secret-${sequencerIndex}-env`

        console.log(chalk.cyan(`Processing L2 Sequencer secret: ${secretName}`))
        const data = await this.convertEnvToDict(path.join(secretsDir, file))
        await this.createOrUpdateSecret(data, secretName)

        // Also add to combined secret with index suffix for backward compatibility
        for (const [key, value] of Object.entries(data)) {
          // If key already has index suffix, use it as is, otherwise add index suffix
          if (key.endsWith(`_${sequencerIndex}`)) {
            l2SequencerSecrets[key] = value
          } else {
            l2SequencerSecrets[`${key}_${sequencerIndex}`] = value
          }
        }
      } else {
        const secretName = `${baseName}-env`
        console.log(chalk.cyan(`Processing ENV secret: ${secretName}`))
        const data = await this.convertEnvToDict(path.join(secretsDir, file))
        await this.createOrUpdateSecret(data, secretName)
      }
    }

    // Push combined L2 Sequencer secrets
    if (Object.keys(l2SequencerSecrets).length > 0) {
      console.log(chalk.cyan(`Processing combined L2 Sequencer secrets: l2-sequencer-secret-env`))
      await this.createOrUpdateSecret(l2SequencerSecrets, 'l2-sequencer-secret-env')
    }
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
      const shouldOverride = await confirm({
        default: false,
        message: chalk.yellow(`Secret ${fullSecretName} already exists. Do you want to override it?`),
      })

      if (!shouldOverride) {
        console.log(chalk.yellow(`Skipping secret: ${fullSecretName}`))
        return
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
}

class HashicorpVaultDevService implements SecretService {
  private debug: boolean
  private pathPrefix: string

  constructor(debug: boolean, pathPrefix: string = 'scroll') {
    this.debug = debug
    this.pathPrefix = pathPrefix
  }

  async pushSecrets(): Promise<void> {
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

    const secretsDir = path.join(process.cwd(), 'secrets')

    // Process JSON files
    const jsonFiles = fs.readdirSync(secretsDir).filter((file) => file.endsWith('.json'))
    for (const file of jsonFiles) {
      const secretName = path.basename(file, '.json')
      console.log(chalk.cyan(`Processing JSON secret: ${this.pathPrefix}/${secretName}`))
      const content = await fs.promises.readFile(path.join(secretsDir, file), 'utf8')

      let propertyName = 'migrate-db.json' // Default for existing behavior
      if (secretName.endsWith('-session')) {
        propertyName = 'session.json'
      } else if (secretName.endsWith('-migrate-db')) {
        propertyName = 'migrate-db.json'
      }
      // Add more specific cases if other JSON types arise

      await this.pushJsonToVault(secretName, content, propertyName)
    }

    // Process ENV files
    const envFiles = fs.readdirSync(secretsDir).filter((file) => file.endsWith('.env'))
    const l2SequencerSecrets: Record<string, string> = {}

    for (const file of envFiles) {
      const baseName = path.basename(file, '.env')

      // Special handling for l2-sequencer-N-secret.env files
      if (/^l2-sequencer-\d+-secret$/.test(baseName)) {
        const sequencerIndex = baseName.match(/l2-sequencer-(\d+)-secret/)?.[1] || '0'
        const secretName = `l2-sequencer-secret-${sequencerIndex}-env`

        console.log(chalk.cyan(`Processing L2 Sequencer secret: ${this.pathPrefix}/${secretName}`))
        const data = await this.convertEnvToDict(path.join(secretsDir, file))
        await this.pushToVault(secretName, data)

        // Also add to combined secret with index suffix for backward compatibility
        for (const [key, value] of Object.entries(data)) {
          // If key already has index suffix, use it as is, otherwise add index suffix
          if (key.endsWith(`_${sequencerIndex}`)) {
            l2SequencerSecrets[key] = value
          } else {
            l2SequencerSecrets[`${key}_${sequencerIndex}`] = value
          }
        }
      } else {
        const secretName = `${baseName}-env`
        console.log(chalk.cyan(`Processing ENV secret: ${this.pathPrefix}/${secretName}`))
        const data = await this.convertEnvToDict(path.join(secretsDir, file))
        await this.pushToVault(secretName, data)
      }
    }

    // Push combined L2 Sequencer secrets for backward compatibility
    if (Object.keys(l2SequencerSecrets).length > 0) {
      console.log(chalk.cyan(`Processing combined L2 Sequencer secrets: ${this.pathPrefix}/l2-sequencer-secret-env`))
      await this.pushToVault('l2-sequencer-secret-env', l2SequencerSecrets)
    }

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
  }

  private flags: any


  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupPushSecrets)
    this.flags = flags

    this.log(chalk.blue('Starting secret push process...'))

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
      await service.pushSecrets()
      this.log(chalk.green('Secrets pushed successfully'))

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
        default: 'scroll',
        message: chalk.cyan('Enter secret prefix name:'),
      }),
      secretRegion: await input({
        default: 'us-west-2',
        message: chalk.cyan('Enter AWS secret region:'),
      }),
      serviceAccount: await input({
        message: chalk.cyan('Enter AWS service account:'),
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
      const sequencerMatch = yamlFile.match(/l2-sequencer-production-(\d+)\.yaml$/)
      const sequencerIndex = sequencerMatch ? sequencerMatch[1] : null

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
          for (const data of secret.data) {
            if (data.remoteRef && data.remoteRef.key) {
              // Keep the standard combined path format
              let updatedKey = ''
              if (/^l2-sequencer-secret-\d+-env$/.test(secretName)) {
                updatedKey = prefixName ? `${prefixName}/l2-sequencer-secret-env` : 'l2-sequencer-secret-env'
              } else if (/^cubesigner-signer-\d+-env$/.test(secretName)) {
                updatedKey = prefixName ? `${prefixName}/${secretName}` : secretName
              } else if (/^cubesigner-signer-\d+-session$/.test(secretName)) {
                updatedKey = prefixName ? `${prefixName}/${secretName}` : secretName
                if (data.secretKey === 'session.json') {
                  data.remoteRef.property = 'session.json'
                  updated = true
                }
              } else {
                updatedKey = prefixName ? `${prefixName}/${secretName}` : secretName
              }

              // Only update if the key has changed
              if (data.remoteRef.key !== updatedKey) {
                data.remoteRef.key = updatedKey
                updated = true
              }
            }
          }
        }
      }

      if (updated) {
        const newContent = yaml.dump(yamlContent, { forceQuotes: true, lineWidth: -1, noRefs: true, quotingType: '"' })
        fs.writeFileSync(yamlPath, newContent)
        this.log(chalk.green(`Updated externalSecrets provider in ${chalk.cyan(yamlFile)}`))
      } else {
        this.log(chalk.yellow(`No changes needed in ${chalk.cyan(yamlFile)}`))
      }
    }
  }
}
