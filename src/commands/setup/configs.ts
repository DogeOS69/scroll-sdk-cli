import * as toml from '@iarna/toml'
import { confirm, input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import Docker from 'dockerode'
import { ethers } from 'ethers'
import * as yaml from 'js-yaml'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { DogeConfig } from '../../types/doge-config.js'

import { CONTRACTS_DOCKER_DEFAULT_TAG, DOCKER_REPOSITORY, DOCKER_TAGS_URL } from '../../constants/docker.js'
import { writeConfigs } from '../../utils/config-writer.js'
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {
  resolveEnvValue,
} from '../../utils/non-interactive.js'

const SECRETS_PATH = path.join(process.cwd(), 'secrets')

export default class SetupConfigs extends Command {
  static override description = 'Generate configuration files and create environment files for services'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --image-tag gen-configs-v0.2.0-debug',
    '<%= config.bin %> <%= command.id %> --configs-dir ./configs-override',
  ]

  static override flags = {
    'base-fee-per-gas': Flags.string({
      description: 'Base fee per gas (non-interactive mode). Uses existing config value if not provided.',
    }),
    'configs-dir': Flags.string({
      default: 'values',
      description: 'Directory name to copy configs to',
      required: false,
    }),
    'deployment-salt': Flags.string({
      description: 'Deployment salt value (non-interactive mode). If not provided, keeps existing or auto-increments.',
    }),
    'doge-config': Flags.string({
      description: 'Path to config file (e.g., .data/doge-config-mainnet.toml or .data/doge-config-testnet.toml)',
      required: false,
    }),
    'image-tag': Flags.string({
      description: 'Specify the Docker image tag to use',
      required: false,
    }),
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    'l1-fee-vault-addr': Flags.string({
      description: 'L1 fee vault address (non-interactive mode). Defaults to OWNER_ADDR.',
    }),
    'l1-plonk-verifier-addr': Flags.string({
      description: 'L1 plonk verifier address (non-interactive mode). If not provided, one will be deployed.',
    }),
    'l2-bridge-fee-recipient-addr': Flags.string({
      description: 'L2 bridge fee recipient address (non-interactive mode). Defaults to zero address.',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts. Uses config values or sensible defaults.',
    }),
    'skip-deployment-salt-update': Flags.boolean({
      default: false,
      description: 'Skip deployment salt update (non-interactive mode)',
    }),
    'skip-l1-fee-vault-update': Flags.boolean({
      default: false,
      description: 'Skip L1 fee vault address update (non-interactive mode)',
    }),
    'skip-l1-plonk-verifier-update': Flags.boolean({
      default: true,
      description: 'Skip L1 plonk verifier address update (non-interactive mode)',
    }),
  }

  private dogeConfig: DogeConfig = {} as DogeConfig
  private jsonCtx!: JsonOutputContext
  private jsonMode: boolean = false
  private nonInteractive: boolean = false

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupConfigs)

    // Setup non-interactive/JSON mode
    this.nonInteractive = flags['non-interactive']
    this.jsonMode = flags.json
    this.jsonCtx = new JsonOutputContext('setup configs', this.jsonMode)

    const imageTag = await this.getDockerImageTag(flags['image-tag'])
    this.jsonCtx.info(`Using Docker image tag: ${imageTag}`)

    const configsDir = flags['configs-dir']
    this.jsonCtx.info(`Using configuration directory: ${configsDir}`)

    const dogeConfigResult = await loadDogeConfigWithSelection(
      flags['doge-config'],
      'scrollsdk doge:config'
    )

    this.dogeConfig = dogeConfigResult.config
    this.jsonCtx.info(`Using Dogecoin config file: ${dogeConfigResult.configPath}`)

    // Skip L1_CONTRACT_DEPLOYMENT_BLOCK for DogeOS network
    // this.jsonCtx.info('Checking L1_CONTRACT_DEPLOYMENT_BLOCK...')
    // await this.updateL1ContractDeploymentBlock()

    this.jsonCtx.info('Checking deployment salt...')
    await this.updateDeploymentSalt(flags)

    this.jsonCtx.info('Checking L1_FEE_VAULT_ADDR...')
    await this.updateL1FeeVaultAddr(flags)

    this.jsonCtx.info('Checking L2_BRIDGE_FEE_RECIPIENT_ADDR...')
    await this.updateL2BridgeFeeRecipientAddr(flags)

    this.jsonCtx.info('Checking L1_PLONK_VERIFIER_ADDR...')
    await this.updateL1PlonkVerifierAddr(flags)

    await this.updateBaseFeePerGas(flags)

    this.jsonCtx.info('Running docker command to generate configs...')
    await this.runDockerCommand(imageTag)

    const publicConfigPath = path.join(process.cwd(), 'config.public.toml')
    if (fs.existsSync(publicConfigPath)) {
      try {
        const publicConfigContent = fs.readFileSync(publicConfigPath, 'utf8')
        toml.parse(publicConfigContent)
        this.jsonCtx.logSuccess('Successfully parsed config.public.toml')
      } catch (error: any) {
        this.jsonCtx.error(
          'E602_INVALID_CONFIG_FORMAT',
          `Failed to parse config.public.toml: ${error.message}`,
          'CONFIGURATION',
          false
        )
      }
    } else {
      this.jsonCtx.addWarning('config.public.toml not found after docker command. Skipping .env generation for docker-compose.')
    }

    this.jsonCtx.info('Creating secrets folder...')
    this.createSecretsFolder()

    this.jsonCtx.info('Creating secrets environment files...')
    await this.createEnvFiles()

    this.jsonCtx.info('Processing YAML files...')
    await this.processYamlFiles(configsDir)

    this.jsonCtx.logSuccess('Configuration setup completed.')

    // JSON output
    if (this.jsonMode) {
      this.jsonCtx.success({
        configsDir,
        dogeConfigPath: dogeConfigResult.configPath,
        imageTag,
        secretsCreated: true,
        yamlFilesProcessed: true,
      })
    }

  }

  private canAccessFile(filePath: string): boolean {
    try {
      // eslint-disable-next-line no-bitwise
      fs.accessSync(filePath, fs.constants.R_OK | fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  }

  private async createEnvFiles(): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.error(chalk.red('config.toml not found in the current directory.'))
      return
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = toml.parse(configContent)

    const services = [
      // 'admin-system-backend',
      // 'admin-system-cron',
      'blockscout',
      // 'bridge-history-api',
      // 'bridge-history-fetcher',
      // 'chain-monitor',
      'coordinator-api',
      'coordinator-cron',
      // 'gas-oracle',
      'fee-oracle',
      // 'l1-explorer',
      'l2-sequencer',
      'rollup-relayer',
      'contracts',
      'l2-bootnode',
      'dogecoin',
      'testnet-activity-helper',
      'l1-interface',
      'blockbook',
      'dogecoin',
      'withdrawal-processor',
      'metrics-exporter',
      'celestia-node',
    ]

    for (const service of services) {
      const envFiles = this.generateEnvContent(service, config)
      for (const [filename, content] of Object.entries(envFiles)) {
        const envFile = path.join(SECRETS_PATH, filename)
        fs.writeFileSync(envFile, content)
        this.jsonCtx.log(chalk.green(`Created ${filename}`))
      }
    }

    // Create additional files
    this.createMigrateDbFiles(config)
  }

  private createMigrateDbFiles(config: any): void {
    const migrateDbFiles = [
      // { key: 'BRIDGE_HISTORY_DB_CONNECTION_STRING', service: 'bridge-history-fetcher' },
      // { key: 'GAS_ORACLE_DB_CONNECTION_STRING', service: 'gas-oracle' },
      { key: 'ROLLUP_NODE_DB_CONNECTION_STRING', service: 'rollup-relayer' },
    ]

    for (const file of migrateDbFiles) {
      const filePath = path.join(SECRETS_PATH, `${file.service}-migrate-db.json`)
      const content: any =
        file.service === 'bridge-history-fetcher'
          ? {
            db: {
              driver_name: 'postgres',
              dsn: config.db[file.key],
              maxIdleNume: 5,
              maxOpenNum: 50,
            },
            l1: {},
            l2: {},
          }
          : {
            driver_name: 'postgres',
            dsn: config.db[file.key],
          }

      fs.writeFileSync(filePath, JSON.stringify(content, null, 2))
      this.jsonCtx.log(chalk.green(`Created ${file.service}-migrate-db.json`))
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

  private async fetchDockerTags(): Promise<string[]> {
    try {
      const response = await fetch(
        `${DOCKER_TAGS_URL}?page_size=100`,
      )
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      return data.results.map((tag: any) => tag.name).filter((tag: string) => tag.startsWith('gen-configs-'))
    } catch (error) {
      this.error(`Failed to fetch Docker tags: ${error}`)
    }
  }



  // TODO: check privatekey secrets once integrated
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
        'L1_FINALIZE_SENDER_PRIVATE_KEY:L1_FINALIZE_SENDER_PRIVATE_KEY',
        'L1_GAS_ORACLE_SENDER_PRIVATE_KEY:L1_GAS_ORACLE_SENDER_PRIVATE_KEY',
        'L2_GAS_ORACLE_SENDER_PRIVATE_KEY:L2_GAS_ORACLE_SENDER_PRIVATE_KEY',
        'ROLLUP_EXPLORER_DB_CONNECTION_STRING:ROLLUP_EXPLORER_DB_CONNECTION_STRING',
        'COORDINATOR_JWT_SECRET_KEY:COORDINATOR_JWT_SECRET_KEY'
      ],
      'coordinator-api': [
        'COORDINATOR_DB_CONNECTION_STRING:SCROLL_COORDINATOR_DB_DSN',
        'COORDINATOR_JWT_SECRET_KEY:SCROLL_COORDINATOR_AUTH_SECRET',
      ],
      'coordinator-cron': [
        'COORDINATOR_DB_CONNECTION_STRING:SCROLL_COORDINATOR_DB_DSN',
        'COORDINATOR_JWT_SECRET_KEY:SCROLL_COORDINATOR_AUTH_SECRET',
      ],
      'dogecoin': [
        'DOGECOIN_RPC_USER:DOGECOIN_RPC_USER',
        'DOGECOIN_RPC_PASSWORD:DOGECOIN_RPC_PASSWORD',
      ],
      'gas-oracle': [
        'GAS_ORACLE_DB_CONNECTION_STRING:SCROLL_ROLLUP_DB_CONFIG_DSN',
        'L1_GAS_ORACLE_SENDER_PRIVATE_KEY:SCROLL_ROLLUP_L2_CONFIG_RELAYER_CONFIG_GAS_ORACLE_SENDER_SIGNER_CONFIG_PRIVATE_KEY_SIGNER_CONFIG_PRIVATE_KEY',
        'L2_GAS_ORACLE_SENDER_PRIVATE_KEY:SCROLL_ROLLUP_L1_CONFIG_RELAYER_CONFIG_GAS_ORACLE_SENDER_SIGNER_CONFIG_PRIVATE_KEY_SIGNER_CONFIG_PRIVATE_KEY',
      ],
      'l1-explorer': ['L1_EXPLORER_DB_CONNECTION_STRING:DATABASE_URL'],
      'l2-sequencer': [
        'L2GETH_KEYSTORE:L2GETH_KEYSTORE',
        'L2GETH_PASSWORD:L2GETH_PASSWORD',
        'L2GETH_NODEKEY:L2GETH_NODEKEY',
      ],
      'rollup-relayer': [
        'ROLLUP_NODE_DB_CONNECTION_STRING:SCROLL_ROLLUP_DB_CONFIG_DSN',
        'L1_COMMIT_SENDER_PRIVATE_KEY:SCROLL_ROLLUP_L2_CONFIG_RELAYER_CONFIG_COMMIT_SENDER_SIGNER_CONFIG_PRIVATE_KEY_SIGNER_CONFIG_PRIVATE_KEY',
        'L1_FINALIZE_SENDER_PRIVATE_KEY:SCROLL_ROLLUP_L2_CONFIG_RELAYER_CONFIG_FINALIZE_SENDER_SIGNER_CONFIG_PRIVATE_KEY_SIGNER_CONFIG_PRIVATE_KEY',
      ],
      'testnet-activity-helper': [
        'L2_TESTNET_ACTIVITY_HELPER_PRIVATE_KEY:private-key',
      ],
      'withdrawal-processor': [
      ],
    }

    const envFiles: { [key: string]: string } = {}

    if (service === 'l2-sequencer') {
      // Handle all sequencers (primary and backups)
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
            content += `${envKey}="${sequencerConfig[configKey]}"\n`
          }
        }

        envFiles[`l2-sequencer-${sequencerIndex}-secret.env`] = content
        sequencerIndex++
      }
    } else if (service === 'l2-bootnode') {
      // Handle L2 bootnode secrets
      if (config.bootnode) {
        let bootnodeIndex = 0
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const bootnodeInstanceKey = `bootnode-${bootnodeIndex}`
          const bootnodeConfig = config.bootnode[bootnodeInstanceKey]

          if (!bootnodeConfig) {
            // No more bootnode instances defined
            break
          }

          // L2GETH_NODEKEY is expected.
          // If it's missing for a defined bootnode instance in config.toml, default to an empty string.
          // config.toml.example shows L2GETH_NODEKEY="", so it should typically exist.
          const nodeKey = bootnodeConfig.L2GETH_NODEKEY === undefined ? '' : bootnodeConfig.L2GETH_NODEKEY
          envFiles[`l2-bootnode-${bootnodeIndex}-secret.env`] = `L2GETH_NODEKEY="${nodeKey}"\n`
          bootnodeIndex++
        }
      } else {
        this.jsonCtx.log(chalk.yellow('No [bootnode] configuration found in config.toml. Skipping l2-bootnode secret generation.'))
      }
    }
    else {
      // Handle other services
      let content = ''
      for (const pair of mapping[service] || []) {
        const [configKey, envKey] = pair.split(':')
        if (config.db && config.db[configKey]) {
          content += `${envKey}="${config.db[configKey]}"\n`
        } else if (config.accounts && config.accounts[configKey]) {
          content += `${envKey}="${config.accounts[configKey]}"\n`
        } else if (config.coordinator && config.coordinator[configKey]) {
          content += `${envKey}="${config.coordinator[configKey]}"\n`
        } else if (config.sequencer && config.sequencer[configKey]) {
          content += `${envKey}="${config.sequencer[configKey]}"\n`
        }
      }

      if (content.length > 0) {
        envFiles[`${service}-secret.env`] = content
      }
    }

    if (service === 'fee-oracle') {
      let content = `DOGEOS_FEE_ORACLE_DOGECOIN__RPC_USER="${this.dogeConfig.dogecoinClusterRpc?.username || ''}"\n`
      content += `DOGEOS_FEE_ORACLE_DOGECOIN__RPC_PASSWORD="${this.dogeConfig.dogecoinClusterRpc?.password || ''}"\n`
      content += `DOGEOS_FEE_ORACLE_CELESTIA__TENDERMINT_RPC_URL="${this.dogeConfig.da?.tendermintRpcUrl || ''}"\n`
      content += `DOGEOS_FEE_ORACLE_PRIVATE_KEY="${config.accounts.L2_GAS_ORACLE_SENDER_PRIVATE_KEY || ''}"\n`
      envFiles['fee-oracle-secret.env'] = content
    }

    if (service === 'l1-interface') {
      let content = `DOGEOS_L1_INTERFACE_DOGECOIN_RPC__USER="${this.dogeConfig.dogecoinClusterRpc?.username || ''}"\n`
      content += `DOGEOS_L1_INTERFACE_DOGECOIN_RPC__PASS="${this.dogeConfig.dogecoinClusterRpc?.password || ''}"\n`
      content += `DOGEOS_L1_INTERFACE_DOGECOIN_RPC__BLOCKBOOK_API_KEY=""\n`

      const url = this.dogeConfig.da?.tendermintRpcUrl || '';
      const lastPart = url.split('/').filter(Boolean).pop() || '';
      content += `DOGEOS_L1_INTERFACE_CELESTIA_INDEXER__BLOB_GET_ALL_FALLBACK_TOKEN=${lastPart}\n`
      envFiles['l1-interface-secret.env'] = content
    }

    if (service === 'blockbook') {
      envFiles['blockbook-secret.env'] = `DOGECOIN_RPC_USER="${this.dogeConfig.dogecoinClusterRpc?.username || ''}"\n`
      envFiles['blockbook-secret.env'] += `DOGECOIN_RPC_PASSWORD="${this.dogeConfig.dogecoinClusterRpc?.password || ''}"\n`
    }

    if (service === 'dogecoin') {
      envFiles['dogecoin-secret.env'] = `DOGECOIN_RPC_USER="${this.dogeConfig.dogecoinClusterRpc?.username}"\nDOGECOIN_RPC_PASSWORD="${this.dogeConfig.dogecoinClusterRpc?.password}"\n`
    }

    if (service === 'metrics-exporter') {
      const credentials = Buffer.from(`${this.dogeConfig.dogecoinClusterRpc?.username}:${this.dogeConfig.dogecoinClusterRpc?.password}`).toString('base64')
      envFiles['metrics-exporter-secret.env'] = `METRICS_EXPORTER_DOGECOIN_BASIC_AUTH="${credentials}"\n`
    }

    if (service === 'withdrawal-processor') {
      // Handle regular config mappings first
      let content = ''
      // content += `DOGEOS_WITHDRAWAL_DATABASE_URL="${this.dogeConfig.rpc?.databaseUrl || ''}"\n`
      // Add Dogecoin RPC credentials from doge-config
      content += `DOGEOS_WITHDRAWAL_DOGECOIN_RPC_USER="${this.dogeConfig.dogecoinClusterRpc?.username || ''}"\n`
      content += `DOGEOS_WITHDRAWAL_DOGECOIN_RPC_PASS="${this.dogeConfig.dogecoinClusterRpc?.password || ''}"\n`
      content += `DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__TENDERMINT_RPC_URL="${this.dogeConfig.da?.tendermintRpcUrl || ''}"\n`

      // Add values from output-withdrawal-processor.toml
      const withdrawal_processor_toml_path = path.join(process.cwd(), ".data", "output-withdrawal-processor.toml");
      if (fs.existsSync(withdrawal_processor_toml_path)) {
        const withdrawal_processor_toml = toml.parse(fs.readFileSync(withdrawal_processor_toml_path, "utf8"));
        content += `DOGEOS_WITHDRAWAL_FEE_SIGNER_KEY="${withdrawal_processor_toml.fee_signer_key}"\n`
        content += `DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KEY="${withdrawal_processor_toml.sequencer_signer_key}"\n`
      } else {
        this.error(`${withdrawal_processor_toml_path} not found`)
      }

      const url = this.dogeConfig.da?.tendermintRpcUrl || '';
      const lastPart = url.split('/').filter(Boolean).pop() || '';
      content += `DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__BLOB_GET_ALL_FALLBACK_TOKEN=${lastPart}\n`;

      envFiles['withdrawal-processor-secret.env'] = content
    }

    if (service === 'celestia-node') {
      let content = `mnemonic="${this.dogeConfig.da?.celestiaMnemonic}"\n`
      const url = this.dogeConfig.da?.tendermintRpcUrl || '';
      const lastPart = url.split('/').filter(Boolean).pop() || '';
      content += `x-token="${lastPart}"\n`;
      envFiles['celestia-node-secret.env'] = content
    }

    return envFiles
  }

  private async getDockerImageTag(providedTag: string | undefined): Promise<string> {
    const defaultTag = `gen-configs-${CONTRACTS_DOCKER_DEFAULT_TAG}`

    if (!providedTag) {
      return defaultTag
    }

    const tags = await this.fetchDockerTags()

    if (providedTag.startsWith('gen-configs-') && tags.includes(providedTag)) {
      return providedTag
    }

    if (providedTag.startsWith('v') && tags.includes(`gen-configs-${providedTag}`)) {
      return `gen-configs-${providedTag}`
    }

    if (/^\d+\.\d+\.\d+$/.test(providedTag) && tags.includes(`gen-configs-v${providedTag}`)) {
      return `gen-configs-v${providedTag}`
    }

    // In non-interactive mode, use default tag if provided tag is invalid
    if (this.nonInteractive) {
      this.jsonCtx.addWarning(`Provided tag "${providedTag}" not found, using default: ${defaultTag}`)
      return defaultTag
    }

    const selectedTag = await select({
      choices: tags.map((tag) => ({ name: tag, value: tag })),
      message: 'Select a Docker image tag:',
    })

    return selectedTag
  }

  private async processYamlFiles(configsDir: string): Promise<void> {
    const sourceDir = process.cwd()
    const targetDir = path.join(sourceDir, configsDir)

    // Ensure the target directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }

    // Check permissions and potentially change ownership before processing
    const yamlFiles = fs.readdirSync(sourceDir).filter((file) => file.endsWith('.yaml'))
    if (yamlFiles.some((file) => !this.canAccessFile(path.join(sourceDir, file)))) {
      let changeOwnership = true
      if (this.nonInteractive) {
        this.jsonCtx.info('Non-interactive mode: Attempting to change ownership of YAML files with permission issues...')
      } else {
        changeOwnership = await confirm({
          message:
            'Some YAML files have permission issues. Would you like to change their ownership to the current user?',
        })
      }

      if (changeOwnership) {
        try {
          const command = `sudo find ${sourceDir} -name "*.yaml" -user root -exec sudo chown -R $USER: {} \\;`
          childProcess.execSync(command, { stdio: 'inherit' })
          this.jsonCtx.logSuccess('File ownership changed successfully.')
        } catch (error) {
          if (this.nonInteractive) {
            this.jsonCtx.error(
              'E900_UNEXPECTED_ERROR',
              `Failed to change file ownership: ${error}`,
              'INTERNAL',
              false
            )
          }

          this.error(`Failed to change file ownership: ${error}`)
          return // Exit the method if we can't change permissions
        }
      } else {
        this.jsonCtx.addWarning('File ownership not changed. Some files may not be accessible.')
        return // Exit the method if user chooses not to change permissions
      }
    }

    const fileMappings = [
      { source: 'admin-system-backend-config.yaml', target: 'admin-system-backend-config.yaml' },
      { source: 'admin-system-backend-config.yaml', target: 'admin-system-cron-config.yaml' },
      { source: 'balance-checker-config.yaml', target: 'balance-checker-config.yaml' },
      { source: 'bridge-history-config.yaml', target: 'bridge-history-api-config.yaml' },
      { source: 'bridge-history-config.yaml', target: 'bridge-history-fetcher-config.yaml' },
      { source: 'chain-monitor-config.yaml', target: 'chain-monitor-config.yaml' },
      { source: 'coordinator-api-config.yaml', target: 'coordinator-api-config.yaml' },
      { source: 'coordinator-cron-config.yaml', target: 'coordinator-cron-config.yaml' },
      { source: 'frontend-config.yaml', target: 'frontends-config.yaml' },
      { source: 'genesis.yaml', target: 'genesis.yaml' },
      { source: 'gas-oracle-config.yaml', target: 'gas-oracle-config.yaml' },
      { source: 'rollup-config.yaml', target: 'rollup-relayer-config.yaml' },
      { source: 'rollup-explorer-backend-config.yaml', target: 'rollup-explorer-backend-config.yaml' },
    ]

    // Process all mappings
    for (const mapping of fileMappings) {
      const sourcePath = path.join(sourceDir, mapping.source)
      const targetPath = path.join(targetDir, mapping.target)

      if (fs.existsSync(sourcePath)) {
        try {
          if (mapping.source === "gas-oracle-config.yaml") {
            // gas-oracle-config.yaml no longer used.
            continue;
          }

          fs.copyFileSync(sourcePath, targetPath)
          this.jsonCtx.log(chalk.green(`Processed file: ${mapping.source} -> ${mapping.target}`))

          if (mapping.target === 'rollup-explorer-backend-config.yaml') {
            const yamlFileContent = fs.readFileSync(targetPath, 'utf8')
            const parsedYaml = yaml.load(yamlFileContent) as any
            if (parsedYaml && parsedYaml.scrollConfig && typeof parsedYaml.scrollConfig === 'string') {
              try {
                const scrollConfigObject = JSON.parse(parsedYaml.scrollConfig)
                const prettyJsonString = JSON.stringify(scrollConfigObject, null, 2)
                const secretsDir = SECRETS_PATH
                const jsonOutputPath = path.join(secretsDir, 'rollup-explorer-backend-secret.json')
                fs.writeFileSync(jsonOutputPath, prettyJsonString)
                this.jsonCtx.log(chalk.green(`Extracted scrollConfig to ${jsonOutputPath}`))
                fs.unlinkSync(targetPath)
              } catch (jsonError) {
                this.jsonCtx.log(chalk.red(`Failed to parse scrollConfig JSON from ${targetPath}: ${jsonError}`))
              }
            } else {
              this.jsonCtx.log(chalk.yellow(`Could not find or parse scrollConfig in ${targetPath}`))
            }
          } else if (
            mapping.target === 'coordinator-api-config.yaml' ||
            mapping.target === 'coordinator-cron-config.yaml'
          ) {
            // remove auth.secret
            try {
              const yamlFileContent = fs.readFileSync(targetPath, 'utf8')
              const parsedYaml = yaml.load(yamlFileContent) as any

              if (!parsedYaml || parsedYaml.scrollConfig === undefined) {
                this.jsonCtx.log(chalk.yellow(`scrollConfig not found in ${mapping.target}`))
                continue
              }

              let scrollConfigObject: any
              const originalScrollConfig = parsedYaml.scrollConfig

              if (typeof originalScrollConfig === 'string') {
                scrollConfigObject = JSON.parse(originalScrollConfig)
              } else if (typeof originalScrollConfig === 'object' && originalScrollConfig !== null) {
                scrollConfigObject = originalScrollConfig
              } else {
                this.jsonCtx.log(chalk.yellow(`Unsupported scrollConfig format in ${mapping.target}`))
                continue
              }

              if (!scrollConfigObject || typeof scrollConfigObject !== 'object') {
                this.jsonCtx.log(chalk.yellow(`scrollConfig is not an object in ${mapping.target}`))
                continue
              }

              if (!scrollConfigObject.auth || typeof scrollConfigObject.auth !== 'object') {
                scrollConfigObject.auth = {}
                this.jsonCtx.log(chalk.yellow(`auth field missing; created auth object in ${mapping.target}`))
              }

              const hadSecretKey = Object.hasOwn(scrollConfigObject.auth, 'secret')
              scrollConfigObject.auth.secret = null
              if (hadSecretKey) {
                this.jsonCtx.log(chalk.green(`Sanitized auth.secret in ${mapping.target}`))
              } else {
                this.jsonCtx.log(chalk.yellow(`auth.secret key missing; initialized to null in ${mapping.target}`))
              }

              parsedYaml.scrollConfig =
                typeof originalScrollConfig === 'string'
                  ? JSON.stringify(scrollConfigObject, null, 2)
                  : scrollConfigObject

              const updatedYaml = yaml.dump(parsedYaml, {indent: 2})
              fs.writeFileSync(targetPath, updatedYaml)
            } catch (error) {
              if (error instanceof Error) {
                this.jsonCtx.log(chalk.red(`Failed to remove auth.secret in ${mapping.target}: ${error.message}`))
              } else {
                this.jsonCtx.log(chalk.red(`Unknown error updating ${mapping.target}`))
              }
            }
          }
        } catch (error: unknown) {
          if (error instanceof Error) {
            this.jsonCtx.log(chalk.red(`Error processing file ${mapping.source}: ${error.message}`))
          } else {
            this.jsonCtx.log(chalk.red(`Unknown error processing file ${mapping.source}`))
          }
        }
      } else {
        this.jsonCtx.log(chalk.yellow(`Source file not found: ${mapping.source}`))
      }
    }

    /*
        try {
          this.jsonCtx.log(chalk.blue(`generating balance-checker alert rules file...`))
          const scrollMonitorProductionFilePath = path.join(targetDir, 'scroll-monitor-production.yaml')
          const balanceCheckerConfigFilePath = path.join(targetDir, 'balance-checker-config.yaml')
          const addedAlertRules = this.generateAlertRules(balanceCheckerConfigFilePath)
          const existingContent = fs.readFileSync(scrollMonitorProductionFilePath, 'utf8')
          const existingYaml = yaml.load(existingContent) as any
          existingYaml['kube-prometheus-stack'].additionalPrometheusRules = addedAlertRules
          fs.writeFileSync(scrollMonitorProductionFilePath, yaml.dump(existingYaml, { indent: 2 }))
        } catch {
          this.error(`generating balance-checker alert rules file failed`)
        }
    */
    // Remove source files after all processing is complete
    for (const mapping of fileMappings) {
      const sourcePath = path.join(sourceDir, mapping.source)
      if (fs.existsSync(sourcePath)) {
        try {
          fs.unlinkSync(sourcePath)
          this.jsonCtx.log(chalk.green(`Removed source file: ${mapping.source}`))
        } catch (error: unknown) {
          if (error instanceof Error) {
            this.jsonCtx.log(chalk.red(`Error removing file ${mapping.source}: ${error.message}`))
          } else {
            this.jsonCtx.log(chalk.red(`Unknown error removing file ${mapping.source}`))
          }
        }
      }
    }

    // Process config.toml and config-contracts.toml
    const configFiles = [
      { key: 'scrollConfig', source: 'config.public.toml', target: 'scroll-common-config.yaml' },
      { key: 'scrollConfigContracts', source: 'config-contracts.toml', target: 'scroll-common-config-contracts.yaml' },
    ]

    for (const file of configFiles) {
      const sourcePath = path.join(sourceDir, file.source)
      const targetPath = path.join(targetDir, file.target)

      if (fs.existsSync(sourcePath)) {
        const content = fs.readFileSync(sourcePath, 'utf8')
        const yamlContent = {
          [file.key]: content,
        }
        const yamlString = yaml.dump(yamlContent, { indent: 2 })
        fs.writeFileSync(targetPath, yamlString)
        this.jsonCtx.log(chalk.green(`Processed file: ${file.target}`))
      } else {
        this.jsonCtx.log(chalk.yellow(`Source file not found: ${file.source}`))
      }
    }
  }

  private async runDockerCommand(imageTag: string): Promise<void> {
    const docker = new Docker()
    // const image = `dogeos69/scroll-stack-contracts:${imageTag}`
    const image = `${DOCKER_REPOSITORY}:${imageTag}`

    try {
      this.jsonCtx.info(`Pulling Docker Image: ${image}`)
      // Pull the image if it doesn't exist locally
      const pullStream = await docker.pull(image)
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(pullStream, (err, res) => {
          if (err) {
            reject(err)
          } else {
            this.jsonCtx.logSuccess('Image pulled successfully')
            resolve(res)
          }
        })
      })

      this.jsonCtx.info('Creating Docker Container...')
      // Create and run the container
      // Note: Container must run as root because forge is installed in /root/.foundry/
      // We fix file ownership after the container exits
      const container = await docker.createContainer({
        Cmd: [], // Add any command if needed
        HostConfig: {
          Binds: [`${process.cwd()}:/contracts/volume`],
        },
        Image: image,
      })

      this.jsonCtx.info('Starting Container')
      await container.start()

      // Wait for the container to finish and get the logs
      const stream = await container.logs({
        follow: true,
        stderr: true,
        stdout: true,
      })

      // Print the logs (stderr in JSON mode to keep stdout clean for JSON response)
      stream.pipe(this.jsonMode ? process.stderr : process.stdout)

      // Wait for the container to finish
      await new Promise((resolve) => {
        container.wait((err, data) => {
          if (err) {
            this.error(`Container exited with error: ${err}`)
          } else if (data.StatusCode !== 0) {
            this.error(`Container exited with status code: ${data.StatusCode}`)
          }

          resolve(null)
        })
      })

      // Clean up the log stream to prevent hanging
      stream.unpipe(this.jsonMode ? process.stderr : process.stdout)
      if ('destroy' in stream && typeof stream.destroy === 'function') {
        stream.destroy()
      }

      // Remove the container
      await container.remove()

      // Fix file ownership on POSIX systems (Docker runs as root, creates root-owned files)
      // Use a lightweight container to chown files since non-root can't chown root-owned files
      if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
        const uid = process.getuid()
        const gid = process.getgid()
        if (uid !== 0) {
          this.jsonCtx.info('Fixing file ownership...')
          try {
            // Pull alpine if not available
            try {
              await docker.pull('alpine:latest')
            } catch {
              // Ignore pull errors - image might already exist
            }

            const chownContainer = await docker.createContainer({
              Cmd: ['chown', '-R', `${uid}:${gid}`, '/volume'],
              HostConfig: {
                AutoRemove: true,
                Binds: [`${process.cwd()}:/volume`],
              },
              Image: 'alpine:latest',
            })
            await chownContainer.start()
            await chownContainer.wait()
          } catch (chownError) {
            this.jsonCtx.addWarning(`Could not fix file ownership: ${chownError}`)
            this.jsonCtx.addWarning('Files may be owned by root. Run: sudo chown -R $(id -u):$(id -g) .')
          }
        }
      }
    } catch (error) {
      this.error(`Failed to run Docker command: ${error}`)
    } finally {
      // Close Docker HTTP agent to release event loop
      const agent = (docker.modem as any).agent
      if (agent && typeof agent.destroy === 'function') {
        agent.destroy()
      }
    }
  }

  private async updateBaseFeePerGas(flags: any): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.addWarning('config.toml not found. Skipping BASE_FEE_PER_GAS update.')
      return
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = toml.parse(configContent)

    const currentBaseFee = (config.genesis as any)?.BASE_FEE_PER_GAS || ''

    if (this.nonInteractive) {
      // Non-interactive mode: use flag value or keep existing
      const newBaseFeePerGas = resolveEnvValue(flags['base-fee-per-gas']) || currentBaseFee

      if (!newBaseFeePerGas) {
        this.jsonCtx.addWarning('BASE_FEE_PER_GAS not provided and not in config. Skipping.')
        return
      }

      if (!config.genesis) {
        config.genesis = {}
      }

      ;(config.genesis as any).BASE_FEE_PER_GAS = newBaseFeePerGas

      if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
        this.jsonCtx.logSuccess(`BASE_FEE_PER_GAS updated in config.toml to "${newBaseFeePerGas}"`)
      }
    } else {
      const newBaseFeePerGas = await input({
        default: currentBaseFee,
        message: "Enter baseFeePerGas"
      })

      if (!config.genesis) {
        config.genesis = {}
      }

      ;(config.genesis as any).BASE_FEE_PER_GAS = newBaseFeePerGas

      if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
        this.jsonCtx.log(chalk.green(`BASE_FEE_PER_GAS updated in config.toml to "${newBaseFeePerGas}"`))
      }
    }
  }

  private async updateDeploymentSalt(flags: any): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.addWarning('config.toml not found. Skipping deployment salt update.')
      return
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = toml.parse(configContent)

    const currentSalt = (config.contracts as any)?.DEPLOYMENT_SALT || ''
    let defaultNewSalt = currentSalt

    if (/\d+$/.test(currentSalt)) {
      // If the current salt ends with a number, increment it
      const number = Number.parseInt(currentSalt.match(/\d+$/)[0], 10)
      defaultNewSalt = currentSalt.replace(/\d+$/, (number + 1).toString())
    } else {
      // Generate a new random 6 char string and append it to the base
      const baseSalt = currentSalt.split('-')[0] || 'devnetSalt'
      const randomString = Math.random().toString(36).slice(2, 8)
      defaultNewSalt = `${baseSalt}-${randomString}`
    }

    this.jsonCtx.info(`Current deployment salt: ${currentSalt}`)

    if (this.nonInteractive) {
      // Non-interactive mode: use flag value or skip if --skip-deployment-salt-update
      if (flags['skip-deployment-salt-update']) {
        this.jsonCtx.info('Skipping deployment salt update (--skip-deployment-salt-update)')
        return
      }

      const newSalt = resolveEnvValue(flags['deployment-salt']) || defaultNewSalt

      if (!config.contracts) {
        config.contracts = {}
      }

      ;(config.contracts as any).DEPLOYMENT_SALT = newSalt

      if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
        this.jsonCtx.logSuccess(`Deployment salt updated in config.toml from "${currentSalt}" to "${newSalt}"`)
      }
    } else {
      const updateSalt = await confirm({
        message: 'Would you like to update the deployment salt in config.toml?',
      })

      if (updateSalt) {
        const newSalt = await input({
          default: defaultNewSalt,
          message: 'Enter new deployment salt:',
        })

        if (!config.contracts) {
          config.contracts = {}
        }

        ;(config.contracts as any).DEPLOYMENT_SALT = newSalt

        if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
          this.jsonCtx.log(chalk.green(`Deployment salt updated in config.toml from "${currentSalt}" to "${newSalt}"`))
        }
      } else {
        this.jsonCtx.log(chalk.yellow('Deployment salt not updated'))
      }
    }
  }

  private async updateL1ContractDeploymentBlock(): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.log(chalk.yellow('config.toml not found. Skipping L1_CONTRACT_DEPLOYMENT_BLOCK update.'))
      return
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = toml.parse(configContent)

    const currentBlock = (config.general as any)?.L1_CONTRACT_DEPLOYMENT_BLOCK || ''
    let defaultNewBlock = currentBlock

    const updateBlock = await confirm({
      message: 'Would you like to update the L1_CONTRACT_DEPLOYMENT_BLOCK in config.toml?',
    })

    if (updateBlock) {
      try {
        const l1RpcUri = (config.frontend as any)?.EXTERNAL_RPC_URI_L1
        const isDevnet = (config.general as any)?.L1_RPC_ENDPOINT === 'http://l1-devnet:8545'

        if (isDevnet) {
          defaultNewBlock = '0'
        } else if (l1RpcUri) {
          const provider = new ethers.JsonRpcProvider(l1RpcUri)
          const latestBlock = await provider.getBlockNumber()
          defaultNewBlock = latestBlock.toString()
          this.jsonCtx.log(chalk.green(`Retrieved current L1 block height: ${defaultNewBlock}`))
        } else {
          this.jsonCtx.log(chalk.yellow('EXTERNAL_RPC_URI_L1 not found in config.toml. Using current value as default.'))
        }
      } catch (error) {
        this.jsonCtx.log(chalk.yellow(`Failed to retrieve current L1 block height: ${error}`))
      }

      if (!defaultNewBlock || Number.isNaN(Number(defaultNewBlock))) {
        defaultNewBlock = '0'
      }

      const newBlock = await input({
        default: defaultNewBlock,
        message: 'Enter new L1_CONTRACT_DEPLOYMENT_BLOCK:',
      })

      if (!config.general) {
        config.general = {}
      }

      ; (config.general as any).L1_CONTRACT_DEPLOYMENT_BLOCK = newBlock

      // fs.writeFileSync(configPath, toml.stringify(config as any))
      if (writeConfigs(config)) {
        this.jsonCtx.logSuccess(`L1_CONTRACT_DEPLOYMENT_BLOCK updated in config.toml from "${currentBlock}" to "${newBlock}"`)
      }

    } else {
      this.jsonCtx.log(chalk.yellow('L1_CONTRACT_DEPLOYMENT_BLOCK not updated'))
    }
  }

  private async updateL1FeeVaultAddr(flags: any): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.addWarning('config.toml not found. Skipping L1_FEE_VAULT_ADDR update.')
      return
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = toml.parse(configContent)

    const defaultAddr = (config.accounts as any)?.OWNER_ADDR || ''

    if (this.nonInteractive) {
      // Non-interactive mode: use flag value, existing config value, or OWNER_ADDR
      if (flags['skip-l1-fee-vault-update']) {
        this.jsonCtx.info('Skipping L1_FEE_VAULT_ADDR update (--skip-l1-fee-vault-update)')
        return
      }

      const newAddr = resolveEnvValue(flags['l1-fee-vault-addr']) ||
                      (config.contracts as any)?.L1_FEE_VAULT_ADDR ||
                      defaultAddr

      if (!ethers.isAddress(newAddr)) {
        this.jsonCtx.error(
          'E600_INVALID_ADDRESS',
          `Invalid L1_FEE_VAULT_ADDR: ${newAddr}`,
          'VALIDATION',
          true,
          { address: newAddr }
        )
      }

      if (!config.contracts) {
        config.contracts = {}
      }

      ;(config.contracts as any).L1_FEE_VAULT_ADDR = newAddr

      if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
        this.jsonCtx.logSuccess(`L1_FEE_VAULT_ADDR updated in config.toml to "${newAddr}"`)
      }
    } else {
      const updateFeeVault = await confirm({
        message: 'Would you like to set a value for L1_FEE_VAULT_ADDR?',
      })

      if (updateFeeVault) {
        this.jsonCtx.log(chalk.yellow('It is recommended to use a Safe for the L1_FEE_VAULT_ADDR.'))
        this.jsonCtx.log(chalk.cyan(`The Owner address (${defaultAddr}) is the default value.`))

        let isValidAddress = false
        let newAddr = ''

        while (!isValidAddress) {
          newAddr = await input({
            default: defaultAddr,
            message: 'Enter the L1_FEE_VAULT_ADDR:',
          })

          if (ethers.isAddress(newAddr)) {
            isValidAddress = true
          } else {
            this.jsonCtx.log(chalk.red('Invalid Ethereum address. Please try again.'))
          }
        }

        if (!config.contracts) {
          config.contracts = {}
        }

        ;(config.contracts as any).L1_FEE_VAULT_ADDR = newAddr

        if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
          this.jsonCtx.log(chalk.green(`L1_FEE_VAULT_ADDR updated in config.toml to "${newAddr}"`))
        }
      } else {
        this.jsonCtx.log(chalk.yellow('L1_FEE_VAULT_ADDR not updated'))
      }
    }
  }

  private async updateL1PlonkVerifierAddr(flags: any): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.addWarning('config.toml not found. Skipping L1_PLONK_VERIFIER_ADDR update.')
      return
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = toml.parse(configContent)

    const currentAddr = (config.contracts as any)?.L1_PLONK_VERIFIER_ADDR || ''

    if (this.nonInteractive) {
      // Non-interactive mode: skip by default (--skip-l1-plonk-verifier-update is true by default)
      // Only update if explicitly provided via flag
      if (flags['skip-l1-plonk-verifier-update'] && !flags['l1-plonk-verifier-addr']) {
        this.jsonCtx.info('Skipping L1_PLONK_VERIFIER_ADDR update (will be auto-deployed)')
        return
      }

      const newAddr = resolveEnvValue(flags['l1-plonk-verifier-addr'])
      if (newAddr) {
        if (!ethers.isAddress(newAddr)) {
          this.jsonCtx.error(
            'E600_INVALID_ADDRESS',
            `Invalid L1_PLONK_VERIFIER_ADDR: ${newAddr}`,
            'VALIDATION',
            true,
            { address: newAddr }
          )
        }

        if (!config.contracts) {
          config.contracts = {}
        }

        ;(config.contracts as any).L1_PLONK_VERIFIER_ADDR = newAddr

        if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
          this.jsonCtx.logSuccess(`L1_PLONK_VERIFIER_ADDR updated in config.toml to "${newAddr}"`)
        }
      } else {
        this.jsonCtx.info('L1_PLONK_VERIFIER_ADDR not provided, will be auto-deployed')
      }
    } else {
      this.jsonCtx.log(chalk.yellow('Note: If you do not set L1_PLONK_VERIFIER_ADDR, one will be automatically deployed.'))

      const updatePlonkVerifier = await confirm({
        default: false,
        message: 'Would you like to set a value for L1_PLONK_VERIFIER_ADDR?',
      })

      if (updatePlonkVerifier) {
        this.jsonCtx.log(chalk.cyan(`The current L1_PLONK_VERIFIER_ADDR is: ${currentAddr}`))

        let isValidAddress = false
        let newAddr = ''

        while (!isValidAddress) {
          newAddr = await input({
            default: currentAddr,
            message: 'Enter the L1_PLONK_VERIFIER_ADDR:',
          })

          if (ethers.isAddress(newAddr)) {
            isValidAddress = true
          } else {
            this.jsonCtx.log(chalk.red('Invalid Ethereum address. Please try again.'))
          }
        }

        if (!config.contracts) {
          config.contracts = {}
        }

        ;(config.contracts as any).L1_PLONK_VERIFIER_ADDR = newAddr

        if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
          this.jsonCtx.log(chalk.green(`L1_PLONK_VERIFIER_ADDR updated in config.toml to "${newAddr}"`))
        }
      } else {
        this.jsonCtx.log(chalk.yellow('L1_PLONK_VERIFIER_ADDR not updated'))
      }
    }
  }

  private async updateL2BridgeFeeRecipientAddr(flags: any): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.addWarning('config.toml not found. Skipping L2_BRIDGE_FEE_RECIPIENT_ADDR update.')
      return
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = toml.parse(configContent)

    const defaultAddr = (config.contracts as any)?.L2_BRIDGE_FEE_RECIPIENT_ADDR || "0x0000000000000000000000000000000000000000"

    if (this.nonInteractive) {
      // Non-interactive mode: use flag value or existing config value or zero address
      const newAddr = resolveEnvValue(flags['l2-bridge-fee-recipient-addr']) || defaultAddr

      if (!ethers.isAddress(newAddr)) {
        this.jsonCtx.error(
          'E600_INVALID_ADDRESS',
          `Invalid L2_BRIDGE_FEE_RECIPIENT_ADDR: ${newAddr}`,
          'VALIDATION',
          true,
          { address: newAddr }
        )
      }

      if (!config.contracts) {
        config.contracts = {}
      }

      ;(config.contracts as any).L2_BRIDGE_FEE_RECIPIENT_ADDR = newAddr

      if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
        this.jsonCtx.logSuccess(`L2_BRIDGE_FEE_RECIPIENT_ADDR updated in config.toml to "${newAddr}"`)
      }
    } else {
      let isValidAddress = false
      let newAddr = ''

      while (!isValidAddress) {
        newAddr = await input({
          default: defaultAddr,
          message: 'Please enter the L2_BRIDGE_FEE_RECIPIENT_ADDR:',
        })

        if (ethers.isAddress(newAddr)) {
          isValidAddress = true
        } else {
          this.jsonCtx.log(chalk.red('Invalid Ethereum address. Please try again.'))
        }
      }

      if (!config.contracts) {
        config.contracts = {}
      }

      ;(config.contracts as any).L2_BRIDGE_FEE_RECIPIENT_ADDR = newAddr

      if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
        this.jsonCtx.log(chalk.green(`L2_BRIDGE_FEE_RECIPIENT_ADDR updated in config.toml to "${newAddr}"`))
      }
    }
  }
}
