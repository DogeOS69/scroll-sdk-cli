export const PROOF_PROGRAM_PUBLICATION_SCHEMA = 'scrollsdk/proof-program-publication/v1' as const

export interface ProofProgramPublicationFileV1 {
  key: string
  sha256: string
  sizeBytes: number
  url: string
}

export interface ProofProgramPublicationV1 {
  artifactStore: {
    bucket: string
    keyPrefix: string
    region: string
  }
  bundleId: string
  coreRevision: string
  files: Record<string, ProofProgramPublicationFileV1>
  proofTopologyBundleRevision: string
  publishedAt: string
  schema: typeof PROOF_PROGRAM_PUBLICATION_SCHEMA
  schemaVersion: 1
  verification: {
    anonymousHttpReadback: 'passed'
    authenticatedS3Readback: 'passed'
  }
}
