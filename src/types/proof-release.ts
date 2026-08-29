import type {ProofTopologyImageReference} from './proof-topology.js'

export const PROOF_RELEASE_SCHEMA = 'dogeos/proof-release/v1' as const

/** A release-relative file pinned by its content digest. */
export interface ProofReleaseFileReference {
  path: string
  sha256: string
}

export interface ProofReleaseRealScrollFiles {
  aggVerifyingKey: ProofReleaseFileReference
  batchAppConfig: ProofReleaseFileReference
  batchAppExe: ProofReleaseFileReference
  batchMaterializerBinary: ProofReleaseFileReference
  bridgeAppConfig: ProofReleaseFileReference
  bridgeAppExe: ProofReleaseFileReference
  chunkAppConfig: ProofReleaseFileReference
  chunkAppExe: ProofReleaseFileReference
  chunkMaterializerBinary: ProofReleaseFileReference
  l2RangeAggregationAppConfig: ProofReleaseFileReference
  l2RangeAggregationAppExe: ProofReleaseFileReference
}

/** Reviewed proof identities emitted by the dogeos-core release producer. */
export interface ProofReleaseRealScrollIdentities {
  batchProgramCommitmentHashHex: string
  batchProgramCommitmentHex: string
  batchVerificationKeyHashHex: string
  bridgeAppCommitRawHex: string
  bridgeProgramCommitmentHashHex: string
  bridgeVerificationKeyHashHex: string
  chunkProgramCommitmentHashHex: string
  chunkProgramCommitmentHex: string
  chunkVerificationKeyHashHex: string
  l2RangeAggregationAppCommitRawHex: string
  l2RangeAggregationProgramCommitmentHashHex: string
  l2RangeAggregationVerificationKeyHashHex: string
}

export interface ProofReleaseRealScrollDefaults {
  batchBackendProfile: string
  batchProverRequirements?: string
  chunkBackendProfile: string
  chunkProverRequirements?: string
}

export interface ProofReleaseV1 {
  compilerImage: ProofTopologyImageReference
  profiles: {
    mock:
      | 'withdrawal_mock_prover'
      | 'withdrawal_mock_prover_real_materialize'
    production:
      | 'real_scroll_prover'
      | 'real_scroll_withdrawal'
      | 'real_scroll_withdrawal_full_topology'
  }
  realScroll: {
    defaults: ProofReleaseRealScrollDefaults
    files: ProofReleaseRealScrollFiles
    identities: ProofReleaseRealScrollIdentities
  }
  releaseId: string
  schema: typeof PROOF_RELEASE_SCHEMA
  workerImages: {
    mock: ProofTopologyImageReference
    production: ProofTopologyImageReference
  }
}
