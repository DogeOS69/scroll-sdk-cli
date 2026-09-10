/* eslint-disable @typescript-eslint/no-explicit-any -- Deployment TOML/JSON inputs are validated at runtime. */

import * as toml from '@iarna/toml'
import {Transaction} from 'bitcoinjs-lib'
import * as fs from 'node:fs'


export interface GenesisSequencerTransaction {
  txHex: string
  txid: string
  vout: number
}

interface DogecoinRpcResponse {
  error?: {code?: number; message?: string} | null
  result?: unknown
}

function normalizeTxid(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a 32-byte transaction id`)
  const normalized = value.trim().toLowerCase().replace(/^0x/, '')
  if (!/^[\da-f]{64}$/.test(normalized)) throw new Error(`${label} must be a 32-byte transaction id`)
  return normalized
}

function normalizeVout(value: unknown, label: string): number {
  const normalized = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(normalized) || Number(normalized) < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }

  return Number(normalized)
}

function normalizeTxHex(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be hexadecimal transaction bytes`)
  const normalized = value.trim().toLowerCase().replace(/^0x/, '')
  if (normalized.length === 0 || normalized.length % 2 !== 0 || !/^[\da-f]+$/.test(normalized)) {
    throw new Error(`${label} must be even-length hexadecimal transaction bytes`)
  }

  return normalized
}

/**
 * Parse the raw Dogecoin transaction locally and bind it to the canonical
 * genesis sequencer outpoint. This avoids trusting an RPC response merely
 * because it was returned for the requested txid.
 */
export function validateGenesisSequencerTransaction(
  txHexValue: unknown,
  txidValue: unknown,
  voutValue: unknown,
): GenesisSequencerTransaction {
  const txHex = normalizeTxHex(txHexValue, 'genesis_sequencer_tx_hex')
  const txid = normalizeTxid(txidValue, 'genesis_sequencer_txid')
  const vout = normalizeVout(voutValue, 'genesis_sequencer_vout')

  let transaction: Transaction
  try {
    transaction = Transaction.fromHex(txHex)
  } catch (error) {
    throw new Error(
      `genesis_sequencer_tx_hex is not a valid Dogecoin transaction: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const actualTxid = transaction.getId().toLowerCase()
  if (actualTxid !== txid) {
    throw new Error(`genesis_sequencer_tx_hex txid mismatch: expected ${txid}, decoded ${actualTxid}`)
  }

  if (vout >= transaction.outs.length) {
    throw new Error(
      `genesis_sequencer_vout ${vout} does not exist in genesis transaction ${txid} (${transaction.outs.length} outputs)`,
    )
  }

  return {txHex, txid, vout}
}

function readProtocolContextOutpoint(protocolContextPath: string): {txid: string; vout: number} | undefined {
  if (!fs.existsSync(protocolContextPath)) return undefined
  const protocolContext = JSON.parse(fs.readFileSync(protocolContextPath, 'utf8')) as any
  const outpoint = protocolContext?.genesis?.genesis_sequencer_outpoint
  if (!outpoint) throw new Error(`${protocolContextPath} missing genesis.genesis_sequencer_outpoint`)
  return {
    txid: normalizeTxid(outpoint.txid, `${protocolContextPath} genesis sequencer txid`),
    vout: normalizeVout(outpoint.vout, `${protocolContextPath} genesis sequencer vout`),
  }
}

async function fetchRawTransactionFromRpc(
  txid: string,
  setupDefaults: any,
): Promise<string> {
  const rpcUrl = typeof setupDefaults.dogecoin_rpc_url === 'string'
    ? setupDefaults.dogecoin_rpc_url.trim()
    : ''
  let rpcError: unknown

  if (rpcUrl) {
    const headers: Record<string, string> = {'content-type': 'application/json'}
    const rpcUser = setupDefaults.dogecoin_rpc_user
    const rpcPassword = setupDefaults.dogecoin_rpc_pass
    if (typeof rpcUser === 'string' && rpcUser && typeof rpcPassword === 'string' && rpcPassword) {
      headers.authorization = `Basic ${Buffer.from(`${rpcUser}:${rpcPassword}`).toString('base64')}`
    }

    try {
      const response = await fetch(rpcUrl, {
        body: JSON.stringify({
          id: 'scrollsdk-genesis-sequencer-transaction',
          jsonrpc: '1.0',
          method: 'getrawtransaction',
          params: [txid, false],
        }),
        headers,
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
      })
      const payload = await response.json() as DogecoinRpcResponse
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (payload.error) throw new Error(payload.error.message || `RPC error ${String(payload.error.code)}`)
      if (typeof payload.result !== 'string') throw new TypeError('getrawtransaction returned a non-string result')
      return payload.result
    } catch (error) {
      rpcError = error
    }
  }

  const rpcReason = rpcError instanceof Error ? rpcError.message : String(rpcError || 'RPC URL not configured')
  throw new Error(
    `could not obtain genesis sequencer transaction ${txid} from Dogecoin RPC (${rpcReason}); `
    + 'configure dogecoin_rpc_url in .data/setup_defaults.toml',
  )
}

export interface EnsureGenesisSequencerTransactionOptions {
  protocolContextPath?: string
  setupDefaultsPath: string
  withdrawalProcessorOutputPath: string
}

/**
 * Ensure the bridge-init output contains the raw genesis transaction required
 * by Withdrawal Processor witness materialization. Existing bytes are always
 * revalidated; legacy deployments are backfilled from Dogecoin RPC once and
 * then remain self-contained for later prep-charts runs.
 */
export async function ensureGenesisSequencerTransaction(
  options: EnsureGenesisSequencerTransactionOptions,
): Promise<GenesisSequencerTransaction> {
  if (!fs.existsSync(options.withdrawalProcessorOutputPath)) {
    throw new Error(`withdrawal processor bridge output not found: ${options.withdrawalProcessorOutputPath}`)
  }

  const source = fs.readFileSync(options.withdrawalProcessorOutputPath, 'utf8')
  const withdrawalOutput = toml.parse(source) as any
  const txid = normalizeTxid(
    withdrawalOutput.genesis_sequencer_txid,
    `${options.withdrawalProcessorOutputPath} genesis_sequencer_txid`,
  )
  const vout = normalizeVout(
    withdrawalOutput.genesis_sequencer_vout,
    `${options.withdrawalProcessorOutputPath} genesis_sequencer_vout`,
  )

  if (options.protocolContextPath) {
    const protocolOutpoint = readProtocolContextOutpoint(options.protocolContextPath)
    if (protocolOutpoint && (protocolOutpoint.txid !== txid || protocolOutpoint.vout !== vout)) {
      throw new Error(
        `genesis sequencer outpoint mismatch between ${options.withdrawalProcessorOutputPath} `
        + `(${txid}:${vout}) and ${options.protocolContextPath} (${protocolOutpoint.txid}:${protocolOutpoint.vout})`,
      )
    }
  }

  let txHex = withdrawalOutput.genesis_sequencer_tx_hex
  if (typeof txHex !== 'string' || txHex.trim() === '') {
    if (!fs.existsSync(options.setupDefaultsPath)) {
      throw new Error(`setup defaults not found while resolving genesis transaction: ${options.setupDefaultsPath}`)
    }

    const setupDefaults = toml.parse(fs.readFileSync(options.setupDefaultsPath, 'utf8')) as any
    txHex = await fetchRawTransactionFromRpc(txid, setupDefaults)
  }

  const validated = validateGenesisSequencerTransaction(txHex, txid, vout)
  if (withdrawalOutput.genesis_sequencer_tx_hex !== validated.txHex) {
    withdrawalOutput.genesis_sequencer_tx_hex = validated.txHex
    fs.writeFileSync(options.withdrawalProcessorOutputPath, toml.stringify(withdrawalOutput))
  }

  return validated
}
