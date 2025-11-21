import fs from 'node:fs'
import { Wallet } from 'ethers'
import { parseTomlConfig } from './config-parser.js'
import chalk from 'chalk'

export interface Utxo {
  txid: string
  vout: number
  value: string // Value in dogetoshis as a string
  confirmations: number
}

export interface Tx {
  hex: string
  confirmations?: number
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

/**
 * Fetches UTXOs for a given address from a blockbook API.
 * @param address The Dogecoin address.
 * @param blockbookUrl The base URL of the blockbook API.
 * @returns A promise that resolves to an array of UTXOs.
 */
export async function getUtxos(address: string, blockbookUrl: string): Promise<Utxo[]> {
  const response = await fetch(`${blockbookUrl}/api/v2/utxo/${address}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch UTXOs: ${response.statusText}`)
  }
  return response.json()
}

/**
 * Fetches the raw transaction hex for a given transaction ID.
 * @param txid The transaction ID.
 * @param blockbookUrl The base URL of the blockbook API.
 * @returns A promise that resolves to the transaction object containing the hex.
 */
export async function getTx(txid: string, blockbookUrl: string): Promise<Tx> {
  const response = await fetch(`${blockbookUrl}/api/v2/tx/${txid}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch transaction: ${response.statusText}`)
  }
  return response.json()
}

/**
 * Broadcasts a raw transaction to the network via a blockbook API.
 * @param txHex The raw transaction hex string.
 * @param blockbookUrl The base URL of the blockbook API.
 * @returns A promise that resolves to the broadcast result, typically containing the txid.
 */
export async function broadcastTx(txHex: string, blockbookUrl: string): Promise<{ result: string }> {
  const response = await fetch(`${blockbookUrl}/api/v2/sendtx/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
    },
    body: txHex,
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Failed to broadcast transaction: ${response.statusText} - ${errorBody}`)
  }

  return response.json()
}

export async function waitForConfirmations(
  txid: string,
  blockbookUrl: string,
  log: (msg: string) => void,
  warn: (msg: string) => void,
  minConfirmations = 1,
  pollIntervalMs = 30_000,
  timeoutMs = 10 * 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  log(chalk.gray(`-> Waiting for ${minConfirmations} confirmations for tx ${txid}...`))

  while (Date.now() <= deadline) {
    try {
      const tx = await getTx(txid, blockbookUrl)
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
