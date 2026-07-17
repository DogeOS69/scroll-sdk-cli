import type { ProvingMode } from './withdrawal-config.js'

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
  network: string
  protocolInstanceId: string
  provingMode: ProvingMode
  signerProofArtifactBaseUrl: string
  signers: SignerPolicyBundleSigner[]
  supportedSigningPolicyVersions: string
  teeAllowedSignerIds: string
  tsoUrl: string
}

export interface SignerRuntimePolicyProfile {
  allowUnimplementedChecks: boolean
  policyMode: 'production_enforce' | 'staging_scaffold'
}

/**
 * mock mirrors e2e_harness: it runs the real signer and all implemented
 * checks, but explicitly records/bypasses production checks that cannot accept
 * deterministic non-cryptographic proof bytes. production remains fail-closed.
 */
export function signerRuntimePolicyProfile(provingMode: ProvingMode): SignerRuntimePolicyProfile {
  return provingMode === 'mock'
    ? { allowUnimplementedChecks: true, policyMode: 'staging_scaffold' }
    : { allowUnimplementedChecks: false, policyMode: 'production_enforce' }
}

export function renderSignerPolicyEnv(input: SignerPolicyBundleInput): string {
  const profile = signerRuntimePolicyProfile(input.provingMode)
  return [
    `# Post-genesis ${input.provingMode} proof policy for a partner-operated attestation-signer.`,
    '# Apply next to the operator-owned WIF/KMS and release-pin settings, then restart.',
    input.provingMode === 'mock'
      ? '# MOCK: real service/transport/policy flow with deterministic NON-cryptographic proofs; unimplemented production checks are audited and bypassed.'
      : '# PRODUCTION: fail-closed policy; the operator must also pin the approved signer image release + git identity in attestation-signer.env.',
    `ATTESTATION_SIGNER_POLICY_MODE=${profile.policyMode}`,
    `ATTESTATION_SIGNER_ALLOW_UNIMPLEMENTED_CHECKS=${profile.allowUnimplementedChecks}`,
    `ATTESTATION_SIGNER_NETWORK=${input.network}`,
    `ATTESTATION_SIGNER_PROTOCOL_INSTANCE_ID=${input.protocolInstanceId}`,
    `ATTESTATION_SIGNER_BRIDGE_NAMESPACE_ID=${input.bridgeNamespaceId}`,
    `ATTESTATION_SIGNER_ACTIVE_BRIDGE_KEY_HASH=${input.activeBridgeKeyHash}`,
    `ATTESTATION_SIGNER_SUPPORTED_SIGNING_POLICY_VERSIONS=${input.supportedSigningPolicyVersions}`,
    'ATTESTATION_SIGNER_VERIFIER_REGISTRY_TOML=/etc/dogeos/verifier-registry.toml',
    'ATTESTATION_SIGNER_SOURCE_SET_TOML=/etc/dogeos/source-set.toml',
    `ATTESTATION_SIGNER_TEE_ALLOWED_SIGNER_IDS=${input.teeAllowedSignerIds}`,
    `ATTESTATION_SIGNER_ENVELOPE_ALLOWED_TEE_SIGNER_IDS=${input.teeAllowedSignerIds}`,
    `ATTESTATION_SIGNER_ENVELOPE_ALLOWED_PROOF_TRIPLES=${input.allowedProofTriples}`,
    `ATTESTATION_SIGNER_ENVELOPE_MAX_PROOF_ARTIFACTS=${DEFAULT_ENVELOPE_MAX_PROOF_ARTIFACTS}`,
    `ATTESTATION_SIGNER_TSO_URL=${input.tsoUrl}`,
    'ATTESTATION_SIGNER_TSO_CALLBACK_PHASE=attestation',
    'ATTESTATION_SIGNER_PROOF_ARTIFACT_FETCH_MODE=http',
    '',
  ].join('\n')
}

/**
 * Put the exact, address-bearing two-party procedure in the artifact sent to
 * partners. This makes the operator handoff itself reviewable/testable, rather
 * than relying on a generic runbook that can drift from the generated policy.
 */
export function renderPartnerCommands(input: SignerPolicyBundleInput): string {
  const profile = signerRuntimePolicyProfile(input.provingMode)
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

  return `# Partner attestation-signer commands

Generated for DogeOS network \`${input.network}\` in \`${input.provingMode}\` proving mode.
The partner commands and network directions are the same in mock and production;
only the delivered signer policy profile and proof implementation differ. This
bundle selects \`${profile.policyMode}\`.

## Addresses fixed by this deployment

| Purpose | Address |
|---|---|
| signer → TSO callbacks | \`${input.tsoUrl}\` |
| signer → accepted proof HTTPS GET root | \`${input.signerProofArtifactBaseUrl}\` |

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
docker compose --project-directory docker-compose up -d

curl -fsS http://127.0.0.1:4040/health
curl -fsS "$SIGNER_ENDPOINT/health"
scrollsdk signer preflight --dir "signer-$SIGNER_ID"
\`\`\`

Send \`signer-$SIGNER_ID/descriptor.json\` to the bridge operator. The bridge
operator imports all descriptors with \`scrollsdk setup attestation-signer
--probe\` **before** bridge genesis.

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
cp signer-policy-bundle/verifier-registry.toml docker-compose/policy/verifier-registry.toml
cp signer-policy-bundle/source-set.toml docker-compose/policy/source-set.toml

docker compose --project-directory docker-compose config --quiet
docker compose --project-directory docker-compose up -d

# Partner-side outbound checks: both addresses must be reachable from this network.
curl -fsS '${input.tsoUrl}/health'
curl -fsS "$SIGNER_ENDPOINT/health"
\`\`\`

The proof GET root cannot be meaningfully health-checked without a concrete
object key. The end-to-end withdrawal test is the authoritative check: the
signer must receive \`POST /sign\`, fetch every full
\`required_proof_artifacts[].proof_artifact_fetch.url\`, and submit its
signature callback to the TSO.

## Bridge-operator reachability check

Before genesis, the bridge operator runs:

\`\`\`bash
scrollsdk setup attestation-signer --threshold <T> --probe
\`\`\`

After K8s deployment, repeat the network check from the cluster namespace so a
developer-laptop route cannot hide a TSO-network failure:

\`\`\`bash
${clusterProbes}
\`\`\`

Mock acceptance requires the same descriptor import, policy delivery, TSO
request, signer proof fetch, callback, and persisted audit trail as production.
It differs only by using deterministic proof bytes and the explicit audited
\`staging_scaffold\` policy needed for those non-cryptographic proofs.
`
}
