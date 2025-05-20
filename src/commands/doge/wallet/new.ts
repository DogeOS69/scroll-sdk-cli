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

import {confirm} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import bitcore from 'bitcore-lib-doge'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

// Assuming loadDogeConfig and DogeConfig types are available and updated
import type {DogeConfig, DogeWallet} from '../../../types/doge-config.js' // Adjusted path
import {loadDogeConfig} from '../../../utils/doge-config.js' // Adjusted path

const {Networks, PrivateKey} = bitcore

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
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(WalletNew)

    let config: DogeConfig
    try {
      config = await loadDogeConfig(flags.config)
    } catch (error) {
      this.error(
        `Failed to load Dogecoin config from ${flags.config}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return
    }

    this.log(chalk.blue(`Using network: ${config.network} (from config file: ${flags.config})`))

    const walletPathFromConfig = config.wallet?.path
    if (!flags.path && !walletPathFromConfig) {
      this.error(`Wallet path not defined. Specify with --path, or ensure 'wallet.path' is set in ${flags.config}`)
      return
    }

    const resolvedWalletPath = path.resolve(flags.path || walletPathFromConfig!)

    if (fs.existsSync(resolvedWalletPath)) {
      this.error(
        `Wallet already exists at ${resolvedWalletPath}. To use this wallet, consider 'doge:wallet:sync' or 'doge:wallet:send'. To create a new one, use a different path or delete the existing file.`,
      )
      return
    }

    const bitcoreNetwork = config.network === 'testnet' ? Networks.testnet : Networks.livenet

    const privateKey = new PrivateKey(null, bitcoreNetwork)
    const address = privateKey.toAddress()

    this.log(chalk.cyan('\nNew wallet details:'))
    this.log(`Network: ${chalk.yellow(config.network)}`)
    this.log(`Address: ${chalk.yellow(address.toString())}`)
    this.log(
      `Private Key (WIF): ${
        flags['dry-run'] ? chalk.grey('[hidden during dry run]') : chalk.yellow(privateKey.toWIF())
      }`,
    )
    if (flags['dry-run']) {
      this.log(chalk.dim('(To view WIF in dry run, a flag like --show-private-key would typically be added)'))
      this.log(chalk.dim('\nDry run - no wallet created'))
      return
    }

    const confirmed = flags.force
      ? true
      : await confirm({
          default: true,
          message: `Create wallet with these details and save to ${resolvedWalletPath}?`,
        })

    if (!confirmed) {
      this.log(chalk.dim('Wallet creation cancelled'))
      return
    }

    const walletDir = path.dirname(resolvedWalletPath)
    if (!fs.existsSync(walletDir)) {
      fs.mkdirSync(walletDir, {recursive: true})
    }

    const walletData: DogeWallet = {
      address: address.toString(),
      network: config.network,
      privateKey: privateKey.toWIF(),
      utxos: [],
    }

    fs.writeFileSync(resolvedWalletPath, JSON.stringify(walletData, null, 2), {mode: 0o600})
    this.log(chalk.green('\n✓ Wallet created successfully'))
    this.log(`Saved to: ${chalk.cyan(resolvedWalletPath)}`)
    this.log(chalk.yellow('Important: Backup your wallet file and keep your private key secret!'))
  }
}
