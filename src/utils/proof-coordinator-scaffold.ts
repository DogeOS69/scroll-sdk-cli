/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values are dynamic documents. */

import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface ScaffoldCoordinatorConfigOptions {
  coordinatorConfigPath: string
  valuesDir: string
}

export interface ScaffoldCoordinatorConfigResult {
  configFile: string
  created: boolean
}

/**
 * Env names projected into withdrawal-processor values by `setup prep-charts`.
 * The scaffold reuses those already-resolved deployment facts instead of
 * inventing its own; anything still `<TODO>` there fails closed here with the
 * offending env named.
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

function readWithdrawalEnv(valuesDir: string): { env: Record<string, string>; valuesPath: string } {
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
  return { env, valuesPath }
}

function requireResolved(env: Record<string, string>, name: string, valuesPath: string): string {
  const value = env[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${valuesPath}: env ${name} is required to scaffold ProofCoordinator.toml; run scrollsdk setup prep-charts first`)
  }

  if (/<(?:auto|todo)>|placeholder/i.test(value)) {
    throw new Error(`${valuesPath}: env ${name} is an unresolved placeholder (${value}); resolve it via config.toml + scrollsdk setup prep-charts before scaffolding`)
  }

  return value
}

function optionalResolved(env: Record<string, string>, name: string): string | undefined {
  const value = env[name]
  if (typeof value !== 'string' || value.trim() === '') return undefined
  if (/<(?:auto|todo)>|placeholder/i.test(value)) return undefined
  return value
}

function requirePositiveIntegerString(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer; got ${value}`)
  }

  return parsed
}

const q = (value: string): string => JSON.stringify(value)

interface EthereumDaInputs {
  blobSourceToml: string
  ethChainId: number
  l1RpcUrl: string
  l2ChainId: number
}

function ethereumDaSection(label: string, dataRoot: string, inputs: EthereumDaInputs): string {
  return `[${label}]
l1_rpc_url = ${q(inputs.l1RpcUrl)}
eth_chain_id = ${inputs.ethChainId}
l2_chain_id = ${inputs.l2ChainId}
artifact_store_root = ${q(`${dataRoot}/blobs`)}
artifact_metadata_sqlite_path = ${q(`${dataRoot}/meta.sqlite`)}

[${label}.blob_source]
${inputs.blobSourceToml.replaceAll('__BLOB_SOURCE__', `${label}.blob_source`)}`
}

/**
 * Generate a complete, validation-passing ProofCoordinator.toml from the
 * deployment facts prep-charts already projected into withdrawal-processor
 * values. The file is only created when missing — an existing hand-maintained
 * config is never touched. The managed verifier block is left as a marked
 * production stub for `setup proof-config` to fill in the same run.
 */
export function scaffoldProofCoordinatorConfig(
  options: ScaffoldCoordinatorConfigOptions
): ScaffoldCoordinatorConfigResult {
  const configFile = path.resolve(options.coordinatorConfigPath)
  if (fs.existsSync(configFile)) return { configFile, created: false }

  const { env, valuesPath } = readWithdrawalEnv(path.resolve(options.valuesDir))
  const l2RpcUrl = requireResolved(env, WP_ENV.l2RpcUrl, valuesPath)
  const l1RpcUrl = requireResolved(env, WP_ENV.l1RpcUrl, valuesPath)
  const ethChainId = requirePositiveIntegerString(
    requireResolved(env, WP_ENV.ethChainId, valuesPath),
    `${valuesPath}: env ${WP_ENV.ethChainId}`
  )
  const l2ChainId = requirePositiveIntegerString(
    requireResolved(env, WP_ENV.l2ChainId, valuesPath),
    `${valuesPath}: env ${WP_ENV.l2ChainId}`
  )
  const dogecoinRpcUrl = requireResolved(env, WP_ENV.dogecoinRpcUrl, valuesPath)
  const dogecoinNetwork = requireResolved(env, WP_ENV.dogecoinNetwork, valuesPath)

  const blobTimeoutMs = requirePositiveIntegerString(
    optionalResolved(env, WP_ENV.blobTimeoutMs) ?? '10000',
    `${valuesPath}: env ${WP_ENV.blobTimeoutMs}`
  )
  const blobS3Url = optionalResolved(env, WP_ENV.blobS3Url)
  const blobS3KeyPrefix = optionalResolved(env, WP_ENV.blobS3KeyPrefix)
  const beaconNodeUrl = optionalResolved(env, WP_ENV.beaconNodeUrl)
  let providerToml: string
  if (blobS3Url) {
    providerToml = `[__BLOB_SOURCE__.aws_s3]\nurl = ${q(blobS3Url)}${blobS3KeyPrefix ? `\nkey_prefix = ${q(blobS3KeyPrefix)}` : ''}`
  } else if (beaconNodeUrl) {
    providerToml = `[__BLOB_SOURCE__.beacon_node]\nurl = ${q(beaconNodeUrl)}`
  } else {
    throw new Error(
      `${valuesPath}: a blob source is required to scaffold ProofCoordinator.toml; set ethereumDa blob archive (${WP_ENV.blobS3Url}) or a beacon node (${WP_ENV.beaconNodeUrl}) via config.toml + scrollsdk setup prep-charts`
    )
  }

  const blobSourceToml = `timeout_ms = ${blobTimeoutMs}\n\n${providerToml}`
  const ethereumDaInputs: EthereumDaInputs = { blobSourceToml, ethChainId, l1RpcUrl, l2ChainId }

  const content = `# Generated by \`scrollsdk setup proof-config --scaffold-coordinator-config\`
# from the prepared withdrawal-processor values. Hand-maintained afterwards:
# scrollsdk only rewrites the marked verifier block below. Review every value
# before production use.
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
l2_rpc_url = ${q(l2RpcUrl)}
subprocess_timeout_ms = 3600000

${ethereumDaSection('materializer.scroll_batch.subprocess.ethereum_da', '/app/data/scroll-batch-eth-da', ethereumDaInputs)}

[materializer.bridge]
enabled = true
advance_l1 = true
advance_l2 = true

[materializer.bridge.dogecoin_rpc]
url = ${q(dogecoinRpcUrl)}
network = ${q(dogecoinNetwork)}

${ethereumDaSection('materializer.bridge.ethereum_da', '/app/data/bridge-eth-da', ethereumDaInputs)}

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
