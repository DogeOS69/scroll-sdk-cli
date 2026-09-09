import type {ProofMaterialsV1} from '../types/proof-materials.js'
import type {
  ProofEnforcement,
  ProofGeneration,
  ProofTopologyArtifactStoreConfig,
  ProofTopologySpec,
  ProofWorkerDeploymentBackend,
  ProofWorkerLaunch,
} from '../types/proof-topology.js'

export const DEFAULT_PROOF_KEY_PREFIX = 'proof-topology'

export function awsS3Endpoint(region: string): string {
  return region === 'us-east-1'
    ? 'https://s3.amazonaws.com'
    : `https://s3.${region}.amazonaws.com`
}

export interface ProofTopologyRuntimeInput {
  artifactKeyPrefix?: string
  blockWitnessDir?: string
  eagerMaterializer?: ProofTopologySpec['deployment']['eagerMaterializer']
  observeRealProofDeadlineMs?: number
  proofCoordinatorPublicUrl: string
  publicS3EndpointUrl?: string
  rpcWitnessUrl?: string
  witnessSource?: 'block_witness_dir' | 'rpc'
  workerDeploymentBackend?: ProofWorkerDeploymentBackend
  workerLaunch?: ProofWorkerLaunch
  workerNodeSelector?: Record<string, string>
  workerResources?: ProofTopologySpec['deployment']['workerResources']
  workerRuntimeClassName?: string
  workerSecretName?: string
  workerTolerations?: ProofTopologySpec['deployment']['workerTolerations']
}

export interface BuildProofTopologyOptions {
  artifactStore: ProofTopologyArtifactStoreConfig
  deploymentName: string
  enforcement?: ProofEnforcement
  generation?: ProofGeneration
  materials: ProofMaterialsV1
  mode?: 'active' | 'disabled'
  runtime: ProofTopologyRuntimeInput
}

function nonEmpty(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function httpUrl(value: string, label: string, workerVisible = false): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL`)
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an absolute http(s) URL without credentials, query, or fragment`)
  }

  if (workerVisible && parsed.protocol === 'http:' && !['::1', '127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error(`${label} must use HTTPS unless it is an explicit loopback tunnel`)
  }

  return value.replace(/\/$/, '')
}

function artifactStore(value: ProofTopologyArtifactStoreConfig): ProofTopologyArtifactStoreConfig {
  if (value.kind !== 's3_compatible') throw new Error('proof deployment requires an s3_compatible artifact store')
  return {
    bucket: nonEmpty(value.bucket, 'proof artifact bucket'),
    endpointUrl: httpUrl(nonEmpty(value.endpointUrl, 'proof artifact endpoint'), 'proof artifact endpoint'),
    forcePathStyle: value.forcePathStyle ?? false,
    kind: 's3_compatible',
    maxReadBodyBytes: value.maxReadBodyBytes ?? 512 * 1024 * 1024,
    region: nonEmpty(value.region, 'proof artifact region'),
  }
}

export function buildProofTopology(options: BuildProofTopologyOptions): ProofTopologySpec {
  const generation = options.generation ?? 'mock'
  const mode = options.mode ?? 'disabled'
  const {materials} = options
  // Mock proving and materialization are independent. When operators import
  // the release's real identity probe for a mock deployment, select the
  // compiler profile that keeps proof generation mock while sourcing the
  // canonical chunk segmentation and running the real materializers. Synthetic
  // identities can only support the one-chunk exact-mock development profile.
  const realMaterialization = generation === 'real'
    || materials.software.identitySource === 'real_identity_probe'
    || materials.software.identitySource === 'dogeos_core_scroll_identity_v1'
  if (generation === 'real' && materials.software.identitySource !== 'real_identity_probe') {
    throw new Error('real proof generation requires identities produced by the dogeos-core real identity probe')
  }

  if (generation === 'real' && (!materials.software.artifacts || !materials.bridge || !materials.images.productionWorker)) {
    throw new Error('real proof generation requires full software artifacts, deployment-bound Bridge material, and a production Worker image in proof-materials-v1.json')
  }

  const materializationArtifacts = materials.software.artifacts
    ?? materials.software.materializationArtifacts
  if (realMaterialization && !materializationArtifacts) {
    throw new Error(
      'real Scroll materialization requires the aggregate verifying key plus Chunk and Batch materializer binaries; '
      + 'rerun setup proof-materials with the release materialization files',
    )
  }

  const compilerIdentity = generation === 'real'
    ? materials.bridge?.artifacts.workerIdentityBundle
    : materials.software.compilerIdentity
  if (!compilerIdentity) {
    throw new Error(`${generation} proof generation requires a canonical dogeos-core worker-identity-bundle.json compiler input; rerun setup proof-materials`)
  }

  const bridgeIdentity = materials.bridge?.identity ?? materials.software.identities.bridge
  const witnessSource = options.runtime.witnessSource ?? 'rpc'
  if (realMaterialization && witnessSource === 'rpc' && !options.runtime.rpcWitnessUrl) {
    throw new Error('real proof materialization with RPC witnesses requires a witness RPC URL')
  }

  const workerLaunch = options.runtime.workerLaunch ?? (generation === 'mock' ? 'local_cpu' : 'external')
  const root = '.data/proof-materials'
  const {artifacts} = materials.software
  const realScroll = {
    ...(materializationArtifacts ? {
      aggVerifyingKeyPath: materializationArtifacts.aggregateVerifyingKey.path,
      batchMaterializerBinaryPath: materializationArtifacts.batchMaterializer.path,
      chunkMaterializerBinaryPath: materializationArtifacts.chunkMaterializer.path,
    } : {}),
    ...(artifacts ? {
      batchAppConfig: artifacts.batchAppConfig.path,
      batchAppExe: artifacts.batchAppExe.path,
      chunkAppConfig: artifacts.chunkAppConfig.path,
      chunkAppExe: artifacts.chunkAppExe.path,
    } : {}),
    batchProgramCommitmentHashHex: materials.software.identities.batch.programCommitmentHash,
    batchProgramCommitmentHex: materials.software.identities.batch.appCommitRaw,
    batchVerificationKeyHashHex: materials.software.identities.batch.verificationKeyHash,
    bridgeAppCommitRawHex: bridgeIdentity.appCommitRaw,
    bridgeProgramCommitmentHashHex: bridgeIdentity.programCommitmentHash,
    bridgeVerificationKeyHashHex: bridgeIdentity.verificationKeyHash,
    chunkBlockWitnessDir: options.runtime.blockWitnessDir,
    chunkProgramCommitmentHashHex: materials.software.identities.chunk.programCommitmentHash,
    chunkProgramCommitmentHex: materials.software.identities.chunk.appCommitRaw,
    chunkVerificationKeyHashHex: materials.software.identities.chunk.verificationKeyHash,
    chunkWitnessRpcUrl: options.runtime.rpcWitnessUrl,
    chunkWitnessSource: witnessSource,
    l2RangeAggregationAppCommitRawHex: materials.software.identities.l2Range.appCommitRaw,
    l2RangeAggregationProgramCommitmentHashHex: materials.software.identities.l2Range.programCommitmentHash,
    l2RangeAggregationVerificationKeyHashHex: materials.software.identities.l2Range.verificationKeyHash,
    resourcesRoot: root,
    workerId: `${options.deploymentName}-proof-worker-0`,
  }
  return {
    active: {
      artifactStore: artifactStore(options.artifactStore),
      profile: generation === 'real'
        ? 'real_scroll_withdrawal_full_topology'
        : realMaterialization
          ? 'withdrawal_mock_prover_real_materialize'
          : 'withdrawal_mock_prover',
      realScroll,
      workerLaunch,
    },
    compiler: {
      identityFilePath: compilerIdentity.path,
      image: materials.images.topologyCompiler,
    },
    deployment: {
      artifactKeyPrefix: nonEmpty(options.runtime.artifactKeyPrefix ?? DEFAULT_PROOF_KEY_PREFIX, 'proof artifact key prefix'),
      coordinatorId: `${options.deploymentName}-proof-coordinator`,
      eagerMaterializer: options.runtime.eagerMaterializer ?? {listenPort: 3007, startBatchHeight: 0, stateDir: '/app/data'},
      generatedMaterialsRoot: '/app/data/proof-topology',
      l2GenesisJson: '/app/genesis/genesis.json',
      ...(materials.images.productionWorker ? {productionWorkerImage: materials.images.productionWorker} : {}),
      proofWorkBind: '0.0.0.0:9300',
      proofWorkPublicUrl: 'http://withdrawal-processor:9300',
      proofWorkTokenFile: '/app/secrets/proof-work-token',
      protocolContextPath: '/app/protocol_context.json',
      proverBind: '0.0.0.0:7788',
      proverPublicUrl: httpUrl(options.runtime.proofCoordinatorPublicUrl, 'Proof Coordinator URL', true),
      publicS3EndpointUrl: options.runtime.publicS3EndpointUrl
        ? httpUrl(options.runtime.publicS3EndpointUrl, 'external artifact endpoint')
        : undefined,
      readinessEvidencePath: '/run/dogeos/prover-worker-ready-v1.json',
      resourcesMountPath: '/app/data/proof-materials',
      workerDeploymentBackend: options.runtime.workerDeploymentBackend ?? 'docker_compose',
      workerNodeSelector: options.runtime.workerNodeSelector,
      workerResources: options.runtime.workerResources,
      workerRuntimeClassName: options.runtime.workerRuntimeClassName,
      workerSecretName: options.runtime.workerSecretName,
      workerTokenFile: '/app/secrets/prover-worker-token',
      workerTolerations: options.runtime.workerTolerations,
    },
    enforcement: options.enforcement ?? 'observe',
    generation,
    mode,
    observeRealProofDeadlineMs: options.runtime.observeRealProofDeadlineMs,
  }
}
