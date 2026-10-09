import type {ProofEnforcement, ProofGeneration, ProofTopologyMode} from '../types/proof-topology.js'

export const ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE = 'advance-l2-agg-verifying-key.bin'
export const ADVANCE_L2_AGG_VERIFYING_KEY_CONTAINER_PATH = `/etc/dogeos/${ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE}`

export interface SignerPolicyBundleSigner {
  id: string
  publicKey: string
  transportPubkey: string
}

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
  signers: SignerPolicyBundleSigner[]
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

/**
 * Create the operator's transport key once, validate the whole file, and
 * install it next to the Compose file, as one block that fails as a unit: a
 * corrupt key or a failed generator returns nonzero and leaves the runtime
 * key untouched. A rerun reuses the key whose public half the TSO directory
 * may already pin; rotation is a separate, explicit step. The partner-kit
 * README carries the same lines.
 */
export const TRANSPORT_KEY_COMMANDS = [
  '(',
  '  set -eu',
  '  key="signer-$SIGNER_ID/transport.key"',
  '  # Create only when absent: write a temp file, then link it in exclusively.',
  '  if [ ! -e "$key" ]; then',
  '    umask 077',
  '    openssl rand -hex 32 > "$key.new"',
  '    ln "$key.new" "$key"',
  '    rm -f "$key.new"',
  '  fi',
  '  # The whole file must be exactly 64 lowercase hex characters and a newline.',
  '  if [ "$(wc -c < "$key")" -ne 65 ] || [ "$(tail -c 1 "$key" | wc -l)" -ne 1 ] \\',
  '    || ! head -c 64 "$key" | grep -Eqx \'[0-9a-f]{64}\'; then',
  '    echo "$key must be exactly one line of 64 hex characters; restore it (rotation is a separate step)" >&2',
  '    exit 1',
  '  fi',
  '  # Install atomically: the runtime key is replaced only by a validated copy.',
  '  cp "$key" docker-compose/transport.key.new',
  '  chmod 600 docker-compose/transport.key.new',
  '  mv -f docker-compose/transport.key.new docker-compose/transport.key',
  ')',
].join('\n')

export function renderPartnerCommands(input: SignerPolicyBundleInput): string {
  const profile = signerRuntimePolicyProfile(input.enforcement)
  const signerRows = input.signers
    .map(signer => `| \`${signer.id}\` | \`${signer.publicKey}\` | \`${signer.transportPubkey}\` |`)
    .join('\n')
  const signerSelections = input.signers.map(signer => `### \`${signer.id}\`

\`\`\`bash
export SIGNER_ID='${signer.id}'
\`\`\``).join('\n\n')
  const verifierCopy = input.advanceL2Verifier
    ? `cp signer-policy-bundle/${input.advanceL2Verifier.aggVerifyingKeyFile} docker-compose/policy/${ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE}`
    : ''
  const preflight = input.enforcement === 'enforce'
    ? 'scrollsdk signer preflight --dir "signer-$SIGNER_ID" --require-production-ready'
    : 'scrollsdk signer preflight --dir "signer-$SIGNER_ID"'

  return `# Partner attestation-signer commands

Network \`${input.network}\`; proof posture
\`${input.mode}/${input.generation}/${input.enforcement}\`; dogeos-core contract
\`attestation_evidence_v2\`; runtime policy \`${profile.policyMode}\`.

| Purpose | Address |
|---|---|
| signer → TSO (dial-out: poll, submit, reject under /signer/) | \`${input.tsoUrl}\` |
${input.mode === 'disabled' ? '' : `| signer → proof artifact HTTPS root | \`${input.signerProofArtifactBaseUrl}\` |`}

| Signer id | Genesis public key | Transport public key |
|---|---|---|
${signerRows}

Signers dial out to the TSO over HTTPS and sign every request with their
transport key. Operators expose nothing inbound.

## Phase A — create identity before genesis

Run from scroll-sdk/partner-kit/attestation-signer and select your signer:

${signerSelections}

\`\`\`bash
export DOGE_NETWORK='${input.network}'
# 1. Signing key and env (add the KMS flags for a KMS backend). The env selects
#    pull delivery and the transport key file below.
scrollsdk signer init --id "$SIGNER_ID" --network "$DOGE_NETWORK"
# 2. Copy the signing env and policy next to the Compose file. The transport
#    key is a separate secret that authenticates this signer to the TSO: the
#    block creates it locally only if absent, validates the whole file and
#    installs it, failing as a unit.
cp "signer-$SIGNER_ID/attestation-signer.env" "signer-$SIGNER_ID/attestation-signer.toml" docker-compose/
chmod 600 docker-compose/attestation-signer.env
${TRANSPORT_KEY_COMMANDS}
# 3. Print the identity with the real backend, network and transport key
#    (the same compose service and mounts the runtime uses):
docker compose --project-directory docker-compose run --rm --no-deps -T attestation-signer \\
  -c /etc/dogeos-partner/attestation-signer.toml --print-identity > "signer-$SIGNER_ID/identity.json"
# 4. Wrap it into the descriptor (read-only for an existing signer):
scrollsdk signer init --id "$SIGNER_ID" --network "$DOGE_NETWORK" \\
  --identity "signer-$SIGNER_ID/identity.json"
\`\`\`

Send \`signer-$SIGNER_ID/descriptor.json\` to the bridge operator for
\`scrollsdk setup attestation-signer --threshold <T>\`. Do not start the current
signer yet: dogeos-core requires canonical protocol context in every mode, and
that context is generated after the descriptor keyset is fixed.

Keep \`transport.key\` with the signing env: the TSO pins its public key, so
losing it means a coordinated config change. Never send it to anyone.
Rerunning these commands never replaces it. Rotation is an explicit,
coordinated step: move the old file aside, create a new key, send the new
descriptor, and switch the runtime key only after the bridge operator has
updated the TSO signer directory.

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
${TRANSPORT_KEY_COMMANDS}
mkdir -p docker-compose/policy
cp signer-policy-bundle/signer-policy.env docker-compose/signer-policy.env
cp signer-policy-bundle/protocol_context.json docker-compose/policy/protocol_context.json
${verifierCopy}

docker compose --project-directory docker-compose config --quiet
docker compose --project-directory docker-compose up -d
${preflight}
\`\`\`

The signer must reach \`${input.tsoUrl}\` and, in proof modes, GET concrete
artifact URLs from requests. The CLI does not probe a fabricated object key.
`
}
