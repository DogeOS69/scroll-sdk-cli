/**
 * Wallet Sync Implementation
 *
 * The command uses NowNodes API to synchronize wallet state:
 * 1. Fetch address information (balance, tx count)
 * 2. Fetch UTXO list (unspent outputs)
 * 3. Fetch full transaction details for each UTXO
 *
 * Key features:
 * - Complete UTXO data for transaction creation
 * - Balance tracking (confirmed/unconfirmed)
 * - Automatic script public key retrieval
 * - Multiple API key sources (flag, env, config)
 */

import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import {DogeWallet} from '../../../types/doge-config.js'
import {loadDogeConfig} from '../../../utils/doge-config.js'

interface AddressInfo {
  address: string
  balance: string
  totalReceived: string
  totalSent: string
  txs: number
  unconfirmedBalance: string
  unconfirmedTxs: number
}

interface UTXOInfo {
  confirmations: number
  height: number
  scriptPubKey: string
  txid: string
  value: string
  vout: number
}

interface TransactionInfo {
  vout: Array<{
    hex: string
    n: number
    value: string
  }>
}

export default class WalletSync extends Command {
  static default = false

  static description = 'Sync wallet UTXOs and balance'

  static examples = [
    '$ scrollsdk doge:wallet sync',
    '$ scrollsdk doge:wallet sync --path ./my-wallet.json',
    '$ scrollsdk doge:wallet sync --api-key YOUR_KEY',
  ]

  static flags = {
    'api-key': Flags.string({
      char: 'k',
      description: 'NowNodes API key (overrides config)',
      env: 'NOWNODES_API_KEY',
    }),
    config: Flags.string({
      char: 'c',
      default: '.data/doge-config.toml',
      description: 'Path to config file',
    }),
    path: Flags.string({
      char: 'p',
      description: 'Custom path for the wallet file (overrides config)',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(WalletSync)

    try {
      // Load config
      const config = await loadDogeConfig(flags.config)

      // Get API key from flags, env, or config
      const apiKey = flags.apiKey || process.env.NOWNODES_API_KEY || config.rpc?.apiKey
      if (!apiKey) {
        this.error(
          'NowNodes API key is required. Provide it via --api-key flag, NOWNODES_API_KEY env var, or in config rpc.apiKey',
        )
      }

      // Load wallet
      const walletPath = flags.path ? path.resolve(flags.path) : path.resolve(config.wallet.path)
      if (!fs.existsSync(walletPath)) {
        this.error(`Wallet file not found at ${walletPath}`)
      }

      const walletData: DogeWallet = JSON.parse(fs.readFileSync(walletPath, 'utf8'))

      // Initialize RPC client
      const baseUrl = 'https://dogebook.nownodes.io/api/v2'

      // Helper function for API calls
      const rpcCall = async <T>(endpoint: string): Promise<T> => {
        const url = `${baseUrl}${endpoint}`
        const response = await fetch(url, {
          headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey,
          },
          method: 'GET',
        })

        if (!response.ok) {
          throw new Error(`API call failed: ${response.status} ${response.statusText}`)
        }

        return response.json()
      }

      // Fetch address info first
      this.log(chalk.cyan('Fetching wallet info...'))
      const addressInfo = await rpcCall<AddressInfo>(`/address/${walletData.address}`)

      // Initialize empty UTXOs array
      walletData.utxos = []

      // Only fetch UTXOs if balance is greater than 0
      if (addressInfo.balance !== '0') {
        const utxos = await rpcCall<UTXOInfo[]>(`/utxo/${walletData.address}`)

        // Debug log the first UTXO
        if (utxos && utxos.length > 0) {
          this.log(chalk.dim('\nFirst UTXO details:'))
          this.log(chalk.dim(JSON.stringify(utxos[0], null, 2)))

          // Fetch full transaction details for each UTXO
          this.log(chalk.cyan('\nFetching full transaction details for UTXOs...'))
          const enhancedUtxos = await Promise.all(
            utxos.map(async (utxo) => {
              const txDetails = await rpcCall<TransactionInfo>(`/tx/${utxo.txid}`)

              // Find matching vout
              const voutDetails = txDetails.vout.find((v) => v.n === utxo.vout)
              if (!voutDetails) {
                throw new Error(`Could not find vout ${utxo.vout} in transaction ${utxo.txid}`)
              }

              this.log(chalk.dim(`- UTXO ${utxo.txid}:${utxo.vout} script: ${voutDetails.hex}`))

              return {
                satoshis: Number.parseInt(utxo.value, 10),
                script: voutDetails.hex,
                txid: utxo.txid,
                vout: utxo.vout,
              }
            }),
          )

          walletData.utxos = enhancedUtxos
        }
      }

      // Calculate total balance
      const totalBalance = walletData.utxos.reduce((sum, utxo) => sum + utxo.satoshis, 0)

      // Save wallet
      fs.writeFileSync(walletPath, JSON.stringify(walletData, null, 2))

      this.log(chalk.green('\n✓ Wallet synced successfully'))
      this.log(`Address: ${chalk.cyan(walletData.address)}`)
      this.log(`UTXOs: ${chalk.yellow(walletData.utxos.length)}`)
      this.log(`Balance: ${chalk.yellow(totalBalance / 1e8)} DOGE`)
      if (addressInfo.unconfirmedBalance !== '0') {
        this.log(`Unconfirmed Balance: ${chalk.yellow(Number.parseInt(addressInfo.unconfirmedBalance, 10) / 1e8)} DOGE`)
      }
    } catch (error) {
      if (error instanceof Error) {
        this.error(error.message)
      }

      throw error
    }
  }
}
