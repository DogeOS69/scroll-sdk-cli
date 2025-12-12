import * as toml from '@iarna/toml'
import { input, select, confirm } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import type { DogeConfig } from '../../types/doge-config.js'
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { getSetupDefaultsPath, SETUP_DEFAULTS_TEMPLATE } from '../../config/constants.js'
import crypto from 'node:crypto'
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
import { Network } from '../../types/doge-config.js'
import { writeConfigs } from '../../utils/config-writer.js'
import {
  createNonInteractiveContext,
  resolveOrPrompt,
  resolveOrSelect,
  resolveConfirm,
  resolveEnvValue,
  validateAndExit,
  type NonInteractiveContext,
} from '../../utils/non-interactive.js'
import { JsonOutputContext } from '../../utils/json-output.js'

export class DogeConfigCommand extends Command {
  static description = 'Configure Dogecoin settings for mainnet or testnet'

  static examples = [
    '$ scrollsdk doge:config',
    '$ scrollsdk doge:config --config .data/doge-config-mainnet.toml',
    '$ scrollsdk doge:config --config .data/doge-config-testnet.toml',
    '$ scrollsdk doge:config --non-interactive --network testnet',
    '$ scrollsdk doge:config --non-interactive --json --network mainnet',
  ]

  static flags = {
    config: Flags.string({
      char: 'c',
      description: 'Path to config file (e.g., .data/doge-config-mainnet.toml or .data/doge-config-testnet.toml)',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      description: 'Run without prompts, using existing config values',
      default: false,
    }),
    json: Flags.boolean({
      description: 'Output in JSON format (stdout for data, stderr for logs)',
      default: false,
    }),
    network: Flags.string({
      char: 'n',
      description: 'Network to configure (mainnet or testnet) - required for non-interactive mode with new config',
      options: ['mainnet', 'testnet'],
    }),
  }

  private dogeConfig: DogeConfig = {} as DogeConfig
  private configPath: string = ''

  // Helper methods for common operations
  private async promptForInput(message: string, defaultValue?: string, validator?: (value: string) => boolean | string, required: boolean = false): Promise<string> {
    return await input({
      message,
      default: defaultValue,
      validate: validator || (() => true),
      required
    })
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

  private async generateCelestiaAddressFromMnemonic(mnemonic: string): Promise<string> {
    try {
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
        prefix: 'celestia'
      })
      const accounts = await wallet.getAccounts()
      return accounts[0].address
    } catch (error) {
      throw new Error(`Failed to generate Celestia address from mnemonic: ${error}`)
    }
  }

  private generateCelestiaNamespace(projectName?: string, byteLength: number = 8): string {
    // Generate a namespace with custom bytes (2-10 bytes allowed)
    if (byteLength < 2 || byteLength > 10) {
      byteLength = 8 // Default to 8 bytes if invalid
    }

    let customBytes = ''
    if (projectName) {
      // Use project name as base for custom bytes
      const hash = crypto.createHash('sha256').update(projectName).digest('hex')
      customBytes = hash.substring(0, byteLength * 2) // Take specified bytes (hex chars = bytes * 2)
    } else {
      // Generate random bytes
      customBytes = crypto.randomBytes(byteLength).toString('hex').toLowerCase()
    }

    return customBytes
  }

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
      } else {
        throw new Error('Unable to get block height from blockbook API')
      }
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

      const result = await response.json() as { error?: { message: string; code: number }; result?: number }

      if (result.error) {
        throw new Error(`RPC error: ${result.error.message} (Code: ${result.error.code})`)
      }

      if (typeof result.result === 'number') {
        return result.result
      }

      throw new Error('RPC response did not contain valid block height')
    }
  }

  private async getCelestiaLatestHeight(tendermintRpcUrl: string): Promise<number> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    const response = await fetch(`${tendermintRpcUrl.replace(/\/$/, '')}/status`, {
      headers,
      method: 'GET'
    })

    if (!response.ok) {
      throw new Error(`Celestia RPC connection failed: ${response.status} ${response.statusText}`)
    }

    const result = await response.json() as {
      result?: {
        sync_info?: {
          latest_block_height?: string
        }
      }
    }

    if (result.result?.sync_info?.latest_block_height) {
      const height = parseInt(result.result.sync_info.latest_block_height, 10)
      if (!isNaN(height)) {
        return height
      }
    }

    throw new Error('Unable to get latest block height from Celestia RPC')
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(DogeConfigCommand)

    // Create non-interactive and JSON output contexts
    const niCtx = createNonInteractiveContext(
      'doge:config',
      flags['non-interactive'],
      flags.json
    )
    const jsonCtx = new JsonOutputContext('doge:config', flags.json)

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
            field: 'network',
            configPath: '--network flag',
            description: 'Network (mainnet or testnet) must be specified in non-interactive mode when creating new config',
          })
          validateAndExit(niCtx)
          return
        }
      } else {
        fileSelected = await select({
          choices: [...configFileChoices, {
            value: "New Config",
            name: "New Config"
          }],
          message: 'Select please:',
        })

        if (fileSelected === "New Config") {
          network = await select({
            choices: [
              { name: 'mainnet', value: 'mainnet' },
              { name: 'testnet', value: 'testnet' }
            ],
            message: 'select network:',
            default: 'testnet'
          });

          if (network === 'mainnet') {
            fileSelected = 'doge-config-mainnet.toml'
          } else {
            fileSelected = 'doge-config-testnet.toml'
          }
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
      frontend: {},
      network: network as Network,
      rpc: {
        username: '',
        password: '',
        apiKey: '',
        blockbookAPIUrl:
          network === 'mainnet' ? 'http://blockbook-mainnet:19139' : 'http://blockbook-testnet:19139',
        url: network === 'mainnet' ? 'https://dogecoin.mainnet.dogeos.com' : 'https://dogecoin.testnet.dogeos.com',
      },
      dogecoinClusterRpc: {
        username: "",
        password: "",
      },
      test: {},
      wallet: {
        path: network === 'mainnet' ? '.data/doge-wallet-mainnet.json' : '.data/doge-wallet-testnet.json',
      },
      da: {
        celestiaIndexerStartBlock: network === 'mainnet' ? '0' : '6175746',
        tendermintRpcUrl: '',
        daNamespace: network === 'mainnet' ? '' : '',
        signerAddress: '',
        celestiaMnemonic: '',
      }
    }
    if (!fs.existsSync(resolvedPath)) {
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
        `Created new default ${network} config file at ${resolvedPath}. You can further customize it with 'scrollsdk doge:config'.`,
      )
    } else {
      ({ config: existingConfig, configPath: resolvedPath } = await loadDogeConfigWithSelection(resolvedPath));
    }

    let newConfig = existingConfig;

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
        field: 'blockbookAPIUrl',
        configPath: '[rpc].blockbookAPIUrl',
        description: 'Internal Blockbook API URL',
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
        field: 'apiKey',
        configPath: '[rpc].apiKey',
        description: 'Blockbook API key',
      },
      false
    ) || ''

    // In non-interactive mode, auto-generate cluster RPC credentials if not set
    let generateClusterRpc: boolean
    if (niCtx.enabled) {
      // Auto-generate if credentials are not already set
      generateClusterRpc = !existingConfig.dogecoinClusterRpc?.username || !existingConfig.dogecoinClusterRpc?.password
    } else {
      generateClusterRpc = await confirm({
        message: `Do you want to automatically generate secure credentials for your Dogecoin RPC service that will be deployed?\n  (These will be used to authenticate access to your Dogecoin nodes)\n  Choose 'Yes' to auto-generate, 'No' to set manually`,
        default: false,
      })
    }

    if (!generateClusterRpc) {
      newConfig.dogecoinClusterRpc!.username = await resolveOrPrompt(
        niCtx,
        () => input({
          default: existingConfig.dogecoinClusterRpc?.username,
          message: `Enter the username for your Dogecoin RPC service (will be used for authentication):`,
        }),
        existingConfig.dogecoinClusterRpc?.username,
        {
          field: 'username',
          configPath: '[dogecoinClusterRpc].username',
          description: 'Dogecoin RPC service username',
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
          field: 'password',
          configPath: '[dogecoinClusterRpc].password',
          description: 'Dogecoin RPC service password (use $ENV:VAR_NAME for secrets)',
        },
        false
      ) || ''
    } else {
      newConfig.dogecoinClusterRpc!.username = this.generateSecureRandomString(8);
      newConfig.dogecoinClusterRpc!.password = this.generateSecureRandomString(16);
      log(chalk.green(`✓ Generated secure random credentials for Dogecoin cluster RPC`));
    }

    newConfig.wallet!.path = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.wallet?.path,
        message: `Enter the wallet file path:`,
      }),
      existingConfig.wallet?.path,
      {
        field: 'path',
        configPath: '[wallet].path',
        description: 'Wallet file path',
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
        field: 'url',
        configPath: '[rpc].url',
        description: 'External Dogecoin RPC URL for wallet operations',
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
        field: 'username',
        configPath: '[rpc].username',
        description: 'RPC username (optional for public endpoints)',
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
        field: 'password',
        configPath: '[rpc].password',
        description: 'RPC password (optional, use $ENV:VAR_NAME for secrets)',
      },
      false
    ) || ''

    log("testing external dogecoin rpc...")

    // Test RPC connection and get latest block height
    let dogecoinCurrentHeight = 5000000;
    try {
      dogecoinCurrentHeight = await this.testRpcConnection(newConfig.rpc!.url!, newConfig.rpc!.username, newConfig.rpc!.password)
      log(chalk.green(`✓ RPC connection test successful! Current block height: ${dogecoinCurrentHeight}`))
    } catch (error) {
      log(chalk.red(`✗ RPC connection test failed: ${error instanceof Error ? error.message : String(error)}`))

      // In non-interactive mode, continue anyway with a warning
      const continueAnyway = await resolveConfirm(
        niCtx,
        () => confirm({
          message: 'RPC connection failed, continue with configuration anyway?',
          default: false
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

    newConfig.da!.tendermintRpcUrl = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.da?.tendermintRpcUrl,
        message: `Enter the Celestia Tendermint RPC URL (if known):`,
        required: false
      }),
      existingConfig.da?.tendermintRpcUrl,
      {
        field: 'tendermintRpcUrl',
        configPath: '[da].tendermintRpcUrl',
        description: 'Celestia Tendermint RPC URL',
      },
      false
    ) || ''

    // Test Celestia RPC connection and get latest height
    let celestiaCurrentHeight = parseInt(existingConfig.da?.celestiaIndexerStartBlock || '6158500')
    if (newConfig.da!.tendermintRpcUrl) {
      try {
        celestiaCurrentHeight = await this.getCelestiaLatestHeight(newConfig.da!.tendermintRpcUrl)
        log(chalk.green(`✓ Celestia RPC connection test successful! Current block height: ${celestiaCurrentHeight}`))
      } catch (error) {
        log(chalk.red(`✗ Celestia RPC connection test failed: ${error instanceof Error ? error.message : String(error)}`))
        if (niCtx.enabled) {
          jsonCtx.addWarning('Celestia RPC connection test failed')
        }
      }
    }

    // Handle Celestia namespace - auto-generate and show to user
    let suggestedNamespace = existingConfig.da?.daNamespace

    if (!suggestedNamespace) {
      // No existing namespace, generate new one
      suggestedNamespace = this.generateCelestiaNamespace()

      log(chalk.blue('\n📋 Celestia DA Namespace:'))
      log(chalk.yellow('Format: Any valid hex string (2-10 bytes allowed)'))
      log(chalk.green(`Auto-generated: ${suggestedNamespace}`))
    } else {
      // Existing namespace found, ask if user wants to generate new one
      log(chalk.blue('\n📋 Celestia DA Namespace:'))
      log(chalk.yellow('Format: Any valid hex string (2-10 bytes allowed)'))
      log(chalk.cyan(`Current: ${suggestedNamespace}`))

      // In non-interactive mode, keep existing namespace
      const generateNew = await resolveConfirm(
        niCtx,
        () => confirm({
          message: 'Generate a new random namespace?',
          default: false
        }),
        false, // In non-interactive, keep existing
        false
      )

      if (generateNew) {
        //randomly generate a namespace
        suggestedNamespace = this.generateCelestiaNamespace()
        log(chalk.green(`New generated: ${suggestedNamespace}`))
      }
    }

    // Ensure we always have a valid namespace
    if (!suggestedNamespace) {
      suggestedNamespace = this.generateCelestiaNamespace()
      log(chalk.green(`Fallback generated: ${suggestedNamespace}`))
    }

    const inputNamespace = await resolveOrPrompt(
      niCtx,
      () => input({
        default: suggestedNamespace,
        message: `Celestia DA Namespace (2-10 bytes, press Enter to use default value):`,
        required: true,
        validate: (value) => {
          if (!value.trim()) {
            return 'Namespace is required'
          }

          // Remove any spaces and convert to lowercase for validation
          const cleanValue = value.replace(/\s+/g, '').toLowerCase()

          // Check if it's valid hex
          if (!/^[0-9a-f]*$/.test(cleanValue)) {
            return 'Namespace must be a valid hex string'
          }

          // Check if length is even (must be valid bytes)
          if (cleanValue.length % 2 !== 0) {
            return 'Namespace must have even number of hex characters'
          }

          // Check byte length (2-10 bytes = 4-20 hex characters)
          const byteLength = cleanValue.length / 2
          if (byteLength < 2 || byteLength > 10) {
            return 'Namespace must be between 2-10 bytes (4-20 hex characters)'
          }

          return true
        }
      }),
      suggestedNamespace,
      {
        field: 'daNamespace',
        configPath: '[da].daNamespace',
        description: 'Celestia DA Namespace (2-10 bytes hex string)',
      }
    ) || suggestedNamespace

    // Process and validate the input namespace value
    // Clean and normalize the input value
    const finalNamespace = inputNamespace.replace(/\s+/g, '').toLowerCase()

    // Double-check validity (should already be validated by the input validator)
    if (finalNamespace.length % 2 === 0 && /^[0-9a-f]*$/.test(finalNamespace)) {
      const byteLength = finalNamespace.length / 2
      if (byteLength >= 2 && byteLength <= 10) {
        log(chalk.green(`✓ Using namespace: ${finalNamespace} (${byteLength} bytes)`))
        newConfig.da!.daNamespace = finalNamespace
      } else {
        this.error('Namespace must be between 2-10 bytes')
        return
      }
    } else {
      this.error('Invalid namespace format after processing')
      return
    }

    // Handle Celestia mnemonic and signer address
    let celestiaMnemonic = ''
    let celestiaSignerAddress = ''

    // In non-interactive mode, use existing mnemonic or generate new one
    let mnemonicChoice: 'generate' | 'input'
    if (niCtx.enabled) {
      // Use existing mnemonic if available, otherwise generate new
      mnemonicChoice = existingConfig.da?.celestiaMnemonic ? 'input' : 'generate'
    } else {
      mnemonicChoice = await select({
        message: 'Celestia mnemonic setup:',
        choices: [
          { name: 'Generate new mnemonic', value: 'generate' },
          { name: 'Input existing mnemonic', value: 'input' }
        ],
        default: existingConfig.da?.celestiaMnemonic ? 'input' : 'generate'
      }) as 'generate' | 'input'
    }

    if (mnemonicChoice === 'generate') {
      // Generate new mnemonic
      const wallet = await DirectSecp256k1HdWallet.generate(24, {
        prefix: 'celestia'
      })
      celestiaMnemonic = wallet.mnemonic
      const accounts = await wallet.getAccounts()
      celestiaSignerAddress = accounts[0].address

      log(chalk.green('✓ Generated new Celestia mnemonic and address'))

      if (!niCtx.enabled) {
        log(chalk.yellow('Please save the following mnemonic securely:'))
        log(chalk.cyan(celestiaMnemonic))
      }
      log(chalk.yellow(`Generated address: ${celestiaSignerAddress}`))

      // In non-interactive mode, always use the generated mnemonic
      const confirmSave = await resolveConfirm(
        niCtx,
        () => confirm({
          message: 'Confirm to use this mnemonic and address?',
          default: true
        }),
        true, // In non-interactive, always confirm
        true
      )

      if (!confirmSave) {
        celestiaMnemonic = ''
        celestiaSignerAddress = ''
      }
    } else if (mnemonicChoice === 'input') {
      // Input existing mnemonic - in non-interactive mode, use existing config value
      if (niCtx.enabled) {
        celestiaMnemonic = resolveEnvValue(existingConfig.da?.celestiaMnemonic) || ''
      } else {
        celestiaMnemonic = await input({
          message: 'Enter your existing Celestia mnemonic:',
          default: existingConfig.da?.celestiaMnemonic,
          validate: (value) => {
            if (!value.trim()) return 'Mnemonic cannot be empty'
            const words = value.trim().split(/\s+/)
            if (words.length !== 12 && words.length !== 24) {
              return 'Mnemonic must be 12 or 24 words'
            }
            return true
          }
        })
      }

      if (celestiaMnemonic.trim()) {
        try {
          celestiaSignerAddress = await this.generateCelestiaAddressFromMnemonic(celestiaMnemonic)
          log(chalk.green(`✓ Auto-generated address from mnemonic: ${celestiaSignerAddress}`))
        } catch (error) {
          log(chalk.red(`Failed to generate address from mnemonic: ${error}`))
          if (niCtx.enabled) {
            // In non-interactive mode, use existing signer address
            celestiaSignerAddress = existingConfig.da?.signerAddress || ''
            if (!celestiaSignerAddress) {
              niCtx.missingFields.push({
                field: 'signerAddress',
                configPath: '[da].signerAddress',
                description: 'Celestia signer address (could not derive from mnemonic)',
              })
            }
          } else {
            celestiaSignerAddress = await input({
              message: 'Please manually enter Celestia Signer address:',
              default: existingConfig.da?.signerAddress,
              validate: (value) => {
                if (!value.trim()) return 'Address cannot be empty'
                if (!value.startsWith('celestia1')) return 'Address must start with celestia1'
                return true
              }
            })
          }
        }
      }
    }

    newConfig.da!.celestiaMnemonic = celestiaMnemonic
    newConfig.da!.signerAddress = celestiaSignerAddress

    //show url of a faucet (skip in non-interactive mode)
    if (!niCtx.enabled) {
      if (newConfig.network === 'testnet') {
        log(chalk.yellow(`\n⚠️  IMPORTANT: Please fund your Celestia signer address with test TIA tokens`))
        log(chalk.blue(`\nYour Celestia Address: ${newConfig.da!.signerAddress}`))
        log(chalk.green(`\n💰 Option 1: Use the faucet (recommended for testing)`))
        log(chalk.blue(`   Faucet URL: https://mocha-4.celenium.io/faucet`))
        log(chalk.red(`   🔴 CRITICAL: Make sure to select "Mocha" network on the faucet website!`))
        log(chalk.green(`\n💳 Option 2: Purchase test TIA tokens from exchanges`))
        log(chalk.cyan(`\n📝 Note: This address ${mnemonicChoice === 'generate' ? 'was just generated' : 'comes from your existing configuration'}`))
      } else {
        log(chalk.yellow(`\n⚠️  IMPORTANT: Please fund your Celestia signer address with TIA tokens`))
        log(chalk.blue(`\nYour Celestia Address: ${newConfig.da!.signerAddress}`))
        log(chalk.green(`\n💡 You need TIA tokens to pay for data availability on Celestia mainnet`))
        log(chalk.cyan(`\n📝 Note: This address ${mnemonicChoice === 'generate' ? 'was just generated' : 'comes from your existing configuration'}`))
      }
    }


    newConfig.da!.celestiaIndexerStartBlock = String(await resolveOrPrompt(
      niCtx,
      () => input({
        default: String(celestiaCurrentHeight),
        message: `Enter the Celestia Indexer Start Block:`,
        validate: (value) => !isNaN(Number(value)) ? true : 'Must be a valid number',
      }),
      existingConfig.da?.celestiaIndexerStartBlock || String(celestiaCurrentHeight),
      {
        field: 'celestiaIndexerStartBlock',
        configPath: '[da].celestiaIndexerStartBlock',
        description: 'Celestia indexer start block height',
      },
      false
    ) || String(celestiaCurrentHeight))

    newConfig.defaults!.dogecoinIndexerStartHeight = String(await resolveOrPrompt(
      niCtx,
      () => input({
        default: String(dogecoinCurrentHeight),
        message: `Enter the Dogecoin Indexer Start Height:`,
        validate: (value) => !isNaN(Number(value)) ? true : 'Must be a valid number',
      }),
      existingConfig.defaults?.dogecoinIndexerStartHeight || String(dogecoinCurrentHeight),
      {
        field: 'dogecoinIndexerStartHeight',
        configPath: '[defaults].dogecoinIndexerStartHeight',
        description: 'Dogecoin indexer start block height',
      },
      false
    ) || String(dogecoinCurrentHeight))

    // Validate any missing required fields before proceeding
    validateAndExit(niCtx)

    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      log(chalk.yellow('config.toml not found. Skipping L1_CONTRACT_DEPLOYMENT_BLOCK update.'))
    } else {
      const configContent = fs.readFileSync(configPath, 'utf8')
      const config = toml.parse(configContent) as {
        general: { L1_CONTRACT_DEPLOYMENT_BLOCK: string }
      }
      config.general.L1_CONTRACT_DEPLOYMENT_BLOCK = newConfig.defaults!.dogecoinIndexerStartHeight
      if (writeConfigs(config)) {
        log(
          chalk.green(`L1_CONTRACT_DEPLOYMENT_BLOCK updated in config.toml`),
        )
      }
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
        network: newConfig.network,
        rpc: {
          url: newConfig.rpc!.url,
          blockbookAPIUrl: newConfig.rpc!.blockbookAPIUrl,
        },
        wallet: {
          path: newConfig.wallet.path,
        },
        da: {
          namespace: newConfig.da!.daNamespace,
          signerAddress: newConfig.da!.signerAddress,
          celestiaIndexerStartBlock: newConfig.da!.celestiaIndexerStartBlock,
        },
        defaults: {
          dogecoinIndexerStartHeight: newConfig.defaults!.dogecoinIndexerStartHeight,
        },
      })
    }
  }


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
    //read existing config file from user's working directory
    const existingConfigStr = fs.readFileSync(setupDefaultsPath, 'utf-8');
    let newConfig = toml.parse(existingConfigStr);

    newConfig.network = newDogeConfig.network;

    newConfig.dogecoin_rpc_url = newDogeConfig.rpc?.url || '';
    newConfig.dogecoin_rpc_user = newDogeConfig.rpc?.username || '';
    newConfig.dogecoin_rpc_pass = newDogeConfig.rpc?.password || '';
    newConfig.dogecoin_blockbook_url = newConfig.network === 'mainnet' ? 'https://dogebook.nownodes.io' : 'https://dogebook-testnet.nownodes.io';
    newConfig.dogecoin_blockbook_api_key = newDogeConfig.rpc?.apiKey || '';

    // Write to setup_defaults.toml
    fs.writeFileSync(setupDefaultsPath, toml.stringify(newConfig));
  }
}

export default DogeConfigCommand
