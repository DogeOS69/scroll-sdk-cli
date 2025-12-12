/* eslint-disable max-depth */
 
 
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

import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import { DogeUTXO, DogeWallet } from '../../../types/doge-config.js'
import { loadDogeConfigWithSelection } from '../../../utils/doge-config.js'

interface AddressTransactionVout {
  addresses: string[]
  hex: string
  isAddress: boolean
  n: number
  spent?: boolean
  spentTxId?: string
  value: string
}

interface AddressTransaction {
  blockHeight: number
  confirmations: number
  txid: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vin: any[]
  vout: AddressTransactionVout[]
}

interface AddressDetailsWithTxsResponse {
  address: string
  balance: string
  itemsOnPage: number
  page: number
  totalPages: number
  totalReceived: string
  totalSent: string
  transactions?: AddressTransaction[]
  txs: number
  unconfirmedBalance: string
  unconfirmedTxs: number
}

export default class WalletSync extends Command {
  static default = false

  static description = 'Sync wallet UTXOs and balance (mainnet/testnet aware)'

  static examples = [
    '$ scrollsdk doge:wallet sync --config .data/doge-config-mainnet.toml',
    '$ scrollsdk doge:wallet sync --config .data/doge-config-testnet.toml',
  ]

  static flags = {
    'api-key': Flags.string({
      char: 'k',
      description: 'NowNodes API key (overrides API key from config)',
      env: 'NOWNODES_API_KEY',
    }),
    config: Flags.string({
      char: 'c',

      description: 'Path to Dogecoin config file',
    }),
    path: Flags.string({
      char: 'p',
      description: 'Custom path for the wallet file (overrides path from config)',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(WalletSync)

    try {

      const { config } = await loadDogeConfigWithSelection(
        flags.config,
        'scrollsdk doge:config',
      )

      this.log(chalk.blue(`Syncing wallet for network: ${config.network} (from ${flags.config})`))

      let apiKey = flags['api-key'] || process.env.NOWNODES_API_KEY || config.rpc?.apiKey
      if (!apiKey) {
        // this.error('API key required. Provide via --api-key, NOWNODES_API_KEY, or rpc.apiKey in config.')
        // return
        apiKey="";
      }

      let blockbookBaseUrl = config.rpc?.blockbookAPIUrl
      // if not endiwith "/api/" or "/api" then add it
      if (blockbookBaseUrl && !blockbookBaseUrl.endsWith('/api/') && !blockbookBaseUrl.endsWith('/api')){
        blockbookBaseUrl += '/api'
      }

      if (!blockbookBaseUrl) {
        this.error('Config rpc.blockbookAPIUrl not found. Required for sync.')
        return
      }

      const walletConfigPath = flags.path || config.wallet?.path
      if (!walletConfigPath) {
        this.error(`Wallet path not defined. Specify with --path or ensure 'wallet.path' is set in ${flags.config}`)
        return
      }

      const resolvedWalletPath = path.resolve(walletConfigPath)

      if (!fs.existsSync(resolvedWalletPath)) {
        this.error(`Wallet file not found: ${resolvedWalletPath}. Use 'doge:wallet new' first.`)
        return
      }

      const walletData: DogeWallet = JSON.parse(fs.readFileSync(resolvedWalletPath, 'utf8'))
      if (!walletData.utxos) walletData.utxos = [] // Ensure utxos array exists
      // Optionally, check if walletData.network matches config.network
      if (walletData.network && walletData.network !== config.network) {
        this.warn(
          chalk.yellow(
            `Warning: Wallet file network (${walletData.network}) does not match config network (${config.network}). Syncing for ${config.network}.`,
          ),
        )
        // No need to error, just sync for the config's network. Wallet file network field is mostly informational.
      }

      const rpcCall = async <T>(endpoint: string, queryParams: string = ''): Promise<T> => {
        const url = `${blockbookBaseUrl.replace(/\/$/, '')}${endpoint}${queryParams}`
        this.log(chalk.dim(`API: ${url}`))
        const response = await fetch(url, { headers: { 'api-key': apiKey }, method: 'GET' })
        if (!response.ok) {
          const errorBody = await response.text()
          throw new Error(`API call to ${url} failed: ${response.status} ${response.statusText}. Body: ${errorBody}`)
        }

        return response.json() as Promise<T>
      }

      this.log(chalk.cyan(`Syncing info for address ${walletData.address} using transaction details...`))
      walletData.utxos = [] // Reset UTXOs
      let currentPage = 1
      let totalPages = 1 // Initialize to 1 to enter loop
      const newUtxos: DogeUTXO[] = []
      let firstPageAddressDetails: AddressDetailsWithTxsResponse | null = null // To store first page details

      do {
        this.log(
          chalk.dim(
            `Fetching address details page ${currentPage} of ${totalPages === 1 && currentPage === 1 ? '?' : totalPages
            }...`,
          ),
        )
        const queryParams = `?page=${currentPage}&pageSize=100&details=txs` // pageSize can be adjusted
        const currentAddressPageDetails = await rpcCall<AddressDetailsWithTxsResponse>(
          `/address/${walletData.address}`,
          queryParams,
        )

        if (currentPage === 1) {
          firstPageAddressDetails = currentAddressPageDetails // Store the first page response
        }

        totalPages = currentAddressPageDetails.totalPages

        if (currentAddressPageDetails.transactions && currentAddressPageDetails.transactions.length > 0) {
          for (const tx of currentAddressPageDetails.transactions) {
            for (const vout of tx.vout) {
              // Check if the output is unspent and belongs to our address
              const isOwnOutput = vout.addresses && vout.addresses.includes(walletData.address)
              // Blockbook might not always include `spent: false`. An output is unspent if `spent` is not true.
              const isUnspent = vout.spent !== true

              if (isOwnOutput && isUnspent) {
                if (!vout.hex || typeof vout.hex !== 'string' || vout.hex.length === 0) {
                  this.warn(
                    chalk.yellow(`UTXO candidate ${tx.txid}:${vout.n} is missing scriptPubKey (hex). Skipping.`),
                  )
                  continue
                }

                const satoshis = Number.parseInt(vout.value, 10)
                if (Number.isNaN(satoshis)) {
                  this.warn(
                    chalk.yellow(
                      `Invalid satoshi value for UTXO candidate ${tx.txid}:${vout.n}. Value: ${vout.value}. Skipping.`,
                    ),
                  )
                  continue
                }

                newUtxos.push({
                  satoshis,
                  script: vout.hex,
                  txid: tx.txid,
                  vout: vout.n,
                })
              }
            }
          }
        } else if (
          currentPage === 1 &&
          (!currentAddressPageDetails.transactions || currentAddressPageDetails.transactions.length === 0)
        ) {
          this.log(chalk.yellow('No transactions found for this address.'))
        }

        currentPage++
      } while (currentPage <= totalPages)

      walletData.utxos = newUtxos
      this.log(chalk.dim(`Found ${walletData.utxos.length} spendable UTXOs from address transaction details.`))

      // Balance calculation and saving remains largely the same
      const totalBalanceSatoshis = walletData.utxos.reduce((sum, utxo) => sum + utxo.satoshis, 0)
      fs.writeFileSync(resolvedWalletPath, JSON.stringify(walletData, null, 2))
      this.log(chalk.green(`\n✓ Wallet synced successfully on ${config.network} network`))
      this.log(`Address: ${chalk.cyan(walletData.address)}`)
      this.log(`UTXOs found: ${chalk.yellow(walletData.utxos.length)}`)
      this.log(`Total Balance from UTXOs: ${chalk.yellow(totalBalanceSatoshis / 1e8)} DOGE`)

      // Use unconfirmedBalance from the first page details we stored.
      // If firstPageAddressDetails is null (e.g. address has 0 txs), unconfirmedBalance will be from a fresh basic call.
      const unconfirmedSource =
        firstPageAddressDetails || (await rpcCall<AddressDetailsWithTxsResponse>(`/address/${walletData.address}`))
      const unconfirmedBalance = Number(unconfirmedSource.unconfirmedBalance)
      if (unconfirmedBalance && unconfirmedBalance !== 0) {
        this.log(`Unconfirmed Balance (API): ${chalk.yellow(unconfirmedBalance / 1e8)} DOGE`)
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      this.error(chalk.red(`Sync Error: ${error.message}`), { exit: 1 })
    }
  }
}
