/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and manifest-derived TOML tables are dynamic documents. */

import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  ensureWithdrawalConfigValues,
  ensureWithdrawalProofActivationSwitch,
  replaceWithdrawalManagedProofBlock,
  setWithdrawalConfigToml,
} from './withdrawal-config.js'

export type ProofFamily = 'bridge_transition' | 'scroll_batch' | 'scroll_chunk'

export const DEFAULT_SCROLL_BATCH_BACKEND_PROFILE = 'scroll-prod-zkvm-batch-v1'
export const DEFAULT_BRIDGE_BACKEND_PROFILE = 'bridge-prod-zkvm-v1'
export const DEFAULT_ENVELOPE_MAX_PROOF_ARTIFACTS = 4
const DEFAULT_SIGNED_URL_TTL_MS = 3_600_000
const DEFAULT_MAX_READ_BODY_BYTES = 512 * 1024 * 1024
const MAX_TRANSPORT_HORIZON_MS = 7 * 24 * 60 * 60 * 1000
const MAX_EMBEDDED_AGG_VK_BYTES = 700 * 1024
const AGG_VK_PATH = '/app/data/verifier/agg-vk.bin'
const STATEMENT_NAMESPACE_CONFIG_PATH = '/app/data/manifests/statement-namespace.json'
const SCROLL_MATERIALIZER_BINARY_PATH = '/usr/local/bin/scroll-runtime-materializer'
const PROOF_WORK_TOKEN_PATH = '/run/secrets/proof-work-token'
const PROVER_WORKER_TOKEN_PATH = '/run/secrets/prover-worker-token'
const SCROLL_BATCH_COMMITMENT_ENV =
  'DOGEOS_PROOF_COORDINATOR_MATERIALIZER__SCROLL_BATCH__SUBPROCESS__CHUNK_PROGRAM_COMMITMENT_HEX'

interface ProofProgramManifest {
  circuit_id: string
  circuit_version: string
  hard_fork_name?: null | string
  program_commitment_hash: string
  proof_family: ProofFamily
  proof_system_id: string
  schema_version: number
  verification_key_hash: string
}

interface ArtifactIdentity {
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
  artifactManifestPath: string
  bridgeBackendProfile?: string
  coordinatorConfigPath: string
  enableWithdrawalProof?: boolean
  manifestPaths: string[]
  scrollBatchBackendProfile?: string
  signerProofArtifactBaseUrl?: string
  skipAttestationSigners?: boolean
  valuesDir: string
  verifierIds?: Partial<Record<ProofFamily, string>>
}

export interface ConfigureProofValuesResult {
  configFile: string
  families: ProofFamily[]
  files: string[]
}

const MANAGED_VERIFIER_BEGIN = '# BEGIN scrollsdk managed verifier configuration'
const MANAGED_VERIFIER_END = '# END scrollsdk managed verifier configuration'

const FAMILY_CONFIG_KEYS: Record<ProofFamily, string> = {
  bridge_transition: 'scroll_bridge_verifier_identity',
  scroll_batch: 'scroll_batch_verifier_identity',
  scroll_chunk: 'scroll_chunk_verifier_identity',
}

const FAMILY_PREFIXES: Record<ProofFamily, string> = {
  bridge_transition: 'SCROLL_BRIDGE',
  scroll_batch: 'SCROLL_BATCH',
  scroll_chunk: 'SCROLL_CHUNK',
}

const RAW_COMMITMENT_KEYS: Record<ProofFamily, keyof ArtifactIdentity> = {
  bridge_transition: 'bridge_app_commit_raw',
  scroll_batch: 'batch_program_commitment_raw',
  scroll_chunk: 'chunk_program_commitment_raw',
}

const PROGRAM_COMMITMENT_HASH_KEYS: Record<ProofFamily, keyof ArtifactIdentity> = {
  bridge_transition: 'bridge_program_commitment_hash',
  scroll_batch: 'batch_program_commitment_hash',
  scroll_chunk: 'chunk_program_commitment_hash',
}

const VERIFICATION_KEY_HASH_KEYS: Record<ProofFamily, keyof ArtifactIdentity> = {
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

function loadProgramManifests(paths: string[]): Map<ProofFamily, { manifest: ProofProgramManifest; path: string }> {
  if (paths.length === 0) throw new Error('At least one --program-manifest is required')
  const manifests = new Map<ProofFamily, { manifest: ProofProgramManifest; path: string }>()
  const basenames = new Set<string>()

  for (const manifestPath of paths.map(item => path.resolve(item))) {
    const manifest = readJson<ProofProgramManifest>(manifestPath)
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

function normalizeSignerProofArtifactBaseUrl(value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error('--signer-proof-artifact-base-url is required for production bridge proof evidence')
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (error) {
    throw new Error(`--signer-proof-artifact-base-url must be an absolute URL: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('--signer-proof-artifact-base-url must not contain credentials, a query, or a fragment')
  }

  const hostname = parsed.hostname.replaceAll(/^\[|]$/g, '').toLowerCase()
  const loopback = hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('--signer-proof-artifact-base-url must use https:// (loopback http:// is allowed for dev/test)')
  }

  parsed.pathname = parsed.pathname.replaceAll(/\/+$/g, '') || '/'
  return parsed.toString().replaceAll(/\/$/g, '')
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

/**
 * The prep-charts template plus every expanded per-instance values file.
 * Writing the template keeps the projection stable across prep-charts re-runs
 * (instances are regenerated from it); writing the instances makes the change
 * effective without another prep-charts pass.
 */
function listAttestationSignerValuesFiles(valuesDir: string): string[] {
  const files: string[] = []
  const template = path.join(valuesDir, 'attestation-signer-production.yaml')
  if (fs.existsSync(template)) files.push(template)
  for (const entry of fs.readdirSync(valuesDir)) {
    if (/^attestation-signer-production-\d+\.yaml$/.test(entry)) files.push(path.join(valuesDir, entry))
  }

  return files.sort()
}

function prepareAttestationSigners(
  valuesDir: string,
  allowedProofTriples: string
): Array<{ filePath: string; values: any }> {
  const files = listAttestationSignerValuesFiles(valuesDir)
  if (files.length === 0) {
    throw new Error(
      `No attestation-signer values found in ${valuesDir} (expected attestation-signer-production.yaml or attestation-signer-production-<N>.yaml); `
      + 'pass --skip-attestation-signers only when signer envelope policy is managed elsewhere'
    )
  }

  return files.map(filePath => {
    const values = readYaml(filePath)
    const signer = values.attestationSigner
    if (!signer || typeof signer !== 'object' || Array.isArray(signer)) {
      throw new Error(`${filePath}: attestationSigner must be a YAML mapping`)
    }

    signer.envelopePolicy ||= {}
    signer.envelopePolicy.allowedProofTriples = allowedProofTriples
    const cap = signer.envelopePolicy.maxProofArtifacts
    if (!Number.isSafeInteger(cap) || cap < ENVELOPE_PROOF_KINDS.length) {
      signer.envelopePolicy.maxProofArtifacts = DEFAULT_ENVELOPE_MAX_PROOF_ARTIFACTS
    }

    signer.proofArtifact ||= {}
    signer.proofArtifact.fetchMode = 'http'
    return { filePath, values }
  })
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

function replaceManagedVerifierBlock(filePath: string, verifier: Record<string, any>): string {
  if (!fs.existsSync(filePath)) throw new Error(`Proof coordinator TOML not found: ${filePath}`)
  const source = fs.readFileSync(filePath, 'utf8')
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
  const coordinatorConfig = toml.parse(fs.readFileSync(coordinatorConfigPath, 'utf8')) as any
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

function validateCoordinatorMaterializerTopology(coordinatorConfigPath: string): void {
  const config = toml.parse(fs.readFileSync(coordinatorConfigPath, 'utf8')) as any
  const { materializer } = config
  const requireString = (value: any, label: string): void => {
    assertIdentifier(value, `${coordinatorConfigPath}: ${label}`)
  }

  const requirePositiveInteger = (value: any, label: string, maximum = Number.MAX_SAFE_INTEGER): void => {
    if (value === undefined || value === null || value === '') {
      throw new Error(`${coordinatorConfigPath}: ${label} is required`)
    }

    parsePositiveInteger(value, 1, `${coordinatorConfigPath}: ${label}`, maximum)
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

  requireEnabled(materializer.scroll_chunk_segmentation, 'materializer.scroll_chunk_segmentation')
  requireEnabled(materializer.scroll_batch, 'materializer.scroll_batch')
  requireString(
    materializer.scroll_batch.materializer_output_root,
    '[materializer.scroll_batch].materializer_output_root'
  )

  if (materializer.scroll_batch.dev_sentinel === true) {
    throw new Error(`${coordinatorConfigPath}: production proof config cannot use materializer.scroll_batch.dev_sentinel`)
  }

  const scrollBatchSubprocess = materializer.scroll_batch.subprocess
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
  requirePositiveInteger(
    scrollBatchSubprocess.subprocess_timeout_ms,
    '[materializer.scroll_batch.subprocess].subprocess_timeout_ms'
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

  const validateEthereumDa = (ethereumDa: any, label: string): void => {
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

  validateEthereumDa(
    scrollBatchSubprocess.ethereum_da,
    'materializer.scroll_batch.subprocess.ethereum_da'
  )

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

  validateEthereumDa(materializer.bridge.ethereum_da, 'materializer.bridge.ethereum_da')
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
  commitments: Map<ProofFamily, string>,
  verifierIds: Partial<Record<ProofFamily, string>>,
  verifierArtifact: VerifierArtifact
): { updatedConfig: string; values: any } {
  const values = readYaml(filePath)
  const verifier: Record<string, any> = { verifier_import_mode: 'production' }
  const manifestConfigMap: Record<string, string> = {}
  for (const [family, { manifest, path: manifestPath }] of manifests) {
    const verifierId = verifierIds[family] || defaultVerifierId(manifest)
    assertIdentifier(verifierId, `${family} verifier ID`)
    verifier[FAMILY_CONFIG_KEYS[family]] = verifierPolicy(manifest, manifestPath, verifierId)
    manifestConfigMap[path.basename(manifestPath)] = `${fs.readFileSync(manifestPath, 'utf8').trimEnd()}\n`
  }

  const scrollChunkManifest = manifests.get('scroll_chunk')!.manifest
  const scrollBatchManifest = manifests.get('scroll_batch')!.manifest
  manifestConfigMap['statement-namespace.json'] = `${JSON.stringify({
    batch: {
      circuit_id: scrollBatchManifest.circuit_id,
      proof_mode: 'Production',
      proof_system_id: scrollBatchManifest.proof_system_id,
      verification_key_hash: scrollBatchManifest.verification_key_hash,
    },
    chunk: {
      circuit_id: scrollChunkManifest.circuit_id,
      proof_mode: 'Production',
      proof_system_id: scrollChunkManifest.proof_system_id,
      verification_key_hash: scrollChunkManifest.verification_key_hash,
    },
  }, null, 2)}\n`

  verifier.scroll_real_verifier = {
    agg_verifying_key_path: AGG_VK_PATH,
    batch_program_commitment_hex: commitments.get('scroll_batch'),
    bridge_program_commitment_hex: commitments.get('bridge_transition'),
    chunk_program_commitment_hex: commitments.get('scroll_chunk'),
  }
  const updatedConfig = replaceManagedVerifierBlock(configPath, verifier)
  values.env ||= []
  if (!Array.isArray(values.env)) throw new Error(`${filePath}: env must be an array`)
  const existingCommitment = values.env.find((item: any) => item?.name === SCROLL_BATCH_COMMITMENT_ENV)
  if (existingCommitment) {
    existingCommitment.value = commitments.get('scroll_chunk')
    delete existingCommitment.valueFrom
  } else {
    values.env.push({
      name: SCROLL_BATCH_COMMITMENT_ENV,
      value: commitments.get('scroll_chunk'),
    })
  }

  values.configMaps ||= {}
  values.configMaps.manifests = { data: manifestConfigMap, enabled: true }
  values.persistence ||= {}
  values.persistence.manifests = {
    enabled: true,
    mountPath: '/app/data/manifests',
    name: '{{ include "scroll.common.lib.chart.names.fullname" . }}-manifests',
    readOnly: true,
    type: 'configMap',
  }
  configureAggVerifierArtifact(
    values,
    '{{ include "scroll.common.lib.chart.names.fullname" . }}-agg-verifying-key',
    verifierArtifact
  )
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

function prepareWithdrawalProcessor(
  filePath: string,
  coordinatorValuesPath: string,
  coordinatorConfigPath: string,
  manifests: Map<ProofFamily, { manifest: ProofProgramManifest; path: string }>,
  commitments: Map<ProofFamily, string>,
  verifierIds: Partial<Record<ProofFamily, string>>,
  scrollBatchBackendProfile: string,
  bridgeBackendProfile: string,
  signerProofArtifactBaseUrl: string,
  verifierArtifact: VerifierArtifact
): any {
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
  const manifestConfigMap: Record<string, string> = {}

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
    mode: 'production',
    require_bridge_state: manifests.has('bridge_transition'),
    require_scroll_execution: manifests.has('scroll_chunk') || manifests.has('scroll_batch'),
  }
  const proofControlPlaneGate: Record<string, any> = {
    store_path: '/app/data/control-plane.sqlite',
  }

  for (const [family, { manifest, path: manifestPath }] of manifests) {
    const verifierId = verifierIds[family] || defaultVerifierId(manifest)
    if (family !== 'bridge_transition') {
      proofControlPlaneGate[`${FAMILY_PREFIXES[family].toLowerCase()}_circuit_id`] = manifest.circuit_id
      proofControlPlaneGate[`${FAMILY_PREFIXES[family].toLowerCase()}_verification_key_hash_hex`] = bareHex(
        manifest.verification_key_hash,
        32,
        `${family} verification key hash`
      )
      proofControlPlaneGate[`${FAMILY_PREFIXES[family].toLowerCase()}_program_commitment_hash_hex`] = manifest.program_commitment_hash
    }

    proofControlPlaneGate[FAMILY_CONFIG_KEYS[family]] = verifierPolicy(manifest, manifestPath, verifierId)

    manifestConfigMap[path.basename(manifestPath)] = `${fs.readFileSync(manifestPath, 'utf8').trimEnd()}\n`
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

  proofControlPlaneGate.scroll_real_verifier = {
    agg_verifying_key_path: AGG_VK_PATH,
    batch_program_commitment_hex: bareHex(
      commitments.get('scroll_batch')!,
      64,
      'scroll batch raw program commitment'
    ),
    bridge_program_commitment_hex: bareHex(
      commitments.get('bridge_transition')!,
      64,
      'bridge raw program commitment'
    ),
    chunk_program_commitment_hex: bareHex(
      commitments.get('scroll_chunk')!,
      64,
      'scroll chunk raw program commitment'
    ),
  }

  const proofConfig: Record<string, any> = {
    proof_control_plane_gate: proofControlPlaneGate,
    proof_system: proofSystem,
    proof_work_api: {
      allow_insecure_http: true,
      auth: {
        bearer_token_file: '/run/secrets/proof-work-token',
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
        scroll_chunk_segmentation: { enabled: true },
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

  const withdrawalConfig = ensureWithdrawalConfigValues(values)
  setWithdrawalConfigToml(
    values,
    replaceWithdrawalManagedProofBlock(withdrawalConfig, proofConfig as toml.JsonMap)
  )

  values.configMaps ||= {}
  values.configMaps['proof-manifests'] = { data: manifestConfigMap, enabled: true }
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
    mountPath: '/run/secrets',
    name: 'proof-secrets',
    readOnly: true,
    type: 'secret',
  }
  configureAggVerifierArtifact(
    values,
    '{{ include "withdrawal-processor.fullname" . }}-agg-verifying-key',
    verifierArtifact
  )
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

  ensureWithdrawalProofActivationSwitch(values)

  return values
}

export function configureProofValues(options: ConfigureProofValuesOptions): ConfigureProofValuesResult {
  const valuesDir = path.resolve(options.valuesDir)
  const manifests = loadProgramManifests(options.manifestPaths)
  const commitments = loadRawCommitments(options.artifactManifestPath, manifests)
  const verifierArtifact = loadVerifierArtifact(options.artifactManifestPath)
  const verifierIds = options.verifierIds || {}
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
  const scrollBatchBackendProfile = options.scrollBatchBackendProfile || DEFAULT_SCROLL_BATCH_BACKEND_PROFILE
  const bridgeBackendProfile = options.bridgeBackendProfile || DEFAULT_BRIDGE_BACKEND_PROFILE
  const signerProofArtifactBaseUrl = normalizeSignerProofArtifactBaseUrl(
    options.signerProofArtifactBaseUrl
  )
  assertIdentifier(scrollBatchBackendProfile, 'Scroll batch backend profile')
  assertIdentifier(bridgeBackendProfile, 'Bridge backend profile')
  readCoordinatorRuntimeProjection(files[0], configFile)
  validateCoordinatorMaterializerTopology(configFile)
  const allowedProofTriples = buildAllowedProofTriples(manifests, verifierIds)
  const attestationUpdates = options.skipAttestationSigners
    ? []
    : prepareAttestationSigners(valuesDir, allowedProofTriples)

  // Build and validate every target before writing any of them.
  const coordinatorUpdate = prepareProofCoordinator(
    files[0],
    configFile,
    manifests,
    commitments,
    verifierIds,
    verifierArtifact
  )
  const withdrawalValues = prepareWithdrawalProcessor(
    files[1],
    files[0],
    configFile,
    manifests,
    commitments,
    verifierIds,
    scrollBatchBackendProfile,
    bridgeBackendProfile,
    signerProofArtifactBaseUrl,
    verifierArtifact
  )
  if (options.enableWithdrawalProof) withdrawalValues.withdrawalProof.enabled = true

  writeTextAtomic(configFile, coordinatorUpdate.updatedConfig)
  writeYamlAtomic(files[0], coordinatorUpdate.values)
  writeYamlAtomic(files[1], withdrawalValues)
  for (const update of attestationUpdates) writeYamlAtomic(update.filePath, update.values)
  return {
    configFile,
    families: [...manifests.keys()].sort(),
    files: [...files, ...attestationUpdates.map(update => update.filePath)],
  }
}
