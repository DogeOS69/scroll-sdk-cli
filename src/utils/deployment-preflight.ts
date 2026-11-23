import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'

import {assertGenesisSequencerAmount} from './bridge-constants.js'
import {inspectContractOwner} from './contract-owner.js'
import {resolveCubesignerPolicy} from './cubesigner-policy-receipts.js'

export interface DeploymentPreflight {
  blockers: string[]
  dstack: {configured: boolean; valuesPresent: boolean}
  proofConfigured: boolean
  warnings: string[]
}

function readToml(file: string): toml.JsonMap {
  try {return toml.parse(fs.readFileSync(file, 'utf8'))} catch {throw new Error(`Cannot read valid TOML: ${file}; contents omitted`)}
}

const BASE_RPC_NAMESPACES = ['eth', 'net', 'rpc', 'web3']

/** Namespaces each Reth role serves over HTTP and WebSocket. */
function rethRpcRole(file: string): {allowed: string[]; name: string; public: boolean} | undefined {
  if (file === 'l2-reth-rpc-public-production.yaml') return {allowed: BASE_RPC_NAMESPACES, name: 'public RPC', public: true}
  // Proof materialization (debug_executionWitness) and explorer tracing call debug here.
  if (file === 'l2-reth-rpc-production.yaml') return {allowed: [...BASE_RPC_NAMESPACES, 'debug'], name: 'internal RPC', public: false}
  const match = /^l2-reth-(bootnode|sequencer)-production(?:-\d+)?\.yaml$/.exec(file)
  return match ? {allowed: BASE_RPC_NAMESPACES, name: match[1], public: false} : undefined
}

/** An omitted list is the chart default (eth, net, web3, rpc); a disabled transport serves nothing. */
function inspectRethRpcNamespaces(valuesDir: string, result: DeploymentPreflight): void {
  for (const file of fs.readdirSync(valuesDir).sort()) {
    const role = rethRpcRole(file)
    if (!role) continue
    let reth: Record<string, {api?: unknown; enabled?: unknown} | undefined> | undefined
    try {
      reth = (yaml.load(fs.readFileSync(path.join(valuesDir, file), 'utf8')) as {reth?: typeof reth} | undefined)?.reth
    } catch {
      result.blockers.push(`Cannot read valid YAML: values/${file}; contents omitted`)
      continue
    }

    for (const transport of ['http', 'ws']) {
      const settings = reth?.[transport]
      if (settings?.enabled === false || typeof settings?.api !== 'string') continue
      const extra = [...new Set(settings.api.split(',').map(item => item.trim()).filter(Boolean))].filter(item => !role.allowed.includes(item)).sort()
      if (extra.length === 0) continue
      const message = `values/${file} reth.${transport}.api enables ${extra.join(', ')} on the ${role.name} node`
      if (role.public) result.blockers.push(`${message}; the public endpoint must serve only ${role.allowed.join(', ')}`)
      else result.warnings.push(`${message}; keep ${role.allowed.join(', ')}, add a namespace only for a named caller, and use the IPC socket for operator access`)
    }
  }
}

const DEFAULT_MAX_WITHDRAWALS_PER_DA_TX = 4500n

/** A parsed non-negative integer (TOML gives a bigint above 2^53), or undefined for any other value. */
function parsedUnsigned(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value >= 0n ? value : undefined
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined
  return undefined
}

/**
 * In Kubernetes the submitter reads its batch limits only from the env in its
 * values (the compiler projects no [batch] table), so an omitted
 * max_withdrawals_per_da_tx is its default, 4500.
 */
function resolveSubmitterWithdrawalLimit(envValue: unknown, result: DeploymentPreflight): bigint | undefined {
  if (envValue === undefined) return DEFAULT_MAX_WITHDRAWALS_PER_DA_TX
  // YAML may have read an unquoted env value as a number. The submitter does
  // not trim an env value, so neither does this check.
  const limit = typeof envValue === 'string'
    ? (/^\d+$/.test(envValue) ? BigInt(envValue) : undefined)
    : parsedUnsigned(envValue)
  if (limit === undefined || limit === 0n) {
    result.blockers.push('eth-da-submitter DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_WITHDRAWALS_PER_DA_TX must be a positive integer')
    return undefined
  }

  return limit
}

/** The withdrawal backlog alerts page at the submitter's limit; an omitted alert limit is 4500. */
function inspectWithdrawalAlertLimit(valuesDir: string, withdrawalLimit: bigint, result: DeploymentPreflight): void {
  const file = path.join(valuesDir, 'scroll-monitor-production.yaml')
  if (!fs.existsSync(file)) return
  try {
    const monitor = yaml.load(fs.readFileSync(file, 'utf8')) as {withdrawalBoundAlerts?: {maxWithdrawalsPerDaTx?: unknown}} | undefined
    const alertLimit = Number(monitor?.withdrawalBoundAlerts?.maxWithdrawalsPerDaTx ?? 4500)
    if (Number(withdrawalLimit) !== alertLimit) result.warnings.push(`scroll-monitor withdrawalBoundAlerts.maxWithdrawalsPerDaTx (${alertLimit}) differs from eth-da-submitter max_withdrawals_per_da_tx (${withdrawalLimit}); set them equal so the withdrawal backlog alerts use the real limit`)
  } catch {result.blockers.push('Cannot read valid YAML: values/scroll-monitor-production.yaml; contents omitted')}
}

/**
 * The WP exports pending_withdrawal_warn_count beside the pending-withdrawal
 * count as its alert level. Its default (4500) is the submitter's default
 * max_withdrawals_per_da_tx, so a changed submitter limit needs it too.
 */
function inspectWpWithdrawalWarnCount(wp: toml.JsonMap, withdrawalLimit: bigint, result: DeploymentPreflight): void {
  const configured = wp.pending_withdrawal_warn_count
  const warnCount = configured === undefined ? DEFAULT_MAX_WITHDRAWALS_PER_DA_TX : parsedUnsigned(configured)
  if (warnCount === undefined) {
    result.blockers.push('WP pending_withdrawal_warn_count must be a non-negative integer')
    return
  }

  if (warnCount === withdrawalLimit) return
  const setting = configured === undefined ? `unset, default ${warnCount}` : String(warnCount)
  result.warnings.push(`WP pending_withdrawal_warn_count (${setting}) differs from eth-da-submitter max_withdrawals_per_da_tx (${withdrawalLimit}); set pending_withdrawal_warn_count = ${withdrawalLimit} in withdrawal-processor/WithdrawalProcessor.toml so the pending-withdrawal alert uses the real limit. Withdrawal Processor images before the release that adds this key refuse it`)
}

/** Compare both withdrawal alert levels with the submitter limit, once it resolves. */
function inspectWithdrawalLimits(root: string, submitterEnvValue: unknown, wp: toml.JsonMap, result: DeploymentPreflight): void {
  const withdrawalLimit = resolveSubmitterWithdrawalLimit(submitterEnvValue, result)
  if (withdrawalLimit === undefined) return
  inspectWithdrawalAlertLimit(path.join(root, 'values'), withdrawalLimit, result)
  inspectWpWithdrawalWarnCount(wp, withdrawalLimit, result)
}

/** Read-only checks for the currently supported configuration and deployment. */
export function inspectDeployment(options: {
  deploymentDir: string; dogeConfig?: string; requireDstack?: boolean
}): DeploymentPreflight {
  const root = path.resolve(options.deploymentDir)
  const result: DeploymentPreflight = {blockers: [], dstack: {configured: false, valuesPresent: false}, proofConfigured: false, warnings: []}
  const dogeFile = path.resolve(root, options.dogeConfig ?? '.data/doge-config.toml')
  const config = readToml(dogeFile) as unknown as DogeConfig
  result.proofConfigured = Boolean(config.proof_topology || fs.existsSync(path.join(root, '.data/proof-deployment.json')))
  const intentFile = path.join(root, '.scrollsdk/intent.json')
  if (fs.existsSync(intentFile)) {
    try {result.proofConfigured ||= Boolean(JSON.parse(fs.readFileSync(intentFile, 'utf8')).proofTopology)} catch {result.blockers.push('Cannot read saved deployment intent (private contents omitted)')}
  }

  try {
    const main = readToml(path.join(root, 'config.toml'))
    result.warnings.push(...inspectContractOwner(main.accounts as Record<string, unknown>).warnings)
  } catch (error) {result.blockers.push(error instanceof Error ? error.message : String(error))}

  try {
    assertGenesisSequencerAmount(readToml(path.join(root, '.data/setup_defaults.toml')).sequencer_target_amount)
  } catch (error) {result.blockers.push(error instanceof Error ? error.message : String(error))}

  if (config.cubesigner?.mode) {
    try {
      const policy = resolveCubesignerPolicy({deploymentDir: root, keys: (config.cubesigner.roles ?? []).flatMap(role => role.keys.map(key => ({keyId: key.key_id, materialId: key.material_id, roleId: role.role_id}))), network: config.network, selection: config.cubesigner})
      result.warnings.push(...policy.warnings)
    } catch (error) {result.blockers.push(error instanceof Error ? error.message : String(error))}
  }
  else {result.blockers.push('Set cubesigner.mode explicitly in the source configuration: production_verifier_key_policy (with its receipts) whenever the selected key carries a hosted verifier policy, or transport_only for a non-mainnet key without one')}

  const wpFile = path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
  const wp = readToml(wpFile)
  const fee = wp.fee_rate_sat_per_kvb
  if (typeof fee !== 'number' || !Number.isSafeInteger(fee) || fee < 100_000) result.blockers.push('WP fee_rate_sat_per_kvb must be an integer >= 100000; choose the fee explicitly in the native input')
  else if (fee < 1_000_000) result.warnings.push('WP fee_rate_sat_per_kvb is below the recommended 1000000')
  const da = wp.ethereum_da as toml.JsonMap | undefined
  const inbox = da?.inbox_worker as toml.JsonMap | undefined
  if (inbox && (!Array.isArray(inbox.expected_batchers) || inbox.expected_batchers.length === 0)) result.blockers.push('WP ethereum_da.inbox_worker.expected_batchers must be nonempty, even when disabled; regenerate from the submitter signer via prep-charts')

  const genesis = JSON.parse(fs.readFileSync(path.join(root, '.data/genesis.json'), 'utf8')) as {gasLimit?: number | string}
  const values = yaml.load(fs.readFileSync(path.join(root, 'values/eth-da-submitter-production.yaml'), 'utf8')) as {configMaps?: {env?: {data?: Record<string, unknown>}}}
  const limit = values.configMaps?.env?.data?.DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_L2_GAS_PER_CHUNK
  // An omitted chart/env override is resolved by the current native default.
  const chunkGas = Number(limit ?? 20_000_000)
  const blockGas = Number(genesis.gasLimit)
  if (!Number.isSafeInteger(blockGas) || blockGas <= 0 || !Number.isSafeInteger(chunkGas) || chunkGas <= blockGas) result.blockers.push('eth-da-submitter max_l2_gas_per_chunk must be strictly greater than the genesis gasLimit; set a valid explicit limit')

  inspectWithdrawalLimits(root, values.configMaps?.env?.data?.DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_WITHDRAWALS_PER_DA_TX, wp, result)
  inspectRethRpcNamespaces(path.join(root, 'values'), result)

  result.dstack.configured = Boolean(config.dstackController && config.dstackController.enabled !== false)
  result.dstack.valuesPresent = fs.existsSync(path.join(root, 'values/dstack-controller-production.yaml'))
  if (!result.dstack.configured || !result.dstack.valuesPresent) {
    const message = 'dstack controller is not fully configured/generated; run dstack-config, gen-secrets --dstack-only and prep-charts --dstack-only before installing its chart'
    if (options.requireDstack) result.blockers.push(message)
    else result.warnings.push(message)
  }

  result.warnings.push('AWS resources and permissions are managed outside the CLI. Run signer network-check on each Docker signer host; configuration checks do not establish live connectivity.')
  return result
}
