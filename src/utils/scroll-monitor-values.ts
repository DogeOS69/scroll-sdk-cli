/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values are dynamic YAML mappings. */
import type {DogeConfig} from '../types/doge-config.js'

import {getRequiredManagedSignerAddress} from './signer-roles.js'

interface MonitorChange {
  key: string
  newValue: string
  oldValue: string
}

interface MonitorInputs {
  dogeConfig: Pick<DogeConfig, 'accounts' | 'ethereumDa' | 'signers'>
  l2ChainId: unknown
  l2RpcUrl: unknown
}

function mapping(value: any, label: string): Record<string, any> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a YAML mapping`)
  }

  return value
}

function chainId(value: unknown, label: string): string {
  const text = String(value ?? '').trim()
  if ((typeof value === 'number' && !Number.isSafeInteger(value))
    || !/^(?:\d+|0x[\dA-Fa-f]+)$/.test(text) || BigInt(text) <= 0n) {
    throw new Error(`${label} must be a positive decimal or hexadecimal chain ID for scroll-monitor`)
  }

  return BigInt(text).toString()
}

function rpcUrl(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  try {
    const parsed = new URL(text)
    if (['http:', 'https:'].includes(parsed.protocol) && !text.includes('<TODO>')) return text
  } catch {
    // Report the config key without exposing credentials embedded in a URL.
  }

  throw new Error(`${label} must be an HTTP(S) RPC URL for scroll-monitor`)
}

/** Reconcile public service identities; retain operator thresholds and Secret-owned RPC URLs. */
export function reconcileScrollMonitorBalances(values: any, inputs: MonitorInputs): MonitorChange[] {
  const current = mapping(values.balanceMonitoring, 'balanceMonitoring')
  if (current.enabled === false) return []

  // Validate and build on a copy so a bad second account cannot leave a partial update.
  const balance = structuredClone(current)
  balance.exporter = mapping(balance.exporter, 'balanceMonitoring.exporter')
  balance.feeWallet = mapping(balance.feeWallet, 'balanceMonitoring.feeWallet')
  balance.ethereum = mapping(balance.ethereum, 'balanceMonitoring.ethereum')
  const changes: MonitorChange[] = []
  const set = (target: Record<string, any>, key: string, value: unknown, prefix: string) => {
    if (target[key] === value) return
    changes.push({
      key: `balanceMonitoring.${prefix}${key}`,
      newValue: key === 'rpcUrl' ? '[redacted]' : String(value),
      oldValue: key === 'rpcUrl' ? '[redacted]' : String(target[key]),
    })
    target[key] = value
  }

  const threshold = (target: Record<string, any>, key: string, fallback: number, prefix: string) => {
    const value = target[key]
    if (value === undefined || value === null || value === '' || value === '<TODO>') {
      set(target, key, fallback, prefix)
    } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`balanceMonitoring.${prefix}${key} must be a nonnegative number`)
    }
  }

  set(balance, 'enabled', true, '')
  if (balance.exporter.enabled === undefined) set(balance.exporter, 'enabled', true, 'exporter.')
  if (balance.feeWallet.enabled === undefined) set(balance.feeWallet, 'enabled', true, 'feeWallet.')
  threshold(balance.feeWallet, 'minimumDoge', 100, 'feeWallet.')

  for (const [account, minimumEth] of [['feeOracle', 5], ['ethDaSubmitter', 0.1]] as const) {
    const prefix = `ethereum.${account}.`
    const target = mapping(balance.ethereum[account], `balanceMonitoring.ethereum.${account}`)
    balance.ethereum[account] = target
    threshold(target, 'minimumEth', minimumEth, prefix)

    // External exporters own their connection settings and supply the same metrics.
    if (balance.exporter.enabled === false) continue

    const feeOracle = account === 'feeOracle'
    const address = getRequiredManagedSignerAddress(
      inputs.dogeConfig, feeOracle ? 'l2GasOracleSender' : 'l1CommitSender',
    )
    const expectedChainId = chainId(
      feeOracle ? inputs.l2ChainId : inputs.dogeConfig.ethereumDa?.chainId,
      feeOracle ? 'general.CHAIN_ID_L2' : 'ethereumDa.chainId',
    )
    set(target, 'address', address, prefix)
    set(target, 'expectedChainId', expectedChainId, prefix)

    // An explicit empty URL delegates this field to an existing Kubernetes Secret.
    const secretOwnsRpc = typeof balance.exporter.envFromSecret === 'string'
      && balance.exporter.envFromSecret.trim() !== '' && target.rpcUrl === ''
    if (!secretOwnsRpc) {
      set(target, 'rpcUrl', rpcUrl(
        feeOracle ? inputs.l2RpcUrl : inputs.dogeConfig.ethereumDa?.submitterRpcUrl,
        feeOracle ? 'general.L2_RPC_ENDPOINT' : 'ethereumDa.submitterRpcUrl',
      ), prefix)
    }
  }

  if (changes.length > 0) values.balanceMonitoring = balance
  return changes
}
