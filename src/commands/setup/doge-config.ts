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
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import { resolveBlockbookKubernetesEndpoints } from '../../utils/kubernetes-endpoints.js'
import {
  createNonInteractiveContext,
  resolveConfirm,
  resolveEnvValue,
  resolveOrPrompt,
  validateAndExit,
} from '../../utils/non-interactive.js'

export class DogeConfigCommand extends Command {
  static description = 'Configure Dogecoin settings and bridge setup defaults for deployment'

  static examples = [
    '$ scrollsdk setup doge-config',
    '$ scrollsdk setup doge-config --config .data/doge-config-mainnet.toml',
    '$ scrollsdk setup doge-config --config .data/doge-config-testnet.toml',
    '$ scrollsdk setup doge-config --non-interactive --network testnet',
    '$ scrollsdk setup doge-config --non-interactive --json --network mainnet',
  ]

  static flags = {
    config: Flags.string({
      char: 'c',
      description: 'Path to config file (e.g., .data/doge-config-mainnet.toml or .data/doge-config-testnet.toml)',
    }),
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    network: Flags.string({
      char: 'n',
      description: 'Network to configure (mainnet or testnet) - required for non-interactive mode with new config',
      options: ['mainnet', 'testnet'],
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
    newConfig.dogecoin_blockbook_url = newConfig.network === 'mainnet' ? 'https://dogebook.nownodes.io' : 'https://dogebook-testnet.nownodes.io';
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

    const files = fs.readdirSync('.data')
    const configFiles = files.filter(file => file.startsWith('doge') && file.endsWith('.toml'))
    const configFileChoices = configFiles.map(file => ({ name: file, value: file }))

    let resolvedPath = flags.config as string
    let network = flags.network || ""

    let fileSelected = ""
    if (!flags.config) {
      if (niCtx.enabled) {
        // Non-interactive mode: use network flag or first existing config file
        if (flags.network) {
          fileSelected = flags.network === 'mainnet' ? 'doge-config-mainnet.toml' : 'doge-config-testnet.toml'
          network = flags.network
        } else if (configFiles.length > 0) {
          // Use first existing config file
          fileSelected = configFiles[0]
          // Infer network from filename
          network = fileSelected.includes('mainnet') ? 'mainnet' : 'testnet'
        } else {
          // No config files and no network specified - error
          niCtx.missingFields.push({
            configPath: '--network flag',
            description: 'Network (mainnet or testnet) must be specified in non-interactive mode when creating new config',
            field: 'network',
          })
          validateAndExit(niCtx)
          return
        }
      } else {
        fileSelected = await select({
          choices: [...configFileChoices, {
            name: "New Config",
            value: "New Config"
          }],
          message: 'Select please:',
        })

        if (fileSelected === "New Config") {
          network = await select({
            choices: [
              { name: 'mainnet', value: 'mainnet' },
              { name: 'testnet', value: 'testnet' }
            ],
            default: 'testnet',
            message: 'select network:'
          });

          fileSelected = network === 'mainnet' ? 'doge-config-mainnet.toml' : 'doge-config-testnet.toml';
        }
      }

      resolvedPath = path.resolve('.data', fileSelected)
    }

    // let resolvedPath = path.resolve(".data", fileSelected)
    let existingConfig: DogeConfig = {} as DogeConfig;

    const defaultConfig: DogeConfig = {
      defaults: {
        dogecoinIndexerStartHeight: '4000000',
      },
      dogecoinClusterRpc: {
        password: "",
        username: "",
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
        url: network === 'mainnet' ? 'https://dogecoin.mainnet.dogeos.com' : 'https://dogecoin.testnet.dogeos.com',
        username: '',
      },
      test: {},
      wallet: {
        path: network === 'mainnet' ? '.data/doge-wallet-mainnet.json' : '.data/doge-wallet-testnet.json',
      }
    }
    if (fs.existsSync(resolvedPath)) {
      ({ config: existingConfig, configPath: resolvedPath } = await loadDogeConfigWithSelection(resolvedPath));
    } else {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fs.writeFileSync(resolvedPath, toml.stringify(existingConfig as any))

      log(
        `Created new default ${network} config file at ${resolvedPath}. You can further customize it with 'scrollsdk setup doge-config'.`,
      )
    }

    const newConfig = existingConfig;
    if (!newConfig.rpc) {
      newConfig.rpc = {}
    }

    // Handle blockbook API URL with confirmation if different from default
    const defaultBlockbookUrl = network === 'mainnet' ? 'https://blockbook.mainnet.dogeos.com/' : 'https://blockbook.testnet.dogeos.com/'
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

    delete (newConfig as Record<string, unknown>).ethereumDa

    newConfig.defaults!.dogecoinIndexerStartHeight = existingConfig.defaults?.dogecoinIndexerStartHeight || String(dogecoinCurrentHeight)
    log(chalk.blue(`Dogecoin Indexer Start Height: ${newConfig.defaults!.dogecoinIndexerStartHeight}`))

    const configPath = path.join(process.cwd(), 'config.toml')
    let config: JsonMap | undefined
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf8')
      config = toml.parse(configContent)
    }

    // Validate any missing required fields before proceeding
    validateAndExit(niCtx)

    if (config) {
      if (!config.general) config.general = {}
      const generalConfig = config.general as JsonMap
      generalConfig.L1_CONTRACT_DEPLOYMENT_BLOCK = newConfig.defaults!.dogecoinIndexerStartHeight
      if (writeConfigs(config)) {
        log(
          chalk.green(`L1_CONTRACT_DEPLOYMENT_BLOCK updated in config.toml`),
        )
      }
    } else {
      log(chalk.yellow('config.toml not found. Skipping L1_CONTRACT_DEPLOYMENT_BLOCK update.'))
    }

    const configDir = path.dirname(resolvedPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fs.writeFileSync(resolvedPath, toml.stringify(newConfig as any))

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
        },
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
