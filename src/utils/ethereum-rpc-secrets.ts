import * as toml from '@iarna/toml'
import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'

import {savedDeploymentEnvFile} from './deployment-paths.js'
import {loadPreparationEnv} from './preparation-io.js'

/** All provider endpoints are private, even when today's value is a public URL. */
export const ETHEREUM_RPC_PLACEHOLDER = 'http://ethereum-rpc.invalid'
export const DOGECOIN_RPC_CREDENTIAL_PLACEHOLDER = 'provided-by-runtime-secret'
export const ETHEREUM_BEACON_PLACEHOLDER = 'http://ethereum-beacon.invalid'
export const FEE_ORACLE_RPC_DEFAULT = 'https://ethereum-rpc.publicnode.com'

// PC's existing RPC Secret also owns Dogecoin auth, so rotating cluster RPC
// credentials does not require baking a new proof-topology bundle.
export const ETHEREUM_RPC_KEYS: Record<string, Record<string, 'beacon' | 'dogecoinPassword' | 'dogecoinUser' | 'execution' | 'fees'>> = {
  'eth-da-submitter': {DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__RPC_URL: 'execution'},
  'fee-oracle': {DOGEOS_FEE_ORACLE_ETHEREUM_DA__ETH_RPC_URL: 'fees'},
  'l1-interface': {
    DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL: 'beacon',
    DOGEOS_L1_INTERFACE_ETHEREUM_DA__L1_RPC_URL: 'execution',
  },
  'proof-coordinator': {
    DOGEOS_PROOF_COORDINATOR_MATERIALIZER__BRIDGE__DOGECOIN_RPC__PASS: 'dogecoinPassword',
    DOGEOS_PROOF_COORDINATOR_MATERIALIZER__BRIDGE__DOGECOIN_RPC__USER: 'dogecoinUser',
    DOGEOS_PROOF_COORDINATOR_MATERIALIZER__BRIDGE__ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL: 'beacon',
    DOGEOS_PROOF_COORDINATOR_MATERIALIZER__BRIDGE__ETHEREUM_DA__L1_RPC_URL: 'execution',
    DOGEOS_PROOF_COORDINATOR_MATERIALIZER__SCROLL_BATCH__SUBPROCESS__ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL: 'beacon',
    DOGEOS_PROOF_COORDINATOR_MATERIALIZER__SCROLL_BATCH__SUBPROCESS__ETHEREUM_DA__L1_RPC_URL: 'execution',
  },
  'scroll-monitor': {SCROLL_BALANCE_ETH_DA_SUBMITTER_RPC_URL: 'execution'},
  'withdrawal-processor': {
    DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL: 'beacon',
    DOGEOS_WITHDRAWAL_ETHEREUM_DA__L1_RPC_URL: 'execution',
  },
}
export function ethereumRpcSecretName(service: string): string {
  return service === 'scroll-monitor' ? 'scroll-monitor-balance-env' : service === 'proof-coordinator' ? 'proof-coordinator-rpc-env' : `${service}-secret-env`
}

export function resolveEthereumRpc(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is required (endpoint omitted)`)
  const names = [...value.matchAll(/\$ENV:(\w+)/g)].map(match => match[1])
  if (names.some(name => !process.env[name])) loadPreparationEnv(savedDeploymentEnvFile(process.cwd()), names)
  const resolved = value.replaceAll(/\$ENV:(\w+)/g, (_, name: string) => {
    const input = process.env[name]
    if (!input) throw new Error(`Set ${name} in private deployment.env`)
    return input
  })
  try {
    const url = new URL(resolved)
    if (!['http:', 'https:'].includes(url.protocol) || /[\s\0"\\]/.test(resolved)) throw new Error('Invalid endpoint')
  } catch {throw new Error(`${label} must be an HTTP(S) endpoint (value omitted)`)}

  return resolved
}

/** Values and native ConfigMaps never need the resolved URL. */
export function reconcileEthereumRpcSecrets(values: Record<string, any>, service: string, options?: {awsRegion?: string; gcpProject?: string; prefix: string; provider: string}, selectedKeys?: string[]): boolean {
  const allKeys = ETHEREUM_RPC_KEYS[service]
  if (!allKeys) return false
  if (service === 'scroll-monitor' && (values.balanceMonitoring?.enabled === false || values.balanceMonitoring?.exporter?.enabled === false)) return false
  const keys = selectedKeys === undefined ? allKeys : Object.fromEntries(Object.entries(allKeys).filter(([key]) => selectedKeys.includes(key)))
  const before = JSON.stringify(values)
  const name = ethereumRpcSecretName(service)
  for (const config of Object.values(values.configMaps ?? {}) as any[]) {
    for (const key of Object.keys(allKeys)) if (config?.data) delete config.data[key]
  }

  if (Array.isArray(values.env)) values.env = values.env.filter((entry: any) => !Object.hasOwn(allKeys, entry.name))
  else if (values.env) for (const key of Object.keys(allKeys)) delete values.env[key]
  if (selectedKeys?.length === 0) {
    if (Array.isArray(values.envFrom)) values.envFrom = values.envFrom.filter((entry: any) => entry.secretRef?.name !== name)
    if (values.externalSecrets) delete values.externalSecrets[name]
    return before !== JSON.stringify(values)
  }

  if (service === 'scroll-monitor') {
    values.balanceMonitoring ??= {}
    values.balanceMonitoring.exporter ??= {}
    const existing = values.balanceMonitoring.exporter.envFromSecret
    if (existing && existing !== name) {
      if (values.balanceMonitoring.ethereum?.ethDaSubmitter?.rpcUrl !== '') throw new Error('An operator-owned balance Secret requires ethereum.ethDaSubmitter.rpcUrl to be empty')
      if (values.externalSecrets) delete values.externalSecrets[name]
      return before !== JSON.stringify(values)
    }

    values.balanceMonitoring.exporter.envFromSecret = name
    values.balanceMonitoring.ethereum ??= {}
    values.balanceMonitoring.ethereum.ethDaSubmitter ??= {}
    values.balanceMonitoring.ethereum.ethDaSubmitter.rpcUrl = ''
  } else {
    values.envFrom ??= []
    if (!values.envFrom.some((entry: any) => entry.secretRef?.name === name)) values.envFrom.push({secretRef: {name}})
  }

  if (options?.provider === 'kubernetes') {
    if (values.externalSecrets) delete values.externalSecrets[name]
  } else {
    values.externalSecrets ??= {}
    const secret = values.externalSecrets[name] ?? {provider: options?.provider === 'gcp' ? 'gcpsm' : options?.provider ?? 'aws', refreshInterval: '2m', serviceAccount: 'external-secrets', ...(options?.provider === 'gcp' ? {projectID: options.gcpProject} : {secretRegion: options?.awsRegion ?? 'us-east-1'})}
    if (options) {
      secret.provider = options.provider === 'gcp' ? 'gcpsm' : options.provider
      if (options.provider === 'gcp') {secret.projectID = options.gcpProject; delete secret.secretRegion}
      else {secret.secretRegion = options.awsRegion ?? 'us-east-1'; delete secret.projectID}
    }

    const remoteKey = options ? `${options.prefix}/${name}` : secret.data?.find((entry: any) => entry.remoteRef?.key)?.remoteRef.key
    if (!remoteKey) throw new Error('Ethereum RPC Secrets require a generated Secret destination; run generate-from-spec first')
    secret.data = (secret.data ?? []).filter((entry: any) => !Object.hasOwn(allKeys, entry.secretKey))
    for (const key of Object.keys(keys)) {
      secret.data = secret.data.filter((entry: any) => entry.secretKey !== key)
      secret.data.push({remoteRef: {key: remoteKey, property: key}, secretKey: key})
    }

    values.externalSecrets[name] = secret
  }

  return before !== JSON.stringify(values)
}

/** Append service-specific keys to the existing private env files, including KMS services. */
export function ethereumRpcSecretLines(service: string, config: DogeConfig, selectedKeys?: string[]): string {
  const keys = ETHEREUM_RPC_KEYS[service]
  if (!keys) return ''
  const defaults = config.ethereumDa?.chain === 'mainnet'
    ? {beacon: 'https://ethereum-beacon-api.publicnode.com', execution: FEE_ORACLE_RPC_DEFAULT}
    : config.ethereumDa?.chain === 'devnet'
      ? {beacon: 'http://l1-devnet-lighthouse:5052', execution: 'http://l1-devnet:8545'}
      : {beacon: 'https://ethereum-sepolia-beacon-api.publicnode.com', execution: 'https://ethereum-sepolia-rpc.publicnode.com'}
  const sources = {beacon: config.ethereumDa?.beaconRpcUrl ?? defaults.beacon, execution: config.ethereumDa?.submitterRpcUrl ?? defaults.execution, fees: config.feeOracle?.ethereumRpcUrl ?? FEE_ORACLE_RPC_DEFAULT}
  return Object.entries(keys).filter(([key]) => selectedKeys === undefined || selectedKeys.includes(key)).map(([key, source]) => {
    if (source === 'dogecoinUser' || source === 'dogecoinPassword') {
      const field = source === 'dogecoinUser' ? 'username' : 'password'
      const value = config.dogecoinClusterRpc?.[field]
      if (typeof value !== 'string' || !value) throw new Error(`Dogecoin cluster RPC ${field} is required (value omitted)`)
      const names = [...value.matchAll(/\$ENV:(\w+)/g)].map(match => match[1])
      if (names.some(name => !process.env[name])) loadPreparationEnv(savedDeploymentEnvFile(process.cwd()), names)
      const resolved = value.replaceAll(/\$ENV:(\w+)/g, (_, name: string) => {
        if (!process.env[name]) throw new Error(`Set ${name} in private deployment.env`)
        return process.env[name]!
      })
      return `${key}=${JSON.stringify(resolved)}\n`
    }

    return `${key}=${JSON.stringify(resolveEthereumRpc(sources[source], `Ethereum ${source} RPC`))}\n`
  }).join('')
}

/** Sanitize the compiler's native input before it can be embedded in a bundle. */
export function sanitizeEthereumRpcToml(source: string): string {
  let parsed: Record<string, any>
  try {parsed = toml.parse(source)} catch {throw new Error('Cannot parse native service TOML (contents omitted)')}
  let changed = false
  function visit(table: Record<string, any>): void {
    for (const [key, value] of Object.entries(table)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      if (key === 'ethereum_da') {
        if (value.l1_rpc_url !== undefined && value.l1_rpc_url !== ETHEREUM_RPC_PLACEHOLDER) {value.l1_rpc_url = ETHEREUM_RPC_PLACEHOLDER; changed = true}
        if (value.blob_source?.beacon_node?.url !== undefined && value.blob_source.beacon_node.url !== ETHEREUM_BEACON_PLACEHOLDER) {value.blob_source.beacon_node.url = ETHEREUM_BEACON_PLACEHOLDER; changed = true}
      }

      if (key === 'ethereum' && value.rpc_url !== undefined && value.rpc_url !== ETHEREUM_RPC_PLACEHOLDER) {value.rpc_url = ETHEREUM_RPC_PLACEHOLDER; changed = true}
      visit(value)
    }
  }

  // The coordinator consumes the same runtime Dogecoin credentials as WP/L1.
  // Never preserve an old password inside a compiler input or ConfigMap.
  const dogecoin = parsed.materializer?.bridge?.dogecoin_rpc
  if (dogecoin) for (const field of ['user', 'pass']) {
    if (dogecoin[field] !== undefined && dogecoin[field] !== DOGECOIN_RPC_CREDENTIAL_PLACEHOLDER) {
      dogecoin[field] = DOGECOIN_RPC_CREDENTIAL_PLACEHOLDER
      changed = true
    }
  }

  visit(parsed)
  return changed ? toml.stringify(parsed) : source
}

/** Do not manufacture partial materializer tables through Figment's env provider. */
export function proofCoordinatorRpcKeys(source: string): string[] {
  let config: Record<string, any>
  try {config = toml.parse(source)} catch {throw new Error('Cannot parse ProofCoordinator TOML (contents omitted)')}
  return Object.keys(ETHEREUM_RPC_KEYS['proof-coordinator']).filter(key => {
    const path = key.slice('DOGEOS_PROOF_COORDINATOR_'.length).toLowerCase().split('__')
    let value: any = config
    for (const field of path) value = value?.[field]
    return value !== undefined
  })
}

/** Persisted spec-derived provider choice survives standalone prep-charts calls. */
export function readEthereumRpcSecretStore(root = process.cwd()): DogeConfig['ethereumRpcSecretStore'] {
  const file = path.join(root, '.data/doge-config.toml')
  if (!fs.existsSync(file)) return undefined
  try {return (toml.parse(fs.readFileSync(file, 'utf8')) as unknown as DogeConfig).ethereumRpcSecretStore} catch {throw new Error('Cannot read private Ethereum Secret store configuration (contents omitted)')}
}
