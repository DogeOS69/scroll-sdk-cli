import type {ProofTopologyImageReference} from './proof-topology.js'

export const PROOF_MATERIALS_SCHEMA = 'scrollsdk/proof-materials/v1' as const

export interface ProofMaterialFileV1 {
  /** Deployment-relative path. */
  path: string
  /** Lowercase, bare SHA-256. */
  sha256: string
  sizeBytes: number
}

export interface ProofProgramIdentityV1 {
  appCommitRaw: string
  programCommitmentHash: string
  verificationKeyHash: string
}

export interface ProofMaterialsV1 {
  bridge?: {
    artifacts: {
      appConfig: ProofMaterialFileV1
      appExe: ProofMaterialFileV1
      l2RangeAppConfig: ProofMaterialFileV1
      l2RangeAppExe: ProofMaterialFileV1
      nativeManifest: ProofMaterialFileV1
      /** Canonical real-bake compiler input; absent in receipts prepared by older CLI versions. */
      workerIdentityBundle?: ProofMaterialFileV1
    }
    genesisSequencerOutpointIndex: number
    genesisStateHash: string
    identity: ProofProgramIdentityV1
    protocolContextPath: string
    protocolContextSha256: string
  }
  generatedAt: string
  images: {
    mockWorker: ProofTopologyImageReference
    productionWorker?: ProofTopologyImageReference
    topologyCompiler: ProofTopologyImageReference
  }
  schema: typeof PROOF_MATERIALS_SCHEMA
  schemaVersion: 1
  software: {
    /** Real-generation files. Absent for identity-only mock preparation. */
    artifacts?: {
      aggregateVerifyingKey: ProofMaterialFileV1
      batchAppConfig: ProofMaterialFileV1
      batchAppExe: ProofMaterialFileV1
      batchMaterializer: ProofMaterialFileV1
      chunkAppConfig: ProofMaterialFileV1
      chunkAppExe: ProofMaterialFileV1
      chunkMaterializer: ProofMaterialFileV1
    }
    /** Canonical identity input copied verbatim from the pinned mock Worker image. */
    compilerIdentity?: ProofMaterialFileV1
    identities: {
      batch: ProofProgramIdentityV1
      bridge: ProofProgramIdentityV1
      chunk: ProofProgramIdentityV1
      l2Range: ProofProgramIdentityV1
    }
    identitySource: 'dogeos_core_scroll_identity_v1' | 'dogeos_core_synthetic_mock_v1' | 'real_identity_probe'
    /** Files required by production-shaped materialization with mock proving. */
    materializationArtifacts?: {
      aggregateVerifyingKey: ProofMaterialFileV1
      batchMaterializer: ProofMaterialFileV1
      chunkMaterializer: ProofMaterialFileV1
    }
    openvmVersion?: string
    rustToolchain?: string
    /** Native Scroll derivation evidence; mock materialization only, not a Bridge bake. */
    scrollIdentityEvidence?: ProofMaterialFileV1
    sourceRevisions?: {
      dogeosCore: string
      scrollZkvmProver: string
    }
  }
}
