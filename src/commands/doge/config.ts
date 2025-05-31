import * as toml from '@iarna/toml'
import { input, select, confirm } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import type { DogeConfig } from '../../types/doge-config.js'
import { loadDogeConfig } from '../../utils/doge-config.js'
import { getSetupDefaultsPath, SETUP_DEFAULTS_TEMPLATE } from '../../config/constants.js'
import crypto from 'node:crypto'

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

  // Common validators
  private validators = {
    required: (value: string) => value.length > 0 ? true : 'This field is required',
    chainId: (value: string) => /^(0x[\dA-Fa-f]+|\d+)$/.test(value) ? true : 'Chain ID must be decimal or hex with 0x prefix',
    evmAddress: (value: string) => /^0x[\dA-Fa-f]{40}$/.test(value) ? true : 'EVM Address must be 20 bytes (40 hex chars) with 0x prefix',
    dogeAddress: (value: string) => /^(D[1-9A-HJ-NP-Za-km-z]{33}|[mn][1-9A-HJ-NP-Za-km-z]{33})$/.test(value) ? true : 'Invalid Dogecoin address format',
    number: (value: string) => !isNaN(Number(value)) ? true : 'Must be a valid number',
  }

  private ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
  }

  private saveConfigToFile(config: any, filePath: string): void {
    this.ensureDirectoryExists(path.dirname(filePath))
    fs.writeFileSync(filePath, toml.stringify(config))
  }

  private getDefaultSetupConfig(): any {
    return {
      network: 'testnet',
      seed_string: '',
      dogecoin_rpc_url: 'https://testnet.doge.xyz',
      dogecoin_rpc_user: 'user',
      dogecoin_rpc_pass: '',
      dogecoin_blockbook_url: 'https://dogebook-testnet.nownodes.io',
      dogecoin_blockbook_api_key: '',
      sequencer_threshold: 1,
      correctness_threshold: 2,
      attestation_threshold: 2,
      recovery_threshold: 2,
      correctness_key_count: 3,
      attestation_key_count: 3,
      recovery_key_count: 3,
      timelock_seconds: 3600,
      fee_rate_sat_per_kvb: 2000000,
      deposit_eth_recipient_address_hex: '0xbb8bc29695232088b1a2dbc117e8c6006478c295',
      sequencer_target_amount: 42069000,
      fee_wallet_target_amount: 1000000000,
      bridge_target_amount: 5000000000,
      confirmations_required: 1
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

  async run(): Promise<void> {
    const { flags } = await this.parse(DogeConfigCommand)
    let resolvedPath = "";

    if (!flags.config) {
      if (!fs.existsSync('.data')) {
        fs.mkdirSync('.data', { recursive: true });
      }
      const files = fs.readdirSync('.data')
      const configFiles = files.filter(file => file.endsWith('.toml'))
      const configFileChoices = configFiles.map(file => ({ name: file, value: file }))

      const fileSelection = await select({
        choices: [
          ...configFileChoices,
          { name: 'Create New Config', value: 'new' as const },
        ],
        message: 'Select config file to configure:',
      })

      if (fileSelection === 'new') {
        const newConfigName = await input({
          default: "doge-config.toml",
          message: 'Enter the name of the new config file:',
        })
        resolvedPath = path.resolve('.data/' + newConfigName);
      } else {
        const configPath = path.join('.data', fileSelection)
        resolvedPath = path.resolve(configPath)
      }

    } else {
      resolvedPath = path.resolve(flags.config);
      if (!fs.existsSync(resolvedPath)) {
        this.error(`Config file ${resolvedPath} does not exist`);
        return;
      }
    }

    this.configPath = resolvedPath
    const existingConfig = await loadDogeConfig(resolvedPath)
    let newConfig = await loadDogeConfig(resolvedPath);
    this.dogeConfig = newConfig

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

    newConfig.defaults!.chainId = await input({
      default: existingConfig.defaults?.chainId,
      message: 'Enter the Chain ID (hex with 0x prefix or decimal):',
      validate: (value) =>
        /^(0x[\dA-Fa-f]+|\d+)$/.test(value) ? true : 'Chain ID must be decimal or hex with 0x prefix',
    })

    newConfig.defaults!.evmAddress = await input({
      default: existingConfig.defaults?.evmAddress || '0x151a64570e4997739458455ba4ab5A535FD2E306',
      message: 'Enter the EVM Address (20 bytes):',
      validate: (value) =>
        /^0x[\dA-Fa-f]{40}$/.test(value) ? true : 'EVM Address must be 20 bytes (40 hex chars) with 0x prefix',
    })

    newConfig.defaults!.recipient = await input({
      default: existingConfig.defaults?.recipient || 'nmNf4f5kyvCFrfyUBoQU3TKN3Dyc5kcMoH',
      message: `Enter the Doge recipient Address:`,
      validate: (value) =>
        /^(D[1-9A-HJ-NP-Za-km-z]{33}|[mn][1-9A-HJ-NP-Za-km-z]{33})$/.test(value)
          ? true
          : 'Invalid Dogecoin address format',
    })

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
      message: `Enter the Celestia Tendermint RPC URL:`,
    });
    newConfig.da!.daNamespace = await input({
      default: existingConfig.da?.daNamespace,
      message: `Enter the Celestia DA Namespace:`,
    });
    newConfig.da!.signerAddress = await input({
      default: existingConfig.da?.signerAddress,
      message: `Enter the Celestia Signer Address:`,
    });
    newConfig.da!.genesisBlobCommitment = await input({
      default: existingConfig.da?.genesisBlobCommitment,
      message: `Enter the Celestia Genesis Blob Commitment:`,
    });

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
    this.log(chalk.blue(`Chain ID: ${newConfig.defaults!.chainId}`))
    this.log(chalk.blue(`EVM Address: ${newConfig.defaults!.evmAddress}`))
    this.log(chalk.blue(`Doge recipient Address: ${newConfig.defaults!.recipient}`))

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
    newConfig.deposit_eth_recipient_address_hex = newDogeConfig.defaults?.evmAddress || '';

    // Write to setup_defaults.toml
    fs.writeFileSync(setupDefaultsPath, toml.stringify(newConfig));
  }
}

export default DogeConfigCommand
