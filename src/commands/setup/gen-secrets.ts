/* eslint-disable @typescript-eslint/no-explicit-any -- Secret files are generated from dynamic TOML configs */
import * as toml from '@iarna/toml'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { DogeConfig } from '../../types/doge-config.js'

import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {
  getRequiredManagedSignerConfig,
  isAwsKmsSigner,
  isLocalSigner,
} from '../../utils/signer-roles.js'
import { RETH_BOOTNODE_NODEKEY_ENV, getBootnodeRethResourceName } from './l2-bootnode-reth.js'
import {
  RETH_NODEKEY_ENV,
  RETH_SIGNER_PRIVATE_KEY_ENV,
  getSequencerRethResourceName,
  normalizeSignerMode,
  signerModeToConfig,
} from './l2-sequencer-reth.js'

const SECRETS_PATH = path.join(process.cwd(), 'secrets')

export default class SetupGenSecrets extends Command {
  static override description = 'Generate local secret files from config.toml, Dogecoin config, and bridge initialization outputs'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --doge-config .data/doge-config.toml',
    '<%= config.bin %> <%= command.id %> --non-interactive --json --doge-config .data/doge-config.toml',
  ]

  static override flags = {
    'doge-config': Flags.string({
      description: 'Path to Dogecoin config file (defaults to .data/doge-config.toml)',
      required: false,
    }),
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts. Uses config values or fails fast.',
    }),
  }

  private dogeConfig: DogeConfig = {} as DogeConfig
  private jsonCtx!: JsonOutputContext
  private jsonMode: boolean = false
  private nonInteractive: boolean = false

  public override async run(): Promise<void> {
    const { flags } = await this.parse(SetupGenSecrets) as any

    this.nonInteractive = flags['non-interactive']
    this.jsonMode = flags.json
    this.jsonCtx = new JsonOutputContext('setup gen-secrets', this.jsonMode)

    const dogeConfigResult = await loadDogeConfigWithSelection(
      flags['doge-config'],
      'scrollsdk setup doge-config'
    )

    this.dogeConfig = dogeConfigResult.config
    this.jsonCtx.info(`Using Dogecoin config file: ${dogeConfigResult.configPath}`)

    const bridgeOutputPath = path.join(process.cwd(), '.data', 'output-withdrawal-processor.toml')
    if (!fs.existsSync(bridgeOutputPath)) {
      this.jsonCtx.error(
        'E103_BRIDGE_INIT_OUTPUT_MISSING',
        `${bridgeOutputPath} not found. Run \`scrollsdk setup bridge-init\` before \`scrollsdk setup gen-secrets\`.`,
        'CONFIGURATION',
        true,
        { path: bridgeOutputPath }
      )
    }

    this.jsonCtx.info('Creating secrets folder...')
    this.createSecretsFolder()

    this.jsonCtx.info('Creating secrets environment files...')
    await this.createEnvFiles()

    this.jsonCtx.logSuccess('Secret generation completed.')

    if (this.jsonMode) {
      this.jsonCtx.success({
        bridgeOutputPath,
        dogeConfigPath: dogeConfigResult.configPath,
        secretsDir: path.join(process.cwd(), 'secrets'),
      })
    }
  }

  private async createEnvFiles(): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.error(
        'E101_CONFIG_NOT_FOUND',
        'config.toml not found in the current directory.',
        'CONFIGURATION',
        true,
        { path: configPath }
      )
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = toml.parse(configContent)

    const services = [
      'blockscout',
      'coordinator-api',
      'coordinator-cron',
      'fee-oracle',
      'l2-sequencer',
      'contracts',
      'l2-bootnode',
      'dogecoin',
      'testnet-activity-helper',
      'l1-interface',
      'blockbook',
      'withdrawal-processor',
      'metrics-exporter',
      'eth-da-submitter',
    ]

    for (const service of services) {
      const envFiles = this.generateEnvContent(service, config)
      for (const [filename, content] of Object.entries(envFiles)) {
        const envFile = path.join(SECRETS_PATH, filename)
        fs.writeFileSync(envFile, content)
        this.jsonCtx.log(chalk.green(`Created ${filename}`))
      }
    }

    const rethEnvFiles = this.generateRethEnvFiles()
    for (const [filename, content] of Object.entries(rethEnvFiles)) {
      const envFile = path.join(SECRETS_PATH, filename)
      fs.writeFileSync(envFile, content)
      this.jsonCtx.log(chalk.green(`Created ${filename}`))
    }
  }

  private createSecretsFolder(): void {
    if (fs.existsSync(SECRETS_PATH)) {
      this.jsonCtx.log(chalk.yellow('Secrets folder already exists'))
    } else {
      fs.mkdirSync(SECRETS_PATH)
      this.jsonCtx.log(chalk.green('Created secrets folder'))
    }
  }

  private envLine(envKey: string, value: unknown, source: string): string {
    return `${envKey}="${this.resolveSecretValue(value, source)}"\n`
  }

  private generateEnvContent(service: string, config: any): { [key: string]: string } {
    const mapping: Record<string, string[]> = {
      'admin-system-backend': [
        'ADMIN_SYSTEM_BACKEND_DB_CONNECTION_STRING:SCROLL_ADMIN_AUTH_DB_CONFIG_DSN',
        'ADMIN_SYSTEM_BACKEND_DB_CONNECTION_STRING:SCROLL_ADMIN_DB_CONFIG_DSN',
        'ADMIN_SYSTEM_BACKEND_DB_CONNECTION_STRING:SCROLL_ADMIN_READ_ONLY_DB_CONFIG_DSN',
      ],
      'admin-system-cron': [
        'ADMIN_SYSTEM_BACKEND_DB_CONNECTION_STRING:SCROLL_ADMIN_AUTH_DB_CONFIG_DSN',
        'ADMIN_SYSTEM_BACKEND_DB_CONNECTION_STRING:SCROLL_ADMIN_DB_CONFIG_DSN',
        'ADMIN_SYSTEM_BACKEND_DB_CONNECTION_STRING:SCROLL_ADMIN_READ_ONLY_DB_CONFIG_DSN',
      ],
      'blockbook': [
        'DOGECOIN_RPC_USER:DOGECOIN_RPC_USER',
        'DOGECOIN_RPC_PASSWORD:DOGECOIN_RPC_PASSWORD',
      ],
      blockscout: ['BLOCKSCOUT_DB_CONNECTION_STRING:DATABASE_URL'],
      'bridge-history-api': ['BRIDGE_HISTORY_DB_CONNECTION_STRING:SCROLL_BRIDGE_HISTORY_DB_DSN'],
      'bridge-history-fetcher': ['BRIDGE_HISTORY_DB_CONNECTION_STRING:SCROLL_BRIDGE_HISTORY_DB_DSN'],
      'chain-monitor': ['CHAIN_MONITOR_DB_CONNECTION_STRING:SCROLL_CHAIN_MONITOR_DB_CONFIG_DSN'],
      'contracts': [
        'DEPLOYER_PRIVATE_KEY:DEPLOYER_PRIVATE_KEY',
        'L1_COMMIT_SENDER_PRIVATE_KEY:L1_COMMIT_SENDER_PRIVATE_KEY',
        'L2_GAS_ORACLE_SENDER_PRIVATE_KEY:L2_GAS_ORACLE_SENDER_PRIVATE_KEY',
        'ROLLUP_EXPLORER_DB_CONNECTION_STRING:ROLLUP_EXPLORER_DB_CONNECTION_STRING',
      ],
      'coordinator-api': [
        'COORDINATOR_DB_CONNECTION_STRING:SCROLL_COORDINATOR_DB_DSN',
      ],
      'coordinator-cron': [
        'COORDINATOR_DB_CONNECTION_STRING:SCROLL_COORDINATOR_DB_DSN',
      ],
      'dogecoin': [
        'DOGECOIN_RPC_USER:DOGECOIN_RPC_USER',
        'DOGECOIN_RPC_PASSWORD:DOGECOIN_RPC_PASSWORD',
      ],
      'gas-oracle': [
        'GAS_ORACLE_DB_CONNECTION_STRING:SCROLL_ROLLUP_DB_CONFIG_DSN',
      ],
      'l1-explorer': ['L1_EXPLORER_DB_CONNECTION_STRING:DATABASE_URL'],
      'l2-sequencer': [
        'L2GETH_KEYSTORE:L2GETH_KEYSTORE',
        'L2GETH_PASSWORD:L2GETH_PASSWORD',
        'L2GETH_NODEKEY:L2GETH_NODEKEY',
      ],
      'testnet-activity-helper': [
        'L2_TESTNET_ACTIVITY_HELPER_PRIVATE_KEY:private-key',
      ],
      'withdrawal-processor': [],
    }

    const envFiles: { [key: string]: string } = {}

    if (service === 'l2-sequencer') {
      if (!config.sequencer) {
        this.jsonCtx.log(chalk.yellow('No [sequencer] configuration found in config.toml. Skipping l2-sequencer secret generation.'))
        return envFiles
      }

      let sequencerIndex = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const sequencerConfig =
          sequencerIndex === 0 ? config.sequencer : config.sequencer[`sequencer-${sequencerIndex}`]
        if (!sequencerConfig) break

        let content = ''
        for (const pair of mapping[service] || []) {
          const [envKey, configKey] = pair.split(':')
          if (sequencerConfig[configKey]) {
            content += this.envLine(envKey, sequencerConfig[configKey], `sequencer.${configKey}`)
          }
        }

        envFiles[`l2-sequencer-${sequencerIndex}-secret.env`] = content
        sequencerIndex++
      }
    } else if (service === 'l2-bootnode') {
      if (config.bootnode) {
        let bootnodeIndex = 0
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const bootnodeInstanceKey = `bootnode-${bootnodeIndex}`
          const bootnodeConfig = config.bootnode[bootnodeInstanceKey]

          if (!bootnodeConfig) {
            break
          }

          const nodeKey = bootnodeConfig.L2GETH_NODEKEY === undefined ? '' : bootnodeConfig.L2GETH_NODEKEY
          envFiles[`l2-bootnode-${bootnodeIndex}-secret.env`] =
            this.envLine('L2GETH_NODEKEY', nodeKey, `bootnode.${bootnodeInstanceKey}.L2GETH_NODEKEY`)
          bootnodeIndex++
        }
      } else {
        this.jsonCtx.log(chalk.yellow('No [bootnode] configuration found in config.toml. Skipping l2-bootnode secret generation.'))
      }
    } else {
      let content = ''
      for (const pair of mapping[service] || []) {
        const [configKey, envKey] = pair.split(':')
        const value = this.getMappedConfigValue(config, configKey)
        if (value) {
          content += this.envLine(envKey, value, configKey)
        }
      }

      if (content.length > 0) {
        envFiles[`${service}-secret.env`] = content
      }
    }

    if (service === 'fee-oracle') {
      const signer = this.requireSigner('l2GasOracleSender')
      if (isLocalSigner(signer)) {
        const privateKey = this.requireConfigValue(
          this.getDogeAccountValue('L2_GAS_ORACLE_SENDER_PRIVATE_KEY'),
          'dogeConfig.accounts.L2_GAS_ORACLE_SENDER_PRIVATE_KEY'
        )
        envFiles['fee-oracle-secret.env'] = this.envLine(
          'DOGEOS_FEE_ORACLE_PRIVATE_KEY',
          privateKey,
          'dogeConfig.accounts.L2_GAS_ORACLE_SENDER_PRIVATE_KEY'
        )
      }
    }

    if (service === 'l1-interface') {
      let content = this.envLine('DOGEOS_L1_INTERFACE_DOGECOIN_RPC__USER', this.dogeConfig.dogecoinClusterRpc?.username || '', 'dogeConfig.dogecoinClusterRpc.username')
      content += this.envLine('DOGEOS_L1_INTERFACE_DOGECOIN_RPC__PASS', this.dogeConfig.dogecoinClusterRpc?.password || '', 'dogeConfig.dogecoinClusterRpc.password')
      content += this.envLine('DOGEOS_L1_INTERFACE_DOGECOIN_RPC__BLOCKBOOK_API_KEY', '', 'DOGEOS_L1_INTERFACE_DOGECOIN_RPC__BLOCKBOOK_API_KEY')
      envFiles['l1-interface-secret.env'] = content
    }

    if (service === 'blockbook') {
      envFiles['blockbook-secret.env'] = this.envLine('DOGECOIN_RPC_USER', this.dogeConfig.dogecoinClusterRpc?.username || '', 'dogeConfig.dogecoinClusterRpc.username')
      envFiles['blockbook-secret.env'] += this.envLine('DOGECOIN_RPC_PASSWORD', this.dogeConfig.dogecoinClusterRpc?.password || '', 'dogeConfig.dogecoinClusterRpc.password')
    }

    if (service === 'dogecoin') {
      envFiles['dogecoin-secret.env'] = this.envLine('DOGECOIN_RPC_USER', this.dogeConfig.dogecoinClusterRpc?.username || '', 'dogeConfig.dogecoinClusterRpc.username')
      envFiles['dogecoin-secret.env'] += this.envLine('DOGECOIN_RPC_PASSWORD', this.dogeConfig.dogecoinClusterRpc?.password || '', 'dogeConfig.dogecoinClusterRpc.password')
    }

    if (service === 'metrics-exporter') {
      const credentials = Buffer.from(`${this.dogeConfig.dogecoinClusterRpc?.username}:${this.dogeConfig.dogecoinClusterRpc?.password}`).toString('base64')
      envFiles['metrics-exporter-secret.env'] = this.envLine('METRICS_EXPORTER_DOGECOIN_BASIC_AUTH', credentials, 'metrics-exporter basic auth')
    }

    if (service === 'withdrawal-processor') {
      let content = ''
      content += this.envLine('DOGEOS_WITHDRAWAL_DOGECOIN_RPC_USER', this.dogeConfig.dogecoinClusterRpc?.username || '', 'dogeConfig.dogecoinClusterRpc.username')
      content += this.envLine('DOGEOS_WITHDRAWAL_DOGECOIN_RPC_PASS', this.dogeConfig.dogecoinClusterRpc?.password || '', 'dogeConfig.dogecoinClusterRpc.password')

      const withdrawalProcessorTomlPath = path.join(process.cwd(), '.data', 'output-withdrawal-processor.toml')
      if (fs.existsSync(withdrawalProcessorTomlPath)) {
        const withdrawalProcessorToml = toml.parse(fs.readFileSync(withdrawalProcessorTomlPath, 'utf8'))
        content += this.envLine('DOGEOS_WITHDRAWAL_FEE_SIGNER_KEY', withdrawalProcessorToml.fee_signer_key, 'output-withdrawal-processor.fee_signer_key')
        content += this.envLine('DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KEY', withdrawalProcessorToml.sequencer_signer_key, 'output-withdrawal-processor.sequencer_signer_key')
      } else {
        this.jsonCtx.error(
          'E101_CONFIG_NOT_FOUND',
          `${withdrawalProcessorTomlPath} not found`,
          'CONFIGURATION',
          true,
          { path: withdrawalProcessorTomlPath }
        )
      }

      envFiles['withdrawal-processor-secret.env'] = content
    }

    if (service === 'eth-da-submitter') {
      const signer = this.requireSigner('l1CommitSender')
      if (isAwsKmsSigner(signer)) {
        return envFiles
      }

      const submitterPrivateKey = this.requireConfigValue(
        this.getDogeAccountValue('L1_COMMIT_SENDER_PRIVATE_KEY'),
        'dogeConfig.accounts.L1_COMMIT_SENDER_PRIVATE_KEY'
      )
      envFiles['eth-da-submitter-secret.env'] = this.envLine(
        'DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__SUBMITTER_PRIVATE_KEY',
        submitterPrivateKey,
        'dogeConfig.accounts.L1_COMMIT_SENDER_PRIVATE_KEY'
      )
    }

    return envFiles
  }

  private generateRethEnvFiles(): { [key: string]: string } {
    const envFiles: { [key: string]: string } = {}

    for (const instance of this.dogeConfig.bootnodeReth?.instances ?? []) {
      if (instance.nodekey?.secretMode === 'plain') continue
      const nodekey = this.requireConfigValue(
        instance.nodekey?.privateKey,
        `dogeConfig.bootnodeReth.instances[index=${instance.index}].nodekey.privateKey`
      )
      envFiles[`${getBootnodeRethResourceName(instance.index)}-secret.env`] = this.envLine(
        RETH_BOOTNODE_NODEKEY_ENV,
        nodekey,
        `dogeConfig.bootnodeReth.instances[index=${instance.index}].nodekey.privateKey`
      )
    }

    for (const instance of this.dogeConfig.sequencerReth?.instances ?? []) {
      const {signer} = instance
      const signerMode = signerModeToConfig(normalizeSignerMode(String(this.requireConfigValue(
        signer?.mode,
        `dogeConfig.sequencerReth.instances[index=${instance.index}].signer.mode`
      ))))
      const nodekeySecretMode = instance.nodekey?.secretMode || signerMode.secretMode
      if (nodekeySecretMode === 'plain') continue

      const nodekey = this.requireConfigValue(
        instance.nodekey?.privateKey,
        `dogeConfig.sequencerReth.instances[index=${instance.index}].nodekey.privateKey`
      )
      let content = this.envLine(
        RETH_NODEKEY_ENV,
        nodekey,
        `dogeConfig.sequencerReth.instances[index=${instance.index}].nodekey.privateKey`
      )

      if (signerMode.signerBackend === 'local') {
        const signerPrivateKey = this.requireConfigValue(
          signer?.privateKey,
          `dogeConfig.sequencerReth.instances[index=${instance.index}].signer.privateKey`
        )
        content += this.envLine(
          RETH_SIGNER_PRIVATE_KEY_ENV,
          signerPrivateKey,
          `dogeConfig.sequencerReth.instances[index=${instance.index}].signer.privateKey`
        )
      }

      envFiles[`${getSequencerRethResourceName(instance.index)}-secret.env`] = content
    }

    return envFiles
  }

  private getDogeAccountValue(key: keyof NonNullable<DogeConfig['accounts']>): unknown {
    return this.dogeConfig.accounts?.[key]
  }

  private getMappedConfigValue(config: any, configKey: string): unknown {
    if (configKey === 'L1_COMMIT_SENDER_PRIVATE_KEY') {
      return isAwsKmsSigner(this.requireSigner('l1CommitSender'))
        ? undefined
        : this.getDogeAccountValue('L1_COMMIT_SENDER_PRIVATE_KEY')
    }

    if (configKey === 'L2_GAS_ORACLE_SENDER_PRIVATE_KEY') {
      return isAwsKmsSigner(this.requireSigner('l2GasOracleSender'))
        ? undefined
        : this.getDogeAccountValue('L2_GAS_ORACLE_SENDER_PRIVATE_KEY')
    }

    if (config.db && config.db[configKey]) return config.db[configKey]
    if (config.accounts && config.accounts[configKey]) return config.accounts[configKey]
    if (config.coordinator && config.coordinator[configKey]) return config.coordinator[configKey]
    if (config.sequencer && config.sequencer[configKey]) return config.sequencer[configKey]
    return undefined
  }

  private requireConfigValue(value: unknown, source: string): unknown {
    if (value === undefined || value === null || String(value).trim() === '') {
      this.jsonCtx.error(
        'E611_REQUIRED_SECRET_VALUE_MISSING',
        `${source} is required for secret generation. Re-run the corresponding setup command to recreate key configuration.`,
        'CONFIGURATION',
        true,
        { source }
      )
    }

    return value
  }

  private requireSigner(signerKey: 'l1CommitSender' | 'l2GasOracleSender') {
    try {
      return getRequiredManagedSignerConfig(this.dogeConfig, signerKey)
    } catch (error) {
      this.jsonCtx.error(
        'E610_SIGNER_CONFIG_MISSING',
        error instanceof Error ? error.message : String(error),
        'CONFIGURATION',
        true,
        { signer: signerKey }
      )
    }
  }

  private resolveSecretValue(value: unknown, source: string): string {
    if (value === undefined || value === null) {
      return ''
    }

    return String(value).replaceAll(/\$ENV:(\w+)/g, (_match, envVarName: string) => {
      const envValue = process.env[envVarName]
      if (envValue === undefined || envValue === '') {
        this.jsonCtx.error(
          'E601_MISSING_ENV_VAR',
          `Environment variable ${envVarName} referenced by ${source} is not set`,
          'CONFIGURATION',
          true,
          { envVarName, source }
        )
      }

      return envValue
    })
  }

}
