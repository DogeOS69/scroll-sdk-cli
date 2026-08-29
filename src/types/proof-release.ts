import type {ProofTopologyImageReference} from './proof-topology.js'

export const PROOF_SOFTWARE_RELEASE_SCHEMA = 'dogeos/proof-software-release/v1' as const
export const PROOF_BRIDGE_MATERIAL_SCHEMA = 'dogeos/proof-bridge-material/v1' as const
export const PROOF_PRODUCTION_INPUTS_SCHEMA = 'scrollsdk/proof-production-inputs/v1' as const

export interface ProofReleaseFileV1 {
  path: string
  sha256: string
  size_bytes: number
}
export interface ScrollProgramIdentityV1 {
  program_commitment_hash: string
  program_commitment_le_raw: string
  verification_key_hash: string
}

export interface ScrollBatchProgramIdentityV1 extends ScrollProgramIdentityV1 {
  recursive_app_commit_raw: string
}

export interface OpenVmProgramIdentityV1 {
  app_commit_raw: string
  program_commitment_hash: string
  verification_key_hash: string
}

export interface ProofReleaseImagesV1 {
  bridge_artifact_baker: ProofTopologyImageReference
  mock_worker: ProofTopologyImageReference
  production_worker: ProofTopologyImageReference
  topology_compiler: ProofTopologyImageReference
}

export interface ProofSoftwareReleaseV1 {
  build: {
    openvm_version: string
    root_verifier_asm_sha256: string
    rust_toolchain: string
  }
  identities: {
    aggregate_verification_key_hash: string
    batch: ScrollBatchProgramIdentityV1
    chunk: ScrollProgramIdentityV1
    l2_range: OpenVmProgramIdentityV1
  }
  images: ProofReleaseImagesV1
  materials: {
    aggregate_verification_key: ProofReleaseFileV1
    batch_app_vmexe: ProofReleaseFileV1
    batch_materializer: ProofReleaseFileV1
    batch_openvm_config: ProofReleaseFileV1
    chunk_app_vmexe: ProofReleaseFileV1
    chunk_materializer: ProofReleaseFileV1
    chunk_openvm_config: ProofReleaseFileV1
    l2_range_app_vmexe: ProofReleaseFileV1
    l2_range_openvm_config: ProofReleaseFileV1
  }
  release_digest: string
  release_id: string
  schema: typeof PROOF_SOFTWARE_RELEASE_SCHEMA
  schema_version: 1
  source_revisions: {
    dogeos_core: string
    scroll_zkvm_prover: string
  }
}

export interface ProofBridgeMaterialV1 {
  bridge_material_digest: string
  files: {
    bridge_app_vmexe: ProofReleaseFileV1
    bridge_openvm_config: ProofReleaseFileV1
    l2_range_app_vmexe: ProofReleaseFileV1
    l2_range_openvm_config: ProofReleaseFileV1
    native_staged_manifest: ProofReleaseFileV1
  }
  genesis_sequencer_outpoint_index: number
  genesis_state_hash: string
  identities: {
    bridge: OpenVmProgramIdentityV1
    l2_range: OpenVmProgramIdentityV1
  }
  openvm_version: string
  protocol_context_sha256: string
  root_verifier_asm_sha256: string
  schema: typeof PROOF_BRIDGE_MATERIAL_SCHEMA
  schema_version: 1
  software_release_digest: string
}

/** Local receipt for the two authoritative production manifests. */
export interface ProofProductionInputsReceiptV1 {
  bridge_material_digest: string
  bridge_material_manifest: string
  bridge_material_root: string
  protocol_context: string
  protocol_context_sha256: string
  release_id: string
  resources_root: string
  schema: typeof PROOF_PRODUCTION_INPUTS_SCHEMA
  schema_version: 1
  software_release_digest: string
  software_release_manifest: string
  software_release_root: string
}

export interface PreparedProofProductionInputs {
  bridge: ProofBridgeMaterialV1
  bridgeManifestPath: string
  bridgeRoot: string
  protocolContextPath: string
  receipt: ProofProductionInputsReceiptV1
  receiptPath: string
  release: ProofSoftwareReleaseV1
  resourcesRoot: string
  softwareManifestPath: string
  softwareRoot: string
}
