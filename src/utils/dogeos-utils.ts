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

type ElectrsUtxo = {
  txid: string
  vout: number
  value: number | string
  status: {
    confirmed: boolean
    block_height?: number
  }
}

type ElectrsTx = {
  status?: {
    confirmed: boolean
    block_height?: number
  }
}

const ELECTRS_FALLBACK_BASE = 'https://doge-electrs-testnet-demo.qed.me'

const normalizeBaseUrl = (url: string) => (url || '').replace(/\/+$/, '')

const resolveBaseUrls = (blockbookUrl: string): string[] => {
  const primary = normalizeBaseUrl(blockbookUrl)
  const electrsBase = ELECTRS_FALLBACK_BASE
  const isElectrsHost = primary.includes('doge-electrs-testnet-demo.qed.me')

  if (isElectrsHost) {
    return [electrsBase]
  }

  // Prefer electrs first, then optional blockbook primary as fallback.
  const bases = [electrsBase, primary].filter(Boolean)
  return Array.from(new Set(bases))
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
  const bases = resolveBaseUrls(blockbookUrl)
  const errors: string[] = []

  for (const baseUrl of bases) {
    const isElectrsOnly = baseUrl.includes('doge-electrs-testnet-demo.qed.me')
    let lastError: unknown

    // Try Blockbook first (skip for electrs-only base)
    if (!isElectrsOnly) {
      try {
        const response = await fetch(`${baseUrl}/api/v2/utxo/${address}`)
        if (!response.ok) {
          throw new Error(`Blockbook request failed: ${response.status} ${response.statusText}`)
        }
        return response.json()
      } catch (error) {
        lastError = error
      }
    }

    // Fallback to Electrs/Esplora-style API
    try {
      const utxoRes = await fetch(`${baseUrl}/address/${address}/utxo`)
      if (!utxoRes.ok) {
        throw new Error(`Electrs request failed: ${utxoRes.status} ${utxoRes.statusText}`)
      }
      const electrsUtxos: ElectrsUtxo[] = await utxoRes.json()

      let tipHeight = 0
      const needsTipHeight = electrsUtxos.some((u) => u.status.confirmed && Number.isFinite(u.status.block_height))
      if (needsTipHeight) {
        try {
          const tipRes = await fetch(`${baseUrl}/blocks/tip/height`)
          if (tipRes.ok) {
            const text = await tipRes.text()
            const parsed = Number.parseInt(text, 10)
            if (Number.isFinite(parsed)) {
              tipHeight = parsed
            }
          }
        } catch {
          // ignore tip height fetch errors; we fall back to minimum confirmations
        }
      }

      return electrsUtxos.map((u) => {
        const valueStr = typeof u.value === 'string' ? u.value : BigInt(u.value).toString()
        const height = u.status.block_height
        let confirmations = 0
        if (u.status.confirmed) {
          confirmations = height && tipHeight ? Math.max(0, tipHeight - height + 1) : 1
        }
        return {
          txid: u.txid,
          vout: u.vout,
          value: valueStr,
          confirmations,
        }
      })
    } catch (error) {
      const reason =
        lastError instanceof Error
          ? `Last blockbook error: ${lastError.message}`
          : `Last blockbook error: ${String(lastError)}`
      const electrsMsg = error instanceof Error ? error.message : String(error)
      errors.push(`[base ${baseUrl}] ${reason}. Electrs error: ${electrsMsg}`)
    }
  }

  throw new Error(`Failed to fetch UTXOs from all configured endpoints. ${errors.join(' | ')}`)
}

/**
 * Fetches the raw transaction hex for a given transaction ID.
 * @param txid The transaction ID.
 * @param blockbookUrl The base URL of the blockbook API.
 * @returns A promise that resolves to the transaction object containing the hex.
 */
export async function getTx(txid: string, blockbookUrl: string): Promise<Tx> {
  const bases = resolveBaseUrls(blockbookUrl)
  const errors: string[] = []

  for (const baseUrl of bases) {
    const isElectrsOnly = baseUrl.includes('doge-electrs-testnet-demo.qed.me')
    let lastError: unknown

    // Try Blockbook first (skip for electrs-only base)
    if (!isElectrsOnly) {
      try {
        const response = await fetch(`${baseUrl}/api/v2/tx/${txid}`)
        if (!response.ok) {
          throw new Error(`Blockbook request failed: ${response.status} ${response.statusText}`)
        }
        return response.json()
      } catch (error) {
        lastError = error
      }
    }

    // Fallback to Electrs/Esplora
    try {
      const [txRes, hexRes] = await Promise.all([
        fetch(`${baseUrl}/tx/${txid}`),
        fetch(`${baseUrl}/tx/${txid}/hex`),
      ])

      if (!txRes.ok) {
        throw new Error(`Electrs tx request failed: ${txRes.status} ${txRes.statusText}`)
      }
      if (!hexRes.ok) {
        throw new Error(`Electrs hex request failed: ${hexRes.status} ${hexRes.statusText}`)
      }

      const tx: ElectrsTx = await txRes.json()
      const hex = await hexRes.text()

      let confirmations = 0
      const height = tx.status?.block_height
      if (tx.status?.confirmed) {
        confirmations = 1
        if (height && Number.isFinite(height)) {
          try {
            const tipRes = await fetch(`${baseUrl}/blocks/tip/height`)
            if (tipRes.ok) {
              const tipText = await tipRes.text()
              const tipHeight = Number.parseInt(tipText, 10)
              if (Number.isFinite(tipHeight)) {
                confirmations = Math.max(1, tipHeight - Number(height) + 1)
              }
            }
          } catch {
            // ignore tip fetch errors; fall back to minimum confirmation
          }
        }
      }

      return { hex, confirmations }
    } catch (error) {
      const reason =
        lastError instanceof Error
          ? `Last blockbook error: ${lastError.message}`
          : `Last blockbook error: ${String(lastError)}`
      const electrsMsg = error instanceof Error ? error.message : String(error)
      errors.push(`[base ${baseUrl}] ${reason}. Electrs error: ${electrsMsg}`)
    }
  }

  throw new Error(`Failed to fetch transaction from all configured endpoints. ${errors.join(' | ')}`)
}

/**
 * Broadcasts a raw transaction to the network via a blockbook API.
 * @param txHex The raw transaction hex string.
 * @param blockbookUrl The base URL of the blockbook API.
 * @returns A promise that resolves to the broadcast result, typically containing the txid.
 */
export async function broadcastTx(txHex: string, blockbookUrl: string): Promise<{ result: string }> {
  const bases = resolveBaseUrls(blockbookUrl)
  const errors: string[] = []

  for (const baseUrl of bases) {
    const isElectrsOnly = baseUrl.includes('doge-electrs-testnet-demo.qed.me')
    let lastError: unknown

    // Try Blockbook first (skip for electrs-only base)
    if (!isElectrsOnly) {
      try {
        const response = await fetch(`${baseUrl}/api/v2/sendtx/`, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain',
          },
          body: txHex,
        })

        if (!response.ok) {
          const errorBody = await response.text()
          throw new Error(`Blockbook broadcast failed: ${response.status} ${response.statusText} - ${errorBody}`)
        }

        return response.json()
      } catch (error) {
        lastError = error
      }
    }

    // Fallback to Electrs/Esplora
    try {
      const response = await fetch(`${baseUrl}/tx`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
        },
        body: txHex,
      })

      if (!response.ok) {
        const errorBody = await response.text()
        throw new Error(`Electrs broadcast failed: ${response.status} ${response.statusText} - ${errorBody}`)
      }

      const txid = (await response.text()).trim()
      if (!txid) {
        throw new Error('Electrs broadcast returned empty txid')
      }
      return { result: txid }
    } catch (error) {
      const reason =
        lastError instanceof Error
          ? `Last blockbook error: ${lastError.message}`
          : `Last blockbook error: ${String(lastError)}`
      const electrsMsg = error instanceof Error ? error.message : String(error)
      errors.push(`[base ${baseUrl}] ${reason}. Electrs error: ${electrsMsg}`)
    }
  }

  throw new Error(`Failed to broadcast transaction via all configured endpoints. ${errors.join(' | ')}`)
}

export async function waitForConfirmations(
  txid: string,
  blockbookUrl: string,
  log: (msg: string) => void,
  warn: (msg: string) => void,
  minConfirmations = 1,
  pollIntervalMs = 3_000,
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
