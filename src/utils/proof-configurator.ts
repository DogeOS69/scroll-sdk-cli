/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and manifest-derived TOML tables are dynamic documents. */

import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export type ProofFamily = 'bridge_transition' | 'scroll_batch' | 'scroll_chunk'

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
  batch_program_commitment_raw?: string
  bridge_app_commit_raw?: string
  chunk_program_commitment_raw?: string
}

interface ArtifactManifest {
  expected_identity?: ArtifactIdentity
}

export interface ConfigureProofValuesOptions {
  artifactManifestPath: string
  coordinatorConfigPath: string
  manifestPaths: string[]
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
}

function normalizeHex(value: unknown, bytes: number, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const normalized = value.toLowerCase()
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be canonical 0x-prefixed ${bytes}-byte hex`)
  }

  return normalized
}

function loadProgramManifests(paths: string[]): Map<ProofFamily, { manifest: ProofProgramManifest; path: string }> {
  if (paths.length === 0) throw new Error('At least one --program-manifest is required')
  const manifests = new Map<ProofFamily, { manifest: ProofProgramManifest; path: string }>()

  for (const manifestPath of paths.map(item => path.resolve(item))) {
    const manifest = readJson<ProofProgramManifest>(manifestPath)
    if (manifest.schema_version !== 1) throw new Error(`${manifestPath}: unsupported schema_version ${manifest.schema_version}`)
    if (!Object.hasOwn(FAMILY_CONFIG_KEYS, manifest.proof_family)) {
      throw new Error(`${manifestPath}: unsupported proof_family ${String(manifest.proof_family)}`)
    }

    if (manifests.has(manifest.proof_family)) throw new Error(`Duplicate manifest for ${manifest.proof_family}`)
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

    commitments.set(family, raw)
  }

  return commitments
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

function readYaml(filePath: string): any {
  if (!fs.existsSync(filePath)) throw new Error(`Values file not found: ${filePath}`)
  const parsed = yaml.load(fs.readFileSync(filePath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Values file must contain a YAML mapping: ${filePath}`)
  return parsed
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

function setEnv(env: Array<Record<string, any>>, name: string, value: string): void {
  const existing = env.find(item => item?.name === name)
  if (existing) {
    existing.value = value
    delete existing.valueFrom
  } else {
    env.push({ name, value })
  }
}

function updateProofCoordinator(
  filePath: string,
  configPath: string,
  manifests: Map<ProofFamily, { manifest: ProofProgramManifest; path: string }>,
  commitments: Map<ProofFamily, string>,
  verifierIds: Partial<Record<ProofFamily, string>>
): void {
  const values = readYaml(filePath)
  const verifier: Record<string, any> = { verifier_import_mode: 'production' }
  const manifestConfigMap: Record<string, string> = {}
  for (const [family, { manifest, path: manifestPath }] of manifests) {
    const verifierId = verifierIds[family] || defaultVerifierId(manifest)
    assertIdentifier(verifierId, `${family} verifier ID`)
    verifier[FAMILY_CONFIG_KEYS[family]] = verifierPolicy(manifest, manifestPath, verifierId)
    manifestConfigMap[path.basename(manifestPath)] = `${fs.readFileSync(manifestPath, 'utf8').trimEnd()}\n`
  }

  verifier.scroll_real_verifier = {
    agg_verifying_key_path: '/app/data/verifier/agg-vk.bin',
    batch_program_commitment_hex: commitments.get('scroll_batch'),
    bridge_program_commitment_hex: commitments.get('bridge_transition'),
    chunk_program_commitment_hex: commitments.get('scroll_chunk'),
  }
  const updatedConfig = replaceManagedVerifierBlock(configPath, verifier)
  values.configMaps ||= {}
  values.configMaps.manifests = { data: manifestConfigMap, enabled: true }
  values.persistence ||= {}
  values.persistence.manifests = {
    enabled: true,
    mountPath: '/app/data/manifests',
    readOnly: true,
    type: 'configMap',
  }
  writeTextAtomic(configPath, updatedConfig)
  writeYamlAtomic(filePath, values)
}

function updateWithdrawalProcessor(
  filePath: string,
  coordinatorValuesPath: string,
  manifests: Map<ProofFamily, { manifest: ProofProgramManifest; path: string }>,
  commitments: Map<ProofFamily, string>,
  verifierIds: Partial<Record<ProofFamily, string>>
): void {
  const values = readYaml(filePath)
  const coordinatorValues = readYaml(coordinatorValuesPath)
  const coordinatorEnv = Object.fromEntries(
    (Array.isArray(coordinatorValues.env) ? coordinatorValues.env : [])
      .filter((item: any) => typeof item?.name === 'string' && item.value !== undefined)
      .map((item: any) => [item.name, String(item.value)])
  ) as Record<string, string>
  values.env ||= []
  if (!Array.isArray(values.env)) throw new Error(`${filePath}: env must be an array`)
  const env = values.env as Array<Record<string, any>>
  const manifestConfigMap: Record<string, string> = {}

  for (let index = env.length - 1; index >= 0; index--) {
    const name = String(env[index]?.name || '')
    if (
      name.startsWith('DOGEOS_WITHDRAWAL_PROOF_TASK_POLICY__') ||
      name.startsWith('DOGEOS_WITHDRAWAL_PROOF_EXECUTION_WORKER__') ||
      name.startsWith('DOGEOS_WITHDRAWAL_LOCAL_BRIDGE_PROOF_RUNTIME__') ||
      name.startsWith('DOGEOS_WITHDRAWAL_SCROLL_WORKER_API__')
    ) env.splice(index, 1)
  }

  setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE', 'production')
  setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_SCROLL_EXECUTION', String(manifests.has('scroll_chunk') || manifests.has('scroll_batch')))
  setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_BRIDGE_STATE', String(manifests.has('bridge_transition')))
  setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__STORE_PATH', '/app/data/control-plane.sqlite')
  setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__ENABLED', 'true')
  setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__BIND_ADDR', '0.0.0.0:9300')
  setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__ALLOW_INSECURE_HTTP', 'true')
  setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__AUTH__BEARER_TOKEN_FILE', '/run/secrets/proof-work-token')
  setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__MATERIALIZE__SCROLL_CHUNK_SEGMENTATION__ENABLED', 'true')
  setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__MATERIALIZE__SCROLL_BATCH__ENABLED', 'true')
  setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__MATERIALIZE__BRIDGE__ENABLED', 'true')
  setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__MATERIALIZE__BRIDGE__ADVANCE_L1_ENABLED', 'true')
  setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__MATERIALIZE__BRIDGE__ADVANCE_L2_ENABLED', 'true')
  setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__MATERIALIZE__BRIDGE__PREPARED_BUNDLE_SOURCE_ROOT', '/app/data/bridge-prepared-bundles')

  for (const [family, { manifest, path: manifestPath }] of manifests) {
    const prefix = `DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__${FAMILY_PREFIXES[family]}`
    const verifierId = verifierIds[family] || defaultVerifierId(manifest)
    setEnv(env, `${prefix}_CIRCUIT_ID`, manifest.circuit_id)
    setEnv(env, `${prefix}_VERIFICATION_KEY_HASH_HEX`, manifest.verification_key_hash)
    const policy = verifierPolicy(manifest, manifestPath, verifierId)
    for (const [key, value] of Object.entries(policy)) {
      setEnv(env, `${prefix}_VERIFIER_IDENTITY__${key.toUpperCase()}`, String(value))
    }

    manifestConfigMap[path.basename(manifestPath)] = `${fs.readFileSync(manifestPath, 'utf8').trimEnd()}\n`
  }

  const bridge = manifests.get('bridge_transition')?.manifest
  if (bridge) {
    setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__PROOF_SYSTEM_ID', bridge.proof_system_id)
    setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__CIRCUIT_ID', bridge.circuit_id)
    setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__VERIFICATION_KEY_HASH_HEX', bridge.verification_key_hash)
  }

  setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__SCROLL_REAL_VERIFIER__AGG_VERIFYING_KEY_PATH', '/app/data/verifier/agg-vk.bin')
  if (commitments.has('scroll_chunk')) setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__SCROLL_REAL_VERIFIER__CHUNK_PROGRAM_COMMITMENT_HEX', commitments.get('scroll_chunk')!)
  if (commitments.has('scroll_batch')) setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__SCROLL_REAL_VERIFIER__BATCH_PROGRAM_COMMITMENT_HEX', commitments.get('scroll_batch')!)
  if (commitments.has('bridge_transition')) setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__SCROLL_REAL_VERIFIER__BRIDGE_PROGRAM_COMMITMENT_HEX', commitments.get('bridge_transition')!)

  const bucket = coordinatorEnv.DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__BUCKET
  const region = coordinatorEnv.DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__REGION
  const keyPrefix = coordinatorEnv.DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__KEY_PREFIX || 'proof-topology'
  const endpointUrl = coordinatorEnv.DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__ENDPOINT_URL
  const publicEndpoint = coordinatorEnv.DOGEOS_PROOF_COORDINATOR_PROVER_API__PUBLIC_S3_ENDPOINT_URL
  if (bucket && region) {
    setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_ARTIFACT_TRANSPORT__KIND', 's3_compatible')
    setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_ARTIFACT_TRANSPORT__LOCAL_STORE_ROOT', '/app/data/proof-artifacts')
    setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_ARTIFACT_TRANSPORT__BUCKET', bucket)
    setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_ARTIFACT_TRANSPORT__REGION', region)
    setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_ARTIFACT_TRANSPORT__KEY_PREFIX', keyPrefix)
    setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_ARTIFACT_TRANSPORT__FORCE_PATH_STYLE', coordinatorEnv.DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__FORCE_PATH_STYLE || String(Boolean(endpointUrl)))
    if (endpointUrl) setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_ARTIFACT_TRANSPORT__ENDPOINT_URL', endpointUrl)
    if (publicEndpoint) {
      const acceptedProofUrl = [publicEndpoint.replaceAll(/\/$/g, ''), keyPrefix.replaceAll(/^\/|\/$/g, ''), 'accepted/proofs']
        .filter(Boolean)
        .join('/')
      setEnv(env, 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__SIGNER_PROOF_ARTIFACT_BASE_URL', acceptedProofUrl)
    }
  }

  values.configMaps ||= {}
  values.configMaps['proof-manifests'] = { data: manifestConfigMap, enabled: true }
  values.persistence ||= {}
  values.persistence['proof-manifests'] = {
    enabled: true,
    mountPath: '/app/data/manifests',
    readOnly: true,
    type: 'configMap',
  }
  values.persistence['proof-secrets'] = {
    enabled: true,
    mountPath: '/run/secrets',
    readOnly: true,
    type: 'secret',
  }

  const coordinatorProofSecret = Object.values(coordinatorValues.externalSecrets || {})
    .find((secret: any) => Array.isArray(secret?.data) && secret.data.some((item: any) => item?.secretKey === 'proof-work-token')) as any
  if (coordinatorProofSecret) {
    values.externalSecrets ||= {}
    values.externalSecrets['proof-secrets'] = {
      ...coordinatorProofSecret,
      data: coordinatorProofSecret.data.filter((item: any) => item?.secretKey === 'proof-work-token'),
    }
  }

  writeYamlAtomic(filePath, values)
}

export function configureProofValues(options: ConfigureProofValuesOptions): ConfigureProofValuesResult {
  const valuesDir = path.resolve(options.valuesDir)
  const manifests = loadProgramManifests(options.manifestPaths)
  const commitments = loadRawCommitments(options.artifactManifestPath, manifests)
  const verifierIds = options.verifierIds || {}
  const configFile = path.resolve(options.coordinatorConfigPath)
  const files = [
    path.join(valuesDir, 'proof-coordinator-production.yaml'),
    path.join(valuesDir, 'withdrawal-processor-production.yaml'),
  ]

  // Complete validation happens before either target is written.
  for (const filePath of files) readYaml(filePath)
  if (!fs.existsSync(configFile)) throw new Error(`Proof coordinator TOML not found: ${configFile}`)
  updateProofCoordinator(files[0], configFile, manifests, commitments, verifierIds)
  updateWithdrawalProcessor(files[1], files[0], manifests, commitments, verifierIds)
  return { configFile, families: [...manifests.keys()].sort(), files }
}
