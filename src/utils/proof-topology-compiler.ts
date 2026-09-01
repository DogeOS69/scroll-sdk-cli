import * as toml from '@iarna/toml'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {
  ProofGeneration,
  ProofTopologyImageReference,
  ProofTopologyRealScrollConfig,
  ProofTopologySpec,
} from '../types/proof-topology.js'

import {buildS3PublicBaseUrl} from './s3-archive.js'

export const DEFAULT_PROOF_TOPOLOGY_OUTPUT = '.data/generated/proof-topology'

export type ProofTopologyPreflightMode = ProofGeneration

export interface ProofTopologyBridgeContext {
  dogecoinNetwork: string
  dogecoinRpcPassword: string
  dogecoinRpcUrl: string
  dogecoinRpcUser: string
}

export interface ProofTopologyEthereumDaBlobSource {
  awsS3?: {
    keyPrefix?: string
    url: string
  }
  beaconNodeUrl: string
  timeoutMs?: number
}

interface EthereumDaBlobSourceInput {
  beaconRpcUrl?: unknown
  blobArchive?: {
    s3?: {
      bucket?: unknown
      enabled?: unknown
      keyPrefix?: unknown
      publicBaseUrl?: unknown
      region?: unknown
    }
  }
}

function configuredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function configuredBoolean(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true')
}

/**
 * Convert deployment-owned Ethereum DA facts into the provider projection
 * consumed by Proof Coordinator materializers. These URLs describe the
 * deployment and deliberately do not belong to the proof identity source.
 */
export function proofTopologyEthereumDaBlobSource(
  ethereumDa: EthereumDaBlobSourceInput | undefined,
): ProofTopologyEthereumDaBlobSource | undefined {
  const beaconNodeUrl = configuredString(ethereumDa?.beaconRpcUrl)
  if (!beaconNodeUrl) return undefined

  const s3 = ethereumDa?.blobArchive?.s3
  const publicBaseUrl = configuredBoolean(s3?.enabled)
    ? configuredString(s3?.publicBaseUrl) || buildS3PublicBaseUrl({
        bucket: configuredString(s3?.bucket),
        region: configuredString(s3?.region),
      })
    : undefined
  return {
    ...(publicBaseUrl ? {
      awsS3: {
        ...(configuredString(s3?.keyPrefix) ? {keyPrefix: configuredString(s3?.keyPrefix)} : {}),
        url: publicBaseUrl,
      },
    } : {}),
    beaconNodeUrl,
  }
}

export interface CompileProofTopologyOptions {
  bridge?: ProofTopologyBridgeContext
  compilerBinary?: string
  compilerImage?: string
  deploymentDir?: string
  deploymentName: string
  ethDaSubmitterBaseConfig?: string
  ethereumDaBlobSource?: ProofTopologyEthereumDaBlobSource
  ethereumL1RpcUrl?: string
  network: string
  outputDir?: string
  preflightMode?: ProofTopologyPreflightMode
  proofCoordinatorBaseConfig?: string
  proofTopology: ProofTopologySpec
  withdrawalProcessorBaseConfig?: string
}

export interface ProofTopologyCompilerBundleManifestV1 {
  bundle_revision: string
  compiler_package_version: string
  deployment_context_schema_version: number
  eth_da_submitter?: string
  generated_materials?: string
  installable_service_configs: boolean
  preflight_only: boolean
  proof_coordinator?: string
  prover_worker?: string
  resolved_sidecar: string
  schema_version: number
  source_schema_version: number
  withdrawal_processor: string
}

export interface ProverWorkerContractV1 {
  argv: string[]
  capabilities: string[]
  desired_state: 'external' | 'local_deployment'
  environment: Array<{name: string; value: string}>
  /** Legacy bundles used a topology digest; PR #937 contracts omit it. */
  expected_topology_digest?: string
  image: ProofTopologyImageReference
  placement: 'external' | 'local_cpu' | 'local_cuda'
  readiness_evidence_path: string
  required_build_class: 'mock_capable' | 'production'
  schema_version: number
}

export interface ResolvedProofTopologySidecarV2 {
  bundle_revision: string
  resolved: {
    enforcement: 'enforce' | 'observe'
    generation?: 'mock' | 'real'
    mode: 'disabled' | 'mock' | 'production'
    profile?: string
  }
  schema_version: number
}

export interface ValidatedProofTopologyBundle {
  bundleDir: string
  enforcement: ProofTopologySpec['enforcement']
  generation: ProofTopologySpec['generation']
  manifest: ProofTopologyCompilerBundleManifestV1
  mode: ProofTopologySpec['mode']
  sidecar: ResolvedProofTopologySidecarV2
  worker?: ProverWorkerContractV1
}

function imageReference(image: ProofTopologyImageReference): string {
  if (!image.repository?.trim() || !/^sha256:[\da-f]{64}$/.test(image.digest)) {
    throw new Error('proof compiler image must use repository@sha256:<64 lowercase hex>')
  }

  return `${image.repository}@${image.digest}`
}

function resolveInside(root: string, value: string, label: string): string {
  const resolved = path.resolve(root, value)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside the deployment directory`)
  }

  return resolved
}

function runtimePath(
  deploymentDir: string,
  value: string | undefined,
  container: boolean,
): string | undefined {
  if (!value) return undefined
  const host = resolveInside(deploymentDir, value, 'proof material path')
  if (!container) return host
  const materialRoot = path.resolve(deploymentDir, '.data/proof-materials')
  const relative = path.relative(materialRoot, host)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`proof material path must remain inside .data/proof-materials: ${value}`)
  }

  return path.posix.join('/app/data/proof-materials', relative.replaceAll(path.sep, '/'))
}

function realScrollSource(
  value: ProofTopologyRealScrollConfig,
  deploymentDir: string,
  container: boolean,
): toml.JsonMap {
  const result: toml.JsonMap = {
    batch_program_commitment_hash_hex: value.batchProgramCommitmentHashHex,
    batch_program_commitment_hex: value.batchProgramCommitmentHex,
    batch_verification_key_hash_hex: value.batchVerificationKeyHashHex,
    bridge_app_commit_raw_hex: value.bridgeAppCommitRawHex,
    bridge_program_commitment_hash_hex: value.bridgeProgramCommitmentHashHex,
    bridge_verification_key_hash_hex: value.bridgeVerificationKeyHashHex,
    chunk_program_commitment_hash_hex: value.chunkProgramCommitmentHashHex,
    chunk_program_commitment_hex: value.chunkProgramCommitmentHex,
    chunk_verification_key_hash_hex: value.chunkVerificationKeyHashHex,
    l2_range_aggregation_app_commit_raw_hex: value.l2RangeAggregationAppCommitRawHex,
    l2_range_aggregation_program_commitment_hash_hex: value.l2RangeAggregationProgramCommitmentHashHex,
    l2_range_aggregation_verification_key_hash_hex: value.l2RangeAggregationVerificationKeyHashHex,
  }
  const paths: Array<[keyof ProofTopologyRealScrollConfig, string]> = [
    ['aggVerifyingKeyPath', 'agg_verifying_key_path'],
    ['batchAppConfig', 'batch_app_config'],
    ['batchAppExe', 'batch_app_exe'],
    ['batchMaterializerBinaryPath', 'batch_materializer_binary_path'],
    ['chunkAppConfig', 'chunk_app_config'],
    ['chunkAppExe', 'chunk_app_exe'],
    ['chunkMaterializerBinaryPath', 'chunk_materializer_binary_path'],
    ['chunkBlockWitnessDir', 'chunk_block_witness_dir'],
  ]
  for (const [field, serialized] of paths) {
    const selected = value[field]
    if (typeof selected === 'string') result[serialized] = runtimePath(deploymentDir, selected, container)!
  }

  const scalar: Array<[keyof ProofTopologyRealScrollConfig, string]> = [
    ['batchBackendProfile', 'batch_backend_profile'],
    ['batchParallelism', 'batch_parallelism'],
    ['batchProverRequirements', 'batch_prover_requirements'],
    ['chunkBackendProfile', 'chunk_backend_profile'],
    ['chunkMaterializerTimeoutMs', 'chunk_materializer_timeout_ms'],
    ['chunkParallelism', 'chunk_parallelism'],
    ['chunkProverRequirements', 'chunk_prover_requirements'],
    ['chunkWitnessRpcUrl', 'chunk_witness_rpc_url'],
    ['chunkWitnessSource', 'chunk_witness_source'],
    ['regtestPinnedGenesisSequencerOutpoint', 'regtest_pinned_genesis_sequencer_outpoint'],
    ['workerId', 'worker_id'],
    ['workerMaxBodyBytes', 'worker_max_body_bytes'],
  ]
  for (const [field, serialized] of scalar) {
    const selected = value[field]
    if (selected !== undefined) result[serialized] = selected as never
  }

  return result
}

export function renderProofTopologySource(
  topology: ProofTopologySpec,
  deploymentDir = '.',
  container = false,
): string {
  const proof: toml.JsonMap = {
    enforcement: topology.enforcement,
    generation: topology.generation,
    mode: topology.mode,
  }
  if (topology.active) {
    const store: toml.JsonMap = {kind: topology.active.artifactStore.kind}
    for (const [key, value] of Object.entries({
      bucket: topology.active.artifactStore.bucket,
      endpoint_url: topology.active.artifactStore.endpointUrl,
      force_path_style: topology.active.artifactStore.forcePathStyle,
      max_read_body_bytes: topology.active.artifactStore.maxReadBodyBytes,
      region: topology.active.artifactStore.region,
    })) if (value !== undefined) store[key] = value as never
    proof.active = {
      artifact_store: store,
      profile: topology.active.profile,
      real_scroll: realScrollSource(topology.active.realScroll, path.resolve(deploymentDir), container),
      worker_launch: topology.active.workerLaunch,
    }
  }

  return toml.stringify({proof_topology: proof, schema_version: 1})
}

function readJson<T>(filePath: string, label: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch (error) {
    throw new Error(`Could not parse ${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function bundleFile(root: string, relative: string, label: string): string {
  if (path.isAbsolute(relative)) throw new Error(`${label} must be bundle-relative`)
  const resolved = path.resolve(root, relative)
  const inside = path.relative(root, resolved)
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`${label} escapes the compiler bundle`)
  const stat = fs.lstatSync(resolved)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`)
  return resolved
}

function collectBundleFiles(root: string, current = root): Array<[string, string]> {
  const result: Array<[string, string]> = []
  for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
    const full = path.join(current, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`compiler bundle contains a symlink: ${full}`)
    if (entry.isDirectory()) result.push(...collectBundleFiles(root, full))
    else if (entry.isFile()) {
      const relative = path.relative(root, full).replaceAll(path.sep, '/')
      if (!['bundle-manifest-v1.json', 'resolved-v2.json'].includes(relative)) {
        result.push([relative, createHash('sha256').update(fs.readFileSync(full)).digest('hex')])
      }
    } else throw new Error(`compiler bundle contains an unsupported entry: ${full}`)
  }

  return result.sort(([left], [right]) => left.localeCompare(right))
}

export function computeProofTopologyBundleRevision(bundleDir: string): string {
  return createHash('sha256').update(JSON.stringify(collectBundleFiles(path.resolve(bundleDir)))).digest('hex')
}

function tableAt(root: toml.JsonMap, segments: string[]): toml.JsonMap | undefined {
  let current: unknown = root
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }

  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as toml.JsonMap
    : undefined
}

function validateProviderUrl(value: string, label: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`)
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`${label} must be an absolute HTTP(S) URL`)
  }
}

function rebindProofTopologyBundleRevision(bundleDir: string): void {
  const manifestPath = path.join(bundleDir, 'bundle-manifest-v1.json')
  const manifest = readJson<ProofTopologyCompilerBundleManifestV1>(
    manifestPath,
    'proof topology bundle manifest',
  )
  const sidecarPath = bundleFile(bundleDir, manifest.resolved_sidecar, 'resolved_sidecar')
  const sidecar = readJson<ResolvedProofTopologySidecarV2>(
    sidecarPath,
    'resolved proof topology sidecar',
  )
  const revision = computeProofTopologyBundleRevision(bundleDir)
  manifest.bundle_revision = revision
  sidecar.bundle_revision = revision
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {mode: 0o600})
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, {mode: 0o600})
}

/**
 * dogeos-core v0.3.0-beta.1 renders an empty Anvil provider for every active
 * PC materializer. Anvil is valid only for dev/regtest and is mutually
 * exclusive with production providers. Until the compiler accepts DA
 * provider placement through its deployment context, replace that generated
 * provider with the deployment facts already owned by scroll-sdk-cli.
 */
export function projectProofCoordinatorEthereumDa(
  bundleDir: string,
  source: ProofTopologyEthereumDaBlobSource | undefined,
): void {
  if (!source) return
  validateProviderUrl(source.beaconNodeUrl, 'Ethereum DA beacon node URL')
  if (source.awsS3) validateProviderUrl(source.awsS3.url, 'Ethereum DA S3 archive URL')
  if (source.timeoutMs !== undefined && (!Number.isSafeInteger(source.timeoutMs) || source.timeoutMs <= 0)) {
    throw new Error('Ethereum DA blob source timeoutMs must be a positive integer')
  }

  const manifestPath = path.join(bundleDir, 'bundle-manifest-v1.json')
  const manifest = readJson<ProofTopologyCompilerBundleManifestV1>(
    manifestPath,
    'proof topology bundle manifest',
  )
  if (!manifest.proof_coordinator) return
  const coordinatorPath = bundleFile(bundleDir, manifest.proof_coordinator, 'proof_coordinator')
  const parsed = toml.parse(fs.readFileSync(coordinatorPath, 'utf8')) as toml.JsonMap
  let changed = false
  for (const ethereumDaPath of [
    ['materializer', 'bridge', 'ethereum_da'],
    ['materializer', 'scroll_batch', 'subprocess', 'ethereum_da'],
  ]) {
    const ethereumDa = tableAt(parsed, ethereumDaPath)
    if (!ethereumDa) continue
    const existing = tableAt(ethereumDa, ['blob_source']) || {}
    delete existing.anvil
    existing.timeout_ms = source.timeoutMs ?? 10_000
    existing.beacon_node = {url: source.beaconNodeUrl}
    if (source.awsS3) {
      existing.aws_s3 = {
        ...(source.awsS3.keyPrefix ? {key_prefix: source.awsS3.keyPrefix} : {}),
        url: source.awsS3.url,
      }
    } else {
      delete existing.aws_s3
    }

    ethereumDa.blob_source = existing
    changed = true
  }

  if (!changed) return
  fs.writeFileSync(coordinatorPath, toml.stringify(parsed), {mode: 0o600})
  rebindProofTopologyBundleRevision(bundleDir)
}

export function validateProofTopologyBundle(
  bundleDir: string,
  expected?: {preflightOnly?: boolean},
): ValidatedProofTopologyBundle {
  const root = path.resolve(bundleDir)
  const manifestPath = path.join(root, 'bundle-manifest-v1.json')
  const manifest = readJson<ProofTopologyCompilerBundleManifestV1>(manifestPath, 'proof topology bundle manifest')
  if (manifest.schema_version !== 1) throw new Error(`${manifestPath}: unsupported schema_version`)
  if (!/^[\da-f]{64}$/.test(manifest.bundle_revision)) throw new Error(`${manifestPath}: invalid bundle_revision`)
  if (manifest.source_schema_version !== 1 || manifest.deployment_context_schema_version !== 1) {
    throw new Error(`${manifestPath}: unsupported source/deployment context contract`)
  }

  if (expected?.preflightOnly !== undefined && manifest.preflight_only !== expected.preflightOnly) {
    throw new Error(`${manifestPath}: preflight_only does not match the requested operation`)
  }

  if (manifest.installable_service_configs === manifest.preflight_only) {
    throw new Error(`${manifestPath}: installable_service_configs is inconsistent`)
  }

  for (const [label, relative] of [
    ['resolved_sidecar', manifest.resolved_sidecar],
    ['withdrawal_processor', manifest.withdrawal_processor],
    ['proof_coordinator', manifest.proof_coordinator],
    ['prover_worker', manifest.prover_worker],
    ['eth_da_submitter', manifest.eth_da_submitter],
  ] as const) if (relative) bundleFile(root, relative, label)
  if (manifest.generated_materials) {
    const materials = path.resolve(root, manifest.generated_materials)
    if (!fs.statSync(materials).isDirectory()) throw new Error('generated_materials must be a directory')
  }

  const actualRevision = computeProofTopologyBundleRevision(root)
  if (actualRevision !== manifest.bundle_revision) {
    throw new Error(`${manifestPath}: bundle revision mismatch; expected ${manifest.bundle_revision}, got ${actualRevision}`)
  }

  const sidecarPath = bundleFile(root, manifest.resolved_sidecar, 'resolved_sidecar')
  const sidecar = readJson<ResolvedProofTopologySidecarV2>(sidecarPath, 'resolved proof topology sidecar')
  if (sidecar.schema_version !== 2 || sidecar.bundle_revision !== manifest.bundle_revision) {
    throw new Error(`${sidecarPath}: sidecar does not bind the compiler bundle revision`)
  }

  if (!['disabled', 'mock', 'production'].includes(sidecar.resolved.mode)) throw new Error(`${sidecarPath}: invalid resolved mode`)
  if (!['enforce', 'observe'].includes(sidecar.resolved.enforcement)) throw new Error(`${sidecarPath}: invalid enforcement`)
  const mode = sidecar.resolved.mode === 'disabled' ? 'disabled' : 'active'
  const generation = sidecar.resolved.mode === 'production' ? 'real' : sidecar.resolved.generation ?? 'mock'
  const active = mode === 'active'
  if (Boolean(manifest.proof_coordinator) !== active || Boolean(manifest.prover_worker) !== active) {
    throw new Error(`${manifestPath}: PC/Worker presence does not match resolved mode`)
  }

  let worker: ProverWorkerContractV1 | undefined
  if (manifest.prover_worker) {
    const workerPath = bundleFile(root, manifest.prover_worker, 'prover_worker')
    worker = readJson<ProverWorkerContractV1>(workerPath, 'prover Worker contract')
    if (worker.schema_version !== 1 || !worker.argv?.length || !worker.capabilities?.length) {
      throw new Error(`${workerPath}: invalid Worker contract`)
    }

    imageReference(worker.image)
    const expectedClass = generation === 'mock' ? 'mock_capable' : 'production'
    if (worker.required_build_class !== expectedClass) throw new Error(`${workerPath}: Worker build class disagrees with generation`)
  }

  return {
    bundleDir: root,
    enforcement: sidecar.resolved.enforcement,
    generation,
    manifest,
    mode,
    sidecar,
    worker,
  }
}

function copyInput(source: string, destination: string, label: string, required: boolean): boolean {
  if (!fs.existsSync(source)) {
    if (!required) return false
    throw new Error(`${label} not found: ${source}`)
  }

  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file: ${source}`)
  fs.copyFileSync(source, destination)
  return true
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

function socketIsLoopback(value: string): boolean {
  const host = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.slice(0, value.lastIndexOf(':'))
  return isLoopbackHost(host)
}

function urlNeedsAcknowledgement(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)
  } catch {
    return false
  }
}

function installBundle(staged: string, target: string): void {
  fs.mkdirSync(path.dirname(target), {recursive: true})
  const backup = `${target}.previous-${process.pid}`
  if (fs.existsSync(backup)) throw new Error(`proof topology backup already exists: ${backup}`)
  let moved = false
  try {
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup)
      moved = true
    }

    fs.renameSync(staged, target)
    if (moved) fs.rmSync(backup, {recursive: true})
  } catch (error) {
    if (!fs.existsSync(target) && moved) fs.renameSync(backup, target)
    throw error
  }
}

export function compileProofTopology(options: CompileProofTopologyOptions): ValidatedProofTopologyBundle {
  const deploymentDir = path.resolve(options.deploymentDir ?? '.')
  const outputDir = resolveInside(deploymentDir, options.outputDir ?? DEFAULT_PROOF_TOPOLOGY_OUTPUT, 'proof topology output')
  const container = !options.compilerBinary
  const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollsdk-proof-input-'))
  fs.mkdirSync(path.dirname(outputDir), {recursive: true})
  const stagingRoot = fs.mkdtempSync(path.join(path.dirname(outputDir), '.scrollsdk-proof-output-'))
  const stagedBundle = path.join(stagingRoot, 'bundle')
  try {
    const wpName = 'withdrawal-processor-base.toml'
    const pcName = 'proof-coordinator-base.toml'
    const submitterName = 'eth-da-submitter-base.toml'
    copyInput(path.resolve(deploymentDir, options.withdrawalProcessorBaseConfig ?? 'withdrawal-processor/WithdrawalProcessor.toml'), path.join(inputDir, wpName), 'Withdrawal Processor base config', true)
    copyInput(path.resolve(deploymentDir, options.proofCoordinatorBaseConfig ?? 'proof-coordinator/ProofCoordinator.toml'), path.join(inputDir, pcName), 'Proof Coordinator base config', true)
    const hasSubmitter = copyInput(path.resolve(deploymentDir, options.ethDaSubmitterBaseConfig ?? 'eth-da-submitter/EthDASubmitter.toml'), path.join(inputDir, submitterName), 'eth-da-submitter base config', false)
    const bridgePasswordName = 'dogecoin-rpc-password'
    if (options.bridge) fs.writeFileSync(path.join(inputDir, bridgePasswordName), options.bridge.dogecoinRpcPassword, {mode: 0o600})
    const mountedInput = (name: string): string => container ? `/input/${name}` : path.join(inputDir, name)
    const {deployment} = options.proofTopology
    const proofWorkBind = deployment.proofWorkBind ?? '0.0.0.0:9300'
    const proofWorkPublicUrl = deployment.proofWorkPublicUrl ?? 'http://withdrawal-processor:9300'
    const proverPublicUrl = deployment.proverPublicUrl ?? (options.proofTopology.mode === 'disabled' ? 'http://127.0.0.1:7788' : undefined)
    if (!proverPublicUrl) throw new Error('active proof topology requires a Worker-reachable HTTPS Proof Coordinator URL')
    const context = {
      artifact_key_prefix: deployment.artifactKeyPrefix,
      // Kubernetes proof services share one chart-owned PVC layout. The root
      // is a deployment convention, not an operator-facing topology field;
      // dogeos-core derives every runtime child directory below it.
      artifact_local_root: '/app/data/proof-artifacts',
      eth_da_submitter: hasSubmitter ? {base_config_path: mountedInput(submitterName)} : {},
      generated_materials_root: deployment.generatedMaterialsRoot ?? '/app/data/proof-topology',
      network: options.network,
      proof_coordinator: {
        allow_insecure_http: urlNeedsAcknowledgement(proofWorkPublicUrl),
        base_config_path: mountedInput(pcName),
        coordinator_id: deployment.coordinatorId ?? `${options.deploymentName}-proof-coordinator`,
        prover_bind: deployment.proverBind ?? '0.0.0.0:7788',
        prover_public_url: proverPublicUrl,
        ...(options.ethereumL1RpcUrl ? {ethereum_l1_rpc_url: options.ethereumL1RpcUrl} : {}),
        ...(options.bridge ? {bridge: {
          dogecoin_network: options.bridge.dogecoinNetwork,
          dogecoin_rpc_password_file: mountedInput(bridgePasswordName),
          dogecoin_rpc_url: options.bridge.dogecoinRpcUrl,
          dogecoin_rpc_user: options.bridge.dogecoinRpcUser,
        }} : {}),
      },
      proof_work_token_file: deployment.proofWorkTokenFile ?? '/app/secrets/proof-work-token',
      protocol_context_path: deployment.protocolContextPath ?? '/app/protocol_context.json',
      prover_worker: {
        mock_image: deployment.mockWorkerImage,
        ...(deployment.productionWorkerImage ? {production_image: deployment.productionWorkerImage} : {}),
        readiness_evidence_path: deployment.readinessEvidencePath ?? '/run/dogeos/prover-worker-ready-v1.json',
        ...(deployment.publicS3EndpointUrl ? {public_s3_endpoint_url: deployment.publicS3EndpointUrl} : {}),
        ...(options.proofTopology.active?.realScroll && options.proofTopology.generation === 'real' && options.proofTopology.active.realScroll.resourcesRoot
          ? {
              bridge_staged_app_config: runtimePath(deploymentDir, options.proofTopology.active.realScroll.resourcesRoot + '/bridge/openvm.toml', container),
              bridge_staged_app_exe: runtimePath(deploymentDir, options.proofTopology.active.realScroll.resourcesRoot + '/bridge/bridge-state.vmexe', container),
            }
          : {}),
      },
      schema_version: 1,
      withdrawal_processor: {
        allow_insecure_http: !socketIsLoopback(proofWorkBind),
        base_config_path: mountedInput(wpName),
        proof_work_bind: proofWorkBind,
        proof_work_public_url: proofWorkPublicUrl,
      },
      worker_token_file: deployment.workerTokenFile ?? '/app/secrets/prover-worker-token',
    }
    const sourcePath = path.join(inputDir, 'proof-topology.toml')
    const contextPath = path.join(inputDir, 'deployment-context.json')
    fs.writeFileSync(sourcePath, renderProofTopologySource(options.proofTopology, deploymentDir, container), {mode: 0o600})
    fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, {mode: 0o600})
    const operation = options.preflightMode ? 'preflight' : 'compile'
    const common = ['--source', mountedInput('proof-topology.toml'), '--deployment-context', mountedInput('deployment-context.json'), '--output', container ? '/output/bundle' : stagedBundle]
    const args = options.preflightMode ? [operation, '--generation', options.preflightMode, ...common] : [operation, ...common]
    const hostUser = typeof process.getuid === 'function' && typeof process.getgid === 'function'
      ? `${process.getuid()}:${process.getgid()}`
      : undefined
    const result = container
      ? spawnSync('docker', [
          'run',
          '--rm',
          ...(hostUser ? ['--user', hostUser] : []),
          '-v', `${deploymentDir}:/deployment:ro`,
          '-v', `${path.join(deploymentDir, '.data/proof-materials')}:/app/data/proof-materials:ro`,
          '-v', `${inputDir}:/input:ro`,
          '-v', `${stagingRoot}:/output`,
          options.compilerImage ?? imageReference(options.proofTopology.compiler.image),
          ...args,
        ], {encoding: 'utf8'})
      : spawnSync(path.resolve(options.compilerBinary!), args, {encoding: 'utf8'})
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`dogeos-proof-topology ${operation} failed: ${(result.stderr || result.stdout).trim()}`)
    projectProofCoordinatorEthereumDa(stagedBundle, options.ethereumDaBlobSource)
    validateProofTopologyBundle(stagedBundle, {preflightOnly: Boolean(options.preflightMode)})
    installBundle(stagedBundle, outputDir)
    return validateProofTopologyBundle(outputDir, {preflightOnly: Boolean(options.preflightMode)})
  } finally {
    fs.rmSync(inputDir, {force: true, recursive: true})
    fs.rmSync(stagingRoot, {force: true, recursive: true})
  }
}
