/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic secret config operations */
import { confirm, input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import * as yaml from 'js-yaml'
import { exec } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'

import { YAML_DUMP_OPTIONS } from '../../config/constants.js'
import { CliExitError, JsonOutputContext } from '../../utils/json-output.js'
import { resolveEnvValue } from '../../utils/non-interactive.js'

const execAsync = promisify(exec)

const DEFAULT_SECRET_PROVIDER = 'aws'
const DEFAULT_AWS_PREFIX = 'dogeos'
const DEFAULT_AWS_SERVICE_ACCOUNT = 'external-secrets'
const DEFAULT_VAULT_PATH = 'scroll'
const DEFAULT_VAULT_SERVER = 'http://vault.default.svc.cluster.local:8200'
const DEFAULT_VAULT_TOKEN_SECRET_KEY = 'token'
const DEFAULT_VAULT_TOKEN_SECRET_NAME = 'vault-token'
const DEFAULT_VAULT_VERSION = 'v2'

interface SecretService {
  pushSecrets(cubesignerOnly?: boolean, secretFile?: string): Promise<PushedSecret[]>
}

interface PushedSecret {
  name: string
  properties: string[]
  sourceFile: string
}

interface ResolvedSecretFile {
  filename?: string
  secretsDir: string
}

function resolveSecretFile(secretFile?: string): ResolvedSecretFile {
  const secretsDir = path.join(process.cwd(), 'secrets')

  if (!secretFile) {
    return { secretsDir }
  }

  const resolvedPath = path.resolve(process.cwd(), secretFile)
  if (fs.existsSync(resolvedPath)) {
    const filename = path.basename(resolvedPath)
    validateSecretFileName(filename)

    return {
      filename,
      secretsDir: path.dirname(resolvedPath),
    }
  }

  const defaultSecretPath = path.join(secretsDir, secretFile)
  if (fs.existsSync(defaultSecretPath)) {
    validateSecretFileName(secretFile)

    return {
      filename: secretFile,
      secretsDir,
    }
  }

  throw new Error(`Secret file not found: ${secretFile} (checked ${resolvedPath} and ${defaultSecretPath})`)
}

function validateSecretFileName(filename: string): void {
  if (filename.endsWith('.env') || filename.endsWith('.json')) return

  throw new Error(`Unsupported secret file type: ${filename}. Expected .env or .json`)
}

function getJsonPropertyName(secretName: string, file: string): string {
  if (secretName.endsWith('-session')) return 'session.json'
  if (secretName.endsWith('-migrate-db')) return 'migrate-db.json'
  if (secretName === 'rollup-explorer-backend-secret') return 'config.json'

  console.warn(chalk.yellow(`Unknown JSON file type for property naming: ${secretName}. Using file name as property.`))
  return file
}

class AWSSecretService implements SecretService {
  private overrideAll: boolean = false

  constructor(
    private region: string,
    private prefixName: string,
    private debug: boolean,
    private nonInteractive: boolean = false
  ) {
    // In non-interactive mode, always override all by default
    if (nonInteractive) {
      this.overrideAll = true
    }
  }

  async pushSecrets(cubesignerOnly: boolean = false, secretFile?: string): Promise<PushedSecret[]> {
    const pushedSecrets: PushedSecret[] = []
    const { filename, secretsDir } = resolveSecretFile(secretFile)

    if (cubesignerOnly) {
      // Only process cubesigner-signer-N-session.json files
      let sessionFiles = fs.readdirSync(secretsDir).filter((file) =>
        file.match(/^cubesigner-signer-\d+-session\.json$/)
      );

      if (filename) {
        if (!/^cubesigner-signer-\d+-session\.json$/.test(filename)) {
          console.warn(chalk.yellow(`File ${filename} is not a valid cubesigner session file. Ignoring.`));
          throw new Error(`File ${filename} is not a valid cubesigner session file`)
        }

        sessionFiles = sessionFiles.filter(f => f === filename);
      }

      if (sessionFiles.length === 0) {
        console.log(chalk.yellow('No cubesigner-signer-N-session.json files found in secrets directory'))
        return []
      }

      for (const file of sessionFiles) {
        const secretName = path.basename(file, '.json')
        console.log(chalk.cyan(`Processing CubeSigner session secret: ${secretName}`))
        const content = await fs.promises.readFile(path.join(secretsDir, file), 'utf8')
        if (await this.createOrUpdateSecret({ 'session.json': content }, secretName)) {
          pushedSecrets.push({ name: secretName, properties: ['session.json'], sourceFile: path.join(secretsDir, file) })
        }
      }

      return pushedSecrets
    }

    // Process JSON files
    let jsonFiles = fs.readdirSync(secretsDir).filter((file) => file.endsWith('.json'));
    if (filename && filename.endsWith('.json')) {
      jsonFiles = jsonFiles.filter((f) => f === filename)
    } else if (filename) {
      jsonFiles = []
    }

    for (const file of jsonFiles) {
      const secretName = path.basename(file, '.json')

      console.log(chalk.cyan(`Processing JSON secret: ${secretName}`))
      const content = await fs.promises.readFile(path.join(secretsDir, file), 'utf8')

      const propertyName = getJsonPropertyName(secretName, file)
      if (await this.createOrUpdateSecret({ [propertyName]: content }, secretName)) {
        pushedSecrets.push({ name: secretName, properties: [propertyName], sourceFile: path.join(secretsDir, file) })
      }
    }

    // Process ENV files
    let envFiles = fs.readdirSync(secretsDir).filter((file) => file.endsWith('.env'))
    if (filename && filename.endsWith('.env')) {
      envFiles = envFiles.filter((f) => f === filename)
    } else if (filename) {
      envFiles = []
    }

    for (const file of envFiles) {
      const baseName = path.basename(file, '.env')
      const secretName = `${baseName}-env`
      console.log(chalk.cyan(`Processing ENV secret: ${secretName}`))
      const data = await this.convertEnvToDict(path.join(secretsDir, file))
      if (await this.createOrUpdateSecret(data, secretName)) {
        pushedSecrets.push({ name: secretName, properties: Object.keys(data), sourceFile: path.join(secretsDir, file) })
      }

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
    return pushedSecrets
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

  private async createOrUpdateSecret(content: Record<string, string>, secretName: string): Promise<boolean> {
    const fullSecretName = `${this.prefixName}/${secretName}`
    const jsonContent = JSON.stringify(content)
    const escapedJsonContent = jsonContent.replaceAll("'", "'\\''")
    if (Object.keys(content).length === 0) {
      console.log(chalk.red(`Skipping secret: ${secretName} because it is empty`))
      return false
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
          return false
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
        return true
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
        return true
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
  private nonInteractive: boolean = false
  private overrideAll: boolean = false
  private pathPrefix: string

  constructor(debug: boolean, pathPrefix: string = 'scroll', nonInteractive: boolean = false) {
    this.debug = debug
    this.pathPrefix = pathPrefix
    this.nonInteractive = nonInteractive
    // In non-interactive mode, always override all by default
    if (nonInteractive) {
      this.overrideAll = true
    }
  }

  async pushSecrets(cubesignerOnly: boolean = false, secretFile?: string): Promise<PushedSecret[]> {
    const pushedSecrets: PushedSecret[] = []
    if (!(await this.isVaultPodRunning())) {
      console.log(chalk.yellow('Vault pod is not running. Please install Vault using the following commands:'))
      console.log(chalk.cyan('helm repo add hashicorp https://helm.releases.hashicorp.com'))
      console.log(chalk.cyan('helm repo update'))
      console.log(chalk.cyan('helm install vault hashicorp/vault --set "server.dev.enabled=true"'))
      console.log(chalk.yellow('After installing Vault, please run this command again.'))
      return []
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

    const { filename, secretsDir } = resolveSecretFile(secretFile)

    if (cubesignerOnly) {
      // Only process cubesigner-signer-N-session.json files
      let sessionFiles = fs.readdirSync(secretsDir).filter((file) =>
        file.match(/^cubesigner-signer-\d+-session\.json$/)
      );

      if (filename) {
        if (!/^cubesigner-signer-\d+-session\.json$/.test(filename)) {
          console.warn(chalk.yellow(`File ${filename} is not a valid cubesigner session file. Ignoring.`));
          throw new Error(`File ${filename} is not a valid cubesigner session file`)
        }

        sessionFiles = sessionFiles.filter(f => f === filename);
      }

      if (sessionFiles.length === 0) {
        console.log(chalk.yellow('No cubesigner-signer-N-session.json files found in secrets directory'))
        return []
      }

      for (const file of sessionFiles) {
        const secretName = path.basename(file, '.json')
        console.log(chalk.cyan(`Processing CubeSigner session secret: ${this.pathPrefix}/${secretName}`))
        const content = await fs.promises.readFile(path.join(secretsDir, file), 'utf8')
        if (await this.pushJsonToVault(secretName, content, 'session.json')) {
          pushedSecrets.push({ name: secretName, properties: ['session.json'], sourceFile: path.join(secretsDir, file) })
        }
      }

      console.log(chalk.green('All CubeSigner session secrets have been processed and populated in Vault.'))
      return pushedSecrets
    }

    // Process JSON files
    let jsonFiles = fs.readdirSync(secretsDir).filter((file) => file.endsWith('.json'));

    if (filename && filename.endsWith('.json')) {
      jsonFiles = jsonFiles.filter(f => f === filename);
    } else if (filename) {
      jsonFiles = []; // Not a json file requested
    }

    for (const file of jsonFiles) {
      const secretName = path.basename(file, '.json')

      console.log(chalk.cyan(`Processing JSON secret: ${this.pathPrefix}/${secretName}`))
      const content = await fs.promises.readFile(path.join(secretsDir, file), 'utf8')

      const propertyName = getJsonPropertyName(secretName, file)
      if (await this.pushJsonToVault(secretName, content, propertyName)) {
        pushedSecrets.push({ name: secretName, properties: [propertyName], sourceFile: path.join(secretsDir, file) })
      }
    }

    // Process ENV files
    let envFiles = fs.readdirSync(secretsDir).filter((file) => file.endsWith('.env'))

    if (filename && filename.endsWith('.env')) {
      envFiles = envFiles.filter(f => f === filename);
    } else if (filename) {
      envFiles = [];
    }
    // const l2SequencerSecrets: Record<string, string> = {}

    for (const file of envFiles) {
      const baseName = path.basename(file, '.env')
      const secretName = `${baseName}-env`
      console.log(chalk.cyan(`Processing ENV secret: ${this.pathPrefix}/${secretName}`))
      const data = await this.convertEnvToDict(path.join(secretsDir, file))
      if (await this.pushToVault(secretName, data)) {
        pushedSecrets.push({ name: secretName, properties: Object.keys(data), sourceFile: path.join(secretsDir, file) })
      }

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
    return pushedSecrets
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

  private async pushJsonToVault(secretName: string, content: string, propertyName: string): Promise<boolean> {
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
        return false
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
            return false
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
      return true
    } catch (error) {
      console.error(chalk.red(`Failed to push JSON secret: ${this.pathPrefix}/${secretName}`))
      console.error(chalk.red(`Error: ${error}`))
      throw error
    }
  }

  private async pushToVault(secretName: string, data: Record<string, string>): Promise<boolean> {
    const kvPairs = Object.entries(data)
      .map(([key, value]) => `${key}='${value.replaceAll("'", "'\\''")}'`)
      .join(' ')

    if (!kvPairs) {
      console.log(chalk.red(`Skipping secret: ${secretName} because it is empty`))
      return false
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
            return false
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
      return true
    } catch (error) {
      console.error(chalk.red(`Failed to push secret: ${this.pathPrefix}/${secretName}`))
      console.error(chalk.red(`Error: ${error}`))
      throw error
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
    '<%= config.bin %> <%= command.id %> --secret-file secrets/l2-reth-bootnode-0-secret.env --values-file values/l2-reth-bootnode-production-0.yaml',
    '<%= config.bin %> <%= command.id %> --cubesigner-only',
    '<%= config.bin %> <%= command.id %> -c --debug',
  ]

  static override flags = {
    // AWS specific flags
    'aws-prefix': Flags.string({
      default: DEFAULT_AWS_PREFIX,
      description: 'AWS Secrets Manager path prefix (e.g., dogeos/testnet)',
    }),
    'aws-region': Flags.string({
      description: 'AWS region for secrets (e.g., us-east-1)',
    }),
    'aws-service-account': Flags.string({
      default: DEFAULT_AWS_SERVICE_ACCOUNT,
      description: 'AWS IAM service account',
    }),
    'cubesigner-only': Flags.boolean({
      char: 'c',
      default: false,
      description: 'Only push CubeSigner related secrets (cubesigner-signer-* files)',
    }),
    debug: Flags.boolean({
      char: 'd',
      default: false,
      description: 'Show debug output',
    }),
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts. Auto-overrides existing secrets.',
    }),
    // Secret service provider
    provider: Flags.string({
      default: DEFAULT_SECRET_PROVIDER,
      description: 'Secret service provider (aws or vault)',
      options: ['aws', 'vault'],
    }),
    'secret-file': Flags.string({
      char: 'f',
      description: 'Local secret file to push (supports .env and .json files)',
    }),
    // Skip updating YAML files
    'skip-yaml-update': Flags.boolean({
      default: false,
      description: 'Skip updating production YAML files with new secret provider',
    }),
    'values-dir': Flags.string({
      default: 'values',
      description: 'Directory containing the values files',
    }),
    'values-file': Flags.string({
      description: 'Specific Helm values YAML file to update after pushing secrets',
    }),
    // Vault specific flags
    'vault-path': Flags.string({
      default: DEFAULT_VAULT_PATH,
      description: 'Vault path prefix',
    }),
    'vault-server': Flags.string({
      default: DEFAULT_VAULT_SERVER,
      description: 'Vault server URL',
    }),
    'vault-token-secret-key': Flags.string({
      default: DEFAULT_VAULT_TOKEN_SECRET_KEY,
      description: 'Vault token secret key',
    }),
    'vault-token-secret-name': Flags.string({
      default: DEFAULT_VAULT_TOKEN_SECRET_NAME,
      description: 'Vault token secret name',
    }),
    'vault-version': Flags.string({
      default: DEFAULT_VAULT_VERSION,
      description: 'Vault version',
    }),
  }

  private flags: any
  private jsonCtx!: JsonOutputContext
  private jsonMode: boolean = false
  private nonInteractive: boolean = false


  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupPushSecrets)
    this.flags = flags

    // Setup non-interactive/JSON mode
    this.nonInteractive = flags['non-interactive']
    this.jsonMode = flags.json
    this.jsonCtx = new JsonOutputContext('setup push-secrets', this.jsonMode)

    this.jsonCtx.info('Starting secret push process...')

    if (flags['cubesigner-only']) {
      this.jsonCtx.info('CubeSigner only mode: Will only process cubesigner-signer-* files')
    }

    const secretService: string = this.nonInteractive
      ? flags.provider || DEFAULT_SECRET_PROVIDER
      : await select({
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
      credentials = this.nonInteractive ? this.getAWSCredentialsFromFlags(flags) : await this.getAWSCredentials()
      service = new AWSSecretService(credentials.secretRegion, credentials.prefixName, flags.debug, this.nonInteractive)
      provider = 'aws'
    } else if (secretService === 'vault') {
      credentials = this.nonInteractive ? this.getVaultCredentialsFromFlags(flags) : await this.getVaultCredentials()
      service = new HashicorpVaultDevService(flags.debug, credentials.path, this.nonInteractive)
      provider = 'vault'
    } else {
      this.jsonCtx.error(
        'E601_INVALID_VALUE',
        'Invalid secret service selected',
        'CONFIGURATION',
        false
      )
      this.error(chalk.red('Invalid secret service selected'))
    }

    try {
      const pushedSecrets = await service.pushSecrets(flags['cubesigner-only'], flags['secret-file'])
      const pushedSecretNames = pushedSecrets.map(secret => secret.name)
      this.jsonCtx.logSuccess('Secrets pushed successfully')

      if (flags['cubesigner-only']) {
        this.jsonCtx.logSuccess('CubeSigner secret push process completed.')
        if (this.jsonMode) {
          this.jsonCtx.success({
            cubesignerOnly: true,
            provider,
            secretsPushed: pushedSecretNames,
          })
        }

        return;
      }

      let shouldUpdateYaml: boolean
      if (this.nonInteractive) {
        shouldUpdateYaml = !flags['skip-yaml-update']
        if (!shouldUpdateYaml) {
          this.jsonCtx.info('Skipping YAML update (--skip-yaml-update)')
        }
      } else {
        shouldUpdateYaml = await confirm({
          message: chalk.cyan('Do you want to update the production YAML files with the new secret provider?'),
        })
      }

      if (shouldUpdateYaml) {
        await this.updateProductionYaml(provider, credentials, pushedSecrets)
        this.jsonCtx.logSuccess('Production YAML files updated successfully')
      } else {
        this.jsonCtx.info('Skipped updating production YAML files')
      }

      this.jsonCtx.logSuccess('Secret push process completed.')

      // JSON output
      if (this.jsonMode) {
        this.jsonCtx.success({
          credentials: {
            prefixName: credentials.prefixName || credentials.path,
            region: credentials.secretRegion,
          },
          provider,
          secretsPushed: pushedSecretNames,
          yamlUpdated: shouldUpdateYaml,
        })
      }
    } catch (error) {
      if (error instanceof CliExitError) throw error
      if (this.jsonMode) {
        this.jsonCtx.error(
          'E900_UNEXPECTED_ERROR',
          `Failed to push secrets: ${error}`,
          'INTERNAL',
          false
        )
      }

      this.error(chalk.red(`Failed to push secrets: ${error}`))
    }
  }

  private deleteYamlValue(target: Record<string, any>, key: string): boolean {
    if (!(key in target)) return false

    delete target[key]
    return true
  }

  private async getAWSCredentials(): Promise<Record<string, string>> {
    return {
      prefixName: await input({
        default: DEFAULT_AWS_PREFIX,
        message: chalk.cyan('Enter a path prefix for AWS Secrets Manager (e.g., my-app/staging or dogeos/testnet):'),
      }),
      secretRegion: await input({
        message: chalk.cyan('Enter AWS secret region(e.g.,us-east-1):'),
        required: true,
      }),
      serviceAccount: await input({
        default: DEFAULT_AWS_SERVICE_ACCOUNT,
        message: chalk.cyan('Enter AWS iam service account:')
      }),
    }
  }

  private getAWSCredentialsFromFlags(flags: any): Record<string, string> {
    const secretRegion = resolveEnvValue(flags['aws-region'])?.trim()
    if (!secretRegion) {
      this.jsonCtx.error(
        'E601_MISSING_FIELD',
        '--aws-region is required when pushing secrets to AWS in non-interactive mode.',
        'CONFIGURATION',
        true,
        { flag: '--aws-region' }
      )
    }

    return {
      prefixName: resolveEnvValue(flags['aws-prefix']) || DEFAULT_AWS_PREFIX,
      secretRegion,
      serviceAccount: resolveEnvValue(flags['aws-service-account']) || DEFAULT_AWS_SERVICE_ACCOUNT,
    }
  }

  private getProductionYamlFiles(): Array<{ displayName: string; yamlPath: string }> {
    const valuesFile = this.flags['values-file']
    if (valuesFile) {
      const resolvedPath = path.resolve(process.cwd(), valuesFile)
      const valuesDirPath = path.join(process.cwd(), this.flags['values-dir'], valuesFile)
      const yamlPath = fs.existsSync(resolvedPath) ? resolvedPath : valuesDirPath

      if (!fs.existsSync(yamlPath)) {
        throw new Error(`Values file not found: ${valuesFile} (checked ${resolvedPath} and ${valuesDirPath})`)
      }

      return [{ displayName: path.relative(process.cwd(), yamlPath), yamlPath }]
    }

    const valuesDir = path.join(process.cwd(), this.flags['values-dir'])
    if (!fs.existsSync(valuesDir)) {
      throw new Error(`Values directory not found at ${valuesDir}`)
    }

    return fs
      .readdirSync(valuesDir)
      .filter((file) => file.endsWith('-production.yaml') || file.match(/-production-\d+\.yaml$/))
      .map(file => ({
        displayName: file,
        yamlPath: path.join(valuesDir, file),
      }))
  }

  private async getVaultCredentials(): Promise<Record<string, string>> {
    return {
      path: await input({
        default: DEFAULT_VAULT_PATH,
        message: chalk.cyan('Enter Vault path:'),
        validate(value: string) {
          if (/^\d+$/.test(value)) {
            return 'Path cannot be all numeric'
          }

          return true
        },
      }),
      server: await input({
        default: DEFAULT_VAULT_SERVER,
        message: chalk.cyan('Enter Vault server URL:'),
      }),
      tokenSecretKey: await input({
        default: DEFAULT_VAULT_TOKEN_SECRET_KEY,
        message: chalk.cyan('Enter Vault token secret key:'),
      }),
      tokenSecretName: await input({
        default: DEFAULT_VAULT_TOKEN_SECRET_NAME,
        message: chalk.cyan('Enter Vault token secret name:'),
      }),
      version: await input({
        default: DEFAULT_VAULT_VERSION,
        message: chalk.cyan('Enter Vault version:'),
      }),
    }
  }

  private getVaultCredentialsFromFlags(flags: any): Record<string, string> {
    return {
      path: resolveEnvValue(flags['vault-path']) || DEFAULT_VAULT_PATH,
      server: resolveEnvValue(flags['vault-server']) || DEFAULT_VAULT_SERVER,
      tokenSecretKey: resolveEnvValue(flags['vault-token-secret-key']) || DEFAULT_VAULT_TOKEN_SECRET_KEY,
      tokenSecretName: resolveEnvValue(flags['vault-token-secret-name']) || DEFAULT_VAULT_TOKEN_SECRET_NAME,
      version: resolveEnvValue(flags['vault-version']) || DEFAULT_VAULT_VERSION,
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
      .filter((file) => file.match(/^cube(?:signer-){2}production-\d+\.yaml$/))

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
      if (sessionSecret.secretRegion) {
        config.secretRegion = sessionSecret.secretRegion
      }

      // Parse prefixName from remoteRef.key
      const data = sessionSecret.data?.[0]
      if (data?.remoteRef?.key) {
        const keyParts = data.remoteRef.key.split('/')
        config.prefixName = keyParts.length > 1 ? keyParts[0] : 'dogeos';
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

  private setYamlValue(target: Record<string, any>, key: string, value: any): boolean {
    if (target[key] === value) return false

    target[key] = value
    return true
  }

  private updateExternalSecretProvider(
    secretName: string,
    secret: any,
    provider: string,
    credentials: Record<string, string>,
  ): boolean {
    let updated = false
    const prefixName: string | undefined = provider === 'vault' ? credentials.path : credentials.prefixName

    updated = this.setYamlValue(secret, 'provider', provider) || updated

    if (provider === 'vault') {
      updated = this.setYamlValue(secret, 'server', credentials.server) || updated
      updated = this.setYamlValue(secret, 'path', credentials.path) || updated
      updated = this.setYamlValue(secret, 'version', credentials.version) || updated
      updated = this.setYamlValue(secret, 'tokenSecretName', credentials.tokenSecretName) || updated
      updated = this.setYamlValue(secret, 'tokenSecretKey', credentials.tokenSecretKey) || updated
      updated = this.deleteYamlValue(secret, 'serviceAccount') || updated
      updated = this.deleteYamlValue(secret, 'secretRegion') || updated
    } else {
      updated = this.setYamlValue(secret, 'serviceAccount', credentials.serviceAccount) || updated
      updated = this.setYamlValue(secret, 'secretRegion', credentials.secretRegion) || updated
      updated = this.deleteYamlValue(secret, 'server') || updated
      updated = this.deleteYamlValue(secret, 'path') || updated
      updated = this.deleteYamlValue(secret, 'version') || updated
      updated = this.deleteYamlValue(secret, 'tokenSecretName') || updated
      updated = this.deleteYamlValue(secret, 'tokenSecretKey') || updated
    }

    for (const dataItem of secret.data || []) {
      if (dataItem.remoteRef) {
        const updatedKey = prefixName ? `${prefixName}/${secretName}` : secretName
        updated = this.setYamlValue(dataItem.remoteRef, 'key', updatedKey) || updated
      }
    }

    return updated
  }

  private async updateProductionYaml(provider: string, credentials: Record<string, string>, pushedSecrets: PushedSecret[]): Promise<void> {
    if (pushedSecrets.length === 0) {
      this.jsonCtx.info('No secrets were pushed successfully; skipping YAML update')
      return
    }

    const pushedSecretsByName = new Map(pushedSecrets.map(secret => [secret.name, secret]))
    const yamlFiles = this.getProductionYamlFiles()
    let matchedSecrets = 0

    for (const yamlFile of yamlFiles) {
      this.log(chalk.cyan(`Processing ${yamlFile.displayName}`))

      // Extract sequencer index from filename if it matches the pattern
      // const sequencerMatch = yamlFile.match(/l2-sequencer-production-(\d+)\.yaml$/)
      // const sequencerIndex = sequencerMatch ? sequencerMatch[1] : null

      const content = fs.readFileSync(yamlFile.yamlPath, 'utf8')
      const yamlContent = yaml.load(content) as any

      let updated = false
      let matchedInFile = false
      if (yamlContent.externalSecrets) {
        for (const [secretName, secret] of Object.entries(yamlContent.externalSecrets) as [string, any][]) {
          const pushedSecret = pushedSecretsByName.get(secretName)
          if (!pushedSecret) continue

          matchedSecrets++
          matchedInFile = true
          this.validateYamlSecretProperties(yamlFile.displayName, secretName, secret, pushedSecret)
          updated = this.updateExternalSecretProvider(secretName, secret, provider, credentials) || updated
        }
      }

      if (updated) {
        const newContent = yaml.dump(yamlContent, YAML_DUMP_OPTIONS)
        fs.writeFileSync(yamlFile.yamlPath, newContent)
        this.log(chalk.green(`Updated externalSecrets provider in ${chalk.cyan(yamlFile.displayName)}`))
      } else if (matchedInFile) {
        this.log(chalk.yellow(`No changes needed in ${chalk.cyan(yamlFile.displayName)}`))
      }
    }

    if (matchedSecrets === 0) {
      const pushedNames = pushedSecrets.map(secret => secret.name).join(', ')
      const target = this.flags['values-file'] ? ` in ${this.flags['values-file']}` : ''
      throw new Error(`No externalSecrets entries matched pushed secret(s) ${pushedNames}${target}`)
    }
  }

  private validateYamlSecretProperties(
    displayName: string,
    secretName: string,
    secret: any,
    pushedSecret: PushedSecret
  ): void {
    const availableProperties = new Set(pushedSecret.properties)
    const missingProperties = new Set<string>()

    for (const dataItem of secret.data || []) {
      const property = dataItem?.remoteRef?.property
      if (typeof property === 'string' && !availableProperties.has(property)) {
        missingProperties.add(property)
      }
    }

    if (missingProperties.size > 0) {
      throw new Error(
        `${displayName} expects property/properties ${[...missingProperties].join(', ')} in remote secret ${secretName}, ` +
        `but ${path.relative(process.cwd(), pushedSecret.sourceFile)} provides ${pushedSecret.properties.join(', ') || 'no properties'}.`
      )
    }
  }
}
