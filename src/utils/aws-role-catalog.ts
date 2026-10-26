/** Inline policy names of the CLI-owned workload roles; aws-roles writes each role's complete set. */
export const ARCHIVE_WRITER_POLICY_NAMES = {da: 'eth-da-submitter-s3-archive', snapshot: 'ScrollSdkSnapshotWrite'} as const
export const PROOF_ARTIFACT_POLICY = 'proof-artifact-store'
export const BRIDGE_SEQUENCER_KMS_POLICY = 'dogeos-bridge-sequencer-kms'
export const DSTACK_WORKER_POLICY = 'scrollsdk-dstack-workers'

export const kmsSignPolicyName = (service: string): string => `${service}-kms-sign`
