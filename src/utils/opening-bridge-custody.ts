/* eslint-disable @typescript-eslint/no-explicit-any -- Deployment TOML/JSON inputs are validated at runtime. */

import * as toml from '@iarna/toml'
import {Transaction} from 'bitcoinjs-lib'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'

/** One `[[opening_bridge_custody]]` entry of the Withdrawal Processor config. */
export interface OpeningBridgeCustodyEntry {
  tx_hex: string
  vout: number
}

export interface OpeningBridgeCustodyBinding {
  /** Genesis Bridge redeem script; every entry must pay its P2SH. */
  bridgeRedeemScriptHex: string
  genesisSequencerOutpoint: {txid: string; vout: number}
}

const hash160 = (bytes: Buffer): Buffer => createHash('ripemd160').update(createHash('sha256').update(bytes).digest()).digest()

/**
 * Check the opening WF's custody list the way the Withdrawal Processor does at
 * startup, as far as local bytes allow: every entry decodes, names an existing
 * output paying the genesis Bridge P2SH, is listed once and is not the genesis
 * sequencer outpoint. The Withdrawal Processor additionally requires each
 * source to be a Bridge funding (or WF) transaction rather than a deposit.
 */
export function validateOpeningBridgeCustody(value: unknown, binding: OpeningBridgeCustodyBinding): OpeningBridgeCustodyEntry[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('opening_bridge_custody must list at least one Bridge funding output')
  if (!/^(?:[\da-f]{2})+$/i.test(binding.bridgeRedeemScriptHex)) throw new Error('Bridge redeem script must be hexadecimal')
  const bridgeScript = `a914${hash160(Buffer.from(binding.bridgeRedeemScriptHex, 'hex')).toString('hex')}87`
  const sequencer = `${binding.genesisSequencerOutpoint.txid.toLowerCase()}:${binding.genesisSequencerOutpoint.vout}`
  const seen = new Set<string>()
  return value.map((entry: any, index) => {
    const label = `opening_bridge_custody[${index}]`
    const txHex = typeof entry?.tx_hex === 'string' ? entry.tx_hex.trim().toLowerCase().replace(/^0x/, '') : ''
    if (!/^(?:[\da-f]{2})+$/.test(txHex)) throw new Error(`${label}.tx_hex must be the raw funding transaction in hexadecimal`)
    if (!Number.isSafeInteger(entry.vout) || entry.vout < 0 || entry.vout > 0xFF_FF_FF_FF) throw new Error(`${label}.vout must be an output index`)
    let transaction: Transaction
    try {transaction = Transaction.fromHex(txHex)} catch {throw new Error(`${label}.tx_hex is not a valid Dogecoin transaction`)}
    const output = transaction.outs[entry.vout]
    const outpoint = `${transaction.getId()}:${entry.vout}`
    if (!output) throw new Error(`${label}: ${outpoint} has no such output`)
    if (Buffer.from(output.script).toString('hex') !== bridgeScript) throw new Error(`${label}: ${outpoint} does not pay the genesis Bridge script`)
    if (outpoint === sequencer || seen.has(outpoint)) throw new Error(`${label}: ${outpoint} is listed twice or is the genesis sequencer outpoint`)
    seen.add(outpoint)
    return {tx_hex: txHex, vout: entry.vout}
  })
}

export interface EnsureOpeningBridgeCustodyOptions {
  /** Bridge funding receipt written by staged preparation; used to backfill deployments prepared before the list existed. */
  bridgeFundingReceiptPath?: string
  bridgeJsonPath: string
  withdrawalProcessorOutputPath: string
}

/**
 * Resolve the opening custody list for Withdrawal Processor configuration.
 * The Bridge output manifest is the authority. A deployment prepared before
 * the list existed is backfilled once from its validated Bridge funding
 * receipt. Without either source the Withdrawal Processor would refuse to
 * start, so fail here with the remedy.
 */
export function ensureOpeningBridgeCustody(options: EnsureOpeningBridgeCustodyOptions): OpeningBridgeCustodyEntry[] {
  const manifest = toml.parse(fs.readFileSync(options.withdrawalProcessorOutputPath, 'utf8')) as any
  const bridge = JSON.parse(fs.readFileSync(options.bridgeJsonPath, 'utf8'))
  let recorded: unknown = manifest.opening_bridge_custody
  if (recorded === undefined && options.bridgeFundingReceiptPath && fs.existsSync(options.bridgeFundingReceiptPath)) {
    const receipt = JSON.parse(fs.readFileSync(options.bridgeFundingReceiptPath, 'utf8'))
    recorded = [{tx_hex: receipt.rawTransaction, vout: receipt.vout}]
  }

  if (recorded === undefined) {
    throw new Error(
      `${options.withdrawalProcessorOutputPath} lists no opening_bridge_custody. The Withdrawal Processor spends the marked Bridge funding `
      + 'output as the opening WF custody and refuses to start without it. Record the raw Bridge funding transaction and its Bridge output index '
      + 'as [[opening_bridge_custody]] (tx_hex, vout) in that file; a deposit-shaped seed output is not accepted.',
    )
  }

  const entries = validateOpeningBridgeCustody(recorded, {
    bridgeRedeemScriptHex: bridge.redeem_script_hex,
    genesisSequencerOutpoint: {txid: String(manifest.genesis_sequencer_txid).replace(/^0x/, ''), vout: Number(manifest.genesis_sequencer_vout)},
  })
  if (JSON.stringify(manifest.opening_bridge_custody) !== JSON.stringify(entries)) {
    manifest.opening_bridge_custody = entries
    fs.writeFileSync(options.withdrawalProcessorOutputPath, toml.stringify(manifest))
  }

  return entries
}
