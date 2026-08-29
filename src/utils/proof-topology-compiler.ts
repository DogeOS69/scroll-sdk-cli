/* eslint-disable perfectionist/sort-objects -- Keep emitted Rust contract fields in schema order. */
import * as toml from '@iarna/toml'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {
  MockProofTopologySpec,
  ProductionProofTopologySpec,
  ProofTopologyArtifactStoreConfig,
  ProofTopologyImageReference,
  ProofTopologyRealScrollConfig,
  ProofTopologySpec,
} from '../types/proof-topology.js'
import type {ProofSystemMode} from './proof-system-mode.js'

import {readProofBridgeMaterial, readProofSoftwareRelease} from './proof-release.js'

export const PROOF_TOPOLOGY_BUNDLE_SCHEMA_VERSION = 1
export const PROOF_TOPOLOGY_CONTEXT_SCHEMA_VERSION = 1
export const PROOF_TOPOLOGY_SOURCE_SCHEMA_VERSION = 1
export const PROOF_TOPOLOGY_SIDECAR_SCHEMA_VERSION = 2
export const DEFAULT_PROOF_TOPOLOGY_OUTPUT = '.data/generated/proof-topology'
export const DEFAULT_PROOF_TOPOLOGY_RESOURCES_MOUNT = '/app/data/proof-release'

const SHA256_DIGEST = /^sha256:[\da-f]{64}$/
const PINNED_IMAGE = /^\S+@sha256:[\da-f]{64}$/

export type DurableProofRows = 'no' | 'unknown' | 'yes'
export type ProofTopologyPreflightMode = Exclude<ProofSystemMode, 'disabled'>

export interface ProofTopologyBridgeContext {
  dogecoinNetwork: string
  dogecoinRpcPassword: string
  dogecoinRpcUrl: string
  dogecoinRpcUser: string
}

export interface CompileProofTopologyOptions {
  bridge?: ProofTopologyBridgeContext
  compilerBinary?: string
  compilerImage?: string
  deploymentDir?: string
  deploymentName: string
  durableProofRows?: DurableProofRows
  ethDaSubmitterBaseConfig?: string
  ethereumL1RpcUrl?: string
  lastActiveDigest?: string
  network: string
  outputDir?: string
  preflightMode?: ProofTopologyPreflightMode
  previousBundleManifest?: string
  previousSidecar?: string
  proofCoordinatorBaseConfig?: string
  proofTopology: ProofTopologySpec
  withdrawalProcessorBaseConfig?: string
}

export interface ProofTopologyCompilerBundleManifestV1 {
  bundle_revision: string
  compiler_package_version: string
  deployment_context_schema_version: number
  eth_da_submitter?: null | string
  generated_materials?: null | string
  installable_service_configs: boolean
  preflight_only: boolean
  proof_coordinator?: null | string
  prover_worker?: null | string
  resolved_sidecar: string
  rollout_plan: string
  schema_version: number
  source_schema_version: number
  withdrawal_processor: string
}

export interface ProofTopologyRolloutPlanV1 {
  bundle_changed: boolean
  deployment_changed: boolean
  desired_services: {
    proof_coordinator: 'absent' | 'external' | 'running'
    prover_worker: 'absent' | 'external' | 'running'
    withdrawal_processor: 'absent' | 'external' | 'running'
  }
  from_bundle_revision: null | string
  from_deployment_revision: null | string
  from_digest: null | string
  from_mode: ProofSystemMode | null
  regeneration?: null | string
  requires_proof_regeneration: boolean
  schema_version: number
  submitter_config_changed: boolean
  to_bundle_revision: string
  to_deployment_revision: string
  to_digest: string
  to_mode: ProofSystemMode
}

interface ResolvedProofTopologySidecarV2 {
  deployment_revision: string
  digest: string
  schema_version: number
  selected: {
    schema_version: number
    selected_mode: ProofSystemMode
  }
}

export interface ProverWorkerContractV1 {
  argv: string[]
  capabilities: string[]
  desired_state: 'external' | 'local_deployment'
  environment: Array<{name: string; value: string}>
  expected_topology_digest: string
  image: ProofTopologyImageReference
  placement: 'external' | 'local_cpu' | 'local_cuda'
  readiness_evidence_path: string
  required_build_class: 'mock_capable' | 'production'
  schema_version: number
}

export interface ValidatedProofTopologyBundle {
  bundleDir: string
  manifest: ProofTopologyCompilerBundleManifestV1
  mode: ProofSystemMode
  plan: ProofTopologyRolloutPlanV1
  worker?: ProverWorkerContractV1
}

function nonEmpty(value: string | undefined, label: string): string {
  if (!value || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function assertImage(image: ProofTopologyImageReference, label: string): void {
  nonEmpty(image.repository, `${label}.repository`)
  if (!SHA256_DIGEST.test(image.digest)) {
    throw new Error(`${label}.digest must match sha256:[0-9a-f]{64}`)
  }
}

function imageReference(image: ProofTopologyImageReference): string {
  assertImage(image, 'proofTopology.compiler.image')
  return `${image.repository}@${image.digest}`
}

function pinnedImageReference(value: string, label: string): string {
  if (!PINNED_IMAGE.test(value)) {
    throw new Error(`${label} must match repository@sha256:<64 lowercase hex>`)
  }

  return value
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : {[key]: value}
}

function proofBucket(value: string | undefined): string {
  const bucket = nonEmpty(value, 'proofTopology artifactStore.bucket')
  if (
    bucket.length < 3
    || bucket.length > 63
    || !/^[\da-z][\d.a-z-]*[\da-z]$/.test(bucket)
    || bucket.includes('..')
  ) {
    throw new Error(
      'proofTopology artifactStore.bucket must be a 3-63 character lowercase S3 bucket name',
    )
  }

  return bucket
}

function proofKeyPrefix(value: string | undefined): string {
  const prefix = nonEmpty(value, 'proofTopology artifactStore.keyPrefix')
  if (
    prefix.startsWith('/')
    || prefix.endsWith('/')
    || prefix.split('/').some(segment => !segment || segment === '.' || segment === '..')
    || [...prefix].some(character =>
      character === '\\'
      || character === '?'
      || character === '#'
      || /\s/u.test(character)
      || character.codePointAt(0)! < 32
      || character.codePointAt(0) === 127)
  ) {
    throw new Error(
      'proofTopology artifactStore.keyPrefix must contain safe non-empty path segments '
      + 'without whitespace, control characters, backslashes, ?, or #',
    )
  }

  return prefix
}

function artifactStoreSource(store: ProofTopologyArtifactStoreConfig): toml.JsonMap {
  if (!['local_fs', 'managed_minio', 's3_compatible'].includes(store.kind)) {
    throw new Error(`unsupported proof topology artifact store kind: ${String(store.kind)}`)
  }

  if (store.kind !== 's3_compatible') return {kind: store.kind}
  return {
    kind: store.kind,
    bucket: proofBucket(store.bucket),
    region: nonEmpty(store.region, 'proofTopology artifactStore.region'),
    key_prefix: proofKeyPrefix(store.keyPrefix),
    ...optional('endpoint_url', store.endpointUrl),
    ...optional('force_path_style', store.forcePathStyle),
    ...optional('max_read_body_bytes', store.maxReadBodyBytes),
  }
}

function relativeResourcePath(root: string, value: string, label: string): string {
  if (value.trim() === '') return ''
  if (path.isAbsolute(value)) {
    throw new Error(`${label} must be relative to resourcesRoot; absolute paths are not portable`)
  }

  const normalized = path.posix.normalize(value.replaceAll('\\', '/'))
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} must remain inside resourcesRoot`)
  }

  return path.posix.join(root, normalized)
}

function realScrollSource(
  real: Partial<ProofTopologyRealScrollConfig>,
  resourcesMountPath: string,
): toml.JsonMap {
  const resource = (value: string | undefined, label: string): string | undefined =>
    value === undefined
      ? undefined
      : relativeResourcePath(resourcesMountPath, value, `proofTopology realScroll.${label}`)
  const witnessSource = real.chunkWitnessSource || 'block_witness_dir'
  return {
    ...optional('chunk_app_exe', resource(real.chunkAppExe, 'chunkAppExe')),
    ...optional('chunk_app_config', resource(real.chunkAppConfig, 'chunkAppConfig')),
    ...optional('batch_app_exe', resource(real.batchAppExe, 'batchAppExe')),
    ...optional('batch_app_config', resource(real.batchAppConfig, 'batchAppConfig')),
    ...optional(
      'agg_verifying_key_path',
      resource(real.aggVerifyingKeyPath, 'aggVerifyingKeyPath'),
    ),
    ...optional('chunk_materializer_binary_path', resource(
      real.chunkMaterializerBinaryPath,
      'chunkMaterializerBinaryPath',
    )),
    ...optional('batch_materializer_binary_path', resource(
      real.batchMaterializerBinaryPath,
      'batchMaterializerBinaryPath',
    )),
    chunk_witness_source: witnessSource,
    ...optional('chunk_witness_rpc_url', real.chunkWitnessRpcUrl),
    ...optional(
      'chunk_block_witness_dir',
      witnessSource === 'rpc'
        ? undefined
        : resource(real.chunkBlockWitnessDir, 'chunkBlockWitnessDir'),
    ),
    ...optional('chunk_verification_key_hash_hex', real.chunkVerificationKeyHashHex),
    ...optional('chunk_program_commitment_hash_hex', real.chunkProgramCommitmentHashHex),
    ...optional('chunk_program_commitment_hex', real.chunkProgramCommitmentHex),
    ...optional('batch_verification_key_hash_hex', real.batchVerificationKeyHashHex),
    ...optional('batch_program_commitment_hash_hex', real.batchProgramCommitmentHashHex),
    ...optional('batch_program_commitment_hex', real.batchProgramCommitmentHex),
    ...optional('bridge_verification_key_hash_hex', real.bridgeVerificationKeyHashHex),
    ...optional('bridge_program_commitment_hash_hex', real.bridgeProgramCommitmentHashHex),
    ...optional('bridge_app_commit_raw_hex', real.bridgeAppCommitRawHex),
    ...optional(
      'l2_range_aggregation_verification_key_hash_hex',
      real.l2RangeAggregationVerificationKeyHashHex,
    ),
    ...optional(
      'l2_range_aggregation_program_commitment_hash_hex',
      real.l2RangeAggregationProgramCommitmentHashHex,
    ),
    ...optional('l2_range_aggregation_app_commit_raw_hex', real.l2RangeAggregationAppCommitRawHex),
    ...optional(
      'regtest_pinned_genesis_sequencer_outpoint',
      real.regtestPinnedGenesisSequencerOutpoint,
    ),
    ...optional('worker_id', real.workerId),
    ...optional('chunk_backend_profile', real.chunkBackendProfile),
    ...optional('batch_backend_profile', real.batchBackendProfile),
    ...optional('chunk_prover_requirements', real.chunkProverRequirements),
    ...optional('batch_prover_requirements', real.batchProverRequirements),
    ...optional('chunk_parallelism', real.chunkParallelism),
    ...optional('batch_parallelism', real.batchParallelism),
    ...optional('chunk_materializer_timeout_ms', real.chunkMaterializerTimeoutMs),
    ...optional('worker_max_body_bytes', real.workerMaxBodyBytes),
    ...optional('proof_coordinator_public_url', real.proofCoordinatorPublicUrl),
    ...optional('s3_public_endpoint_url', real.s3PublicEndpointUrl),
  }
}

function mockSource(
  mock: MockProofTopologySpec,
  resourcesMountPath: string,
): toml.JsonMap {
  return {
    ...optional('profile', mock.profile),
    ...(mock.artifactStore
      ? {artifact_store: artifactStoreSource(mock.artifactStore)}
      : {}),
    ...(mock.realScroll
      ? {real_scroll: realScrollSource(mock.realScroll, resourcesMountPath)}
      : {}),
  }
}

function productionSource(
  production: ProductionProofTopologySpec,
  resourcesMountPath: string,
): toml.JsonMap {
  return {
    ...optional('profile', production.profile),
    ...(production.artifactStore
      ? {artifact_store: artifactStoreSource(production.artifactStore)}
      : {}),
    ...optional('worker_launch', production.workerLaunch),
    ...(production.realScroll
      ? {real_scroll: realScrollSource(production.realScroll, resourcesMountPath)}
      : {}),
  }
}

export function renderProofTopologySource(
  proofTopology: ProofTopologySpec,
  options: {resourcesMountPath?: string} = {},
): string {
  const resourcesMountPath = options.resourcesMountPath
    || proofTopology.deployment?.resourcesMountPath
    || DEFAULT_PROOF_TOPOLOGY_RESOURCES_MOUNT
  if (!path.posix.isAbsolute(resourcesMountPath)) {
    throw new Error('proofTopology.deployment.resourcesMountPath must be an absolute POSIX path')
  }

  const proof: toml.JsonMap = {
    mode: proofTopology.mode,
    ...(proofTopology.mock
      ? {mock: mockSource(proofTopology.mock, resourcesMountPath)}
      : {}),
    ...(proofTopology.production
      ? {production: productionSource(proofTopology.production, resourcesMountPath)}
      : {}),
    ...(proofTopology.recovery
      ? {
          recovery: {
            pre_tsuki_direct_sign_max_end_batch_height:
              proofTopology.recovery.preTsukiDirectSignMaxEndBatchHeight,
          },
        }
      : {}),
  }
  return toml.stringify({
    schema_version: PROOF_TOPOLOGY_SOURCE_SCHEMA_VERSION,
    proof_topology: proof,
  } as toml.JsonMap)
}

function resolveInside(root: string, value: string, label: string): string {
  const resolved = path.resolve(root, value)
  const relative = path.relative(root, resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside deployment directory ${root}`)
  }

  return resolved
}

function selectedProfile(
  topology: ProofTopologySpec,
  mode: ProofSystemMode,
): MockProofTopologySpec | ProductionProofTopologySpec | undefined {
  return mode === 'mock' ? topology.mock : mode === 'production' ? topology.production : undefined
}

function selectedResourcesRoot(
  topology: ProofTopologySpec,
  mode: ProofSystemMode,
  deploymentDir: string,
): string | undefined {
  const profile = selectedProfile(topology, mode)
  const configured = mode === 'production'
    ? topology.production?.release.resourcesRoot
    : profile?.realScroll?.resourcesRoot
  if (!configured) return undefined
  const root = resolveInside(
    deploymentDir,
    configured,
    mode === 'production'
      ? 'proofTopology production.release.resourcesRoot'
      : 'proofTopology realScroll.resourcesRoot',
  )
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`proof topology resourcesRoot is not a directory: ${root}`)
  }

  return root
}

function readJson<T>(filePath: string, label: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function bundlePath(
  root: string,
  relative: unknown,
  label: string,
  expectedType: 'directory' | 'file' = 'file',
): string {
  if (typeof relative !== 'string' || relative.trim() === '' || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a non-empty bundle-relative path`)
  }

  const resolved = path.resolve(root, relative)
  const inside = path.relative(root, resolved)
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new Error(`${label} escapes compiler bundle: ${relative}`)
  }

  if (!fs.existsSync(resolved)) throw new Error(`${label} is missing from compiler bundle: ${relative}`)
  const stat = fs.lstatSync(resolved)
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${relative}`)
  if (expectedType === 'file' && !stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${relative}`)
  }

  if (expectedType === 'directory' && !stat.isDirectory()) {
    throw new Error(`${label} must be a directory: ${relative}`)
  }

  return resolved
}

function validateDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[\da-f]{64}$/.test(value)) {
    throw new Error(`${label} is not a canonical lowercase SHA-256 proof-topology digest`)
  }
}

function validateNullableDigest(value: unknown, label: string): asserts value is null | string {
  if (value !== null) validateDigest(value, label)
}

/** Recompute the core compiler's canonical revision over every bundle payload file. */
export function computeProofTopologyBundleRevision(bundleDir: string): string {
  const root = path.resolve(bundleDir)
  const files: Array<[string, string]> = []
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const filePath = path.join(directory, entry.name)
      const stat = fs.lstatSync(filePath)
      if (stat.isSymbolicLink()) {
        throw new Error(`proof topology compiler bundle must not contain symlinks: ${filePath}`)
      }

      if (stat.isDirectory()) {
        visit(filePath)
        continue
      }

      if (!stat.isFile()) {
        throw new Error(`proof topology compiler bundle contains a non-regular entry: ${filePath}`)
      }

      const relative = path.relative(root, filePath).split(path.sep).join('/')
      if (['bundle-manifest-v1.json', 'rollout-plan-v1.json'].includes(relative)) continue
      files.push([
        relative,
        createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
      ])
    }
  }

  visit(root)
  files.sort((left, right) => Buffer.compare(Buffer.from(left[0]), Buffer.from(right[0])))
  return createHash('sha256').update(JSON.stringify(files)).digest('hex')
}

export function validateProofTopologyBundle(
  bundleDir: string,
  expected: {mode: ProofSystemMode; preflightOnly: boolean},
): ValidatedProofTopologyBundle {
  const root = path.resolve(bundleDir)
  const manifestPath = path.join(root, 'bundle-manifest-v1.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`proof topology compiler did not emit bundle-manifest-v1.json in ${root}`)
  }

  const manifest = readJson<ProofTopologyCompilerBundleManifestV1>(manifestPath, manifestPath)
  if (
    manifest.schema_version !== PROOF_TOPOLOGY_BUNDLE_SCHEMA_VERSION
    || manifest.source_schema_version !== PROOF_TOPOLOGY_SOURCE_SCHEMA_VERSION
    || manifest.deployment_context_schema_version !== PROOF_TOPOLOGY_CONTEXT_SCHEMA_VERSION
  ) {
    throw new Error(`${manifestPath}: unsupported proof topology compiler schema version`)
  }

  validateDigest(manifest.bundle_revision, `${manifestPath}: bundle_revision`)
  if (
    typeof manifest.preflight_only !== 'boolean'
    || typeof manifest.installable_service_configs !== 'boolean'
  ) {
    throw new TypeError(`${manifestPath}: compiler lifecycle flags must be booleans`)
  }

  if (manifest.preflight_only !== expected.preflightOnly) {
    throw new Error(
      `${manifestPath}: preflight_only=${String(manifest.preflight_only)} does not match invocation`,
    )
  }

  if (manifest.installable_service_configs !== !expected.preflightOnly) {
    throw new Error(
      expected.preflightOnly
        ? `${manifestPath}: preflight bundle must not be installable`
        : `${manifestPath}: compiler bundle is not installable`,
    )
  }

  nonEmpty(manifest.compiler_package_version, `${manifestPath}: compiler_package_version`)
  const requiredFiles = [
    ['withdrawal_processor', manifest.withdrawal_processor],
    ['resolved_sidecar', manifest.resolved_sidecar],
    ['rollout_plan', manifest.rollout_plan],
  ] as const
  for (const [label, file] of requiredFiles) bundlePath(root, file, label)
  for (const [label, file, type] of [
    ['proof_coordinator', manifest.proof_coordinator],
    ['eth_da_submitter', manifest.eth_da_submitter],
    ['generated_materials', manifest.generated_materials, 'directory'],
    ['prover_worker', manifest.prover_worker],
  ] as const) {
    if (file) bundlePath(root, file, label, type || 'file')
  }

  if (
    manifest.resolved_sidecar !== 'resolved-v2.json'
    || manifest.rollout_plan !== 'rollout-plan-v1.json'
    || manifest.withdrawal_processor !== 'withdrawal-processor.toml'
  ) {
    throw new Error(`${manifestPath}: compiler bundle uses non-canonical contract filenames`)
  }

  const planPath = bundlePath(root, manifest.rollout_plan, 'rollout_plan')
  const plan = readJson<ProofTopologyRolloutPlanV1>(planPath, planPath)
  if (plan.schema_version !== 1 || plan.to_mode !== expected.mode) {
    throw new Error(`${planPath}: rollout target mode does not match requested ${expected.mode}`)
  }

  validateDigest(plan.to_digest, `${planPath}: to_digest`)
  validateDigest(plan.to_deployment_revision, `${planPath}: to_deployment_revision`)
  validateDigest(plan.to_bundle_revision, `${planPath}: to_bundle_revision`)
  validateNullableDigest(plan.from_digest, `${planPath}: from_digest`)
  validateNullableDigest(
    plan.from_deployment_revision,
    `${planPath}: from_deployment_revision`,
  )
  validateNullableDigest(plan.from_bundle_revision, `${planPath}: from_bundle_revision`)
  if (plan.from_mode !== null && !['disabled', 'mock', 'production'].includes(plan.from_mode)) {
    throw new Error(`${planPath}: from_mode is invalid`)
  }

  const regenerationReasons = [
    'active_digest_changed',
    'dormant_digest_changed',
    'dormant_identity_unknown_with_durable_rows',
  ]
  if (
    plan.regeneration !== null
    && (
      typeof plan.regeneration !== 'string'
      || !regenerationReasons.includes(plan.regeneration)
    )
  ) {
    throw new Error(`${planPath}: regeneration reason is invalid`)
  }

  if (plan.requires_proof_regeneration !== (plan.regeneration !== null)) {
    throw new Error(`${planPath}: regeneration reason disagrees with rollout decision`)
  }

  if (
    typeof plan.bundle_changed !== 'boolean'
    || typeof plan.deployment_changed !== 'boolean'
    || typeof plan.requires_proof_regeneration !== 'boolean'
    || typeof plan.submitter_config_changed !== 'boolean'
  ) {
    throw new TypeError(`${planPath}: rollout decision flags must be booleans`)
  }

  if (
    !plan.desired_services
    || plan.desired_services.withdrawal_processor !== 'running'
    || !['absent', 'external', 'running'].includes(plan.desired_services.proof_coordinator)
    || !['absent', 'external', 'running'].includes(plan.desired_services.prover_worker)
  ) {
    throw new Error(`${planPath}: desired_services is invalid`)
  }

  const expectedBundleChanged = plan.from_bundle_revision !== plan.to_bundle_revision
  if (plan.bundle_changed !== expectedBundleChanged) {
    throw new Error(`${planPath}: bundle_changed disagrees with bundle revisions`)
  }

  const actualBundleRevision = computeProofTopologyBundleRevision(root)
  if (
    manifest.bundle_revision !== actualBundleRevision
    || plan.to_bundle_revision !== actualBundleRevision
  ) {
    throw new Error(
      `${manifestPath}: bundle_revision does not match the rendered bundle payload`,
    )
  }

  const sidecarPath = bundlePath(root, manifest.resolved_sidecar, 'resolved_sidecar')
  const sidecar = readJson<ResolvedProofTopologySidecarV2>(sidecarPath, sidecarPath)
  if (
    sidecar.schema_version !== PROOF_TOPOLOGY_SIDECAR_SCHEMA_VERSION
    || sidecar.selected?.schema_version !== PROOF_TOPOLOGY_SIDECAR_SCHEMA_VERSION
    || sidecar.selected.selected_mode !== expected.mode
    || sidecar.digest !== plan.to_digest
    || sidecar.deployment_revision !== plan.to_deployment_revision
  ) {
    throw new Error(`${sidecarPath}: resolved sidecar disagrees with the rollout target`)
  }

  const expectedActive = expected.mode !== 'disabled'
  if (Boolean(manifest.proof_coordinator) !== expectedActive) {
    throw new Error(`${manifestPath}: proof_coordinator presence does not match mode ${expected.mode}`)
  }

  if (Boolean(manifest.prover_worker) !== expectedActive) {
    throw new Error(`${manifestPath}: prover_worker presence does not match mode ${expected.mode}`)
  }

  if (plan.desired_services.withdrawal_processor !== 'running') {
    throw new Error(`${planPath}: withdrawal_processor must remain running`)
  }

  if (expected.mode === 'disabled') {
    if (
      plan.desired_services.proof_coordinator !== 'absent'
      || plan.desired_services.prover_worker !== 'absent'
    ) {
      throw new Error(`${planPath}: disabled mode must make PC and Worker absent`)
    }

    return {bundleDir: root, manifest, mode: expected.mode, plan}
  }

  if (plan.desired_services.proof_coordinator !== 'running') {
    throw new Error(`${planPath}: active mode requires proof_coordinator running`)
  }

  const workerPath = bundlePath(root, manifest.prover_worker!, 'prover_worker')
  const worker = readJson<ProverWorkerContractV1>(workerPath, workerPath)
  if (worker.schema_version !== 1 || worker.expected_topology_digest !== plan.to_digest) {
    throw new Error(`${workerPath}: Worker contract does not bind the rollout topology digest`)
  }

  assertImage(worker.image, `${workerPath}: image`)
  if (
    !Array.isArray(worker.argv)
    || worker.argv.length === 0
    || worker.argv.some(value => typeof value !== 'string' || value === '')
  ) {
    throw new Error(`${workerPath}: argv must not be empty`)
  }

  const expectedBuildClass = expected.mode === 'mock' ? 'mock_capable' : 'production'
  if (worker.required_build_class !== expectedBuildClass) {
    throw new Error(`${workerPath}: required_build_class does not match mode ${expected.mode}`)
  }

  if (!['external', 'local_deployment'].includes(worker.desired_state)) {
    throw new Error(`${workerPath}: desired_state is invalid`)
  }

  if (!['external', 'local_cpu', 'local_cuda'].includes(worker.placement)) {
    throw new Error(`${workerPath}: placement is invalid`)
  }

  const expectedDesiredState = worker.placement === 'external' ? 'external' : 'local_deployment'
  if (worker.desired_state !== expectedDesiredState) {
    throw new Error(`${workerPath}: desired_state disagrees with placement`)
  }

  if (expected.mode === 'mock' && worker.placement !== 'local_cpu') {
    throw new Error(`${workerPath}: mock Worker placement must be local_cpu`)
  }

  if (
    !Array.isArray(worker.environment)
    || worker.environment.some(item =>
      !item
      || typeof item.name !== 'string'
      || !/^[A-Z_][\dA-Z_]*$/.test(item.name)
      || typeof item.value !== 'string')
  ) {
    throw new Error(`${workerPath}: environment is invalid`)
  }

  if (new Set(worker.environment.map(item => item.name)).size !== worker.environment.length) {
    throw new Error(`${workerPath}: environment names must be unique`)
  }

  const digestEnvironment = worker.environment.filter(
    item => item.name === 'DOGEOS_PROOF_TOPOLOGY_DIGEST',
  )
  if (
    digestEnvironment.length !== 1
    || digestEnvironment[0].value !== plan.to_digest
  ) {
    throw new Error(`${workerPath}: environment does not bind the topology digest`)
  }

  const readinessEnvironment = worker.environment.filter(
    item => item.name === 'DOGEOS_PROVER_WORKER_READY_FILE',
  )
  if (
    readinessEnvironment.length !== 1
    || readinessEnvironment[0].value !== worker.readiness_evidence_path
  ) {
    throw new Error(`${workerPath}: environment does not bind the readiness evidence path`)
  }

  const cudaEnvironment = worker.environment.filter(
    item => item.name === 'DOGEOS_REQUIRE_CUDA_PROVER',
  )
  if (
    worker.placement === 'local_cuda'
      ? cudaEnvironment.length !== 1 || cudaEnvironment[0].value !== '1'
      : cudaEnvironment.length > 0
  ) {
    throw new Error(`${workerPath}: CUDA environment does not match Worker placement`)
  }

  if (
    !Array.isArray(worker.capabilities)
    || worker.capabilities.length === 0
    || worker.capabilities.some(value => typeof value !== 'string' || value === '')
    || new Set(worker.capabilities).size !== worker.capabilities.length
  ) {
    throw new Error(`${workerPath}: capabilities must be unique non-empty strings`)
  }

  if (!path.posix.isAbsolute(worker.readiness_evidence_path)) {
    throw new Error(`${workerPath}: readiness_evidence_path must be absolute`)
  }

  const desiredWorker = worker.desired_state === 'external' ? 'external' : 'running'
  if (plan.desired_services.prover_worker !== desiredWorker) {
    throw new Error(`${workerPath}: desired state disagrees with rollout plan`)
  }

  return {bundleDir: root, manifest, mode: expected.mode, plan, worker}
}

function writePrivate(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, {mode: 0o600})
}

function copyInput(source: string, destination: string, label: string, required: boolean): boolean {
  if (!fs.existsSync(source)) {
    if (!required) return false
    throw new Error(`${label} not found: ${source}`)
  }

  if (!fs.statSync(source).isFile()) throw new Error(`${label} is not a file: ${source}`)
  fs.copyFileSync(source, destination)
  fs.chmodSync(destination, 0o600)
  return true
}

function mountedInputPath(name: string, container: boolean, inputDir: string): string {
  return container ? `/compiler-input/${name}` : path.join(inputDir, name)
}

function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase()
  const normalized = lower.startsWith('[') && lower.endsWith(']')
    ? lower.slice(1, -1)
    : lower
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function socketIsLoopback(value: string): boolean {
  const host = value.startsWith('[')
    ? value.slice(1, value.indexOf(']'))
    : value.slice(0, value.lastIndexOf(':'))
  return isLoopbackHost(host)
}

function requiresInsecureHttpAcknowledgement(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)
  } catch {
    // Leave URL diagnostics to the authoritative compiler.
    return false
  }
}

function deploymentContext(
  options: CompileProofTopologyOptions,
  input: {
    bridgePassword?: string
    container: boolean
    inputDir: string
    mode: ProofSystemMode
    proofCoordinatorBase: string
    submitterBase?: string
    withdrawalBase: string
  },
): Record<string, unknown> {
  const topology = options.proofTopology
  const deployment = topology.deployment || {}
  const selected = selectedProfile(topology, input.mode)
  const proverPublicUrl = deployment.proverPublicUrl
    || (input.mode === 'disabled' ? 'http://127.0.0.1:7788' : undefined)
  if (!proverPublicUrl) {
    throw new Error(
      'active proof topology requires proofTopology.deployment.proverPublicUrl; '
      + 'use an HTTPS URL reachable by the selected Worker (or an explicit 127.0.0.1 tunnel)',
    )
  }

  const proverWorker = {
    ...(input.mode === 'mock' && topology.mock
      ? {mock_image: topology.mock.workerImage}
      : {}),
    readiness_evidence_path:
      deployment.readinessEvidencePath || '/run/dogeos/prover-worker-ready-v1.json',
    ...(selected?.realScroll?.s3PublicEndpointUrl
      ? {public_s3_endpoint_url: selected.realScroll.s3PublicEndpointUrl}
      : {}),
  }
  return {
    schema_version: PROOF_TOPOLOGY_CONTEXT_SCHEMA_VERSION,
    network: options.network,
    protocol_context_path: deployment.protocolContextPath || '/app/protocol_context.json',
    withdrawal_processor: {
      base_config_path: mountedInputPath(input.withdrawalBase, input.container, input.inputDir),
      proof_work_bind: deployment.proofWorkBind || '0.0.0.0:9300',
      allow_insecure_http: !socketIsLoopback(
        deployment.proofWorkBind || '0.0.0.0:9300',
      ),
      proof_work_public_url:
        deployment.proofWorkPublicUrl || 'http://withdrawal-processor:9300',
    },
    proof_coordinator: {
      base_config_path: mountedInputPath(
        input.proofCoordinatorBase,
        input.container,
        input.inputDir,
      ),
      prover_bind: deployment.proverBind || '0.0.0.0:7788',
      prover_public_url: proverPublicUrl,
      coordinator_id: deployment.coordinatorId || `${options.deploymentName}-proof-coordinator`,
      allow_insecure_http: requiresInsecureHttpAcknowledgement(
        deployment.proofWorkPublicUrl || 'http://withdrawal-processor:9300',
      ),
      ...optional('ethereum_l1_rpc_url', options.ethereumL1RpcUrl),
      ...(options.bridge
        ? {
            bridge: {
              dogecoin_rpc_url: options.bridge.dogecoinRpcUrl,
              dogecoin_network: options.bridge.dogecoinNetwork,
              dogecoin_rpc_user: options.bridge.dogecoinRpcUser,
              dogecoin_rpc_password_file: mountedInputPath(
                input.bridgePassword!,
                input.container,
                input.inputDir,
              ),
            },
          }
        : {}),
    },
    generated_materials_root:
      deployment.generatedMaterialsRoot || '/app/data/proof-topology',
    artifact_local_root: deployment.artifactLocalRoot || '/app/data/proof-artifacts',
    proof_work_token_file: deployment.proofWorkTokenFile || '/app/secrets/proof-work-token',
    worker_token_file: deployment.workerTokenFile || '/app/secrets/prover-worker-token',
    prover_worker: proverWorker,
    eth_da_submitter: input.submitterBase
      ? {
          base_config_path: mountedInputPath(
            input.submitterBase,
            input.container,
            input.inputDir,
          ),
        }
      : {},
  }
}

function releaseRuntimePath(
  resourcesRoot: string,
  resourcesMount: string,
  value: string,
  label: string,
  container: boolean,
): string {
  const hostPath = resolveInside(resourcesRoot, value, label)
  if (!container) return hostPath
  const relative = path.relative(resourcesRoot, hostPath).replaceAll(path.sep, '/')
  return path.posix.join(resourcesMount, relative)
}

function compilerFailure(command: string, status: null | number, stdout: string, stderr: string): Error {
  const detail = stderr.trim() || stdout.trim()
  return new Error(
    `${command} exited with status ${String(status)}${detail ? `: ${detail}` : ''}`,
  )
}

function installBundle(stagedBundle: string, target: string): void {
  const parent = path.dirname(target)
  fs.mkdirSync(parent, {recursive: true})
  const backup = path.join(parent, `.${path.basename(target)}.previous-${process.pid}`)
  if (fs.existsSync(backup)) {
    throw new Error(`proof topology installation backup already exists: ${backup}`)
  }

  let movedPrevious = false
  try {
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup)
      movedPrevious = true
    }

    fs.renameSync(stagedBundle, target)
    if (movedPrevious) fs.rmSync(backup, {force: true, recursive: true})
  } catch (error) {
    if (!fs.existsSync(target) && movedPrevious && fs.existsSync(backup)) {
      fs.renameSync(backup, target)
    }

    throw error
  }
}

function validatePreviousBundleEvidence(sidecarPath: string, manifestPath: string): void {
  const bundleDir = path.dirname(path.resolve(manifestPath))
  if (path.basename(manifestPath) !== 'bundle-manifest-v1.json') {
    throw new Error('previousBundleManifest must point to bundle-manifest-v1.json')
  }

  const manifest = readJson<ProofTopologyCompilerBundleManifestV1>(
    manifestPath,
    'previous proof topology bundle manifest',
  )
  const manifestSidecar = bundlePath(
    bundleDir,
    manifest.resolved_sidecar,
    'previous proof topology resolved_sidecar',
  )
  if (path.resolve(sidecarPath) !== manifestSidecar) {
    throw new Error(
      'previousSidecar does not match resolved_sidecar in previousBundleManifest',
    )
  }

  const sidecar = readJson<ResolvedProofTopologySidecarV2>(
    manifestSidecar,
    'previous proof topology resolved sidecar',
  )
  const mode = sidecar.selected?.selected_mode
  if (!['disabled', 'mock', 'production'].includes(mode)) {
    throw new Error('previous proof topology sidecar selected_mode is invalid')
  }

  validateProofTopologyBundle(bundleDir, {mode, preflightOnly: false})
}

/**
 * Invoke the dogeos-core compiler and atomically install its validated bundle.
 * This function intentionally performs no Kubernetes or process lifecycle work.
 */
export function compileProofTopology(
  options: CompileProofTopologyOptions,
): ValidatedProofTopologyBundle {
  const topology = options.proofTopology
  const deploymentDir = path.resolve(options.deploymentDir || '.')
  const mode: ProofSystemMode = options.preflightMode || topology.mode
  const preflightOnly = options.preflightMode !== undefined
  const container = !options.compilerBinary
  const outputDir = resolveInside(
    deploymentDir,
    options.outputDir || DEFAULT_PROOF_TOPOLOGY_OUTPUT,
    'proof topology outputDir',
  )
  if (outputDir === deploymentDir) {
    throw new Error('proof topology outputDir must not be the deployment directory')
  }

  const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollsdk-proof-topology-input-'))
  fs.chmodSync(inputDir, 0o700)
  const outputParent = path.dirname(outputDir)
  fs.mkdirSync(outputParent, {recursive: true})
  const stagingRoot = fs.mkdtempSync(
    path.join(outputParent, '.scrollsdk-proof-topology-compile-'),
  )
  const stagedBundle = path.join(stagingRoot, 'bundle')
  try {
    const withdrawalSource = path.resolve(
      deploymentDir,
      options.withdrawalProcessorBaseConfig
      || 'withdrawal-processor/WithdrawalProcessor.toml',
    )
    const coordinatorSource = path.resolve(
      deploymentDir,
      options.proofCoordinatorBaseConfig || 'proof-coordinator/ProofCoordinator.toml',
    )
    const withdrawalName = 'withdrawal-processor-base.toml'
    const coordinatorName = 'proof-coordinator-base.toml'
    copyInput(withdrawalSource, path.join(inputDir, withdrawalName), 'Withdrawal Processor base config', true)
    copyInput(
      coordinatorSource,
      path.join(inputDir, coordinatorName),
      'Proof Coordinator base config',
      mode !== 'disabled',
    )
    if (!fs.existsSync(path.join(inputDir, coordinatorName))) {
      writePrivate(path.join(inputDir, coordinatorName), '')
    }

    let submitterName: string | undefined
    if (options.ethDaSubmitterBaseConfig) {
      submitterName = 'eth-da-submitter-base.toml'
      copyInput(
        path.resolve(deploymentDir, options.ethDaSubmitterBaseConfig),
        path.join(inputDir, submitterName),
        'eth-da-submitter base config',
        true,
      )
    }

    let bridgePasswordName: string | undefined
    if (options.bridge) {
      bridgePasswordName = 'dogecoin-rpc-password'
      writePrivate(
        path.join(inputDir, bridgePasswordName),
        `${options.bridge.dogecoinRpcPassword}\n`,
      )
    }

    const resourcesMountPath = container
      ? topology.deployment?.resourcesMountPath || DEFAULT_PROOF_TOPOLOGY_RESOURCES_MOUNT
      : selectedResourcesRoot(topology, mode, deploymentDir)
        || topology.deployment?.resourcesMountPath
        || DEFAULT_PROOF_TOPOLOGY_RESOURCES_MOUNT
    if (container) {
      const normalizedMount = path.posix.normalize(resourcesMountPath)
      if (
        !path.posix.isAbsolute(normalizedMount)
        || normalizedMount === '/'
        || normalizedMount === '/compiler-input'
        || normalizedMount.startsWith('/compiler-input/')
        || normalizedMount === '/compiler-output'
        || normalizedMount.startsWith('/compiler-output/')
      ) {
        throw new Error(
          'proofTopology.deployment.resourcesMountPath must be an absolute path outside compiler input/output mounts',
        )
      }
    }

    if (!container) {
      const selectedRoot = selectedResourcesRoot(topology, mode, deploymentDir)
      const configuredRuntimeRoot = topology.deployment?.resourcesMountPath
      if (selectedRoot && (!configuredRuntimeRoot || path.resolve(configuredRuntimeRoot) !== selectedRoot)) {
        throw new Error(
          '--compiler-binary cannot translate host proof resources into a different runtime mount; '
          + 'use the pinned compiler image or make resourcesMountPath resolve to resourcesRoot',
        )
      }
    }

    let productionReleaseArgs: string[] = []
    let productionWorkerImage: ProofTopologyImageReference | undefined
    if (mode === 'production') {
      const {production} = topology
      if (!production) {
        throw new Error('production mode requires proofTopology.production')
      }

      const resourcesRoot = selectedResourcesRoot(topology, mode, deploymentDir)!
      const softwareRoot = resolveInside(
        resourcesRoot,
        production.release.softwareRoot,
        'proofTopology.production.release.softwareRoot',
      )
      const softwareManifest = resolveInside(
        resourcesRoot,
        production.release.softwareManifest,
        'proofTopology.production.release.softwareManifest',
      )
      const bridgeRoot = resolveInside(
        resourcesRoot,
        production.release.bridgeRoot,
        'proofTopology.production.release.bridgeRoot',
      )
      const bridgeManifest = resolveInside(
        resourcesRoot,
        production.release.bridgeManifest,
        'proofTopology.production.release.bridgeManifest',
      )
      const release = readProofSoftwareRelease(softwareManifest, softwareRoot)
      if (release.release_digest !== production.release.softwareReleaseDigest) {
        throw new Error(
          'proofTopology.production.release.softwareReleaseDigest does not match its manifest',
        )
      }

      const bridge = readProofBridgeMaterial(bridgeManifest, bridgeRoot)
      if (bridge.bridge_material_digest !== production.release.bridgeMaterialDigest) {
        throw new Error(
          'proofTopology.production.release.bridgeMaterialDigest does not match its manifest',
        )
      }

      if (
        release.images.topology_compiler.repository !== topology.compiler.image.repository
        || release.images.topology_compiler.digest !== topology.compiler.image.digest
      ) {
        throw new Error(
          'production software release topology compiler image does not match proofTopology.compiler.image',
        )
      }

      productionWorkerImage = release.images.production_worker
      const protocolContextSource = resolveInside(
        deploymentDir,
        topology.deployment?.protocolContextSource || '.data/protocol_context.json',
        'proofTopology.deployment.protocolContextSource',
      )
      const protocolContextName = 'protocol_context.json'
      copyInput(
        protocolContextSource,
        path.join(inputDir, protocolContextName),
        'protocol context',
        true,
      )
      productionReleaseArgs = [
        '--software-release-manifest',
        releaseRuntimePath(
          resourcesRoot,
          resourcesMountPath,
          path.relative(resourcesRoot, softwareManifest),
          'proof software release manifest',
          container,
        ),
        '--software-release-root',
        releaseRuntimePath(
          resourcesRoot,
          resourcesMountPath,
          path.relative(resourcesRoot, softwareRoot),
          'proof software release root',
          container,
        ),
        '--bridge-material-manifest',
        releaseRuntimePath(
          resourcesRoot,
          resourcesMountPath,
          path.relative(resourcesRoot, bridgeManifest),
          'proof Bridge material manifest',
          container,
        ),
        '--bridge-material-root',
        releaseRuntimePath(
          resourcesRoot,
          resourcesMountPath,
          path.relative(resourcesRoot, bridgeRoot),
          'proof Bridge material root',
          container,
        ),
        '--protocol-context-source',
        mountedInputPath(protocolContextName, container, inputDir),
      ]
    }

    const sourcePath = path.join(inputDir, 'proof-topology.toml')
    writePrivate(sourcePath, renderProofTopologySource(topology, {resourcesMountPath}))
    const contextPath = path.join(inputDir, 'deployment-context.json')
    writePrivate(contextPath, `${JSON.stringify(deploymentContext(options, {
      bridgePassword: bridgePasswordName,
      container,
      inputDir,
      mode,
      proofCoordinatorBase: coordinatorName,
      submitterBase: submitterName,
      withdrawalBase: withdrawalName,
    }), null, 2)}\n`)

    if (
      !preflightOnly
      && Boolean(options.previousSidecar) !== Boolean(options.previousBundleManifest)
    ) {
      throw new Error(
        'previous proof topology evidence must include both previousSidecar '
        + 'and previousBundleManifest',
      )
    }

    let previousSidecarName: string | undefined
    let previousManifestName: string | undefined
    let previousSidecarCandidate: string | undefined
    let previousManifestCandidate: string | undefined
    if (!preflightOnly && options.previousSidecar && options.previousBundleManifest) {
      previousSidecarCandidate = path.resolve(deploymentDir, options.previousSidecar)
      previousManifestCandidate = path.resolve(deploymentDir, options.previousBundleManifest)
    } else if (!preflightOnly) {
      const installedManifest = path.join(outputDir, 'bundle-manifest-v1.json')
      if (fs.existsSync(installedManifest)) {
        const manifest = readJson<Partial<ProofTopologyCompilerBundleManifestV1>>(
          installedManifest,
          'installed proof topology bundle manifest',
        )
        const legacyV1 = manifest.resolved_sidecar === 'resolved-v1.json'
          && manifest.bundle_revision === undefined
        if (!legacyV1) {
          previousManifestCandidate = installedManifest
          previousSidecarCandidate = bundlePath(
            outputDir,
            manifest.resolved_sidecar,
            'installed proof topology resolved_sidecar',
          )
        }
      } else if (fs.existsSync(path.join(outputDir, 'resolved-v2.json'))) {
        throw new Error(
          `installed proof topology evidence is incomplete in ${outputDir}: `
          + 'bundle-manifest-v1.json is missing',
        )
      }
    }

    if (previousSidecarCandidate && previousManifestCandidate) {
      validatePreviousBundleEvidence(previousSidecarCandidate, previousManifestCandidate)
      previousSidecarName = 'previous-resolved-v2.json'
      copyInput(
        previousSidecarCandidate,
        path.join(inputDir, previousSidecarName),
        'previous proof topology sidecar',
        true,
      )
      previousManifestName = 'previous-bundle-manifest-v1.json'
      copyInput(
        previousManifestCandidate,
        path.join(inputDir, previousManifestName),
        'previous proof topology bundle manifest',
        true,
      )
    }

    const subcommand = preflightOnly ? 'preflight' : 'compile'
    const commonArgs = [
      subcommand,
      ...(preflightOnly ? ['--mode', mode] : []),
      '--source',
      mountedInputPath('proof-topology.toml', container, inputDir),
      '--deployment-context',
      mountedInputPath('deployment-context.json', container, inputDir),
      ...(!preflightOnly && previousSidecarName && previousManifestName
        ? [
            '--previous-sidecar',
            mountedInputPath(previousSidecarName, container, inputDir),
            '--previous-bundle-manifest',
            mountedInputPath(previousManifestName, container, inputDir),
          ]
        : []),
      ...(!preflightOnly && options.lastActiveDigest
        ? ['--last-active-digest', options.lastActiveDigest]
        : []),
      ...(preflightOnly
        ? []
        : ['--durable-proof-rows', options.durableProofRows || 'unknown']),
      ...productionReleaseArgs,
      '--output',
      container ? '/compiler-output/bundle' : stagedBundle,
    ]

    let command: string
    let args: string[]
    if (container) {
      const compilerImage = options.compilerImage
        ? pinnedImageReference(options.compilerImage, '--compiler-image')
        : imageReference(topology.compiler.image)
      const resourcesRoot = selectedResourcesRoot(topology, mode, deploymentDir)
      for (const mountValue of [inputDir, stagingRoot, resourcesRoot].filter(Boolean) as string[]) {
        if (mountValue.includes(',')) {
          throw new Error(`Docker bind-mount paths must not contain commas: ${mountValue}`)
        }
      }

      command = 'docker'
      args = [
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '128',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=64m',
        '--user',
        `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
        '--mount',
        `type=bind,src=${inputDir},dst=/compiler-input,readonly`,
        '--mount',
        `type=bind,src=${stagingRoot},dst=/compiler-output`,
        ...(resourcesRoot
          ? [
              '--mount',
              `type=bind,src=${resourcesRoot},dst=${topology.deployment?.resourcesMountPath || DEFAULT_PROOF_TOPOLOGY_RESOURCES_MOUNT},readonly`,
            ]
          : []),
        compilerImage,
        ...commonArgs,
      ]
    } else {
      command = path.resolve(options.compilerBinary!)
      args = commonArgs
    }

    const child = spawnSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: 'pipe',
    })
    if (child.error) throw child.error
    if (child.status !== 0) {
      throw compilerFailure(command, child.status, child.stdout || '', child.stderr || '')
    }

    const validated = validateProofTopologyBundle(stagedBundle, {mode, preflightOnly})
    const selected = selectedProfile(topology, mode)
    if (validated.worker && selected) {
      const expectedImage = mode === 'production'
        ? productionWorkerImage
        : topology.mock?.workerImage
      if (!expectedImage) {
        throw new Error(`selected ${mode} topology has no authoritative Worker image`)
      }

      if (
        validated.worker.image.repository !== expectedImage.repository
        || validated.worker.image.digest !== expectedImage.digest
      ) {
        throw new Error('compiler Worker image does not match the selected proof topology profile')
      }

      const expectedDesiredState = mode === 'production'
        && topology.production?.workerLaunch === 'external'
        ? 'external'
        : 'local_deployment'
      if (validated.worker.desired_state !== expectedDesiredState) {
        throw new Error('compiler Worker desired_state does not match selected workerLaunch')
      }

      const expectedPlacement = mode === 'mock'
        ? 'local_cpu'
        : topology.production?.workerLaunch
      if (validated.worker.placement !== expectedPlacement) {
        throw new Error('compiler Worker placement does not match selected workerLaunch')
      }
    }

    installBundle(stagedBundle, outputDir)
    return {...validated, bundleDir: outputDir}
  } finally {
    fs.rmSync(inputDir, {force: true, recursive: true})
    fs.rmSync(stagingRoot, {force: true, recursive: true})
  }
}
