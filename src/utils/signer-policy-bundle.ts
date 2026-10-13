import type {ProofEnforcement, ProofGeneration, ProofTopologyMode} from '../types/proof-topology.js'

export const ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE = 'advance-l2-agg-verifying-key.bin'
export const ADVANCE_L2_AGG_VERIFYING_KEY_CONTAINER_PATH = `/etc/dogeos/${ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE}`

export interface SignerAdvanceL2VerifierMaterial {
  aggVerifyingKeyFile: string
  aggVerifyingKeySha256: string
  batchProgramCommitmentHex: string
  l2RangeAggregationProgramCommitmentHex: string
}

export interface SignerPolicyBundleInput {
  advanceL2Verifier?: SignerAdvanceL2VerifierMaterial
  enforcement: ProofEnforcement
  generation: ProofGeneration
  mode: ProofTopologyMode
  network: string
  signerProofArtifactBaseUrl?: string
  tsoUrl: string
}

export interface SignerRuntimePolicyProfile {
  policyMode: ProofEnforcement
}

export function signerRuntimePolicyProfile(enforcement: ProofEnforcement): SignerRuntimePolicyProfile {
  return {policyMode: enforcement}
}

/** Partner-owned V2 policy; bridge-derived inputs are supplied by env. */
export function renderSignerOperatorPolicyTemplate(): string {
  return `# Partner-owned dogeos-core attestation-signer V2 policy.
# Generated once by scrollsdk signer init and NEVER overwritten by a bridge
# bundle. Uncomment and fill the policy you intend to serve. Keep secrets in
# attestation-signer.env, not this file.
#
# The bridge bundle supplies mode, TSO URL, canonical protocol context,
# artifact origin, and production AdvanceL2 verifier material through env.

# Optional bounded artifact limits; omission uses dogeos-core defaults.
# [artifact_fetch]
# max_compressed_bytes = 67108864
# max_decompressed_bytes = 536870912
# timeout_ms = 10000
# cache_max_entries = 64
# cache_max_bytes = 536870912

# Both non-empty allowlists are required for production V2 readiness.
# [rotation_policy]
# allowed_next_bridge_script_hashes = ["0x<40-lowercase-hex>"]
# allowed_next_sequencer_signers = ["0x<40-lowercase-hex>"]

# [advance_l1_policy.terminal_anchor_sources]
# posture = "quorum"
# required_agreement = 2
# [[advance_l1_policy.terminal_anchor_sources.sources]]
# trust_domain_id = "dogecoin-operator-a"
# rpc_url = "https://dogecoin-a.example"
# timeout_ms = 10000
# [[advance_l1_policy.terminal_anchor_sources.sources]]
# trust_domain_id = "dogecoin-operator-b"
# rpc_url = "https://dogecoin-b.example"
# timeout_ms = 10000

# [advance_l2_policy.ethereum_sources]
# posture = "quorum"
# required_agreement = 2
# [[advance_l2_policy.ethereum_sources.sources]]
# trust_domain_id = "ethereum-operator-a"
# rpc_url = "https://ethereum-a.example"
# timeout_ms = 10000
# [[advance_l2_policy.ethereum_sources.sources]]
# trust_domain_id = "ethereum-operator-b"
# rpc_url = "https://ethereum-b.example"
# timeout_ms = 10000

# Enforce requires quorum with at least two independent trust domains for
# every source set. explicit_single_source is only allowed in observe mode.
# [advance_l2_policy.l2_sources]
# posture = "quorum"
# required_agreement = 2
# [[advance_l2_policy.l2_sources.sources]]
# trust_domain_id = "l2-operator-a"
# rpc_url = "https://l2-a.example"
# timeout_ms = 10000
# [[advance_l2_policy.l2_sources.sources]]
# trust_domain_id = "l2-operator-b"
# rpc_url = "https://l2-b.example"
# timeout_ms = 10000
`
}

export function renderSignerPolicyEnv(input: SignerPolicyBundleInput): string {
  const profile = signerRuntimePolicyProfile(input.enforcement)
  const artifactOrigin = input.mode === 'active' && input.signerProofArtifactBaseUrl
    ? new URL(input.signerProofArtifactBaseUrl).origin
    : undefined
  if (input.generation === 'real' && !input.advanceL2Verifier) {
    throw new Error('real signer policy requires compiler-selected AdvanceL2 verifier material')
  }

  return [
    `# dogeos-core attestation_evidence_v2 policy for ${input.mode}/${input.generation}/${input.enforcement}.`,
    `ATTESTATION_SIGNER_POLICY_MODE=${profile.policyMode}`,
    `ATTESTATION_SIGNER_NETWORK=${input.network}`,
    'ATTESTATION_SIGNER_PROTOCOL_CONTEXT_JSON=/etc/dogeos/protocol_context.json',
    ...(artifactOrigin ? [`ATTESTATION_SIGNER_ARTIFACT_ALLOWED_ORIGINS=${artifactOrigin}`] : []),
    ...(input.advanceL2Verifier
      ? [
          `ATTESTATION_SIGNER_ADVANCE_L2_AGG_VERIFYING_KEY_PATH=${ADVANCE_L2_AGG_VERIFYING_KEY_CONTAINER_PATH}`,
          `ATTESTATION_SIGNER_ADVANCE_L2_BATCH_PROGRAM_COMMITMENT_HEX=${input.advanceL2Verifier.batchProgramCommitmentHex}`,
          `ATTESTATION_SIGNER_L2_RANGE_AGGREGATION_PROGRAM_COMMITMENT_HEX=${input.advanceL2Verifier.l2RangeAggregationProgramCommitmentHex}`,
        ]
      : []),
    `ATTESTATION_SIGNER_TSO_URL=${input.tsoUrl}`,
    '',
  ].join('\n')
}
