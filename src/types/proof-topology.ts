import type {ProofSystemMode} from '../utils/proof-system-mode.js'

/** Digest-pinned image consumed as part of a compiler or Worker contract. */
export interface ProofTopologyImageReference {
  digest: string
  repository: string
}

export interface ProofTopologyCompilerConfig {
  /** Must be the proof-topology compiler from the same dogeos-core release as the services. */
  image: ProofTopologyImageReference
}

export interface ProofTopologyArtifactStoreConfig {
  bucket?: string
  endpointUrl?: string
  forcePathStyle?: boolean
  keyPrefix?: string
  kind: 'local_fs' | 'managed_minio' | 's3_compatible'
  maxReadBodyBytes?: number
  region?: string
}

/**
 * Real Scroll material and identity input owned by the release producer.
 * File/directory fields are deployment-relative beneath `resourcesRoot` and
 * are compiled at the stable runtime mount selected by `resourcesMountPath`.
 */
export interface ProofTopologyRealScrollConfig {
  aggVerifyingKeyPath?: string
  batchAppConfig?: string
  batchAppExe?: string
  batchBackendProfile?: string
  batchMaterializerBinaryPath?: string
  batchParallelism?: number
  batchProgramCommitmentHashHex?: string
  batchProgramCommitmentHex?: string
  batchProverRequirements?: string
  batchVerificationKeyHashHex?: string
  bridgeAppCommitRawHex?: string
  bridgeProgramCommitmentHashHex?: string
  bridgeVerificationKeyHashHex?: string
  chunkAppConfig?: string
  chunkAppExe?: string
  chunkBackendProfile?: string
  chunkBlockWitnessDir?: string
  chunkMaterializerBinaryPath?: string
  chunkMaterializerTimeoutMs?: number
  chunkParallelism?: number
  chunkProgramCommitmentHashHex?: string
  chunkProgramCommitmentHex?: string
  chunkProverRequirements?: string
  chunkVerificationKeyHashHex?: string
  chunkWitnessRpcUrl?: string
  chunkWitnessSource?: 'block_witness_dir' | 'rpc'
  l2RangeAggregationAppCommitRawHex?: string
  l2RangeAggregationProgramCommitmentHashHex?: string
  l2RangeAggregationVerificationKeyHashHex?: string
  proofCoordinatorPublicUrl?: string
  regtestPinnedGenesisSequencerOutpoint?: string
  /** Host path containing all selected release material. */
  resourcesRoot?: string
  s3PublicEndpointUrl?: string
  workerId?: string
  workerMaxBodyBytes?: number
}

export interface MockProofTopologySpec {
  artifactStore: ProofTopologyArtifactStoreConfig
  profile:
    | 'withdrawal_mock_prover'
    | 'withdrawal_mock_prover_real_materialize'
  realScroll?: ProofTopologyRealScrollConfig
  workerImage: ProofTopologyImageReference
}

export interface ProductionProofTopologySpec {
  artifactStore: ProofTopologyArtifactStoreConfig
  profile:
    | 'real_scroll_prover'
    | 'real_scroll_withdrawal'
    | 'real_scroll_withdrawal_full_topology'
  realScroll: ProofTopologyRealScrollConfig
  release: {
    bridgeManifest: string
    bridgeMaterialDigest: string
    bridgeRoot: string
    resourcesRoot: string
    softwareManifest: string
    softwareReleaseDigest: string
    softwareRoot: string
  }
  workerLaunch: 'external' | 'local_cpu' | 'local_cuda'
}

export interface ProofTopologyDeploymentConfig {
  artifactLocalRoot?: string
  coordinatorId?: string
  generatedMaterialsRoot?: string
  proofWorkBind?: string
  proofWorkPublicUrl?: string
  proofWorkTokenFile?: string
  protocolContextPath?: string
  /** Deployment-relative protocol context copied into an external Worker bundle. */
  protocolContextSource?: string
  proverBind?: string
  proverPublicUrl?: string
  readinessEvidencePath?: string
  /** Runtime mount corresponding to the selected profile's resourcesRoot. */
  resourcesMountPath?: string
  /** Existing PVC pre-populated with the selected release at resourcesMountPath. */
  resourcesPersistentVolumeClaim?: string
  /** Optional Kubernetes placement for the compiler-selected local production Worker. */
  workerNodeSelector?: Record<string, string>
  /** Kubernetes resources for the compiler-selected local production Worker. */
  workerResources?: {
    limits?: Record<string, number | string>
    requests?: Record<string, number | string>
  }
  /** RuntimeClass for the compiler-selected local production Worker, for example `nvidia`. */
  workerRuntimeClassName?: string
  /** Existing Kubernetes Secret containing the selected Worker token key. */
  workerSecretName?: string
  workerTokenFile?: string
  /** Kubernetes tolerations for compiler-selected local Workers. */
  workerTolerations?: Array<{
    effect?: 'NoExecute' | 'NoSchedule' | 'PreferNoSchedule'
    key?: string
    operator?: 'Equal' | 'Exists'
    tolerationSeconds?: number
    value?: string
  }>
}

export interface ProofTopologySpec {
  compiler: ProofTopologyCompilerConfig
  deployment?: ProofTopologyDeploymentConfig
  mock?: MockProofTopologySpec
  mode: ProofSystemMode
  production?: ProductionProofTopologySpec
  recovery?: {
    preTsukiDirectSignMaxEndBatchHeight: number
  }
}
