/** Digest-pinned image consumed by the compiler or a generated Worker contract. */
export interface ProofTopologyImageReference {
  digest: string
  repository: string
}

export type ProofTopologyMode = 'active' | 'disabled'
export type ProofGeneration = 'mock' | 'real'
export type ProofEnforcement = 'enforce' | 'observe'
export type ProofWorkerLaunch = 'external' | 'local_cpu' | 'local_cuda'
export type ProofWorkerDeploymentBackend = 'docker_compose' | 'kubernetes'

export interface ProofTopologyCompilerConfig {
  /** Deployment-relative canonical identity input passed to dogeos-core. */
  identityFilePath?: string
  /** Must come from the same dogeos-core revision as the deployed services. */
  image: ProofTopologyImageReference
}

export interface ProofTopologyArtifactStoreConfig {
  bucket?: string
  endpointUrl?: string
  forcePathStyle?: boolean
  /** Retired: artifact key placement now belongs to deployment.artifactKeyPrefix. */
  keyPrefix?: string
  kind: 'local_fs' | 'managed_minio' | 's3_compatible'
  maxReadBodyBytes?: number
  region?: string
}

/**
 * Strict identity/resource table consumed by dogeos-core. Identity values are
 * derived by Rust/OpenVM tooling and imported from proof-materials-v1.json;
 * scroll-sdk-cli never computes them independently.
 */
export interface ProofTopologyRealScrollConfig {
  aggVerifyingKeyPath?: string
  batchAppConfig?: string
  batchAppExe?: string
  batchBackendProfile?: string
  batchMaterializerBinaryPath?: string
  batchParallelism?: number
  batchProgramCommitmentHashHex: string
  batchProgramCommitmentHex: string
  batchProverRequirements?: string
  batchVerificationKeyHashHex: string
  bridgeAppCommitRawHex: string
  bridgeProgramCommitmentHashHex: string
  bridgeVerificationKeyHashHex: string
  chunkAppConfig?: string
  chunkAppExe?: string
  chunkBackendProfile?: string
  chunkBlockWitnessDir?: string
  chunkMaterializerBinaryPath?: string
  chunkMaterializerTimeoutMs?: number
  chunkParallelism?: number
  chunkProgramCommitmentHashHex: string
  chunkProgramCommitmentHex: string
  chunkProverRequirements?: string
  chunkVerificationKeyHashHex: string
  chunkWitnessRpcUrl?: string
  chunkWitnessSource?: 'block_witness_dir' | 'rpc'
  l2RangeAggregationAppCommitRawHex: string
  l2RangeAggregationProgramCommitmentHashHex: string
  l2RangeAggregationVerificationKeyHashHex: string
  regtestPinnedGenesisSequencerOutpoint?: string
  /** Host path containing imported software and Bridge material. */
  resourcesRoot: string
  /** Retired placement field; rejected by the PR #937 source adapter. */
  s3PublicEndpointUrl?: string
  workerId?: string
  workerMaxBodyBytes?: number
}

export interface ActiveProofTopologySpec {
  artifactStore: ProofTopologyArtifactStoreConfig
  profile:
    | 'real_scroll_prover'
    | 'real_scroll_withdrawal'
    | 'real_scroll_withdrawal_full_topology'
    | 'withdrawal_mock_prover'
    | 'withdrawal_mock_prover_real_materialize'
  realScroll: ProofTopologyRealScrollConfig
  workerLaunch: ProofWorkerLaunch
}

export interface ProofTopologyDeploymentConfig {
  artifactKeyPrefix: string
  coordinatorId?: string
  generatedMaterialsRoot?: string
  l2GenesisJson?: string
  mockWorkerImage: ProofTopologyImageReference
  productionWorkerImage?: ProofTopologyImageReference
  proofWorkBind?: string
  proofWorkPublicUrl?: string
  proofWorkTokenFile?: string
  protocolContextPath?: string
  proverBind?: string
  proverPublicUrl?: string
  publicS3EndpointUrl?: string
  readinessEvidencePath?: string
  /** Runtime mount corresponding to realScroll.resourcesRoot. */
  resourcesMountPath?: string
  /** Existing PVC pre-populated with proof material at resourcesMountPath. */
  resourcesPersistentVolumeClaim?: string
  /** How scroll-sdk-cli installs adapter-managed local_cpu/local_cuda Workers. */
  workerDeploymentBackend?: ProofWorkerDeploymentBackend
  workerNodeSelector?: Record<string, string>
  workerResources?: {
    limits?: Record<string, number | string>
    requests?: Record<string, number | string>
  }
  workerRuntimeClassName?: string
  workerSecretName?: string
  workerTokenFile?: string
  workerTolerations?: Array<{
    effect?: 'NoExecute' | 'NoSchedule' | 'PreferNoSchedule'
    key?: string
    operator?: 'Equal' | 'Exists'
    tolerationSeconds?: number
    value?: string
  }>
}

export interface ProofTopologySpec {
  active?: ActiveProofTopologySpec
  compiler: ProofTopologyCompilerConfig
  deployment: ProofTopologyDeploymentConfig
  enforcement: ProofEnforcement
  generation: ProofGeneration
  mode: ProofTopologyMode
}
