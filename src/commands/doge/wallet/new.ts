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

const {Networks, PrivateKey} = bitcore

export default class WalletNew extends Command {
  static default = false

  static description = 'Create a new Dogecoin wallet'

  static examples = [
    '$ scrollsdk doge:wallet new',
    '$ scrollsdk doge:wallet new --path ./my-custom-wallet.json',
    '$ scrollsdk doge:wallet new --dry-run',
    '$ scrollsdk doge:wallet new --force',
  ]

  static flags = {
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
      default: '.data/doge-wallet.json',
      description: 'Path to save the wallet file',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(WalletNew)

    // Get wallet path
    const walletPath = path.resolve(flags.path)

    // Check if wallet exists
    if (fs.existsSync(walletPath)) {
      throw new Error(`Wallet already exists at ${walletPath}`)
    }

    // Create new wallet
    const network = Networks.livenet
    const privateKey = new PrivateKey(null, network)
    const address = privateKey.toAddress()

    // Show wallet details
    this.log(chalk.cyan('\nNew wallet details:'))
    this.log(`Address: ${chalk.yellow(address.toString())}`)

    if (flags['dry-run']) {
      this.log(chalk.dim('\nDry run - no wallet created'))
      return
    }

    // Confirm wallet creation
    if (!flags.force) {
      const confirmed = await confirm({
        message: 'Create wallet with these details?',
      })

      if (!confirmed) {
        this.log(chalk.dim('Wallet creation cancelled'))
        return
      }
    }

    // Create wallet directory if it doesn't exist
    const walletDir = path.dirname(walletPath)
    if (!fs.existsSync(walletDir)) {
      fs.mkdirSync(walletDir, {recursive: true})
    }

    // Save wallet with secure permissions
    const walletData = {
      address: address.toString(),
      privateKey: privateKey.toWIF(),
      utxos: [],
    }

    fs.writeFileSync(walletPath, JSON.stringify(walletData, null, 2), {mode: 0o600})
    this.log(chalk.green('\n✓ Wallet created successfully'))
    this.log(`Saved to: ${chalk.cyan(walletPath)}`)
  }
}
