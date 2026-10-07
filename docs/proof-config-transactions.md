# Proof configuration generations

The source-free path uses dogeos-core's `dogeos-proof-release-v1.json` and its
SHA-256. dogeos-core `proof-release.yml` (PR #1335) publishes it as the
`proof-release-<tag>` pre-release. The manifest is only a schema, one core
revision and five images from that revision, pinned by digest and keyed by
image name:

| Key | Used for |
|---|---|
| `proof-preparation-producer` | Offline bake of the deployment's Bridge and aggregation guests |
| `prover-worker-cuda` | Production Worker; its commitment labels must equal the bake's |
| `proof-coordinator` | Pinned in PC values; source of both materializers |
| `dogeos-proof-topology` | Topology compiler |
| `proof-bundle-publisher` | The 11-file S3 program publisher |

There is no mock Worker image: Proof Coordinator produces mock proofs in
process. Both generations bake the deployment:

- `generation = real` imports the bake as complete real materials, checks the
  CUDA image labels and freezes the S3 program publication plan.
- `generation = mock` keeps proving mock but materializes for real
  (`withdrawal_mock_prover_real_materialize`): it imports `real-identity.env`
  and compiles with the bake's `worker-identity-bundle.json` minus
  `bridge_guest`, which is the release Worker's own `--print-identity-json`.
  A plain synthetic mock is not a release configuration; use
  `setup proof-materials --mock-worker-image` for it.

Earlier manifests (for example `dogeos-proof-release-pr1177.json`, with
`genericBundle`, `publisher` and `cuda` sections) are historical and are
rejected by the current validator.

**Isolated E2E, 2026-10-03.** Core `7d87706931c1517979a10724396b694283e3385a`
(PR #1335): coordinator, compiler and publisher built by `docker-build.yml`;
CUDA (`cuda_arch=86`) by `prover-worker-cuda-image.yml`, whose smoke job
checked the commitment labels; the producer built locally from
`Dockerfile.proof-producer`. Its build-time identities equal those in the PR:
batch `0x00947c84…90233cb3`, aggregation `0x0033fb4d…1817f230`, bridge VK
`0x6475dc70…c00486f6`. On a copy of the devnet deployment, `proof-config
prepare` with `generation = real` baked the devnet protocol context offline,
passed the CUDA label check, copied materializers byte-identical to the
coordinator image's, compiled an installable topology and froze an 11-file
plan in 7 min 10 s. `publish` without `--apply` revalidated the plan.
`generation = mock` selected `withdrawal_mock_prover_real_materialize`, rendered
no Worker contract, compiled with a `bridge_guest`-free bundle carrying the
release commitments, and passed `proof-config-check` (7 min 57 s). Nothing was
written to S3 or Kubernetes, and no GPU proof was run.

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

Preparation pulls the digest-pinned images and, for real generation, runs the
`proof-preparation-producer` on the deployment's protocol context with
`--network none` (see [image tools](proof-image-tools.md)). The image carries the
pinned Scroll programs, a Worker compiled against the derived commitments and an
offline Cargo closure, so it bakes the instance-bound Bridge and aggregation
guests with no source checkout. Preparation then checks the CUDA Worker image
labels against the bake's commitments, copies the two materializers out of a
stopped `proof-coordinator` container, imports materials, compiles topology and
values, generates the external signer handoff when external signers are
configured, and freezes the S3 publication plan, whose publisher is
`images["proof-bundle-publisher"]`.

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
  WP may independently use `active / real / enforce`; use its `plain`
  correctness-policy transport. Both `deployment-preflight` and
  `proof-config-check` accept this combination without CubeSigner production
  policy receipts. Real proof materials, publication evidence and external
  Attestation Signer validation remain required for enforcement.
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
