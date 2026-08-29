import type {ProofTopologyImageReference} from './proof-topology.js'

export const PROOF_SOFTWARE_RELEASE_SCHEMA = 'dogeos/proof-software-release/v1' as const
export const PROOF_DEPLOYMENT_RELEASE_LOCK_SCHEMA =
  'dogeos/proof-deployment-release-lock/v1' as const
export const PROOF_RELEASE_IMPORT_SCHEMA = 'scrollsdk/proof-release-import/v1' as const
export const PROOF_SOFTWARE_RELEASE_IMPORT_SCHEMA =
  'scrollsdk/proof-software-release-import/v1' as const

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
  proof_coordinator?: ProofTopologyImageReference
  topology_compiler: ProofTopologyImageReference
  withdrawal_processor?: ProofTopologyImageReference
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

export interface ProofDeploymentReleaseProjectionV1 {
  aggregate_verification_key: string
  batch_app_vmexe: string
  batch_materializer: string
  batch_openvm_config: string
  bridge_app_vmexe: string
  bridge_openvm_config: string
  chunk_app_vmexe: string
  chunk_materializer: string
  chunk_openvm_config: string
  identities: {
    aggregate_verification_key_hash: string
    batch: ScrollBatchProgramIdentityV1
    bridge: OpenVmProgramIdentityV1
    chunk: ScrollProgramIdentityV1
    l2_range: OpenVmProgramIdentityV1
  }
  images: ProofReleaseImagesV1
  l2_range_app_vmexe: string
  l2_range_openvm_config: string
}

export interface ProofDeploymentReleaseLockV1 {
  bridge_material_digest: string
  bridge_material_manifest: string
  bridge_material_root: string
  lock_digest: string
  projection: ProofDeploymentReleaseProjectionV1
  schema: typeof PROOF_DEPLOYMENT_RELEASE_LOCK_SCHEMA
  schema_version: 1
  software_release_digest: string
  software_release_manifest: string
  software_release_root: string
}

/** Local, non-authoritative receipt recording which immutable OCI image was imported. */
export interface ProofReleaseImportV1 {
  deployment_lock: string
  deployment_lock_digest: string
  protocol_context: string
  protocol_context_sha256: string
  release_id: string
  release_image: string
  schema: typeof PROOF_RELEASE_IMPORT_SCHEMA
  schema_version: 1
  software_release_digest: string
}

/** Local receipt for a validated software release imported without deployment-bound Bridge material. */
export interface ProofSoftwareReleaseImportV1 {
  release_id: string
  release_image: string
  schema: typeof PROOF_SOFTWARE_RELEASE_IMPORT_SCHEMA
  schema_version: 1
  software_release_digest: string
  software_release_manifest: string
}

/** Mock-capable immutable software release; it is deliberately insufficient for production. */
export interface PreparedProofSoftwareRelease {
  importPath: string
  manifestPath: string
  receipt: ProofSoftwareReleaseImportV1
  release: ProofSoftwareReleaseV1
  resourcesRoot: string
  softwareRoot: string
}

/** The validated local input consumed by topology initialization. */
export interface PreparedProofRelease {
  importPath: string
  lock: ProofDeploymentReleaseLockV1
  lockPath: string
  receipt: ProofReleaseImportV1
  release: ProofSoftwareReleaseV1
  resourcesRoot: string
}
