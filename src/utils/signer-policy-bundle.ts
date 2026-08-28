import type {PreTsukiDirectSignIntent} from './pre-tsuki-direct-sign.js'
import type {ProofSystemMode} from './proof-system-mode.js'

import {PRE_TSUKI_DIRECT_SIGN_ATTESTATION_SIGNER_ENV} from './pre-tsuki-direct-sign.js'

export const ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE = 'advance-l2-agg-verifying-key.bin'
export const ADVANCE_L2_AGG_VERIFYING_KEY_CONTAINER_PATH = `/etc/dogeos/${ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE}`

export interface SignerPolicyBundleSigner {
  endpoint: string
  id: string
  publicKey: string
}

export interface SignerAdvanceL2VerifierMaterial {
  aggVerifyingKeyFile: string
  aggVerifyingKeySha256: string
  batchProgramCommitmentHex: string
  l2RangeAggregationProgramCommitmentHex: string
}

export interface SignerPolicyBundleInput {
  advanceL2Verifier?: SignerAdvanceL2VerifierMaterial
  mode: ProofSystemMode
  network: string
  preTsukiDirectSign?: PreTsukiDirectSignIntent
  signerProofArtifactBaseUrl?: string
  signers: SignerPolicyBundleSigner[]
  tsoUrl: string
}

export interface SignerRuntimePolicyProfile {
  allowUnimplementedChecks: boolean
  policyMode: 'dev_permissive' | 'production_enforce' | 'staging_scaffold'
}

export function signerRuntimePolicyProfile(mode: ProofSystemMode): SignerRuntimePolicyProfile {
  if (mode === 'disabled') return {allowUnimplementedChecks: false, policyMode: 'dev_permissive'}
  return mode === 'mock'
    ? {allowUnimplementedChecks: true, policyMode: 'staging_scaffold'}
    : {allowUnimplementedChecks: false, policyMode: 'production_enforce'}
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

# Deliberate 1-of-1 L2 source; prefer quorum when independent sources exist.
# [advance_l2_policy.l2_sources]
# posture = "explicit_single_source"
# required_agreement = 1
# [[advance_l2_policy.l2_sources.sources]]
# trust_domain_id = "partner-l2-source"
# rpc_url = "https://l2-rpc.partner.example"
# timeout_ms = 10000
`
}

export function renderSignerPolicyEnv(input: SignerPolicyBundleInput): string {
  const profile = signerRuntimePolicyProfile(input.mode)
  const artifactOrigin = input.mode !== 'disabled' && input.signerProofArtifactBaseUrl
    ? new URL(input.signerProofArtifactBaseUrl).origin
    : undefined
  if (input.mode === 'production' && !input.advanceL2Verifier) {
    throw new Error('production signer policy requires compiler-selected AdvanceL2 verifier material')
  }

  return [
    `# dogeos-core attestation_evidence_v2 policy for proof mode ${input.mode}.`,
    `ATTESTATION_SIGNER_POLICY_MODE=${profile.policyMode}`,
    `ATTESTATION_SIGNER_ALLOW_UNIMPLEMENTED_CHECKS=${profile.allowUnimplementedChecks}`,
    `ATTESTATION_SIGNER_NETWORK=${input.network}`,
    ...(input.preTsukiDirectSign
      ? [`${PRE_TSUKI_DIRECT_SIGN_ATTESTATION_SIGNER_ENV}=${input.preTsukiDirectSign.maxEndBatchHeight}`]
      : []),
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

export function renderPartnerCommands(input: SignerPolicyBundleInput): string {
  const profile = signerRuntimePolicyProfile(input.mode)
  const signerRows = input.signers
    .map(signer => `| \`${signer.id}\` | \`${signer.endpoint}\` | \`${signer.publicKey}\` |`)
    .join('\n')
  const signerSelections = input.signers.map(signer => `### \`${signer.id}\`

\`\`\`bash
export SIGNER_ID='${signer.id}'
export SIGNER_ENDPOINT='${signer.endpoint}'
\`\`\``).join('\n\n')
  const clusterProbes = input.signers.map(signer => `# ${signer.id}
kubectl -n <namespace> run signer-reachability-${signer.id} --rm -i --restart=Never \\
  --image=curlimages/curl:8.20.0 -- \\
  curl -fsS '${signer.endpoint}/health'`).join('\n\n')
  const verifierCopy = input.advanceL2Verifier
    ? `cp signer-policy-bundle/${input.advanceL2Verifier.aggVerifyingKeyFile} docker-compose/policy/${ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE}`
    : ''
  const preflight = input.mode === 'production'
    ? 'scrollsdk signer preflight --dir "signer-$SIGNER_ID" --require-production-ready'
    : 'scrollsdk signer preflight --dir "signer-$SIGNER_ID"'
  const recovery = input.preTsukiDirectSign
    ? `## Temporary pre-Tsuki direct-sign recovery

The Issue #843 testnet-only pin ends at L2 batch
\`${input.preTsukiDirectSign.maxEndBatchHeight}\`. WP and TSO must carry the
same pin. The two recovery capability rows do not count toward
\`production_v2_ready\`. Retire WP, signer, then TSO after completion is stable.

`
    : ''

  return `# Partner attestation-signer commands

Network \`${input.network}\`; proof mode \`${input.mode}\`; dogeos-core contract
\`attestation_evidence_v2\`; runtime policy \`${profile.policyMode}\`.

| Purpose | Address |
|---|---|
| signer → TSO callbacks | \`${input.tsoUrl}\` |
${input.mode === 'disabled' ? '' : `| signer → proof artifact HTTPS root | \`${input.signerProofArtifactBaseUrl}\` |`}

| Signer id | TSO → signer URL | Genesis public key |
|---|---|---|
${signerRows}

The signer URL must be reachable from TSO. Use TLS in production; do not use
localhost, a Docker-only hostname, or a Kubernetes service name.

## Phase A — create identity before genesis

Run from scroll-sdk/partner-kit/attestation-signer and select your signer:

${signerSelections}

\`\`\`bash
export DOGE_NETWORK='${input.network}'
scrollsdk signer init \\
  --id "$SIGNER_ID" \\
  --network "$DOGE_NETWORK" \\
  --endpoint "$SIGNER_ENDPOINT"
\`\`\`

Send \`signer-$SIGNER_ID/descriptor.json\` to the bridge operator for
\`scrollsdk setup attestation-signer --threshold <T>\`. Do not start the current
signer yet: dogeos-core requires canonical protocol context in every mode, and
that context is generated after the descriptor keyset is fixed.

For KMS add its backend flags. Production operators must also pass the approved
\`--allowed-release-version\` and full \`--allowed-git-commit\`.

## Phase B — install bundle and start signer

Keep partner-owned \`attestation-signer.toml\` separate from this bundle. For
production, fill its three RPC source sets and two rotation allowlists first.
Incomplete optional policy starts fail-closed and leaves \`/ready\` at HTTP 503.

\`\`\`bash
export SIGNER_ID='<your signer id>'
cp "signer-$SIGNER_ID/attestation-signer.env" docker-compose/
cp "signer-$SIGNER_ID/attestation-signer.toml" docker-compose/
chmod 600 docker-compose/attestation-signer.env
mkdir -p docker-compose/policy
cp signer-policy-bundle/signer-policy.env docker-compose/signer-policy.env
cp signer-policy-bundle/protocol_context.json docker-compose/policy/protocol_context.json
${verifierCopy}

if grep -q '^${PRE_TSUKI_DIRECT_SIGN_ATTESTATION_SIGNER_ENV}=' docker-compose/attestation-signer.env; then
  echo '${PRE_TSUKI_DIRECT_SIGN_ATTESTATION_SIGNER_ENV} belongs only in signer-policy.env' >&2
  exit 1
fi

docker compose --project-directory docker-compose config --quiet
docker compose --project-directory docker-compose up -d
curl -fsS "$SIGNER_ENDPOINT/health"
${preflight}
\`\`\`

The signer must call \`${input.tsoUrl}\` and, in proof modes, GET concrete
artifact URLs from requests. The CLI does not probe a fabricated object key.

${recovery}## Bridge-operator reachability check

\`\`\`bash
${clusterProbes}
\`\`\`
`
}
