import type { JsonMap } from '@iarna/toml'

import * as toml from '@iarna/toml'
import { confirm, input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { DogeConfig } from '../../types/doge-config.js'

import { SETUP_DEFAULTS_TEMPLATE, getSetupDefaultsPath } from '../../config/constants.js'
import { Network } from '../../types/doge-config.js'
import { writeConfigs } from '../../utils/config-writer.js'
import {
  dogeConfigToToml,
  normalizeDogeNetwork,
} from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import { resolveBlockbookKubernetesEndpoints } from '../../utils/kubernetes-endpoints.js'
import {
  createNonInteractiveContext,
  resolveConfirm,
  resolveEnvValue,
  resolveOrPrompt,
  resolveOrSelect,
  validateAndExit,
} from '../../utils/non-interactive.js'

type EthereumDaChain = 'devnet' | 'mainnet' | 'sepolia'

const ETHEREUM_DA_DEFAULTS: Record<EthereumDaChain, {
  beaconRpcUrl: string
  chainId: string
  minFinality: 'finalized' | 'safe'
  submitterRpcUrl: string
}> = {
  devnet: {
    beaconRpcUrl: 'http://l1-devnet-lighthouse:5052',
    chainId: '32382',
    minFinality: 'safe',
    submitterRpcUrl: 'http://l1-devnet:8545',
  },
  mainnet: {
    beaconRpcUrl: 'https://ethereum-beacon-api.publicnode.com',
    chainId: '1',
    minFinality: 'finalized',
    submitterRpcUrl: 'https://eth.drpc.org',
  },
  sepolia: {
    beaconRpcUrl: 'https://ethereum-sepolia-beacon-api.publicnode.com',
    chainId: '11155111',
    minFinality: 'safe',
    submitterRpcUrl: 'https://sepolia.drpc.org',
  },
}

function normalizeClusterLocalHttpUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.toLowerCase().startsWith('https://')) return trimmed

  try {
    const parsedUrl = new URL(trimmed)
    const hostname = parsedUrl.hostname.toLowerCase()
    const serviceHosts = ['l1-devnet', 'l1-devnet-geth', 'l1-devnet-lighthouse']
    if (serviceHosts.some(serviceHost => hostname === serviceHost || hostname.startsWith(`${serviceHost}.`))) {
      return trimmed.replace(/^https:\/\//i, 'http://')
    }
  } catch {
    return trimmed
  }

  return trimmed
}

export class DogeConfigCommand extends Command {
  static description = 'Configure Dogecoin settings and bridge setup defaults for deployment'

  static examples = [
    '$ scrollsdk setup doge-config',
    '$ scrollsdk setup doge-config --config .data/doge-config.toml',
    '$ scrollsdk setup doge-config --non-interactive',
    '$ scrollsdk setup doge-config --non-interactive --json',
  ]

  static flags = {
    config: Flags.string({
      char: 'c',
      description: 'Path to config file',
    }),
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts, using existing config values',
    }),
  }

  private configPath: string = ''
  private dogeConfig: DogeConfig = {} as DogeConfig

  async generateSetupDefaultsToml(newDogeConfig: DogeConfig): Promise<void> {
    // Create setup_defaults.toml in user's current working directory
    const setupDefaultsPath = getSetupDefaultsPath();

    if (!fs.existsSync(setupDefaultsPath)) {
      // Ensure the target directory exists
      const targetDir = path.dirname(setupDefaultsPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      this.log(chalk.blue(`Creating setup defaults from embedded template at ${setupDefaultsPath}`));
      fs.writeFileSync(setupDefaultsPath, SETUP_DEFAULTS_TEMPLATE);
    }

    // read existing config file from user's working directory
    const existingConfigStr = fs.readFileSync(setupDefaultsPath, 'utf8');
    const newConfig = toml.parse(existingConfigStr);

    newConfig.network = newDogeConfig.network;

    newConfig.dogecoin_rpc_url = newDogeConfig.rpc?.url || '';
    newConfig.dogecoin_rpc_user = newDogeConfig.rpc?.username || '';
    newConfig.dogecoin_rpc_pass = newDogeConfig.rpc?.password || '';
    newConfig.dogecoin_blockbook_url = newDogeConfig.rpc?.blockbookAPIUrl ||
      (newConfig.network === 'mainnet' ? 'https://dogebook.nownodes.io' :
        newConfig.network === 'testnet' ? 'https://dogebook-testnet.nownodes.io' : 'http://blockbook:19139');
    newConfig.dogecoin_blockbook_api_key = newDogeConfig.rpc?.apiKey || '';

    // Write to setup_defaults.toml
    fs.writeFileSync(setupDefaultsPath, toml.stringify(newConfig));
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(DogeConfigCommand)

    // Create non-interactive and JSON output contexts
    const niCtx = createNonInteractiveContext(
      'setup doge-config',
      flags['non-interactive'],
      flags.json
    )
    const jsonCtx = new JsonOutputContext('setup doge-config', flags.json)

    // Helper for logging
    const log = (msg: string) => jsonCtx.log(msg)

    if (!fs.existsSync('.data')) {
      fs.mkdirSync('.data', { recursive: true })
    }

    const resolvedPath = flags.config ? path.resolve(flags.config as string) : path.resolve('.data/doge-config.toml')
    const mainConfigPath = path.join(process.cwd(), 'config.toml')
    const legacyMainConfig = this.getLegacyMainConfig()
    const legacyNetwork = this.getLegacyNetwork(legacyMainConfig)
    const legacyEthereumDa = (legacyMainConfig as Record<string, unknown>).ethereumDa as DogeConfig['ethereumDa'] | undefined
    let network: Network = legacyNetwork || 'testnet'

    const configExists = fs.existsSync(resolvedPath)
    let existingConfig: DogeConfig = {} as DogeConfig;

    if (configExists) {
      existingConfig = toml.parse(fs.readFileSync(resolvedPath, 'utf8')) as unknown as DogeConfig
      const existingNetwork = normalizeDogeNetwork(existingConfig.network)
      if (existingConfig.network && !existingNetwork) {
        this.error(`Invalid network in ${resolvedPath}: ${String(existingConfig.network)}. Must be 'mainnet', 'testnet', or 'regtest'.`)
      }

      if ((existingConfig.localSigners as Record<string, unknown> | undefined)?.network) {
        delete (existingConfig.localSigners as Record<string, unknown>).network
      }

      network = existingNetwork || legacyNetwork || network
    }

    const selectedNetwork = await resolveOrSelect<Network>(
      niCtx,
      () => select({
        choices: [
          { name: 'Dogecoin Testnet', value: 'testnet' },
          { name: 'Dogecoin Mainnet', value: 'mainnet' },
          { name: 'Dogecoin Regtest', value: 'regtest' },
        ],
        default: network,
        message: 'Select the Dogecoin network:',
      }),
      existingConfig.network || legacyNetwork || network,
      ['mainnet', 'testnet', 'regtest'],
      {
        configPath: 'network',
        description: 'Dogecoin network',
        field: 'network',
      },
    ) || network
    network = selectedNetwork

    const defaultConfig: DogeConfig = {
      defaults: {
        dogecoinIndexerStartHeight: '4000000',
        l1GenesisBlock: '4000001',
      },
      dogecoinClusterRpc: {
        password: "",
        username: "",
      },
      ethereumDa: legacyEthereumDa || {
        chain: this.getDefaultEthereumDaChain(network),
        ...ETHEREUM_DA_DEFAULTS[this.getDefaultEthereumDaChain(network)],
      },
      frontend: {},
      network: network as Network,
      rpc: {
        apiKey: '',
        blockbookAPIUrl: resolveBlockbookKubernetesEndpoints({
          kubernetes: existingConfig.kubernetes,
          network: network as Network,
        }).apiUrl,
        password: '',
        url: network === 'mainnet' ? 'https://dogecoin.mainnet.dogeos.com' :
          network === 'testnet' ? 'https://dogecoin.testnet.dogeos.com' : 'http://localhost:18332',
        username: '',
      },
      test: {},
      wallet: {
        path: `.data/doge-wallet-${network}.json`,
      }
    }
    if (!configExists) {
      // In non-interactive mode, always create default config
      const shouldCreate = await resolveConfirm(
        niCtx,
        () => confirm({
          default: true,
          message: `Config file not found at ${resolvedPath}. Would you like to create a default one now?`,
        }),
        true, // In non-interactive, always create
        true
      )

      if (!shouldCreate) {
        throw new Error(`Config file not found at ${resolvedPath}, and not created.`)
      }

      log('Creating a new default Dogecoin configuration file...')

      existingConfig = defaultConfig;
      fs.writeFileSync(resolvedPath, dogeConfigToToml(existingConfig))

      log(
        `Created new default ${network} config file at ${resolvedPath}. You can further customize it with 'scrollsdk setup doge-config'.`,
      )
    }

    const newConfig = existingConfig;
    newConfig.network = network
    if (!newConfig.rpc) {
      newConfig.rpc = {}
    }

    if (!newConfig.defaults) {
      newConfig.defaults = {}
    }

    if (!newConfig.dogecoinClusterRpc) {
      newConfig.dogecoinClusterRpc = {}
    }

    if (!newConfig.wallet) {
      newConfig.wallet = { path: `.data/doge-wallet-${network}.json` }
    }

    // Handle blockbook API URL with confirmation if different from default
    const defaultBlockbookUrl = network === 'mainnet' ? 'https://blockbook.mainnet.dogeos.com/' :
      network === 'testnet' ? 'https://blockbook.testnet.dogeos.com/' : 'http://blockbook:19139'
    const currentBlockbookUrl = existingConfig.rpc?.blockbookAPIUrl || defaultBlockbookUrl

    newConfig.rpc!.blockbookAPIUrl = await resolveOrPrompt(
      niCtx,
      () => input({
        default: currentBlockbookUrl,
        message: `Enter Internal Blockbook API URL:`,
      }),
      existingConfig.rpc?.blockbookAPIUrl || currentBlockbookUrl,
      {
        configPath: '[rpc].blockbookAPIUrl',
        description: 'Internal Blockbook API URL',
        field: 'blockbookAPIUrl',
      },
      false
    ) || currentBlockbookUrl

    newConfig.rpc!.apiKey = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.rpc?.apiKey,
        message: 'Enter your blockbook API key:',
      }),
      resolveEnvValue(existingConfig.rpc?.apiKey),
      {
        configPath: '[rpc].apiKey',
        description: 'Blockbook API key',
        field: 'apiKey',
      },
      false
    ) || ''

    // In non-interactive mode, auto-generate cluster RPC credentials if not set
    const generateClusterRpc: boolean = niCtx.enabled ? (!existingConfig.dogecoinClusterRpc?.username || !existingConfig.dogecoinClusterRpc?.password) : await confirm({
        default: false,
        message: `Do you want to automatically generate secure credentials for your Dogecoin RPC service that will be deployed?\n  (These will be used to authenticate access to your Dogecoin nodes)\n  Choose 'Yes' to auto-generate, 'No' to set manually`,
      })

    if (generateClusterRpc) {
      newConfig.dogecoinClusterRpc!.username = this.generateSecureRandomString(8);
      newConfig.dogecoinClusterRpc!.password = this.generateSecureRandomString(16);
      log(chalk.green(`✓ Generated secure random credentials for Dogecoin cluster RPC`));
    } else {
      newConfig.dogecoinClusterRpc!.username = await resolveOrPrompt(
        niCtx,
        () => input({
          default: existingConfig.dogecoinClusterRpc?.username,
          message: `Enter the username for your Dogecoin RPC service (will be used for authentication):`,
        }),
        existingConfig.dogecoinClusterRpc?.username,
        {
          configPath: '[dogecoinClusterRpc].username',
          description: 'Dogecoin RPC service username',
          field: 'username',
        },
        false
      ) || ''

      newConfig.dogecoinClusterRpc!.password = await resolveOrPrompt(
        niCtx,
        () => input({
          default: existingConfig.dogecoinClusterRpc?.password,
          message: `Enter the password for your Dogecoin RPC service (will be used for authentication):`,
        }),
        resolveEnvValue(existingConfig.dogecoinClusterRpc?.password),
        {
          configPath: '[dogecoinClusterRpc].password',
          description: 'Dogecoin RPC service password (use $ENV:VAR_NAME for secrets)',
          field: 'password',
        },
        false
      ) || ''
    }

    newConfig.wallet!.path = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.wallet?.path,
        message: `Enter the wallet file path:`,
      }),
      existingConfig.wallet?.path,
      {
        configPath: '[wallet].path',
        description: 'Wallet file path',
        field: 'path',
      },
      false
    ) || existingConfig.wallet?.path || ''

    newConfig.rpc!.url = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.rpc?.url || defaultConfig.rpc?.url || '',
        message: `Enter an external dogecoin RPC URL for wallet operations (send/sync):
      `,
      }),
      existingConfig.rpc?.url || defaultConfig.rpc?.url,
      {
        configPath: '[rpc].url',
        description: 'External Dogecoin RPC URL for wallet operations',
        field: 'url',
      },
      false
    ) || existingConfig.rpc?.url || ''

    newConfig.rpc!.username = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.rpc?.username,
        message: `Enter RPC username (leave empty for public RPC endpoints):`,
      }),
      existingConfig.rpc?.username,
      {
        configPath: '[rpc].username',
        description: 'RPC username (optional for public endpoints)',
        field: 'username',
      },
      false
    ) || ''

    newConfig.rpc!.password = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.rpc?.password,
        message: `Enter RPC password (leave empty for public RPC endpoints):`,
      }),
      resolveEnvValue(existingConfig.rpc?.password),
      {
        configPath: '[rpc].password',
        description: 'RPC password (optional, use $ENV:VAR_NAME for secrets)',
        field: 'password',
      },
      false
    ) || ''

    log("testing external dogecoin rpc...")

    // Test RPC connection and get latest block height
    let dogecoinCurrentHeight = 5_000_000;
    try {
      dogecoinCurrentHeight = await this.testRpcConnection(newConfig.rpc!.url!, newConfig.rpc!.username, newConfig.rpc!.password)
      log(chalk.green(`✓ RPC connection test successful! Current block height: ${dogecoinCurrentHeight}`))
    } catch (error) {
      log(chalk.red(`✗ RPC connection test failed: ${error instanceof Error ? error.message : String(error)}`))

      // In non-interactive mode, continue anyway with a warning
      const continueAnyway = await resolveConfirm(
        niCtx,
        () => confirm({
          default: false,
          message: 'RPC connection failed, continue with configuration anyway?'
        }),
        true, // In non-interactive mode, continue with warning
        false
      )

      if (!continueAnyway) {
        this.error('RPC connection failed, configuration cancelled')
        return
      }

      if (niCtx.enabled) {
        jsonCtx.addWarning('Dogecoin RPC connection test failed - configuration continued with warning')
      }
    }

    const existingEthereumDa = newConfig.ethereumDa || legacyEthereumDa || {}
    const existingEthereumDaChain = existingEthereumDa.chain as EthereumDaChain | undefined
    const defaultEthereumDaChain = existingEthereumDaChain || this.getDefaultEthereumDaChain(network)
    const ethereumDaChain = await resolveOrSelect<EthereumDaChain>(
      niCtx,
      () => select({
        choices: [
          { name: 'Sepolia testnet', value: 'sepolia' },
          { name: 'Ethereum mainnet', value: 'mainnet' },
          { name: 'Devnet / private Ethereum chain', value: 'devnet' },
        ],
        default: defaultEthereumDaChain,
        message: 'Select the Ethereum chain used as the DA layer ([ethereumDa].chain):',
      }),
      existingEthereumDa.chain || defaultEthereumDaChain,
      ['mainnet', 'sepolia', 'devnet'],
      {
        configPath: '[ethereumDa].chain',
        description: 'Ethereum DA chain',
        field: 'chain',
      },
    ) || defaultEthereumDaChain
    const ethereumDaDefaults = ETHEREUM_DA_DEFAULTS[ethereumDaChain]
    const shouldReuseExistingEthereumDaValues = niCtx.enabled || existingEthereumDaChain === ethereumDaChain
    const ethereumDaFieldDefault = (field: 'beaconRpcUrl' | 'chainId' | 'submitterRpcUrl') =>
      shouldReuseExistingEthereumDaValues
        ? existingEthereumDa?.[field] || ethereumDaDefaults[field]
        : ethereumDaDefaults[field]

    const ethereumDaSubmitterRpcUrl = normalizeClusterLocalHttpUrl(await resolveOrPrompt(
      niCtx,
      () => input({
        default: ethereumDaFieldDefault('submitterRpcUrl'),
        message: 'Enter the real Ethereum execution JSON-RPC endpoint used by eth-da-submitter ([ethereumDa].submitterRpcUrl):',
      }),
      ethereumDaFieldDefault('submitterRpcUrl'),
      {
        configPath: '[ethereumDa].submitterRpcUrl',
        description: 'Real Ethereum execution JSON-RPC endpoint used by eth-da-submitter',
        field: 'submitterRpcUrl',
      },
    ) || ethereumDaDefaults.submitterRpcUrl)

    const ethereumDaBeaconRpcUrl = normalizeClusterLocalHttpUrl(await resolveOrPrompt(
      niCtx,
      () => input({
        default: ethereumDaFieldDefault('beaconRpcUrl'),
        message: 'Enter the real Ethereum beacon API endpoint used as the DA data source ([ethereumDa].beaconRpcUrl):',
      }),
      ethereumDaFieldDefault('beaconRpcUrl'),
      {
        configPath: '[ethereumDa].beaconRpcUrl',
        description: 'Real Ethereum beacon API endpoint used as the DA data source',
        field: 'beaconRpcUrl',
      },
    ) || ethereumDaDefaults.beaconRpcUrl)

    const ethereumDaChainId = await resolveOrPrompt(
      niCtx,
      () => input({
        default: ethereumDaFieldDefault('chainId'),
        message: 'Enter the real Ethereum DA execution chain ID ([ethereumDa].chainId):',
      }),
      ethereumDaFieldDefault('chainId'),
      {
        configPath: '[ethereumDa].chainId',
        description: 'Real Ethereum DA execution chain ID',
        field: 'chainId',
      },
    ) || ethereumDaDefaults.chainId

    newConfig.ethereumDa = {
      beaconRpcUrl: ethereumDaBeaconRpcUrl,
      chain: ethereumDaChain,
      chainId: ethereumDaChainId,
      minFinality: ethereumDaDefaults.minFinality,
      submitterRpcUrl: ethereumDaSubmitterRpcUrl,
    }

    newConfig.defaults!.dogecoinIndexerStartHeight = existingConfig.defaults?.dogecoinIndexerStartHeight || String(dogecoinCurrentHeight)
    const indexerStartHeight = Number(newConfig.defaults!.dogecoinIndexerStartHeight)
    newConfig.defaults!.l1GenesisBlock = existingConfig.defaults?.l1GenesisBlock ||
      String(Number.isFinite(indexerStartHeight) ? Math.max(0, indexerStartHeight + 1) : 0)
    log(chalk.blue(`Dogecoin Indexer Start Height: ${newConfig.defaults!.dogecoinIndexerStartHeight}`))
    log(chalk.blue(`L1 Genesis Block: ${newConfig.defaults!.l1GenesisBlock}`))

    // Validate any missing required fields before proceeding
    validateAndExit(niCtx)

    const mainConfig = toml.parse(fs.readFileSync(mainConfigPath, 'utf8')) as JsonMap
    if (!mainConfig.general) mainConfig.general = {}
    const generalConfig = mainConfig.general as JsonMap
    generalConfig.L1_CONTRACT_DEPLOYMENT_BLOCK = newConfig.defaults!.dogecoinIndexerStartHeight
    if (writeConfigs(mainConfig, undefined, undefined, flags.json)) {
      log(
        chalk.green(`L1_CONTRACT_DEPLOYMENT_BLOCK updated in config.toml`),
      )
    }

    const configDir = path.dirname(resolvedPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }

    fs.writeFileSync(resolvedPath, dogeConfigToToml(newConfig))
    this.removeLegacyDogeConfigFromMainConfig(mainConfigPath, flags.json, log)

    log(chalk.green(`\nConfiguration for ${newConfig.network} network saved to ${resolvedPath}`))
    log(chalk.blue('\nConfiguration Summary:'))
    log(chalk.blue(`Network: ${newConfig.network}`))
    log(chalk.blue(`RPC URL: ${newConfig.rpc!.url}`))
    log(chalk.blue(`Blockbook API URL: ${newConfig.rpc!.blockbookAPIUrl}`))
    log(chalk.blue(`Wallet Path: ${newConfig.wallet.path}`))

    await this.generateSetupDefaultsToml(newConfig)

    // Output JSON response on success
    if (flags.json) {
      jsonCtx.success({
        configPath: resolvedPath,
        defaults: {
          dogecoinIndexerStartHeight: newConfig.defaults!.dogecoinIndexerStartHeight,
          l1GenesisBlock: newConfig.defaults!.l1GenesisBlock,
        },
        ethereumDa: newConfig.ethereumDa,
        network: newConfig.network,
        rpc: {
          blockbookAPIUrl: newConfig.rpc!.blockbookAPIUrl,
          url: newConfig.rpc!.url,
        },
        wallet: {
          path: newConfig.wallet.path,
        },
      })
    }
  }

  private generateSecureRandomString(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let result = ''
    const randomBytes = crypto.randomBytes(length)

    for (let i = 0; i < length; i++) {
      result += chars[randomBytes[i] % chars.length]
    }

    return result
  }

  private getDefaultEthereumDaChain(network: Network): EthereumDaChain {
    if (network === 'mainnet') return 'mainnet'
    if (network === 'regtest') return 'devnet'
    return 'sepolia'
  }

  private getLegacyMainConfig(): JsonMap {
    const mainConfigPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(mainConfigPath)) return {} as JsonMap

    return toml.parse(fs.readFileSync(mainConfigPath, 'utf8')) as JsonMap
  }

  private getLegacyNetwork(mainConfig: JsonMap): Network | undefined {
    const { dogecoin } = mainConfig as Record<string, unknown>
    if (!dogecoin || typeof dogecoin !== 'object' || Array.isArray(dogecoin)) return undefined
    return normalizeDogeNetwork((dogecoin as Record<string, unknown>).network)
  }

  private removeLegacyDogeConfigFromMainConfig(mainConfigPath: string, jsonMode: boolean, log: (msg: string) => void): void {
    if (!fs.existsSync(mainConfigPath)) return

    const mainConfig = toml.parse(fs.readFileSync(mainConfigPath, 'utf8')) as JsonMap
    let changed = false
    if ((mainConfig as Record<string, unknown>).dogecoin !== undefined) {
      delete (mainConfig as Record<string, unknown>).dogecoin
      changed = true
    }

    if ((mainConfig as Record<string, unknown>).ethereumDa !== undefined) {
      delete (mainConfig as Record<string, unknown>).ethereumDa
      changed = true
    }

    if (changed && writeConfigs(mainConfig, undefined, undefined, jsonMode)) {
      log(chalk.green('Moved [dogecoin] and [ethereumDa] settings out of config.toml'))
    }
  }

  // Helper methods for common operations


  private async testRpcConnection(rpcUrl: string, username?: string, password?: string): Promise<number> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    // Handle different RPC URL formats
    if (rpcUrl.includes('nownodes.io')) {
      // NowNodes API format - use getblock API
      const infoUrl = `${rpcUrl.replace(/\/$/, '')}/`

      const response = await fetch(infoUrl, {
        headers,
        method: 'GET'
      })

      if (!response.ok) {
        throw new Error(`blockbook API connection failed: ${response.status} ${response.statusText}`)
      }

      const result = await response.json() as { blockbook: { bestHeight: number } }
      if (result.blockbook && typeof result.blockbook.bestHeight === 'number') {
        return result.blockbook.bestHeight
      }
 
        throw new Error('Unable to get block height from blockbook API')
      
    } else {
      // Standard Dogecoin RPC format
      if (username && password) {
        const credentials = Buffer.from(`${username}:${password}`).toString('base64')
        headers.Authorization = `Basic ${credentials}`
      }

      const body = JSON.stringify({
        id: 'test',
        jsonrpc: '1.0',
        method: 'getblockcount',
        params: [],
      })

      const response = await fetch(rpcUrl, {
        body,
        headers,
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error(`RPC connection failed: ${response.status} ${response.statusText}`)
      }

      const result = await response.json() as { error?: { code: number; message: string }; result?: number }

      if (result.error) {
        throw new Error(`RPC error: ${result.error.message} (Code: ${result.error.code})`)
      }

      if (typeof result.result === 'number') {
        return result.result
      }

      throw new Error('RPC response did not contain valid block height')
    }
  }
}

export default DogeConfigCommand
