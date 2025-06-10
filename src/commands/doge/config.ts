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

export class DogeConfigCommand extends Command {
  static description = 'Configure Dogecoin settings for mainnet or testnet'

  static examples = [
    '$ scrollsdk doge:config',
    '$ scrollsdk doge:config --config .data/doge-config-mainnet.toml',
    '$ scrollsdk doge:config --config .data/doge-config-testnet.toml',
  ]

  static flags = {
    config: Flags.string({
      char: 'c',
      description: 'Path to config file (e.g., .data/doge-config-mainnet.toml or .data/doge-config-testnet.toml)',
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

  async run(): Promise<void> {
    const { flags } = await this.parse(DogeConfigCommand)

    if (!fs.existsSync('.data')) {
      fs.mkdirSync('.data', { recursive: true })
    }

    const files = fs.readdirSync('.data')
    const configFiles = files.filter(file => file.startsWith('doge') && file.endsWith('.toml'))
    const configFileChoices = configFiles.map(file => ({ name: file, value: file }))
    
    let resolvedPath = flags.config as string
    let network = ""

    let fileSelected=""
    if (!flags.config) {
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
      resolvedPath = path.resolve('.data', fileSelected)
    }

    // let resolvedPath = path.resolve(".data", fileSelected)
    let existingConfig: DogeConfig = {} as DogeConfig;

    if (!fs.existsSync(resolvedPath)) {
      const shouldCreate = await confirm({
        default: true,
        message: `Config file not found at ${resolvedPath}. Would you like to create a default one now?`,
      })

      if (!shouldCreate) {
        throw new Error(`Config file not found at ${resolvedPath}, and not created.`)
      }

      console.log('Creating a new default Dogecoin configuration file...')

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
            network === 'mainnet' ? 'https://dogebook.nownodes.io/api/v2' : 'https://dogebook-testnet.nownodes.io/api/v2',
          url: network === 'mainnet' ? '' : 'https://testnet.doge.xyz/',
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
          //rpcUrl: network === 'mainnet' ? 'http://celestia-mainnet:26658' : 'http://celestia-testnet-mocha:26658',
          tendermintRpcUrl: '',
          daNamespace: network === 'mainnet' ? '' : '',
          signerAddress: '',
          celestiaMnemonic: '',
        }
      }

      // const configDir = path.dirname(resolvedPath)
      // if (!fs.existsSync(configDir)) {
      //   fs.mkdirSync(configDir, { recursive: true })
      // }
      existingConfig = defaultConfig;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fs.writeFileSync(resolvedPath, toml.stringify(existingConfig as any))

      console.log(
        `Created new default ${network} config file at ${resolvedPath}. You can further customize it with 'scrollsdk doge:config'.`,
      )
    } else {
      ({ config: existingConfig, configPath: resolvedPath } = await loadDogeConfigWithSelection(resolvedPath));
    }

    let newConfig = existingConfig;

    newConfig.rpc!.apiKey = await input({
      default: existingConfig.rpc?.apiKey,
      message: 'Enter your NowNodes API key (get one at nownodes.io):',
      validate: (value) => (value ? true : 'API key is required'),
    })

    let generateClusterRpc = await confirm({
      message: `Do you want to automatically generate secure credentials for your Dogecoin RPC service that will be deployed?\n  (These will be used to authenticate access to your Dogecoin nodes)\n  Choose 'Yes' to auto-generate, 'No' to set manually`,
      default: true,
    })
    if (!generateClusterRpc) {
      newConfig.dogecoinClusterRpc!.username = await input({
        default: existingConfig.dogecoinClusterRpc?.username,
        message: `Enter the username for your Dogecoin RPC service (will be used for authentication):`,
      });

      newConfig.dogecoinClusterRpc!.password = await input({
        default: existingConfig.dogecoinClusterRpc?.password,
        message: `Enter the password for your Dogecoin RPC service (will be used for authentication):`,
      });
    } else {
      newConfig.dogecoinClusterRpc!.username = this.generateSecureRandomString(8);
      newConfig.dogecoinClusterRpc!.password = this.generateSecureRandomString(16);
      this.log(chalk.green(`✓ Generated secure random credentials for Dogecoin cluster RPC`));
    }

    newConfig.wallet!.path = await input({
      default: existingConfig.wallet?.path,
      message: `Enter the wallet file path:`,
    })

    newConfig.rpc!.url = await input({
      default: existingConfig.rpc?.url,
      message: `Enter an external dogecoin RPC URL for wallet operations (send/sync):
      `,
    });

    newConfig.rpc!.username = await input({
      default: existingConfig.rpc?.username,
      message: `Enter RPC username (leave empty for public RPC endpoints):`,
    });

    newConfig.rpc!.password = await input({
      default: existingConfig.rpc?.password,
      message: `Enter RPC password (leave empty for public RPC endpoints):`,
    });

    newConfig.da!.tendermintRpcUrl = await input({
      default: existingConfig.da?.tendermintRpcUrl,
      message: `Enter the Celestia Tendermint RPC URL (if known):`,
      required: false
    });

    // Handle Celestia namespace - auto-generate and show to user
    let suggestedNamespace = existingConfig.da?.daNamespace

    if (!suggestedNamespace) {
      // No existing namespace, generate new one
      suggestedNamespace = this.generateCelestiaNamespace()

      this.log(chalk.blue('\n📋 Celestia DA Namespace:'))
      this.log(chalk.yellow('Format: Any valid hex string (2-10 bytes allowed)'))
      this.log(chalk.green(`Auto-generated: ${suggestedNamespace}`))
    } else {
      // Existing namespace found, ask if user wants to generate new one
      this.log(chalk.blue('\n📋 Celestia DA Namespace:'))
      this.log(chalk.yellow('Format: Any valid hex string (2-10 bytes allowed)'))
      this.log(chalk.cyan(`Current: ${suggestedNamespace}`))

      const generateNew = await confirm({
        message: 'Generate a new random namespace?',
        default: false
      })

      if (generateNew) {
        //randomly generate a namespace
        suggestedNamespace = this.generateCelestiaNamespace()
        this.log(chalk.green(`New generated: ${suggestedNamespace}`))
      }
    }

    // Ensure we always have a valid namespace
    if (!suggestedNamespace) {
      suggestedNamespace = this.generateCelestiaNamespace()
      this.log(chalk.green(`Fallback generated: ${suggestedNamespace}`))
    }

    const inputNamespace = await input({
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
    });

    // Process and validate the input namespace value
    // Clean and normalize the input value
    const finalNamespace = inputNamespace.replace(/\s+/g, '').toLowerCase()

    // Double-check validity (should already be validated by the input validator)
    if (finalNamespace.length % 2 === 0 && /^[0-9a-f]*$/.test(finalNamespace)) {
      const byteLength = finalNamespace.length / 2
      if (byteLength >= 2 && byteLength <= 10) {
        this.log(chalk.green(`✓ Using namespace: ${finalNamespace} (${byteLength} bytes)`))
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

    const mnemonicChoice = await select({
      message: 'Celestia mnemonic setup:',
      choices: [
        { name: 'Generate new mnemonic', value: 'generate' },
        { name: 'Input existing mnemonic', value: 'input' }
      ],
      default: existingConfig.da?.celestiaMnemonic ? 'input' : 'generate'
    })

    if (mnemonicChoice === 'generate') {
      // Generate new mnemonic
      const wallet = await DirectSecp256k1HdWallet.generate(24, {
        prefix: 'celestia'
      })
      celestiaMnemonic = wallet.mnemonic
      const accounts = await wallet.getAccounts()
      celestiaSignerAddress = accounts[0].address

      this.log(chalk.green('✓ Generated new Celestia mnemonic and address'))
      this.log(chalk.yellow('Please save the following mnemonic securely:'))
      this.log(chalk.cyan(celestiaMnemonic))
      this.log(chalk.yellow(`Generated address: ${celestiaSignerAddress}`))

      const confirmSave = await confirm({
        message: 'Confirm to use this mnemonic and address?',
        default: true
      })

      if (!confirmSave) {
        celestiaMnemonic = ''
        celestiaSignerAddress = ''
      }
    } else if (mnemonicChoice === 'input') {
      // Input existing mnemonic
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

      if (celestiaMnemonic.trim()) {
        try {
          celestiaSignerAddress = await this.generateCelestiaAddressFromMnemonic(celestiaMnemonic)
          this.log(chalk.green(`✓ Auto-generated address from mnemonic: ${celestiaSignerAddress}`))
        } catch (error) {
          this.log(chalk.red(`Failed to generate address from mnemonic: ${error}`))
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

    newConfig.da!.celestiaMnemonic = celestiaMnemonic
    newConfig.da!.signerAddress = celestiaSignerAddress

    //show url of a faucet
    if (newConfig.network === 'testnet') {
      this.log(chalk.yellow(`\n⚠️  IMPORTANT: Please fund your Celestia signer address with test TIA tokens`))
      this.log(chalk.blue(`\nYour Celestia Address: ${newConfig.da!.signerAddress}`))
      this.log(chalk.green(`\n💰 Option 1: Use the faucet (recommended for testing)`))
      this.log(chalk.blue(`   Faucet URL: https://mocha-4.celenium.io/faucet`))
      this.log(chalk.red(`   🔴 CRITICAL: Make sure to select "Mocha" network on the faucet website!`))
      this.log(chalk.green(`\n💳 Option 2: Purchase test TIA tokens from exchanges`))
      this.log(chalk.cyan(`\n📝 Note: This address ${mnemonicChoice === 'generate' ? 'was just generated' : 'comes from your existing configuration'}`))
    } else {
      this.log(chalk.yellow(`\n⚠️  IMPORTANT: Please fund your Celestia signer address with TIA tokens`))
      this.log(chalk.blue(`\nYour Celestia Address: ${newConfig.da!.signerAddress}`))
      this.log(chalk.green(`\n💡 You need TIA tokens to pay for data availability on Celestia mainnet`))
      this.log(chalk.cyan(`\n📝 Note: This address ${mnemonicChoice === 'generate' ? 'was just generated' : 'comes from your existing configuration'}`))
    }

    newConfig.da!.celestiaIndexerStartBlock = String(await input({
      default: String(existingConfig.da?.celestiaIndexerStartBlock || 0),
      message: `Enter the Celestia Indexer Start Block:`,
      validate: (value) => !isNaN(Number(value)) ? true : 'Must be a valid number',
    }));

    newConfig.defaults!.dogecoinIndexerStartHeight = String(await input({
      default: String(existingConfig.defaults?.dogecoinIndexerStartHeight || 4000000),
      message: `Enter the Dogecoin Indexer Start Height:`,
      validate: (value) => !isNaN(Number(value)) ? true : 'Must be a valid number',
    }));

    const configDir = path.dirname(resolvedPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fs.writeFileSync(resolvedPath, toml.stringify(newConfig as any))

    this.log(chalk.green(`\nConfiguration for ${newConfig.network} network saved to ${resolvedPath}`))
    this.log(chalk.blue('\nConfiguration Summary:'))
    this.log(chalk.blue(`Network: ${newConfig.network}`))
    this.log(chalk.blue(`RPC URL: ${newConfig.rpc!.url}`))
    this.log(chalk.blue(`Blockbook API URL: ${newConfig.rpc!.blockbookAPIUrl}`))
    this.log(chalk.blue(`Wallet Path: ${newConfig.wallet.path}`))

    await this.generateSetupDefaultsToml(newConfig)
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

    newConfig.dogecoin_rpc_url = newDogeConfig.rpc?.url || 'https://testnet.doge.xyz';
    newConfig.dogecoin_rpc_user = newDogeConfig.rpc?.username || '';
    newConfig.dogecoin_rpc_pass = newDogeConfig.rpc?.password || '';
    const blockbookUrl = newDogeConfig.rpc?.blockbookAPIUrl?.replace('/api/v2', '') || '';
    newConfig.dogecoin_blockbook_url = blockbookUrl;
    newConfig.dogecoin_blockbook_api_key = newDogeConfig.rpc?.apiKey || '';

    // Write to setup_defaults.toml
    fs.writeFileSync(setupDefaultsPath, toml.stringify(newConfig));
  }
}

export default DogeConfigCommand
