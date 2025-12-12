/**
 * Wallet Creation Implementation
 *
 * The command uses bitcore-lib-doge's classes for wallet creation:
 * - PrivateKey for secure key generation
 * - Address for P2PKH address creation
 * - Networks for network selection (mainnet/testnet)
 *
 * Key features:
 * - Cryptographically secure key generation
 * - WIF-encoded private key storage
 * - P2PKH address format
 * - Interactive confirmation
 * - Dry run preview mode
 */

import { confirm } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import bitcore from 'bitcore-lib-doge'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

// Assuming loadDogeConfig and DogeConfig types are available and updated
import type { DogeConfig, DogeWallet } from '../../../types/doge-config.js' // Adjusted path
import { loadDogeConfigWithSelection } from '../../../utils/doge-config.js' // Adjusted path
import { JsonOutputContext } from '../../../utils/json-output.js'

const { Networks, PrivateKey } = bitcore

export default class WalletNew extends Command {
  static default = false

  static description = 'Create a new Dogecoin wallet (mainnet or testnet)'

  static examples = [
    '$ scrollsdk doge:wallet new --config .data/doge-config-mainnet.toml',
    '$ scrollsdk doge:wallet new --config .data/doge-config-testnet.toml',
    '$ scrollsdk doge:wallet new --path ./my-custom-wallet.json --config .data/doge-config-testnet.toml',
    '$ scrollsdk doge:wallet new --dry-run',
    '$ scrollsdk doge:wallet new --force',
  ]

  static flags = {
    config: Flags.string({
      char: 'c',
      default: '.data/doge-config.toml', // User should point to the correct mainnet/testnet config
      description: 'Path to Dogecoin config file (determines network and default wallet path)',
    }),
    'dry-run': Flags.boolean({
      char: 'd',
      default: false,
      description: 'Show what would be created without actually creating the wallet',
    }),
    force: Flags.boolean({
      char: 'f',
      default: false,
      description: 'Skip confirmation prompt',
    }),
    path: Flags.string({
      char: 'p',
      description: 'Path to save the wallet file (overrides path from config file)',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      description: 'Run without prompts (implies --force)',
      default: false,
    }),
    json: Flags.boolean({
      description: 'Output in JSON format (stdout for data, stderr for logs)',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(WalletNew)

    const nonInteractive = flags['non-interactive']
    const jsonMode = flags.json
    const jsonCtx = new JsonOutputContext('doge wallet new', jsonMode)

    // In non-interactive mode, we must have a config path to avoid prompts in loadDogeConfigWithSelection
    // The --config flag has a default value, so this will always be set
    const { config, configPath } = await loadDogeConfigWithSelection(
      flags.config,
      'scrollsdk doge:config'
    )

    jsonCtx.info(`Using network: ${config.network} (from config file: ${configPath})`)

    const walletPathFromConfig = config.wallet?.path
    if (!flags.path && !walletPathFromConfig) {
      jsonCtx.error(
        'E601_MISSING_FIELD',
        `Wallet path not defined. Specify with --path, or ensure 'wallet.path' is set in ${configPath}`,
        'CONFIGURATION',
        true,
        { configFile: configPath }
      )
    }

    const resolvedWalletPath = path.resolve(flags.path || walletPathFromConfig!)

    if (fs.existsSync(resolvedWalletPath)) {
      jsonCtx.error(
        'E602_FILE_EXISTS',
        `Wallet already exists at ${resolvedWalletPath}. To use this wallet, consider 'doge:wallet:sync' or 'doge:wallet:send'. To create a new one, use a different path or delete the existing file.`,
        'CONFIGURATION',
        true,
        { walletPath: resolvedWalletPath }
      )
    }

    const bitcoreNetwork = config.network === 'testnet' ? Networks.testnet : Networks.livenet

    const privateKey = new PrivateKey(null, bitcoreNetwork)
    const address = privateKey.toAddress()

    if (!jsonMode) {
      this.log(chalk.cyan('\nNew wallet details:'))
      this.log(`Network: ${chalk.yellow(config.network)}`)
      this.log(`Address: ${chalk.yellow(address.toString())}`)
      this.log(
        `Private Key (WIF): ${flags['dry-run'] ? chalk.grey('[hidden during dry run]') : chalk.yellow(privateKey.toWIF())
        }`,
      )
    }

    if (flags['dry-run']) {
      if (!jsonMode) {
        this.log(chalk.dim('(To view WIF in dry run, a flag like --show-private-key would typically be added)'))
        this.log(chalk.dim('\nDry run - no wallet created'))
      }
      if (jsonMode) {
        jsonCtx.success({
          dryRun: true,
          network: config.network,
          address: address.toString(),
          walletPath: resolvedWalletPath,
        })
      }
      return
    }

    // In non-interactive mode, always skip confirmation (like --force)
    const confirmed = flags.force || nonInteractive
      ? true
      : await confirm({
        default: true,
        message: `Create wallet with these details and save to ${resolvedWalletPath}?`,
      })

    if (!confirmed) {
      jsonCtx.info('Wallet creation cancelled')
      return
    }

    const walletDir = path.dirname(resolvedWalletPath)
    if (!fs.existsSync(walletDir)) {
      fs.mkdirSync(walletDir, { recursive: true })
    }

    const walletData: DogeWallet = {
      address: address.toString(),
      network: config.network,
      privateKey: privateKey.toWIF(),
      utxos: [],
    }

    fs.writeFileSync(resolvedWalletPath, JSON.stringify(walletData, null, 2), { mode: 0o600 })

    jsonCtx.logSuccess('Wallet created successfully')
    if (!jsonMode) {
      this.log(`Saved to: ${chalk.cyan(resolvedWalletPath)}`)
      this.log(chalk.yellow('Important: Backup your wallet file and keep your private key secret!'))
    }

    // JSON output
    if (jsonMode) {
      jsonCtx.success({
        network: config.network,
        address: address.toString(),
        privateKey: privateKey.toWIF(),
        walletPath: resolvedWalletPath,
      })
    }
  }
}
