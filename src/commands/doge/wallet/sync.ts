import {Command, Flags} from '@oclif/core'
import * as bitcoin from 'bitcoinjs-lib'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import type {DogeUTXO, DogeWallet} from '../../../types/doge-config.js'

import {dogecoinMainnet, dogecoinTestnet} from '../../../types/dogecoin.js'
import {loadDogeConfigWithSelection} from '../../../utils/doge-config.js'
import {getTx, getUtxos, resolveElectrsUrl} from '../../../utils/dogeos-utils.js'

/** Build a complete replacement only after every unspent output has been validated. */
export async function fetchWalletUtxos(wallet: DogeWallet, network: string, electrsUrl: string): Promise<DogeUTXO[]> {
  const expectedScript = bitcoin.address.toOutputScript(wallet.address, network === 'mainnet' ? dogecoinMainnet : dogecoinTestnet)
  const utxos = await getUtxos(wallet.address, electrsUrl)
  const transactions = new Map<string, bitcoin.Transaction>()
  const result: DogeUTXO[] = []
  for (const utxo of utxos) {
    let transaction = transactions.get(utxo.txid)
    if (!transaction) {
      transaction = bitcoin.Transaction.fromHex((await getTx(utxo.txid, electrsUrl)).hex)
      if (transaction.getId() !== utxo.txid) throw new Error('Electrs transaction bytes do not match the requested txid')
      transactions.set(utxo.txid, transaction)
    }

    const output = transaction.outs[utxo.vout]
    if (!output || !Buffer.from(output.script).equals(Buffer.from(expectedScript)) || BigInt(output.value) !== BigInt(utxo.value)) {
      throw new Error(`Electrs UTXO ${utxo.txid}:${utxo.vout} does not match the wallet's transaction output`)
    }

    const satoshis = Number(utxo.value)
    if (!Number.isSafeInteger(satoshis)) throw new Error('UTXO value exceeds wallet numeric precision')
    result.push({satoshis, script: Buffer.from(output.script).toString('hex'), txid: utxo.txid, vout: utxo.vout})
  }

  return result
}

export default class WalletSync extends Command {
  static description = 'Sync wallet UTXOs and balance using Electrs/Esplora'

  static examples = ['<%= config.bin %> <%= command.id %> --config .data/doge-config.toml --electrs-url http://localhost:3002']

  static flags = {
    config: Flags.string({char: 'c', description: 'Path to Dogecoin config file'}),
    'electrs-url': Flags.string({description: 'Electrs/Esplora URL; defaults to rpc.electrsAPIUrl or the testnet Electrs endpoint'}),
    path: Flags.string({char: 'p', description: 'Wallet file path (overrides wallet.path in config)'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(WalletSync)
    try {
      const {config} = await loadDogeConfigWithSelection(flags.config, 'scrollsdk setup doge-config')
      const electrsUrl = resolveElectrsUrl(flags['electrs-url'] || config.rpc?.electrsAPIUrl, config.network)
      const walletPath = flags.path || config.wallet?.path
      if (!walletPath) throw new Error('Set --path or wallet.path before synchronizing')
      const resolvedPath = path.resolve(walletPath)
      if (!fs.existsSync(resolvedPath)) throw new Error(`Wallet file not found: ${resolvedPath}. Run doge wallet new first.`)
      const wallet: DogeWallet = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
      if (wallet.network && wallet.network !== config.network) throw new Error('Wallet and config networks do not match')
      const utxos = await fetchWalletUtxos(wallet, config.network, electrsUrl)
      const balance = utxos.reduce((total, utxo) => total + BigInt(utxo.satoshis), 0n)
      fs.writeFileSync(resolvedPath, JSON.stringify({...wallet, utxos}, null, 2))
      this.log(chalk.green(`Wallet synced on ${config.network}: ${utxos.length} UTXOs`))
      this.log(`Address: ${wallet.address}`)
      this.log(`Balance: ${balance / 100_000_000n}.${(balance % 100_000_000n).toString().padStart(8, '0')} DOGE`)
    } catch (error) {
      this.error(`Sync failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
