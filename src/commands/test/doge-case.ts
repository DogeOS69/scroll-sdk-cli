import {Args, Command, Flags} from '@oclif/core'
import bitcore from 'bitcore-lib-doge'
import chalk from 'chalk'
import yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

import {dogecoinMainnet, dogecoinTestnet} from '../../types/dogecoin.js'

interface BlockbookUtxo {
  confirmations?: number
  height?: number
  scriptPubKey?: string
  txid: string
  value: string
  vout: number
}

type BitcoreUtxo = InstanceType<typeof bitcore.Transaction.UnspentOutput>

interface OutputSpec {
  address?: string
  data?: Buffer
  type: 'opreturn' | 'p2pkh'
  value?: number
}

type ExtendedTransaction = {
  fromString(serialized: string): bitcore.Transaction
  getFee(): number
  isFullySigned(): boolean
  outputs: Array<{script: {toHex(): string}}>
  toBuffer(): Buffer
} & bitcore.Transaction

const DEFAULT_FEE_RATE_PER_KB = 1000 // dogetoshis per kilobyte
const BRIDGE_AMOUNT = 2 * 100_000_000 // 2 DOGE
const DUST_LIMIT = 1 // 0.01 DOGE worth of dogetoshis, matching reference file intention
const L1_INTERFACE_VALUES_FILE = 'values/l1-interface-production.yaml'
const BITCORE_MAINNET = ensureBitcoreNetwork('dogecoin-mainnet', 'doge-mainnet', dogecoinMainnet)
const BITCORE_TESTNET = ensureBitcoreNetwork('dogecoin-testnet', 'doge-testnet', dogecoinTestnet)
const defaultBridgeAddress = getDefaultBridgeAddress()

export default class TestDogeCase extends Command {
  static override args = {
    caseName: Args.string({
      description: 'Scenario to execute',
      options: ['multiple-opreturn', 'multiple-output'],
      required: true,
    }),
  }

  static override description = 'Synthetic Dogecoin cases to stress specific bridge behaviors'

  static override examples = [
    '$ scrollsdk test:doge-case multiple-opreturn',
    '$ scrollsdk test:doge-case multiple-output --outputcount=2048 --outputvalue=5000000',
  ]

  static override flags = {
    agentwif: Flags.string({
      char: 'a',
      default: 'ciCWUwnkp21uK3Mm12UcGT27HNXCMFa6U1kFogJjsp9W51BVRgnX',
      description: 'Agent WIF key that funds and signs the transaction',
    }),
    blockbookurl: Flags.string({
      char: 'b',
      default: 'https://blockbook.qiaoxiaorui.org',
      description: 'Base Blockbook URL (the command appends /api/v2 automatically if missing)',
    }),
    bridge: Flags.string({
      char: 'r',
      default: defaultBridgeAddress,
      description: 'Bridge P2PKH/P2SH address used for the P2PKH outputs',
    }),
    broadcast: Flags.boolean({
      allowNo: true,
      default: true,
      description: 'Broadcast the transaction after signing (disable to print the raw hex only)',
    }),
    masterwifl: Flags.string({
      char: 'm',
      default: 'ciCWUwnkp21uK3Mm12UcGT27HNXCMFa6U1kFogJjsp9W51BVRgnX',
      description: 'Master WIF key (currently informational, kept for compatibility with the reference tool)',
    }),
    network: Flags.string({
      char: 'n',
      default: 'testnet',
      description: 'Network to use for decoding the provided WIF keys',
      options: ['mainnet', 'testnet'],
    }),
    outputcount: Flags.integer({
      char: 'c',
      default: 1024,
      description: 'Number of additional P2PKH outputs for the multiple-output scenario',
    }),
    outputvalue: Flags.string({
      char: 'v',
      default: '1000000',
      description: 'Value per additional P2PKH output (dogetoshis) for the multiple-output scenario',
    }),
  }

  public async run(): Promise<void> {
    const {args} = await this.parse(TestDogeCase)

    this.log(chalk.cyan(`Running Dogecoin test case: ${args.caseName}`))

    if (args.caseName === 'multiple-opreturn') {
      await this.runMultipleOpReturnScenario()
      return
    }

    if (args.caseName === 'multiple-output') {
      await this.runMultipleOutputScenario()
      return
    }

    this.error(`Unsupported case "${args.caseName}"`)
  }

  private async broadcastTransaction(rawTx: string, baseUrl: string): Promise<string> {
    const apiBase = this.normalizeBlockbookBase(baseUrl)
    const response = await fetch(`${apiBase}/sendtx/`, {
      body: rawTx,
      headers: {'Content-Type': 'text/plain'},
      method: 'POST',
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Broadcast failed: ${response.status} ${response.statusText}. Body: ${body}`)
    }

    const payload = (await response.json()) as {result?: string; txid?: string}
    const txid = payload.result ?? payload.txid
    if (!txid) {
      throw new Error(`Unexpected response from Blockbook sendtx: ${JSON.stringify(payload)}`)
    }

    return txid
  }

  private async buildAndProcessTransaction(outputs: OutputSpec[]): Promise<void> {
    const {flags} = await this.parse(TestDogeCase)
    const network = flags.network === 'mainnet' ? BITCORE_MAINNET : BITCORE_TESTNET

    const agentKey = new bitcore.PrivateKey(flags.agentwif, network)
    const agentKeyNetworkName = (agentKey as unknown as {network?: {name?: string}}).network?.name
    const targetNetworkName = (network as {name?: string} | undefined)?.name
    if (agentKeyNetworkName && targetNetworkName && agentKeyNetworkName !== targetNetworkName) {
      this.error(
        `Agent key network (${agentKeyNetworkName}) does not match requested network (${targetNetworkName}). Provide a matching WIF.`,
      )
    }

    const agentAddress = agentKey.toAddress().toString()

    const utxos = await this.fetchSpendableUtxos(agentAddress, flags.blockbookurl)
    if (utxos.length === 0) {
      this.error(`No spendable UTXOs found for ${agentAddress}. Fund the wallet first.`)
    }

    this.log(chalk.gray(`Using ${utxos.length} UTXO(s) from ${agentAddress}`))

    const tx = new bitcore.Transaction() as ExtendedTransaction
    tx.from(utxos)
    tx.feePerKb(DEFAULT_FEE_RATE_PER_KB)
    tx.change(agentAddress)

    for (const output of outputs) {
      if (output.type === 'p2pkh') {
        if (!output.address || typeof output.value !== 'number') {
          this.error('Invalid P2PKH output specification encountered.')
        }

        tx.to(output.address, output.value)
      } else if (output.type === 'opreturn') {
        if (!output.data) this.error('OP_RETURN output missing data payload.')
        tx.addData(output.data)
      }
    }

    tx.sign(agentKey)

    if (!tx.isFullySigned()) {
      this.error('Transaction is not fully signed. Ensure the provided WIF matches the funding UTXOs.')
    }

    const fee = tx.getFee()
    this.log(chalk.gray(`Estimated fee: ${fee} dogetoshis (${fee / 1e8} DOGE)`))
    this.log(chalk.gray(`Serialized size: ${tx.toBuffer().length} bytes`))

    if (!flags.broadcast) {
      this.log(chalk.yellow('\nBroadcast disabled (--no-broadcast). Raw transaction:'))
      this.log(tx.serialize())
      return
    }

    const txid = await this.broadcastTransaction(tx.serialize(), flags.blockbookurl)
    this.log(chalk.green(`Broadcast complete! TxID: ${txid}`))
  }

  private async fetchSpendableUtxos(address: string, baseUrl: string): Promise<BitcoreUtxo[]> {
    const apiBase = this.normalizeBlockbookBase(baseUrl)
    const response = await fetch(`${apiBase}/utxo/${encodeURIComponent(address)}?confirmed=true`)

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to fetch UTXOs: ${response.status} ${response.statusText}. Body: ${body}`)
    }

    const rawUtxos = (await response.json()) as BlockbookUtxo[]
    const normalized: BitcoreUtxo[] = []

    const enriched = await Promise.all(
      rawUtxos.map(async (utxo) => {
        const script = utxo.scriptPubKey ?? (await this.lookupOutputScript(utxo.txid, utxo.vout, apiBase))
        return {script, utxo}
      }),
    )

    for (const {script, utxo} of enriched) {
      const satoshis = Number(utxo.value)
      if (!Number.isFinite(satoshis) || satoshis <= 0) continue

      if (!script) {
        this.warn(`Skipping UTXO ${utxo.txid}:${utxo.vout} due to missing script.`)
        continue
      }

      normalized.push(
        new bitcore.Transaction.UnspentOutput({
          address,
          outputIndex: utxo.vout,
          satoshis,
          script,
          txId: utxo.txid,
        }),
      )
    }

    return normalized
  }

  private async lookupOutputScript(txid: string, vout: number, apiBase: string): Promise<string> {
    const response = await fetch(`${apiBase}/tx/${txid}`)
    if (!response.ok) {
      this.warn(`Failed to fetch tx ${txid} for script lookup: ${response.status} ${response.statusText}`)
      return ''
    }

    const payload = (await response.json()) as {hex?: string}
    if (!payload.hex) {
      this.warn(`Transaction ${txid} did not include hex in response.`)
      return ''
    }

    const tx = new bitcore.Transaction() as ExtendedTransaction
    tx.fromString(payload.hex)
    const {outputs} = tx
    const output = outputs[vout]
    if (!output) return ''
    return output.script.toHex()
  }

  private normalizeBlockbookBase(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, '')
    if (trimmed.endsWith('/api/v2')) return trimmed
    if (trimmed.endsWith('/api')) return `${trimmed}/v2`
    return `${trimmed}/api/v2`
  }

  private async runMultipleOpReturnScenario(): Promise<void> {
    const {flags} = await this.parse(TestDogeCase)

    const outputs: OutputSpec[] = [
      {address: flags.bridge, type: 'p2pkh', value: BRIDGE_AMOUNT},
      {data: Buffer.from('00d98f41da0f5b229729ed7bf469ea55d98d11f467', 'hex'), type: 'opreturn'},
      {data: Buffer.from('002eaf5e9022f7c99937ecba7925f1baa9d1bf75b2', 'hex'), type: 'opreturn'},
    ]

    await this.buildAndProcessTransaction(outputs)
  }

  private async runMultipleOutputScenario(): Promise<void> {
    const {flags} = await this.parse(TestDogeCase)

    if (!Number.isSafeInteger(flags.outputcount) || flags.outputcount <= 0) {
      this.error('outputcount must be a positive safe integer.')
    }

    const sanitized = (flags.outputvalue ?? '').replaceAll('_', '')
    if (!/^\d+$/.test(sanitized)) {
      this.error('outputvalue must be a numeric string representing dogetoshis.')
    }

    const perOutput = Number(sanitized)
    if (!Number.isSafeInteger(perOutput) || perOutput < DUST_LIMIT) {
      this.error(`outputvalue must be >= ${DUST_LIMIT} dogetoshis to avoid dust outputs.`)
    }

    const outputs: OutputSpec[] = [
      {data: Buffer.from('00d98f41da0f5b229729ed7bf469ea55d98d11f467', 'hex'), type: 'opreturn'},
      {address: flags.bridge, type: 'p2pkh', value: 100_000_000},
    ]

    for (let i = 0; i < flags.outputcount; i += 1) {
      outputs.push({address: flags.bridge, type: 'p2pkh', value: perOutput})
    }

    await this.buildAndProcessTransaction(outputs)
  }
}

function getDefaultBridgeAddress(): string {
  /*
values/l1-interface-production.yaml
configMaps:
  env:
    enabled: true
    data:
      DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__BRIDGE_ADDRESS: 2NFhzWC5hz1oxeVk8XK5riLGiwGJ2HkntUy
  */
  try {
    const absolutePath = path.resolve(L1_INTERFACE_VALUES_FILE)
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`${L1_INTERFACE_VALUES_FILE} not found`)
    }

    const contents = fs.readFileSync(absolutePath, 'utf8')
    const parsed = yaml.load(contents) as {
      configMaps?: {
        env?: {
          data?: Record<string, unknown>
        }
      }
    }

    const data = parsed?.configMaps?.env?.data
    const candidate =
      typeof data?.DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__BRIDGE_ADDRESS === 'string'
        ? data.DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__BRIDGE_ADDRESS.trim()
        : undefined

    if (!candidate) {
      throw new Error('DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__BRIDGE_ADDRESS missing or empty in configMaps.env.data')
    }

    return candidate
  } catch (error) {
    throw new Error(
      `Failed to determine default bridge address from ${L1_INTERFACE_VALUES_FILE}: ${
        error instanceof Error ? error.message : error
      }`,
    )
  }
}

type BitcoreNetworksExtended = {
  add(definition: {
    alias: string
    bip32: {private: number; public: number}
    name: string
    networkMagic?: number
    port?: number
    privatekey: number
    pubkeyhash: number
    scripthash: number
    xprivkey: number
    xpubkey: number
  }): typeof bitcore.Networks.livenet
  get(name: string): typeof bitcore.Networks.livenet | undefined
} & typeof bitcore.Networks

function ensureBitcoreNetwork(
  name: string,
  alias: string,
  params: typeof dogecoinMainnet,
): typeof bitcore.Networks.livenet {
  const networks = bitcore.Networks as BitcoreNetworksExtended
  const existing = networks.get(name)
  if (existing) return existing

  return networks.add({
    alias,
    bip32: {
      private: params.bip32.private,
      public: params.bip32.public,
    },
    name,
    privatekey: params.wif,
    pubkeyhash: params.pubKeyHash,
    scripthash: params.scriptHash,
    xprivkey: params.bip32.private,
    xpubkey: params.bip32.public,
  })
}
