import type {ProofTopologyImageReference} from './proof-topology.js'

export const PROOF_WORKER_IMAGE_CHECK_SCHEMA = 'scrollsdk/proof-worker-image-check/v1' as const

export interface ProofWorkerImageCheckV1 {
  coreRevision: string
  cudaArchitectures: string[]
  identities: {
    batchAggregationProgramCommitmentRaw: string
    batchProgramCommitmentRaw: string
  }
  image: ProofTopologyImageReference
  inspectedAt: string
  schema: typeof PROOF_WORKER_IMAGE_CHECK_SCHEMA
  schemaVersion: 1
}
