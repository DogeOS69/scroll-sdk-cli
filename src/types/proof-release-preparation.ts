export const PROOF_RELEASE_PREPARATION_SCHEMA = 'scrollsdk/proof-release-preparation/v1' as const

export interface ProofReleasePreparationFileV1 {
  /** Absolute local path. The receipt is a local build handoff, not a portable deployment artifact. */
  path: string
  sha256: string
  sizeBytes: number
}

export interface ProofReleasePreparationV1 {
  coreRevision: string
  /** The prepare-real output tree: the producer's Scroll programs, the deployment's Bridge bake and its 11 identity exports. */
  files: {
    bridge: {
      appConfig: ProofReleasePreparationFileV1
      appExe: ProofReleasePreparationFileV1
      l2RangeAppConfig: ProofReleasePreparationFileV1
      l2RangeAppExe: ProofReleasePreparationFileV1
      nativeManifest: ProofReleasePreparationFileV1
      workerIdentityBundle: ProofReleasePreparationFileV1
    }
    identityEnv: ProofReleasePreparationFileV1
    protocolContext: ProofReleasePreparationFileV1
    scroll: {
      aggregateVerifyingKey: ProofReleasePreparationFileV1
      batchAppConfig: ProofReleasePreparationFileV1
      batchAppExe: ProofReleasePreparationFileV1
      chunkAppConfig: ProofReleasePreparationFileV1
      chunkAppExe: ProofReleasePreparationFileV1
    }
  }
  generatedAt: string
  schema: typeof PROOF_RELEASE_PREPARATION_SCHEMA
  schemaVersion: 1
}
