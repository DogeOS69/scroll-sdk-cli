# Prepare CubeSigner configuration, then verify activation

Prepare complete production configuration before Council approval. Install the
signer only after execution of the exact attachment and fresh activation checks.
Preparation, activation and real signing acceptance are separate outcomes.

This workflow uses Core's [governance tool](https://github.com/DogeOS69/dogeos-core/blob/7bf8fcefb34bfeb1fd835193b1b8500cd0f48549/tools/cubesigner/governance/README.md)
and [TEE key runbook](https://github.com/DogeOS69/dogeos-core/blob/7bf8fcefb34bfeb1fd835193b1b8500cd0f48549/docs/runbooks/cubesigner-tee-key-operations.md)
at commit `7bf8fcefb34bfeb1fd835193b1b8500cd0f48549`. That runbook is a draft,
conditional on its production decisions and disposable-organization acceptance.
CLI validation does not certify those decisions or organization export/history
controls. The CLI implements an evidence adapter and verifier, not Council voting.

## Prerequisites and private workspace

Use a private deployment directory outside Git. Keep evidence files mode 0600
and directories mode 0700. Use one writer at a time. The authenticated management
session defaults to the `cs` session file; `CUBESIGNER_MANAGEMENT_TOKEN_FILE` or
`--session-file` selects another file. Never put a session token on the command
line or in expected-policy inputs.

The release owner supplies the actual deployment-specific policy source/script
commits (or approved compiler image), independently reproduced Wasm hash, test
report, program/verifier identity digests, and full resolver URL. The governance
owner supplies the reviewed Core config/state and a bounded runtime-session
lifetime. Council members cannot also be the configured owner, operator,
publisher or proposer. Use the reviewed quorum; there is no default 2-of-2 policy.

Build the pinned Core tool in a separate checkout; keep its package pins:

```bash
git -C "$CORE_REPO" worktree add --detach "$GOVERNANCE_CHECKOUT" \
  7bf8fcefb34bfeb1fd835193b1b8500cd0f48549
cd "$GOVERNANCE_CHECKOUT/tools/cubesigner/governance"
npm install
npm test
node dist/src/main.js --help
```

In subsequent commands, `GOV` is the absolute path to that `dist/src/main.js`;
`GOV_CONFIG`, `GOV_STATE` and `GOV_LOG` are absolute private paths. Mutation
commands default to dry run. Review each preview before its explicit `--apply`.
If a remote operation times out, read its current object/version and existing
log before retrying. A missing local checkpoint never means a mutation failed.

## 1. Context, proof materials and reviewed policy build

From the directory containing the selected spec and environment inputs:

```bash
scrollsdk setup plan
scrollsdk setup genesis
scrollsdk setup aws
scrollsdk setup bridge-funding
# Complete the reported funding handoff; resume this same stage as needed.
scrollsdk setup protocol-context
scrollsdk setup proof-materials
scrollsdk setup policy-prepare
```

`proof-materials` now only imports, bakes, exports and checks proof material.
It does not publish artifacts, attach policy, create sessions or publish a kit.
`policy-prepare` independently follows protocol context; it can run before the
proof bake. Actual program/VK artifacts are required when preparing the expected
policy below. `--non-interactive` alone does not select standalone or mock mode.
Standalone use requires `--generation` or `--preparation-receipt` explicitly.

For an external reproducible build, follow the
[external build/import commands](cubesigner-external-policy.md#1-prepare-the-public-protocol-inputs-and-build),
then `cubesigner-policy import` and resume `policy-prepare`. An image export is
an alternative only if the reviewed release selects it. Imports verify hashes
and declared provenance; independent reproduction remains the builders' task.

Share only reviewed public context bytes, public Bridge redeem script, resolver
URL and release artifacts. Do not distribute `.data/bridge.json` wholesale,
wallet inputs, management sessions, or the entire deployment directory.
Preserve the context/genesis/selected key. Never replace a deployment commitment
with a canonical test fixture or infer an identity digest from an executable hash.

## 2. Publish once and prepare expected inputs

The publisher first reads the existing version. If this artifact is already
published, reuse its returned version; do not publish again to repair local state.

```bash
node "$GOV" publish --config "$GOV_CONFIG" --state "$GOV_STATE" \
  --log "$GOV_LOG" --wasm "$WASM_FILE" --sha256 "$REVIEWED_WASM_SHA256"
# After reviewing the preview, the authorized publisher executes that same command with --apply.
```

Set `POLICY_NAME` and `POLICY_VERSION` from the returned provider identity, with
`POLICY_VERSION=v1` or later. `v0`, `latest`, unknown hashes and placeholder
resolver paths cannot produce complete expected production values.

Now enter the generated directory; all following CLI examples use `--dir .`:

```bash
cd "$DEPLOYMENT"
scrollsdk setup cubesigner-policy prepare-input --dir . \
  --environment "$CUBESIGNER_ENVIRONMENT" --organization "$CUBESIGNER_ORG_ID" \
  --policy "$POLICY_NAME/$POLICY_VERSION" \
  --program-identity-digest "$REVIEWED_PROGRAM_IDENTITY_DIGEST" \
  --verifier-identity-digest "$REVIEWED_VERIFIER_IDENTITY_DIGEST" \
  --resolver-base-url "$REVIEWED_PROOF_ARTIFACT_BASE_URL" \
  --tests "$REVIEWED_TEST_REPORT" --requires-live-evidence
scrollsdk setup cubesigner-policy prepare --dir . \
  --input .scrollsdk/inputs/cubesigner-policy/preparation.json --json
scrollsdk setup proof-publish --dir .
scrollsdk setup signer-kit --dir .
```

Use `--no-requires-live-evidence` **only when that is the reviewed release's
requirement**. It is never a workaround for missing acceptance. If already
available, supply `--live-evidence` to `prepare-input` with the reviewed report.
The test report must contain its real `result`, `coreRevision`, `wasmSha256`,
`protocolContextSha256` and compiled `bindings`. The latter bind the full
`proofArtifactBaseUrl`, `namespaceId`, `teePublicKey`, `bridgeKeyHash`,
`bridgeProgramCommitment` and `aggregateVkIdentity`. Obtain this report from the
release's real tests; neither CLI command creates passing test evidence.

`prepare-input` derives the known fields from current artifacts. `prepare` checks
all references and the remotely published immutable version and archives them
under `.data/cubesigner-policy-prepared/`; its selection is
`.scrollsdk/inputs/cubesigner-policy/expected.json`. No attachment receipt is
created. Interrupted local archive publication resumes through readback.
The configuration compiler imports this selection without changing frozen intent.

`proof-publish` is an explicit cloud publication boundary. `signer-kit` is local;
`signer-kit-publish` separately publishes under saved S3 intent or waits for the
existing reviewed publication record. Run it when ready:

```bash
scrollsdk setup signer-kit-publish --dir .
```

Its pending handoff does not prevent unrelated render or Secret upload. Other
services may be installed, but dependencies requiring TEE signatures can remain
blocked. This is not a claim the whole chain is operational.

## 3. Prepare runtime credentials now, or defer them

Create the durable governance handoff using the existing Core config/state/log.
An empty existing log is allowed before a proposal; no approval is required to
prepare a session for an already authorized role.

```bash
scrollsdk setup cubesigner-policy handoff --dir . --kind sealed-upgrade \
  --config "$GOV_CONFIG" --state "$GOV_STATE" --operations "$GOV_LOG" \
  --session-lifetime "$REVIEWED_SESSION_LIFETIME_SECONDS" --json
scrollsdk setup render --dir .
scrollsdk setup upload-secrets --dir .
```

The runtime step validates the expected material and role access independently
of the attachment. It reuses a valid local seed after checking remote session
metadata; otherwise it explicitly creates a session with exactly
`sign:btc:psbt:doge`, auth 300 seconds, refresh 86400 seconds and the reviewed
maximum lifetime. Session creation is a provider mutation. It does not change
key policy, vote, upload the seed or restart pods.

To defer only the signer credentials:

```bash
scrollsdk setup render --dir . --defer-cubesigner
scrollsdk setup upload-secrets --dir . --defer-cubesigner
```

Deferred steps stay incomplete. Stale signer files are excluded from unrelated
upload. Later, rerun render and upload without the flag; completed unrelated
steps are not repeated. A valid seed is reused, never automatically rotated.

An interrupted creation leaves `.scrollsdk/cubesigner-session-creation.json`.
If the provider may have created a session but the seed was not saved, recover
the private seed or explicitly revoke that session before archiving the journal
and retrying. File existence alone does not establish a usable session. Expired,
revoked or overly broad sessions require explicit operator recovery/rotation.
Each instance needs its own seed and writable refresh cache; do not share caches.

## 4. Propose, approve, execute the identical request

The proposer previews and executes the exact attachment while retaining
`RequireRoleSession` and the concrete `NamedPolicy#…/vN` entry. An unexpected
additional policy requires review; it must not be silently removed.

```bash
node "$GOV" attach --config "$GOV_CONFIG" --state "$GOV_STATE" \
  --log "$GOV_LOG" --version "$POLICY_VERSION"
node "$GOV" attach --config "$GOV_CONFIG" --state "$GOV_STATE" \
  --log "$GOV_LOG" --version "$POLICY_VERSION" --apply
node "$GOV" mfa "$MFA_ID" --config "$GOV_CONFIG" > "$APPROVAL_SNAPSHOT"
```

Exit 10 or an MFA ID means pending, not executed. Council members independently
review the exact method, path, complete body, environment/org/key/role, immutable
version and reproduced Wasm hash. Each authorized Council member uses their own
session, according to the selected MFA policy:

```bash
cs mfa get --mfa-id "$MFA_ID"
cs mfa approve-fido --mfa-id "$MFA_ID"
# A rejection is explicit: cs mfa reject-fido --mfa-id "$MFA_ID"
```

**Approval does not execute.** Capture each completed approval snapshot before
execution; the request can disappear afterward. The proposer resubmits the
identical config/state/version with all required `--mfa` IDs:

```bash
node "$GOV" mfa "$MFA_ID" --config "$GOV_CONFIG" > "$APPROVAL_SNAPSHOT"
node "$GOV" attach --config "$GOV_CONFIG" --state "$GOV_STATE" \
  --log "$GOV_LOG" --version "$POLICY_VERSION" --apply --mfa "$MFA_ID"
scrollsdk setup cubesigner-policy handoff --dir . --kind sealed-upgrade \
  --config "$GOV_CONFIG" --state "$GOV_STATE" --operations "$GOV_LOG" \
  --approval "$APPROVAL_SNAPSHOT" \
  --session-lifetime "$REVIEWED_SESSION_LIFETIME_SECONDS" --json
scrollsdk setup cubesigner-policy verify-activation --dir . --policy-only --json
```

Repeat `--approval` and `--mfa` for multiple IDs. The adapter accepts the pinned
Core `mfa` output including its final `RESULT:` line and JSONL operation log.
It pins private copies and refuses a silently changed request/Council/lifetime.
A rejection deletes the request; missing snapshots are reported unknown, never
assumed approved. Expired/partial/mismatched approvals fail. After timeout, inspect
current attachment and preserve the successful operation record; do not republish,
reattach or change genesis solely to repair a local checkpoint.

Policy-only verification still exits nonzero because credentials/delivery have
not been checked. Its private report distinguishes those missing checks.
The full verifier uses role-scoped key access and a fresh signed **Full role
attestation**, including the nested key, with provider-trusted JWKS. Owner-only
key attestation is not required. It checks Council seals, quorum/members/MFA,
ACLs, owner/type, exact request and execution. Approval snapshots and operation
logs are reviewed Core evidence, not independently signed provider audit history;
that limitation is reported separately from fresh binding/attestation checks.

For an existing approved attachment, import the original config/state/log and
approval evidence and read back its version. For older receipts lacking complete
material bindings, run `prepare-input` and `prepare` for that same published
version; the original verified receipts remain intact. Do not initiate a fresh approval
round. Legacy `cubesigner-policy reconcile` remains available for verified
release/attachment receipts; `expected.json` never substitutes for those receipts.

## Initial provisioning differs from a sealed upgrade

Use the pinned Core setup sequence: check, create-role, create-policy, create-key,
add-key, add-operator, optional set-key-acl, publish/attach v1 or later, seal, verify.
Preview mutations, then apply them with the correct owner/operator identities.
The new key must remain unregistered and unfunded until sealing and verification;
finish this external provisioning before relying on it in production funding.
Do not use the sealed-upgrade approval sequence for every unsealed setup operation.

After reviewing that history, archive an initial handoff instead:

```bash
scrollsdk setup cubesigner-policy handoff --dir . --kind initial-provisioning \
  --config "$GOV_CONFIG" --state "$GOV_STATE" --operations "$GOV_LOG" \
  --initial-seal-last-reviewed \
  --session-lifetime "$REVIEWED_SESSION_LIFETIME_SECONDS" --json
```

That explicit flag records the operator's reviewed unregistered/unfunded and
seal-before-registration declaration; it is not an on-chain proof. An existing
reviewed report can instead be supplied with `--provisioning`. Activation still
requires fresh sealed object state, exact execution and signed attestation.
Organization export/history controls and initial chain history remain explicit
external acceptance checks; a boolean declaration does not independently verify them.

## 5. Deliver Secrets and use the guarded installation target

Finish any deferred render/upload first. If ExternalSecrets has not yet been
installed for the signer, apply **only** its SecretStore/ExternalSecret resources
so the controller can deliver the uploaded seed before any signer pod exists.
For example, with Helm and `yq` v4, from the deployment directory:

```bash
helm template cubesigner-signer oci://ghcr.io/dogeos69/scroll-sdk/helm/cubesigner-signer \
  --version 0.1.9 --namespace "$NAMESPACE" \
  --values values/cubesigner-signer-production.yaml \
  | yq 'select(.kind == "SecretStore" or .kind == "ExternalSecret")' \
  | kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" apply -f -
```

Review the rendered destination resources before applying them. This command is
an explicit Kubernetes mutation and creates no signer workload. Apply the prepared `protocol-context-config` ConfigMap using
`make install-scroll-common KUBE_CONTEXT="$KUBE_CONTEXT" NAMESPACE="$NAMESPACE"`, and wait for both
`cubesigner-signer-env` and `cubesigner-signer-session` to be delivered. Avoid
printing Secret data; activation compares their contents in memory.

```bash
scrollsdk setup cubesigner-policy verify-activation --dir . \
  --kube-context "$KUBE_CONTEXT" --namespace "$NAMESPACE" --json
make install-cubesigner-signer KUBE_CONTEXT="$KUBE_CONTEXT" NAMESPACE="$NAMESPACE"
```

The companion **scroll-sdk** `examples/Makefile.example` change runs activation
again immediately before Helm, with the same context/namespace/chart/version/
values. It checks effective rendered env entries, key Secret indirection,
read-only seed mount, one replica/private cache, current provider bindings and
the actual delivered seed. A cached success report never authorizes installation.
A read-only preflight cannot eliminate a provider change between check and install;
the Core signer retains its static runtime readiness checks.

Existing operator Makefiles are preserved. Update only their
`install-cubesigner-signer` recipe by adding this line immediately before the
existing Helm command (with a real tab):

```make
	scrollsdk setup cubesigner-policy verify-activation --dir . --kube-context "$(KUBE_CONTEXT)" --values values/cubesigner-signer-production.yaml --chart oci://ghcr.io/dogeos69/scroll-sdk/helm/cubesigner-signer --chart-version 0.1.9 --namespace "$(NAMESPACE)"
```

Pinned older SDK revisions do not inherit this template change. Ship/select the
companion revision before claiming generated installs are guarded. Raw `helm`
can bypass the Make target; this is not Kubernetes admission enforcement.
The verifier itself never installs, restarts, signs, approves or rotates.

## 6. Keep live acceptance separate

The activation report at `.scrollsdk/cubesigner-activation.json` never claims an
installation occurred. After explicit installation, verify running WP transport
`bridge_proof_ref_v1`, gateway production mode, immutable identifier and digest,
and the actual mounted protocol context. Run the existing
`setup proof-config-check --live` for its documented topology checks; those alone
are not a signing/denial test.

Use the release's controlled acceptance harness and archive real positive proof
retrieval/signing and tampered or mismatched proof rejection **before native
signing**. Record proof/store readback evidence, running pins, policy/key/context,
request/response hashes and the positive/negative results. An empty-request
rejection, unit fixture, testnet fallback or import check does not establish this.
Do not broadcast real withdrawals to test CLI orchestration.

When the release requires live evidence before production activation, use the
pinned runbook's separately governed, unregistered/unfunded mainnet-type canary
and approved real proof/PSBT fixtures first. The canary must use the reviewed
context/resolver/program policy; an unrelated testnet result cannot qualify the
production release. Preserve its scoped evidence and the release owner's explicit
production binding. Do not disable the requirement to break a dependency cycle.

Import the actual reviewed exercise report without rebaking or rewriting unrelated values:

```bash
scrollsdk setup cubesigner-policy import-acceptance --dir . --report "$REVIEWED_LIVE_REPORT" --json
scrollsdk setup cubesigner-policy verify-activation --dir . --kube-context "$KUBE_CONTEXT" --namespace "$NAMESPACE" --json
```

The imported report contract extends the existing bound live evidence with
`schema: scrollsdk/cubesigner-live-acceptance/v1`, `result: passed`,
`policyIdentifier`, `keyId`, `protocolContextSha256`, `policyArtifactDigest`,
`realProofSigned`, `tamperedProofDeniedBeforeNativeSigning`, `artifactStoreReadback`,
`wpTransport: bridge_proof_ref_v1`, and
`gatewayMode: production_verifier_key_policy`. It also requires `proofArtifactUrl`, `proofSha256`, `signingResponseSha256` and
`denialResponseSha256` identifying the archived real exercise. These fields must come from the
reviewed real exercise, never be invented to satisfy a gate. CLI validation of a
reviewed report is not independent reproduction of that exercise. A canary report explicitly sets `scope: canary`, preserves the actual canary
`keyId`, and adds `targetKeyId`, `canaryKeyType: SecpDogeAddr`,
`canaryUnregisteredAndUnfunded`, `canaryGovernanceVerified` and
`productionBindingReviewed`. The release owner must review that binding; the
immutable policy, Wasm, context and resolver remain exact. The CLI does not
replace the canary key ID with the production key. Its status is
`canary-evidence-validated-production-not-verified`, not production acceptance.
Legacy verified receipt consumers retain their original same-key requirement.
No report means acceptance remains `not-verified`.

## Resume and status

Only plans with the current workflow steps can resume. Older workflow layouts
are not migrated: a mismatch fails before any step runs or saved state changes.
Within the current workflow, completed steps and valid sessions are reused;
deferred session preparation/upload resumes independently. Never delete state
or rerun genesis to resume a governance wait.

The build handoff, expected-policy selection, governance handoff and activation
report have distinct meanings. Handoff outcomes separately show build, published
version, proposal, per-ID approval state, recorded execution, binding verification,
governance and live acceptance. Recorded is not verified. Preparation success
always leaves signer activation pending until the fresh guard succeeds.
