/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and parsed TOML are dynamic documents. */

import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { WITHDRAWAL_NATIVE_CONFIG_RELPATH } from './withdrawal-config.js'

export interface ScaffoldCoordinatorConfigOptions {
  coordinatorConfigPath: string
  valuesDir: string
  /** Native WithdrawalProcessor.toml; preferred fact source when present. */
  withdrawalConfigPath?: string
}

export interface ScaffoldCoordinatorConfigResult {
  configFile: string
  created: boolean
}

/** Deployment facts the coordinator scaffold shares with withdrawal-processor. */
interface ScaffoldFacts {
  beaconNodeUrl?: string
  blobS3KeyPrefix?: string
  blobS3Url?: string
  blobTimeoutMs: number
  dogecoinNetwork: string
  dogecoinRpcUrl: string
  ethChainId: number
  l1RpcUrl: string
  l2ChainId: number
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
  ethChainId: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__ETH_CHAIN_ID',
  l1RpcUrl: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__L1_RPC_URL',
  l2ChainId: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__L2_CHAIN_ID',
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
    ethChainId: requirePositiveIntegerString(
      requireResolved(parsed.ethereum_da?.eth_chain_id, at('ethereum_da.eth_chain_id')),
      at('ethereum_da.eth_chain_id')
    ),
    l1RpcUrl: requireResolved(parsed.ethereum_da?.l1_rpc_url, at('ethereum_da.l1_rpc_url')),
    l2ChainId: requirePositiveIntegerString(
      requireResolved(parsed.ethereum_da?.l2_chain_id, at('ethereum_da.l2_chain_id')),
      at('ethereum_da.l2_chain_id')
    ),
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
    ethChainId: requirePositiveIntegerString(requireResolved(env[WP_ENV.ethChainId], at(WP_ENV.ethChainId)), at(WP_ENV.ethChainId)),
    l1RpcUrl: requireResolved(env[WP_ENV.l1RpcUrl], at(WP_ENV.l1RpcUrl)),
    l2ChainId: requirePositiveIntegerString(requireResolved(env[WP_ENV.l2ChainId], at(WP_ENV.l2ChainId)), at(WP_ENV.l2ChainId)),
    l2RpcUrl: requireResolved(env[WP_ENV.l2RpcUrl], at(WP_ENV.l2RpcUrl)),
    source: valuesPath,
  }
}

const q = (value: string): string => JSON.stringify(value)

function ethereumDaSection(label: string, dataRoot: string, facts: ScaffoldFacts, providerToml: string): string {
  return `[${label}]
l1_rpc_url = ${q(facts.l1RpcUrl)}
eth_chain_id = ${facts.ethChainId}
l2_chain_id = ${facts.l2ChainId}
artifact_store_root = ${q(`${dataRoot}/blobs`)}
artifact_metadata_sqlite_path = ${q(`${dataRoot}/meta.sqlite`)}

[${label}.blob_source]
timeout_ms = ${facts.blobTimeoutMs}

${providerToml.replaceAll('__BLOB_SOURCE__', `${label}.blob_source`)}`
}

/**
 * Generate a complete, validation-passing ProofCoordinator.toml from the
 * deployment facts prep-charts already resolved — read from the native
 * WithdrawalProcessor.toml when it exists, or the legacy values env layout
 * otherwise. The file is only created when missing; the managed verifier block
 * is left as a marked production stub for `setup proof-config` to fill in the
 * same run.
 */
export function scaffoldProofCoordinatorConfig(
  options: ScaffoldCoordinatorConfigOptions
): ScaffoldCoordinatorConfigResult {
  const configFile = path.resolve(options.coordinatorConfigPath)
  if (fs.existsSync(configFile)) return { configFile, created: false }

  const valuesDir = path.resolve(options.valuesDir)
  const withdrawalConfigPath = path.resolve(
    options.withdrawalConfigPath || path.join(path.dirname(valuesDir), WITHDRAWAL_NATIVE_CONFIG_RELPATH)
  )
  const facts = fs.existsSync(withdrawalConfigPath)
    ? readFactsFromWithdrawalToml(withdrawalConfigPath)
    : readFactsFromValuesEnv(valuesDir)

  let providerToml: string
  if (facts.blobS3Url) {
    providerToml = `[__BLOB_SOURCE__.aws_s3]\nurl = ${q(facts.blobS3Url)}${facts.blobS3KeyPrefix ? `\nkey_prefix = ${q(facts.blobS3KeyPrefix)}` : ''}`
  } else if (facts.beaconNodeUrl) {
    providerToml = `[__BLOB_SOURCE__.beacon_node]\nurl = ${q(facts.beaconNodeUrl)}`
  } else {
    throw new Error(
      `${facts.source}: a blob source is required to scaffold ProofCoordinator.toml; configure the ethereumDa blob archive or a beacon node via config.toml + scrollsdk setup prep-charts`
    )
  }

  const content = `# Generated by \`scrollsdk setup proof-config --scaffold-coordinator-config\`
# from the prepared withdrawal-processor deployment configuration.
# Hand-maintained afterwards: scrollsdk only rewrites the marked verifier block
# below. Review every value before production use.
poll_interval_ms = 1000
lease_ttl_ms = 60000

[auth]
bearer_token_file = "/run/secrets/proof-work-token"

[artifact_store]
kind = "s3"
key_prefix = "proof-topology"
force_path_style = false

[materializer]
artifact_store_root = "/app/data/proof-materializer-staging"

[materializer.scroll_chunk_segmentation]
enabled = true

[materializer.scroll_batch]
enabled = true
dev_sentinel = false
materializer_output_root = "/app/data/scroll-batch-materializer"

[materializer.scroll_batch.subprocess]
binary_path = "/usr/local/bin/scroll-runtime-materializer"
statement_namespace_config_path = "/app/data/manifests/statement-namespace.json"
scratch_root = "/app/data/scroll-batch-scratch"
# setup proof-config injects the validated raw commitment through the
# DOGEOS_PROOF_COORDINATOR_* environment overlay.
chunk_program_commitment_hex = "overridden-by-scrollsdk"
l2_rpc_url = ${q(facts.l2RpcUrl)}
subprocess_timeout_ms = 3600000

${ethereumDaSection('materializer.scroll_batch.subprocess.ethereum_da', '/app/data/scroll-batch-eth-da', facts, providerToml)}

[materializer.bridge]
enabled = true
advance_l1 = true
advance_l2 = true

[materializer.bridge.dogecoin_rpc]
url = ${q(facts.dogecoinRpcUrl)}
network = ${q(facts.dogecoinNetwork)}

${ethereumDaSection('materializer.bridge.ethereum_da', '/app/data/bridge-eth-da', facts, providerToml)}

# BEGIN scrollsdk managed verifier configuration
[verifier]
verifier_import_mode = "production"
# END scrollsdk managed verifier configuration

[prover_api]
enabled = true
bind_addr = "0.0.0.0:9400"
worker_auth_token_file = "/run/secrets/prover-worker-token"
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

  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  const temporaryPath = `${configFile}.tmp-${process.pid}`
  try {
    fs.writeFileSync(temporaryPath, content, { mode: 0o600 })
    fs.renameSync(temporaryPath, configFile)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
  }

  return { configFile, created: true }
}
