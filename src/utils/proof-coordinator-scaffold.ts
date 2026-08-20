/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and parsed TOML are dynamic documents. */

import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { type ProvingMode, WITHDRAWAL_NATIVE_CONFIG_RELPATH } from './withdrawal-config.js'

export interface ScaffoldCoordinatorConfigOptions {
  coordinatorConfigPath: string
  /**
   * `mock` scaffolds the dev-sentinel scroll materializers paired with the
   * dev_dummy verifier (dogeos-core e2e strict-withdrawal shape); `production`
   * (default) scaffolds the real subprocess materializer topology.
   */
  provingMode?: ProvingMode
  valuesDir: string
  /** Native WithdrawalProcessor.toml; preferred fact source when present. */
  withdrawalConfigPath?: string
}

export interface ScaffoldCoordinatorConfigResult {
  configFile: string
  created: boolean
  /** True when this invocation changed the file, including initial creation. */
  updated: boolean
}

/** Deployment facts the coordinator scaffold shares with withdrawal-processor. */
interface ScaffoldFacts {
  beaconNodeUrl?: string
  blobS3KeyPrefix?: string
  blobS3Url?: string
  blobTimeoutMs: number
  dogecoinNetwork: string
  dogecoinRpcUrl: string
  l1RpcUrl: string
  l2RpcUrl: string
  source: string
}

/**
 * Env names projected into withdrawal-processor values by older prep-charts
 * layouts. Newer layouts own these in WithdrawalProcessor.toml instead.
 */
const WP_ENV = {
  beaconNodeUrl: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL',
  blobS3KeyPrefix: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__KEY_PREFIX',
  blobS3Url: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL',
  blobTimeoutMs: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__TIMEOUT_MS',
  dogecoinNetwork: 'DOGEOS_WITHDRAWAL_NETWORK_STR',
  dogecoinRpcUrl: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_URL',
  l1RpcUrl: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__L1_RPC_URL',
  l2RpcUrl: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__RPC_URL',
} as const

function isPlaceholder(value: string): boolean {
  return /<(?:auto|todo)>|placeholder/i.test(value)
}

function requireResolved(value: unknown, label: string): string {
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error(`${label} is required to scaffold ProofCoordinator.toml; run scrollsdk setup prep-charts first`)
  }

  if (isPlaceholder(text)) {
    throw new Error(`${label} is an unresolved placeholder (${text}); resolve it via config.toml + scrollsdk setup prep-charts before scaffolding`)
  }

  return text
}

function optionalResolved(value: unknown): string | undefined {
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string' || text.trim() === '' || isPlaceholder(text)) return undefined
  return text
}

function requirePositiveIntegerString(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer; got ${value}`)
  }

  return parsed
}

function readFactsFromWithdrawalToml(configPath: string): ScaffoldFacts {
  let parsed: any
  try {
    parsed = toml.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`${configPath}: invalid WithdrawalProcessor TOML: ${error instanceof Error ? error.message : String(error)}`)
  }

  const at = (label: string) => `${configPath}: ${label}`
  const blobSource = parsed.ethereum_da?.blob_source || {}
  return {
    beaconNodeUrl: optionalResolved(blobSource.beacon_node?.url),
    blobS3KeyPrefix: optionalResolved(blobSource.aws_s3?.key_prefix),
    blobS3Url: optionalResolved(blobSource.aws_s3?.url),
    blobTimeoutMs: requirePositiveIntegerString(
      optionalResolved(blobSource.timeout_ms) ?? '10000',
      at('ethereum_da.blob_source.timeout_ms')
    ),
    dogecoinNetwork: requireResolved(parsed.network_str, at('network_str')),
    dogecoinRpcUrl: requireResolved(parsed.dogecoin_rpc_url, at('dogecoin_rpc_url')),
    l1RpcUrl: requireResolved(parsed.ethereum_da?.l1_rpc_url, at('ethereum_da.l1_rpc_url')),
    l2RpcUrl: requireResolved(parsed.dogeos_indexer?.rpc_url, at('dogeos_indexer.rpc_url')),
    source: configPath,
  }
}

function readFactsFromValuesEnv(valuesDir: string): ScaffoldFacts {
  const valuesPath = path.join(valuesDir, 'withdrawal-processor-production.yaml')
  if (!fs.existsSync(valuesPath)) {
    throw new Error(`Values file not found: ${valuesPath}; run scrollsdk setup prep-charts before scaffolding ProofCoordinator.toml`)
  }

  const values = yaml.load(fs.readFileSync(valuesPath, 'utf8')) as any
  const env = Object.fromEntries(
    (Array.isArray(values?.env) ? values.env : [])
      .filter((item: any) => typeof item?.name === 'string' && item.value !== undefined)
      .map((item: any) => [item.name, String(item.value)])
  ) as Record<string, string>
  const at = (name: string) => `${valuesPath}: env ${name}`
  return {
    beaconNodeUrl: optionalResolved(env[WP_ENV.beaconNodeUrl]),
    blobS3KeyPrefix: optionalResolved(env[WP_ENV.blobS3KeyPrefix]),
    blobS3Url: optionalResolved(env[WP_ENV.blobS3Url]),
    blobTimeoutMs: requirePositiveIntegerString(
      optionalResolved(env[WP_ENV.blobTimeoutMs]) ?? '10000',
      at(WP_ENV.blobTimeoutMs)
    ),
    dogecoinNetwork: requireResolved(env[WP_ENV.dogecoinNetwork], at(WP_ENV.dogecoinNetwork)),
    dogecoinRpcUrl: requireResolved(env[WP_ENV.dogecoinRpcUrl], at(WP_ENV.dogecoinRpcUrl)),
    l1RpcUrl: requireResolved(env[WP_ENV.l1RpcUrl], at(WP_ENV.l1RpcUrl)),
    l2RpcUrl: requireResolved(env[WP_ENV.l2RpcUrl], at(WP_ENV.l2RpcUrl)),
    source: valuesPath,
  }
}

const q = (value: string): string => JSON.stringify(value)

export const MANAGED_RUNTIME_BEGIN = '# BEGIN scrollsdk managed proof coordinator runtime'
export const MANAGED_RUNTIME_END = '# END scrollsdk managed proof coordinator runtime'
const MANAGED_VERIFIER_BEGIN = '# BEGIN scrollsdk managed verifier configuration'

function table(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? {...value as Record<string, any>}
    : {}
}

function existingString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

function ethereumDaConfig(
  existing: unknown,
  dataRoot: string,
  facts: ScaffoldFacts,
): Record<string, any> {
  const config = table(existing)
  const blobSource = table(config.blob_source)
  delete blobSource.aws_s3
  delete blobSource.beacon_node
  blobSource.timeout_ms = facts.blobTimeoutMs
  if (facts.blobS3Url) {
    blobSource.aws_s3 = {
      ...(facts.blobS3KeyPrefix ? {key_prefix: facts.blobS3KeyPrefix} : {}),
      url: facts.blobS3Url,
    }
  } else if (facts.beaconNodeUrl) {
    blobSource.beacon_node = {url: facts.beaconNodeUrl}
  } else {
    throw new Error(
      `${facts.source}: a blob source is required to scaffold ProofCoordinator.toml; configure the ethereumDa blob archive or a beacon node via config.toml + scrollsdk setup prep-charts`
    )
  }

  config.l1_rpc_url = facts.l1RpcUrl
  config.artifact_store_root = existingString(config.artifact_store_root, `${dataRoot}/blobs`)
  config.artifact_metadata_sqlite_path = existingString(
    config.artifact_metadata_sqlite_path,
    `${dataRoot}/meta.sqlite`,
  )
  config.blob_source = blobSource
  return config
}

/**
 * Merge CLI-owned deployment facts into the coordinator materializer tree.
 * Unknown runtime tuning remains intact, while fields that must agree with the
 * withdrawal processor and mutually exclusive mock/production topology are
 * always reconciled.
 */
function buildMaterializerRuntime(
  facts: ScaffoldFacts,
  provingMode: ProvingMode,
  existing: unknown = undefined,
): Record<string, any> {
  const materializer = table(existing)
  materializer.artifact_store_root = existingString(
    materializer.artifact_store_root,
    '/app/data/proof-materializer-staging',
  )

  const scrollBatch = table(materializer.scroll_batch)
  scrollBatch.enabled = true
  scrollBatch.materializer_output_root = existingString(
    scrollBatch.materializer_output_root,
    '/app/data/scroll-batch-materializer',
  )
  if (provingMode === 'mock') {
    delete materializer.scroll_chunk_segmentation
    materializer.dev_sentinel_scroll_chunk = {
      ...table(materializer.dev_sentinel_scroll_chunk),
      enabled: true,
    }
    scrollBatch.dev_sentinel = true
    scrollBatch.proof_mode = 'Mock'
    delete scrollBatch.subprocess
  } else {
    delete materializer.dev_sentinel_scroll_chunk
    materializer.scroll_chunk_segmentation = {
      ...table(materializer.scroll_chunk_segmentation),
      enabled: true,
    }
    scrollBatch.dev_sentinel = false
    delete scrollBatch.proof_mode
    const subprocess = table(scrollBatch.subprocess)
    subprocess.binary_path = existingString(
      subprocess.binary_path,
      '/usr/local/bin/scroll-runtime-materializer',
    )
    subprocess.statement_namespace_config_path = existingString(
      subprocess.statement_namespace_config_path,
      '/app/data/manifests/statement-namespace.json',
    )
    subprocess.scratch_root = existingString(
      subprocess.scratch_root,
      '/app/data/scroll-batch-scratch',
    )
    subprocess.chunk_program_commitment_hex = 'overridden-by-scrollsdk'
    subprocess.l2_rpc_url = facts.l2RpcUrl
    subprocess.subprocess_timeout_ms = Number.isSafeInteger(subprocess.subprocess_timeout_ms)
      && subprocess.subprocess_timeout_ms > 0
      ? subprocess.subprocess_timeout_ms
      : 3_600_000
    subprocess.ethereum_da = ethereumDaConfig(
      subprocess.ethereum_da,
      '/app/data/scroll-batch-eth-da',
      facts,
    )
    scrollBatch.subprocess = subprocess
  }

  materializer.scroll_batch = scrollBatch
  const bridge = table(materializer.bridge)
  bridge.enabled = true
  bridge.advance_l1 = true
  bridge.advance_l2 = true
  bridge.dogecoin_rpc = {
    ...table(bridge.dogecoin_rpc),
    network: facts.dogecoinNetwork,
    url: facts.dogecoinRpcUrl,
  }
  bridge.ethereum_da = ethereumDaConfig(
    bridge.ethereum_da,
    '/app/data/bridge-eth-da',
    facts,
  )
  materializer.bridge = bridge
  return materializer
}

function renderManagedRuntime(materializer: Record<string, any>): string {
  const body = toml.stringify({materializer} as toml.JsonMap).trimEnd()
  return `${MANAGED_RUNTIME_BEGIN}\n${body}\n${MANAGED_RUNTIME_END}`
}

function migrateLegacyHeader(source: string): string {
  return source
    .replace(
      '# Initially scaffolded from the prepared withdrawal-processor configuration.\n'
      + '# Hand-maintained afterwards: `scrollsdk setup prep-charts` only rewrites the\n'
      + '# marked verifier block when proof mode is active. Review every value before\n'
      + '# production use.\n',
      '# Initially scaffolded from the prepared withdrawal-processor configuration.\n'
      + '# scrollsdk owns the marked runtime and verifier blocks. Configuration outside\n'
      + '# those blocks remains operator-maintained.\n',
    )
    .replace(
      '# Generated by `scrollsdk setup prep-charts`\n'
      + '# from the prepared withdrawal-processor deployment configuration.\n'
      + '# Hand-maintained afterwards: scrollsdk only rewrites the marked verifier block\n'
      + '# below. Review every value before production use.\n',
      '# Generated by `scrollsdk setup prep-charts` from the prepared\n'
      + '# withdrawal-processor deployment configuration. scrollsdk owns the marked\n'
      + '# runtime and verifier blocks; all other configuration is operator-maintained.\n',
    )
}

function replaceManagedRuntimeBlock(
  filePath: string,
  source: string,
  materializer: Record<string, any>,
): string {
  const beginCount = source.split(MANAGED_RUNTIME_BEGIN).length - 1
  const endCount = source.split(MANAGED_RUNTIME_END).length - 1
  if (beginCount !== endCount || beginCount > 1) {
    throw new Error(`${filePath}: expected at most one complete ${MANAGED_RUNTIME_BEGIN} / ${MANAGED_RUNTIME_END} block`)
  }

  const managed = renderManagedRuntime(materializer)
  if (beginCount === 1) {
    const begin = source.indexOf(MANAGED_RUNTIME_BEGIN)
    const end = source.indexOf(MANAGED_RUNTIME_END, begin)
    const afterEnd = end + MANAGED_RUNTIME_END.length
    return `${source.slice(0, begin)}${managed}${source.slice(afterEnd)}`
  }

  // One-time migration for coordinator files scaffolded before the runtime
  // ownership marker existed. The verifier marker is the unambiguous boundary;
  // refusing any other section in between prevents accidental broad rewrites.
  const materializerHeader = /^\[materializer]\s*(?:#.*)?$/m.exec(source)
  const verifierBoundary = source.indexOf(MANAGED_VERIFIER_BEGIN)
  if (!materializerHeader || verifierBoundary < materializerHeader.index) {
    throw new Error(
      `${filePath}: cannot safely reconcile an existing coordinator config without a [materializer] tree followed by ${MANAGED_VERIFIER_BEGIN}`
    )
  }

  const legacyRuntime = source.slice(materializerHeader.index, verifierBoundary)
  for (const match of legacyRuntime.matchAll(/^\s*\[\[?([^\]]+)]]?\s*(?:#.*)?$/gm)) {
    if (match[1] !== 'materializer' && !match[1].startsWith('materializer.')) {
      throw new Error(`${filePath}: cannot migrate coordinator runtime across non-materializer section [${match[1]}]`)
    }
  }

  const prefix = source.slice(0, materializerHeader.index)
  const suffix = source.slice(verifierBoundary)
  return `${prefix}${managed}\n\n${suffix}`
}

function writeAtomically(filePath: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true})
  const temporaryPath = `${filePath}.tmp-${process.pid}`
  try {
    fs.writeFileSync(temporaryPath, content, {mode})
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
  }
}

/**
 * Generate a complete, validation-passing ProofCoordinator.toml from the
 * deployment facts prep-charts already resolved — read from the native
 * WithdrawalProcessor.toml when it exists, or the legacy values env layout
 * otherwise. For an existing file, the marked materializer/runtime block is
 * reconciled on every run while operator-owned configuration outside the block
 * remains byte-for-byte intact. The managed verifier block is left for
 * `setup prep-charts` to fill in the same run.
 */
export function scaffoldProofCoordinatorConfig(
  options: ScaffoldCoordinatorConfigOptions
): ScaffoldCoordinatorConfigResult {
  const configFile = path.resolve(options.coordinatorConfigPath)
  const valuesDir = path.resolve(options.valuesDir)
  const withdrawalConfigPath = path.resolve(
    options.withdrawalConfigPath || path.join(path.dirname(valuesDir), WITHDRAWAL_NATIVE_CONFIG_RELPATH)
  )
  const facts = fs.existsSync(withdrawalConfigPath)
    ? readFactsFromWithdrawalToml(withdrawalConfigPath)
    : readFactsFromValuesEnv(valuesDir)

  const provingMode = options.provingMode || 'production'
  const existed = fs.existsSync(configFile)
  if (existed) {
    const original = fs.readFileSync(configFile, 'utf8')
    const source = migrateLegacyHeader(original)
    let parsed: any
    try {
      parsed = toml.parse(source)
    } catch (error) {
      throw new Error(`${configFile}: invalid existing ProofCoordinator TOML: ${error instanceof Error ? error.message : String(error)}`)
    }

    const materializer = buildMaterializerRuntime(facts, provingMode, parsed.materializer)
    const candidate = replaceManagedRuntimeBlock(configFile, source, materializer)
    try {
      toml.parse(candidate)
    } catch (error) {
      throw new Error(`${configFile}: reconciled ProofCoordinator TOML is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }

    const updated = candidate !== original
    if (updated) {
      writeAtomically(configFile, candidate, fs.statSync(configFile).mode % 0o1000)
    }

    return {configFile, created: false, updated}
  }

  const materializer = buildMaterializerRuntime(facts, provingMode)

  const content = `# Generated by \`scrollsdk setup prep-charts\`
# from the prepared withdrawal-processor deployment configuration.
# scrollsdk owns the marked runtime and verifier blocks; all other
# configuration is operator-maintained.
poll_interval_ms = 1000
lease_ttl_ms = 60000
protocol_context_json = "/app/protocol_context.json"

[auth]
bearer_token_file = "/app/secrets/proof-work-token"

[artifact_store]
kind = "s3"
key_prefix = "proof-topology"
force_path_style = false

${renderManagedRuntime(materializer)}

# BEGIN scrollsdk managed verifier configuration
[verifier]
verifier_import_mode = ${q(provingMode === 'mock' ? 'dev_dummy' : 'production')}
# END scrollsdk managed verifier configuration

[prover_api]
enabled = true
bind_addr = "0.0.0.0:9400"
worker_auth_token_file = "/app/secrets/prover-worker-token"
max_lease_ttl_ms = 300000
transport = "s3"

[artifact_write]
signed_put_expiry_ms = 3600000
staging_prefix = "staging/proofs"
accepted_prefix = "accepted/proofs"
max_proof_bytes = 536870912
max_public_output_bytes = 10485760
`

  try {
    toml.parse(content)
  } catch (error) {
    throw new Error(`Generated ProofCoordinator.toml is invalid TOML: ${error instanceof Error ? error.message : String(error)}`)
  }

  writeAtomically(configFile, content, 0o600)
  return {configFile, created: true, updated: true}
}
