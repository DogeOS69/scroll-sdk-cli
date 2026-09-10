import chalk from 'chalk'
import { Wallet } from 'ethers'
import fs from 'node:fs'

import { parseTomlConfig } from './config-parser.js'

export interface Utxo {
  confirmations: number
  txid: string
  value: string // Value in dogetoshis as a string
  vout: number
}

export interface Tx {
  confirmations?: number
  hex: string
}

type ElectrsUtxo = {
  status: {
    block_height?: number
    confirmed: boolean
  }
  txid: string
  value: number | string
  vout: number
}

type ElectrsTx = {
  status?: {
    block_height?: number
    confirmed: boolean
  }
}

const DEFAULT_TESTNET_ELECTRS_URL = 'https://doge-electrs-testnet-demo.qed.me'

/** Never fall back to a different network or a different operator endpoint. */
export function resolveElectrsUrl(configured: string | undefined, network: string): string {
  const endpoint = configured?.trim() || (network === 'testnet' ? DEFAULT_TESTNET_ELECTRS_URL : '')
  if (!endpoint) throw new Error(`An Electrs URL is required for ${network}; set --electrs-url or rpc.electrsAPIUrl.`)
  const parsed = new URL(endpoint)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Electrs URL must use http(s)')
  return endpoint.replace(/\/+$/, '')
}

async function requestElectrs(baseUrl: string, route: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${route}`, {...init, signal: AbortSignal.timeout(15_000)})
  if (!response.ok) throw new Error(`Electrs request failed: HTTP ${response.status}`)
  return response
}

async function getTipHeight(baseUrl: string): Promise<number | undefined> {
  try {
    const response = await requestElectrs(baseUrl, '/blocks/tip/height')
    const height = Number((await response.text()).trim())
    return Number.isSafeInteger(height) && height >= 0 ? height : undefined
  } catch {
    return undefined
  }
}

function confirmationsFor(status: ElectrsTx['status'], tip: number | undefined): number {
  if (!status?.confirmed) return 0
  if (status.block_height !== undefined && tip !== undefined) return Math.max(0, tip - status.block_height + 1)
  return 1
}

export const toString = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.trim()
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString()
  }

  return ''
}

export const loadToml = (filePath: string, label: string, warn: (msg: string) => void): Record<string, unknown> | undefined => {
  if (!fs.existsSync(filePath)) {
    warn(`${label} not found at ${filePath}`)
    return undefined
  }

  try {
    return parseTomlConfig(filePath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warn(`Failed to parse ${label}: ${reason}`)
    return undefined
  }
}

export const ensureHexKey = (value: string) => {
  if (!value) return value
  return value.startsWith('0x') ? value : `0x${value}`
}

export const deriveAddressFromKey = (privateKey: string, fallbackAddress: string, warn: (msg: string) => void): string => {
  if (privateKey) {
    try {
      return new Wallet(privateKey).address
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      warn(`Failed to derive L2 sender address from private key: ${reason}`)
    }
  }

  return fallbackAddress
}

export const loadJson = (filePath: string, label: string, warn: (msg: string) => void): Record<string, unknown> | undefined => {
  if (!fs.existsSync(filePath)) {
    warn(`${label} not found at ${filePath}`)
    return undefined
  }

  try {
    const contents = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(contents)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warn(`Failed to parse ${label}: ${reason}`)
    return undefined
  }
}

export const maskSensitive = (value: string) => {
  if (!value) return ''
  if (value.length <= 12) return value
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

/** Fetch unspent outputs from the configured Electrs/Esplora endpoint. */
export async function getUtxos(address: string, electrsUrl: string): Promise<Utxo[]> {
  const response = await requestElectrs(electrsUrl, `/address/${encodeURIComponent(address)}/utxo`)
  const utxos = await response.json() as ElectrsUtxo[]
  const tip = utxos.some(utxo => utxo.status.confirmed) ? await getTipHeight(electrsUrl) : undefined
  return utxos.map(utxo => {
    if (typeof utxo.value === 'number' && !Number.isSafeInteger(utxo.value)) throw new Error('Electrs returned an unsafe UTXO value')
    if (!/^\d+$/.test(String(utxo.value))) throw new Error('Electrs returned an invalid UTXO value')
    return {
      confirmations: confirmationsFor(utxo.status, tip),
      txid: utxo.txid,
      value: String(utxo.value),
      vout: utxo.vout,
    }
  })
}

/** Fetch transaction bytes and confirmation status using Electrs/Esplora. */
export async function getTx(txid: string, electrsUrl: string): Promise<Tx> {
  const route = `/tx/${encodeURIComponent(txid)}`
  const [transaction, raw] = await Promise.all([
    requestElectrs(electrsUrl, route), requestElectrs(electrsUrl, `${route}/hex`),
  ])
  const tx = await transaction.json() as ElectrsTx
  const tip = tx.status?.confirmed ? await getTipHeight(electrsUrl) : undefined
  return {confirmations: confirmationsFor(tx.status, tip), hex: (await raw.text()).trim()}
}

/** Broadcast only to the configured Electrs/Esplora endpoint. */
export async function broadcastTx(txHex: string, electrsUrl: string): Promise<{result: string}> {
  const response = await requestElectrs(electrsUrl, '/tx', {
    body: txHex, headers: {'Content-Type': 'text/plain'}, method: 'POST',
  })
  const txid = (await response.text()).trim()
  if (!txid) throw new Error('Electrs broadcast returned empty txid')
  return {result: txid}
}

export async function waitForConfirmations(
  txid: string,
  electrsUrl: string,
  log: (msg: string) => void,
  warn: (msg: string) => void,
  minConfirmations = 1,
  pollIntervalMs = 3000,
  timeoutMs = 10 * 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  log(chalk.gray(`-> Waiting for ${minConfirmations} confirmations for tx ${txid}...`))

  while (Date.now() <= deadline) {
    try {
      const tx = await getTx(txid, electrsUrl)
      const confirmations = tx.confirmations ?? 0
      if (confirmations >= minConfirmations) {
        log(chalk.green(`✅ Transaction ${txid} confirmed.`))
        return true
      }

      log(chalk.gray(`   Current: ${confirmations}/${minConfirmations}...`))
    } catch (error) {
      warn(`   ${chalk.yellow('⚠️ Failed to fetch confirmation status:')} ${(error as Error).message}`)
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollIntervalMs)
    })
  }

  log(chalk.red(`   Timeout reached waiting for confirmations for ${txid}.`))
  return false
}
