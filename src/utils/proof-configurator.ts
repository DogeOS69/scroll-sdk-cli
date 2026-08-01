/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and manifest-derived TOML tables are dynamic documents. */

import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  MOCK_BRIDGE_BACKEND_PROFILE,
  MOCK_PROGRAM_MANIFESTS_DIR,
  MOCK_SCROLL_BATCH_BACKEND_PROFILE,
  ensureMockProgramManifests,
  mockVerifierIds,
} from './mock-proof-topology.js'
import {
  type ProvingMode,
  WITHDRAWAL_NATIVE_CONFIG_RELPATH,
  ensureWithdrawalChartWiring,
  ensureWithdrawalProofActivationSwitch,
  removeInlineWithdrawalConfig,
  replaceWithdrawalManagedProofBlock,
} from './withdrawal-config.js'

export type { ProvingMode } from './withdrawal-config.js'

export type ProofFamily =
  | 'advance_l2_aggregation'
  | 'bridge_transition'
  | 'scroll_batch'
  | 'scroll_chunk'

export const DEFAULT_SCROLL_BATCH_BACKEND_PROFILE = 'scroll-prod-zkvm-batch-v1'
export const DEFAULT_BRIDGE_BACKEND_PROFILE = 'bridge-prod-zkvm-v1'
export const DEFAULT_PROOF_ARTIFACT_MANIFEST = 'proof-artifacts/release.json'
export const DEFAULT_PROOF_COORDINATOR_CONFIG = 'proof-coordinator/ProofCoordinator.toml'
export const DEFAULT_PROOF_PROGRAM_MANIFESTS = [
  'proof-artifacts/manifests/scroll-chunk.json',
  'proof-artifacts/manifests/scroll-batch.json',
  'proof-artifacts/manifests/advance-l2-aggregation.json',
  'proof-artifacts/manifests/bridge-transition.json',
]
export const DEFAULT_STATEMENT_NAMESPACE_CONFIG = 'proof-artifacts/manifests/statement-namespace.json'
const DEFAULT_SIGNED_URL_TTL_MS = 3_600_000
const DEFAULT_MAX_READ_BODY_BYTES = 512 * 1024 * 1024
const MAX_TRANSPORT_HORIZON_MS = 7 * 24 * 60 * 60 * 1000
const MAX_EMBEDDED_AGG_VK_BYTES = 700 * 1024
const PROOF_DATA_MOUNT_PATH = '/app/data'
const AGG_VK_PATH = '/app/data/verifier/agg-vk.bin'
const STATEMENT_NAMESPACE_CONFIG_PATH = '/app/data/manifests/statement-namespace.json'
const SCROLL_MATERIALIZER_BINARY_PATH = '/usr/local/bin/scroll-runtime-materializer'
const PROOF_SECRET_MOUNT_PATH = '/app/secrets'
const PROOF_WORK_TOKEN_PATH = `${PROOF_SECRET_MOUNT_PATH}/proof-work-token`
const PROVER_WORKER_TOKEN_PATH = `${PROOF_SECRET_MOUNT_PATH}/prover-worker-token`
const SCROLL_BATCH_COMMITMENT_ENV =
  'DOGEOS_PROOF_COORDINATOR_MATERIALIZER__SCROLL_BATCH__SUBPROCESS__CHUNK_PROGRAM_COMMITMENT_HEX'

interface ProofProgramManifest {
  artifacts: Array<{
    kind: 'app_vk' | 'app_vmexe' | 'openvm_config' | 'proving_params'
    sha256: string
    size_bytes: number
  }>
  circuit_id: string
  circuit_version: string
  hard_fork_name?: null | string
  program_commitment_hash: string
  proof_family: ProofFamily
  proof_system_id: string
  schema_version: number
  toolchain: {
    openvm_version: string
    rust_toolchain: string
  }
  verification_key_hash: string
}

interface ArtifactIdentity {
  advance_l2_aggregation_app_commit_raw?: string
  advance_l2_aggregation_program_commitment_hash?: string
  advance_l2_aggregation_verification_key_hash?: string
  batch_program_commitment_hash?: string
  batch_program_commitment_raw?: string
  batch_verification_key_hash?: string
  bridge_app_commit_raw?: string
  bridge_program_commitment_hash?: string
  bridge_verification_key_hash?: string
  chunk_program_commitment_hash?: string
  chunk_program_commitment_raw?: string
  chunk_verification_key_hash?: string
}

interface ArtifactFile {
  path: string
  sha256: string
}

interface ArtifactManifest {
  artifacts?: {
    agg_verifying_key?: ArtifactFile
  }
  expected_identity?: ArtifactIdentity
}

interface VerifierArtifact {
  base64: string
  sha256: string
}

export interface ConfigureProofValuesOptions {
  /** Ignored in mock proving mode (no release artifacts exist). */
  artifactManifestPath?: string
  bridgeBackendProfile?: string
  coordinatorConfigPath: string
  /**
   * Public HTTPS host for the proof-coordinator ingress (external prover
   * workers claim through it). When set, the coordinator values gain an
   * nginx + cert-manager ingress for this host.
   */
  coordinatorIngressHost?: string
  /** Ignored in mock proving mode (mock manifests are synthesized). */
  manifestPaths?: string[]
  /** Default `production`; `mock` stages the dev_dummy/prover-worker-mock lane. */
  provingMode?: ProvingMode
  scrollBatchBackendProfile?: string
  signerProofArtifactBaseUrl?: string
  /** Generated JSON passed to Helm with --set-file, never embedded in values. */
  statementNamespacePath?: string
  valuesDir: string
  verifierIds?: Partial<Record<ProofFamily, string>>
  /**
   * Required native WithdrawalProcessor.toml template. The managed proof block
   * is updated there and Helm supplies it with --set-file; application TOML is
   * never embedded in values YAML. Defaults to
   * withdrawal-processor/WithdrawalProcessor.toml next to the values directory.
   */
  withdrawalConfigPath?: string
}

export interface HelmSetFileBinding {
  filePath: string
  key: string
}

export interface ConfigureProofValuesResult {
  artifactReadBaseUrlMapping: 'custom-gateway-root' | 'custom-prefix-path' | 'native-s3-prefix'
  configFile: string
  families: ProofFamily[]
  files: string[]
  helmSetFiles: {
    proofCoordinator: HelmSetFileBinding[]
    withdrawalProcessor: HelmSetFileBinding[]
  }
  provingMode: ProvingMode
  signerProofArtifactBaseUrl: string
  signerProofArtifactBaseUrlSource: 'flag' | 'staged'
  statementNamespaceFile: string
}

export interface ConfigureDisabledProofResult {
  files: string[]
  helmSetFiles: {
    proofCoordinator: HelmSetFileBinding[]
    withdrawalProcessor: HelmSetFileBinding[]
  }
  provingMode: undefined
}

export const MANAGED_VERIFIER_BEGIN = '# BEGIN scrollsdk managed verifier configuration'
export const MANAGED_VERIFIER_END = '# END scrollsdk managed verifier configuration'

const FAMILY_CONFIG_KEYS: Record<ProofFamily, string> = {
  advance_l2_aggregation: 'advance_l2_aggregation_verifier_identity',
  bridge_transition: 'scroll_bridge_verifier_identity',
  scroll_batch: 'scroll_batch_verifier_identity',
  scroll_chunk: 'scroll_chunk_verifier_identity',
}

const FAMILY_PREFIXES: Record<ProofFamily, string> = {
  advance_l2_aggregation: 'ADVANCE_L2_AGGREGATION',
  bridge_transition: 'SCROLL_BRIDGE',
  scroll_batch: 'SCROLL_BATCH',
  scroll_chunk: 'SCROLL_CHUNK',
}

const RAW_COMMITMENT_KEYS: Record<ProofFamily, keyof ArtifactIdentity> = {
  advance_l2_aggregation: 'advance_l2_aggregation_app_commit_raw',
  bridge_transition: 'bridge_app_commit_raw',
  scroll_batch: 'batch_program_commitment_raw',
  scroll_chunk: 'chunk_program_commitment_raw',
}

const PROGRAM_COMMITMENT_HASH_KEYS: Record<ProofFamily, keyof ArtifactIdentity> = {
  advance_l2_aggregation: 'advance_l2_aggregation_program_commitment_hash',
  bridge_transition: 'bridge_program_commitment_hash',
  scroll_batch: 'batch_program_commitment_hash',
  scroll_chunk: 'chunk_program_commitment_hash',
}

const VERIFICATION_KEY_HASH_KEYS: Record<ProofFamily, keyof ArtifactIdentity> = {
  advance_l2_aggregation: 'advance_l2_aggregation_verification_key_hash',
  bridge_transition: 'bridge_verification_key_hash',
  scroll_batch: 'batch_verification_key_hash',
  scroll_chunk: 'chunk_verification_key_hash',
}

// Registry-facing proof-kind tags carried on the signer evidence envelope's
// required_proof_artifacts (see dogeos-core withdrawal_processor evidence.rs):
// only the bridge state-transition proof and the inner ScrollBatch proof cross
// the signer boundary; scroll_chunk proofs are aggregated into the batch.
const ENVELOPE_PROOF_KINDS: ReadonlyArray<readonly [ProofFamily, string]> = [
  ['bridge_transition', 'openvm_state_transition'],
  ['scroll_batch', 'scroll_batch'],
]

function readJson<T>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch (error) {
    throw new Error(`Cannot read JSON ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value) > 256) {
    throw new Error(`${label} must be a non-empty string of at most 256 bytes`)
  }

  if (/<(?:auto|todo)>|placeholder/i.test(value)) {
    throw new Error(`${label} must not contain an unresolved placeholder`)
  }
}

function normalizeHex(value: unknown, bytes: number, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const normalized = value.toLowerCase()
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be canonical 0x-prefixed ${bytes}-byte hex`)
  }

  return normalized
}

function bareHex(value: string, bytes: number, label: string): string {
  return normalizeHex(value, bytes, label).slice(2)
}

function parsePositiveInteger(
  value: unknown,
  fallback: number,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`)
  }

  return parsed
}

function assertJsonObjectKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }

  const keys = Object.keys(value)
  const unknown = keys.filter(key => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${label} contains unknown field(s): ${unknown.join(', ')}`)
  const missing = required.filter(key => !Object.hasOwn(value, key))
  if (missing.length > 0) throw new Error(`${label} is missing required field(s): ${missing.join(', ')}`)
}

/** Mirror dogeos_proof_worker_contract::ProofProgramManifestV1 validation. */
function validateProgramManifestShape(manifest: ProofProgramManifest, manifestPath: string): void {
  const topLevel = [
    'artifacts',
    'circuit_id',
    'circuit_version',
    'hard_fork_name',
    'program_commitment_hash',
    'proof_family',
    'proof_system_id',
    'schema_version',
    'toolchain',
    'verification_key_hash',
  ] as const
  assertJsonObjectKeys(
    manifest,
    topLevel,
    topLevel.filter(key => key !== 'hard_fork_name'),
    manifestPath
  )
  assertJsonObjectKeys(
    manifest.toolchain,
    ['openvm_version', 'rust_toolchain'],
    ['openvm_version', 'rust_toolchain'],
    `${manifestPath}: toolchain`
  )
  assertIdentifier(manifest.toolchain.openvm_version, `${manifestPath}: toolchain.openvm_version`)
  assertIdentifier(manifest.toolchain.rust_toolchain, `${manifestPath}: toolchain.rust_toolchain`)

  if (!Array.isArray(manifest.artifacts)) throw new Error(`${manifestPath}: artifacts must be an array`)
  const kindOrder = ['app_vmexe', 'openvm_config', 'app_vk', 'proving_params'] as const
  let previous = -1
  for (const [index, artifact] of manifest.artifacts.entries()) {
    const label = `${manifestPath}: artifacts[${index}]`
    assertJsonObjectKeys(artifact, ['kind', 'sha256', 'size_bytes'], ['kind', 'sha256', 'size_bytes'], label)
    const order = kindOrder.indexOf(artifact.kind)
    if (order < 0) throw new Error(`${label}.kind is unsupported: ${String(artifact.kind)}`)
    if (order <= previous) {
      throw new Error(`${manifestPath}: artifacts must use unique kinds in canonical order (${kindOrder.join(', ')})`)
    }

    previous = order
    artifact.sha256 = normalizeHex(artifact.sha256, 32, `${label}.sha256`)
    if (typeof artifact.size_bytes !== 'number') throw new Error(`${label}.size_bytes must be a JSON integer`)
    parsePositiveInteger(artifact.size_bytes, 1, `${label}.size_bytes`)
  }

  if (manifest.artifacts[0]?.kind !== 'app_vmexe' || manifest.artifacts[1]?.kind !== 'openvm_config') {
    throw new Error(`${manifestPath}: artifacts must contain app_vmexe followed by openvm_config`)
  }
}

function loadProgramManifests(paths: string[]): Map<ProofFamily, { manifest: ProofProgramManifest; path: string }> {
  if (paths.length === 0) throw new Error('At least one --program-manifest is required')
  const manifests = new Map<ProofFamily, { manifest: ProofProgramManifest; path: string }>()
  const basenames = new Set<string>()

  for (const manifestPath of paths.map(item => path.resolve(item))) {
    const manifest = readJson<ProofProgramManifest>(manifestPath)
    validateProgramManifestShape(manifest, manifestPath)
    if (manifest.schema_version !== 1) throw new Error(`${manifestPath}: unsupported schema_version ${manifest.schema_version}`)
    if (!Object.hasOwn(FAMILY_CONFIG_KEYS, manifest.proof_family)) {
      throw new Error(`${manifestPath}: unsupported proof_family ${String(manifest.proof_family)}`)
    }

    if (manifests.has(manifest.proof_family)) throw new Error(`Duplicate manifest for ${manifest.proof_family}`)
    const basename = path.basename(manifestPath)
    if (basenames.has(basename)) {
      throw new Error(`Duplicate program manifest basename ${basename}; mounted ConfigMap keys must be unique`)
    }

    basenames.add(basename)
    assertIdentifier(manifest.proof_system_id, `${manifestPath}: proof_system_id`)
    assertIdentifier(manifest.circuit_id, `${manifestPath}: circuit_id`)
    assertIdentifier(manifest.circuit_version, `${manifestPath}: circuit_version`)
    if (manifest.hard_fork_name !== null && manifest.hard_fork_name !== undefined) {
      assertIdentifier(manifest.hard_fork_name, `${manifestPath}: hard_fork_name`)
    }

    manifest.verification_key_hash = normalizeHex(manifest.verification_key_hash, 32, `${manifestPath}: verification_key_hash`)
    manifest.program_commitment_hash = normalizeHex(manifest.program_commitment_hash, 32, `${manifestPath}: program_commitment_hash`)
    manifests.set(manifest.proof_family, { manifest, path: manifestPath })
  }

  for (const family of Object.keys(FAMILY_CONFIG_KEYS) as ProofFamily[]) {
    if (!manifests.has(family)) {
      throw new Error(`Missing program manifest for required production proof family: ${family}`)
    }
  }

  return manifests
}

function loadRawCommitments(
  artifactManifestPath: string,
  manifests: Map<ProofFamily, { manifest: ProofProgramManifest; path: string }>
): Map<ProofFamily, string> {
  const artifactManifest = readJson<ArtifactManifest>(path.resolve(artifactManifestPath))
  if (!artifactManifest.expected_identity) throw new Error('Artifact manifest is missing expected_identity')
  const commitments = new Map<ProofFamily, string>()

  for (const [family, { manifest }] of manifests) {
    const key = RAW_COMMITMENT_KEYS[family]
    const raw = normalizeHex(artifactManifest.expected_identity[key], 64, `expected_identity.${key}`)
    const actualHash = `0x${createHash('sha256').update(Buffer.from(raw.slice(2), 'hex')).digest('hex')}`
    if (actualHash !== manifest.program_commitment_hash) {
      throw new Error(`${family}: sha256(${key}) ${actualHash} does not match program manifest ${manifest.program_commitment_hash}`)
    }

    const programHashKey = PROGRAM_COMMITMENT_HASH_KEYS[family]
    const releaseProgramHash = normalizeHex(
      artifactManifest.expected_identity[programHashKey],
      32,
      `expected_identity.${programHashKey}`
    )
    if (releaseProgramHash !== manifest.program_commitment_hash) {
      throw new Error(
        `${family}: expected_identity.${programHashKey} ${releaseProgramHash} does not match program manifest ${manifest.program_commitment_hash}`
      )
    }

    const verificationKey = VERIFICATION_KEY_HASH_KEYS[family]
    const releaseVerificationKeyHash = normalizeHex(
      artifactManifest.expected_identity[verificationKey],
      32,
      `expected_identity.${verificationKey}`
    )
    if (releaseVerificationKeyHash !== manifest.verification_key_hash) {
      throw new Error(
        `${family}: expected_identity.${verificationKey} ${releaseVerificationKeyHash} does not match program manifest ${manifest.verification_key_hash}`
      )
    }

    commitments.set(family, raw)
  }

  return commitments
}

function loadVerifierArtifact(artifactManifestPath: string): VerifierArtifact {
  const resolvedManifestPath = path.resolve(artifactManifestPath)
  const artifactManifest = readJson<ArtifactManifest>(resolvedManifestPath)
  const aggVk = artifactManifest.artifacts?.agg_verifying_key
  if (!aggVk) {
    throw new Error(`${resolvedManifestPath}: artifacts.agg_verifying_key is required`)
  }

  assertIdentifier(aggVk.path, `${resolvedManifestPath}: artifacts.agg_verifying_key.path`)
  if (typeof aggVk.sha256 !== 'string') {
    throw new TypeError(`${resolvedManifestPath}: artifacts.agg_verifying_key.sha256 must be a string`)
  }

  const expectedSha256 = aggVk.sha256.toLowerCase().replace(/^0x/, '')
  if (!/^[\da-f]{64}$/.test(expectedSha256)) {
    throw new Error(`${resolvedManifestPath}: artifacts.agg_verifying_key.sha256 must be a 32-byte hex digest`)
  }

  const artifactPath = path.isAbsolute(aggVk.path)
    ? aggVk.path
    : path.resolve(path.dirname(resolvedManifestPath), aggVk.path)
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(artifactPath)
  } catch (error) {
    throw new Error(`Cannot read aggregate verifying key ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (bytes.length === 0) throw new Error(`Aggregate verifying key is empty: ${artifactPath}`)
  if (bytes.length > MAX_EMBEDDED_AGG_VK_BYTES) {
    throw new Error(
      `Aggregate verifying key ${artifactPath} is ${bytes.length} bytes; the embedded ConfigMap limit is ${MAX_EMBEDDED_AGG_VK_BYTES} bytes`
    )
  }

  const actualSha256 = createHash('sha256').update(bytes).digest('hex')
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Aggregate verifying key SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`)
  }

  return { base64: bytes.toString('base64'), sha256: actualSha256 }
}

export function normalizeSignerProofArtifactBaseUrl(value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error('a proof artifact public base URL is required for bridge proof evidence')
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (error) {
    throw new Error(`proof artifact base URL must be an absolute URL: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('proof artifact base URL must not contain credentials, a query, or a fragment')
  }

  const hostname = parsed.hostname.replaceAll(/^\[|]$/g, '').toLowerCase()
  const loopback = hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('proof artifact base URL must use https:// (loopback http:// is allowed for dev/test)')
  }

  parsed.pathname = parsed.pathname.replaceAll(/\/+$/g, '') || '/'
  return parsed.toString().replaceAll(/\/$/g, '')
}

/**
 * Validate that an AWS-native S3 GET root includes the artifact-store key
 * prefix. Custom gateways may intentionally map their own root to that prefix,
 * so they remain supported but are classified for an operator-visible warning.
 */
export function classifyProofArtifactBaseUrlMapping(
  normalizedBaseUrl: string,
  store: { bucket: string; keyPrefix: string; region: string }
): ConfigureProofValuesResult['artifactReadBaseUrlMapping'] {
  const parsed = new URL(normalizedBaseUrl)
  const hostname = parsed.hostname.toLowerCase()
  const nativeS3Hosts = new Set([
    `${store.bucket}.s3.${store.region}.amazonaws.com`,
    `${store.bucket}.s3.amazonaws.com`,
  ])
  const nativePathStyleHosts = new Set([
    `s3.${store.region}.amazonaws.com`,
    `s3-${store.region}.amazonaws.com`,
    's3.amazonaws.com',
  ])
  const normalizedPath = parsed.pathname.replaceAll(/^\/+|\/+$/g, '')
  const normalizedPrefix = store.keyPrefix.replaceAll(/^\/+|\/+$/g, '')

  if (nativeS3Hosts.has(hostname)) {
    if (normalizedPath !== normalizedPrefix) {
      throw new Error(
        `proof artifact base URL for native S3 bucket ${store.bucket} must end at key prefix /${normalizedPrefix}; `
        + `got path /${normalizedPath}. Use https://${store.bucket}.s3.${store.region}.amazonaws.com/${normalizedPrefix}`
      )
    }

    return 'native-s3-prefix'
  }

  if (nativePathStyleHosts.has(hostname)) {
    const expectedPath = `${store.bucket}/${normalizedPrefix}`
    if (normalizedPath !== expectedPath) {
      throw new Error(
        `proof artifact base URL for native path-style S3 bucket ${store.bucket} must end at /${expectedPath}; `
        + `got path /${normalizedPath}`
      )
    }

    return 'native-s3-prefix'
  }

  if (normalizedPath === normalizedPrefix || normalizedPath.endsWith(`/${normalizedPrefix}`)) {
    return 'custom-prefix-path'
  }

  return 'custom-gateway-root'
}

function defaultVerifierId(manifest: ProofProgramManifest): string {
  return `${manifest.proof_system_id}-${manifest.circuit_id}-${manifest.circuit_version}`
    .toLowerCase()
    .replaceAll(/[^\d._a-z-]+/g, '-')
}

function verifierPolicy(
  manifest: ProofProgramManifest,
  manifestPath: string,
  verifierId: string
): Record<string, any> {
  const policy: Record<string, any> = {
    expected_circuit_id: manifest.circuit_id,
    expected_circuit_version: manifest.circuit_version,
    expected_program_commitment_hash_hex: manifest.program_commitment_hash,
    expected_proof_system_id: manifest.proof_system_id,
    expected_verification_key_hash_hex: manifest.verification_key_hash,
    program_manifest_path: `/app/data/manifests/${path.basename(manifestPath)}`,
    verifier_id: verifierId,
  }
  if (manifest.hard_fork_name !== null && manifest.hard_fork_name !== undefined) {
    policy.expected_hard_fork_name = manifest.hard_fork_name
  }

  return policy
}

/**
 * Render the attestation-signer envelope allowlist CSV from the same release
 * identities projected into WP and proof-coordinator. Format per signer
 * contract: `proof_kind:verifier_id:vk_hash` tokens joined by commas, with
 * bare lowercase 32-byte hex vk hashes (the signer's canonical form).
 */
function buildAllowedProofTriples(
  manifests: Map<ProofFamily, { manifest: ProofProgramManifest; path: string }>,
  verifierIds: Partial<Record<ProofFamily, string>>
): string {
  return ENVELOPE_PROOF_KINDS.map(([family, proofKind]) => {
    const { manifest } = manifests.get(family)!
    const verifierId = verifierIds[family] || defaultVerifierId(manifest)
    assertIdentifier(verifierId, `${family} verifier ID`)
    if (/[,:]/.test(verifierId)) {
      throw new Error(`${family} verifier ID must not contain ':' or ',' — it is embedded in the signer proof-triple CSV`)
    }

    const vkHash = bareHex(manifest.verification_key_hash, 32, `${family} verification key hash`)
    return `${proofKind}:${verifierId}:${vkHash}`
  }).join(',')
}

/** A value resolved from a deployment artifact instead of a CLI flag. */
export interface DerivedValue {
  source: string
  value: string
}

/**
 * Read the signer proof-artifact base URL that an earlier prep-charts run
 * staged into a WithdrawalProcessor.toml document, so later invocations
 * (prep-charts re-runs, export-signer-policy) do not need the value repeated.
 */
export function readStagedSignerProofArtifactBaseUrl(withdrawalConfigSource: string): string | undefined {
  const parsed = toml.parse(withdrawalConfigSource) as any
  const value = parsed?.proof_system?.signer_proof_artifact_base_url
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Derive the envelope proof-triple allowlist from deployment artifacts.
 *
 * Preferred source is the managed verifier block prep-charts staged into
 * ProofCoordinator.toml: it carries the deployed verifier identities including
 * any --verifier-id overrides, so the exported signer policy is guaranteed to
 * allow exactly what the coordinator enforces. Before prep-charts has run,
 * fall back to computing the same CSV from the release manifests; when neither
 * exists the proof topology is not staged yet and the caller keeps the
 * allowlist empty.
 */
export function deriveAllowedProofTriples(
  coordinatorConfigPath: string,
  manifestPaths: string[]
): DerivedValue | undefined {
  const configFile = path.resolve(coordinatorConfigPath)
  if (fs.existsSync(configFile)) {
    const parsed = toml.parse(fs.readFileSync(configFile, 'utf8')) as any
    const verifier = parsed?.verifier
    const triples: string[] = []
    for (const [family, proofKind] of ENVELOPE_PROOF_KINDS) {
      const identity = verifier?.[FAMILY_CONFIG_KEYS[family]]
      const verifierId = identity?.verifier_id
      const vkHash = identity?.expected_verification_key_hash_hex
      if (typeof verifierId !== 'string' || typeof vkHash !== 'string') break
      assertIdentifier(verifierId, `${family} verifier ID`)
      if (/[,:]/.test(verifierId)) {
        throw new Error(`${family} verifier ID must not contain ':' or ',' — it is embedded in the signer proof-triple CSV`)
      }

      triples.push(`${proofKind}:${verifierId}:${bareHex(vkHash, 32, `${family} verification key hash`)}`)
    }

    if (triples.length === ENVELOPE_PROOF_KINDS.length) {
      return { source: configFile, value: triples.join(',') }
    }
  }

  const resolvedManifests = manifestPaths.map(item => path.resolve(item))
  if (resolvedManifests.length > 0 && resolvedManifests.every(item => fs.existsSync(item))) {
    const manifests = loadProgramManifests(resolvedManifests)
    return { source: resolvedManifests.join(', '), value: buildAllowedProofTriples(manifests, {}) }
  }

  return undefined
}

function readYaml(filePath: string): any {
  if (!fs.existsSync(filePath)) throw new Error(`Values file not found: ${filePath}`)
  const parsed = yaml.load(fs.readFileSync(filePath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Values file must contain a YAML mapping: ${filePath}`)
  return parsed
}

function requireIrsaServiceAccount(values: any, label: string): void {
  if (values.serviceAccount?.create !== true) {
    throw new Error(`${label}: serviceAccount.create must be true when withdrawalProof.s3AuthMode is irsa`)
  }

  const roleArn = values.serviceAccount?.annotations?.['eks.amazonaws.com/role-arn']
  assertIdentifier(roleArn, `${label}: serviceAccount.annotations.eks.amazonaws.com/role-arn`)
  if (!/^arn:(?:aws|aws-cn|aws-us-gov):iam::\d{12}:role\/[\w+,./=@-]+$/.test(roleArn)) {
    throw new Error(`${label}: serviceAccount.annotations.eks.amazonaws.com/role-arn must be an IAM role ARN`)
  }
}

function validateProofS3AuthTopology(coordinatorValues: any, withdrawalValues: any): void {
  const authMode = withdrawalValues.withdrawalProof?.s3AuthMode
  if (authMode !== 'ambient' && authMode !== 'irsa') {
    throw new Error(
      'withdrawal-processor values: withdrawalProof.s3AuthMode must be explicitly set to ambient or irsa'
    )
  }

  if (authMode === 'irsa') {
    requireIrsaServiceAccount(coordinatorValues, 'proof-coordinator values')
    requireIrsaServiceAccount(withdrawalValues, 'withdrawal-processor values')
  }
}

function validateProofSecretTopology(coordinatorValues: any): void {
  const mappedKeys = new Set(
    Object.values(coordinatorValues.externalSecrets || {})
      .flatMap((secret: any) => Array.isArray(secret?.data) ? secret.data : [])
      .map((item: any) => item?.secretKey)
      .filter((key: unknown): key is string => typeof key === 'string')
  )
  if (mappedKeys.has('proof-work-token') && mappedKeys.has('prover-worker-token')) return

  const existingSecretName = coordinatorValues.persistence?.secrets?.name
  if (typeof existingSecretName === 'string' && existingSecretName.trim() !== '') return

  throw new Error(
    'proof-coordinator values must provide proof-work-token and prover-worker-token external-secret mappings, or an explicit persistence.secrets.name'
  )
}

function writeYamlAtomic(filePath: string, value: any): void {
  const temporaryPath = `${filePath}.tmp-${process.pid}`
  try {
    fs.writeFileSync(temporaryPath, yaml.dump(value, { lineWidth: -1, noRefs: true }), { mode: 0o600 })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
  }
}

function writeTextAtomic(filePath: string, value: string): void {
  const temporaryPath = `${filePath}.tmp-${process.pid}`
  try {
    // POSIX mode masks are intentionally expressed as bit flags.
    // eslint-disable-next-line no-bitwise
    const mode = fs.statSync(filePath).mode & 0o777
    fs.writeFileSync(temporaryPath, value, { mode })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
  }
}

function writeGeneratedTextAtomic(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp-${process.pid}`
  try {
    fs.writeFileSync(temporaryPath, value, { mode: 0o600 })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
  }
}

/**
 * Keep values responsible only for ConfigMap shape. JSON payloads arrive via
 * Helm --set-file; remove legacy inline JSON without disturbing unrelated
 * entries an operator may keep in the same ConfigMap.
 */
function ensureExternalJsonConfigMap(values: Record<string, any>, name: string, label: string): void {
  values.configMaps ||= {}
  values.configMaps[name] ||= {}
  const configMap = values.configMaps[name]
  if (!configMap || typeof configMap !== 'object' || Array.isArray(configMap)) {
    throw new TypeError(`${label}: configMaps.${name} must be a mapping`)
  }

  configMap.enabled = true
  if (configMap.data === undefined) return
  if (!configMap.data || typeof configMap.data !== 'object' || Array.isArray(configMap.data)) {
    throw new TypeError(`${label}: configMaps.${name}.data must be a mapping`)
  }

  for (const key of Object.keys(configMap.data)) {
    if (key.toLowerCase().endsWith('.json')) delete configMap.data[key]
  }

  if (Object.keys(configMap.data).length === 0) delete configMap.data
}

function buildStatementNamespaceConfig(
  manifests: Map<ProofFamily, { manifest: ProofProgramManifest; path: string }>,
  provingMode: ProvingMode
): string {
  const scrollChunkManifest = manifests.get('scroll_chunk')!.manifest
  const scrollBatchManifest = manifests.get('scroll_batch')!.manifest
  const proofMode = provingMode === 'mock' ? 'Mock' : 'Production'
  return `${JSON.stringify({
    batch: {
      circuit_id: scrollBatchManifest.circuit_id,
      proof_mode: proofMode,
      proof_system_id: scrollBatchManifest.proof_system_id,
      verification_key_hash: scrollBatchManifest.verification_key_hash,
    },
    chunk: {
      circuit_id: scrollChunkManifest.circuit_id,
      proof_mode: proofMode,
      proof_system_id: scrollChunkManifest.proof_system_id,
      verification_key_hash: scrollChunkManifest.verification_key_hash,
    },
  }, null, 2)}\n`
}

function escapeHelmKeySegment(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('.', '\\.')
    .replaceAll(',', '\\,')
    .replaceAll('=', '\\=')
}

function manifestSetFileBindings(
  configMapName: string,
  manifests: Map<ProofFamily, { manifest: ProofProgramManifest; path: string }>
): HelmSetFileBinding[] {
  return [...manifests.values()].map(({ path: manifestPath }) => ({
    filePath: manifestPath,
    key: `configMaps.${configMapName}.data.${escapeHelmKeySegment(path.basename(manifestPath))}`,
  }))
}

function migrateLegacyProofSecretPaths(config: string): string {
  return config
    .replaceAll('/run/secrets/proof-work-token', PROOF_WORK_TOKEN_PATH)
    .replaceAll('/run/secrets/prover-worker-token', PROVER_WORKER_TOKEN_PATH)
}

function replaceManagedVerifierBlock(filePath: string, verifier: Record<string, any>): string {
  if (!fs.existsSync(filePath)) throw new Error(`Proof coordinator TOML not found: ${filePath}`)
  const source = migrateLegacyProofSecretPaths(fs.readFileSync(filePath, 'utf8'))
  const begin = source.indexOf(MANAGED_VERIFIER_BEGIN)
  const end = source.indexOf(MANAGED_VERIFIER_END)
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error(`${filePath}: expected exactly one ${MANAGED_VERIFIER_BEGIN} / ${MANAGED_VERIFIER_END} block`)
  }

  if (source.split(MANAGED_VERIFIER_BEGIN).length !== 2 || source.split(MANAGED_VERIFIER_END).length !== 2) {
    throw new Error(`${filePath}: duplicate scrollsdk managed verifier markers`)
  }

  const afterEnd = end + MANAGED_VERIFIER_END.length
  const managed = `${MANAGED_VERIFIER_BEGIN}\n${toml.stringify({ verifier } as toml.JsonMap).trimEnd()}\n${MANAGED_VERIFIER_END}`
  const candidate = `${source.slice(0, begin)}${managed}${source.slice(afterEnd)}`
  try {
    toml.parse(candidate)
  } catch (error) {
    throw new Error(`${filePath}: generated TOML is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }

  return candidate
}

function parseEnvBoolean(value: string | undefined, fallback: boolean, label: string): boolean {
  if (value === undefined || value.trim() === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${label} must be true or false`)
}

interface CoordinatorRuntimeProjection {
  bucket: string
  coordinatorValues: any
  endpointUrl?: string
  forcePathStyle: boolean
  keyPrefix: string
  maxReadBodyBytes: number
  region: string
  signedUrlTtlMs: number
}

function readCoordinatorRuntimeProjection(
  coordinatorValuesPath: string,
  coordinatorConfigPath: string
): CoordinatorRuntimeProjection {
  const coordinatorValues = readYaml(coordinatorValuesPath)
  const coordinatorEnv = Object.fromEntries(
    (Array.isArray(coordinatorValues.env) ? coordinatorValues.env : [])
      .filter((item: any) => typeof item?.name === 'string' && item.value !== undefined)
      .map((item: any) => [item.name, String(item.value)])
  ) as Record<string, string>
  const coordinatorConfig = toml.parse(
    migrateLegacyProofSecretPaths(fs.readFileSync(coordinatorConfigPath, 'utf8'))
  ) as any
  const bucket = coordinatorEnv.DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__BUCKET
  const region = coordinatorEnv.DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__REGION
  const keyPrefix = coordinatorEnv.DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__KEY_PREFIX || 'proof-topology'
  const endpointUrl = coordinatorEnv.DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__ENDPOINT_URL
  if (!bucket || !region) {
    throw new Error('proof-coordinator artifact-store bucket and region are required for withdrawal proof topology')
  }

  assertIdentifier(bucket, 'proof-coordinator artifact-store bucket')
  assertIdentifier(region, 'proof-coordinator artifact-store region')
  assertIdentifier(keyPrefix, 'proof-coordinator artifact-store key prefix')

  return {
    bucket,
    coordinatorValues,
    endpointUrl,
    forcePathStyle: parseEnvBoolean(
      coordinatorEnv.DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__FORCE_PATH_STYLE,
      Boolean(endpointUrl),
      'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__FORCE_PATH_STYLE'
    ),
    keyPrefix,
    maxReadBodyBytes: parsePositiveInteger(
      coordinatorEnv.DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__MAX_READ_BODY_BYTES
        ?? coordinatorConfig.artifact_store?.max_read_body_bytes,
      DEFAULT_MAX_READ_BODY_BYTES,
      'proof_artifact_transport.max_read_body_bytes'
    ),
    region,
    signedUrlTtlMs: parsePositiveInteger(
      coordinatorConfig.artifact_write?.signed_put_expiry_ms,
      DEFAULT_SIGNED_URL_TTL_MS,
      'proof_artifact_transport.signed_url_ttl_ms',
      MAX_TRANSPORT_HORIZON_MS
    ),
  }
}

function validateCoordinatorMaterializerTopology(
  coordinatorConfigPath: string,
  provingMode: ProvingMode = 'production'
): void {
  const config = toml.parse(
    migrateLegacyProofSecretPaths(fs.readFileSync(coordinatorConfigPath, 'utf8'))
  ) as any
  const { materializer } = config
  const requireString = (value: any, label: string): void => {
    assertIdentifier(value, `${coordinatorConfigPath}: ${label}`)
  }

  const requireEnabled = (table: any, label: string): void => {
    if (!table || table.enabled !== true) {
      throw new Error(`${coordinatorConfigPath}: [${label}].enabled = true is required by the generated withdrawal proof topology`)
    }
  }

  if (config.auth?.bearer_token_file !== PROOF_WORK_TOKEN_PATH) {
    throw new Error(`${coordinatorConfigPath}: [auth].bearer_token_file must be ${PROOF_WORK_TOKEN_PATH}`)
  }

  if (config.artifact_store?.kind !== 's3') {
    throw new Error(`${coordinatorConfigPath}: [artifact_store].kind = "s3" is required`)
  }

  if (!config.prover_api || config.prover_api.enabled !== true) {
    throw new Error(`${coordinatorConfigPath}: [prover_api].enabled = true is required for external workers`)
  }

  if (config.prover_api.bind_addr !== '0.0.0.0:9400') {
    throw new Error(`${coordinatorConfigPath}: [prover_api].bind_addr must be 0.0.0.0:9400`)
  }

  if (config.prover_api.worker_auth_token_file !== PROVER_WORKER_TOKEN_PATH) {
    throw new Error(
      `${coordinatorConfigPath}: [prover_api].worker_auth_token_file must be ${PROVER_WORKER_TOKEN_PATH}`
    )
  }

  if (config.prover_api.transport !== 's3') {
    throw new Error(`${coordinatorConfigPath}: [prover_api].transport = "s3" is required`)
  }

  if (!materializer || typeof materializer !== 'object') {
    throw new Error(
      `${coordinatorConfigPath}: [materializer] is required; verifier-only proof-coordinator config cannot consume WP materialize claims`
    )
  }

  requireString(materializer.artifact_store_root, '[materializer].artifact_store_root')

  requireEnabled(materializer.scroll_batch, 'materializer.scroll_batch')
  requireString(
    materializer.scroll_batch.materializer_output_root,
    '[materializer.scroll_batch].materializer_output_root'
  )

  if (provingMode === 'mock') {
    // Mock proving runs the dev-sentinel scroll materializers (the dogeos-core
    // e2e strict-withdrawal shape). The production subprocess topology must
    // not coexist, or the deployment would silently mix real and mock scroll
    // materialize lanes.
    requireEnabled(materializer.dev_sentinel_scroll_chunk, 'materializer.dev_sentinel_scroll_chunk')
    if (materializer.scroll_batch.dev_sentinel !== true) {
      throw new Error(`${coordinatorConfigPath}: mock proving requires [materializer.scroll_batch].dev_sentinel = true`)
    }

    if (materializer.scroll_batch.proof_mode !== 'Mock') {
      throw new Error(`${coordinatorConfigPath}: mock proving requires [materializer.scroll_batch].proof_mode = "Mock"`)
    }

    if (materializer.scroll_batch.subprocess !== undefined) {
      throw new Error(
        `${coordinatorConfigPath}: mock proving must not configure [materializer.scroll_batch.subprocess]; regenerate the coordinator TOML with --scaffold-coordinator-config under mock proving`
      )
    }
  } else {
    requireEnabled(materializer.scroll_chunk_segmentation, 'materializer.scroll_chunk_segmentation')
    if (materializer.scroll_batch.dev_sentinel === true) {
      throw new Error(`${coordinatorConfigPath}: production proof config cannot use materializer.scroll_batch.dev_sentinel`)
    }

    validateScrollBatchSubprocess(coordinatorConfigPath, materializer.scroll_batch.subprocess)
  }

  requireEnabled(materializer.bridge, 'materializer.bridge')
  if (materializer.bridge.advance_l1 !== true || materializer.bridge.advance_l2 !== true) {
    throw new Error(
      `${coordinatorConfigPath}: [materializer.bridge] must set advance_l1 = true and advance_l2 = true to match WP`
    )
  }

  if (!materializer.bridge.dogecoin_rpc || typeof materializer.bridge.dogecoin_rpc !== 'object') {
    throw new Error(`${coordinatorConfigPath}: [materializer.bridge.dogecoin_rpc] is required for AdvanceL1`)
  }

  requireString(materializer.bridge.dogecoin_rpc.url, '[materializer.bridge.dogecoin_rpc].url')
  requireString(materializer.bridge.dogecoin_rpc.network, '[materializer.bridge.dogecoin_rpc].network')

  validateEthereumDaSection(coordinatorConfigPath, materializer.bridge.ethereum_da, 'materializer.bridge.ethereum_da')
}

function validateScrollBatchSubprocess(coordinatorConfigPath: string, scrollBatchSubprocess: any): void {
  const requireString = (value: any, label: string): void => {
    assertIdentifier(value, `${coordinatorConfigPath}: ${label}`)
  }

  if (!scrollBatchSubprocess || typeof scrollBatchSubprocess !== 'object') {
    throw new Error(
      `${coordinatorConfigPath}: [materializer.scroll_batch.subprocess] is required; production cannot rely on an external summary.json producer`
    )
  }

  requireString(
    scrollBatchSubprocess.binary_path,
    '[materializer.scroll_batch.subprocess].binary_path'
  )
  if (scrollBatchSubprocess.binary_path !== SCROLL_MATERIALIZER_BINARY_PATH) {
    throw new Error(
      `${coordinatorConfigPath}: [materializer.scroll_batch.subprocess].binary_path must be ${SCROLL_MATERIALIZER_BINARY_PATH}`
    )
  }

  requireString(
    scrollBatchSubprocess.statement_namespace_config_path,
    '[materializer.scroll_batch.subprocess].statement_namespace_config_path'
  )
  if (scrollBatchSubprocess.statement_namespace_config_path !== STATEMENT_NAMESPACE_CONFIG_PATH) {
    throw new Error(
      `${coordinatorConfigPath}: [materializer.scroll_batch.subprocess].statement_namespace_config_path must be ${STATEMENT_NAMESPACE_CONFIG_PATH}`
    )
  }

  requireString(scrollBatchSubprocess.scratch_root, '[materializer.scroll_batch.subprocess].scratch_root')
  if (
    scrollBatchSubprocess.subprocess_timeout_ms === undefined ||
    scrollBatchSubprocess.subprocess_timeout_ms === null ||
    scrollBatchSubprocess.subprocess_timeout_ms === ''
  ) {
    throw new Error(`${coordinatorConfigPath}: [materializer.scroll_batch.subprocess].subprocess_timeout_ms is required`)
  }

  parsePositiveInteger(
    scrollBatchSubprocess.subprocess_timeout_ms,
    1,
    `${coordinatorConfigPath}: [materializer.scroll_batch.subprocess].subprocess_timeout_ms`
  )
  const hasL2Rpc = scrollBatchSubprocess.l2_rpc_url !== undefined
  const hasBlockWitnessDir = scrollBatchSubprocess.block_witness_dir !== undefined
  if (hasL2Rpc === hasBlockWitnessDir) {
    throw new Error(
      `${coordinatorConfigPath}: [materializer.scroll_batch.subprocess] must set exactly one of l2_rpc_url or block_witness_dir`
    )
  }

  if (hasL2Rpc) requireString(scrollBatchSubprocess.l2_rpc_url, '[materializer.scroll_batch.subprocess].l2_rpc_url')
  if (hasBlockWitnessDir) {
    requireString(scrollBatchSubprocess.block_witness_dir, '[materializer.scroll_batch.subprocess].block_witness_dir')
  }

  validateEthereumDaSection(
    coordinatorConfigPath,
    scrollBatchSubprocess.ethereum_da,
    'materializer.scroll_batch.subprocess.ethereum_da'
  )
}

function validateEthereumDaSection(coordinatorConfigPath: string, ethereumDa: any, label: string): void {
  const requireString = (value: any, itemLabel: string): void => {
    assertIdentifier(value, `${coordinatorConfigPath}: ${itemLabel}`)
  }

  const requirePositiveInteger = (value: any, itemLabel: string, maximum = Number.MAX_SAFE_INTEGER): void => {
    if (value === undefined || value === null || value === '') {
      throw new Error(`${coordinatorConfigPath}: ${itemLabel} is required`)
    }

    parsePositiveInteger(value, 1, `${coordinatorConfigPath}: ${itemLabel}`, maximum)
  }

  if (!ethereumDa || typeof ethereumDa !== 'object') {
    throw new Error(`${coordinatorConfigPath}: [${label}] is required`)
  }

  requireString(ethereumDa.l1_rpc_url, `[${label}].l1_rpc_url`)
  requireString(ethereumDa.artifact_store_root, `[${label}].artifact_store_root`)
  requireString(ethereumDa.artifact_metadata_sqlite_path, `[${label}].artifact_metadata_sqlite_path`)
  requirePositiveInteger(ethereumDa.eth_chain_id, `[${label}].eth_chain_id`)
  requirePositiveInteger(ethereumDa.l2_chain_id, `[${label}].l2_chain_id`, 0xFF_FF_FF_FF)
  const blobSource = ethereumDa.blob_source
  if (!blobSource || typeof blobSource !== 'object') {
    throw new Error(`${coordinatorConfigPath}: [${label}.blob_source] is required for cache misses`)
  }

  requirePositiveInteger(blobSource.timeout_ms, `[${label}.blob_source].timeout_ms`)
  const providerNames = ['anvil', 'aws_s3', 'beacon_node', 'blob_scan', 'block_native']
    .filter(name => blobSource[name] && typeof blobSource[name] === 'object')
  if (providerNames.length === 0) {
    throw new Error(`${coordinatorConfigPath}: [${label}.blob_source] must configure at least one provider`)
  }

  for (const providerName of providerNames) {
    if (providerName === 'anvil' && blobSource[providerName].url === undefined) continue
    requireString(blobSource[providerName].url, `[${label}.blob_source.${providerName}].url`)
  }
}

function requireProofDataPath(value: unknown, label: string): string {
  assertIdentifier(value, label)
  if (!path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path under ${PROOF_DATA_MOUNT_PATH}`)
  }

  const normalized = path.posix.normalize(value)
  if (normalized !== value || (normalized !== PROOF_DATA_MOUNT_PATH && !normalized.startsWith(`${PROOF_DATA_MOUNT_PATH}/`))) {
    throw new Error(`${label} must be a normalized path under ${PROOF_DATA_MOUNT_PATH}`)
  }

  return normalized
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/**
 * Project coordinator-owned writable paths onto the chart's data PVC. The
 * coordinator deliberately requires the shared materializer staging root to
 * exist, and other materializers create children below their configured roots.
 * Creating every configured output/cache parent here makes the filesystem
 * contract explicit and catches paths outside the mounted PVC before Helm is
 * run.
 */
function configureProofDataDirectories(
  values: Record<string, any>,
  coordinatorConfig: string,
  coordinatorConfigPath: string
): void {
  const config = toml.parse(coordinatorConfig) as any
  const directories = new Set<string>()

  const visit = (value: unknown, labels: string[]): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const itemLabels = [...labels, key]
      const label = `${coordinatorConfigPath}: [${itemLabels.slice(0, -1).join('.')}].${key}`
      if (key === 'artifact_store_root' || key === 'materializer_output_root' || key === 'scratch_root') {
        directories.add(requireProofDataPath(item, label))
      } else if (key === 'artifact_metadata_sqlite_path') {
        const filePath = requireProofDataPath(item, label)
        if (filePath === PROOF_DATA_MOUNT_PATH) {
          throw new Error(`${label} must name a file below ${PROOF_DATA_MOUNT_PATH}`)
        }

        directories.add(path.posix.dirname(filePath))
      }

      visit(item, itemLabels)
    }
  }

  visit(config.materializer, ['materializer'])
  if (directories.size === 0) {
    throw new Error(`${coordinatorConfigPath}: [materializer] does not configure any writable data directories`)
  }

  values.initContainers ||= {}
  values.initContainers['prepare-proof-data-directories'] = {
    args: [`mkdir -p ${[...directories].sort().map(directory => shellQuote(directory)).join(' ')}`],
    command: ['/bin/sh', '-ec'],
    image: 'busybox:1.36.1',
    volumeMounts: [{ mountPath: PROOF_DATA_MOUNT_PATH, name: 'data' }],
  }
}

function configureAggVerifierArtifact(
  values: Record<string, any>,
  configMapName: string,
  verifierArtifact: VerifierArtifact
): void {
  values.configMaps ||= {}
  values.configMaps['agg-verifying-key'] = {
    data: {
      'agg-vk.bin.b64': verifierArtifact.base64,
      'agg-vk.bin.sha256': verifierArtifact.sha256,
    },
    enabled: true,
  }
  values.persistence ||= {}
  values.persistence['agg-verifying-key-source'] = {
    enabled: true,
    mountPath: '-',
    name: configMapName,
    readOnly: true,
    type: 'configMap',
  }
  values.initContainers ||= {}
  values.initContainers['install-agg-verifying-key'] = {
    args: [
      `mkdir -p /app/data/verifier
expected="$(tr -d '[:space:]' < /app/verifier-source/agg-vk.bin.sha256)"
base64 -d /app/verifier-source/agg-vk.bin.b64 > ${AGG_VK_PATH}.tmp
echo "$expected  ${AGG_VK_PATH}.tmp" | sha256sum -c -
mv ${AGG_VK_PATH}.tmp ${AGG_VK_PATH}
chmod 0444 ${AGG_VK_PATH}`,
    ],
    command: ['/bin/sh', '-ec'],
    image: 'busybox:1.36.1',
    volumeMounts: [
      { mountPath: '/app/data', name: 'data' },
      { mountPath: '/app/verifier-source', name: 'agg-verifying-key-source', readOnly: true },
    ],
  }
}

function prepareProofCoordinator(
  filePath: string,
  configPath: string,
  manifests: Map<ProofFamily, { manifest: ProofProgramManifest; path: string }>,
  commitments: Map<ProofFamily, string> | undefined,
  verifierIds: Partial<Record<ProofFamily, string>>,
  verifierArtifact: VerifierArtifact | undefined,
  provingMode: ProvingMode
): { updatedConfig: string; values: any } {
  const mock = provingMode === 'mock'
  const values = readYaml(filePath)
  values.persistence ||= {}
  values.persistence.secrets ||= {}
  values.persistence.secrets.mountPath = PROOF_SECRET_MOUNT_PATH
  const verifier: Record<string, any> = { verifier_import_mode: mock ? 'dev_dummy' : 'production' }
  for (const [family, { manifest, path: manifestPath }] of manifests) {
    const verifierId = verifierIds[family] || defaultVerifierId(manifest)
    assertIdentifier(verifierId, `${family} verifier ID`)
    verifier[FAMILY_CONFIG_KEYS[family]] = verifierPolicy(manifest, manifestPath, verifierId)
  }

  // The real Scroll verifier attachment (aggregate VK + raw commitments) only
  // exists for release artifacts; the dev_dummy verifier is structural.
  if (!mock) {
    verifier.scroll_real_verifier = {
      advance_l2_aggregation_program_commitment_hex: commitments!.get('advance_l2_aggregation'),
      agg_verifying_key_path: AGG_VK_PATH,
      batch_program_commitment_hex: commitments!.get('scroll_batch'),
      bridge_program_commitment_hex: commitments!.get('bridge_transition'),
      chunk_program_commitment_hex: commitments!.get('scroll_chunk'),
    }
  }

  const updatedConfig = replaceManagedVerifierBlock(configPath, verifier)
  configureProofDataDirectories(values, updatedConfig, configPath)
  values.env ||= []
  if (!Array.isArray(values.env)) throw new Error(`${filePath}: env must be an array`)
  const commitmentIndex = values.env.findIndex((item: any) => item?.name === SCROLL_BATCH_COMMITMENT_ENV)
  if (mock) {
    if (commitmentIndex !== -1) values.env.splice(commitmentIndex, 1)
  } else if (commitmentIndex === -1) {
    values.env.push({
      name: SCROLL_BATCH_COMMITMENT_ENV,
      value: commitments!.get('scroll_chunk'),
    })
  } else {
    values.env[commitmentIndex].value = commitments!.get('scroll_chunk')
    delete values.env[commitmentIndex].valueFrom
  }

  ensureExternalJsonConfigMap(values, 'manifests', filePath)
  values.persistence ||= {}
  values.persistence.manifests = {
    enabled: true,
    mountPath: '/app/data/manifests',
    name: '{{ include "scroll.common.lib.chart.names.fullname" . }}-manifests',
    readOnly: true,
    type: 'configMap',
  }
  if (mock) {
    removeAggVerifierArtifact(values)
  } else {
    configureAggVerifierArtifact(
      values,
      '{{ include "scroll.common.lib.chart.names.fullname" . }}-agg-verifying-key',
      verifierArtifact!
    )
  }

  values.service ||= {}
  values.service.main ||= {}
  values.service.main.enabled = true
  values.service.main.ports ||= {}
  values.service.main.ports.http = {
    enabled: true,
    port: 9400,
    protocol: 'TCP',
  }
  return { updatedConfig, values }
}

/**
 * Render the public HTTPS entrypoint external prover workers use to reach the
 * coordinator's `/v1/prover` gateway. Mirrors the tso-service ingress shape
 * (nginx class + cert-manager cluster issuer).
 */
function ensureCoordinatorIngress(values: Record<string, any>, host: string): void {
  assertIdentifier(host, 'proof-coordinator ingress host')
  values.ingress ||= {}
  const existingAnnotations = values.ingress.main?.annotations || {}
  values.ingress.main = {
    annotations: {
      ...existingAnnotations,
      'cert-manager.io/cluster-issuer': existingAnnotations['cert-manager.io/cluster-issuer'] || 'letsencrypt-prod',
    },
    enabled: true,
    hosts: [{ host, paths: [{ path: '/', pathType: 'Prefix' }] }],
    ingressClassName: values.ingress.main?.ingressClassName || 'nginx',
    tls: [{ hosts: [host], secretName: 'proof-coordinator-tls' }],
  }
}

/** Drop the release-artifact aggregate-VK plumbing when staging mock proving. */
function removeAggVerifierArtifact(values: Record<string, any>): void {
  if (values.configMaps) delete values.configMaps['agg-verifying-key']
  if (values.persistence) delete values.persistence['agg-verifying-key-source']
  if (values.initContainers) {
    delete values.initContainers['install-agg-verifying-key']
    if (Object.keys(values.initContainers).length === 0) delete values.initContainers
  }
}

function prepareWithdrawalProcessor(
  filePath: string,
  coordinatorValuesPath: string,
  coordinatorConfigPath: string,
  manifests: Map<ProofFamily, { manifest: ProofProgramManifest; path: string }>,
  commitments: Map<ProofFamily, string> | undefined,
  verifierIds: Partial<Record<ProofFamily, string>>,
  scrollBatchBackendProfile: string,
  bridgeBackendProfile: string,
  signerProofArtifactBaseUrl: string,
  verifierArtifact: VerifierArtifact | undefined,
  provingMode: ProvingMode,
  nativeWithdrawalConfig: string
): { updatedWithdrawalConfig?: string; values: any } {
  const mock = provingMode === 'mock'
  const values = readYaml(filePath)
  const projection = readCoordinatorRuntimeProjection(
    coordinatorValuesPath,
    coordinatorConfigPath
  )
  const { coordinatorValues } = projection
  assertIdentifier(scrollBatchBackendProfile, 'Scroll batch backend profile')
  assertIdentifier(bridgeBackendProfile, 'Bridge backend profile')
  values.env ||= []
  if (!Array.isArray(values.env)) throw new Error(`${filePath}: env must be an array`)
  const env = values.env as Array<Record<string, any>>

  for (let index = env.length - 1; index >= 0; index--) {
    const name = String(env[index]?.name || '')
    if (
      name === 'DOGEOS_WITHDRAWAL_COORDINATOR_POLL_INTERVAL_SECS' ||
      name === 'DOGEOS_WITHDRAWAL_PROVING_MODE' ||
      name === 'DOGEOS_WITHDRAWAL_SCROLL_PROOF_INPUT_POLICY' ||
      name.startsWith('DOGEOS_WITHDRAWAL_PROOF_ARTIFACT_TRANSPORT__') ||
      name.startsWith('DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__') ||
      name.startsWith('DOGEOS_WITHDRAWAL_PROOF_TASK_POLICY__') ||
      name.startsWith('DOGEOS_WITHDRAWAL_PROOF_EXECUTION_WORKER__') ||
      name.startsWith('DOGEOS_WITHDRAWAL_PROOF_SYSTEM__') ||
      name.startsWith('DOGEOS_WITHDRAWAL_PROOF_WORK_API__') ||
      name.startsWith('DOGEOS_WITHDRAWAL_LOCAL_BRIDGE_PROOF_RUNTIME__') ||
      name.startsWith('DOGEOS_WITHDRAWAL_SCROLL_WORKER_API__')
    ) env.splice(index, 1)
  }

  const proofSystem: Record<string, any> = {
    mode: mock ? 'dev_dummy' : 'production',
    require_bridge_state: manifests.has('bridge_transition'),
    require_scroll_execution: manifests.has('scroll_chunk') || manifests.has('scroll_batch'),
  }
  const proofControlPlaneGate: Record<string, any> = {
    store_path: '/app/data/control-plane.sqlite',
  }

  for (const [family, { manifest, path: manifestPath }] of manifests) {
    const verifierId = verifierIds[family] || defaultVerifierId(manifest)
    if (family === 'scroll_batch' || family === 'scroll_chunk') {
      proofControlPlaneGate[`${FAMILY_PREFIXES[family].toLowerCase()}_circuit_id`] = manifest.circuit_id
      proofControlPlaneGate[`${FAMILY_PREFIXES[family].toLowerCase()}_verification_key_hash_hex`] = bareHex(
        manifest.verification_key_hash,
        32,
        `${family} verification key hash`
      )
      proofControlPlaneGate[`${FAMILY_PREFIXES[family].toLowerCase()}_program_commitment_hash_hex`] = manifest.program_commitment_hash
    }

    proofControlPlaneGate[FAMILY_CONFIG_KEYS[family]] = verifierPolicy(manifest, manifestPath, verifierId)
  }

  const bridge = manifests.get('bridge_transition')?.manifest
  if (bridge) {
    proofControlPlaneGate.proof_system_id = bridge.proof_system_id
    proofControlPlaneGate.circuit_id = bridge.circuit_id
    proofControlPlaneGate.verification_key_hash_hex = bareHex(
      bridge.verification_key_hash,
      32,
      'bridge verification key hash'
    )
  }

  if (!mock) {
    proofControlPlaneGate.scroll_real_verifier = {
      advance_l2_aggregation_program_commitment_hex: bareHex(
        commitments!.get('advance_l2_aggregation')!,
        64,
        'AdvanceL2 aggregation raw program commitment'
      ),
      agg_verifying_key_path: AGG_VK_PATH,
      batch_program_commitment_hex: bareHex(
        commitments!.get('scroll_batch')!,
        64,
        'scroll batch raw program commitment'
      ),
      bridge_program_commitment_hex: bareHex(
        commitments!.get('bridge_transition')!,
        64,
        'bridge raw program commitment'
      ),
      chunk_program_commitment_hex: bareHex(
        commitments!.get('scroll_chunk')!,
        64,
        'scroll chunk raw program commitment'
      ),
    }
  }

  const proofConfig: Record<string, any> = {
    proof_control_plane_gate: proofControlPlaneGate,
    proof_system: proofSystem,
    proof_work_api: {
      allow_insecure_http: true,
      auth: {
        bearer_token_file: PROOF_WORK_TOKEN_PATH,
      },
      bind_addr: '0.0.0.0:9300',
      enabled: true,
      materialize: {
        bridge: {
          advance_l1_enabled: true,
          advance_l2_enabled: true,
          enabled: true,
          prepared_bundle_source_root: '/app/data/bridge-prepared-bundles',
          remote_prove_options: {
            backend_profile: bridgeBackendProfile,
          },
        },
        scroll_batch: {
          enabled: true,
          remote_prove_options: {
            backend_profile: scrollBatchBackendProfile,
          },
        },
        // This is the explicit production Scroll proof-input source. The
        // e2e_harness exact-mock topology must leave it absent so dogeos-core
        // wires DevExactMockFactSource instead.
        ...(mock ? {} : { scroll_chunk_segmentation: { enabled: true } }),
      },
    },
  }

  proofConfig.proof_artifact_transport = {
    bucket: projection.bucket,
    force_path_style: projection.forcePathStyle,
    key_prefix: projection.keyPrefix,
    kind: 's3_compatible',
    local_store_root: '/app/data/proof-artifacts',
    max_read_body_bytes: projection.maxReadBodyBytes,
    region: projection.region,
    signed_url_ttl_ms: projection.signedUrlTtlMs,
    ...(projection.endpointUrl ? { endpoint_url: projection.endpointUrl } : {}),
  }
  proofSystem.signer_proof_artifact_base_url = signerProofArtifactBaseUrl

  const updatedWithdrawalConfig = replaceWithdrawalManagedProofBlock(nativeWithdrawalConfig, proofConfig as toml.JsonMap)
  ensureWithdrawalChartWiring(values)
  // helm --set-file supplies the ConfigMap key; a stale inline copy would
  // shadow-confuse operators reading the values file.
  removeInlineWithdrawalConfig(values)

  ensureExternalJsonConfigMap(values, 'proof-manifests', filePath)
  values.persistence ||= {}
  values.persistence['proof-manifests'] = {
    enabled: true,
    mountPath: '/app/data/manifests',
    name: '{{ include "withdrawal-processor.fullname" . }}-proof-manifests',
    readOnly: true,
    type: 'configMap',
  }
  values.persistence['proof-secrets'] = {
    enabled: true,
    mountPath: PROOF_SECRET_MOUNT_PATH,
    name: 'proof-secrets',
    readOnly: true,
    type: 'secret',
  }
  if (mock) {
    removeAggVerifierArtifact(values)
  } else {
    configureAggVerifierArtifact(
      values,
      '{{ include "withdrawal-processor.fullname" . }}-agg-verifying-key',
      verifierArtifact!
    )
  }

  values.service ||= {}
  values.service.main ||= {}
  values.service.main.ports ||= {}
  values.service.main.ports['proof-work'] = {
    enabled: true,
    port: 9300,
    protocol: 'TCP',
  }

  const coordinatorProofSecret = Object.values(coordinatorValues.externalSecrets || {})
    .find((secret: any) => Array.isArray(secret?.data) && secret.data.some((item: any) => item?.secretKey === 'proof-work-token')) as any
  if (coordinatorProofSecret) {
    values.externalSecrets ||= {}
    values.externalSecrets['proof-secrets'] = {
      ...coordinatorProofSecret,
      data: coordinatorProofSecret.data.filter((item: any) => item?.secretKey === 'proof-work-token'),
    }
  } else {
    const existingSecretName = coordinatorValues.persistence?.secrets?.name
    if (typeof existingSecretName !== 'string' || existingSecretName.trim() === '') {
      throw new Error(
        'proof-coordinator must provide either an externalSecrets proof-work-token mapping or persistence.secrets.name for WP auth'
      )
    }

    values.persistence['proof-secrets'].name = existingSecretName
  }

  ensureWithdrawalProofActivationSwitch(values, provingMode)

  return { updatedWithdrawalConfig, values }
}

export function configureProofValues(options: ConfigureProofValuesOptions): ConfigureProofValuesResult {
  const provingMode: ProvingMode = options.provingMode || 'production'
  const mock = provingMode === 'mock'
  const valuesDir = path.resolve(options.valuesDir)
  // Mock proving has no release artifacts: the program manifests are
  // synthesized from the canonical mock topology identities (anchored to the
  // deployment working directory next to values/), and there is no
  // raw-commitment / aggregate-verifying-key material to stage.
  const manifestPaths = mock
    ? ensureMockProgramManifests(path.join(path.dirname(valuesDir), MOCK_PROGRAM_MANIFESTS_DIR))
    : options.manifestPaths
  if (!manifestPaths || manifestPaths.length === 0) {
    throw new Error('At least one program manifest is required')
  }

  const manifests = loadProgramManifests(manifestPaths)
  const statementNamespaceFile = path.resolve(
    options.statementNamespacePath
    || path.join(path.dirname(valuesDir), DEFAULT_STATEMENT_NAMESPACE_CONFIG)
  )
  if ([...manifests.values()].some(item => item.path === statementNamespaceFile)) {
    throw new Error(`statement namespace output must not overwrite a program manifest: ${statementNamespaceFile}`)
  }

  const statementNamespaceConfig = buildStatementNamespaceConfig(manifests, provingMode)
  // Keep the generated file subject to the same parse-before-write rule as
  // every other prep-charts proof output.
  JSON.parse(statementNamespaceConfig)
  let commitments: Map<ProofFamily, string> | undefined
  let verifierArtifact: VerifierArtifact | undefined
  if (!mock) {
    if (!options.artifactManifestPath) {
      throw new Error('The release artifact manifest is required for production proving')
    }

    commitments = loadRawCommitments(options.artifactManifestPath, manifests)
    verifierArtifact = loadVerifierArtifact(options.artifactManifestPath)
  }

  const verifierIds = { ...(mock ? mockVerifierIds() : {}), ...options.verifierIds }
  const configFile = path.resolve(options.coordinatorConfigPath)
  const files = [
    path.join(valuesDir, 'proof-coordinator-production.yaml'),
    path.join(valuesDir, 'withdrawal-processor-production.yaml'),
  ]

  // Complete validation happens before either target is written.
  const coordinatorValuesInput = readYaml(files[0])
  const withdrawalValuesInput = readYaml(files[1])
  validateProofS3AuthTopology(coordinatorValuesInput, withdrawalValuesInput)
  validateProofSecretTopology(coordinatorValuesInput)
  if (!fs.existsSync(configFile)) throw new Error(`Proof coordinator TOML not found: ${configFile}`)
  const scrollBatchBackendProfile = options.scrollBatchBackendProfile
    || (mock ? MOCK_SCROLL_BATCH_BACKEND_PROFILE : DEFAULT_SCROLL_BATCH_BACKEND_PROFILE)
  const bridgeBackendProfile = options.bridgeBackendProfile
    || (mock ? MOCK_BRIDGE_BACKEND_PROFILE : DEFAULT_BRIDGE_BACKEND_PROFILE)
  const withdrawalConfigFile = path.resolve(
    options.withdrawalConfigPath
    || path.join(path.dirname(valuesDir), WITHDRAWAL_NATIVE_CONFIG_RELPATH)
  )
  if (!fs.existsSync(withdrawalConfigFile)) {
    throw new Error(
      `WithdrawalProcessor TOML template not found: ${withdrawalConfigFile}. `
      + 'Copy withdrawal-processor/WithdrawalProcessor.toml from the scroll-sdk examples layout; '
      + 'prep-charts updates the native file and never embeds application TOML in values YAML.'
    )
  }

  const nativeWithdrawalConfig = fs.readFileSync(withdrawalConfigFile, 'utf8')

  // The base URL is an external deployment decision, so the first run must
  // receive it explicitly; re-runs default to what that run staged into the
  // native WithdrawalProcessor.toml proof block.
  let signerProofArtifactBaseUrlSource: 'flag' | 'staged' = 'flag'
  let signerProofArtifactBaseUrlInput = options.signerProofArtifactBaseUrl
  if (!signerProofArtifactBaseUrlInput) {
    const staged = readStagedSignerProofArtifactBaseUrl(nativeWithdrawalConfig)
    if (staged === undefined) {
      throw new Error(
        'proofSystem.artifactReadBaseUrl is required: no previously staged value found in WithdrawalProcessor.toml (configure proofSystem before the first prep-charts run)'
      )
    }

    signerProofArtifactBaseUrlSource = 'staged'
    signerProofArtifactBaseUrlInput = staged
  }

  const signerProofArtifactBaseUrl = normalizeSignerProofArtifactBaseUrl(signerProofArtifactBaseUrlInput)
  assertIdentifier(scrollBatchBackendProfile, 'Scroll batch backend profile')
  assertIdentifier(bridgeBackendProfile, 'Bridge backend profile')
  const runtimeProjection = readCoordinatorRuntimeProjection(files[0], configFile)
  const artifactReadBaseUrlMapping = classifyProofArtifactBaseUrlMapping(
    signerProofArtifactBaseUrl,
    runtimeProjection
  )
  validateCoordinatorMaterializerTopology(configFile, provingMode)
  // Validate the partner signer policy projection now, even though the actual
  // docker-compose policy bundle is exported after bridge genesis. This keeps
  // an invalid verifier ID from being staged into coordinator/WP and failing
  // only much later at `setup export-signer-policy`.
  buildAllowedProofTriples(manifests, verifierIds)
  // Build and validate every target before writing any of them.
  const coordinatorUpdate = prepareProofCoordinator(
    files[0],
    configFile,
    manifests,
    commitments,
    verifierIds,
    verifierArtifact,
    provingMode
  )
  if (options.coordinatorIngressHost) {
    ensureCoordinatorIngress(coordinatorUpdate.values, options.coordinatorIngressHost)
  }

  const withdrawalUpdate = prepareWithdrawalProcessor(
    files[1],
    files[0],
    configFile,
    manifests,
    commitments,
    verifierIds,
    scrollBatchBackendProfile,
    bridgeBackendProfile,
    signerProofArtifactBaseUrl,
    verifierArtifact,
    provingMode,
    nativeWithdrawalConfig
  )
  ensureWithdrawalProofActivationSwitch(withdrawalUpdate.values, provingMode)

  const coordinatorManifestSetFiles = manifestSetFileBindings('manifests', manifests)
  const withdrawalManifestSetFiles = manifestSetFileBindings('proof-manifests', manifests)
  const helmSetFiles = {
    proofCoordinator: [
      { filePath: configFile, key: 'proofCoordinator.config.content' },
      ...coordinatorManifestSetFiles,
      {
        filePath: statementNamespaceFile,
        key: 'configMaps.manifests.data.statement-namespace\\.json',
      },
    ],
    withdrawalProcessor: [
      {
        filePath: withdrawalConfigFile,
        key: 'configMaps.config.data.WithdrawalProcessor\\.toml',
      },
      ...withdrawalManifestSetFiles,
    ],
  }

  writeTextAtomic(configFile, coordinatorUpdate.updatedConfig)
  writeYamlAtomic(files[0], coordinatorUpdate.values)
  writeYamlAtomic(files[1], withdrawalUpdate.values)
  if (withdrawalUpdate.updatedWithdrawalConfig !== undefined) {
    writeTextAtomic(withdrawalConfigFile, withdrawalUpdate.updatedWithdrawalConfig)
  }

  writeGeneratedTextAtomic(statementNamespaceFile, statementNamespaceConfig)

  return {
    artifactReadBaseUrlMapping,
    configFile,
    families: [...manifests.keys()].sort(),
    files: [
      ...files,
      ...(withdrawalUpdate.updatedWithdrawalConfig === undefined ? [] : [withdrawalConfigFile]),
      statementNamespaceFile,
    ],
    helmSetFiles,
    provingMode,
    signerProofArtifactBaseUrl,
    signerProofArtifactBaseUrlSource,
    statementNamespaceFile,
  }
}

/**
 * Project the proof-disabled/direct-sign posture without requiring release
 * artifacts, proof storage, a coordinator, or a prover worker.
 */
export function configureDisabledProofValues(options: {
  valuesDir: string
  withdrawalConfigPath?: string
}): ConfigureDisabledProofResult {
  const valuesDir = path.resolve(options.valuesDir)
  const valuesFile = path.join(valuesDir, 'withdrawal-processor-production.yaml')
  const withdrawalConfigFile = path.resolve(
    options.withdrawalConfigPath
    || path.join(path.dirname(valuesDir), WITHDRAWAL_NATIVE_CONFIG_RELPATH)
  )
  if (!fs.existsSync(withdrawalConfigFile)) {
    throw new Error(`WithdrawalProcessor TOML template not found: ${withdrawalConfigFile}`)
  }

  const values = readYaml(valuesFile)
  ensureWithdrawalChartWiring(values)
  removeInlineWithdrawalConfig(values)
  ensureWithdrawalProofActivationSwitch(values, 'disabled')
  if (values.configMaps) {
    delete values.configMaps['proof-manifests']
    delete values.configMaps['agg-verifying-key']
  }

  if (values.persistence) {
    delete values.persistence['proof-manifests']
    delete values.persistence['proof-secrets']
    delete values.persistence['agg-verifying-key-source']
  }

  if (values.externalSecrets) delete values.externalSecrets['proof-secrets']
  if (values.initContainers) {
    delete values.initContainers['install-agg-verifying-key']
    if (Object.keys(values.initContainers).length === 0) delete values.initContainers
  }

  if (values.service?.main?.ports) delete values.service.main.ports['proof-work']

  const nativeSource = fs.readFileSync(withdrawalConfigFile, 'utf8')
  const nativeConfig = replaceWithdrawalManagedProofBlock(nativeSource, {
    proof_system: {
      mode: 'disabled',
      require_bridge_state: false,
      require_scroll_execution: false,
    },
  } as toml.JsonMap)
  writeYamlAtomic(valuesFile, values)
  writeTextAtomic(withdrawalConfigFile, nativeConfig)

  return {
    files: [valuesFile, withdrawalConfigFile],
    helmSetFiles: {
      proofCoordinator: [],
      withdrawalProcessor: [{
        filePath: withdrawalConfigFile,
        key: 'configMaps.config.data.WithdrawalProcessor\\.toml',
      }],
    },
    provingMode: undefined,
  }
}
