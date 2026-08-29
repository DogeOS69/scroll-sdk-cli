import * as fs from 'node:fs'
import * as path from 'node:path'

import type {
  PreparedProofRelease,
  PreparedProofSoftwareRelease,
} from '../types/proof-release.js'
import type {
  ProofTopologyArtifactStoreConfig,
  ProofTopologyDeploymentConfig,
  ProofTopologyRealScrollConfig,
  ProofTopologySpec,
} from '../types/proof-topology.js'
import type {ProofSystemMode} from './proof-system-mode.js'

export const DEFAULT_PROOF_RESOURCES_PVC = 'dogeos-proof-release'
export const DEFAULT_PROOF_KEY_PREFIX = 'proof-topology'

export interface ProofTopologyRuntimeInput {
  blockWitnessDir?: string
  proofCoordinatorPublicUrl?: string
  publicS3EndpointUrl?: string
  resourcesPersistentVolumeClaim?: string
  resourcesRoot?: string
  rpcWitnessUrl?: string
  witnessSource?: 'block_witness_dir' | 'rpc'
  workerNodeSelector?: Record<string, string>
  workerResources?: ProofTopologyDeploymentConfig['workerResources']
  workerRuntimeClassName?: string
  workerSecretName?: string
  workerTolerations?: ProofTopologyDeploymentConfig['workerTolerations']
}

export interface BuildProofTopologyOptions {
  artifactStore: ProofTopologyArtifactStoreConfig
  deploymentDir?: string
  deploymentName: string
  mode?: ProofSystemMode
  productionWorkerLaunch: 'external' | 'local_cpu' | 'local_cuda'
  release: PreparedProofRelease
  runtime?: ProofTopologyRuntimeInput
}

export interface BuildMockProofTopologyOptions {
  artifactStore: ProofTopologyArtifactStoreConfig
  deploymentName: string
  mode?: 'disabled' | 'mock'
  release: PreparedProofSoftwareRelease
  runtime?: ProofTopologyRuntimeInput
}

function nonEmpty(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function portableRelativePath(root: string, input: string, label: string): string {
  const resolved = path.resolve(root, input)
  const relative = path.relative(root, resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside deployment directory ${root}`)
  }

  return (relative || '.').replaceAll(path.sep, '/')
}

function validateHttpUrl(value: string, label: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL`)
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(
      `${label} must be an absolute http(s) URL without userinfo, query, or fragment`,
    )
  }

  return value.replace(/\/$/, '')
}

function validateWorkerVisibleUrl(value: string, label: string): string {
  const normalized = validateHttpUrl(value, label)
  const parsed = new URL(normalized)
  if (parsed.protocol === 'http:' && parsed.hostname !== '127.0.0.1') {
    throw new Error(
      `${label} must use HTTPS unless it is http://127.0.0.1 for an explicit loopback tunnel`,
    )
  }

  return normalized
}

function validateArtifactStore(
  store: ProofTopologyArtifactStoreConfig,
): ProofTopologyArtifactStoreConfig {
  if (store.kind !== 's3_compatible') {
    throw new Error(
      'staging a proof topology requires an s3_compatible artifact store; '
      + 'prepare AWS/S3-compatible resources before initialization',
    )
  }

  return {
    bucket: nonEmpty(store.bucket, 'proof artifact store bucket'),
    endpointUrl: validateHttpUrl(
      nonEmpty(store.endpointUrl, 'proof artifact store endpointUrl'),
      'proof artifact store endpointUrl',
    ),
    forcePathStyle: store.forcePathStyle ?? false,
    keyPrefix: nonEmpty(store.keyPrefix || DEFAULT_PROOF_KEY_PREFIX, 'proof artifact keyPrefix'),
    kind: 's3_compatible',
    maxReadBodyBytes: store.maxReadBodyBytes || 512 * 1024 * 1024,
    region: nonEmpty(store.region, 'proof artifact store region'),
  }
}

/**
 * Build a mock-only topology from an immutable software release. This path
 * intentionally has no production profile, Bridge artifact, real proving
 * identity, release PVC, or deployment lock.
 */
export function buildMockProofTopologyFromSoftwareRelease(
  options: BuildMockProofTopologyOptions,
): ProofTopologySpec {
  const runtime = options.runtime || {}
  const artifactStore = validateArtifactStore(options.artifactStore)
  const coordinatorUrl = validateWorkerVisibleUrl(
    nonEmpty(runtime.proofCoordinatorPublicUrl, 'proof coordinator public URL'),
    'proof coordinator public URL',
  )
  return {
    compiler: {image: {...options.release.release.images.topology_compiler}},
    deployment: {
      artifactLocalRoot: '/app/data/proof-artifacts',
      coordinatorId: `${options.deploymentName}-proof-coordinator`,
      generatedMaterialsRoot: '/app/data/proof-topology',
      proofWorkBind: '0.0.0.0:9300',
      proofWorkPublicUrl: 'http://withdrawal-processor:9300',
      proofWorkTokenFile: '/app/secrets/proof-work-token',
      protocolContextPath: '/app/protocol_context.json',
      protocolContextSource: '.data/protocol_context.json',
      proverBind: '0.0.0.0:7788',
      proverPublicUrl: coordinatorUrl,
      readinessEvidencePath: '/run/dogeos/prover-worker-ready-v1.json',
      ...(runtime.workerNodeSelector ? {workerNodeSelector: runtime.workerNodeSelector} : {}),
      ...(runtime.workerResources ? {workerResources: runtime.workerResources} : {}),
      ...(runtime.workerRuntimeClassName
        ? {workerRuntimeClassName: runtime.workerRuntimeClassName}
        : {}),
      ...(runtime.workerSecretName ? {workerSecretName: runtime.workerSecretName} : {}),
      workerTokenFile: '/app/secrets/prover-worker-token',
      ...(runtime.workerTolerations ? {workerTolerations: runtime.workerTolerations} : {}),
    },
    mock: {
      artifactStore: {...artifactStore},
      profile: 'withdrawal_mock_prover',
      workerImage: {...options.release.release.images.mock_worker},
    },
    mode: options.mode || 'mock',
  }
}

function runtimeRealScroll(
  options: BuildProofTopologyOptions,
  resourcesRoot: string,
): ProofTopologyRealScrollConfig {
  const {identities} = options.release.lock.projection
  const {projection} = options.release.lock
  const runtime = options.runtime || {}
  const witnessSource = runtime.witnessSource || 'block_witness_dir'
  let chunkBlockWitnessDir: string | undefined
  let chunkWitnessRpcUrl: string | undefined
  if (witnessSource === 'block_witness_dir') {
    chunkBlockWitnessDir = runtime.blockWitnessDir || 'witnesses'
    const root = path.resolve(options.deploymentDir || '.', resourcesRoot)
    const witness = path.resolve(root, chunkBlockWitnessDir)
    const inside = path.relative(root, witness)
    if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
      throw new Error('proof block witness directory must remain inside resourcesRoot')
    }

    if (!fs.existsSync(witness) || !fs.statSync(witness).isDirectory()) {
      throw new Error(
        `proof block witness directory not found: ${witness}; `
        + 'prepare it or select RPC witness input',
      )
    }
  } else {
    chunkWitnessRpcUrl = validateHttpUrl(
      nonEmpty(runtime.rpcWitnessUrl, 'proof RPC witness URL'),
      'proof RPC witness URL',
    )
  }

  return {
    aggVerifyingKeyPath: releaseRelativePath(
      options.release,
      projection.aggregate_verification_key,
      'aggregate_verification_key',
    ),
    batchAppConfig: releaseRelativePath(
      options.release,
      projection.batch_openvm_config,
      'batch_openvm_config',
    ),
    batchAppExe: releaseRelativePath(
      options.release,
      projection.batch_app_vmexe,
      'batch_app_vmexe',
    ),
    batchMaterializerBinaryPath: releaseRelativePath(
      options.release,
      projection.batch_materializer,
      'batch_materializer',
    ),
    batchProgramCommitmentHashHex: identities.batch.program_commitment_hash,
    batchProgramCommitmentHex: identities.batch.program_commitment_le_raw,
    batchVerificationKeyHashHex: identities.batch.verification_key_hash,
    bridgeAppCommitRawHex: identities.bridge.app_commit_raw,
    bridgeProgramCommitmentHashHex: identities.bridge.program_commitment_hash,
    bridgeVerificationKeyHashHex: identities.bridge.verification_key_hash,
    chunkAppConfig: releaseRelativePath(
      options.release,
      projection.chunk_openvm_config,
      'chunk_openvm_config',
    ),
    chunkAppExe: releaseRelativePath(
      options.release,
      projection.chunk_app_vmexe,
      'chunk_app_vmexe',
    ),
    ...(chunkBlockWitnessDir ? {chunkBlockWitnessDir} : {}),
    chunkMaterializerBinaryPath: releaseRelativePath(
      options.release,
      projection.chunk_materializer,
      'chunk_materializer',
    ),
    chunkProgramCommitmentHashHex: identities.chunk.program_commitment_hash,
    chunkProgramCommitmentHex: identities.chunk.program_commitment_le_raw,
    chunkVerificationKeyHashHex: identities.chunk.verification_key_hash,
    ...(chunkWitnessRpcUrl ? {chunkWitnessRpcUrl} : {}),
    chunkWitnessSource: witnessSource,
    l2RangeAggregationAppCommitRawHex: identities.l2_range.app_commit_raw,
    l2RangeAggregationProgramCommitmentHashHex: identities.l2_range.program_commitment_hash,
    l2RangeAggregationVerificationKeyHashHex: identities.l2_range.verification_key_hash,
    resourcesRoot,
    ...(runtime.publicS3EndpointUrl
      ? {
          s3PublicEndpointUrl: validateWorkerVisibleUrl(
            runtime.publicS3EndpointUrl,
            'Worker-visible S3 endpoint URL',
          ),
        }
      : {}),
    workerId: `${options.deploymentName}-proof-worker-0`,
  }
}

function releaseRelativePath(
  prepared: PreparedProofRelease,
  candidate: string,
  label: string,
): string {
  const relative = path.relative(prepared.resourcesRoot, path.resolve(candidate))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`proof release projection ${label} escapes prepared resources root`)
  }

  return relative.replaceAll(path.sep, '/')
}

export function buildProofTopologyFromRelease(
  options: BuildProofTopologyOptions,
): ProofTopologySpec {
  const deploymentDir = path.resolve(options.deploymentDir || '.')
  const runtime = options.runtime || {}
  const resourcesRoot = portableRelativePath(
    deploymentDir,
    options.release.resourcesRoot,
    'proof resourcesRoot',
  )
  if (
    runtime.resourcesRoot
    && path.resolve(deploymentDir, runtime.resourcesRoot) !== options.release.resourcesRoot
  ) {
    throw new Error('proof resourcesRoot override must match the prepared deployment release lock')
  }

  const realScroll = runtimeRealScroll(options, resourcesRoot)
  const artifactStore = validateArtifactStore(options.artifactStore)
  const coordinatorUrl = validateWorkerVisibleUrl(
    nonEmpty(runtime.proofCoordinatorPublicUrl, 'proof coordinator public URL'),
    'proof coordinator public URL',
  )

  const deployment: ProofTopologyDeploymentConfig = {
    artifactLocalRoot: '/app/data/proof-artifacts',
    bridgeStagedAppConfig: releaseRelativePath(
      options.release,
      options.release.lock.projection.bridge_openvm_config,
      'bridge_openvm_config',
    ),
    bridgeStagedAppExe: releaseRelativePath(
      options.release,
      options.release.lock.projection.bridge_app_vmexe,
      'bridge_app_vmexe',
    ),
    coordinatorId: `${options.deploymentName}-proof-coordinator`,
    generatedMaterialsRoot: '/app/data/proof-topology',
    proofWorkBind: '0.0.0.0:9300',
    proofWorkPublicUrl: 'http://withdrawal-processor:9300',
    proofWorkTokenFile: '/app/secrets/proof-work-token',
    protocolContextPath: '/app/protocol_context.json',
    protocolContextSource: '.data/protocol_context.json',
    proverBind: '0.0.0.0:7788',
    proverPublicUrl: coordinatorUrl,
    readinessEvidencePath: '/run/dogeos/prover-worker-ready-v1.json',
    resourcesMountPath: '/app/data/proof-release',
    resourcesPersistentVolumeClaim: nonEmpty(
      runtime.resourcesPersistentVolumeClaim || DEFAULT_PROOF_RESOURCES_PVC,
      'proof resources PVC',
    ),
    ...(runtime.workerNodeSelector ? {workerNodeSelector: runtime.workerNodeSelector} : {}),
    ...(runtime.workerResources ? {workerResources: runtime.workerResources} : {}),
    ...(runtime.workerRuntimeClassName
      ? {workerRuntimeClassName: runtime.workerRuntimeClassName}
      : {}),
    ...(runtime.workerSecretName ? {workerSecretName: runtime.workerSecretName} : {}),
    workerTokenFile: '/app/secrets/prover-worker-token',
    ...(runtime.workerTolerations ? {workerTolerations: runtime.workerTolerations} : {}),
  }
  return {
    compiler: {image: {...options.release.lock.projection.images.topology_compiler}},
    deployment,
    mock: {
      artifactStore: {...artifactStore},
      profile: 'withdrawal_mock_prover',
      workerImage: {...options.release.lock.projection.images.mock_worker},
    },
    mode: options.mode || 'disabled',
    production: {
      artifactStore: {...artifactStore},
      profile: 'real_scroll_withdrawal_full_topology',
      realScroll: {...realScroll},
      workerImage: {...options.release.lock.projection.images.production_worker},
      workerLaunch: options.productionWorkerLaunch,
    },
  }
}

export function awsS3Endpoint(region: string): string {
  return `https://s3.${nonEmpty(region, 'AWS region')}.amazonaws.com`
}
