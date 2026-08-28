import * as fs from 'node:fs'
import * as path from 'node:path'

import type {ProofReleaseV1} from '../types/proof-release.js'
import type {
  ProofTopologyArtifactStoreConfig,
  ProofTopologyDeploymentConfig,
  ProofTopologyRealScrollConfig,
  ProofTopologySpec,
} from '../types/proof-topology.js'
import type {ProofSystemMode} from './proof-system-mode.js'

import {verifyProofReleaseMaterials} from './proof-release.js'

export const DEFAULT_PROOF_RESOURCES_ROOT = 'proof-artifacts'
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
  release: ProofReleaseV1
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

function isClusterLocalCoordinator(value: string): boolean {
  const {hostname} = new URL(value)
  return hostname === 'proof-coordinator'
    || hostname.endsWith('.svc')
    || hostname.endsWith('.svc.cluster.local')
    || hostname.endsWith('.cluster.local')
}

function validateArtifactStore(
  store: ProofTopologyArtifactStoreConfig,
): ProofTopologyArtifactStoreConfig {
  if (store.kind !== 's3_compatible') {
    throw new Error(
      'staging a production proof topology requires an s3_compatible artifact store; '
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

function runtimeRealScroll(
  options: BuildProofTopologyOptions,
  resourcesRoot: string,
): ProofTopologyRealScrollConfig {
  const {defaults, files, identities} = options.release.realScroll
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
    aggVerifyingKeyPath: files.aggVerifyingKey.path,
    batchAppConfig: files.batchAppConfig.path,
    batchAppExe: files.batchAppExe.path,
    batchBackendProfile: defaults.batchBackendProfile,
    batchMaterializerBinaryPath: files.batchMaterializerBinary.path,
    ...(defaults.batchProverRequirements
      ? {batchProverRequirements: defaults.batchProverRequirements}
      : {}),
    ...identities,
    chunkAppConfig: files.chunkAppConfig.path,
    chunkAppExe: files.chunkAppExe.path,
    chunkBackendProfile: defaults.chunkBackendProfile,
    ...(chunkBlockWitnessDir ? {chunkBlockWitnessDir} : {}),
    chunkMaterializerBinaryPath: files.chunkMaterializerBinary.path,
    ...(defaults.chunkProverRequirements
      ? {chunkProverRequirements: defaults.chunkProverRequirements}
      : {}),
    ...(chunkWitnessRpcUrl ? {chunkWitnessRpcUrl} : {}),
    chunkWitnessSource: witnessSource,
    resourcesRoot,
    ...(runtime.publicS3EndpointUrl
      ? {
          s3PublicEndpointUrl: validateHttpUrl(
            runtime.publicS3EndpointUrl,
            'Worker-visible S3 endpoint URL',
          ),
        }
      : {}),
    workerId: `${options.deploymentName}-proof-worker-0`,
  }
}

export function buildProofTopologyFromRelease(
  options: BuildProofTopologyOptions,
): ProofTopologySpec {
  const deploymentDir = path.resolve(options.deploymentDir || '.')
  const runtime = options.runtime || {}
  const resourcesRoot = portableRelativePath(
    deploymentDir,
    runtime.resourcesRoot || DEFAULT_PROOF_RESOURCES_ROOT,
    'proof resourcesRoot',
  )
  verifyProofReleaseMaterials(options.release, path.resolve(deploymentDir, resourcesRoot))
  const realScroll = runtimeRealScroll(options, resourcesRoot)
  const artifactStore = validateArtifactStore(options.artifactStore)
  const coordinatorUrl = runtime.proofCoordinatorPublicUrl
    ? validateHttpUrl(runtime.proofCoordinatorPublicUrl, 'proof coordinator public URL')
    : 'http://proof-coordinator:7788'
  if (
    options.productionWorkerLaunch === 'external'
    && isClusterLocalCoordinator(coordinatorUrl)
  ) {
    throw new Error(
      'external production Worker requires a proof coordinator URL reachable outside Kubernetes',
    )
  }

  const deployment: ProofTopologyDeploymentConfig = {
    artifactLocalRoot: '/app/data/proof-artifacts',
    bridgeStagedAppConfig: options.release.realScroll.files.bridgeAppConfig.path,
    bridgeStagedAppExe: options.release.realScroll.files.bridgeAppExe.path,
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
    compiler: {image: {...options.release.compilerImage}},
    deployment,
    mock: {
      artifactStore: {...artifactStore},
      profile: options.release.profiles.mock,
      ...(options.release.profiles.mock === 'withdrawal_mock_prover_real_materialize'
        ? {realScroll: {...realScroll}}
        : {}),
      workerImage: {...options.release.workerImages.mock},
    },
    mode: options.mode || 'disabled',
    production: {
      artifactStore: {...artifactStore},
      profile: options.release.profiles.production,
      realScroll: {...realScroll},
      workerImage: {...options.release.workerImages.production},
      workerLaunch: options.productionWorkerLaunch,
    },
  }
}

export function awsS3Endpoint(region: string): string {
  return `https://s3.${nonEmpty(region, 'AWS region')}.amazonaws.com`
}
