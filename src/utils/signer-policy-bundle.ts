import type { PreTsukiDirectSignIntent } from './pre-tsuki-direct-sign.js'
import type { ProofSystemMode } from './proof-system-mode.js'

import { PRE_TSUKI_DIRECT_SIGN_ATTESTATION_SIGNER_ENV } from './pre-tsuki-direct-sign.js'

/**
 * Matches dogeos-core's e2e_harness attestation-signer posture. AdvanceL1
 * carries one proof artifact and AdvanceL2 carries two; four leaves bounded
 * headroom while keeping the envelope deny-by-default.
 */
export const DEFAULT_ENVELOPE_MAX_PROOF_ARTIFACTS = 4

export interface SignerPolicyBundleSigner {
  endpoint: string
  id: string
  publicKey: string
}

export interface SignerPolicyBundleInput {
  activeBridgeKeyHash: string
  allowedProofTriples: string
  bridgeNamespaceId: string
  mode: ProofSystemMode
  network: string
  preTsukiDirectSign?: PreTsukiDirectSignIntent
  protocolInstanceId: string
  signerProofArtifactBaseUrl?: string
  signers: SignerPolicyBundleSigner[]
  supportedSigningPolicyVersions: string
  teeAllowedSignerIds: string
  tsoUrl: string
}

export interface SignerRuntimePolicyProfile {
  allowUnimplementedChecks: boolean
  envelopeMaxProofArtifacts: number
  policyMode: 'dev_permissive' | 'production_enforce' | 'staging_scaffold'
  proofArtifactFetchMode: 'disabled' | 'http'
}

/**
 * mock mirrors e2e_harness: it runs the real signer and all implemented
 * checks, but explicitly records/bypasses production checks that cannot accept
 * deterministic non-cryptographic proof bytes. production remains fail-closed.
 */
export function signerRuntimePolicyProfile(mode: ProofSystemMode): SignerRuntimePolicyProfile {
  if (mode === 'disabled') {
    return {
      allowUnimplementedChecks: false,
      envelopeMaxProofArtifacts: 0,
      policyMode: 'dev_permissive',
      proofArtifactFetchMode: 'disabled',
    }
  }

  return mode === 'mock'
    ? {
        allowUnimplementedChecks: true,
        envelopeMaxProofArtifacts: DEFAULT_ENVELOPE_MAX_PROOF_ARTIFACTS,
        policyMode: 'staging_scaffold',
        proofArtifactFetchMode: 'http',
      }
    : {
        allowUnimplementedChecks: false,
        envelopeMaxProofArtifacts: DEFAULT_ENVELOPE_MAX_PROOF_ARTIFACTS,
        policyMode: 'production_enforce',
        proofArtifactFetchMode: 'http',
      }
}

export function renderVerifierRegistryToml(allowedProofTriples: string): string {
  const triples = allowedProofTriples.split(',').map(value => value.trim()).filter(Boolean)
  const entries = triples.map((triple, index) => {
    const [proofKind, verifierId, vkHash, ...extra] = triple.split(':')
    if (extra.length > 0 || !proofKind || !verifierId || !vkHash) {
      throw new Error(`allowed proof triple ${index} must be proof_kind:verifier_id:vk_hash`)
    }

    const normalizedVkHash = vkHash.toLowerCase().startsWith('0x')
      ? vkHash.toLowerCase()
      : `0x${vkHash.toLowerCase()}`
    if (!/^0x[\da-f]{64}$/.test(normalizedVkHash)) {
      throw new Error(`allowed proof triple ${index} vk_hash must be 32-byte hex`)
    }

    return `[[verifier]]
proof_kind = ${JSON.stringify(proofKind)}
verifier_id = ${JSON.stringify(verifierId)}
vk_hash = ${JSON.stringify(normalizedVkHash)}
allowed_protocol_versions = [1]
allowed_signing_policy_versions = [1]
`
  })

  return `# Generated from the proof topology staged by scrollsdk setup prep-charts.
# Registry membership binds signer policy to the same proof identities used by
# withdrawal-processor and proof-coordinator; it is not proof-byte verification.
${entries.join('\n')}`
}

export function renderMockSourceSetToml(): string {
  return `# Mock/e2e_harness source-set scaffold.
# Intentionally empty: staging_scaffold records the not-yet-implemented RPC
# source agreement checks as audited bypasses. Production must provide the
# three real source sections in configs/source-set.toml.
`
}

export function renderDisabledVerifierRegistryToml(): string {
  return `# Proof system disabled.
# Direct-sign/dev_permissive signer policy accepts no proof artifacts, so the
# verifier registry is intentionally empty.
`
}

export function renderDisabledSourceSetToml(): string {
  return `# Proof system disabled.
# Direct-sign/dev_permissive signer policy performs no proof source quorum.
`
}

export function renderSignerPolicyEnv(input: SignerPolicyBundleInput): string {
  const profile = signerRuntimePolicyProfile(input.mode)
  const artifactAllowedOrigins = input.signerProofArtifactBaseUrl
    ? new URL(input.signerProofArtifactBaseUrl).origin
    : ''
  return [
    `# Post-genesis ${input.mode} proof-system policy for a partner-operated attestation-signer.`,
    '# Apply next to the operator-owned WIF/KMS and release-pin settings, then restart.',
    input.preTsukiDirectSign
      ? `# TEMPORARY TESTNET RECOVERY: pre-Tsuki direct-sign is bounded at L2 batch ${input.preTsukiDirectSign.maxEndBatchHeight}.`
      : input.mode === 'disabled'
      ? '# DISABLED: proof-disabled/dev_permissive posture; proof artifacts are not accepted or fetched.'
      : input.mode === 'mock'
      ? '# MOCK: real service/transport/policy flow with deterministic NON-cryptographic proofs; unimplemented production checks are audited and bypassed.'
      : '# PRODUCTION: fail-closed policy; the operator must also pin the approved signer image release + git identity in attestation-signer.env.',
    `ATTESTATION_SIGNER_POLICY_MODE=${profile.policyMode}`,
    `ATTESTATION_SIGNER_ALLOW_UNIMPLEMENTED_CHECKS=${profile.allowUnimplementedChecks}`,
    `ATTESTATION_SIGNER_NETWORK=${input.network}`,
    ...(input.preTsukiDirectSign
      ? [`${PRE_TSUKI_DIRECT_SIGN_ATTESTATION_SIGNER_ENV}=${input.preTsukiDirectSign.maxEndBatchHeight}`]
      : []),
    'ATTESTATION_SIGNER_PROTOCOL_CONTEXT_JSON=/etc/dogeos/protocol_context.json',
    ...(artifactAllowedOrigins
      ? [`ATTESTATION_SIGNER_ARTIFACT_ALLOWED_ORIGINS=${artifactAllowedOrigins}`]
      : []),
    `ATTESTATION_SIGNER_TSO_URL=${input.tsoUrl}`,
    '',
  ].join('\n')
}

/**
 * Put the exact, address-bearing two-party procedure in the artifact sent to
 * partners. This makes the operator handoff itself reviewable/testable, rather
 * than relying on a generic runbook that can drift from the generated policy.
 */
export function renderPartnerCommands(input: SignerPolicyBundleInput): string {
  const profile = signerRuntimePolicyProfile(input.mode)
  const signerRows = input.signers
    .map(signer => `| \`${signer.id}\` | \`${signer.endpoint}\` | \`${signer.publicKey}\` |`)
    .join('\n')
  const signerSelections = input.signers
    .map(signer => `### \`${signer.id}\`

\`\`\`bash
export SIGNER_ID='${signer.id}'
export SIGNER_ENDPOINT='${signer.endpoint}'
\`\`\``)
    .join('\n\n')
  const clusterProbes = input.signers
    .map(signer => `# ${signer.id}
kubectl -n <namespace> run signer-reachability-${signer.id} --rm -i --restart=Never \\
  --image=curlimages/curl:8.20.0 -- \\
  curl -fsS '${signer.endpoint}/health'`)
    .join('\n\n')
  const directSignNotice = input.preTsukiDirectSign
    ? `## Temporary pre-Tsuki direct-sign recovery

This bundle enables the Issue #843 **testnet-only** recovery capability through
L2 batch height \`${input.preTsukiDirectSign.maxEndBatchHeight}\`. The bridge
operator must configure that exact same pin on Withdrawal Processor and TSO.
After restart, inspect the signer \`/policy\` response: the
\`advance_l1_pre_tsuki_direct_sign\` and
\`advance_l2_pre_tsuki_direct_sign\` capabilities must be serving. They are
excluded from \`/ready\`, so readiness alone does not verify this posture.

After the authoritative completion predicate is stable, retire in reverse
order: remove the WP posture, then remove
\`${PRE_TSUKI_DIRECT_SIGN_ATTESTATION_SIGNER_ENV}\` from this signer policy and
restart it, then remove the TSO pin. Never enable proof mode while this temporary
posture remains configured.

`
    : ''

  return `# Partner attestation-signer commands

Generated for DogeOS network \`${input.network}\` in proof-system mode \`${input.mode}\`.
This bundle selects \`${profile.policyMode}\` and proof artifact fetch mode
\`${profile.proofArtifactFetchMode}\`.

## Addresses fixed by this deployment

| Purpose | Address |
|---|---|
| signer → TSO callbacks | \`${input.tsoUrl}\` |
${input.mode === 'disabled' ? '' : `| signer → accepted proof HTTPS GET root | \`${input.signerProofArtifactBaseUrl}\` |`}

| Signer id | TSO → signer base URL | Genesis public key |
|---|---|---|
${signerRows}

The signer endpoint must be the IP/domain reachable **from the bridge
operator's TSO network**. Use a TLS domain in production, or a private
\`http://<vpn-ip>:4040\` endpoint for an isolated mock/VPN test. Do not publish
\`localhost\`, a Docker-only hostname, or a Kubernetes service name.

## Phase A — partner creates and exposes its signer before bridge genesis

Run from the root of \`scroll-sdk/partner-kit/attestation-signer\`. Select the
block for the signer your organisation operates; run only that block:

${signerSelections}

Then run the common deployment commands:

\`\`\`bash
export DOGE_NETWORK='${input.network}'

# Specify the TSO-reachable IP/domain once. signer preflight reuses it from the descriptor.
scrollsdk signer init \\
  --id "$SIGNER_ID" \\
  --network "$DOGE_NETWORK" \\
  --endpoint "$SIGNER_ENDPOINT"

cp "signer-$SIGNER_ID/attestation-signer.env" docker-compose/
chmod 600 docker-compose/attestation-signer.env
mkdir -p docker-compose/policy
docker compose --project-directory docker-compose config --quiet
docker compose --project-directory docker-compose up -d

curl -fsS http://127.0.0.1:4040/health
curl -fsS "$SIGNER_ENDPOINT/health"
scrollsdk signer preflight --dir "signer-$SIGNER_ID"
\`\`\`

Send \`signer-$SIGNER_ID/descriptor.json\` to the bridge operator. The bridge
operator imports all descriptors with \`scrollsdk setup attestation-signer
--threshold <T>\` **before** bridge genesis. Descriptor import is deliberately
offline; this successful partner preflight is the runtime public-key probe.

For an AWS KMS signer, use the same command with \`--backend aws-kms\` and the
KMS flags. For a production policy, the operator-owned
\`attestation-signer.env\` must also contain the approved image pins generated
or supplied during image approval:

\`\`\`dotenv
ATTESTATION_SIGNER_ALLOWED_RELEASE_VERSION=<approved CARGO_PKG_VERSION>
ATTESTATION_SIGNER_ALLOWED_GIT_COMMIT=<approved full git sha>
ATTESTATION_SIGNER_ALLOWED_SIGNING_POLICY_VERSION=1
\`\`\`

## Phase B — partner applies this bundle after bridge genesis

Place this directory at \`signer-policy-bundle/\` next to \`docker-compose/\`,
select/export your \`SIGNER_ID\` again, derive the previously verified endpoint
from its descriptor, then run:

\`\`\`bash
export SIGNER_ID='<your signer id from the table above>'
export SIGNER_ENDPOINT="$(SIGNER_ID="$SIGNER_ID" node -p 'JSON.parse(require("fs").readFileSync("signer-" + process.env.SIGNER_ID + "/descriptor.json", "utf8")).endpoint')"

cp signer-policy-bundle/signer-policy.env docker-compose/signer-policy.env
cp signer-policy-bundle/protocol_context.json docker-compose/policy/protocol_context.json
cp signer-policy-bundle/verifier-registry.toml docker-compose/policy/verifier-registry.toml
cp signer-policy-bundle/source-set.toml docker-compose/policy/source-set.toml

# The deployment-wide recovery pin belongs only to signer-policy.env. Refuse a
# stale manual copy that could silently survive a generated retirement bundle.
if grep -q '^${PRE_TSUKI_DIRECT_SIGN_ATTESTATION_SIGNER_ENV}=' docker-compose/attestation-signer.env; then
  echo '${PRE_TSUKI_DIRECT_SIGN_ATTESTATION_SIGNER_ENV} must not be set in operator-owned attestation-signer.env' >&2
  exit 1
fi

docker compose --project-directory docker-compose config --quiet
docker compose --project-directory docker-compose up -d

# Partner-side outbound checks: both addresses must be reachable from this network.
curl -fsS '${input.tsoUrl}/health'
curl -fsS "$SIGNER_ENDPOINT/health"
\`\`\`

${input.mode === 'disabled'
    ? 'Direct-sign acceptance requires the signer to receive `POST /sign` without proof artifacts and submit its signature callback to the TSO.'
    : 'The proof GET root cannot be meaningfully health-checked without a concrete object key. The end-to-end withdrawal test is authoritative: the signer must fetch every `required_proof_artifacts[].proof_artifact_fetch.url` and submit its signature callback to the TSO.'}

${directSignNotice}
## Bridge-operator reachability check

Before genesis, the bridge operator imports the descriptors:

\`\`\`bash
scrollsdk setup attestation-signer --threshold <T>
\`\`\`

After K8s deployment, repeat the network check from the cluster namespace so a
developer-laptop route cannot hide a TSO-network failure:

\`\`\`bash
${clusterProbes}
\`\`\`

${input.mode === 'disabled'
    ? 'Disabled-mode acceptance ends at the direct attestation signature and callback; proof coordinator, proof storage, verifier registry membership, and prover worker are outside this posture.'
    : 'Mock acceptance requires descriptor import, policy delivery, TSO request, signer proof fetch, callback, and persisted audit trail. It uses deterministic proof bytes and the audited `staging_scaffold` policy.'}
`
}
