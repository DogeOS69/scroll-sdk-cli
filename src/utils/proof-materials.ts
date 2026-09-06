import {spawnSync} from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type {
  ProofMaterialFileV1,
  ProofMaterialsV1,
  ProofProgramIdentityV1,
} from '../types/proof-materials.js'
import type {ProofTopologyImageReference} from '../types/proof-topology.js'

import {PROOF_MATERIALS_SCHEMA} from '../types/proof-materials.js'

export const DEFAULT_PROOF_MATERIALS_RECEIPT = '.data/proof-materials-v1.json'
export const DEFAULT_PROOF_MATERIALS_ROOT = '.data/proof-materials'
export const MOCK_WORKER_IDENTITY_CONTAINER_PATH = '/etc/dogeos/proof-identity/worker-identity.json'
const MOCK_WORKER_IDENTITY_RELATIVE_PATH = 'software/identity/worker-identity.json'

const HEX_32 = /^0x[\da-f]{64}$/
const HEX_64 = /^0x[\da-f]{128}$/
const BARE_HEX_32 = /^[\da-f]{64}$/
const SHA256 = /^[\da-f]{64}$/
const PINNED_IMAGE = /^(\S+)@(sha256:[\da-f]{64})$/

const IDENTITY_ENV_FIELDS = new Set([
  'DOGEOS_BATCH_AGGREGATION_PROGRAM_COMMITMENT_RAW',
  'DOGEOS_BATCH_PROGRAM_COMMITMENT',
  'DOGEOS_BATCH_PROGRAM_COMMITMENT_RAW',
  'DOGEOS_BATCH_SCROLL_PROGRAM_COMMITMENT_RAW',
  'DOGEOS_BATCH_VK_HASH',
  'DOGEOS_BRIDGE_APP_COMMIT_RAW',
  'DOGEOS_BRIDGE_PROGRAM_COMMITMENT',
  'DOGEOS_BRIDGE_VK_HASH',
  'DOGEOS_CHUNK_PROGRAM_COMMITMENT',
  'DOGEOS_CHUNK_PROGRAM_COMMITMENT_RAW',
  'DOGEOS_CHUNK_VK_HASH',
])

interface ProducerArtifact {
  path: string
  sha256: string
  size_bytes: number
}

interface ProducerManifest {
  artifacts: {
    batch_openvm_toml: ProducerArtifact
    batch_vmexe: ProducerArtifact
    chunk_openvm_toml: ProducerArtifact
    chunk_vmexe: ProducerArtifact
    root_agg_verifying_key: ProducerArtifact
  }
  dogeos_core_commit: string
  producer: {
    commit: string
  }
  toolchain: {
    openvm_tag: string
    rust: string
  }
}

interface NativeBridgeManifest {
  advance_l2_batch_aggregation_app_commit_raw: string
  advance_l2_batch_aggregation_app_config_sha256: string
  advance_l2_batch_aggregation_inner_batch_app_commit_raw: string
  advance_l2_batch_aggregation_vmexe_sha256: string
  advance_l2_batch_aggregation_vmexe_size_bytes: number
  advance_l2_inner_batch_app_commit_raw: string
  app_commit_raw: string
  app_config_sha256: string
  genesis_sequencer_outpoint_index: number
  genesis_state_hash: string
  openvm_version: string
  program_commitment_hash: string
  schema_version: number
  verification_key_hash: string
  vmexe_sha256: string
  vmexe_size_bytes: number
}

export interface PrepareProofMaterialsOptions {
  aggregateVerifyingKey?: string
  batchMaterializer?: string
  bridgeArtifactDir?: string
  chunkMaterializer?: string
  deploymentDir: string
  generation: 'mock' | 'real'
  identityEnv?: string
  images: {
    mockWorker: ProofTopologyImageReference
    productionWorker?: ProofTopologyImageReference
    topologyCompiler: ProofTopologyImageReference
  }
  /** Test/air-gapped override; ordinary setup extracts this from mockWorker. */
  mockWorkerIdentity?: string
  outputReceipt?: string
  outputRoot?: string
  producerManifest?: string
  protocolContext?: string
  refreshExistingImages?: boolean
  /**
   * Canonical worker-identity-bundle.json emitted by the matching dogeos-core
   * bake. Required when mock proving uses real Scroll materialization because
   * the mock image intentionally carries an all-zero batch_guest placeholder.
   */
  workerIdentityBundle?: string
}

function mockWorkerAggregationIdentity(body: string, label: string): {appCommitRaw: string; programCommitmentHash: string} {
  const root = mapping(JSON.parse(body) as unknown, label)
  assertOnlyKeys(root, [
    'batch_aggregation_guest',
    'batch_guest',
    'guest_openvm_toml_sha256',
    'image_revision',
    'openvm_version',
    'root_verifier_asm_sha256',
  ], label)
  if (root.image_revision !== null) requiredString(root.image_revision, `${label}.image_revision`)
  requiredString(root.openvm_version, `${label}.openvm_version`)
  canonicalHex(root.root_verifier_asm_sha256, 32, `${label}.root_verifier_asm_sha256`)
  canonicalHex(root.guest_openvm_toml_sha256, 32, `${label}.guest_openvm_toml_sha256`)

  const batch = mapping(root.batch_guest, `${label}.batch_guest`)
  validateGuestCommit(batch, `${label}.batch_guest`)
  const aggregation = mapping(root.batch_aggregation_guest, `${label}.batch_aggregation_guest`)
  assertOnlyKeys(aggregation, [
    'app_commit_raw',
    'app_exe_commit',
    'app_vm_commit',
    'embedded_inner_batch_app_commit_raw',
    'program_commitment_hash',
  ], `${label}.batch_aggregation_guest`)
  validateGuestCommit(aggregation, `${label}.batch_aggregation_guest`)
  const appCommitRaw = canonicalHex(
    aggregation.app_commit_raw,
    64,
    `${label}.batch_aggregation_guest.app_commit_raw`,
  )
  const programCommitmentHash = canonicalHex(
    aggregation.program_commitment_hash,
    32,
    `${label}.batch_aggregation_guest.program_commitment_hash`,
  )
  if (sha256Bytes(appCommitRaw) !== programCommitmentHash) {
    throw new Error(`${label}.batch_aggregation_guest program commitment hash does not match app_commit_raw`)
  }

  const embeddedInner = canonicalHex(
    aggregation.embedded_inner_batch_app_commit_raw,
    64,
    `${label}.batch_aggregation_guest.embedded_inner_batch_app_commit_raw`,
  )
  const batchRaw = canonicalHex(batch.app_commit_raw, 64, `${label}.batch_guest.app_commit_raw`)
  if (batchRaw !== `0x${'0'.repeat(128)}` && embeddedInner !== batchRaw) {
    throw new Error(`${label}.batch_aggregation_guest embedded inner Batch commitment does not match batch_guest`)
  }

  return {appCommitRaw, programCommitmentHash}
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value).filter(key => !allowedSet.has(key))
  if (unknown.length > 0) throw new Error(`${label} contains unknown field ${unknown[0]}`)
  for (const key of allowed) {
    if (!(key in value)) throw new Error(`${label} is missing ${key}`)
  }
}

function bareHex32(value: unknown, label: string): string {
  const text = requiredString(value, label)
  if (!BARE_HEX_32.test(text)) throw new Error(`${label} must be canonical lowercase bare 32-byte hex`)
  return text
}

function validateGuestCommit(value: Record<string, unknown>, label: string): void {
  const required = ['app_commit_raw', 'app_exe_commit', 'app_vm_commit']
  if (label.endsWith('.batch_guest')) assertOnlyKeys(value, required, label)
  const exe = bareHex32(value.app_exe_commit, `${label}.app_exe_commit`)
  const vm = bareHex32(value.app_vm_commit, `${label}.app_vm_commit`)
  const raw = canonicalHex(value.app_commit_raw, 64, `${label}.app_commit_raw`)
  if (raw !== `0x${exe}${vm}`) throw new Error(`${label}.app_commit_raw does not match app_exe_commit ++ app_vm_commit`)
}

function validateMockWorkerIdentity(body: string, label: string): void {
  mockWorkerAggregationIdentity(body, label)
}

function validateRealMaterializationWorkerIdentity(
  body: string,
  env: Record<string, string>,
  label: string,
): void {
  const root = mapping(JSON.parse(body) as unknown, label)
  const batch = mapping(root.batch_guest, `${label}.batch_guest`)
  const batchRaw = canonicalHex(batch.app_commit_raw, 64, `${label}.batch_guest.app_commit_raw`)
  if (batchRaw === `0x${'0'.repeat(128)}`) {
    throw new Error(`${label}.batch_guest must not be the all-zero mock placeholder for real materialization`)
  }

  if (batchRaw !== env.DOGEOS_BATCH_PROGRAM_COMMITMENT_RAW) {
    throw new Error(`${label}.batch_guest does not match DOGEOS_BATCH_PROGRAM_COMMITMENT_RAW`)
  }

  const aggregation = mapping(root.batch_aggregation_guest, `${label}.batch_aggregation_guest`)
  const aggregationRaw = canonicalHex(
    aggregation.app_commit_raw,
    64,
    `${label}.batch_aggregation_guest.app_commit_raw`,
  )
  if (aggregationRaw !== env.DOGEOS_BATCH_AGGREGATION_PROGRAM_COMMITMENT_RAW) {
    throw new Error(`${label}.batch_aggregation_guest does not match DOGEOS_BATCH_AGGREGATION_PROGRAM_COMMITMENT_RAW`)
  }
}

export function extractMockWorkerIdentity(image: ProofTopologyImageReference): string {
  const reference = immutableProofImage(image)
  const result = spawnSync('docker', [
    'run',
    '--rm',
    '--entrypoint',
    '/bin/cat',
    reference,
    MOCK_WORKER_IDENTITY_CONTAINER_PATH,
  ], {encoding: 'utf8', maxBuffer: 4 * 1024 * 1024})
  if (result.error) {
    throw new Error(`Unable to extract mock Worker identity from ${reference}: ${result.error.message}`)
  }

  if (result.status !== 0) {
    throw new Error(`Unable to extract ${MOCK_WORKER_IDENTITY_CONTAINER_PATH} from ${reference}: ${(result.stderr || result.stdout).trim()}`)
  }

  try {
    validateMockWorkerIdentity(result.stdout, `${reference}:${MOCK_WORKER_IDENTITY_CONTAINER_PATH}`)
  } catch (error) {
    throw new Error(`Invalid mock Worker identity in ${reference}: ${error instanceof Error ? error.message : String(error)}`)
  }

  return result.stdout
}

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label} must be a JSON object`)
  }

  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`)
  return Number(value)
}

function readJson(filePath: string, label: string): unknown {
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`Could not parse ${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  return value
}

function canonicalHex(value: unknown, bytes: 32 | 64, label: string): string {
  const text = requiredString(value, label)
  const expression = bytes === 32 ? HEX_32 : HEX_64
  if (!expression.test(text)) throw new Error(`${label} must be canonical lowercase 0x-prefixed ${bytes}-byte hex`)
  return text
}

function normalizeSha256(value: unknown, label: string): string {
  const text = requiredString(value, label).replace(/^0x/, '')
  if (!SHA256.test(text)) throw new Error(`${label} must be a lowercase SHA-256 digest`)
  return text
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function sha256Bytes(value: string): string {
  return `0x${crypto.createHash('sha256').update(Buffer.from(value.slice(2), 'hex')).digest('hex')}`
}

function assertRegularFile(filePath: string, label: string): void {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(filePath)
  } catch {
    throw new Error(`${label} does not exist: ${filePath}`)
  }

  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular, non-symlink file: ${filePath}`)
}

function assertDirectory(filePath: string, label: string): void {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(filePath)
  } catch {
    throw new Error(`${label} does not exist: ${filePath}`)
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a non-symlink directory: ${filePath}`)
}

function parseProducerArtifact(value: unknown, label: string): ProducerArtifact {
  const object = mapping(value, label)
  const artifact = {
    path: requiredString(object.path, `${label}.path`),
    sha256: normalizeSha256(object.sha256, `${label}.sha256`),
    size_bytes: requiredInteger(object.size_bytes, `${label}.size_bytes`),
  }
  const resolved = path.resolve(artifact.path)
  assertRegularFile(resolved, label)
  const actualSha = sha256File(resolved)
  const actualSize = fs.statSync(resolved).size
  if (actualSha !== artifact.sha256) throw new Error(`${label} SHA-256 mismatch: expected ${artifact.sha256}, got ${actualSha}`)
  if (actualSize !== artifact.size_bytes) throw new Error(`${label} size mismatch: expected ${artifact.size_bytes}, got ${actualSize}`)
  return {...artifact, path: resolved}
}

function readProducerManifest(filePath: string): ProducerManifest {
  const root = mapping(readJson(filePath, 'dogeos-core real-proving artifact manifest'), 'producer manifest')
  const artifacts = mapping(root.artifacts, 'producer manifest.artifacts')
  const producer = mapping(root.producer, 'producer manifest.producer')
  const toolchain = mapping(root.toolchain, 'producer manifest.toolchain')
  return {
    artifacts: {
      batch_openvm_toml: parseProducerArtifact(artifacts.batch_openvm_toml, 'producer manifest.artifacts.batch_openvm_toml'),
      batch_vmexe: parseProducerArtifact(artifacts.batch_vmexe, 'producer manifest.artifacts.batch_vmexe'),
      chunk_openvm_toml: parseProducerArtifact(artifacts.chunk_openvm_toml, 'producer manifest.artifacts.chunk_openvm_toml'),
      chunk_vmexe: parseProducerArtifact(artifacts.chunk_vmexe, 'producer manifest.artifacts.chunk_vmexe'),
      root_agg_verifying_key: parseProducerArtifact(artifacts.root_agg_verifying_key, 'producer manifest.artifacts.root_agg_verifying_key'),
    },
    dogeos_core_commit: requiredString(root.dogeos_core_commit, 'producer manifest.dogeos_core_commit'),
    producer: {commit: requiredString(producer.commit, 'producer manifest.producer.commit')},
    toolchain: {
      openvm_tag: requiredString(toolchain.openvm_tag, 'producer manifest.toolchain.openvm_tag'),
      rust: requiredString(toolchain.rust, 'producer manifest.toolchain.rust'),
    },
  }
}

export function parseProofIdentityEnv(body: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [index, raw] of body.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^export ([\dA-Z_]+)=(0x[\da-f]+)$/.exec(line)
    if (!match) throw new Error(`identity env line ${index + 1} is not an allowed export assignment`)
    const [, name, value] = match
    if (!IDENTITY_ENV_FIELDS.has(name)) throw new Error(`identity env line ${index + 1} contains unsupported field ${name}`)
    if (result[name] !== undefined) throw new Error(`identity env contains duplicate field ${name}`)
    result[name] = value
  }

  for (const name of IDENTITY_ENV_FIELDS) {
    if (result[name] === undefined) throw new Error(`identity env is missing ${name}`)
  }

  for (const name of [
    'DOGEOS_BATCH_PROGRAM_COMMITMENT_RAW',
    'DOGEOS_BATCH_SCROLL_PROGRAM_COMMITMENT_RAW',
    'DOGEOS_BATCH_AGGREGATION_PROGRAM_COMMITMENT_RAW',
    'DOGEOS_BRIDGE_APP_COMMIT_RAW',
    'DOGEOS_CHUNK_PROGRAM_COMMITMENT_RAW',
  ]) canonicalHex(result[name], 64, name)
  for (const name of [
    'DOGEOS_BATCH_PROGRAM_COMMITMENT',
    'DOGEOS_BATCH_VK_HASH',
    'DOGEOS_BRIDGE_PROGRAM_COMMITMENT',
    'DOGEOS_BRIDGE_VK_HASH',
    'DOGEOS_CHUNK_PROGRAM_COMMITMENT',
    'DOGEOS_CHUNK_VK_HASH',
  ]) canonicalHex(result[name], 32, name)

  return result
}

export function parseImmutableProofImage(value: string, label: string): ProofTopologyImageReference {
  const match = PINNED_IMAGE.exec(value.trim())
  if (!match) throw new Error(`${label} must use repository@sha256:<64 lowercase hex>`)
  return {digest: match[2], repository: match[1]}
}

/** Resolve a release tag once, then persist and execute only its immutable digest. */
export function resolveImmutableProofImage(value: string, label: string): ProofTopologyImageReference {
  const reference = value.trim()
  if (reference.includes('@')) return parseImmutableProofImage(reference, label)
  const slash = reference.lastIndexOf('/')
  const colon = reference.lastIndexOf(':')
  if (colon <= slash || colon === reference.length - 1 || /\s/.test(reference)) {
    throw new Error(`${label} must use repository:tag or repository@sha256:<64 lowercase hex>`)
  }

  const repository = reference.slice(0, colon)
  const result = spawnSync('docker', [
    'buildx',
    'imagetools',
    'inspect',
    reference,
    '--format',
    '{{json .Manifest}}',
  ], {encoding: 'utf8'})
  if (result.error) throw new Error(`Unable to resolve ${label} ${reference}: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`Unable to resolve ${label} ${reference}: ${(result.stderr || result.stdout).trim()}`)
  }

  let digest: unknown
  try {
    digest = (JSON.parse(result.stdout) as {digest?: unknown}).digest
  } catch {
    throw new Error(`Unable to resolve ${label} ${reference}: Docker returned malformed manifest JSON`)
  }

  return parseImmutableProofImage(`${repository}@${String(digest)}`, label)
}

export function immutableProofImage(image: ProofTopologyImageReference): string {
  const value = `${image.repository}@${image.digest}`
  parseImmutableProofImage(value, 'proof image')
  return value
}

function copyMaterial(
  deploymentDir: string,
  outputRoot: string,
  source: string,
  relative: string,
): ProofMaterialFileV1 {
  assertRegularFile(source, `proof material ${relative}`)
  const destination = path.join(outputRoot, relative)
  fs.mkdirSync(path.dirname(destination), {recursive: true})
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
  const stat = fs.statSync(destination)
  return {
    path: path.relative(deploymentDir, destination).replaceAll(path.sep, '/'),
    sha256: sha256File(destination),
    sizeBytes: stat.size,
  }
}

function writeMaterialBody(
  deploymentDir: string,
  outputRoot: string,
  body: string,
  relative: string,
  replace = false,
): ProofMaterialFileV1 {
  const destination = path.join(outputRoot, relative)
  fs.mkdirSync(path.dirname(destination), {recursive: true})
  if (replace) {
    const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
    fs.writeFileSync(temporary, body, {flag: 'wx', mode: 0o600})
    fs.renameSync(temporary, destination)
  } else {
    fs.writeFileSync(destination, body, {flag: 'wx', mode: 0o600})
  }

  const stat = fs.statSync(destination)
  return {
    path: path.relative(deploymentDir, destination).replaceAll(path.sep, '/'),
    sha256: sha256File(destination),
    sizeBytes: stat.size,
  }
}

function bridgeManifest(filePath: string): NativeBridgeManifest {
  const root = mapping(readJson(filePath, 'Bridge artifact manifest'), 'Bridge artifact manifest')
  return {
    advance_l2_batch_aggregation_app_commit_raw: canonicalHex(root.advance_l2_batch_aggregation_app_commit_raw, 64, 'Bridge manifest.advance_l2_batch_aggregation_app_commit_raw'),
    advance_l2_batch_aggregation_app_config_sha256: canonicalHex(root.advance_l2_batch_aggregation_app_config_sha256, 32, 'Bridge manifest.advance_l2_batch_aggregation_app_config_sha256'),
    advance_l2_batch_aggregation_inner_batch_app_commit_raw: canonicalHex(root.advance_l2_batch_aggregation_inner_batch_app_commit_raw, 64, 'Bridge manifest.advance_l2_batch_aggregation_inner_batch_app_commit_raw'),
    advance_l2_batch_aggregation_vmexe_sha256: canonicalHex(root.advance_l2_batch_aggregation_vmexe_sha256, 32, 'Bridge manifest.advance_l2_batch_aggregation_vmexe_sha256'),
    advance_l2_batch_aggregation_vmexe_size_bytes: requiredInteger(root.advance_l2_batch_aggregation_vmexe_size_bytes, 'Bridge manifest.advance_l2_batch_aggregation_vmexe_size_bytes'),
    advance_l2_inner_batch_app_commit_raw: canonicalHex(root.advance_l2_inner_batch_app_commit_raw, 64, 'Bridge manifest.advance_l2_inner_batch_app_commit_raw'),
    app_commit_raw: canonicalHex(root.app_commit_raw, 64, 'Bridge manifest.app_commit_raw'),
    app_config_sha256: canonicalHex(root.app_config_sha256, 32, 'Bridge manifest.app_config_sha256'),
    genesis_sequencer_outpoint_index: requiredInteger(root.genesis_sequencer_outpoint_index, 'Bridge manifest.genesis_sequencer_outpoint_index'),
    genesis_state_hash: canonicalHex(root.genesis_state_hash, 32, 'Bridge manifest.genesis_state_hash'),
    openvm_version: requiredString(root.openvm_version, 'Bridge manifest.openvm_version'),
    program_commitment_hash: canonicalHex(root.program_commitment_hash, 32, 'Bridge manifest.program_commitment_hash'),
    schema_version: requiredInteger(root.schema_version, 'Bridge manifest.schema_version'),
    verification_key_hash: canonicalHex(root.verification_key_hash, 32, 'Bridge manifest.verification_key_hash'),
    vmexe_sha256: canonicalHex(root.vmexe_sha256, 32, 'Bridge manifest.vmexe_sha256'),
    vmexe_size_bytes: requiredInteger(root.vmexe_size_bytes, 'Bridge manifest.vmexe_size_bytes'),
  }
}

function identity(
  appCommitRaw: string,
  programCommitmentHash: string,
  verificationKeyHash: string,
): ProofProgramIdentityV1 {
  return {
    appCommitRaw: canonicalHex(appCommitRaw, 64, 'proof identity appCommitRaw'),
    programCommitmentHash: canonicalHex(programCommitmentHash, 32, 'proof identity programCommitmentHash'),
    verificationKeyHash: canonicalHex(verificationKeyHash, 32, 'proof identity verificationKeyHash'),
  }
}

/** Mirrors dogeos_proof_topology::fixtures::synthetic_identities() from PR #937. */
export function syntheticMockProofIdentities(): ProofMaterialsV1['software']['identities'] {
  const raw = (character: string): string => `0x${character.repeat(128)}`
  const chunkRaw = raw('3')
  const batchRaw = raw('8')
  const bridgeRaw = raw('a')
  const l2RangeRaw = raw('7')
  const recursiveVk = `0x${'6'.repeat(64)}`
  return {
    batch: identity(batchRaw, sha256Bytes(batchRaw), `0x${'4'.repeat(64)}`),
    bridge: identity(bridgeRaw, sha256Bytes(bridgeRaw), recursiveVk),
    chunk: identity(chunkRaw, sha256Bytes(chunkRaw), `0x${'1'.repeat(64)}`),
    l2Range: identity(l2RangeRaw, sha256Bytes(l2RangeRaw), recursiveVk),
  }
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true})
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx', mode: 0o600})
}

function replacePrivateJson(filePath: string, value: unknown): void {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx', mode: 0o600})
  try {
    fs.renameSync(temporary, filePath)
  } catch (error) {
    fs.rmSync(temporary, {force: true})
    throw error
  }
}

function refreshExistingProofMaterialImages(
  options: PrepareProofMaterialsOptions,
  deploymentDir: string,
  outputRoot: string,
  receiptPath: string,
): {receipt: ProofMaterialsV1; receiptPath: string} | undefined {
  const outputRootExists = fs.existsSync(outputRoot)
  const receiptExists = fs.existsSync(receiptPath)
  if (!outputRootExists && !receiptExists) return
  if (!options.refreshExistingImages) {
    throw new Error(
      'Proof materials already exist; mock image refresh requires explicit '
      + '--compiler-image and --mock-worker-image',
    )
  }

  if (!outputRootExists || !receiptExists) {
    throw new Error('Existing proof materials are incomplete; both the material directory and receipt are required for image refresh')
  }

  if (options.generation !== 'mock' || options.identityEnv || options.bridgeArtifactDir
    || options.producerManifest || options.chunkMaterializer || options.batchMaterializer
    || options.protocolContext || options.images.productionWorker) {
    throw new Error('Existing proof materials only support an image-only refresh in generation=mock')
  }

  assertDirectory(outputRoot, 'Existing proof material directory')
  const existing = readProofMaterials(receiptPath, deploymentDir)
  const receipt: ProofMaterialsV1 = {
    ...existing,
    generatedAt: new Date().toISOString(),
    images: {
      ...existing.images,
      mockWorker: options.images.mockWorker,
      topologyCompiler: options.images.topologyCompiler,
    },
    // Image-only refresh must not replace release/deployment identity material.
    // In particular, mock Worker images intentionally carry an all-zero
    // batch_guest placeholder, while a real-materialization mock topology uses
    // the non-placeholder bundle imported during the original preparation.
    software: existing.software,
  }
  replacePrivateJson(receiptPath, receipt)
  return {receipt, receiptPath}
}

export function prepareProofMaterials(options: PrepareProofMaterialsOptions): {
  receipt: ProofMaterialsV1
  receiptPath: string
} {
  const deploymentDir = path.resolve(options.deploymentDir)
  const outputRoot = path.resolve(deploymentDir, options.outputRoot ?? DEFAULT_PROOF_MATERIALS_ROOT)
  const receiptPath = path.resolve(deploymentDir, options.outputReceipt ?? DEFAULT_PROOF_MATERIALS_RECEIPT)
  for (const image of Object.values(options.images)) {
    if (image) immutableProofImage(image)
  }

  if (options.generation === 'mock' && options.identityEnv
    && !options.workerIdentityBundle && !options.mockWorkerIdentity) {
    throw new Error(
      'Mock proving with real materialization requires --worker-identity-bundle from the matching dogeos-core bake; '
      + 'the mock Worker image carries an all-zero batch_guest placeholder',
    )
  }

  const workerIdentityPath = options.workerIdentityBundle ?? options.mockWorkerIdentity
  const mockWorkerIdentity = workerIdentityPath === undefined
    ? extractMockWorkerIdentity(options.images.mockWorker)
    : fs.readFileSync(path.resolve(workerIdentityPath), 'utf8')
  validateMockWorkerIdentity(mockWorkerIdentity, 'Worker identity bundle')

  const refreshed = refreshExistingProofMaterialImages(
    options,
    deploymentDir,
    outputRoot,
    receiptPath,
  )
  if (refreshed) return refreshed

  let env: Record<string, string> | undefined
  if (options.identityEnv) {
    env = parseProofIdentityEnv(fs.readFileSync(path.resolve(options.identityEnv), 'utf8'))
    if (options.generation === 'mock') {
      validateRealMaterializationWorkerIdentity(mockWorkerIdentity, env, 'Worker identity bundle')
    }
  } else if (options.generation === 'real') {
    throw new Error('Real proof materials require --identity-env')
  }

  let producer: ProducerManifest | undefined
  let aggregateVerifyingKey: string | undefined
  let chunkMaterializer: string | undefined
  let batchMaterializer: string | undefined
  if (options.generation === 'real') {
    if (!options.producerManifest) throw new Error('Real proof materials require --software-manifest')
    if (!options.chunkMaterializer) throw new Error('Real proof materials require --chunk-materializer')
    if (!options.batchMaterializer) throw new Error('Real proof materials require --batch-materializer')
    producer = readProducerManifest(path.resolve(options.producerManifest))
    aggregateVerifyingKey = producer.artifacts.root_agg_verifying_key.path
    chunkMaterializer = path.resolve(options.chunkMaterializer)
    batchMaterializer = path.resolve(options.batchMaterializer)
    assertRegularFile(chunkMaterializer, 'Chunk materializer')
    assertRegularFile(batchMaterializer, 'Batch materializer')
  } else if (options.bridgeArtifactDir || options.protocolContext || options.images.productionWorker) {
    throw new Error('Bridge artifacts and the production Worker image belong to generation=real; rerun with --generation real')
  } else if (env) {
    if (!options.aggregateVerifyingKey || !options.chunkMaterializer || !options.batchMaterializer) {
      throw new Error(
        'Mock proving with real materialization requires --aggregate-verifying-key, '
        + '--chunk-materializer, and --batch-materializer',
      )
    }

    aggregateVerifyingKey = path.resolve(options.aggregateVerifyingKey)
    chunkMaterializer = path.resolve(options.chunkMaterializer)
    batchMaterializer = path.resolve(options.batchMaterializer)
    assertRegularFile(aggregateVerifyingKey, 'Aggregate verifying key')
    assertRegularFile(chunkMaterializer, 'Chunk materializer')
    assertRegularFile(batchMaterializer, 'Batch materializer')
  } else if (options.aggregateVerifyingKey || options.chunkMaterializer || options.batchMaterializer) {
    throw new Error('Materializer files require --identity-env or --generation real')
  }

  fs.mkdirSync(path.dirname(outputRoot), {recursive: true})
  fs.mkdirSync(outputRoot, {mode: 0o700, recursive: false})
  try {
    const identities = env ? {
      batch: identity(env.DOGEOS_BATCH_SCROLL_PROGRAM_COMMITMENT_RAW, env.DOGEOS_BATCH_PROGRAM_COMMITMENT, env.DOGEOS_BATCH_VK_HASH),
      bridge: identity(env.DOGEOS_BRIDGE_APP_COMMIT_RAW, env.DOGEOS_BRIDGE_PROGRAM_COMMITMENT, env.DOGEOS_BRIDGE_VK_HASH),
      chunk: identity(env.DOGEOS_CHUNK_PROGRAM_COMMITMENT_RAW, env.DOGEOS_CHUNK_PROGRAM_COMMITMENT, env.DOGEOS_CHUNK_VK_HASH),
      l2Range: identity(env.DOGEOS_BATCH_AGGREGATION_PROGRAM_COMMITMENT_RAW, sha256Bytes(env.DOGEOS_BATCH_AGGREGATION_PROGRAM_COMMITMENT_RAW), env.DOGEOS_BRIDGE_VK_HASH),
    } : syntheticMockProofIdentities()

    if (!env && options.generation === 'mock') {
      const aggregation = mockWorkerAggregationIdentity(mockWorkerIdentity, 'mock Worker identity')
      identities.l2Range = {
        ...identities.l2Range,
        ...aggregation,
      }
    }

    const receipt: ProofMaterialsV1 = {
      generatedAt: new Date().toISOString(),
      images: options.images,
      schema: PROOF_MATERIALS_SCHEMA,
      schemaVersion: 1,
      software: {
        compilerIdentity: writeMaterialBody(
          deploymentDir,
          outputRoot,
          mockWorkerIdentity,
          MOCK_WORKER_IDENTITY_RELATIVE_PATH,
        ),
        identities,
        identitySource: env ? 'real_identity_probe' : 'dogeos_core_synthetic_mock_v1',
      },
    }

    if (producer && chunkMaterializer && batchMaterializer) {
      receipt.software.artifacts = {
        aggregateVerifyingKey: copyMaterial(deploymentDir, outputRoot, producer.artifacts.root_agg_verifying_key.path, 'software/verifier/root_verifier_vk'),
        batchAppConfig: copyMaterial(deploymentDir, outputRoot, producer.artifacts.batch_openvm_toml.path, 'software/batch/openvm.toml'),
        batchAppExe: copyMaterial(deploymentDir, outputRoot, producer.artifacts.batch_vmexe.path, 'software/batch/app.vmexe'),
        batchMaterializer: copyMaterial(deploymentDir, outputRoot, batchMaterializer, 'software/bin/batch-materializer'),
        chunkAppConfig: copyMaterial(deploymentDir, outputRoot, producer.artifacts.chunk_openvm_toml.path, 'software/chunk/openvm.toml'),
        chunkAppExe: copyMaterial(deploymentDir, outputRoot, producer.artifacts.chunk_vmexe.path, 'software/chunk/app.vmexe'),
        chunkMaterializer: copyMaterial(deploymentDir, outputRoot, chunkMaterializer, 'software/bin/chunk-materializer'),
      }
      receipt.software.openvmVersion = producer.toolchain.openvm_tag
      receipt.software.rustToolchain = producer.toolchain.rust
      receipt.software.sourceRevisions = {
        dogeosCore: producer.dogeos_core_commit,
        scrollZkvmProver: producer.producer.commit,
      }
    } else if (env && aggregateVerifyingKey && chunkMaterializer && batchMaterializer) {
      receipt.software.materializationArtifacts = {
        aggregateVerifyingKey: copyMaterial(
          deploymentDir,
          outputRoot,
          aggregateVerifyingKey,
          'software/verifier/root_verifier_vk',
        ),
        batchMaterializer: copyMaterial(
          deploymentDir,
          outputRoot,
          batchMaterializer,
          'software/bin/batch-materializer',
        ),
        chunkMaterializer: copyMaterial(
          deploymentDir,
          outputRoot,
          chunkMaterializer,
          'software/bin/chunk-materializer',
        ),
      }
    }

    if (options.bridgeArtifactDir) {
      if (!env) throw new Error('Bridge material requires identities from --identity-env')
      const bridgeRoot = path.resolve(options.bridgeArtifactDir)
      assertDirectory(bridgeRoot, 'Bridge artifact directory')
      const nativeManifestPath = path.join(bridgeRoot, 'bridge-artifact-manifest.json')
      const native = bridgeManifest(nativeManifestPath)
      if (native.verification_key_hash !== receipt.software.identities.l2Range.verificationKeyHash) {
        throw new Error('Bridge verification key does not match the shared L2-range recursive verification key')
      }

      if (native.advance_l2_batch_aggregation_app_commit_raw !== receipt.software.identities.l2Range.appCommitRaw) {
        throw new Error('Bridge artifact L2-range app commitment does not match the software identity probe')
      }

      if (native.advance_l2_inner_batch_app_commit_raw !== env.DOGEOS_BATCH_PROGRAM_COMMITMENT_RAW) {
        throw new Error('Bridge artifact inner Batch commitment does not match the identity probe')
      }

      if (native.advance_l2_batch_aggregation_inner_batch_app_commit_raw !== native.advance_l2_inner_batch_app_commit_raw) {
        throw new Error('Bridge artifact records inconsistent inner Batch commitments')
      }

      const protocolContext = path.resolve(options.protocolContext ?? '')
      assertRegularFile(protocolContext, 'Deployment protocol context')
      receipt.bridge = {
        artifacts: {
          appConfig: copyMaterial(deploymentDir, outputRoot, path.join(bridgeRoot, 'openvm.toml'), 'bridge/openvm.toml'),
          appExe: copyMaterial(deploymentDir, outputRoot, path.join(bridgeRoot, 'bridge-state.vmexe'), 'bridge/bridge-state.vmexe'),
          l2RangeAppConfig: copyMaterial(deploymentDir, outputRoot, path.join(bridgeRoot, 'batch-aggregation-openvm.toml'), 'bridge/batch-aggregation-openvm.toml'),
          l2RangeAppExe: copyMaterial(deploymentDir, outputRoot, path.join(bridgeRoot, 'batch-aggregation.vmexe'), 'bridge/batch-aggregation.vmexe'),
          nativeManifest: copyMaterial(deploymentDir, outputRoot, nativeManifestPath, 'bridge/bridge-artifact-manifest.json'),
        },
        genesisSequencerOutpointIndex: native.genesis_sequencer_outpoint_index,
        genesisStateHash: native.genesis_state_hash,
        identity: identity(native.app_commit_raw, native.program_commitment_hash, native.verification_key_hash),
        protocolContextPath: path.relative(deploymentDir, protocolContext).replaceAll(path.sep, '/'),
        protocolContextSha256: sha256File(protocolContext),
      }

      for (const [file, expectedSha, expectedSize] of [
        [receipt.bridge.artifacts.appExe, normalizeSha256(native.vmexe_sha256, 'Bridge vmexe sha256'), native.vmexe_size_bytes],
        [receipt.bridge.artifacts.appConfig, normalizeSha256(native.app_config_sha256, 'Bridge config sha256'), undefined],
        [receipt.bridge.artifacts.l2RangeAppExe, normalizeSha256(native.advance_l2_batch_aggregation_vmexe_sha256, 'L2-range vmexe sha256'), native.advance_l2_batch_aggregation_vmexe_size_bytes],
        [receipt.bridge.artifacts.l2RangeAppConfig, normalizeSha256(native.advance_l2_batch_aggregation_app_config_sha256, 'L2-range config sha256'), undefined],
      ] as Array<[ProofMaterialFileV1, string, number | undefined]>) {
        if (file.sha256 !== expectedSha) throw new Error(`Bridge manifest hash mismatch for ${file.path}`)
        if (expectedSize !== undefined && file.sizeBytes !== expectedSize) throw new Error(`Bridge manifest size mismatch for ${file.path}`)
      }
    }

    writePrivateJson(receiptPath, receipt)
    return {receipt, receiptPath}
  } catch (error) {
    fs.rmSync(outputRoot, {force: true, recursive: true})
    throw error
  }
}

function proofMaterialFile(value: unknown, label: string): ProofMaterialFileV1 {
  const object = mapping(value, label)
  return {
    path: requiredString(object.path, `${label}.path`),
    sha256: normalizeSha256(object.sha256, `${label}.sha256`),
    sizeBytes: requiredInteger(object.sizeBytes, `${label}.sizeBytes`),
  }
}

function proofProgramIdentity(value: unknown, label: string): ProofProgramIdentityV1 {
  const object = mapping(value, label)
  return identity(
    requiredString(object.appCommitRaw, `${label}.appCommitRaw`),
    requiredString(object.programCommitmentHash, `${label}.programCommitmentHash`),
    requiredString(object.verificationKeyHash, `${label}.verificationKeyHash`),
  )
}

function imageReference(value: unknown, label: string): ProofTopologyImageReference {
  const object = mapping(value, label)
  const image = {
    digest: requiredString(object.digest, `${label}.digest`),
    repository: requiredString(object.repository, `${label}.repository`),
  }
  immutableProofImage(image)
  return image
}

export function readProofMaterials(receiptPath: string, deploymentDir = path.dirname(path.dirname(receiptPath))): ProofMaterialsV1 {
  const root = mapping(readJson(receiptPath, 'proof material receipt'), 'proof material receipt')
  if (root.schema !== PROOF_MATERIALS_SCHEMA || root.schemaVersion !== 1) {
    throw new Error(`Unsupported proof material receipt schema in ${receiptPath}`)
  }

  const images = mapping(root.images, 'proof material receipt.images')
  const software = mapping(root.software, 'proof material receipt.software')
  const identities = mapping(software.identities, 'proof material receipt.software.identities')
  const receipt: ProofMaterialsV1 = {
    generatedAt: requiredString(root.generatedAt, 'proof material receipt.generatedAt'),
    images: {
      mockWorker: imageReference(images.mockWorker, 'proof material receipt.images.mockWorker'),
      ...(images.productionWorker === undefined ? {} : {
        productionWorker: imageReference(images.productionWorker, 'proof material receipt.images.productionWorker'),
      }),
      topologyCompiler: imageReference(images.topologyCompiler, 'proof material receipt.images.topologyCompiler'),
    },
    schema: PROOF_MATERIALS_SCHEMA,
    schemaVersion: 1,
    software: {
      ...(software.compilerIdentity === undefined ? {} : {
        compilerIdentity: proofMaterialFile(software.compilerIdentity, 'software.compilerIdentity'),
      }),
      identities: {
        batch: proofProgramIdentity(identities.batch, 'software.identities.batch'),
        bridge: proofProgramIdentity(identities.bridge, 'software.identities.bridge'),
        chunk: proofProgramIdentity(identities.chunk, 'software.identities.chunk'),
        l2Range: proofProgramIdentity(identities.l2Range, 'software.identities.l2Range'),
      },
      identitySource: requiredString(software.identitySource, 'software.identitySource') as ProofMaterialsV1['software']['identitySource'],
    },
  }
  if (!['dogeos_core_synthetic_mock_v1', 'real_identity_probe'].includes(receipt.software.identitySource)) {
    throw new Error(`Unsupported proof identity source: ${receipt.software.identitySource}`)
  }

  if (receipt.software.identitySource === 'dogeos_core_synthetic_mock_v1') {
    const expected = syntheticMockProofIdentities()
    for (const family of ['batch', 'bridge', 'chunk'] as const) {
      if (JSON.stringify(receipt.software.identities[family]) !== JSON.stringify(expected[family])) {
        throw new Error('Synthetic mock proof identities differ from the dogeos-core PR #937 fixture table')
      }
    }
  }

  if (software.artifacts !== undefined) {
    const artifacts = mapping(software.artifacts, 'proof material receipt.software.artifacts')
    const revisions = mapping(software.sourceRevisions, 'proof material receipt.software.sourceRevisions')
    receipt.software.artifacts = {
      aggregateVerifyingKey: proofMaterialFile(artifacts.aggregateVerifyingKey, 'software.artifacts.aggregateVerifyingKey'),
      batchAppConfig: proofMaterialFile(artifacts.batchAppConfig, 'software.artifacts.batchAppConfig'),
      batchAppExe: proofMaterialFile(artifacts.batchAppExe, 'software.artifacts.batchAppExe'),
      batchMaterializer: proofMaterialFile(artifacts.batchMaterializer, 'software.artifacts.batchMaterializer'),
      chunkAppConfig: proofMaterialFile(artifacts.chunkAppConfig, 'software.artifacts.chunkAppConfig'),
      chunkAppExe: proofMaterialFile(artifacts.chunkAppExe, 'software.artifacts.chunkAppExe'),
      chunkMaterializer: proofMaterialFile(artifacts.chunkMaterializer, 'software.artifacts.chunkMaterializer'),
    }
    receipt.software.openvmVersion = requiredString(software.openvmVersion, 'software.openvmVersion')
    receipt.software.rustToolchain = requiredString(software.rustToolchain, 'software.rustToolchain')
    receipt.software.sourceRevisions = {
      dogeosCore: requiredString(revisions.dogeosCore, 'software.sourceRevisions.dogeosCore'),
      scrollZkvmProver: requiredString(revisions.scrollZkvmProver, 'software.sourceRevisions.scrollZkvmProver'),
    }
  } else if (software.openvmVersion !== undefined || software.rustToolchain !== undefined || software.sourceRevisions !== undefined) {
    throw new Error('Identity-only proof material receipt must not contain incomplete real-release metadata')
  }

  if (software.materializationArtifacts !== undefined) {
    const artifacts = mapping(software.materializationArtifacts, 'proof material receipt.software.materializationArtifacts')
    receipt.software.materializationArtifacts = {
      aggregateVerifyingKey: proofMaterialFile(artifacts.aggregateVerifyingKey, 'software.materializationArtifacts.aggregateVerifyingKey'),
      batchMaterializer: proofMaterialFile(artifacts.batchMaterializer, 'software.materializationArtifacts.batchMaterializer'),
      chunkMaterializer: proofMaterialFile(artifacts.chunkMaterializer, 'software.materializationArtifacts.chunkMaterializer'),
    }
  }

  if (root.bridge !== undefined) {
    const bridge = mapping(root.bridge, 'proof material receipt.bridge')
    const bridgeArtifacts = mapping(bridge.artifacts, 'proof material receipt.bridge.artifacts')
    receipt.bridge = {
      artifacts: {
        appConfig: proofMaterialFile(bridgeArtifacts.appConfig, 'bridge.artifacts.appConfig'),
        appExe: proofMaterialFile(bridgeArtifacts.appExe, 'bridge.artifacts.appExe'),
        l2RangeAppConfig: proofMaterialFile(bridgeArtifacts.l2RangeAppConfig, 'bridge.artifacts.l2RangeAppConfig'),
        l2RangeAppExe: proofMaterialFile(bridgeArtifacts.l2RangeAppExe, 'bridge.artifacts.l2RangeAppExe'),
        nativeManifest: proofMaterialFile(bridgeArtifacts.nativeManifest, 'bridge.artifacts.nativeManifest'),
      },
      genesisSequencerOutpointIndex: requiredInteger(bridge.genesisSequencerOutpointIndex, 'bridge.genesisSequencerOutpointIndex'),
      genesisStateHash: canonicalHex(bridge.genesisStateHash, 32, 'bridge.genesisStateHash'),
      identity: proofProgramIdentity(bridge.identity, 'bridge.identity'),
      protocolContextPath: requiredString(bridge.protocolContextPath, 'bridge.protocolContextPath'),
      protocolContextSha256: normalizeSha256(bridge.protocolContextSha256, 'bridge.protocolContextSha256'),
    }
  }

  for (const file of [
    ...(receipt.software.compilerIdentity ? [receipt.software.compilerIdentity] : []),
    ...Object.values(receipt.software.artifacts ?? {}),
    ...Object.values(receipt.software.materializationArtifacts ?? {}),
    ...Object.values(receipt.bridge?.artifacts ?? {}),
  ]) {
    const resolved = path.resolve(deploymentDir, file.path)
    const relative = path.relative(deploymentDir, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Proof material path escapes deployment directory: ${file.path}`)
    assertRegularFile(resolved, `proof material ${file.path}`)
    if (sha256File(resolved) !== file.sha256 || fs.statSync(resolved).size !== file.sizeBytes) {
      throw new Error(`Proof material content drift: ${file.path}`)
    }
  }

  for (const [family, proofIdentity] of Object.entries(receipt.software.identities)) {
    if (proofIdentity.programCommitmentHash !== sha256Bytes(proofIdentity.appCommitRaw)) {
      throw new Error(`${family} program commitment hash does not match its raw app commitment`)
    }
  }

  if (receipt.bridge) {
    if (receipt.bridge.identity.verificationKeyHash !== receipt.software.identities.l2Range.verificationKeyHash) {
      throw new Error('Bridge and L2-range verification key hashes differ')
    }

    const protocol = path.resolve(deploymentDir, receipt.bridge.protocolContextPath)
    assertRegularFile(protocol, 'proof material protocol context')
    if (sha256File(protocol) !== receipt.bridge.protocolContextSha256) throw new Error('Deployment protocol context changed after Bridge bake')
  }

  return receipt
}
