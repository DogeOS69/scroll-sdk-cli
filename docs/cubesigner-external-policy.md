# External CubeSigner policy build and governed attachment

Use this route when the release owner requires Core's
`tools/cubesigner/build-verifier.sh` rather than the CLI compiler image.
This runbook uses placeholders, not production identities. Obtain the exact
policy source commit, build-script commit, independently reproduced Wasm hash,
and Council configuration from the release handoff. Do not infer them from a
moving release branch or from the canonical test genesis.

## 1. Prepare the public protocol inputs and build

Complete `scrollsdk setup protocol-context` after Bridge funding. Preserve the
original `.data/protocol_context.json` bytes and hash; share that public file,
the WP proof artifact base URL, and the genesis Bridge public redeem script
with the release owner. Never share private Bridge configuration or wallet keys.

The source commit contains the deployment's resolver, Bridge commitment, and
namespace. The build-script commit selects the reproducible build procedure;
these are different inputs. Follow Core PR #1495's
`docs/runbooks/cubesigner-tee-key-operations.md` and
`tools/cubesigner/governance/README.md` at the agreed revision.

On Linux, the prescribed script installs its pinned toolchain and WASI SDK:

```bash
bash /path/to/reviewed/build-verifier.sh "$POLICY_SOURCE_COMMIT" "$CORE_REPO"
```

The script replaces `/tmp/dogeos-verifier-build/src`. Preserve previous evidence
and avoid concurrent builds in that directory. Compare the printed Wasm hash
with the independent build. Archive the Wasm, protocol context, Bridge public
artifact, build log, source/script commits and provider readbacks outside Git.
Do not keep the only copy under `/tmp`.

## 2. Publish, propose, approve, and verify

Prefer Core's governance tool with the Council-reviewed `gov.json`. It supports
`publish`, `attach`, `mfa`, and `verify`; mutations are dry runs until `--apply`.
Preserve its state and evidence log. Council approval does not execute an
attachment: replay the identical request with its approval ID after approval.

For an already provisioned rehearsal using `cs` directly, the corresponding
operations are below. Set IDs and paths from the reviewed handoff. Check the
installed CLI version/help and perform each operation only after checking the
preceding response:

```bash
# Read the current policy before publishing; do not accidentally publish twice.
cs policy get --name "$POLICY_NAME" --version latest
cs policy update --name "$POLICY_NAME" "$WASM_FILE"
# Use the returned concrete version, and compare its remote Wasm hash.
cs policy get --name "$POLICY_NAME" --version "$POLICY_VERSION"

# Direct key reads can return UserNotKeyOwner; use the authorized role read.
cs key get --role-id "$ROLE_ID" --key-id "$KEY_ID"
```

`cs key set-policy` replaces the complete signing-policy list. Preserve every
required policy. For exactly the two-entry policy below, prepare the JSON values:

```bash
ROLE_POLICY=$(jq -cn --arg role "$ROLE_ID" '{RequireRoleSession: [$role]}')
VERSION_POLICY=$(jq -cn --arg policy "$POLICY_ID/$POLICY_VERSION" '$policy')

# One --policy per entry. A JSON array in one --policy is not supported by cs 0.181.0.
cs key set-policy --key-id "$KEY_ID" \
  --policy "$ROLE_POLICY" --policy "$VERSION_POLICY"
```

If the existing key has other policies, stop and prepare a reviewed update that
preserves those entries. Do not reduce its policy list to fit this example.
The expected sealed-key response is `202 Accepted` with `MfaRequired`, not a
completed attachment. Read the returned request with `cs mfa get --mfa-id
"$APPROVAL_ID"`; check method/path/body and send its ID and artifact hash to the
Council. Only the authorized approvers perform their approval actions.

After the required approvals, repeat the identical update:

```bash
cs key set-policy --key-id "$KEY_ID" \
  --policy "$ROLE_POLICY" --policy "$VERSION_POLICY" --mfa-id "$APPROVAL_ID"
cs key get --role-id "$ROLE_ID" --key-id "$KEY_ID"
cs policy get --name "$POLICY_NAME" --version "$POLICY_VERSION"
```

Verify the key's policy reference, role restriction, public key and edit policy;
verify the policy hash and attachment relationship. The key object's `version`
is not the named policy version. Save raw readbacks privately with mode 0600.
These API responses do not replace signed attestation verification.

## 3. Import the reviewed external artifact into staged preparation

Run from the operator repository. `--wasm` is relative to `--dir`. The archived
artifact must be inside the deployment directory, with no symlink components.
Use the hashes reviewed in the release handoff:

```bash
scrollsdk setup cubesigner-policy import \
  --dir deployment \
  --wasm .data/policy-evidence/cubesigner_verifier_policy.wasm \
  --expected-wasm-sha256 "$REVIEWED_WASM_SHA256" \
  --expected-protocol-context-sha256 "$REVIEWED_CONTEXT_SHA256" \
  --core-revision "$POLICY_SOURCE_COMMIT" \
  --build-script-revision "$BUILD_SCRIPT_COMMIT" \
  --source-repo "$CORE_REPO" --json
```

The command checks the component header, artifact hash, current protocol-context
hash, both local Git commits, and the script bytes at the selected commit. It
archives the component/checksum and an external-build receipt in
`.data/cubesigner-policy/`, and selects `method: external` in
`.scrollsdk/inputs/cubesigner-policy/compiler.json`. It performs no build,
fetch, provider mutation, or preparation-state edit. Matching retries are safe;
conflicting selections/output require inspection and are not overwritten.
Final proof readiness permits the imported policy source commit to differ from
the proof image release commit. This requires the pinned external-build import
to match the governed policy's source commit and Wasm hash, with the current
protocol context intact. The governed receipt must still match the selected
proof materials' exact Bridge program and aggregate VK file hashes. A different
commit without that verified import remains blocked. Preserve both real source
revisions; do not rewrite a receipt to make them appear identical.
If an earlier run created an image-selection template, preserve and review it
before moving it aside to select the external route.

The receipt explicitly records **operator-declared build provenance**. The
importer cannot prove that arbitrary supplied Wasm was compiled from a supplied
commit, nor that a second operator reproduced it. It is not a compiler-image
receipt and cannot be passed to the limited `cubesigner-policy deploy` command.
Keep the independent comparison and build evidence with it.

## 4. Reconcile an already approved attachment

`deployment/v2` is an operation record from the limited `deploy` command; it is
not interchangeable with the `release/v1` and `attachment/v1` preparation
schemas. Do not rename its `schema` field. Use the read-only reconciliation
command for an existing immutable policy version:

```bash
scrollsdk setup cubesigner-policy reconcile \
  --dir deployment \
  --input .data/policy-review.json \
  --json
```

All input file references below are relative to the deployment directory, with
pinned SHA-256 hashes. The input is a reviewed release description, **not a
provider response**. Replace placeholders only with verified release data.
The command cannot infer program/verifier identity semantics from arbitrary
Wasm; obtain those values from the matching release. It does not run tests or
turn a build success into a passing test report.

```json
{
  "environment": "gamma",
  "organization": "Org#REPLACE",
  "key": {"keyId": "Key#REPLACE", "materialId": "REPLACE", "roleId": "Role#REPLACE"},
  "buildReceipt": {"path": ".data/cubesigner-policy/build-receipt.json", "sha256": "REPLACE"},
  "bridgeProgram": {"path": ".data/release/bridge-state.vmexe", "sha256": "REPLACE"},
  "aggregateVerifyingKey": {"path": ".data/release/aggregate-vk", "sha256": "REPLACE"},
  "release": {
    "coreRevision": "REPLACE_WITH_FULL_POLICY_SOURCE_COMMIT",
    "policyIdentifier": "example-policy/v2",
    "sdkVersion": "0.4.281",
    "requestContract": "dogeos-cubesigner-compact-psbt-bridge-proof-ref-v1-sign-all-scripts-false-unprefixed-hex-explain-v3",
    "proofResolverAuthority": "https://proofs.example.com",
    "protocolContextSha256": "sha256:REPLACE",
    "programIdentityDigest": "sha256:REPLACE",
    "verifierIdentityDigest": "sha256:REPLACE",
    "verifierProvenance": {
      "bridgeProgramSha256": "sha256:REPLACE",
      "aggregateVerifyingKeySha256": "sha256:REPLACE"
    },
    "wasm": {"path": ".data/cubesigner-policy/cubesigner_verifier_policy.wasm", "sha256": "sha256:REPLACE"},
    "tests": {"path": ".data/policy-tests.json", "sha256": "sha256:REPLACE", "result": "passed"},
    "requiresLiveEvidence": false
  }
}
```

Set `requiresLiveEvidence` to the actual reviewed release requirement, not to
whatever makes preparation pass. When required (or when already collected),
add a top-level `liveEvidence: {"path": "…", "sha256": "sha256:…"}` reference.
The existing validator checks its result, key, policy version and context.
Without it, reconciliation explicitly reports `liveAcceptance: not-verified`.

The test report must contain `result: "passed"`, the full `coreRevision`,
`wasmSha256` and `protocolContextSha256` (both hashes prefixed with `sha256:`).
Include the actual commands, scope, results and retained log references in
that report. It is operator-supplied evidence: the CLI verifies its bindings
and file hash, not whether an assertion in the report is truthful. Do not
create a passing report until the applicable release tests have run. Local
release tests and real-proof signing/denial acceptance are separate.

Reconciliation verifies the selected key/role against saved deployment config,
uses the role-scoped key GET endpoint, checks the session environment/org,
remote immutable version and Wasm hash, enabled key/role, the exact
`RequireRoleSession` plus named-policy pair, reverse attachment, and current
resolver allowlist. It never uploads, attaches, signs, requests approval,
changes ownership, or writes the allowlist. Owner-only key attestation is not
required. No governance approval is inferred solely from a local file.

On success it archives the release, attachment, local reports, build receipt,
Wasm, context and minimal provider readback in a **new**
`.data/cubesigner-policy-reconciled/` directory, validates them using the same
consumer as preparation, and fills `.scrollsdk/inputs/cubesigner-policy/receipts.json`.
It replaces only the untouched waiting template (or creates an absent selection).
Existing populated selections and output directories are refused. Use `--output`
with a new relative directory after inspecting partial output from an interrupted
run. A context change requires evidence for the new context.

The command does not edit frozen intent, configuration or checkpoints. Resume
the normal stage to import the verified references. Keep the evidence directory
private; the public examples here deliberately contain no deployment identities.

## 5. Resume and complete signer-side acceptance

When ready to run the remaining operations in the saved plan, resume
`scrollsdk setup proof-materials`. The policy step validates the import against
the current context and does not rebuild or repeat governance. Later steps
still require production release/attachment receipts and their test evidence;
see [receipt requirements](proof-config-transactions.md#cubesigner-receipts-and-external-signer-evidence).
Do not label API snapshots as these receipts or manually complete state steps.

Signer-side acceptance remains separate:

1. Verify the generated and running WP sends `bridge_proof_ref_v1`; verify the
   gateway uses production mode with the exact approved version and digest.
2. Demonstrate signing with a valid real proof, including successful policy
   retrieval from the actual proof bucket.
3. Demonstrate denial for a tampered or mismatched proof. For a mainnet-type
   key, a logged fallback is not a denial and does not pass this check.

Use the release's controlled test procedure and record actual results. Never
invent a passing test report to satisfy configuration validation. Build import,
Council approval, provider readback, and runtime acceptance are distinct states.
