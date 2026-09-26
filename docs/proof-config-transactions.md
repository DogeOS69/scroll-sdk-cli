# Proof configuration generations

The source-free path uses a **complete** `dogeos-proof-release-v1.json` and its
SHA-256. The manifest binds six immutable images, one core revision, the five
generic Scroll files, Rust/OpenVM/Scroll provenance and the exact publication
mapping. The historical two-image inventory is not a substitute.

PR #1177 remains unmerged. Consult [the build inventory](proof-tool-images-pr1177.json)
for verified build status. Passing unit tests or publishing candidate images is
not production policy approval or a real-proof end-to-end result.

The PR #1177 candidate is available as
[`dogeos-proof-release-pr1177.json`](dogeos-proof-release-pr1177.json), SHA-256
`51645abda8736504dfb82ae16578297b66ec4b7fa26a718885c95c21aff2a2ef`.
All six images were built at core revision
`6700d4baca0830bb5ac26bfee5a17c53aa725c42`; finalization at the later tooling/evidence
commit validates those unchanged image digests. The GPU identity receipt is a
native startup/identity check, not a real-proof end-to-end result.

The anticipated input release arrived on 2026-09-24 as
[`proving-openvm17-0badaf7a-d4e65b65`](https://github.com/DogeOS69/dogeos-core/releases/tag/proving-openvm17-0badaf7a-d4e65b65).
Its manifest SHA-256 is
`1ad8be98f1f818a211c70adb799d71c65497101a7b5a308093c05f02925b4ec2`.
All seven downloads passed size/hash checks. Its five circuit files are identical
to the candidate's existing lock, and the current CLI producer independently
derived all seven matching manifest identities. See the
[verification record](proof-proving-inputs-20260924.json).
The two updated materializers belong to core `d4e65b65`; they must not replace
the binaries in the coherent six-image candidate. The existing release manifest
and its hash remain immutable. The new input release is not itself a complete
six-image proof software release or evidence of a successful GPU proof.

The user selected **isolated E2E only** on 2026-09-24. Do not publish to or update
the existing devnet/testnet deployments as part of this validation. Production
environment/policy selection remains a separate step.

## Existing deployment inputs

Preparation reads `.data/doge-config.toml`, `.data/protocol_context.json`,
`.data/proof-aws.json`, existing `values/`, and the native base-config directories.
It writes a new candidate deployment directory. The active deployment is not
modified. Values/resources/ingress overlays are copied into the candidate before
the proof compiler updates the fields it owns.

AWS bucket, region and prefix come from `proof-aws.json` and must match the
deployment's canonical `ethereumDa.blobArchive.s3`. Do not repeat them in the
request. Coordinator/compiler/Worker images and identities come from the release
and native receipts, not operator-edited commitments.

Example `proof-request.json`:

```json
{
  "deploymentName": "dogeos-devnet",
  "mode": "active",
  "generation": "real",
  "enforcement": "observe",
  "runtime": {
    "observeRealProofDeadlineMs": 1800000,
    "proofCoordinatorPublicUrl": "https://proof-coordinator.example.com",
    "rpcWitnessUrl": "https://l2-rpc.example.com",
    "workerLaunch": "external",
    "workerDeploymentBackend": "docker_compose"
  },
  "tsoUrl": "https://tso.example.com"
}
```

`tsoUrl` may be omitted when the existing `config.toml` has `[ingress].TSO_HOST`.
`observeRealProofDeadlineMs` may be omitted when the existing proof topology
already supplies it; its positive integer value is checked before preparation.
Worker placement is provider-neutral. These commands do not rent a GPU, launch
a Worker, attach a policy or contact Kubernetes.

## Prepare and publish

```bash
scrollsdk setup proof-config prepare \
  --deployment-dir "$DEPLOYMENT_DIR" \
  --request proof-request.json \
  --release dogeos-proof-release-v1.json \
  --release-sha256 "$PROOF_RELEASE_SHA256" \
  --output proof-generations/candidate-001 --json
```

Preparation pulls the digest-pinned images and runs the CPU producer without
network, credentials, GPU access or a writable root filesystem. Host compilation
was performed in CI; the bundled guest builder bakes the instance-bound programs
inside the isolated container. Preparation then checks the Worker image, imports
materials, compiles topology and values, generates the external signer handoff
when external signers are configured, and freezes the S3 publication plan.

All files are staged in a sibling temporary directory. A per-output lock rejects
concurrent preparation for the same destination. Native failures and input drift
leave the destination absent and the active deployment intact. A successful
rename exposes the complete candidate and `proof-config-prepared.json` together.
The command returns the prepared receipt's SHA-256.

For real proving, review or apply that exact prepared receipt:

```bash
scrollsdk setup proof-config publish \
  --receipt "$PREPARED_RECEIPT" --receipt-sha256 "$PREPARED_RECEIPT_SHA256" \
  --json

scrollsdk setup proof-config publish \
  --receipt "$PREPARED_RECEIPT" --receipt-sha256 "$PREPARED_RECEIPT_SHA256" \
  --aws-profile "$AWS_PROFILE" --apply --json
```

Only `--apply` writes S3 objects. The publisher accepts unexpired temporary AWS
credentials, uploads the reviewed 11 files beneath their content-addressed
prefix, preserves bucket configuration, and requires authenticated and anonymous
readback. Local inputs and the publication plan are revalidated before mutation.
Successful publication writes the bound publication receipt and final
`.data/proof-deployment.json` inside the candidate directory. The original
prepared contract remains available for audit.

Mock configuration finishes with `prepare` and has no publication plan. A real
candidate is not finalized if local checks or readback fail. S3 objects already
uploaded on a failed attempt remain content-addressed; the CLI never deletes
shared artifacts as an implicit rollback. Existing receipts/final contracts are
not overwritten by a repeated `publish --apply`.

### Isolated publisher integration test

After `yarn build`, a prepared real candidate can be checked against a disposable
MinIO without uploading to the AWS endpoint in its deployment configuration:

```bash
node scripts/proof-publisher-e2e.mjs \
  "$PREPARED_RECEIPT" "$PREPARED_RECEIPT_SHA256" /tmp/new-publisher-e2e-report.json
```

The script first calls the CLI's read-only publication validator, then stages the
exact 11 frozen files. It runs the selected digest-pinned publisher on an internal
Docker network with disposable credentials and a temporary MinIO. It verifies
authenticated publisher readback, every anonymous object's size/hash, the exact
object inventory, and anonymous rejection after removing the test read policy.
Containers/network are removed before a passing report is written. No host AWS
credentials, deployment bucket, Kubernetes context, or CubeSigner key is used.
The report covers publication components; it is deliberately not a production
publication receipt, `publish --apply` final-contract test, or real-proof E2E.

## CubeSigner receipts and external signer evidence

Use the same explicit `mode` in `signing.cubesigner` (DeploymentSpec) or
`cubesigner` (doge-config):

- `transport_only`: non-mainnet only, reported as not production-ready. It does
  not bypass any CubeSigner-hosted key policy already attached to the key.
- `production_verifier_key_policy`: requires `policyReceipts`. Mixing receipts
  with manually transcribed `productionPolicy` fields is rejected.

`policyReceipts` includes `release`, `attachment`, `protocolContext`, optional
`liveEvidence` references (`path` plus `sha256`), and explicit `environment` and
`organization`. Paths resolve relative to the deployment. The release receipt
also refers to its Wasm and test report relative to the receipt directory.

The validated schemas are:

| Receipt | Bound evidence |
| --- | --- |
| `dogeos/cubesigner-policy-release/v1` | Full core revision, immutable `name/vN`, SDK `0.4.281`, request contract, Wasm path/size/SHA, passed test report/hash, HTTPS resolver authority, protocol-context digest, program/verifier identities, Bridge program and aggregate VK provenance. |
| `dogeos/cubesigner-policy-attachment/v1` | Environment/organization, exact key/material/role IDs, release and artifact hashes, immutable policy identifier, verified provider readback and C2F egress authority. |
| `dogeos/attestation-signer-policy-validation/v1` | Active signer ID/public key, exported bundle-manifest hash, core revision, enforcing policy mode, redacted final-config digest, passed validation result and timestamp. |

Release/attachment timestamps and content hashes are checked. Symlinks and
parent-directory symlinks are rejected. Live evidence is size-bounded,
digest-verified and projected into a generated read-only ConfigMap mount at
`/app/proof-policy/live-evidence.json`.

Partner validation references belong in
`attestationSigner.policyValidation = {bundleManifest, receipts}` in doge-config.
Receipts describe actual externally performed verification. They are not
templates to fill with a fabricated success. No provider or partner secret is
needed in these receipts. A pending candidate can be used for the partner
handoff; once real evidence exists, prepare a new generation with those explicit
references. The receipt must describe the same topology/context/release.

One-release migration behavior keeps missing-mode legacy configuration on the
fail-closed production runtime default and reports a warning. It never silently
selects `transport_only`. Legacy configuration cannot pass the enforcement gate.
A legacy live-evidence path without a verified mount is rejected.

The core policy build currently has candidate/test pins. Creating a deployment's
production policy release receipt and provider attachment evidence still requires
the matching audited core policy build/provider procedure. The CLI imports and
checks that evidence; it does not manufacture it or change provider state.

## Consistency checks and advanced commands

Deployment contracts use schema version 8. Regenerate older contracts. They bind
the selected materials/protocol/publication and artifact-store receipts, native topology and Worker
contract, plus semantic hashes of proof-owned values. Unrelated chart overlays
remain legal. Managed env, image, mount, init-container, topology annotation and
proof TOML changes require regeneration.

`setup proof-config-check` reports missing enforcement evidence in observe mode
and rejects enforcing configurations with missing or mismatched evidence.

For advanced manual generation, select materials explicitly with
`setup prep-charts --proof-materials-receipt PATH` and, after publication,
`--proof-publication-receipt PATH`. `setup export-signer-policy --contract PATH`
uses only those bound materials. It never falls back to the default receipt.
Signer exports require a new versioned output directory and are staged before
one rename; failed exports leave prior bundles intact.

`setup proof-bundle-publish --release FILE --release-sha256 SHA` uses the immutable
publisher image. `--core-dir` remains a deprecated diagnostic compatibility path.
