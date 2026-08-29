import * as fs from 'node:fs'
import * as path from 'node:path'

import type {PreparedProofProductionInputs} from '../types/proof-release.js'
import type {
  ProofTopologyArtifactStoreConfig,
  ProofTopologyDeploymentConfig,
  ProofTopologyImageReference,
  ProofTopologyRealScrollConfig,
  ProofTopologySpec,
} from '../types/proof-topology.js'
import type {ProofSystemMode} from './proof-system-mode.js'

import {productionReleaseForTopology} from './proof-release.js'

export const DEFAULT_PROOF_RESOURCES_PVC = 'dogeos-proof-release'
export const DEFAULT_PROOF_KEY_PREFIX = 'proof-topology'

export interface ProofTopologyRuntimeInput {
  blockWitnessDir?: string
  proofCoordinatorPublicUrl?: string
  publicS3EndpointUrl?: string
  resourcesPersistentVolumeClaim?: string
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
  compilerImage: ProofTopologyImageReference
  deploymentDir?: string
  deploymentName: string
  mockWorkerImage: ProofTopologyImageReference
  mode?: ProofSystemMode
  production?: {
    inputs: PreparedProofProductionInputs
    workerLaunch: 'external' | 'local_cpu' | 'local_cuda'
  }
  runtime?: ProofTopologyRuntimeInput
}

function nonEmpty(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
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

function validateImage(
  image: ProofTopologyImageReference,
  label: string,
): ProofTopologyImageReference {
  if (!image.repository?.trim()) throw new Error(`${label}.repository must not be empty`)
  if (!/^sha256:[\da-f]{64}$/.test(image.digest)) {
    throw new Error(`${label}.digest must match sha256:[0-9a-f]{64}`)
  }

  return {...image}
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

function productionRealScroll(
  options: BuildProofTopologyOptions,
): ProofTopologyRealScrollConfig {
  const runtime = options.runtime || {}
  const witnessSource = runtime.witnessSource || 'rpc'
  const real: ProofTopologyRealScrollConfig = {
    chunkWitnessSource: witnessSource,
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
  if (witnessSource === 'rpc') {
    real.chunkWitnessRpcUrl = validateHttpUrl(
      nonEmpty(runtime.rpcWitnessUrl, 'proof RPC witness URL'),
      'proof RPC witness URL',
    )
  } else {
    const {resourcesRoot} = options.production!.inputs
    const witness = path.resolve(resourcesRoot, runtime.blockWitnessDir || 'witnesses')
    const relative = path.relative(resourcesRoot, witness)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('proof block witness directory must remain inside production resources root')
    }

    if (!fs.existsSync(witness) || !fs.statSync(witness).isDirectory()) {
      throw new Error(`proof block witness directory not found: ${witness}`)
    }

    real.chunkBlockWitnessDir = relative.replaceAll(path.sep, '/')
  }

  return real
}

export function buildProofTopology(options: BuildProofTopologyOptions): ProofTopologySpec {
  const runtime = options.runtime || {}
  const artifactStore = validateArtifactStore(options.artifactStore)
  const coordinatorUrl = validateWorkerVisibleUrl(
    nonEmpty(runtime.proofCoordinatorPublicUrl, 'proof coordinator public URL'),
    'proof coordinator public URL',
  )
  const mode = options.mode || 'disabled'
  if (mode === 'production' && !options.production) {
    throw new Error(
      'production mode requires prepared ProofSoftwareReleaseV1 and ProofBridgeMaterialV1 inputs',
    )
  }

  const deployment: ProofTopologyDeploymentConfig = {
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
    ...(options.production
      ? {
          resourcesMountPath: '/app/data/proof-release',
          resourcesPersistentVolumeClaim: nonEmpty(
            runtime.resourcesPersistentVolumeClaim || DEFAULT_PROOF_RESOURCES_PVC,
            'proof resources PVC',
          ),
        }
      : {}),
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
    compiler: {image: validateImage(options.compilerImage, 'proof topology compiler image')},
    deployment,
    mock: {
      artifactStore: {...artifactStore},
      profile: 'withdrawal_mock_prover',
      workerImage: validateImage(options.mockWorkerImage, 'mock Worker image'),
    },
    mode,
    ...(options.production
      ? {
          production: {
            artifactStore: {...artifactStore},
            profile: 'real_scroll_withdrawal_full_topology' as const,
            realScroll: productionRealScroll(options),
            release: productionReleaseForTopology(
              options.production.inputs,
              options.deploymentDir || '.',
            ),
            workerLaunch: options.production.workerLaunch,
          },
        }
      : {}),
  }
}

export function awsS3Endpoint(region: string): string {
  return `https://s3.${nonEmpty(region, 'AWS region')}.amazonaws.com`
}
