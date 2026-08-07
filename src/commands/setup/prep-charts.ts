/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic YAML/TOML config operations */
import * as toml from '@iarna/toml'
import { confirm } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import { Wallet } from 'ethers'
import * as yaml from 'js-yaml'
import { execFileSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { DogeConfig } from '../../types/doge-config.js'

import {
  GENERATE_BRIDGE_INFO_FILE,
  L1_INTERFACE_BEACON_API_ENDPOINT,
  L1_INTERFACE_RPC_ENDPOINT,
  YAML_DUMP_OPTIONS,
} from '../../config/constants.js'
import { DogeConfig as DogeConfigType } from '../../types/doge-config.js'
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { GenerationTransaction } from '../../utils/generation-transaction.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {
  resolveBlockbookKubernetesEndpoints,
  resolveDogecoinKubernetesEndpoints,
} from '../../utils/kubernetes-endpoints.js'
import {
  type ResolvedProofIntent,
  resolveProofIntent,
} from '../../utils/proof-intent.js'
import {
  type ReconcileProofKubernetesResult,
  reconcileProofKubernetes,
} from '../../utils/proof-kubernetes-reconciler.js'
import { buildS3PublicBaseUrl, buildS3PublicPrefixUrl } from '../../utils/s3-archive.js'
import { deriveBridgeNamespaceId } from '../../utils/signer-policy-derivation.js'
import {
  getRequiredManagedSignerConfig,
  isAwsKmsSigner,
  isLocalSigner,
} from '../../utils/signer-roles.js'
import {
  WITHDRAWAL_CONFIG_FILE,
  WITHDRAWAL_NATIVE_CONFIG_RELPATH,
  buildWithdrawalDeploymentFacts,
  ensureWithdrawalChartWiring,
  ensureWithdrawalProofActivationSwitch,
  isWithdrawalProofActivationEnv,
  mergeWithdrawalManagedDeploymentBlock,
  removeInlineWithdrawalConfig,
  stripMigratedWithdrawalEnv,
} from '../../utils/withdrawal-config.js'
import {
  RETH_BOOTNODE_NODEKEY_ENV,
  type ResolvedBootnodeRethConfig,
  applyBootnodeRethValues,
  deriveBootnodeRethEnodeUrl,
  getBootnodeRethResourceName,
  getBootnodeRethValuesFileName,
} from './l2-bootnode-reth.js'
import {
  RETH_NODEKEY_ENV,
  RETH_SIGNER_PRIVATE_KEY_ENV,
  type ResolvedSequencerRethConfig,
  applySequencerRethValues,
  deriveSequencerRethEnodeUrl,
  getSequencerRethResourceName,
  getSequencerRethValuesFileName,
  normalizeRethNodekey,
  normalizeSignerMode,
  signerModeToConfig,
} from './l2-sequencer-reth.js'

export interface TsoSignerEndpoint {
  network: string
  role: 'Attestation' | 'Tee'
  uri: string
}

interface PrepChartGenerationResult {
  proof: ReconcileProofKubernetesResult
  skippedBootnodeRethInstances: number
  skippedConfig: number
  skippedInstances: number
  skippedProduction: number
  skippedRethInstances: number
  updatedBootnodeRethInstances: number
  updatedConfig: number
  updatedInstances: number
  updatedProduction: number
  updatedRethInstances: number
}

export function applyFrontendEnvFileValues(
  source: string,
  updates: Record<string, unknown>,
): {changed: boolean; content: string} {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  while (lines.at(-1) === '') lines.pop()
  const positions = new Map<string, number>()
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^([A-Z][\dA-Z_]*)\s*=\s*(.*)$/)
    if (match) positions.set(match[1], index)
  }

  let changed = false
  for (const [key, rawValue] of Object.entries(updates)) {
    if (rawValue === undefined || rawValue === null) continue
    const rendered = `${key} = ${String(rawValue)}`
    const position = positions.get(key)
    if (position === undefined) {
      lines.push(rendered)
      positions.set(key, lines.length - 1)
      changed = true
    } else if (lines[position] !== rendered) {
      lines[position] = rendered
      changed = true
    }
  }

  return {changed, content: `${lines.join('\n')}\n`}
}

/**
 * Build the in-cluster bootstrap peer set used during the one-way geth-to-Reth
 * cutover. Every L2 client must be able to reach either generation of
 * sequencer while both are available, so this set intentionally contains
 * sequencers only: legacy geth sequencers first, followed by Reth sequencers.
 *
 * Bootnodes are not part of this list. They have their own topology and the
 * external RPC package builds a separate geth+Reth bootnode peer set.
 */
export function buildInitialSequencerPeers(
  gethSequencerPeers: string[],
  rethSequencerPeers: string[],
): string[] {
  const peers = new Set<string>()
  for (const peer of [...gethSequencerPeers, ...rethSequencerPeers]) {
    const normalized = peer.trim()
    if (normalized !== '') peers.add(normalized)
  }

  return [...peers]
}

/** Render the shared in-cluster sequencer peers for Reth's CSV CLI value. */
export function buildRethInitialTrustedPeers(
  gethSequencerPeers: string[],
  rethSequencerPeers: string[],
): string {
  return buildInitialSequencerPeers(gethSequencerPeers, rethSequencerPeers).join(',')
}

/** Render the shared in-cluster sequencer peers for geth's JSON env value. */
export function buildL2GethInitialPeerList(
  gethSequencerPeers: string[],
  rethSequencerPeers: string[],
): string {
  return JSON.stringify(buildInitialSequencerPeers(gethSequencerPeers, rethSequencerPeers))
}

/**
 * The descriptor endpoint is the routing contract: preserve the partner's
 * exact IP/domain and project it into the TSO registration list alongside the
 * in-cluster TEE signers. Always return the full list so a missing/stale values
 * array cannot silently disconnect external signers.
 */
export function buildTsoSigners(config: Pick<DogeConfig, 'cubesigner' | 'network' | 'signerUrls'>): TsoSignerEndpoint[] {
  const cubesignerRoles = config.cubesigner?.roles || []
  if (cubesignerRoles.length > 1) {
    throw new Error('CubeSigner supports exactly one TEE role and one in-cluster deployment')
  }

  const teeSigners: TsoSignerEndpoint[] = cubesignerRoles.length === 0 ? [] : [{
    network: config.network,
    role: 'Tee',
    uri: 'http://cubesigner-signer:3000',
  }]
  const attestationSigners: TsoSignerEndpoint[] = (config.signerUrls || []).map(uri => ({
    network: config.network,
    role: 'Attestation',
    uri,
  }))
  return [...teeSigners, ...attestationSigners]
}

const CUBESIGNER_POLICY_REQUEST_CONTRACT =
  'dogeos-cubesigner-psbt-no-metadata-sign-all-scripts-false-unprefixed-hex-v1'

/**
 * Build the non-secret CubeSigner runtime projection owned by prep-charts.
 * Bridge identity is derived from bridge-init output, never from the PSBT or
 * independently authored Helm values. Reviewed production-policy evidence is
 * projected only when it exists in doge-config; absent evidence stays blank in
 * the production template so /ready fails closed.
 */
export function buildCubesignerPrepEnv(
  config: Pick<DogeConfig, 'cubesigner' | 'network'>,
  bridgeNamespaceId: string,
): Record<string, string> {
  if (!/^0x[\da-f]{40}$/.test(bridgeNamespaceId)) {
    throw new Error('CubeSigner bridge namespace id must be 0x-prefixed lowercase 20-byte hex')
  }

  const env: Record<string, string> = {
    CS_SESSIONS_DIR: '/app/.sessions',
    DOGEOS_CUBESIGNER_SIGNER_BRIDGE_NAMESPACE_ID: bridgeNamespaceId,
    DOGEOS_CUBESIGNER_SIGNER_LOG_LEVEL: 'info',
    DOGEOS_CUBESIGNER_SIGNER_MAX_CUBESIGNER_REQUEST_JSON_BYTES: '393216',
    DOGEOS_CUBESIGNER_SIGNER_MAX_CUBESIGNER_RESPONSE_JSON_BYTES: '393216',
    DOGEOS_CUBESIGNER_SIGNER_MAX_PSBT_BASE64_LEN: '130048',
    DOGEOS_CUBESIGNER_SIGNER_MAX_SIGN_REQUEST_JSON_BYTES: '262144',
    DOGEOS_CUBESIGNER_SIGNER_NETWORK: config.network,
    DOGEOS_CUBESIGNER_SIGNER_POLL_INTERVAL: '500',
    DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_MODE: 'production_verifier_key_policy',
    DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_REQUEST_CONTRACT:
      CUBESIGNER_POLICY_REQUEST_CONTRACT,
    DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_SDK_VERSION: '0.4.152-0',
    DOGEOS_CUBESIGNER_SIGNER_SESSION_KEEP_ALIVE_INTERVAL: '3600000',
    DOGEOS_CUBESIGNER_SIGNER_SIGNATURE_MODE: 'ecdsa',
    NETWORK: config.network,
  }
  const policy = config.cubesigner?.productionPolicy
  if (policy) {
    env.DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_IDENTIFIER = policy.policyIdentifier
    env.DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_ARTIFACT_DIGEST =
      policy.policyArtifactDigest
    env.DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_VERIFIER_IDENTITY_DIGEST =
      policy.verifierIdentityDigest
    env.DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_PROGRAM_IDENTITY_DIGEST =
      policy.programIdentityDigest
    env.DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_PROOF_RESOLVER_AUTHORITY =
      policy.proofResolverAuthority
    if (policy.liveEvidenceReportPath) {
      env.DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_LIVE_EVIDENCE_REPORT_PATH =
        policy.liveEvidenceReportPath
    }

    if (policy.liveEvidenceReportDigest) {
      env.DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_LIVE_EVIDENCE_REPORT_DIGEST =
        policy.liveEvidenceReportDigest
    }
  }

  return env
}

/** Upsert prep-owned scalar env values while preserving unrelated entries. */
export function applyCubesignerPrepEnv(
  productionYaml: any,
  desiredEnv: Record<string, string>,
): PrepChartChange[] {
  productionYaml.env ||= []
  const changes: PrepChartChange[] = []
  for (const [envKey, newValue] of Object.entries(desiredEnv)) {
    const envVar = productionYaml.env.find((item: any) => item.name === envKey)
    if (envVar) {
      if (envVar.value !== newValue || envVar.valueFrom !== undefined) {
        const oldValue = envVar.valueFrom === undefined
          ? String(envVar.value)
          : JSON.stringify(envVar.valueFrom)
        delete envVar.valueFrom
        envVar.value = newValue
        changes.push({key: `env.${envKey}`, newValue, oldValue})
      }
    } else {
      productionYaml.env.push({name: envKey, value: newValue})
      changes.push({key: `env.${envKey}`, newValue, oldValue: 'undefined'})
    }
  }

  return changes
}

/** Bind production-policy evidence to the singleton signer's exact key Secret. */
export function ensureCubesignerPolicyKeyBinding(productionYaml: any): PrepChartChange[] {
  productionYaml.env ||= []
  const name = 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_KEY_IDENTIFIER'
  const valueFrom = {
    secretKeyRef: {
      key: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID',
      name: 'cubesigner-signer-env',
    },
  }
  const envVar = productionYaml.env.find((item: any) => item.name === name)
  const oldValue = envVar
    ? JSON.stringify(envVar.valueFrom ?? envVar.value)
    : 'undefined'
  if (envVar && JSON.stringify(envVar.valueFrom) === JSON.stringify(valueFrom) &&
    envVar.value === undefined) {
    return []
  }

  if (envVar) {
    delete envVar.value
    envVar.valueFrom = valueFrom
  } else {
    productionYaml.env.push({name, valueFrom})
  }

  return [{key: `env.${name}`, newValue: JSON.stringify(valueFrom), oldValue}]
}

/**
 * Strip port from hostname for Kubernetes Ingress
 * Kubernetes Ingress hosts cannot contain port numbers
 * e.g., "localhost:8545" -> "localhost"
 */
function stripPortFromHost(host: string): string {
  if (!host) return host
  // Handle IPv6 addresses like [::1]:8545
  if (host.includes('[')) {
    const bracketEnd = host.indexOf(']')
    if (bracketEnd !== -1 && host[bracketEnd + 1] === ':') {
      return host.slice(0, Math.max(0, bracketEnd + 1))
    }

    return host
  }

  // Handle regular hostname:port
  const colonIndex = host.lastIndexOf(':')
  if (colonIndex !== -1) {
    // Check if what's after the colon is a number (port)
    const potentialPort = host.slice(Math.max(0, colonIndex + 1))
    if (/^\d+$/.test(potentialPort)) {
      return host.slice(0, Math.max(0, colonIndex))
    }
  }

  return host
}

export function shouldSkipL2ContractDeploymentBlockUpdate(
  chartName: string,
  key: string,
  skipL2ContractDeploymentBlock: boolean
): boolean {
  return skipL2ContractDeploymentBlock &&
    key === 'L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK' &&
    (
      chartName.startsWith('l2-bootnode') ||
      chartName.startsWith('l2-rpc') ||
      chartName.startsWith('l2-sequencer')
    )
}

export interface PrepChartChange {
  key: string
  newValue: string
  oldValue: string
}

/** Remove values files for the retired in-cluster attestation-signer chart. */
export function removeRetiredAttestationSignerValues(valuesDir: string): string[] {
  if (!fs.existsSync(valuesDir)) return []
  const removed: string[] = []
  for (const file of fs.readdirSync(valuesDir)) {
    if (!/^attestation-signer-production(?:-\d+)?\.yaml$/.test(file)) continue
    fs.rmSync(path.join(valuesDir, file))
    removed.push(file)
  }

  return removed.sort()
}

/** Remove obsolete multi-instance CubeSigner values generated by older CLIs. */
export function removeRetiredCubesignerInstanceValues(valuesDir: string): string[] {
  if (!fs.existsSync(valuesDir)) return []
  const removed: string[] = []
  for (const file of fs.readdirSync(valuesDir)) {
    if (!/^cube(?:signer-){2}production-\d+\.yaml$/.test(file)) continue
    fs.rmSync(path.join(valuesDir, file))
    removed.push(file)
  }

  return removed.sort()
}

function removeChartResourceNameOverrides(values: any): void {
  if (!values.global) return
  delete values.global.fullnameOverride
  delete values.global.nameOverride
  if (Object.keys(values.global).length === 0) delete values.global
}

const ETH_DA_ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'

const FEE_ORACLE_LEGACY_CONFIGMAP_PREFIXES = [
  'DOGEOS_FEE_ORACLE_DOGECOIN__',
  'DOGEOS_FEE_ORACLE_CELESTIA__',
  'DOGEOS_FEE_ORACLE_THRESHOLDS__',
  'DOGEOS_FEE_ORACLE_DEPLOYMENT__',
]

const FEE_ORACLE_LEGACY_CONFIGMAP_KEYS = new Set([
  'DOGEOS_FEE_ORACLE_PRICE_ORACLE__UPDATE_ON_EACH_CYCLE',
])

function removeNamedSecretRef(productionYaml: any, secretName: string, changes: PrepChartChange[]): void {
  if (!Array.isArray(productionYaml.envFrom)) return

  const nextEnvFrom = productionYaml.envFrom.filter((item: any) => item?.secretRef?.name !== secretName)
  if (nextEnvFrom.length === productionYaml.envFrom.length) return

  if (nextEnvFrom.length > 0) {
    productionYaml.envFrom = nextEnvFrom
  } else {
    delete productionYaml.envFrom
  }

  changes.push({ key: `envFrom.${secretName}`, newValue: 'removed', oldValue: 'present' })
}

function removeExternalSecret(productionYaml: any, secretName: string, changes: PrepChartChange[]): void {
  if (!productionYaml.externalSecrets?.[secretName]) return

  delete productionYaml.externalSecrets[secretName]
  if (Object.keys(productionYaml.externalSecrets).length === 0) {
    delete productionYaml.externalSecrets
  }

  changes.push({ key: `externalSecrets.${secretName}`, newValue: 'removed', oldValue: 'present' })
}

function ensureNamedSecretRef(productionYaml: any, secretName: string, changes: PrepChartChange[]): void {
  productionYaml.envFrom ||= []
  if (!Array.isArray(productionYaml.envFrom)) return
  if (productionYaml.envFrom.some((item: any) => item?.secretRef?.name === secretName)) return

  productionYaml.envFrom.push({ secretRef: { name: secretName } })
  changes.push({ key: `envFrom.${secretName}`, newValue: 'present', oldValue: 'missing' })
}

export function scrubFeeOracleLegacyValues(productionYaml: any): PrepChartChange[] {
  const changes: PrepChartChange[] = []
  const envData = productionYaml.configMaps?.env?.data

  if (envData && typeof envData === 'object') {
    for (const key of Object.keys(envData)) {
      if (
        FEE_ORACLE_LEGACY_CONFIGMAP_KEYS.has(key) ||
        FEE_ORACLE_LEGACY_CONFIGMAP_PREFIXES.some(prefix => key.startsWith(prefix))
      ) {
        const oldValue = envData[key]
        delete envData[key]
        changes.push({
          key: `configMaps.env.data.${key}`,
          newValue: 'removed',
          oldValue: String(oldValue ?? 'undefined'),
        })
      }
    }
  }

  if (Array.isArray(productionYaml.env)) {
    const nextEnv = productionYaml.env.filter((item: any) => typeof item?.name !== 'string' || !item.name.startsWith('FEE_ORACLE_'))
    if (nextEnv.length !== productionYaml.env.length) {
      for (const item of productionYaml.env) {
        if (typeof item?.name === 'string' && item.name.startsWith('FEE_ORACLE_')) {
          changes.push({
            key: `env.${item.name}`,
            newValue: 'removed',
            oldValue: String(item.value ?? 'undefined'),
          })
        }
      }

      productionYaml.env = nextEnv
    }
  }

  return changes
}

export function applyConfigMapEnvValues(
  productionYaml: any,
  envValues: Record<string, string | undefined>
): PrepChartChange[] {
  const changes: PrepChartChange[] = []
  const envData = productionYaml.configMaps?.env?.data
  if (!envData || typeof envData !== 'object') return changes

  for (const [envKey, newValue] of Object.entries(envValues)) {
    if (newValue === undefined || newValue === null || String(newValue).trim() === '') continue

    const oldValue = envData[envKey]
    if (oldValue !== newValue) {
      envData[envKey] = newValue
      changes.push({
        key: `configMaps.env.data.${envKey}`,
        newValue,
        oldValue: String(oldValue ?? 'undefined'),
      })
    }
  }

  return changes
}

export function applyFeeOracleCurrentEnv(
  productionYaml: any,
  envValues: Record<string, string | undefined>
): PrepChartChange[] {
  return applyConfigMapEnvValues(productionYaml, envValues)
}

export function buildFeeOraclePrepEnv(input: {
  ethereumDaRpcUrl: string | undefined
  gasOracleContract: string | undefined
  l2ChainId: number | string | undefined
  l2RpcUrl: string | undefined
}): Record<string, string | undefined> {
  return {
    DOGEOS_FEE_ORACLE_ETHEREUM_DA__ETH_RPC_URL: input.ethereumDaRpcUrl,
    DOGEOS_FEE_ORACLE_L2__CHAIN_ID: input.l2ChainId === undefined ? undefined : String(input.l2ChainId),
    DOGEOS_FEE_ORACLE_L2__GAS_ORACLE_CONTRACT: input.gasOracleContract,
    DOGEOS_FEE_ORACLE_L2__RPC_URL: input.l2RpcUrl,
  }
}

export function buildEthDaSubmitterPrepEnv(input: {
  batch?: NonNullable<NonNullable<DogeConfig['ethereumDa']>['batch']> | undefined
  ethereumChainId: number | string | undefined
  ethereumRpcUrl: string | undefined
  l2ChainId: number | string | undefined
  l2RpcUrl: string | undefined
  l2StartBlockNumber?: number | string | undefined
  publish?: NonNullable<NonNullable<DogeConfig['ethereumDa']>['publish']> | undefined
  s3Bucket?: string | undefined
  s3Enabled?: boolean | string | undefined
  s3EndpointUrl?: string | undefined
  s3ForcePathStyle?: boolean | string | undefined
  s3InitialBackoffMs?: number | string | undefined
  s3KeyPrefix?: string | undefined
  s3MaxBackoffMs?: number | string | undefined
  s3MaxRetries?: number | string | undefined
  s3PollIntervalMs?: number | string | undefined
  s3Region?: string | undefined
  s3UploadingTimeoutMs?: number | string | undefined
}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__ETH_CHAIN_ID: input.ethereumChainId === undefined ? undefined : String(input.ethereumChainId),
    DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__L2_CHAIN_ID: input.l2ChainId === undefined ? undefined : String(input.l2ChainId),
    DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__RPC_URL: input.ethereumRpcUrl,
    DOGEOS_ETH_DA_SUBMITTER_L2__RPC_URL: input.l2RpcUrl,
    DOGEOS_ETH_DA_SUBMITTER_L2__START_BLOCK_NUMBER: optionalConfigString(input.l2StartBlockNumber),
  }

  const {batch} = input
  if (batch) {
    const {cutover} = batch
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__COMPRESSION = optionalConfigString(batch.compression) ?? 'auto'
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_BATCH_HASH = optionalConfigString(batch.genesisBatchHash) ?? optionalConfigString(cutover?.lastBatchHash) ?? ETH_DA_ZERO_HASH
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_NEXT_RELAYED_DEPOSIT_INDEX = String(batch.genesisNextRelayedDepositIndex ?? cutover?.nextRelayedDepositIndex ?? 0)
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_NEXT_WITHDRAW_INDEX = String(batch.genesisNextWithdrawIndex ?? cutover?.nextWithdrawIndex ?? 0)
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_RELAYED_DEPOSIT_QUEUE_HASH = optionalConfigString(batch.genesisRelayedDepositQueueHash) ?? optionalConfigString(cutover?.relayedDepositQueueHash) ?? ETH_DA_ZERO_HASH
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_STATE_ROOT = optionalConfigString(batch.genesisStateRoot) ?? optionalConfigString(cutover?.stateRoot) ?? ETH_DA_ZERO_HASH
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_WITHDRAW_ROOT = optionalConfigString(batch.genesisWithdrawRoot) ?? optionalConfigString(cutover?.withdrawRoot) ?? ETH_DA_ZERO_HASH
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_BLOCKS_PER_CHUNK = String(batch.maxBlocksPerChunk ?? 128)
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_CHUNKS_PER_BATCH = String(batch.maxChunksPerBatch ?? 1)
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_L2_GAS_PER_CHUNK = String(batch.maxL2GasPerChunk ?? 6_000_000)
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_UNCOMPRESSED_BATCH_BYTES_SIZE = String(batch.maxUncompressedBatchBytesSize ?? 131_072)
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__MIN_CODEC_VERSION = String(batch.minCodecVersion ?? 10)

    if (normalizeInitialBatchSidecarJson(batch.initialBatchSidecarJson)) {
      env.DOGEOS_ETH_DA_SUBMITTER_BATCH__INITIAL_BATCH_SIDECAR_JSON = '/app/config/initial_batch.json'
    }

    if (cutover) {
      env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__LAST_BATCH_HASH = optionalConfigString(cutover.lastBatchHash)
      env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__LAST_BATCH_INDEX = optionalConfigString(cutover.lastBatchIndex)
      env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__NEXT_RELAYED_DEPOSIT_INDEX = optionalConfigString(cutover.nextRelayedDepositIndex)
      env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__NEXT_WITHDRAW_INDEX = optionalConfigString(cutover.nextWithdrawIndex)
      env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__RELAYED_DEPOSIT_QUEUE_HASH = optionalConfigString(cutover.relayedDepositQueueHash)
      env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__STATE_ROOT = optionalConfigString(cutover.stateRoot)
      env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__WITHDRAW_ROOT = optionalConfigString(cutover.withdrawRoot)
    }
  }

  const {publish} = input
  if (publish) {
    env.DOGEOS_ETH_DA_SUBMITTER_PUBLISH__ALLOW_LIVENESS_BUDGET_OVERRIDE = optionalConfigString(publish.allowLivenessBudgetOverride)
    env.DOGEOS_ETH_DA_SUBMITTER_PUBLISH__BUDGET_WINDOW = optionalConfigString(publish.budgetWindow)
    env.DOGEOS_ETH_DA_SUBMITTER_PUBLISH__HIGH_BACKLOG_THRESHOLD = optionalConfigString(publish.highBacklogThreshold)
    env.DOGEOS_ETH_DA_SUBMITTER_PUBLISH__MAX_BATCH_WAIT = optionalConfigString(publish.maxBatchWait)
    env.DOGEOS_ETH_DA_SUBMITTER_PUBLISH__MAX_BLOBS_PER_TX = optionalConfigString(publish.maxBlobsPerTx)
    env.DOGEOS_ETH_DA_SUBMITTER_PUBLISH__MAX_LIVENESS_DELAY = optionalConfigString(publish.maxLivenessDelay)
    env.DOGEOS_ETH_DA_SUBMITTER_PUBLISH__MAX_PENDING_BLOB_TXS = optionalConfigString(publish.maxPendingBlobTxs)
    env.DOGEOS_ETH_DA_SUBMITTER_PUBLISH__TARGET_BLOBS_PER_TX = optionalConfigString(publish.targetBlobsPerTx)
  }

  if (input.s3Enabled !== undefined) {
    const s3Enabled = truthyConfigValue(input.s3Enabled)
    env.DOGEOS_ETH_DA_SUBMITTER_S3__ENABLED = s3Enabled ? 'true' : 'false'

    if (s3Enabled) {
      env.DOGEOS_ETH_DA_SUBMITTER_S3__BUCKET = optionalConfigString(input.s3Bucket)
      env.DOGEOS_ETH_DA_SUBMITTER_S3__REGION = optionalConfigString(input.s3Region)
      env.DOGEOS_ETH_DA_SUBMITTER_S3__KEY_PREFIX = optionalConfigString(input.s3KeyPrefix)
      env.DOGEOS_ETH_DA_SUBMITTER_S3__ENDPOINT_URL = optionalConfigString(input.s3EndpointUrl)
      env.DOGEOS_ETH_DA_SUBMITTER_S3__FORCE_PATH_STYLE = optionalConfigString(input.s3ForcePathStyle)
      env.DOGEOS_ETH_DA_SUBMITTER_S3__POLL_INTERVAL_MS = optionalConfigString(input.s3PollIntervalMs)
      env.DOGEOS_ETH_DA_SUBMITTER_S3__INITIAL_BACKOFF_MS = optionalConfigString(input.s3InitialBackoffMs)
      env.DOGEOS_ETH_DA_SUBMITTER_S3__MAX_BACKOFF_MS = optionalConfigString(input.s3MaxBackoffMs)
      env.DOGEOS_ETH_DA_SUBMITTER_S3__MAX_RETRIES = optionalConfigString(input.s3MaxRetries)
      env.DOGEOS_ETH_DA_SUBMITTER_S3__UPLOADING_TIMEOUT_MS = optionalConfigString(input.s3UploadingTimeoutMs)
    }
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key]
    }
  }

  return env
}

export function applyEthDaSubmitterInitialBatchSidecar(
  productionYaml: any,
  initialBatchSidecarJson: string | undefined
): PrepChartChange[] {
  const changes: PrepChartChange[] = []
  const sidecarJson = normalizeInitialBatchSidecarJson(initialBatchSidecarJson)
  if (!sidecarJson) return changes

  productionYaml.configMaps ||= {}
  productionYaml.configMaps['initial-batch'] ||= {}
  const initialBatchConfigMap = productionYaml.configMaps['initial-batch']
  const nextConfigMap = {
    ...initialBatchConfigMap,
    data: {
      ...initialBatchConfigMap.data,
      'initial_batch.json': sidecarJson,
    },
    enabled: true,
  }
  const previousConfigMap = JSON.stringify(initialBatchConfigMap)
  productionYaml.configMaps['initial-batch'] = nextConfigMap
  const currentConfigMap = JSON.stringify(nextConfigMap)
  if (previousConfigMap !== currentConfigMap) {
    changes.push({
      key: 'configMaps.initial-batch',
      newValue: currentConfigMap,
      oldValue: previousConfigMap,
    })
  }

  productionYaml.persistence ||= {}
  const previousPersistence = JSON.stringify(productionYaml.persistence['initial-batch'])
  productionYaml.persistence['initial-batch'] = {
    enabled: true,
    items: [{ key: 'initial_batch.json', path: 'initial_batch.json' }],
    mountPath: '/app/config',
    name: '{{ include "scroll.common.lib.chart.names.fullname" . }}-initial-batch',
    readOnly: true,
    type: 'configMap',
  }
  const currentPersistence = JSON.stringify(productionYaml.persistence['initial-batch'])
  if (previousPersistence !== currentPersistence) {
    changes.push({
      key: 'persistence.initial-batch',
      newValue: currentPersistence,
      oldValue: previousPersistence || 'undefined',
    })
  }

  return changes
}

function truthyConfigValue(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.toLowerCase() === 'true')
}

function isConfiguredValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== ''
}

function optionalConfigString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const stringValue = String(value)
  return stringValue.trim() === '' ? undefined : stringValue
}

function normalizeInitialBatchSidecarJson(value: string | undefined): string | undefined {
  const stringValue = optionalConfigString(value)
  if (!stringValue) return undefined
  const trimmed = stringValue.trim()
  try {
    JSON.parse(trimmed)
  } catch {
    throw new Error('ethereumDa.batch.initialBatchSidecarJson must be valid JSON')
  }

  return trimmed
}

function pushConfigValidationError(errors: string[], path: string, message: string): void {
  errors.push(`${path}: ${message}`)
}

function validateOptionalBytes32Config(errors: string[], path: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (!/^0x[\dA-Fa-f]{64}$/.test(String(value))) {
    pushConfigValidationError(errors, path, 'must be a 32-byte 0x-prefixed hex string')
  }
}

function validateRequiredBytes32Config(errors: string[], path: string, value: unknown): void {
  if (!isConfiguredValue(value) || !/^0x[\dA-Fa-f]{64}$/.test(String(value))) {
    pushConfigValidationError(errors, path, 'must be a 32-byte 0x-prefixed hex string')
  }
}

function validateOptionalJsonConfig(errors: string[], path: string, value: string | undefined): void {
  if (value === undefined) return
  if (value.trim() === '') {
    pushConfigValidationError(errors, path, 'must be valid JSON when set')
    return
  }

  try {
    JSON.parse(value.trim())
  } catch {
    pushConfigValidationError(errors, path, 'must be valid JSON')
  }
}

function validateOptionalIntegerConfig(
  errors: string[],
  path: string,
  value: unknown,
  minimum: number,
  description: string
): void {
  if (value === undefined || value === null) return
  if (String(value).trim() === '') {
    pushConfigValidationError(errors, path, `must be ${description}`)
    return
  }

  const parsedValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsedValue) || parsedValue < minimum) {
    pushConfigValidationError(errors, path, `must be ${description}`)
  }
}

function validateRequiredIntegerConfig(
  errors: string[],
  path: string,
  value: unknown,
  minimum: number,
  description: string
): void {
  if (!isConfiguredValue(value)) {
    pushConfigValidationError(errors, path, `must be ${description}`)
    return
  }

  validateOptionalIntegerConfig(errors, path, value, minimum, description)
}

function validateOptionalNonEmptyStringConfig(errors: string[], path: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (String(value).trim() === '') {
    pushConfigValidationError(errors, path, 'must not be empty')
  }
}

export function validateDogeConfigEthereumDaForPrep(ethereumDa: DogeConfig['ethereumDa'] | undefined): void {
  const errors: string[] = []
  const batch = ethereumDa?.batch
  const cutover = batch?.cutover
  const hasCutover = cutover !== undefined
  const hasL2StartBlockNumber = isConfiguredValue(ethereumDa?.l2StartBlockNumber)

  validateOptionalIntegerConfig(errors, 'ethereumDa.l2StartBlockNumber', ethereumDa?.l2StartBlockNumber, 0, 'a non-negative integer')
  if (hasCutover && !hasL2StartBlockNumber) {
    pushConfigValidationError(errors, 'ethereumDa.l2StartBlockNumber', 'must be set when ethereumDa.batch.cutover is set')
  }

  if (!hasCutover && hasL2StartBlockNumber) {
    pushConfigValidationError(errors, 'ethereumDa.batch.cutover', 'must be set when ethereumDa.l2StartBlockNumber is set')
  }

  if (batch) {
    if (batch.compression !== undefined && !['auto', 'none'].includes(String(batch.compression))) {
      pushConfigValidationError(errors, 'ethereumDa.batch.compression', 'must be auto or none')
    }

    validateOptionalBytes32Config(errors, 'ethereumDa.batch.genesisBatchHash', batch.genesisBatchHash)
    validateOptionalBytes32Config(errors, 'ethereumDa.batch.genesisRelayedDepositQueueHash', batch.genesisRelayedDepositQueueHash)
    validateOptionalBytes32Config(errors, 'ethereumDa.batch.genesisStateRoot', batch.genesisStateRoot)
    validateOptionalBytes32Config(errors, 'ethereumDa.batch.genesisWithdrawRoot', batch.genesisWithdrawRoot)
    validateOptionalJsonConfig(errors, 'ethereumDa.batch.initialBatchSidecarJson', batch.initialBatchSidecarJson)
    validateOptionalIntegerConfig(errors, 'ethereumDa.batch.genesisNextRelayedDepositIndex', batch.genesisNextRelayedDepositIndex, 0, 'a non-negative integer')
    validateOptionalIntegerConfig(errors, 'ethereumDa.batch.genesisNextWithdrawIndex', batch.genesisNextWithdrawIndex, 0, 'a non-negative integer')
    validateOptionalIntegerConfig(errors, 'ethereumDa.batch.maxBlocksPerChunk', batch.maxBlocksPerChunk, 1, 'a positive integer')
    validateOptionalIntegerConfig(errors, 'ethereumDa.batch.maxChunksPerBatch', batch.maxChunksPerBatch, 1, 'a positive integer')
    validateOptionalIntegerConfig(errors, 'ethereumDa.batch.maxL2GasPerChunk', batch.maxL2GasPerChunk, 1, 'a positive integer')
    validateOptionalIntegerConfig(errors, 'ethereumDa.batch.maxUncompressedBatchBytesSize', batch.maxUncompressedBatchBytesSize, 1, 'a positive integer')
    validateOptionalIntegerConfig(errors, 'ethereumDa.batch.minCodecVersion', batch.minCodecVersion, 0, 'a non-negative integer')

    if (cutover) {
      validateRequiredIntegerConfig(errors, 'ethereumDa.batch.cutover.lastBatchIndex', cutover.lastBatchIndex, 0, 'a non-negative integer')
      validateRequiredIntegerConfig(errors, 'ethereumDa.batch.cutover.nextRelayedDepositIndex', cutover.nextRelayedDepositIndex, 0, 'a non-negative integer')
      validateRequiredIntegerConfig(errors, 'ethereumDa.batch.cutover.nextWithdrawIndex', cutover.nextWithdrawIndex, 0, 'a non-negative integer')
      validateRequiredBytes32Config(errors, 'ethereumDa.batch.cutover.lastBatchHash', cutover.lastBatchHash)
      validateRequiredBytes32Config(errors, 'ethereumDa.batch.cutover.relayedDepositQueueHash', cutover.relayedDepositQueueHash)
      validateRequiredBytes32Config(errors, 'ethereumDa.batch.cutover.stateRoot', cutover.stateRoot)
      validateRequiredBytes32Config(errors, 'ethereumDa.batch.cutover.withdrawRoot', cutover.withdrawRoot)
    }
  }

  const publish = ethereumDa?.publish
  if (publish) {
    validateOptionalNonEmptyStringConfig(errors, 'ethereumDa.publish.budgetWindow', publish.budgetWindow)
    validateOptionalIntegerConfig(errors, 'ethereumDa.publish.highBacklogThreshold', publish.highBacklogThreshold, 1, 'a positive integer')
    validateOptionalNonEmptyStringConfig(errors, 'ethereumDa.publish.maxBatchWait', publish.maxBatchWait)
    validateOptionalIntegerConfig(errors, 'ethereumDa.publish.maxBlobsPerTx', publish.maxBlobsPerTx, 1, 'a positive integer')
    validateOptionalNonEmptyStringConfig(errors, 'ethereumDa.publish.maxLivenessDelay', publish.maxLivenessDelay)
    validateOptionalIntegerConfig(errors, 'ethereumDa.publish.maxPendingBlobTxs', publish.maxPendingBlobTxs, 1, 'a positive integer')
    validateOptionalIntegerConfig(errors, 'ethereumDa.publish.targetBlobsPerTx', publish.targetBlobsPerTx, 1, 'a positive integer')
  }

  const s3Archive = ethereumDa?.blobArchive?.s3
  if (truthyConfigValue(s3Archive?.enabled)) {
    validateOptionalNonEmptyStringConfig(errors, 'ethereumDa.blobArchive.s3.bucket', s3Archive?.bucket)
    validateOptionalNonEmptyStringConfig(errors, 'ethereumDa.blobArchive.s3.region', s3Archive?.region)
    if (!isConfiguredValue(s3Archive?.bucket)) {
      pushConfigValidationError(errors, 'ethereumDa.blobArchive.s3.bucket', 'must be set when S3 blob archive is enabled')
    }

    if (!isConfiguredValue(s3Archive?.region)) {
      pushConfigValidationError(errors, 'ethereumDa.blobArchive.s3.region', 'must be set when S3 blob archive is enabled')
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid doge-config Ethereum DA config:\n- ${errors.join('\n- ')}`)
  }
}

export function buildL1InterfaceBlobSourcePrepEnv(input: {
  beaconRpcUrl: string | undefined
  s3KeyPrefix?: string | undefined
  s3PublicBaseUrl?: string | undefined
  s3TimeoutMs?: boolean | number | string | undefined
  s3TreatForbiddenAsMissing?: boolean | number | string | undefined
}): Record<string, string | undefined> {
  return {
    DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__KEY_PREFIX: optionalConfigString(input.s3KeyPrefix),
    DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TIMEOUT_MS: optionalConfigString(input.s3TimeoutMs),
    DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TREAT_FORBIDDEN_AS_MISSING: optionalConfigString(input.s3TreatForbiddenAsMissing),
    DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL: optionalConfigString(input.s3PublicBaseUrl),
    DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL: input.beaconRpcUrl,
    DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__TIMEOUT_MS: '10000',
  }
}

export function buildWithdrawalBlobSourcePrepEnv(input: {
  beaconRpcUrl: string | undefined
  s3KeyPrefix?: string | undefined
  s3PublicBaseUrl?: string | undefined
  s3TimeoutMs?: boolean | number | string | undefined
  s3TreatForbiddenAsMissing?: boolean | number | string | undefined
}): Record<string, string | undefined> {
  return {
    DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__KEY_PREFIX: optionalConfigString(input.s3KeyPrefix),
    DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TIMEOUT_MS: optionalConfigString(input.s3TimeoutMs),
    DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TREAT_FORBIDDEN_AS_MISSING: optionalConfigString(input.s3TreatForbiddenAsMissing),
    DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL: optionalConfigString(input.s3PublicBaseUrl),
    DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL: input.beaconRpcUrl,
    DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__TIMEOUT_MS: '10000',
  }
}

export function getEthereumDaS3PublicBaseUrl(s3Archive: NonNullable<NonNullable<NonNullable<DogeConfig['ethereumDa']>['blobArchive']>['s3']> | undefined): string | undefined {
  if (!truthyConfigValue(s3Archive?.enabled)) return undefined
  return buildS3PublicBaseUrl(s3Archive ?? {})
}

export function getEthereumDaS3PublicBlobUrl(s3Archive: NonNullable<NonNullable<NonNullable<DogeConfig['ethereumDa']>['blobArchive']>['s3']> | undefined): string | undefined {
  if (!truthyConfigValue(s3Archive?.enabled)) return undefined
  return buildS3PublicPrefixUrl(s3Archive ?? {})
}

export function applyRethBlobS3Url(
  productionYaml: any,
  blobS3Url: string | undefined = ''
): PrepChartChange[] {
  const changes: PrepChartChange[] = []
  productionYaml.reth ||= {}
  const nextValue = blobS3Url
  const oldValue = productionYaml.reth.blobS3Url
  if (oldValue !== nextValue) {
    productionYaml.reth.blobS3Url = nextValue
    changes.push({
      key: 'reth.blobS3Url',
      newValue: nextValue,
      oldValue: String(oldValue ?? 'undefined'),
    })
  }

  return changes
}

export function applyRethNetworkId(
  productionYaml: any,
  networkId: string | undefined,
): PrepChartChange[] {
  if (networkId === undefined) return []

  productionYaml.reth ||= {}
  const oldValue = productionYaml.reth.networkId
  if (oldValue === networkId) return []

  productionYaml.reth.networkId = networkId
  return [{
    key: 'reth.networkId',
    newValue: networkId,
    oldValue: String(oldValue ?? 'undefined'),
  }]
}

export function resolveRethP2PNetworkId(
  dogeConfig: Pick<DogeConfig, 'reth'>,
  configuredL2ChainId: unknown,
): string | undefined {
  const configuredNetworkId = dogeConfig.reth?.networkId ?? configuredL2ChainId
  if (configuredNetworkId === undefined || configuredNetworkId === null) return undefined

  const networkId = String(configuredNetworkId).trim()
  if (!/^\d+$/.test(networkId)) {
    throw new Error(`reth.networkId must be a decimal integer, got: ${JSON.stringify(configuredNetworkId)}`)
  }

  return networkId
}

export function isL2RethRpcChart(chartName: string): boolean {
  return chartName === 'l2-reth-rpc' || chartName === 'l2-reth-rpc-public'
}

export function isL2RethBlobS3Chart(chartName: string): boolean {
  return chartName === 'l2-reth-bootnode' ||
    chartName === 'l2-reth-sequencer' ||
    isL2RethRpcChart(chartName)
}

export function getProductionChartName(fileName: string): string {
  return fileName.replace(/-production(-\d+)?\.yaml$/, '')
}

export function getL2RethRpcIngressConfigKey(
  chartName: string,
  ingressKey: string
): string | undefined {
  if (!isL2RethRpcChart(chartName)) return undefined
  return ingressKey === 'websocket' ? 'RPC_GATEWAY_WS_HOST' : 'RPC_GATEWAY_HOST'
}

export function applyL2RethRpcRuntimeValues(
  productionYaml: any,
  values: {
    blobS3Url: string | undefined
    l1Url: string
    networkId: string | undefined
    trustedPeers: string
  }
): PrepChartChange[] {
  const changes: PrepChartChange[] = []
  productionYaml.reth ||= {}

  for (const [key, newValue] of Object.entries({
    l1Url: values.l1Url,
    trustedPeers: values.trustedPeers,
  })) {
    if (newValue === undefined || productionYaml.reth[key] === newValue) continue
    const oldValue = productionYaml.reth[key]
    productionYaml.reth[key] = newValue
    changes.push({
      key: `reth.${key}`,
      newValue,
      oldValue: String(oldValue ?? 'undefined'),
    })
  }

  changes.push(
    ...applyRethNetworkId(productionYaml, values.networkId),
    ...applyRethBlobS3Url(productionYaml, values.blobS3Url),
  )
  return changes
}

export function applyL2RethRpcPublicIngressPolicy(productionYaml: any): PrepChartChange[] {
  const changes: PrepChartChange[] = []
  const { ingress } = productionYaml
  if (!ingress || typeof ingress !== 'object') return changes

  for (const ingressKey of ['main', 'websocket']) {
    const ingressValue = ingress[ingressKey]
    if (!ingressValue || typeof ingressValue !== 'object') continue

    if (ingressValue.enabled !== true) {
      changes.push({
        key: `ingress.${ingressKey}.enabled`,
        newValue: 'true',
        oldValue: String(ingressValue.enabled ?? 'undefined'),
      })
      ingressValue.enabled = true
    }

    ingressValue.annotations ||= {}
    const issuerKey = 'cert-manager.io/cluster-issuer'
    if (ingressValue.annotations[issuerKey] !== 'letsencrypt-prod') {
      changes.push({
        key: `ingress.${ingressKey}.annotations.${issuerKey}`,
        newValue: 'letsencrypt-prod',
        oldValue: String(ingressValue.annotations[issuerKey] ?? 'undefined'),
      })
      ingressValue.annotations[issuerKey] = 'letsencrypt-prod'
    }

    const ingressHosts = Array.isArray(ingressValue.hosts)
      ? ingressValue.hosts.map((host: { host?: unknown }) => host.host).filter((host: unknown): host is string => typeof host === 'string')
      : []
    if (ingressHosts.length === 0 || !Array.isArray(ingressValue.tls)) continue

    for (const [tlsIndex, tlsEntry] of ingressValue.tls.entries()) {
      if (!tlsEntry || typeof tlsEntry !== 'object') continue
      const oldTlsHosts = Array.isArray(tlsEntry.hosts) ? tlsEntry.hosts : []
      if (JSON.stringify(oldTlsHosts) === JSON.stringify(ingressHosts)) continue
      changes.push({
        key: `ingress.${ingressKey}.tls[${tlsIndex}].hosts`,
        newValue: JSON.stringify(ingressHosts),
        oldValue: JSON.stringify(oldTlsHosts),
      })
      tlsEntry.hosts = ingressHosts
    }
  }

  return changes
}

export function removeL2GethBlobS3ExtraParams(productionYaml: any): PrepChartChange[] {
  const changes: PrepChartChange[] = []
  const envData = productionYaml.configMaps?.env?.data
  if (!envData || typeof envData !== 'object') return changes

  if ('L2GETH_EXTRA_PARAMS' in envData) {
    const oldValue = envData.L2GETH_EXTRA_PARAMS
    delete envData.L2GETH_EXTRA_PARAMS
    changes.push({
      key: 'configMaps.env.data.L2GETH_EXTRA_PARAMS',
      newValue: 'removed',
      oldValue: String(oldValue),
    })
  }

  return changes
}

export function removeConfigMapEnvKeys(
  productionYaml: any,
  envKeys: string[]
): PrepChartChange[] {
  const changes: PrepChartChange[] = []
  const envData = productionYaml.configMaps?.env?.data
  if (!envData || typeof envData !== 'object') return changes

  for (const envKey of envKeys) {
    if (!(envKey in envData)) continue

    const oldValue = envData[envKey]
    delete envData[envKey]
    changes.push({
      key: `configMaps.env.data.${envKey}`,
      newValue: 'removed',
      oldValue: String(oldValue ?? 'undefined'),
    })
  }

  return changes
}

export function scrubL1InterfaceRetiredEnv(productionYaml: any): PrepChartChange[] {
  return removeConfigMapEnvKeys(productionYaml, [
    'DOGEOS_L1_INTERFACE_INITIAL_SYSTEM_SIGNER',
  ])
}

export function removeEnvArrayKeys(
  productionYaml: any,
  envKeys: string[]
): PrepChartChange[] {
  const changes: PrepChartChange[] = []
  if (!Array.isArray(productionYaml.env)) return changes

  const envKeySet = new Set(envKeys)
  const nextEnv = []
  for (const item of productionYaml.env) {
    if (typeof item?.name === 'string' && envKeySet.has(item.name)) {
      changes.push({
        key: `env.${item.name}`,
        newValue: 'removed',
        oldValue: String(item.value ?? 'undefined'),
      })
      continue
    }

    nextEnv.push(item)
  }

  if (nextEnv.length !== productionYaml.env.length) {
    productionYaml.env = nextEnv
  }

  return changes
}

const WITHDRAWAL_LEGACY_PROOF_ENV_KEYS = new Set([
  'DOGEOS_WITHDRAWAL_COORDINATOR_POLL_INTERVAL_SECS',
  'DOGEOS_WITHDRAWAL_PROVING_MODE',
  'DOGEOS_WITHDRAWAL_SCROLL_PROOF_INPUT_POLICY',
  'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__PROOF_MODE',
  'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__VERIFICATION_POLICY',
  'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__VERIFIER_IMPORT_MODE',
])

const WITHDRAWAL_LEGACY_PROOF_ENV_PREFIXES = [
  'DOGEOS_WITHDRAWAL_PROOF_ARTIFACT_TRANSPORT__',
  'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__',
  'DOGEOS_WITHDRAWAL_PROOF_TASK_POLICY__',
  'DOGEOS_WITHDRAWAL_PROOF_EXECUTION_WORKER__',
  'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__',
  'DOGEOS_WITHDRAWAL_PROOF_WORK_API__',
  'DOGEOS_WITHDRAWAL_LOCAL_BRIDGE_PROOF_RUNTIME__',
  'DOGEOS_WITHDRAWAL_SCROLL_WORKER_API__',
]

/** Remove retired fields and proof settings now owned by WithdrawalProcessor.toml. */
export function scrubWithdrawalLegacyProofEnv(productionYaml: any): PrepChartChange[] {
  const changes: PrepChartChange[] = []
  if (!Array.isArray(productionYaml.env)) return changes

  const nextEnv = []
  for (const item of productionYaml.env) {
    const name = typeof item?.name === 'string' ? item.name : ''
    const retired = !isWithdrawalProofActivationEnv(name) && (
      WITHDRAWAL_LEGACY_PROOF_ENV_KEYS.has(name)
      || WITHDRAWAL_LEGACY_PROOF_ENV_PREFIXES.some(prefix => name.startsWith(prefix))
    )
    if (retired) {
      changes.push({
        key: `env.${name}`,
        newValue: 'removed',
        oldValue: String(item.value ?? 'undefined'),
      })
      continue
    }

    nextEnv.push(item)
  }

  if (nextEnv.length !== productionYaml.env.length) productionYaml.env = nextEnv
  return changes
}

export default class SetupPrepCharts extends Command {
  static override description = 'Validate Makefile and prepare Helm charts for Scroll SDK'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --spec deployment-spec.yaml',
    '<%= config.bin %> <%= command.id %> --github-username=your-username --github-token=your-token',
    '<%= config.bin %> <%= command.id %> --values-dir=./custom-values',
    '<%= config.bin %> <%= command.id %> --skip-auth-check',
    '<%= config.bin %> <%= command.id %> --skip-l2-contract-deployment-block',
  ]

  static override flags = {
    'doge-config': Flags.string({ description: 'Path to Dogecoin config file' }),
    'github-token': Flags.string({ description: 'GitHub Personal Access Token', required: false }),
    'github-username': Flags.string({ description: 'GitHub username', required: false }),
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts. Auto-applies all detected changes.',
    }),
    'skip-auth-check': Flags.boolean({ default: false, description: 'Skip authentication check for individual charts' }),
    'skip-l2-contract-deployment-block': Flags.boolean({
      default: false,
      description: 'Do not overwrite L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK in L2 production values files',
    }),
    spec: Flags.string({
      description: 'Optional DeploymentSpec proof-intent source; auto-detects deployment-spec.yaml/yml when omitted',
    }),
    'values-dir': Flags.string({ default: './values', description: 'Directory containing values files; must be inside the deployment root for transactional generation' }),
  }

  private bridgeConfig: any = {}

  private configData: any = {}

  private configMapping: Record<string, ((chartName: string, productionNumber: string) => string) | string> = {
    'ADMIN_SYSTEM_DASHBOARD_HOST': 'ingress.ADMIN_SYSTEM_DASHBOARD_HOST',
    'BLOCKSCOUT_HOST': 'ingress.BLOCKSCOUT_HOST',
    'BRIDGE_HISTORY_API_HOST': 'ingress.BRIDGE_HISTORY_API_HOST',
    'CHAIN_ID': 'general.CHAIN_ID_L2',
    'CHAIN_ID_L1': 'general.CHAIN_ID_L1',
    'CHAIN_ID_L2': 'general.CHAIN_ID_L2',
    'COORDINATOR_API_HOST': 'ingress.COORDINATOR_API_HOST',
    'DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__ETH_CHAIN_ID': 'ethereumDa.chainId',
    'DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__L2_CHAIN_ID': 'general.CHAIN_ID_L2',
    'DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__RPC_URL': 'ethereumDa.submitterRpcUrl',
    'DOGEOS_ETH_DA_SUBMITTER_L2__RPC_URL': 'general.L2_RPC_ENDPOINT',
    'DOGEOS_WITHDRAWAL_ETHEREUM_DA__ETH_CHAIN_ID': 'ethereumDa.chainId',
    'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__EXPECTED_BATCHERS': 'signers.l1CommitSender.expectedAddress',
    'DOGEOS_WITHDRAWAL_ETHEREUM_DA__L1_RPC_URL': 'ethereumDa.submitterRpcUrl',
    'DOGEOS_WITHDRAWAL_ETHEREUM_DA__L2_CHAIN_ID': 'general.CHAIN_ID_L2',
    // Add ingress host mappings
    'FRONTEND_HOST': 'ingress.FRONTEND_HOST',
    'GRAFANA_HOST': 'ingress.GRAFANA_HOST',
    'L1_DEVNET_HOST': 'ingress.L1_DEVNET_HOST',
    'L1_EXPLORER_HOST': 'ingress.L1_EXPLORER_HOST',
    'L1_RPC_ENDPOINT': 'general.L1_RPC_ENDPOINT',
    'L1_SCROLL_CHAIN_PROXY_ADDR': 'contractsFile.L1_SCROLL_CHAIN_PROXY_ADDR',
    'L2_RPC_ENDPOINT': 'general.L2_RPC_ENDPOINT',
    // 'L2GETH_NODEKEY': (chartName, productionNumber) =>
    //   chartName.startsWith('l2-bootnode') ? `bootnode.bootnode-${productionNumber}.L2GETH_NODEKEY` :
    //     (productionNumber === '0' ? 'sequencer.L2GETH_NODEKEY' : `sequencer.sequencer-${productionNumber}.L2GETH_NODEKEY`),
    'L2GETH_KEYSTORE': (chartName, productionNumber) =>
      productionNumber === '0' ? 'sequencer.L2GETH_KEYSTORE' : `sequencer.sequencer-${productionNumber}.L2GETH_KEYSTORE`,
    'L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK': 'general.L1_CONTRACT_DEPLOYMENT_BLOCK',
    'L2GETH_PASSWORD': (chartName, productionNumber) =>
      productionNumber === '0' ? 'sequencer.L2GETH_PASSWORD' : `sequencer.sequencer-${productionNumber}.L2GETH_PASSWORD`,
    'L2GETH_PEER_LIST': 'sequencer.L2_GETH_STATIC_PEERS',
    'L2GETH_SIGNER_ADDRESS': (chartName, productionNumber) =>
      productionNumber === '0' ? 'sequencer.L2GETH_SIGNER_ADDRESS' : `sequencer.sequencer-${productionNumber}.L2GETH_SIGNER_ADDRESS`,
    'ROLLUP_EXPLORER_API_HOST': 'ingress.ROLLUP_EXPLORER_API_HOST',
    'RPC_GATEWAY_HOST': 'ingress.RPC_GATEWAY_HOST',
    'RPC_GATEWAY_WS_HOST': 'ingress.RPC_GATEWAY_WS_HOST',
    'SCROLL_L1_RPC': 'general.L1_RPC_ENDPOINT',
    'SCROLL_L2_RPC': 'general.L2_RPC_ENDPOINT',

    // Add more mappings as needed
  }

  private contractsConfig: any = {}
  private dogeConfig: DogeConfig = {} as DogeConfig
  private flags: any
  private jsonCtx!: JsonOutputContext
  private jsonMode: boolean = false
  private nonInteractive: boolean = false
  private outputTestData: Record<string, any> = {}
  private proofIntent!: ResolvedProofIntent
  private skipL2ContractDeploymentBlock: boolean = false
  private withdrawalProcessorConfig: toml.JsonMap = {}

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupPrepCharts)

    // Setup non-interactive/JSON mode
    this.nonInteractive = flags['non-interactive']
    this.jsonMode = flags.json
    this.skipL2ContractDeploymentBlock = flags['skip-l2-contract-deployment-block']
    this.jsonCtx = new JsonOutputContext('setup prep-charts', this.jsonMode)

    this.jsonCtx.info('Starting chart preparation...')

    // Load configs before processing yaml files
    await this.loadConfigs(flags)

    if (flags['github-username'] && flags['github-token']) {
      try {
        await this.authenticateGHCR(flags['github-username'], flags['github-token'])
      } catch {
        this.jsonCtx.addWarning('Failed to authenticate with GitHub Container Registry')
      }
    }

    let skipAuthCheck = flags['skip-auth-check']
    if (!skipAuthCheck && !this.nonInteractive) {
      skipAuthCheck = !(await confirm({ message: 'Do you want to perform authentication checks for individual charts?' }))
    } else if (this.nonInteractive && !skipAuthCheck) {
      // In non-interactive mode, default to skipping auth check unless explicitly configured
      skipAuthCheck = true
      this.jsonCtx.info('Non-interactive mode: Skipping authentication checks')
    }

    // Validate Makefile
    await this.validateMakefile(skipAuthCheck)

    const deploymentRoot = process.cwd()
    const originalValuesDir = path.resolve(deploymentRoot, flags['values-dir'])
    const transaction = GenerationTransaction.begin(deploymentRoot)
    let generation: PrepChartGenerationResult
    let changedFiles: string[] = []
    try {
      const stagedValuesDir = transaction.toStagingPath(originalValuesDir)
      this.proofIntent = this.rebaseProofIntentForStaging(
        transaction,
        this.proofIntent,
      )
      process.chdir(transaction.stagingRoot)
      generation = await this.generateCharts(stagedValuesDir)
      process.chdir(deploymentRoot)
      changedFiles = transaction.commit().changedFiles
    } catch (error) {
      process.chdir(deploymentRoot)
      transaction.rollback()
      throw error
    }

    const {
      proof: stagedProof,
      skippedBootnodeRethInstances,
      skippedConfig,
      skippedInstances,
      skippedProduction,
      skippedRethInstances,
      updatedBootnodeRethInstances,
      updatedConfig,
      updatedInstances,
      updatedProduction,
      updatedRethInstances,
    } = generation
    const proof = this.rebaseProofResultFromStaging(transaction, stagedProof)
    const valuesDir = originalValuesDir

    this.jsonCtx.logSuccess(`Updated instance-specific YAML files for ${updatedInstances + updatedBootnodeRethInstances + updatedRethInstances} chart(s).`);
    this.jsonCtx.info(`Skipped ${skippedInstances + skippedBootnodeRethInstances + skippedRethInstances} instance-specific chart(s).`);

    this.jsonCtx.logSuccess(`Updated production YAML files for ${updatedProduction} chart(s).`)
    this.jsonCtx.info(`Skipped ${skippedProduction} chart(s).`)

    this.jsonCtx.logSuccess(`Updated config YAML files for ${updatedConfig} chart(s).`);
    this.jsonCtx.info(`Skipped ${skippedConfig} chart(s).`);

    this.jsonCtx.logSuccess('Chart preparation completed.')

    // JSON output
    if (this.jsonMode) {
      this.jsonCtx.success({
        configCharts: { skipped: skippedConfig, updated: updatedConfig },
        generation: {
          changedFiles,
          committed: true,
        },
        instanceCharts: {
          skipped: skippedInstances + skippedBootnodeRethInstances + skippedRethInstances,
          updated: updatedInstances + updatedBootnodeRethInstances + updatedRethInstances,
        },
        productionCharts: { skipped: skippedProduction, updated: updatedProduction },
        proof: {
          contract: proof.contract,
          files: proof.files,
          mode: proof.mode,
          scaffoldedCoordinatorConfig: proof.scaffoldedCoordinatorConfig,
          workerBundle: proof.workerBundle,
        },
        totalSkipped: skippedInstances + skippedBootnodeRethInstances + skippedRethInstances + skippedProduction + skippedConfig,
        totalUpdated: updatedInstances + updatedBootnodeRethInstances + updatedRethInstances + updatedProduction + updatedConfig,
        valuesDir,
      })
    }
  }

  private async authenticateGHCR(username: string, token: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', ['login', 'ghcr.io', '-u', username, '--password-stdin'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child.stdin.write(token)
      child.stdin.end()
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`docker login exited with code ${code}`))
      })
      child.on('error', reject)
    })
    this.log('Authenticated with GitHub Container Registry')
  }

  private buildBootnodeRethResolvedConfig(index: number): ResolvedBootnodeRethConfig {
    const instance = this.dogeConfig.bootnodeReth?.instances?.find(item => item.index === index)
    if (!instance) {
      this.error(`bootnodeReth.instances does not contain index ${index}. Run scrollsdk setup l2-bootnode-reth first.`)
    }

    const nodekey = instance.nodekey?.privateKey
    if (!nodekey) {
      this.error(`bootnodeReth.instances[index=${index}].nodekey.privateKey is missing. Run scrollsdk setup l2-bootnode-reth first.`)
    }

    return {
      enodeUrl: instance.enodeUrl || deriveBootnodeRethEnodeUrl(nodekey, index),
      index,
      nodekey,
      secretMode: instance.nodekey?.secretMode || 'external-secret',
      secretName: `${getBootnodeRethResourceName(index)}-secret-env`,
    }
  }

  private buildFreshL2GethPeerList(): string {
    return buildL2GethInitialPeerList(
      this.getLegacySequencerPeers(),
      this.getRethSequencerPeers(),
    )
  }

  private buildFreshRethTrustedPeers(): string {
    return buildRethInitialTrustedPeers(
      this.getLegacySequencerPeers(),
      this.getRethSequencerPeers(),
    )
  }

  private buildSequencerRethResolvedConfig(index: number): ResolvedSequencerRethConfig {
    const instance = this.dogeConfig.sequencerReth?.instances?.find(item => item.index === index)
    if (!instance) {
      this.error(`sequencerReth.instances does not contain index ${index}. Run scrollsdk setup l2-sequencer-reth --index ${index} first.`)
    }

    const nodekey = instance.nodekey?.privateKey
    if (!nodekey) {
      this.error(`sequencerReth.instances[index=${index}].nodekey.privateKey is missing. Run scrollsdk setup l2-sequencer-reth --index ${index} first.`)
    }

    const {signer} = instance
    if (!signer?.mode) {
      this.error(`sequencerReth.instances[index=${index}].signer.mode is missing. Run scrollsdk setup l2-sequencer-reth --index ${index} first.`)
    }

    const signerMode = signerModeToConfig(normalizeSignerMode(signer.mode))

    if (signerMode.signerBackend === 'local' && !signer.privateKey) {
      this.error(`sequencerReth.instances[index=${index}].signer.privateKey is missing for local signer backend.`)
    }

    if (signerMode.signerBackend === 'aws_kms' && !signer.kmsKeyId) {
      this.error(`sequencerReth.instances[index=${index}].signer.kmsKeyId is missing for AWS KMS signer backend.`)
    }

    return {
      index,
      nodekey,
      secretMode: instance.nodekey?.secretMode || signerMode.secretMode,
      secretName: `${getSequencerRethResourceName(index)}-secret-env`,
      signer: {
        address: signer.address,
        backend: signerMode.signerBackend,
        kmsKeyArn: signer.kmsKeyArn,
        kmsKeyId: signer.kmsKeyId,
        kmsRegion: signer.kmsRegion,
        privateKey: signer.privateKey,
        serviceAccountName: signer.serviceAccountName,
        serviceAccountRoleArn: signer.serviceAccountRoleArn,
      },
      signerMode: signerMode.mode,
    }
  }

  private deriveLegacySequencerEnodeUrl(nodekey: string, index: number): string {
    const wallet = new Wallet(`0x${normalizeRethNodekey(nodekey)}`)
    const publicKeyNoPrefix = wallet.signingKey.publicKey.slice(4)
    return `enode://${publicKeyNoPrefix}@l2-sequencer-${index}:30303`
  }

  private formatUrl(baseUrl: string, path: string = ''): string {
    // Remove trailing slash from baseUrl
    const cleanBase = baseUrl.replace(/\/+$/, '');
    // Remove leading slash from path and ensure it starts with a single slash if not empty
    const cleanPath = path ? '/' + path.replace(/^\/+/, '') : '';
    return cleanBase + cleanPath;
  }

  private async generateCharts(valuesDir: string): Promise<PrepChartGenerationResult> {
    const {skipped: skippedInstances, updated: updatedInstances} =
      await this.processMutipleInstance(valuesDir)
    const {
      skipped: skippedBootnodeRethInstances,
      updated: updatedBootnodeRethInstances,
    } = await this.processBootnodeRethInstanceFiles(valuesDir)
    const {skipped: skippedRethInstances, updated: updatedRethInstances} =
      await this.processSequencerRethInstanceFiles(valuesDir)
    const {skipped: skippedProduction, updated: updatedProduction} =
      await this.processProductionYaml(valuesDir)
    const {skipped: skippedConfig, updated: updatedConfig} =
      await this.processConfigYaml(valuesDir)
    const proof = this.reconcileProofKubernetes(valuesDir)
    return {
      proof,
      skippedBootnodeRethInstances,
      skippedConfig,
      skippedInstances,
      skippedProduction,
      skippedRethInstances,
      updatedBootnodeRethInstances,
      updatedConfig,
      updatedInstances,
      updatedProduction,
      updatedRethInstances,
    }
  }

  private getBaseUrl(url?: string) {
    if (!url) return url;
    try {
      const urlObj = new URL(url);
      if (urlObj.pathname.endsWith('/api/v2')) {
        urlObj.pathname = urlObj.pathname.slice(0, -7) + '/api';
      }

      let urlString = urlObj.toString();
      // Remove trailing slash if it exists
      if (urlString.endsWith('/')) {
        urlString = urlString.slice(0, -1);
      }

      return urlString;
    } catch {
      return url;
    }
  }

  private getConfigValue(key: string): any {
    const [configType, ...rest] = key.split('.')
    const configKey = rest.join('.')

    if (configType === 'contractsFile') {
      return this.getNestedValue(this.contractsConfig, configKey)
    }
 
      return this.getNestedValue(this.configData, key)
    
  }

  private getFixedL2NodeEnvValue(chartName: string, key: string): string | undefined {
    if (key === 'L2GETH_L1_ENDPOINT') return L1_INTERFACE_RPC_ENDPOINT
    if (key === 'L2GETH_DA_BLOB_BEACON_NODE') return L1_INTERFACE_BEACON_API_ENDPOINT
    if (key === 'L2GETH_PEER_LIST' && this.isL2GethNode(chartName)) {
      return this.buildFreshL2GethPeerList()
    }
  }

  private getIngressHostConfigValue(chartName: string, ingressKey: string): string | undefined {
    const rethRpcConfigKey = getL2RethRpcIngressConfigKey(chartName, ingressKey)
    if (rethRpcConfigKey) {
      return this.getConfigValue(`ingress.${rethRpcConfigKey}`)
    }

    if ((chartName === 'l2-rpc' || chartName === 'l2-rpc-reth' || chartName === 'l2-reth-rpc') && ingressKey === 'websocket') {
      return this.getConfigValue('ingress.RPC_GATEWAY_WS_HOST')
    }

    const directMappingKey = `ingress.${chartName.toUpperCase().replaceAll('-', '_')}_HOST`
    const directValue = this.getConfigValue(directMappingKey)
    this.log(chalk.yellow(`${chartName}: ${directMappingKey} -> ${directValue}`))
    if (directValue) return directValue

    const alternativeMappings: Record<string, string> = {
      'admin-system-dashboard': 'ADMIN_SYSTEM_DASHBOARD_HOST',
      blockbook: 'BLOCKBOOK_HOST',
      blockscout: 'BLOCKSCOUT_HOST',
      'bridge-history-api': 'BRIDGE_HISTORY_API_HOST',
      'coordinator-api': 'COORDINATOR_API_HOST',
      dogecoin: 'DOGECOIN_HOST',
      frontends: 'FRONTEND_HOST',
      'l1-devnet': 'L1_DEVNET_HOST',
      'l2-reth-rpc': 'RPC_GATEWAY_HOST',
      'l2-rpc': 'RPC_GATEWAY_HOST',
      'l2-rpc-reth': 'RPC_GATEWAY_HOST',
      'rollup-explorer-backend': 'ROLLUP_EXPLORER_API_HOST',
      'tso-service': 'TSO_HOST',
    }
    const alternativeKey = alternativeMappings[chartName]
    if (!alternativeKey) {
      this.jsonCtx.addWarning(`${chartName}: no ingress host mapping for ${directMappingKey}; leaving ingress host unchanged.`)
      return undefined
    }

    const alternativeValue = this.getConfigValue(`ingress.${alternativeKey}`)
    if (!alternativeValue) {
      this.jsonCtx.addWarning(`${chartName}: ingress.${alternativeKey} is not configured; leaving ingress host unchanged.`)
    }

    return alternativeValue
  }

  private getLegacySequencerPeers(): string[] {
    const sequencerConfig = this.configData.sequencer
    if (!sequencerConfig || typeof sequencerConfig !== 'object') return []

    const peers = this.parsePeerList(sequencerConfig.L2_GETH_STATIC_PEERS)
    if (peers.length > 0) return peers

    const derivedPeers: string[] = []
    if (sequencerConfig.L2GETH_NODEKEY) {
      derivedPeers.push(this.deriveLegacySequencerEnodeUrl(sequencerConfig.L2GETH_NODEKEY, 0))
    }

    for (const [key, value] of Object.entries(sequencerConfig)) {
      const match = key.match(/^sequencer-(\d+)$/)
      if (!match || !value || typeof value !== 'object') continue

      const nodekey = (value as { L2GETH_NODEKEY?: unknown }).L2GETH_NODEKEY
      if (typeof nodekey === 'string' && nodekey.trim() !== '') {
        derivedPeers.push(this.deriveLegacySequencerEnodeUrl(nodekey, Number(match[1])))
      }
    }

    return derivedPeers
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((prev, curr) => prev && prev[curr], obj)
  }

  private getRethSequencerPeers(): string[] {
    const rethSequencerPeers: string[] = []
    for (const instance of this.dogeConfig.sequencerReth?.instances ?? []) {
      if (instance.nodekey?.privateKey) {
        rethSequencerPeers.push(deriveSequencerRethEnodeUrl(instance.nodekey.privateKey, instance.index))
        continue
      }

      if (instance.enodeUrl) {
        rethSequencerPeers.push(instance.enodeUrl)
      }
    }

    return rethSequencerPeers
  }

  private isL2GethNode(chartName: string): boolean {
    return chartName === 'l2-bootnode' || chartName === 'l2-rpc' || chartName === 'l2-sequencer'
  }

  private isL2Node(chartName: string): boolean {
    return chartName.startsWith("l2-bootnode") || chartName.startsWith("l2-rpc") || chartName.startsWith("l2-sequencer") || chartName.startsWith("l2-reth");
  }

  private async loadConfigs(flags: any): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    const contractsConfigPath = path.join(process.cwd(), 'config-contracts.toml')

    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf8')
      this.configData = toml.parse(configContent)
    } else {
      this.warn('config.toml not found. Some values may not be populated correctly.')
    }

    if (fs.existsSync(contractsConfigPath)) {
      const contractsConfigContent = fs.readFileSync(contractsConfigPath, 'utf8')
      this.contractsConfig = toml.parse(contractsConfigContent)
    } else {
      this.warn('config-contracts.toml not found. Some values may not be populated correctly.')
    }

    const { config, configPath: dogeConfigPath } = await loadDogeConfigWithSelection(
      flags['doge-config'],
      'scrollsdk setup doge-config',
    )
    this.dogeConfig = config as DogeConfigType;
    this.proofIntent = resolveProofIntent({
      deploymentDir: process.cwd(),
      dogeConfig: this.dogeConfig,
      dogeConfigPath,
      specPath: flags.spec,
    })
    this.jsonCtx.info(
      `Proof intent: ${this.proofIntent.intent.mode} (${this.proofIntent.source.kind}: ${this.proofIntent.source.path})`,
    )
    this.configData.ethereumDa = this.dogeConfig.ethereumDa


    const withdrawalProcessorConfigPath = path.join(process.cwd(), ".data/output-withdrawal-processor.toml")
    if (!fs.existsSync(withdrawalProcessorConfigPath)) {
      this.error("run scrollsdk setup bridge-init first");
      return
    }

    const withdrawalProcessorConfigContent = fs.readFileSync(withdrawalProcessorConfigPath, 'utf8');
    this.withdrawalProcessorConfig = toml.parse(withdrawalProcessorConfigContent);

    const bridgeConfigPath = path.join(process.cwd(), ".data/bridge.json")
    if (!fs.existsSync(bridgeConfigPath)) {
      this.error("run scrollsdk setup bridge-init --step 3-bridge-info first");
      return
    }

    this.bridgeConfig = JSON.parse(fs.readFileSync(bridgeConfigPath, 'utf8'));
    if (!this.bridgeConfig.redeem_script_hex) {
      this.error(`${bridgeConfigPath} missing redeem_script_hex. Run scrollsdk setup bridge-init --step 3-bridge-info first`);
    }

    const outputTestDataPath = path.join(process.cwd(), ".data/output-test-data.json")
    if (!fs.existsSync(outputTestDataPath)) {
      this.error("run scrollsdk setup bridge-init --step 2-setup first");
      return
    }

    this.outputTestData = JSON.parse(fs.readFileSync(outputTestDataPath, 'utf8'));
    for (const key of ['fee_wallet_address', 'sequencer_address']) {
      if (typeof this.outputTestData[key] !== 'string' || this.outputTestData[key].trim() === '') {
        this.error(`${outputTestDataPath} missing ${key}. Run scrollsdk setup bridge-init --step 2-setup first`);
      }
    }

  }

  private parsePeerList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String).filter(item => item.trim() !== '')
    if (typeof value !== 'string' || value.trim() === '') return []

    const trimmed = value.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) return parsed.map(String).filter(item => item.trim() !== '')
      } catch {
        return [trimmed]
      }
    }

    return trimmed.split(',').map(item => item.trim()).filter(Boolean)
  }

  private async processBootnodeRethInstanceFiles(valuesDir: string): Promise<{ skipped: number; updated: number }> {
    const instances = this.dogeConfig.bootnodeReth?.instances ?? []
    if (instances.length === 0) return { skipped: 0, updated: 0 }

    let updatedCharts = 0
    let skippedCharts = 0
    const templateFilePath = path.join(valuesDir, 'l2-reth-bootnode-production.yaml')

    for (const instance of instances) {
      const destFilePath = path.join(valuesDir, getBootnodeRethValuesFileName(instance.index))
      if (fs.existsSync(destFilePath)) {
        skippedCharts++
        continue
      }

      if (!fs.existsSync(templateFilePath)) {
        this.error(
          `${getBootnodeRethValuesFileName(instance.index)} not found and reth template ${templateFilePath} is missing. ` +
          `Create l2-reth-bootnode-production.yaml or ${getBootnodeRethValuesFileName(instance.index)}; prep-charts will not reuse old l2-bootnode values.`
        )
      }

      const templateContent = fs.readFileSync(templateFilePath, 'utf8')
      const newYamlContent = templateContent.replaceAll('__INSTANCE_INDEX__', instance.index.toString())
      fs.writeFileSync(destFilePath, newYamlContent)
      this.jsonCtx.logSuccess(`Created ${path.relative(process.cwd(), destFilePath) || destFilePath}`)
      updatedCharts++
    }

    return { skipped: skippedCharts, updated: updatedCharts }
  }

  private async processConfigYaml(valuesDir: string): Promise<{ skipped: number, updated: number }> {
    let updatedCharts = 0
    let skippedCharts = 0
    const configFiles = fs.readdirSync(valuesDir)
      .filter(file => file.endsWith('-config.yaml'))

    for (const file of configFiles) {
      const yamlPath = path.join(valuesDir, file)
      this.log(chalk.cyan(`Processing ${yamlPath}`));
      const chartName = file.replace(/-config\.yaml$/, '');
      const yamlData = yaml.load(fs.readFileSync(yamlPath, "utf8")) as any;
      const changes: Array<{ key: string; newValue: string; oldValue: string }> = [];

      if (chartName === "rollup-relayer") {
        let updated = false;
        // Parse the JSON string from scrollConfig
        let scrollConfigJson: any = {};
        try {
          scrollConfigJson = JSON.parse(yamlData.scrollConfig);
        } catch (error: any) {
          this.error(chalk.red(`Failed to parse scrollConfig JSON in ${file}: ` + error.message));
        }

        const currentL1Endpoint = scrollConfigJson.l1_config.endpoint;
        if (currentL1Endpoint !== "") {
          scrollConfigJson.l1_config.endpoint = "";
          updated = true;
          changes.push({ key: `l1_config.endpoint`, newValue: "", oldValue: currentL1Endpoint });
        }

        // Remove celestia_submit_endpoint if it exists
        if (scrollConfigJson.l2_config?.relayer_config?.celestia_submit_endpoint !== undefined) {
          const currentCelestiaEndpoint = scrollConfigJson.l2_config.relayer_config.celestia_submit_endpoint;
          delete scrollConfigJson.l2_config.relayer_config.celestia_submit_endpoint;
          updated = true;
          changes.push({ key: `l2_config.relayer_config.celestia_submit_endpoint`, newValue: "removed", oldValue: currentCelestiaEndpoint });
        }


        if (updated) {
          if (!this.jsonMode) {
            this.log(`\nFor ${chalk.cyan(file)}:`)
            this.log(chalk.green('Changes:'))
            for (const change of changes) {
              this.log(`  ${chalk.yellow(change.key)}: ${change.oldValue} -> ${change.newValue}`)
            }
          }

          let shouldUpdate = this.nonInteractive
          if (!this.nonInteractive) {
            shouldUpdate = await confirm({ message: `Do you want to apply these changes to ${file}?` })
          }

          if (shouldUpdate) {
            // Preserve the literal block scalar format for scrollConfig
            const jsonConfigString = JSON.stringify(scrollConfigJson, null, 2);

            // Manually construct to get exact "scrollConfig: |" format
            const indentedJson = jsonConfigString
              .trim()
              .split('\n')
              .map(line => `  ${line}`)
              .join('\n');

            const yamlContent = `scrollConfig: |\n${indentedJson}\n`;

            fs.writeFileSync(yamlPath, yamlContent);
            this.jsonCtx.logSuccess(`Updated ${file}`)
            updatedCharts++;
          } else {
            this.jsonCtx.info(`Skipped updating ${file}`);
            skippedCharts++;
          }
        }
      } else {
        this.jsonCtx.info(`No changes needed in ${file}`);
        skippedCharts++;
      }

      if (chartName === "frontends") {
        const {scrollConfig} = yamlData;
        const generatedFrontendConfig =
          yamlData.configMaps?.['frontend-config']?.data?.['frontend-config']

        let sharedHost = this.getConfigValue("ingress.FRONTEND_HOST")
        if (sharedHost && sharedHost.startsWith("portal.")) {
          sharedHost = sharedHost.slice(7)
        }

        const configUpdates = {
          REACT_APP_BASE_CHAIN: this.getConfigValue("general.CHAIN_NAME_L1"),
          REACT_APP_CONNECT_WALLET_PROJECT_ID: this.getConfigValue("frontend.CONNECT_WALLET_PROJECT_ID"),
          REACT_APP_DOGE_BRIDGE_ADDRESS: this.withdrawalProcessorConfig.bridge_address,
          REACT_APP_DOGE_NETWORK: this.dogeConfig.network,
          REACT_APP_ETH_SYMBOL: this.getConfigValue("frontend.ETH_SYMBOL"),
          REACT_APP_EXTERNAL_DOCS_URI: this.formatUrl("https://docs." + sharedHost, "/en/home"),
          REACT_APP_EXTERNAL_EXPLORER_URI_L1: this.getConfigValue("frontend.DOGE_EXTERNAL_EXPLORER_URI_L1"),
          REACT_APP_EXTERNAL_RPC_URI_L1: this.getConfigValue("frontend.DOGE_EXTERNAL_RPC_URI_L1"),
          REACT_APP_FAUCET_URI: this.formatUrl("https://faucet." + sharedHost),
          REACT_APP_L1_CUSTOM_ERC20_GATEWAY_PROXY_ADDR: "",
          REACT_APP_L1_STANDARD_ERC20_GATEWAY_PROXY_ADDR: "",
          REACT_APP_L2_CUSTOM_ERC20_GATEWAY_PROXY_ADDR: "",
          REACT_APP_MOAT_ADDRESS: this.getConfigValue("contractsFile.L2_MOAT_PROXY_ADDR"),
          REACT_APP_ROLLUP: this.getConfigValue("general.CHAIN_NAME_L2"),
        };

        if (typeof scrollConfig !== 'string') {
          if (typeof generatedFrontendConfig !== 'string') {
            this.jsonCtx.info(`No supported frontend config payload found in ${file}`)
            skippedCharts++
            continue
          }

          const generatedUpdate = applyFrontendEnvFileValues(
            generatedFrontendConfig,
            configUpdates,
          )
          if (!generatedUpdate.changed) {
            this.jsonCtx.info(`No changes needed in ${file}`)
            skippedCharts++
            continue
          }

          yamlData.configMaps['frontend-config'].data['frontend-config'] =
            generatedUpdate.content
          fs.writeFileSync(yamlPath, yaml.dump(yamlData, YAML_DUMP_OPTIONS))
          this.jsonCtx.logSuccess(`Updated ${file}`)
          updatedCharts++
          continue
        }

        let scrollConfigToml: any = {};
        try {
          scrollConfigToml = toml.parse(scrollConfig);
        } catch (error: any) {
          this.error(chalk.red("scrollConfig failed: " + error.message));
        }

        let updated = false;
        for (const [key, newValue] of Object.entries(configUpdates)) {
          // Minimal/spec-first deployments may not have post-contract or
          // optional frontend fields yet. Omit unresolved inputs instead of
          // inserting `undefined`, which @iarna/toml cannot serialize.
          if (newValue === undefined || newValue === null) continue

          const oldValue = scrollConfigToml[key];
          if (!oldValue || oldValue !== newValue) {
            changes.push({ key, newValue: String(newValue), oldValue: String(oldValue || '') });
            scrollConfigToml[key] = newValue;
            updated = true;
          }
        }

        if (updated) {
          if (!this.jsonMode) {
            this.log(`\nFor ${chalk.cyan(file)}:`);
            this.log(chalk.green('Changes:'));
            for (const change of changes) {
              this.log(`  ${chalk.yellow(change.key)}: ${change.oldValue} -> ${change.newValue}`);
            }
          }

          let shouldUpdate = this.nonInteractive
          if (!this.nonInteractive) {
            shouldUpdate = await confirm({ message: `Do you want to apply these changes to ${file}?` });
          }

          if (shouldUpdate) {
            // Preserve the literal block scalar format for scrollConfig
            const tomlConfigString = toml.stringify(scrollConfigToml);

            // Manually construct to get exact "scrollConfig: |" format (not "scrollConfig: |-")
            const indentedToml = tomlConfigString
              .trim()
              .split('\n')
              .map(line => `  ${line}`)
              .join('\n');

            const yamlContent = `scrollConfig: |\n${indentedToml}\n`;

            fs.writeFileSync(yamlPath, yamlContent);
            this.jsonCtx.logSuccess(`Updated ${file}`);
            updatedCharts++;
          } else {
            this.jsonCtx.info(`Skipped updating ${file}`);
            skippedCharts++;
          }
        } else {
          this.jsonCtx.info(`No changes needed in ${file}`);
          skippedCharts++;
        }
      }
    }

    return { skipped: skippedCharts, updated: updatedCharts };
  }

  // Generic ingress processing function
  private processIngressHosts(
    ingressConfig: any,
    hostConfigValue: string,
    changes: Array<{ key: string; newValue: string; oldValue: string }>,
    keyPrefix: string = 'ingress'
  ): boolean {
    let ingressUpdated = false;

    if (ingressConfig && typeof ingressConfig === 'object' && 'hosts' in ingressConfig) {
      const hosts = ingressConfig.hosts as Array<{ host: string; paths?: any[] }>;
      if (Array.isArray(hosts)) {
        // Strip port from hostname - Kubernetes Ingress hosts cannot contain ports
        const sanitizedHost = hostConfigValue ? stripPortFromHost(hostConfigValue) : hostConfigValue;
        for (const [i, host] of hosts.entries()) {
          if (typeof host === 'object' && 'host' in host && sanitizedHost && sanitizedHost !== host.host) {
              changes.push({
                key: `${keyPrefix}.hosts[${i}].host`,
                newValue: sanitizedHost,
                oldValue: host.host
              });
              host.host = sanitizedHost;
              ingressUpdated = true;
            }
        }
      }

      // Update TLS section if it exists and ingress was updated
      if (ingressUpdated && ingressConfig.tls) {
        const tlsEntries = ingressConfig.tls as Array<{ hosts: string[] }>;
        if (Array.isArray(tlsEntries)) {
          for (const tlsEntry of tlsEntries) {
            if (Array.isArray(tlsEntry.hosts)) {
              tlsEntry.hosts = hosts.map((host) => host.host);
            }
          }
        }
      }
    }

    return ingressUpdated;
  }

  private async processMutipleInstance(valuesDir: string): Promise<{ skipped: number; updated: number }> {
    interface ChartConfig {
      chartName: string;
      configKey: string;
    }

    let updatedCharts = 0;
    let skippedCharts = 0;

    // attestation-signer is partner-operated through docker-compose. Remove
    // values left by older CLI releases so a later `helm install-all` cannot
    // accidentally resurrect the retired in-cluster deployment shape.
    for (const file of removeRetiredAttestationSignerValues(valuesDir)) {
      this.jsonCtx.info(`Removed retired in-cluster attestation signer values: ${file}`)
      updatedCharts++
    }

    for (const file of removeRetiredCubesignerInstanceValues(valuesDir)) {
      this.jsonCtx.info(`Removed obsolete multi-instance CubeSigner values: ${file}`)
      updatedCharts++
    }

    const names: ChartConfig[] = [{
      chartName: "l2-bootnode",
      configKey: "bootnode"
    }, {
      chartName: "l2-sequencer",
      configKey: "sequencer"
    }];

    for (const item of names) {
      const { chartName, configKey } = item;

      let releaseIndex = 0;
      const templateFilePath = path.join(valuesDir, `${chartName}-production.yaml`);
      if (!fs.existsSync(templateFilePath)) {
        this.warn(chalk.yellow(`Source file not found: ${templateFilePath}, skipping ${chartName} charts`));
        skippedCharts++;
        continue;
      }

      if (!this.configData[configKey]) {
        this.error(`${configKey} not found in config.toml`);
      }

      const templateContent = fs.readFileSync(templateFilePath, 'utf8');

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const instanceKey = `${configKey}-${releaseIndex}`

        // instanceConfig is like this.configData.bootnode.bootnode-0, or this.configData.sequencer.sequencer-0
        const instanceConfig = this.configData[configKey][instanceKey]

        if (!instanceConfig && instanceKey !== "sequencer-0") {
          // No more bootnode instances defined
          this.log(chalk.yellow(`No more ${instanceKey} instances defined.`));
          break
        }

        const destFilePath = path.join(valuesDir, `${chartName}-production-${releaseIndex}.yaml`);

        const newYamlContent = templateContent.replaceAll('__INSTANCE_INDEX__', releaseIndex.toString());
        fs.writeFileSync(destFilePath, newYamlContent);
        updatedCharts++;

        releaseIndex++
      }

    }

    return { skipped: skippedCharts, updated: updatedCharts };
  }

  private async processProductionYaml(
    valuesDir: string
  ): Promise<{ skipped: number; updated: number }> {
    const productionFiles = fs.readdirSync(valuesDir)
      .filter(file => file.endsWith('-production.yaml') || file.match(/-production-\d+\.yaml$/))

    let updatedCharts = 0
    let skippedCharts = 0
    const dogecoinEndpoints = resolveDogecoinKubernetesEndpoints(this.dogeConfig)
    const blockbookEndpoints = resolveBlockbookKubernetesEndpoints(this.dogeConfig)
    const dogecoinInternalUrl = dogecoinEndpoints.rpcUrl
    const s3Archive = this.dogeConfig.ethereumDa?.blobArchive?.s3
    const s3PublicBaseUrl = getEthereumDaS3PublicBaseUrl(s3Archive)
    const s3PublicBlobUrl = getEthereumDaS3PublicBlobUrl(s3Archive)
    const configuredL2ChainId = this.getConfigValue('general.CHAIN_ID_L2')
    const l2P2PNetworkId = resolveRethP2PNetworkId(this.dogeConfig, configuredL2ChainId)

    for (const file of productionFiles) {
      if (file === 'l2-reth-bootnode-production.yaml') {
        this.jsonCtx.info(`Skipping reth bootnode template ${file}`)
        skippedCharts++
        continue
      }

      if (file === 'l2-reth-sequencer-production.yaml') {
        this.jsonCtx.info(`Skipping reth sequencer template ${file}`)
        skippedCharts++
        continue
      }

      const yamlPath = path.join(valuesDir, file)
      const chartName = getProductionChartName(file)
      const productionNumber = file.match(/-production-(\d+)\.yaml$/)?.[1] || '0'

      this.log(`Processing ${file} for chart ${chartName}...`)

      const productionYamlContent = fs.readFileSync(yamlPath, 'utf8')
      const productionYaml = yaml.load(productionYamlContent) as any

      let updated = false
      const changes: Array<{ key: string; newValue: string; oldValue: string }> = []

      // In the normal deployment flow every concrete Reth node uses the L2
      // chain ID as its P2P network ID. A shadowfork may intentionally override
      // these values afterward to isolate the dev P2P network from production.
      // Numbered bootnode/sequencer files normalize to their base chart names.
      if (isL2RethBlobS3Chart(chartName)) {
        const sharedRethChanges = [
          ...applyRethNetworkId(productionYaml, l2P2PNetworkId),
          ...applyRethBlobS3Url(productionYaml, s3PublicBlobUrl),
        ]
        if (sharedRethChanges.length > 0) {
          changes.push(...sharedRethChanges)
          updated = true
        }
      }

      // Process configMaps
      if (productionYaml.configMaps) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const [_configMapName, configMapData] of Object.entries(productionYaml.configMaps)) {
          if (configMapData && typeof configMapData === 'object' && 'data' in configMapData) {
            const envData = (configMapData as any).data
            for (const [key, oldValue] of Object.entries(envData)) {
              if (shouldSkipL2ContractDeploymentBlockUpdate(chartName, key, this.skipL2ContractDeploymentBlock)) {
                continue
              }

              if (this.isL2Node(chartName)) {
                const fixedValue = this.getFixedL2NodeEnvValue(chartName, key)
                if (fixedValue !== undefined) {
                  if (fixedValue !== oldValue) {
                    changes.push({ key, newValue: fixedValue, oldValue: JSON.stringify(oldValue) })
                    envData[key] = fixedValue
                    updated = true
                  }

                  continue
                }
              }

              const configPathOrResolver = this.configMapping[key]
              if (configPathOrResolver) {
                let configKey: string
                configKey = typeof configPathOrResolver === 'function' ? configPathOrResolver(chartName, productionNumber) : configPathOrResolver;
                if (chartName === "l1-devnet" && key === "CHAIN_ID") {
                  configKey = "ethereumDa.chainId";
                }

                let configValue = this.getConfigValue(configKey)
                if (this.isL2Node(chartName) && key === "L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK") {
                  configValue = this.dogeConfig.defaults?.dogecoinIndexerStartHeight;
                }

                if (configValue !== undefined && configValue !== null) {
                  const newValue: string | string[] = Array.isArray(configValue) ? JSON.stringify(configValue) : String(configValue);
                  if (newValue !== oldValue) {
                    changes.push({ key, newValue, oldValue: JSON.stringify(oldValue) })
                    envData[key] = newValue
                    updated = true
                  }
                } else {
                  this.log(chalk.yellow(`${chartName}: No value found for ${configKey}`))
                }
              }
            }
          }
        }
      }

      if (chartName.startsWith('l2-bootnode')) {
        const l2GethS3Changes = removeL2GethBlobS3ExtraParams(productionYaml)
        if (l2GethS3Changes.length > 0) {
          changes.push(...l2GethS3Changes)
          updated = true
        }
      }

      if (chartName === 'l2-reth-bootnode') {
        const previousRethValues = JSON.stringify(productionYaml)
        const resolved = this.buildBootnodeRethResolvedConfig(Number(productionNumber))
        applyBootnodeRethValues(productionYaml, resolved)
        productionYaml.reth ||= {}
        const trustedPeers = this.buildFreshRethTrustedPeers()
        if (productionYaml.reth.trustedPeers !== trustedPeers) {
          productionYaml.reth.trustedPeers = trustedPeers
        }

        this.removeLegacyRethTrustedPeersEnv(productionYaml)

        const nextRethValues = JSON.stringify(productionYaml)
        if (previousRethValues !== nextRethValues) {
          changes.push({
            key: 'bootnodeReth',
            newValue: 'applied from doge-config.toml',
            oldValue: 'previous values',
          })
          updated = true
          if (resolved.secretMode === 'external-secret') {
            this.jsonCtx.info(`Push ${resolved.secretName} with ${RETH_BOOTNODE_NODEKEY_ENV} before deploying.`)
          } else {
            this.jsonCtx.addWarning(`${file}: plain reth bootnode key material will be written into values YAML. Use only for development.`)
          }
        }
      }

      if (chartName === 'l2-reth-sequencer') {
        const previousRethValues = JSON.stringify(productionYaml)
        const resolved = this.buildSequencerRethResolvedConfig(Number(productionNumber))
        applySequencerRethValues(productionYaml, resolved)
        productionYaml.reth ||= {}
        const trustedPeers = this.buildFreshRethTrustedPeers()
        if (productionYaml.reth.trustedPeers !== trustedPeers) {
          productionYaml.reth.trustedPeers = trustedPeers
        }

        this.removeLegacyRethTrustedPeersEnv(productionYaml)

        const nextRethValues = JSON.stringify(productionYaml)
        if (previousRethValues !== nextRethValues) {
          changes.push({
            key: 'sequencerReth',
            newValue: 'applied from doge-config.toml',
            oldValue: 'previous values',
          })
          updated = true
          if (resolved.secretMode === 'external-secret') {
            this.jsonCtx.info(`Push ${resolved.secretName} with ${RETH_NODEKEY_ENV}${resolved.signer.backend === 'local' ? ` and ${RETH_SIGNER_PRIVATE_KEY_ENV}` : ''} before deploying.`)
          } else {
            this.jsonCtx.addWarning(`${file}: plain reth key material will be written into values YAML. Use only for development.`)
          }
        }
      }

      if (isL2RethRpcChart(chartName)) {
        if (chartName === 'l2-reth-rpc') {
          const oldGlobalNaming = JSON.stringify(productionYaml.global || {})
          removeChartResourceNameOverrides(productionYaml)
          if (oldGlobalNaming !== JSON.stringify(productionYaml.global || {})) {
            changes.push({
              key: 'global.nameOverride/global.fullnameOverride',
              newValue: 'release-derived',
              oldValue: oldGlobalNaming,
            })
            updated = true
          }
        }

        const trustedPeers = this.buildFreshRethTrustedPeers()
        const runtimeChanges = applyL2RethRpcRuntimeValues(productionYaml, {
          blobS3Url: s3PublicBlobUrl,
          l1Url: L1_INTERFACE_RPC_ENDPOINT,
          networkId: l2P2PNetworkId,
          trustedPeers,
        })
        if (runtimeChanges.length > 0) {
          changes.push(...runtimeChanges)
          updated = true
        }

        if (chartName === 'l2-reth-rpc-public') {
          const ingressPolicyChanges = applyL2RethRpcPublicIngressPolicy(productionYaml)
          if (ingressPolicyChanges.length > 0) {
            changes.push(...ingressPolicyChanges)
            updated = true
          }
        }

        if (this.removeLegacyRethTrustedPeersEnv(productionYaml)) {
          changes.push({
            key: 'configMaps.env.data.RETH_TRUSTED_PEERS',
            newValue: 'removed',
            oldValue: 'present',
          })
          updated = true
        }
      }

      // Process ingress
      if (productionYaml.ingress) {
        let ingressUpdated = false;
        for (const [ingressKey, ingressValue] of Object.entries(productionYaml.ingress)) {
          if (ingressValue && typeof ingressValue === 'object' && 'hosts' in ingressValue) {
            const hosts = ingressValue.hosts as Array<{ host: string }>;
            if (Array.isArray(hosts)) {
              for (const [i, host] of hosts.entries()) {
                if (typeof host === 'object' && 'host' in host) {
                  const configValue = this.getIngressHostConfigValue(chartName, ingressKey)

                  if (configValue) {
                    // Strip port from hostname - Kubernetes Ingress hosts cannot contain ports
                    const sanitizedHost = stripPortFromHost(configValue);
                    if (sanitizedHost !== host.host) {
                      changes.push({ key: `ingress.${ingressKey}.hosts[${i}].host`, newValue: sanitizedHost, oldValue: host.host });
                      host.host = sanitizedHost;
                      ingressUpdated = true;
                    }
                  }
                }
              }
            }
          }
        }

        if (ingressUpdated) {
          updated = true;
          // Update the tls section if it exists
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for (const [_ingressKey, ingressValue] of Object.entries(productionYaml.ingress)) {
            if (ingressValue && typeof ingressValue === 'object' && 'tls' in ingressValue && 'hosts' in ingressValue) {
              const tlsEntries = ingressValue.tls as Array<{ hosts: string[] }>;
              const hosts = ingressValue.hosts as Array<{ host: string }>;
              if (Array.isArray(tlsEntries) && Array.isArray(hosts)) {
                for (const tlsEntry of tlsEntries) {
                  if (Array.isArray(tlsEntry.hosts)) {
                    tlsEntry.hosts = hosts.map((host) => host.host);
                  }
                }
              }
            }
          }
        }
      }



      if (productionYaml["blockscout-stack"]) {
        let ingressUpdated = false;
        const {blockscout} = productionYaml["blockscout-stack"];
        const {frontend} = productionYaml["blockscout-stack"];
        const blockscout_host = this.getConfigValue("ingress.BLOCKSCOUT_HOST");
        const blockscout_url = this.getConfigValue("frontend.EXTERNAL_EXPLORER_URI_L2");

        if (blockscout?.ingress?.annotations?.["nginx.ingress.kubernetes.io/cors-allow-origin"]) {
          const oldValue = blockscout.ingress.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"];
          if (oldValue !== blockscout_url) {
            changes.push({ key: `ingress.blockscout.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"]`, newValue: blockscout_url, oldValue });
            blockscout.ingress.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"] = blockscout_url;
            ingressUpdated = true;
          }
        }

        if (blockscout?.ingress?.hostname) {
          const oldValue = blockscout.ingress.hostname;
          if (oldValue !== blockscout_host) {
            changes.push({ key: `ingress.blockscout.hostname`, newValue: blockscout_host, oldValue });
            blockscout.ingress.hostname = blockscout_host;
            ingressUpdated = true;
          }
        }

        // only enable tls if use command scrollsdk setup tls
        // if setup:tls was executed, all http protocol will be updated to https
        // so we don't support disable tls for now

        // if (blockscout?.ingress?.tls?.enabled) {
        //   if (blockscout.ingress.tls.enabled !== false) {
        //     const oldValue = blockscout.ingress.tls.enabled;
        //     blockscout.ingress.tls.enabled = false; // Ensure it's boolean false
        //     changes.push({ key: `ingress.blockscout.tls.enabled`, oldValue: String(oldValue), newValue: "false" });
        //     ingressUpdated = true;
        //   }
        // }

        if (frontend?.env?.NEXT_PUBLIC_API_HOST) {
          const oldValue = frontend.env.NEXT_PUBLIC_API_HOST;
          if (oldValue !== blockscout_host) {
            changes.push({ key: `frontend.env.NEXT_PUBLIC_API_HOST`, newValue: blockscout_host, oldValue });
            frontend.env.NEXT_PUBLIC_API_HOST = blockscout_host;
            ingressUpdated = true;
          }
        }

        const protocol = blockscout_url.startsWith("https") ? "https" : "http";
        if (frontend?.env?.NEXT_PUBLIC_API_PROTOCOL) {
          const oldValue = frontend.env.NEXT_PUBLIC_API_PROTOCOL;
          if (oldValue !== protocol) {
            changes.push({
              key: `frontend.env.NEXT_PUBLIC_API_PROTOCOL`,
              newValue: protocol,
              oldValue
            });
            frontend.env.NEXT_PUBLIC_API_PROTOCOL = protocol;
            ingressUpdated = true;
          }
        }

        if (frontend?.env?.NEXT_PUBLIC_APP_PROTOCOL) {
          const oldValue = frontend.env.NEXT_PUBLIC_APP_PROTOCOL;
          if (oldValue !== protocol) {
            changes.push({
              key: `frontend.env.NEXT_PUBLIC_APP_PROTOCOL`,
              newValue: protocol,
              oldValue
            });
            frontend.env.NEXT_PUBLIC_APP_PROTOCOL = protocol;
            ingressUpdated = true;
          }
        }

        if (frontend?.ingress?.annotations?.["nginx.ingress.kubernetes.io/cors-allow-origin"]) {
          const oldValue = frontend.ingress.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"];
          if (oldValue !== blockscout_url) {
            changes.push({ key: `frontend.ingress.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"]`, newValue: blockscout_url, oldValue });
            frontend.ingress.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"] = blockscout_url;
            ingressUpdated = true;
          }
        }

        if (frontend?.ingress?.hostname) {
          const oldValue = frontend.ingress.hostname;
          if (oldValue !== blockscout_host) {
            changes.push({ key: `frontend.ingress.hostname`, newValue: blockscout_host, oldValue });
            frontend.ingress.hostname = blockscout_host;
            ingressUpdated = true;
          }
        }

        /*
        NEXT_PUBLIC_NETWORK_ID: "221122420"
        */
        const oldNetworkName = frontend?.env?.NEXT_PUBLIC_NETWORK_NAME;
        const newNetworkName = this.getConfigValue("general.CHAIN_NAME_L2");
        if (!oldNetworkName || oldNetworkName !== newNetworkName) {
          changes.push({ key: `frontend.env.NEXT_PUBLIC_NETWORK_NAME`, newValue: newNetworkName, oldValue: oldNetworkName });
          frontend.env.NEXT_PUBLIC_NETWORK_NAME = newNetworkName;
          ingressUpdated = true;
        }

        const oldValue = frontend?.env?.NEXT_PUBLIC_NETWORK_ID;
        const newValue = this.getConfigValue("general.CHAIN_ID_L2");
        if (!oldValue || oldValue !== this.getConfigValue("general.CHAIN_ID_L2")) {
          changes.push({ key: `frontend.env.NEXT_PUBLIC_NETWORK_ID`, newValue, oldValue });
          frontend.env.NEXT_PUBLIC_NETWORK_ID = newValue;
          ingressUpdated = true;
        }


        interface BlockscoutEnvMapping {
          configKey: string;
          defaultValue?: string;
          key: string;
        }

        const BLOCKSCOUT_ENV_MAPPINGS: BlockscoutEnvMapping[] = [
          {
            configKey: '',
            defaultValue: '0',
            key: 'INDEXER_SCROLL_L1_BATCH_START_BLOCK'
          },
          {
            configKey: '',
            defaultValue: '0',
            key: 'INDEXER_SCROLL_L1_MESSENGER_START_BLOCK'
          },
          {
            configKey: 'contractsFile.L1_SCROLL_CHAIN_PROXY_ADDR',
            key: 'INDEXER_SCROLL_L1_CHAIN_CONTRACT'
          },
          {
            configKey: 'L1_SCROLL_MESSENGER_PROXY_ADDR',
            key: 'INDEXER_SCROLL_L1_MESSENGER_CONTRACT'
          },
          {
            configKey: 'L2_DOGEOS_MESSENGER_PROXY_ADDR',
            key: 'INDEXER_SCROLL_L2_MESSENGER_CONTRACT'
          },
          {
            configKey: 'L1_GAS_PRICE_ORACLE_ADDR',
            key: 'INDEXER_SCROLL_L2_GAS_ORACLE_CONTRACT'
          },
          {
            configKey: 'general.L1_RPC_ENDPOINT',
            key: 'INDEXER_SCROLL_L1_RPC'
          }


        ];
        const benv = productionYaml["blockscout-stack"].blockscout.env;

        for (const mapping of BLOCKSCOUT_ENV_MAPPINGS) {
          const { configKey, defaultValue, key } = mapping;

          let newValue = this.getConfigValue(configKey);
          if (!newValue) {
            newValue = configKey ? this.contractsConfig[configKey] : defaultValue;
          }

          const oldValue = benv[key];

          if (newValue === oldValue) {
            this.log(chalk.yellow(`No value found for ${key}`));
          } else {
            changes.push({
              key: `blockscout.env.${key}`,
              newValue,
              oldValue: benv[key]
            });
            benv[key] = newValue;
            updated = true;
          }
        }

        if (ingressUpdated) {
          updated = true;
        }
      }

      if (productionYaml.grafana) {
        /*
          grafana.ini:
            server:
              domain: grafana.scrollsdk
              root_url: "https://grafana.scrollsdk""
        */
        if (!productionYaml.grafana["grafana.ini"]) {
          productionYaml.grafana["grafana.ini"] = { server: {} };
        }

        if (!productionYaml.grafana["grafana.ini"].server) {
          productionYaml.grafana["grafana.ini"].server = {};
        }

        const existingDomain = productionYaml.grafana?.["grafana.ini"]?.server?.domain ?? null;
        const existingRootUrl = productionYaml.grafana?.["grafana.ini"]?.server?.root_url ?? null;

        const newDomain = this.getConfigValue("ingress.GRAFANA_HOST");
        if (existingDomain !== newDomain) {
          changes.push({ key: `grafana["grafana.ini"].server.domain`, newValue: newDomain, oldValue: existingDomain });
          productionYaml.grafana["grafana.ini"].server.domain = newDomain;
          updated = true;
        }

        const newRootUrl = this.getConfigValue("frontend.GRAFANA_URI");
        if (existingRootUrl !== newRootUrl) {
          changes.push({ key: `grafana["grafana.ini"].server.root_url`, newValue: newRootUrl, oldValue: existingRootUrl });
          productionYaml.grafana["grafana.ini"].server.root_url = newRootUrl;
          updated = true;
        }



        let ingressUpdated = false;
        const ingressValue = productionYaml.grafana.ingress;
        if (ingressValue && typeof ingressValue === 'object' && 'hosts' in ingressValue) {
          const hosts = ingressValue.hosts as Array<string>;
          if (Array.isArray(hosts)) {
            for (let i = 0; i < hosts.length; i++) {
              if (typeof (hosts[i]) === 'string') {
                const configValue: string | undefined = this.getConfigValue("ingress.GRAFANA_HOST");
                // Strip port from hostname - Kubernetes Ingress hosts cannot contain ports
                const sanitizedHost = configValue ? stripPortFromHost(configValue) : configValue;

                if (sanitizedHost && (sanitizedHost !== hosts[i])) {
                  changes.push({ key: `ingress.hosts[${i}]`, newValue: sanitizedHost, oldValue: hosts[i] });
                  hosts[i] = sanitizedHost;
                  ingressUpdated = true;
                }
              }
            }
          }
        }

        if (ingressUpdated) {
          updated = true;
          // Update the tls section if it exists
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for (const [_ingressKey, ingressValue] of Object.entries(productionYaml.grafana.ingress)) {
            if (ingressValue && typeof ingressValue === 'object' && 'tls' in ingressValue && 'hosts' in ingressValue) {
              const tlsEntries = ingressValue.tls as Array<{ hosts: string[] }>;
              const hosts = ingressValue.hosts as Array<{ host: string }>;
              if (Array.isArray(tlsEntries) && Array.isArray(hosts)) {
                for (const tlsEntry of tlsEntries) {
                  if (Array.isArray(tlsEntry.hosts)) {
                    tlsEntry.hosts = hosts.map((host) => host.host);
                  }
                }
              }
            }
          }
        }
      }

      // eslint-disable-next-line unicorn/prefer-switch
      if (chartName === 'blockbook') {
        if (!productionYaml.blockbook || typeof productionYaml.blockbook !== 'object') {
          productionYaml.blockbook = {}
        }

        if (productionYaml.fullnameOverride !== blockbookEndpoints.serviceName) {
          changes.push({ key: 'fullnameOverride', newValue: blockbookEndpoints.serviceName, oldValue: String(productionYaml.fullnameOverride || 'undefined') })
          productionYaml.fullnameOverride = blockbookEndpoints.serviceName
          updated = true
        }

        let ingressUpdated = false;
        if (productionYaml.ingress) {
          const ingressValue = productionYaml.ingress;
          ingressValue.enabled = true;
          const configValue = this.getConfigValue('ingress.BLOCKBOOK_HOST');
          ingressUpdated = this.processIngressHosts(ingressValue, configValue, changes);
        } else {
          productionYaml.ingress = {
            annotations: {
              "cert-manager.io/cluster-issuer": "letsencrypt-prod",
              "nginx.ingress.kubernetes.io/ssl-redirect": "true"
            },
            className: "nginx",
            enabled: true,
            hosts: [
              {
                host: this.getConfigValue("ingress.BLOCKBOOK_HOST"),
                paths: [{ path: "/", pathType: "Prefix" }]
              }
            ],
          };
          changes.push({ key: `ingress`, newValue: JSON.stringify(productionYaml.ingress), oldValue: "undefined" });
          ingressUpdated = true;
        }

        if (ingressUpdated) {
          updated = true;
        }

        if (productionYaml.blockbook.rpcUrl !== dogecoinEndpoints.rpcUrl) {
          changes.push({ key: 'blockbook.rpcUrl', newValue: dogecoinEndpoints.rpcUrl, oldValue: String(productionYaml.blockbook.rpcUrl || 'undefined') })
          productionYaml.blockbook.rpcUrl = dogecoinEndpoints.rpcUrl
          updated = true
        }

        if (productionYaml.blockbook.messageQueueBinding !== dogecoinEndpoints.zmqRawBlockUrl) {
          changes.push({ key: 'blockbook.messageQueueBinding', newValue: dogecoinEndpoints.zmqRawBlockUrl, oldValue: String(productionYaml.blockbook.messageQueueBinding || 'undefined') })
          productionYaml.blockbook.messageQueueBinding = dogecoinEndpoints.zmqRawBlockUrl
          updated = true
        }

        const oldValue = productionYaml.blockbook.blockHeight;
        const newValue = this.dogeConfig.defaults?.dogecoinIndexerStartHeight;
        if (oldValue !== newValue) {
          productionYaml.blockbook.blockHeight = this.dogeConfig.defaults?.dogecoinIndexerStartHeight;
          updated = true;
          changes.push({ key: `blockbook.blockHeight`, newValue: newValue || 'undefined', oldValue: oldValue || 'undefined' });
        }
      }

      else if (chartName === "l1-devnet") {
        if (!productionYaml.network || typeof productionYaml.network !== 'object') {
          productionYaml.network = {}
        }

        const ethereumDaChainId = Number(this.getConfigValue("ethereumDa.chainId"))
        if (!Number.isInteger(ethereumDaChainId) || ethereumDaChainId <= 0) {
          this.error('ethereumDa.chainId must be set to the real Ethereum DA execution chain ID before preparing the l1-devnet chart.')
        }

        const networkConfig = productionYaml.network
        if (networkConfig.chainId !== ethereumDaChainId) {
          changes.push({ key: 'network.chainId', newValue: String(ethereumDaChainId), oldValue: String(networkConfig.chainId || 'undefined') })
          networkConfig.chainId = ethereumDaChainId
          updated = true
        }

        if (networkConfig.networkId !== ethereumDaChainId) {
          changes.push({ key: 'network.networkId', newValue: String(ethereumDaChainId), oldValue: String(networkConfig.networkId || 'undefined') })
          networkConfig.networkId = ethereumDaChainId
          updated = true
        }
      }

      else if (chartName === 'fee-oracle') {
        if (!productionYaml.configMaps?.env?.data) {
          this.error(`${chartName}: configMaps.env.data not found in config`);
        }

        const todoMappings = buildFeeOraclePrepEnv({
          ethereumDaRpcUrl: this.getConfigValue("ethereumDa.submitterRpcUrl"),
          gasOracleContract: this.getConfigValue("contractsFile.L1_GAS_PRICE_ORACLE_ADDR"),
          l2ChainId: this.getConfigValue("general.CHAIN_ID_L2"),
          l2RpcUrl: this.getConfigValue("general.L2_RPC_ENDPOINT"),
        })

        const signerConfig = this.requireSigner('l2GasOracleSender')
        if (isAwsKmsSigner(signerConfig)) {
          Object.assign(todoMappings, {
            DOGEOS_FEE_ORACLE_WALLET__KMS_EXPECTED_ADDRESS: signerConfig.expectedAddress,
            DOGEOS_FEE_ORACLE_WALLET__KMS_KEY_ID: signerConfig.kmsKeyId,
            DOGEOS_FEE_ORACLE_WALLET__KMS_REGION: signerConfig.kmsRegion,
            DOGEOS_FEE_ORACLE_WALLET__SIGNER_BACKEND: 'aws_kms',
          })
        } else {
          Object.assign(todoMappings, {
            DOGEOS_FEE_ORACLE_WALLET__PRIVATE_KEY_ENV: 'DOGEOS_FEE_ORACLE_PRIVATE_KEY',
            DOGEOS_FEE_ORACLE_WALLET__SIGNER_BACKEND: 'local',
          })
        }

        const feeOracleChanges = [
          ...scrubFeeOracleLegacyValues(productionYaml),
          ...applyFeeOracleCurrentEnv(productionYaml, todoMappings),
        ]

        if (isAwsKmsSigner(signerConfig)) {
          feeOracleChanges.push(...removeConfigMapEnvKeys(productionYaml, [
            'DOGEOS_FEE_ORACLE_WALLET__PRIVATE_KEY_ENV',
          ]))
          removeNamedSecretRef(productionYaml, 'fee-oracle-secret-env', feeOracleChanges)
          removeExternalSecret(productionYaml, 'fee-oracle-secret-env', feeOracleChanges)

          productionYaml.serviceAccount ||= {}
          const previousServiceAccount = JSON.stringify(productionYaml.serviceAccount)
          productionYaml.serviceAccount.create = true
          productionYaml.serviceAccount.name = signerConfig.serviceAccountName || 'fee-oracle'
          if (signerConfig.serviceAccountRoleArn) {
            productionYaml.serviceAccount.annotations ||= {}
            productionYaml.serviceAccount.annotations['eks.amazonaws.com/role-arn'] = signerConfig.serviceAccountRoleArn
          }

          const nextServiceAccount = JSON.stringify(productionYaml.serviceAccount)
          if (previousServiceAccount !== nextServiceAccount) {
            feeOracleChanges.push({ key: 'serviceAccount', newValue: nextServiceAccount, oldValue: previousServiceAccount })
          }
        } else if (isLocalSigner(signerConfig)) {
          feeOracleChanges.push(...removeConfigMapEnvKeys(productionYaml, [
            'DOGEOS_FEE_ORACLE_WALLET__KMS_EXPECTED_ADDRESS',
            'DOGEOS_FEE_ORACLE_WALLET__KMS_KEY_ID',
            'DOGEOS_FEE_ORACLE_WALLET__KMS_REGION',
          ]))
          ensureNamedSecretRef(productionYaml, 'fee-oracle-secret-env', feeOracleChanges)
        }

        if (feeOracleChanges.length > 0) {
          changes.push(...feeOracleChanges)
          updated = true
        }
      }

      else if (chartName === 'l1-interface') {
        if (!productionYaml.configMaps?.env?.data) {
          this.error(`${chartName}: configMaps.env.data not found in config`);
        }

        const dogecoinIndexerStartHeight = Number(this.dogeConfig.defaults?.dogecoinIndexerStartHeight)
        if (!Number.isSafeInteger(dogecoinIndexerStartHeight) || dogecoinIndexerStartHeight < 0) {
          this.error(`${chartName}: dogeConfig.defaults.dogecoinIndexerStartHeight must be a non-negative integer before preparing charts`);
        }

        const configuredL1GenesisBlock = this.dogeConfig.defaults?.l1GenesisBlock
        const l1GenesisBlock = configuredL1GenesisBlock === undefined
          ? Math.max(0, dogecoinIndexerStartHeight + 1)
          : Number(configuredL1GenesisBlock)
        if (!Number.isSafeInteger(l1GenesisBlock) || l1GenesisBlock < 0) {
          this.error(`${chartName}: dogeConfig.defaults.l1GenesisBlock must be a non-negative integer`);
        }

        if (l1GenesisBlock > 0 && dogecoinIndexerStartHeight >= l1GenesisBlock) {
          this.log(chalk.yellow(`${chartName}: dogecoinIndexerStartHeight should be lower than l1GenesisBlock because l1-interface starts scanning from start_height + 1`))
        }

        const todoMappings = {
          "DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__BRIDGE_ADDRESS": this.withdrawalProcessorConfig.bridge_address,
          "DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__FEE_WALLET_ADDRESS": this.outputTestData.fee_wallet_address,
          "DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__SEQUENCER_ADDRESS": this.outputTestData.sequencer_address,
          "DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__START_HEIGHT": String(Math.max(0, dogecoinIndexerStartHeight)),
          "DOGEOS_L1_INTERFACE_DOGECOIN_RPC__URL": dogecoinInternalUrl,
          "DOGEOS_L1_INTERFACE_ETHEREUM_DA__ETH_CHAIN_ID": String(this.getConfigValue("ethereumDa.chainId")),
          "DOGEOS_L1_INTERFACE_ETHEREUM_DA__L1_RPC_URL": this.getConfigValue("ethereumDa.submitterRpcUrl"),
          "DOGEOS_L1_INTERFACE_ETHEREUM_DA__L2_CHAIN_ID": String(this.getConfigValue("general.CHAIN_ID_L2")),
          "DOGEOS_L1_INTERFACE_L1_BASE_FEE_PER_GAS": this.getConfigValue("genesis.BASE_FEE_PER_GAS").toString(),
          "DOGEOS_L1_INTERFACE_L1_GAS_LIMIT": "30000000",
          "DOGEOS_L1_INTERFACE_L1_GENESIS_BLOCK": String(Math.max(0, l1GenesisBlock)),
          "DOGEOS_L1_INTERFACE_L2_MESSENGER_ADDRESS": this.getConfigValue("contractsFile.L2_DOGEOS_MESSENGER_PROXY_ADDR"),
          "DOGEOS_L1_INTERFACE_L2_MOAT_CONTRACT_ADDRESS": this.getConfigValue("contractsFile.L2_MOAT_PROXY_ADDR"),
          "DOGEOS_L1_INTERFACE_NETWORK_STR": this.withdrawalProcessorConfig.network_str,
          "DOGEOS_L1_INTERFACE_REPLAY_READ__L2_BOOTSTRAP_NEXT_STARTING_BLOCK_HEIGHT": this.dogeConfig.defaults?.l2BootstrapNextStartingBlockHeight,
          "DOGEOS_L1_INTERFACE_REPLAY_READ__MAINTAINER_ENABLED": "true",
          "DOGEOS_L1_INTERFACE_REPLAY_READ__REQUIRE_FULL_VALIDATION": "false",
          "DOGEOS_L1_INTERFACE_SCROLL_CHAIN_ADDRESS": this.getConfigValue("contractsFile.L1_SCROLL_CHAIN_PROXY_ADDR"),
          // "DOGEOS_L1_INTERFACE_SCROLL_MESSENGER_ADDRESS": this.getConfigValue("contractsFile.L1_SCROLL_MESSENGER_PROXY_ADDR")
        }

        const l1InterfaceCleanupChanges = [
          ...scrubL1InterfaceRetiredEnv(productionYaml),
          ...removeConfigMapEnvKeys(productionYaml, [
            'DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__KIND',
          ]),
        ]
        if (l1InterfaceCleanupChanges.length > 0) {
          changes.push(...l1InterfaceCleanupChanges)
          updated = true
        }

        const s3Archive = this.dogeConfig.ethereumDa?.blobArchive?.s3
        const s3ArchiveEnabled = truthyConfigValue(s3Archive?.enabled)
        if (!s3ArchiveEnabled) {
          const staleS3Changes = removeConfigMapEnvKeys(productionYaml, [
            'DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__KEY_PREFIX',
            'DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TIMEOUT_MS',
            'DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TREAT_FORBIDDEN_AS_MISSING',
            'DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL',
          ])
          if (staleS3Changes.length > 0) {
            changes.push(...staleS3Changes)
            updated = true
          }
        }

        const currentMappings = {
          ...todoMappings,
          ...buildL1InterfaceBlobSourcePrepEnv({
            beaconRpcUrl: this.getConfigValue("ethereumDa.beaconRpcUrl"),
            s3KeyPrefix: s3ArchiveEnabled ? s3Archive?.keyPrefix : undefined,
            s3PublicBaseUrl: s3ArchiveEnabled ? s3PublicBaseUrl : undefined,
            s3TimeoutMs: s3ArchiveEnabled ? s3Archive?.timeoutMs : undefined,
            s3TreatForbiddenAsMissing: s3ArchiveEnabled ? s3Archive?.treatForbiddenAsMissing : undefined,
          }),
        }

        for (const [envKey, newVal] of Object.entries(currentMappings)) {
          if (newVal === undefined || newVal === null || String(newVal).trim() === '') continue

          const oldValue = productionYaml.configMaps.env.data[envKey];
          if (oldValue !== newVal) {
            productionYaml.configMaps.env.data[envKey] = newVal;
            updated = true;
            changes.push({ key: `configMaps.env.data.${envKey}`, newValue: newVal, oldValue: oldValue || 'undefined' });
          }
        }
      }

      else if (chartName === 'withdrawal-processor') {
        if (!productionYaml.env) {
          this.error(`${chartName}: env not found in config`);
        }

        const dogecoinIndexerStartHeight = Number(this.dogeConfig.defaults?.dogecoinIndexerStartHeight)
        if (!Number.isFinite(dogecoinIndexerStartHeight)) {
          this.error(`${chartName}: dogeConfig.defaults.dogecoinIndexerStartHeight must be configured before preparing charts`);
        }

        const s3Archive = this.dogeConfig.ethereumDa?.blobArchive?.s3
        const s3ArchiveEnabled = truthyConfigValue(s3Archive?.enabled)

        // Deployment configuration is TOML-owned: merge the derived facts into
        // the managed deployment block of the native WithdrawalProcessor.toml.
        // Operator tuning of other keys inside that block survives the merge.
        const { defaults, deletePaths, facts } = buildWithdrawalDeploymentFacts({
          bridgeAddress: this.withdrawalProcessorConfig.bridge_address,
          dogecoinIndexerStartHeight,
          dogecoinRpcUrl: dogecoinInternalUrl,
          ethereumDa: {
            beaconRpcUrl: this.getConfigValue('ethereumDa.beaconRpcUrl'),
            ethChainId: this.getConfigValue('ethereumDa.chainId'),
            expectedBatcherAddress: this.getConfigValue('accounts.L1_COMMIT_SENDER_ADDR'),
            inboxWorkerStartBlock: this.dogeConfig.defaults?.ethereumDaEmbeddedIndexerStartBlock,
            l1RpcUrl: this.getConfigValue('ethereumDa.submitterRpcUrl'),
            l2ChainId: this.getConfigValue('general.CHAIN_ID_L2'),
            minFinality: this.getConfigValue('ethereumDa.minFinality'),
            s3: {
              enabled: s3ArchiveEnabled,
              keyPrefix: s3Archive?.keyPrefix,
              publicBaseUrl: s3PublicBaseUrl,
              timeoutMs: s3Archive?.timeoutMs,
              treatForbiddenAsMissing: s3Archive?.treatForbiddenAsMissing,
            },
          },
          genesisSequencerTxid: this.withdrawalProcessorConfig.genesis_sequencer_txid,
          genesisSequencerVout: this.withdrawalProcessorConfig.genesis_sequencer_vout,
          initialBridgeRedeemScriptHex: this.bridgeConfig.redeem_script_hex,
          l2BootstrapNextStartingBlockHeight: this.dogeConfig.defaults?.l2BootstrapNextStartingBlockHeight,
          l2MessageQueueAddress: this.getConfigValue('contractsFile.L2_MESSAGE_QUEUE_ADDR'),
          l2MessengerAddress: this.getConfigValue('contractsFile.L2_DOGEOS_MESSENGER_PROXY_ADDR'),
          l2RpcUrl: this.getConfigValue('general.L2_RPC_ENDPOINT'),
          networkStr: this.withdrawalProcessorConfig.network_str,
        })

        const nativeConfigPath = path.resolve(path.dirname(path.resolve(valuesDir)), WITHDRAWAL_NATIVE_CONFIG_RELPATH)
        const nativeConfigExisted = fs.existsSync(nativeConfigPath)
        if (!nativeConfigExisted) {
          this.error(
            `withdrawal-processor native TOML template is missing: ${nativeConfigPath}. `
            + 'Copy withdrawal-processor/WithdrawalProcessor.toml from the scroll-sdk examples layout; '
            + 'prep-charts updates that file but never creates or embeds application TOML in values YAML.'
          )
        }

        // Legacy inline copies are discarded only after the scroll-sdk native
        // template is present; helm --set-file supplies the ConfigMap content.
        const inlineSource = removeInlineWithdrawalConfig(productionYaml)
        if (inlineSource !== undefined) {
          this.jsonCtx.addWarning(`withdrawal-processor: dropping inline configMaps ${WITHDRAWAL_CONFIG_FILE}; ${nativeConfigPath} is the source of truth`)

          changes.push({
            key: `configMaps.config.data.${WITHDRAWAL_CONFIG_FILE}`,
            newValue: `owned by ${nativeConfigPath}`,
            oldValue: 'inline TOML',
          })
          updated = true
        }

        const previousSource = fs.readFileSync(nativeConfigPath, 'utf8')
        const mergedSource = mergeWithdrawalManagedDeploymentBlock(previousSource, facts, { defaults, deletePaths })
        if (mergedSource !== previousSource) {
          fs.writeFileSync(nativeConfigPath, mergedSource)
          this.jsonCtx.info(`withdrawal-processor: updated ${nativeConfigPath}`)
        }

        const wiringBefore = JSON.stringify([
          productionYaml.args,
          productionYaml.configMaps?.config,
          productionYaml.persistence?.['withdrawal-processor-config'],
        ])
        ensureWithdrawalChartWiring(productionYaml)
        if (wiringBefore !== JSON.stringify([
          productionYaml.args,
          productionYaml.configMaps?.config,
          productionYaml.persistence?.['withdrawal-processor-config'],
        ])) {
          changes.push({ key: 'withdrawal-processor config wiring', newValue: 'canonical --config arg, ConfigMap, and mount', oldValue: 'non-canonical' })
          updated = true
        }

        const migratedEnvChanges = stripMigratedWithdrawalEnv(productionYaml)
        if (migratedEnvChanges.length > 0) {
          changes.push(...migratedEnvChanges)
          updated = true
        }

        const proofSystemMode = this.proofIntent.intent.mode
        if (ensureWithdrawalProofActivationSwitch(productionYaml, proofSystemMode)) {
          changes.push({
            key: 'withdrawalProof.enabled',
            newValue: productionYaml.withdrawalProof.enabled,
            oldValue: 'missing or non-canonical activation projection',
          })
          updated = true
        }

        // Rebuild all TSO signers so stale roles do not remain. Create the
        // array when absent: descriptor import must always reach TSO values.
        const existingSigners = Array.isArray(productionYaml.tsoSigners) ? productionYaml.tsoSigners : []
        const newSigners = buildTsoSigners(this.dogeConfig)
        if (JSON.stringify(existingSigners) !== JSON.stringify(newSigners)) {
          productionYaml.tsoSigners = newSigners
          updated = true;
          changes.push({
            key: 'tsoSigners',
            newValue: JSON.stringify(newSigners),
            oldValue: JSON.stringify(existingSigners),
          });
        }
      }

      else if (chartName === "cubesigner-signer") {
        if (!productionYaml.env) {
          this.error(`${chartName}: env not found in config`);
        }

        const namespace = deriveBridgeNamespaceId(
          path.join(process.cwd(), GENERATE_BRIDGE_INFO_FILE),
        )
        if (!namespace) {
          this.error(
            `${GENERATE_BRIDGE_INFO_FILE} missing a canonical namespace_id; ` +
            'run scrollsdk setup bridge-init --step 3-bridge-info first',
          )
        }

        const cubesignerChanges = [
          ...removeEnvArrayKeys(productionYaml, [
            // Retired compatibility/configuration surfaces. The signer now has
            // one correctness/TEE role and the prefixed cap is authoritative.
            'CUBESIGNER_MAX_PSBT_BASE64_LEN',
            'DOGEOS_CUBESIGNER_SIGNER_SIGNER_ROLE',
          ]),
          ...applyCubesignerPrepEnv(
            productionYaml,
            buildCubesignerPrepEnv(this.dogeConfig, namespace.value),
          ),
          ...ensureCubesignerPolicyKeyBinding(productionYaml),
        ]
        if (cubesignerChanges.length > 0) {
          updated = true
          changes.push(...cubesignerChanges)
        }
      }
      else if (chartName === "eth-da-submitter") {
        if (!productionYaml.configMaps?.env?.data) {
          this.error(`${chartName}: configMaps.env.data not found in config`);
        }

        try {
          validateDogeConfigEthereumDaForPrep(this.dogeConfig.ethereumDa)
        } catch (error: any) {
          this.error(error.message)
        }

        const s3Archive = this.dogeConfig.ethereumDa?.blobArchive?.s3
        const todoMappings = buildEthDaSubmitterPrepEnv({
          batch: this.dogeConfig.ethereumDa?.batch,
          ethereumChainId: this.getConfigValue("ethereumDa.chainId"),
          ethereumRpcUrl: this.getConfigValue("ethereumDa.submitterRpcUrl"),
          l2ChainId: this.getConfigValue("general.CHAIN_ID_L2"),
          l2RpcUrl: this.getConfigValue("general.L2_RPC_ENDPOINT"),
          l2StartBlockNumber: this.dogeConfig.ethereumDa?.l2StartBlockNumber,
          publish: this.dogeConfig.ethereumDa?.publish,
          s3Bucket: s3Archive?.bucket,
          s3Enabled: s3Archive?.enabled,
          s3EndpointUrl: s3Archive?.endpointUrl,
          s3ForcePathStyle: s3Archive?.forcePathStyle,
          s3InitialBackoffMs: s3Archive?.initialBackoffMs,
          s3KeyPrefix: s3Archive?.keyPrefix,
          s3MaxBackoffMs: s3Archive?.maxBackoffMs,
          s3MaxRetries: s3Archive?.maxRetries,
          s3PollIntervalMs: s3Archive?.pollIntervalMs,
          s3Region: s3Archive?.region,
          s3UploadingTimeoutMs: s3Archive?.uploadingTimeoutMs,
        })

        const signerConfig = this.requireSigner('l1CommitSender')
        if (signerConfig?.backend === 'aws_kms') {
          Object.assign(todoMappings, {
            "DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__KMS_EXPECTED_ADDRESS": signerConfig.expectedAddress,
            "DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__KMS_KEY_ID": signerConfig.kmsKeyId,
            "DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__KMS_REGION": signerConfig.kmsRegion,
            "DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__SIGNER_BACKEND": "aws_kms",
          })
        } else {
          Object.assign(todoMappings, {
            "DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__SIGNER_BACKEND": "local",
          })
        }

        const envData = productionYaml.configMaps.env.data;
        for (const [envKey, newValue] of Object.entries(todoMappings)) {
          if (newValue === undefined || newValue === null || String(newValue).trim() === '') continue

          if (envData[envKey] !== newValue) {
            const oldValue = envData[envKey];
            envData[envKey] = newValue;
            updated = true;
            changes.push({ key: `configMaps.env.data.${envKey}`, newValue: String(newValue), oldValue: String(oldValue || 'undefined') });
          }
        }

        const initialBatchChanges = applyEthDaSubmitterInitialBatchSidecar(
          productionYaml,
          this.dogeConfig.ethereumDa?.batch?.initialBatchSidecarJson
        )
        if (initialBatchChanges.length > 0) {
          changes.push(...initialBatchChanges)
          updated = true
        }

        if (signerConfig?.backend === 'aws_kms') {
          const kmsSignerChanges = removeConfigMapEnvKeys(productionYaml, [
            'DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__SUBMITTER_PRIVATE_KEY',
          ])
          if (kmsSignerChanges.length > 0) {
            changes.push(...kmsSignerChanges)
            updated = true
          }

          if (Array.isArray(productionYaml.envFrom)) {
            const nextEnvFrom = productionYaml.envFrom.filter((item: any) => item?.secretRef?.name !== 'eth-da-submitter-secret-env')
            if (nextEnvFrom.length !== productionYaml.envFrom.length) {
              productionYaml.envFrom = nextEnvFrom
              updated = true
              changes.push({ key: 'envFrom.eth-da-submitter-secret-env', newValue: 'removed', oldValue: 'present' })
            }
          }

          if (productionYaml.externalSecrets?.['eth-da-submitter-secret-env']) {
            delete productionYaml.externalSecrets['eth-da-submitter-secret-env']
            if (Object.keys(productionYaml.externalSecrets).length === 0) delete productionYaml.externalSecrets
            updated = true
            changes.push({ key: 'externalSecrets.eth-da-submitter-secret-env', newValue: 'removed', oldValue: 'present' })
          }

          productionYaml.serviceAccount ||= {}
          const previousServiceAccount = JSON.stringify(productionYaml.serviceAccount)
          productionYaml.serviceAccount.create = true
          productionYaml.serviceAccount.name = signerConfig.serviceAccountName || 'eth-da-submitter'
          if (signerConfig.serviceAccountRoleArn) {
            productionYaml.serviceAccount.annotations ||= {}
            productionYaml.serviceAccount.annotations['eks.amazonaws.com/role-arn'] = signerConfig.serviceAccountRoleArn
          }

          const nextServiceAccount = JSON.stringify(productionYaml.serviceAccount)
          if (previousServiceAccount !== nextServiceAccount) {
            updated = true
            changes.push({ key: 'serviceAccount', newValue: nextServiceAccount, oldValue: previousServiceAccount })
          }
        } else {
          const localSignerChanges = removeConfigMapEnvKeys(productionYaml, [
            'DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__KMS_EXPECTED_ADDRESS',
            'DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__KMS_KEY_ID',
            'DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__KMS_REGION',
          ])
          ensureNamedSecretRef(productionYaml, 'eth-da-submitter-secret-env', localSignerChanges)
          if (localSignerChanges.length > 0) {
            changes.push(...localSignerChanges)
            updated = true
          }
        }
      }
      else if (chartName === "tso-service") {
        if (!productionYaml.env) {
          this.error(`${chartName}: env not found in config`);
        }

        const todoMappings = {
          "DOGE_NETWORK": this.dogeConfig.network,
          "TIMEOUT_CHECK_INTERVAL_SECONDS": "60",
          "TSO_CORRECTNESS_MAX_PSBT_BASE64_LEN": "130048",
          "TSO_CUBESIGNER_MAX_PSBT_BASE64_LEN": "130048",
        }

        for (const [envKey, newValue] of Object.entries(todoMappings)) {
          const envVar = productionYaml.env.find((item: any) => item.name === envKey);
          if (envVar) {
            if (envVar.value !== newValue) {
              const oldValue = envVar.value;
              envVar.value = newValue;
              updated = true;
              changes.push({ key: `env.${envKey}`, newValue, oldValue });
            }
          } else {
            productionYaml.env.push({ name: envKey, value: newValue });
            updated = true;
            changes.push({ key: `env.${envKey}`, newValue, oldValue: 'undefined' });
          }
        }
      }
      else if (chartName === "metrics-exporter") {

        const rollupExplorerBackendUrl = "http://rollup-explorer-backend";
        const l2RpcEndpoint = this.getConfigValue("general.L2_RPC_ENDPOINT");
        const l2TxFeeVaultAddr = this.getConfigValue("contracts.overrides.L2_TX_FEE_VAULT");
        const l2BridgeFeeRecipientAddr = this.getConfigValue("contracts.L2_BRIDGE_FEE_RECIPIENT_ADDR");
        const isDogeos = this.getConfigValue("general.L1_RPC_ENDPOINT") === L1_INTERFACE_RPC_ENDPOINT;
        const l1MessageQueueProxyAddr = isDogeos ? "" : this.getConfigValue("contractsFile.L1_MESSAGE_QUEUE_V2_PROXY_ADDR");
        const l1RpcEndpoint = this.getConfigValue("general.L1_RPC_ENDPOINT");

        if (productionYaml.metricsConfig) {
          if (productionYaml.metricsConfig.rollup.url !== rollupExplorerBackendUrl) {
            updated = true;
            changes.push({
              key: `metricsConfig.rollup.url`, newValue: rollupExplorerBackendUrl,
              oldValue: productionYaml.metricsConfig.rollup.url
            });
            productionYaml.metricsConfig.rollup.url = rollupExplorerBackendUrl;
          }

          if (productionYaml.metricsConfig.l1Network.url !== l1RpcEndpoint) {
            updated = true;
            changes.push({
              key: `metricsConfig.l1Network.url`, newValue: l1RpcEndpoint,
              oldValue: productionYaml.metricsConfig.l1Network.url
            });
            productionYaml.metricsConfig.l1Network.url = l1RpcEndpoint;
          }

          if (productionYaml.metricsConfig.l1Network.L1_MESSAGE_QUEUE_PROXY_ADDR !== l1MessageQueueProxyAddr) {
            updated = true;
            changes.push({
              key: `metricsConfig.l1Network.L1_MESSAGE_QUEUE_PROXY_ADDR`, newValue: l1MessageQueueProxyAddr,
              oldValue: productionYaml.metricsConfig.l1Network.L1_MESSAGE_QUEUE_PROXY_ADDR
            });
            productionYaml.metricsConfig.l1Network.L1_MESSAGE_QUEUE_PROXY_ADDR = l1MessageQueueProxyAddr;
          }

          if (productionYaml.metricsConfig.dogecoin.url !== dogecoinInternalUrl) {
            updated = true;
            changes.push({
              key: `metricsConfig.dogecoin.url`, newValue: dogecoinInternalUrl,
              oldValue: productionYaml.metricsConfig.dogecoin.url
            });
            productionYaml.metricsConfig.dogecoin.url = dogecoinInternalUrl;
          }

          if (productionYaml.metricsConfig.dogeos.url !== l2RpcEndpoint) {
            updated = true;
            changes.push({
              key: `metricsConfig.dogeos.url`, newValue: l2RpcEndpoint,
              oldValue: productionYaml.metricsConfig.dogeos.url
            });
            productionYaml.metricsConfig.dogeos.url = l2RpcEndpoint;
          }

          if (productionYaml.metricsConfig.dogeos.L2_TX_FEE_VAULT_ADDR !== l2TxFeeVaultAddr) {
            updated = true;
            changes.push({
              key: `metricsConfig.dogeos.L2_TX_FEE_VAULT_ADDR`, newValue: l2TxFeeVaultAddr,
              oldValue: productionYaml.metricsConfig.dogeos.L2_TX_FEE_VAULT_ADDR
            });
            productionYaml.metricsConfig.dogeos.L2_TX_FEE_VAULT_ADDR = l2TxFeeVaultAddr;
          }

          if (productionYaml.metricsConfig.dogeos.L2_BRIDGE_FEE_RECIPIENT_ADDR !== l2BridgeFeeRecipientAddr) {
            updated = true;
            changes.push({
              key: `metricsConfig.dogeos.L2_BRIDGE_FEE_RECIPIENT_ADDR`, newValue: l2BridgeFeeRecipientAddr,
              oldValue: productionYaml.metricsConfig.dogeos.L2_BRIDGE_FEE_RECIPIENT_ADDR
            });
            productionYaml.metricsConfig.dogeos.L2_BRIDGE_FEE_RECIPIENT_ADDR = l2BridgeFeeRecipientAddr;
          }
        } else {
          productionYaml.metricsConfig = {
            dogecoin: {
              url: dogecoinInternalUrl
            },
            dogeos: {
              L2_BRIDGE_FEE_RECIPIENT_ADDR: l2BridgeFeeRecipientAddr,
              L2_TX_FEE_VAULT_ADDR: l2TxFeeVaultAddr,
              url: this.getConfigValue("general.L2_RPC_ENDPOINT")
            },
            l1Network: {
              L1_MESSAGE_QUEUE_PROXY_ADDR: l1MessageQueueProxyAddr,
              url: l1RpcEndpoint
            },
            rollup: {
              url: rollupExplorerBackendUrl
            }
          };
          updated = true;
          changes.push({
            key: `metricsConfig`, newValue: JSON.stringify(productionYaml.metricsConfig),
            oldValue: "undefined"
          });
        }
      }
      else if (chartName === "dogecoin") {
        const isRegtest = this.dogeConfig.network === "regtest";
        const isTestnet = this.dogeConfig.network === "testnet";
        if (!productionYaml.dogecoinConf || typeof productionYaml.dogecoinConf !== 'object') {
          productionYaml.dogecoinConf = {}
        }

        if (!productionYaml.service || typeof productionYaml.service !== 'object') {
          productionYaml.service = {}
        }

        if (!productionYaml.storage || typeof productionYaml.storage !== 'object') {
          productionYaml.storage = {}
        }

        if (productionYaml.fullnameOverride !== dogecoinEndpoints.serviceName) {
          const oldValue = productionYaml.fullnameOverride;
          productionYaml.fullnameOverride = dogecoinEndpoints.serviceName;
          updated = true;
          changes.push({ key: `fullnameOverride`, newValue: dogecoinEndpoints.serviceName, oldValue: String(oldValue || 'undefined') });
        }

        const dogecoinConf_regtest = productionYaml.dogecoinConf?.regtest;
        const expected_regtest = isRegtest ? 1 : 0;
        if (dogecoinConf_regtest !== expected_regtest) {
          productionYaml.dogecoinConf.regtest = expected_regtest;
          updated = true;
          changes.push({ key: `dogecoinConf.regtest`, newValue: String(expected_regtest), oldValue: String(dogecoinConf_regtest) });
        }

        const dogecoinConf_testnet = productionYaml.dogecoinConf?.testnet;
        const expected_testnet = isTestnet ? 1 : 0;
        if (dogecoinConf_testnet !== expected_testnet) {
          productionYaml.dogecoinConf.testnet = expected_testnet;
          updated = true;
          changes.push({ key: `dogecoinConf.testnet`, newValue: String(expected_testnet), oldValue: String(dogecoinConf_testnet) });
        }

        const service_port = productionYaml.service?.port;
        const expected_service_port = dogecoinEndpoints.p2pPort;
        if (service_port !== expected_service_port) {
          productionYaml.service.port = expected_service_port;
          updated = true;
          changes.push({ key: `service.port`, newValue: String(expected_service_port), oldValue: String(service_port) });
        }

        const service_rpcPort = productionYaml.service?.rpcPort;
        const expected_service_rpcPort = dogecoinEndpoints.rpcPort;
        if (service_rpcPort !== expected_service_rpcPort) {
          productionYaml.service.rpcPort = expected_service_rpcPort;
          updated = true;
          changes.push({ key: `service.rpcPort`, newValue: String(expected_service_rpcPort), oldValue: String(service_rpcPort) });
        }

        const storage_size = productionYaml.storage?.size;
        const expected_storage_size = isRegtest || isTestnet ? "50Gi" : "250Gi";
        if (storage_size !== expected_storage_size) {
          productionYaml.storage.size = expected_storage_size;
          updated = true;
          changes.push({ key: `storage.size`, newValue: String(expected_storage_size), oldValue: String(storage_size) });
        }

        // let rpcPassword = productionYaml.rpcPassword;
        // let expectedRpcPassword = this.dogeConfig.dogecoinClusterRpc?.password;
        // if (rpcPassword !== expectedRpcPassword) {
        //   productionYaml.rpcPassword = expectedRpcPassword;
        //   updated = true;
        //   changes.push({ key: `rpcPassword`, oldValue: String(rpcPassword), newValue: String(expectedRpcPassword) });
        // }

        const rpcUser = productionYaml.dogecoinConf?.rpcuser;
        const expectedRpcUser = this.dogeConfig.dogecoinClusterRpc?.username;
        if (rpcUser !== expectedRpcUser) {
          productionYaml.dogecoinConf.rpcuser = expectedRpcUser;
          updated = true;
          changes.push({ key: `dogecoinConf.rpcuser`, newValue: String(expectedRpcUser), oldValue: String(rpcUser) });
        }

        // Process dogecoin ingress.
        let ingressUpdated = false;
        if (productionYaml.ingress) {
          const configValue = this.getConfigValue('ingress.DOGECOIN_HOST');
          ingressUpdated = this.processIngressHosts(productionYaml.ingress, configValue, changes);
        }

        if (ingressUpdated) {
          updated = true;
        }
      }
      else if (chartName === "testnet-activity-helper") {
        const l2RpcEndpoint = this.getConfigValue("general.L2_RPC_ENDPOINT");
        if (productionYaml.config?.externalRpcUriL2 !== l2RpcEndpoint) {
          productionYaml.config.externalRpcUriL2 = l2RpcEndpoint;
          updated = true;
          changes.push({ key: `config.externalRpcUriL2`, newValue: l2RpcEndpoint, oldValue: productionYaml.config?.externalRpcUriL2 });
        }
      }

      if (updated) {
        if (!this.jsonMode) {
          this.log(`\nFor ${chalk.cyan(file)}:`)
          this.log(chalk.green('Changes:'))
          for (const change of changes) {
            this.log(`  ${chalk.yellow(change.key)}: ${change.oldValue} -> ${change.newValue}`)
          }
        }

        let shouldUpdate = this.nonInteractive
        if (!this.nonInteractive) {
          shouldUpdate = await confirm({ message: `Do you want to apply these changes to ${file}?` })
        }

        if (shouldUpdate) {
          const yamlString = yaml.dump(productionYaml, YAML_DUMP_OPTIONS)

          fs.writeFileSync(yamlPath, yamlString)
          this.jsonCtx.logSuccess(`Updated ${file}`)
          updatedCharts++
        } else {
          this.jsonCtx.info(`Skipped updating ${file}`)
          skippedCharts++
        }
      } else {
        this.jsonCtx.info(`No changes needed in ${file}`)
        skippedCharts++
      }
    }


    return { skipped: skippedCharts, updated: updatedCharts }
  }

  private async processSequencerRethInstanceFiles(valuesDir: string): Promise<{ skipped: number; updated: number }> {
    const instances = this.dogeConfig.sequencerReth?.instances ?? []
    if (instances.length === 0) return { skipped: 0, updated: 0 }

    let updatedCharts = 0
    let skippedCharts = 0
    const templateFilePath = path.join(valuesDir, 'l2-reth-sequencer-production.yaml')

    for (const instance of instances) {
      const destFilePath = path.join(valuesDir, getSequencerRethValuesFileName(instance.index))
      if (fs.existsSync(destFilePath)) {
        skippedCharts++
        continue
      }

      if (!fs.existsSync(templateFilePath)) {
        this.error(
          `${getSequencerRethValuesFileName(instance.index)} not found and reth template ${templateFilePath} is missing. ` +
          `Create l2-reth-sequencer-production.yaml or ${getSequencerRethValuesFileName(instance.index)}; prep-charts will not reuse old l2-sequencer values.`
        )
      }

      const templateContent = fs.readFileSync(templateFilePath, 'utf8')
      const newYamlContent = templateContent.replaceAll('__INSTANCE_INDEX__', instance.index.toString())
      fs.writeFileSync(destFilePath, newYamlContent)
      this.jsonCtx.logSuccess(`Created ${path.relative(process.cwd(), destFilePath) || destFilePath}`)
      updatedCharts++
    }

    return { skipped: skippedCharts, updated: updatedCharts }
  }

  private rebaseProofIntentForStaging(
    transaction: GenerationTransaction,
    resolved: ResolvedProofIntent,
  ): ResolvedProofIntent {
    let sourcePath = resolved.source.path
    try {
      sourcePath = transaction.toStagingPath(sourcePath)
    } catch {
      // An explicitly selected source outside the deployment root remains
      // read-only and is recorded as an absolute contract path.
    }

    let {release} = resolved.intent
    if (release) {
      const originalRelease = path.resolve(transaction.originalRoot, release)
      try {
        transaction.toStagingPath(originalRelease)
      } catch {
        // Preserve an external release root instead of resolving its relative
        // spelling against the temporary generation workspace.
        release = originalRelease
      }
    }

    return {
      intent: {
        ...resolved.intent,
        ...(release ? {release} : {}),
      },
      source: {
        ...resolved.source,
        path: sourcePath,
      },
    }
  }

  private rebaseProofResultFromStaging(
    transaction: GenerationTransaction,
    result: ReconcileProofKubernetesResult,
  ): ReconcileProofKubernetesResult {
    const workerBundle = result.workerBundle
      ? {
          ...result.workerBundle,
          bundleDir: transaction.toOriginalPath(result.workerBundle.bundleDir),
          files: result.workerBundle.files.map(file => transaction.toOriginalPath(file)),
          manifestFile: transaction.toOriginalPath(result.workerBundle.manifestFile),
          ...('releaseManifestFile' in result.workerBundle
            ? {
                releaseManifestFile: transaction.toOriginalPath(
                  result.workerBundle.releaseManifestFile,
                ),
              }
            : {}),
        }
      : undefined
    return {
      ...result,
      files: result.files.map(file => transaction.toOriginalPath(file)),
      release: {
        artifactManifest: transaction.toOriginalPath(result.release.artifactManifest),
        programManifests: result.release.programManifests
          .map(file => transaction.toOriginalPath(file)),
        releaseRoot: transaction.toOriginalPath(result.release.releaseRoot),
        statementNamespace: transaction.toOriginalPath(result.release.statementNamespace),
      },
      ...(workerBundle ? {workerBundle} : {}),
    }
  }

  private reconcileProofKubernetes(valuesDir: string): ReconcileProofKubernetesResult {
    const coordinatorIngressHost = this.getConfigValue('ingress.PROOF_COORDINATOR_HOST')
    const result = reconcileProofKubernetes({
      aggregationL2ChainId: this.getConfigValue('general.CHAIN_ID_L2') as number | string | undefined,
      coordinatorIngressHost: typeof coordinatorIngressHost === 'string'
        ? coordinatorIngressHost
        : undefined,
      deploymentDir: process.cwd(),
      intent: this.proofIntent,
      valuesDir,
    })
    this.jsonCtx.logSuccess(
      `Reconciled ${result.mode} proof K8s configuration; contract ${result.contract.generationId}`,
    )
    if (result.workerBundle && result.mode === 'mock') {
      this.jsonCtx.addWarning(
        `Mock worker bundle ${result.workerBundle.bundleId} is credential-pending. `
        + 'Hydrate prover-worker.env on the worker host before running setup proof-worker-check.',
      )
    } else if (result.workerBundle) {
      this.jsonCtx.addWarning(
        `Production worker bundle ${result.workerBundle.bundleId} is credential-pending. `
        + 'Run setup proof-worker to inject the bearer token, sync the release and bundle to the GPU host, '
        + 'then run setup proof-worker-check before docker compose up.',
      )
    }

    return result
  }

  private removeLegacyRethTrustedPeersEnv(productionYaml: any): boolean {
    if (!productionYaml.configMaps?.env?.data || !('RETH_TRUSTED_PEERS' in productionYaml.configMaps.env.data)) {
      return false
    }

    delete productionYaml.configMaps.env.data.RETH_TRUSTED_PEERS
    return true
  }

  private requireSigner(signerKey: 'l1CommitSender' | 'l2GasOracleSender') {
    try {
      return getRequiredManagedSignerConfig(this.dogeConfig, signerKey)
    } catch (error) {
      this.jsonCtx.error(
        'E610_SIGNER_CONFIG_MISSING',
        error instanceof Error ? error.message : String(error),
        'CONFIGURATION',
        true,
        { signer: signerKey }
      )
    }
  }

  private async validateMakefile(skipAuthCheck: boolean): Promise<void> {
    this.log(chalk.blue('Validating Makefile...'))
    const makefilePath = path.join(process.cwd(), 'Makefile')
    if (!fs.existsSync(makefilePath)) {
      this.error('Makefile not found in the current directory.')
    }

    const makefileContent = fs.readFileSync(makefilePath, 'utf8')
    const installCommands = makefileContent.match(/helm\s+upgrade\s+-i.*?(?=\n\n|Z)/gs)

    if (!installCommands) {
      this.warn('No Helm upgrade commands found in the Makefile.')
      return
    }

    for (const command of installCommands) {
      const chartNameMatch = command.match(/upgrade\s+-i\s+(\S+)/)
      const ociMatch = command.match(/oci:\/\/(\S+)/)
      const ociVersionMatch = command.match(/--version\s*=\s*(\S+)\s+/);

      if (chartNameMatch && ociMatch) {
        const chartName = chartNameMatch[1]
        const ociUrl = ociMatch[0]
        const ociVersion = ociVersionMatch && ociVersionMatch.length > 1 ? ociVersionMatch[1] : "";

        if (!skipAuthCheck) {
          const hasAccess = this.validateOCIAccess(ociUrl, ociVersion)

          if (hasAccess) {
            this.log(chalk.green(`Access verified for chart: ${chartName}`))
          } else {
            this.log(chalk.red(`Unable to access chart: ${chartName}`))
            this.log('This might be due to authentication issues.')
            this.log('To authenticate, run the command with the following flags:')
            this.log('--github-username=your-username --github-token=your-personal-access-token')
            this.log('You can create a Personal Access Token at: https://github.com/settings/tokens')
            this.log('Ensure the token has the necessary permissions to access the required repositories.')
          }
        }

        const valuesFileMatches = command.match(/-f\s+(\S+)/g)
        if (valuesFileMatches) {
          for (const match of valuesFileMatches) {
            const valuesFile = match.split(' ')[1]
            if (fs.existsSync(valuesFile)) {
              this.log(chalk.green(`Values file verified: ${valuesFile}`))
            } else {
              this.log(chalk.red(`Values file not found: ${valuesFile}`))
            }
          }
        }
      }
    }
  }

  private validateOCIAccess(ociUrl: string, ociVersion: string): boolean {
    try {
      const args = ['show', 'chart', ociUrl]
      if (ociVersion) {
        args.push('--version', ociVersion)
      }

      execFileSync('helm', args, { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }
}
