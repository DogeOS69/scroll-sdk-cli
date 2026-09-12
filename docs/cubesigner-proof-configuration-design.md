# CubeSigner and proof configuration generation design

Status: proposed design; no new command described here is implemented yet.

This document defines the remaining configuration-generation work for
CubeSigner policy and the DogeOS proof topology. It is intentionally limited to
the role of `scrollsdk`: turn reviewed intent and immutable release receipts
into internally consistent runtime configuration, partner handoff bundles, and
validation receipts.

`scrollsdk` is not a deployment orchestrator. Production operators continue to
run the individual `scrollsdk setup ...` commands, review their outputs, and
install the result through their own deployment process.

## Scope boundary

The CLI owns deterministic configuration work:

- validating high-level CubeSigner and proof intent;
- importing immutable release and provider-readback receipts;
- deriving low-level identities, paths, hashes, image references, and runtime
  environment values from those receipts;
- generating the proof-related portions of chart values, the Worker contract,
  and the external Attestation Signer policy handoff;
- checking that all generated outputs describe the same protocol context,
  policy, proof-material release, and topology generation;
- emitting machine-readable, secret-free configuration receipts.

The CLI does **not** own:

- Helm or Kubernetes installation, cleanup, PVC deletion, rollout ordering, or
  readiness waiting;
- Bridge funding, Shadowfork mining, acceptance traffic, or incident recovery;
- SSH/Compose deployment of partner signers;
- provisioning or renting a GPU server, dstack, Vast, or another compute
  provider;
- attaching, removing, or replacing a CubeSigner policy as a side effect of
  configuration generation;
- generating dogeos-core proof identities, commitments, verifying keys, or the
  CubeSigner Wasm policy implementation;
- environment-specific operational tuning such as confirmation counts, batch
  intervals, ingress, storage size, or request-size limits.

Fast deployment runners in environment repositories may call many atomic CLI
commands, install charts, and perform tests. They are test automation, not a
model for a new `scrollsdk deploy` command group.

## Existing capabilities to preserve

The current proof configuration path already has the right foundations:

- `proofTopology` has independent `mode`, `generation`, and `enforcement`
  switches;
- `proof-release-prepare`, `proof-worker-image-check`, `proof-materials`, and
  `proof-bundle-publish` establish versioned proof inputs and publication
  receipts;
- the topology compiler produces one canonical compiled bundle;
- `prep-charts` projects that bundle into Withdrawal Processor, Proof
  Coordinator, Worker, DA submitter, and eager-materializer configuration;
- `proof-config-check` validates the deployment contract and compiled Worker
  bundle without contacting Kubernetes;
- proof-work and Worker credentials are separate;
- `proof-worker` hydrates a compiler-generated Worker bundle without making the
  credential part of its identity;
- `export-signer-policy` exports the bridge-owned portion of the external
  Attestation Signer policy while leaving RPC source sets and rotation
  allowlists to the partner operator;
- `cubesigner-init` creates or imports the CubeSigner role/key and records its
  public identity.

The objective is to close the remaining provenance and consistency gaps, not
to replace these commands with a general workflow engine.

## Audited gaps

### P0: CubeSigner policy mode is not an explicit input

`SigningConfig.cubesigner` records optional production-policy fields but no
runtime policy mode. Initial values generation unconditionally emits
`production_verifier_key_policy`, even when the evidence fields are absent.
`prep-charts`, however, only updates evidence fields and leaves any existing
mode untouched. Consequently the initial generation path and regeneration path
can produce different postures, and a manually selected `transport_only` value
can survive unnoticed.

Add an explicit mode:

```yaml
signing:
  cubesigner:
    mode: transport_only | production_verifier_key_policy
```

Rules:

- `transport_only` is allowed only for non-mainnet configuration and is always
  reported as not production-ready;
- `transport_only` never counts as proof enforcement or CubeSigner-policy
  readiness;
- selecting `transport_only` must warn when an imported key-readback receipt
  says that the key already has a policy attached, because local runtime mode
  does not bypass a CubeSigner-hosted key policy;
- `production_verifier_key_policy` requires validated release and attachment
  receipts; empty strings are not valid evidence;
- both initial generation and `prep-charts` derive the same environment value
  from this field. Operators must not maintain it by hand in generated values.

### P0: Production policy evidence is manually transcribed

The current `CubesignerProductionPolicy` accepts individual digest and identity
strings. That permits values from different policy builds or protocol contexts
to be combined into a syntactically valid configuration.

The CLI should consume two immutable receipts instead.

`cubesigner-policy-release-v1.json` is produced alongside the dogeos-core
policy build and test process. It binds:

- dogeos-core source revision;
- exact Wasm artifact path, size, and SHA-256;
- immutable policy name and version (`name/vN`, never `latest`);
- CubeSigner SDK version and request-contract version;
- compiled proof-resolver authority pin;
- verifier identity digest;
- BridgeState program and aggregate-verifying-key identity/provenance;
- policy test results and their artifact hashes;
- receipt schema and creation timestamp.

`cubesigner-policy-attachment-v1.json` is provider/operator readback evidence.
It binds:

- CubeSigner environment/organization identity;
- exact key ID, key material ID, and role ID;
- exact attached `name/vN` policy identifier and artifact digest;
- required C2F egress authority and provider readback;
- attachment/readback timestamp;
- prior immutable version usable for a separately approved rollback.

The receipt does not grant the CLI authority to change provider state.
`scrollsdk` validates and imports it. Policy build, push, tests, immutable
version attachment, logs, and rollback remain with the audited dogeos-core
tools and operator procedure. In particular, configuration generation must
never remove or replace an existing key policy.

The imported attachment must match the CubeSigner key selected by
`cubesigner-init`. A receipt for another key, role, organization, policy
version, artifact, or resolver authority fails closed.

### P0: Live evidence can name a file that is not mounted

The schema accepts an absolute live-evidence report path and digest, and values
generation exports them as environment variables. No generated volume/mount
currently guarantees that the file exists inside the signer container.

The configuration compiler must do one of the following atomically:

1. copy the validated, regular, non-symlink evidence file into a generated
   ConfigMap/Secret input and emit the corresponding read-only mount; or
2. require an explicit external mount descriptor and validate that the selected
   chart values expose the same container path.

The file digest is checked before generation and again by
`proof-config-check`. A configured path without a generated or declared mount
is invalid.

### P0: No supported producer creates a complete preparation root

`proof-release-prepare` is named like a producer, but it only validates and
captures an already assembled native `artifact-root`. Before the command can
run, an operator must currently obtain the five Scroll program/VK files, run
the dogeos-core three-phase native identity probe, build both materializers,
and bake the Bridge/Aggregation artifacts against this deployment's
`protocol_context.json`. There is no single supported dogeos-core command or
current release image that performs that complete operation.

`setup proof-image-tools` covers only parts of the problem when matching images
have been published: it can export a compiled Worker identity and materializer
binaries from Worker/Coordinator images, or use a producer image to derive
Scroll identity evidence from five caller-supplied public files. The historical
artifact-baker image is not authority for a newer core revision, and neither
action produces the deployment-bound Bridge bake and complete real-release
root. The production CUDA Worker image is validated later and is not a
preparation-root producer.

Today the reliable fallback therefore requires a clean dogeos-core source
checkout at the exact approved revision plus its pinned Rust/OpenVM toolchain.
Environment-specific helper scripts may drive those native commands for a
Devnet, but they are not a portable production interface and must not be
treated as release authority.

Close this gap without turning the CLI into a deployment orchestrator:

1. The dogeos-core release pipeline publishes either a digest-pinned CPU
   preparation-producer image or an immutable release bundle plus a compatible
   CPU baker image. Its provenance binds the full core revision, toolchain,
   producer contract, and all software inputs.
2. Extend the existing `setup proof-image-tools` with a `prepare-real` action
   rather than adding a workflow command group. Its operator inputs are the
   approved producer image/release receipt, expected core revision, current
   protocol context, and a new output directory. A Worker CUDA image, AWS,
   Kubernetes, and GPU provider are not inputs.
3. Run the producer offline with no credentials, GPU, host source mount, or
   network. It emits the conventional complete `artifact-root` and a producer
   receipt. The CLI verifies file boundaries, hashes, revision, protocol-context
   binding, identities, and manifest relationships before publishing the local
   output atomically.
4. Keep `proof-release-prepare` as the next trust-boundary check and immutable
   handoff capture. It accepts the generated root or the explicit source-build
   fallback, but never downloads an unpinned latest bundle or silently mixes
   files from another release.

Until that producer exists, the production runbook must say plainly that full
real-proof preparation requires the dogeos-core source checkout. Docker Hub is
used later for the immutable production Worker image and may supply partial
tools only when their revision exactly matches the selected release.

The source checkout is a temporary compatibility fallback, not an acceptable
end-state dependency. Release compilation belongs in dogeos-core CI. An
operator workstation must never need Rust, OpenVM, Cargo caches, circuit source,
or a local dogeos-core repository merely to configure a DogeOS instance.

### P0: Program publication still reads its contract from source

`setup proof-bundle-publish` currently requires `--core-dir` so it can read the
authoritative 11-file mapping and invoke
`tools/real-proving/publish-real-proving-bundle.sh` from a clean checkout. This
is another production source dependency even after the preparation root has
already been captured.

Move the publication contract into the immutable proof release:

- the release manifest carries the versioned file mapping, publisher contract
  version, publisher image digest, and full core revision;
- the digest-pinned publisher image contains the implementation and no mutable
  release inputs;
- `proof-bundle-publish` consumes the validated release/materials receipt and
  invokes that image with only the staged 11 files, selected S3 destination,
  and temporary AWS credentials;
- the command verifies that the publisher image, file mapping, preparation
  receipt, topology bundle, and production Worker all identify the same release;
- `--core-dir` is removed from the normal production interface. A source-based
  compatibility flag may exist only during a bounded migration and must be
  reported as legacy mode.

### Required dogeos-core proof release contract

The dogeos-core release pipeline should publish one signed or digest-pinned
`dogeos-proof-release-v1.json` as the operator entry point. It names immutable
OCI references rather than asking an operator to correlate tags:

```text
dogeos-proof-release-v1.json
  core revision and source repository
  Rust/OpenVM/Scroll toolchain identities
  generic Scroll program/VK bundle digest
  CPU preparation-producer image digest
  S3 publisher image digest and 11-file mapping version
  proof-topology compiler image digest
  mock Worker image digest
  Proof Coordinator/materializer image digest
  supported CUDA Worker build identity inputs
  CubeSigner policy build artifact/receipt when released together
```

The generic program bundle may be an OCI artifact, a read-only release object,
or content-addressed files in a release bucket; its transport is not important.
The manifest digest and per-file hashes are authoritative. Mutable tags and a
GitHub Actions retention-limited artifact alone are insufficient.

With that contract, the operator-facing preparation input is only:

```text
approved proof-release manifest reference/digest
current protocol_context.json
new local output directory
```

`scrollsdk` resolves the immutable producer, runs it in a networkless read-only
container, validates the generated instance-bound bake, and later uses the
receipt-pinned publisher image for S3 publication. No proof configuration
command requires a dogeos-core source checkout.

### P0: Attestation Signer export can read a stale proof receipt

`export-signer-policy` resolves the selected proof intent, but its production
verifier helper reads `DEFAULT_PROOF_MATERIALS_RECEIPT` directly. A deployment
using a versioned or non-default materials receipt can therefore export an
aggregate verifying key and commitments from a different release.

The exporter must resolve verifier material only through the selected proof
deployment contract. That contract must bind the materials receipt and digest,
publication receipt and digest when applicable, compiled topology revision,
protocol-context digest, and generated configuration ID. Direct fallback to a
default receipt is forbidden once a contract is selected.

The exporter also writes directly into its destination and removes stale files
before all validation succeeds. It must stage every output in a sibling
temporary directory, validate the complete manifest, and atomically replace
the destination only after success.

### P0: Proof-managed values can drift after generation

The proof deployment contract records values hashes, but validation currently
checks only that the values files exist. This intentionally permits environment
overlays, but also permits manual changes to proof-managed fields without
detection.

Define a semantic managed block for each generated component. Its digest covers
only fields owned by the proof compiler, for example:

- mode/generation/enforcement and observe deadline;
- topology bundle revision and protocol identity;
- artifact-store identity and key prefix;
- immutable compiler and Worker image identities;
- program/verifier commitments and paths;
- proof-work versus Worker credential references;
- eager and fallback materializer configuration;
- signer proof-artifact base URL;
- CubeSigner policy mode and imported evidence identities.

`proof-config-check` recomputes these semantic digests from the final values.
Unrelated chart overlays remain legal. A change to a managed field requires
regeneration, not a manual waiver.

### P0: Artifact-store values have duplicate operator inputs

`setup proof-aws-init` currently reads the canonical shared artifact store from
`doge-config.toml [ethereumDa.blobArchive.s3]`, while also accepting `--bucket`
and `--key-prefix` as equality assertions. Even though the flags are not
overrides, they make the operator enter the same values twice and make scripts
look as though two configuration authorities exist.

Use one source of truth:

- the operator declares the bucket, artifact region, and key-prefix policy once
  in DeploymentSpec/doge-config;
- `proof-aws-init` accepts the config path and AWS/EKS provisioning choices,
  reads the artifact store from that canonical section, and has no normal
  `--bucket` or `--key-prefix` inputs;
- if a separate proof store is supported later, it is a named canonical store
  declared once in DeploymentSpec and referenced by topology, not a command-line
  override;
- `.data/proof-aws.json` may repeat the resolved bucket/region/prefix because it
  is a generated resource receipt, but it records the source config path,
  section, source SHA-256, and resolved-store digest. It is never edited as a
  second desired-state file;
- `proof-config prepare` validates that the proof-AWS receipt still matches the
  current canonical store and fails with an instruction to rerun
  `proof-aws-init` when it has drifted.

Deprecate `--bucket` and `--key-prefix` for one compatibility release. If they
are supplied, they may only match the canonical values and produce a deprecation
warning; they must never become overrides. Remove them from the documented
production interface and then from the command after environment automation has
migrated.

### P1: Low-level proof fields are editable source intent

`ProofTopologySpec.active.realScroll` exposes values such as commitments,
verifying-key paths, materializer paths, and release roots. These are outputs of
proof-material and publication receipts, not independent operator choices.
Manually copying them into a DeploymentSpec creates another opportunity to mix
releases.

The reviewed input should contain only high-level posture and receipt
references. The compiler derives all low-level `realScroll` data:

```yaml
proofRelease:
  manifest: dogeos69/dogeos-proof-release@sha256:<digest>

proofTopology:
  mode: active | disabled
  generation: mock | real
  enforcement: observe | enforce
  observeRealProofDeadlineMs: 300000
  deployment:
    artifactStoreRef: ethereumDa.blobArchive.s3
    workerBackend: external | kubernetes | none
```

The concrete schema may keep a compiler-internal resolved type, but the public
DeploymentSpec type must not require users to transcribe derived identities or
paths. Immutable compiler and Worker images come from validated receipts or an
explicit image-validation receipt, not mutable tags.

### P1: Enforce readiness lacks a complete evidence gate

The topology validator correctly rejects enforcement unless proving is
`active/real`. That is necessary but insufficient. `active/real/enforce` must
also require:

- a valid real proof-materials receipt;
- a matching program-publication receipt for externally fetched materials;
- matching protocol-context and artifact-store receipts;
- a valid Worker bundle/image identity when the topology requires a Worker;
- completed external Attestation Signer policy-validation receipts for every
  active signer;
- CubeSigner `production_verifier_key_policy` with matching release and
  attachment readback receipts;
- mounted and digest-verified live evidence when the selected policy requires
  it.

`active/real/observe` uses real generation and must have real materials,
publication, and Worker configuration, but it may run before all enforcement
readiness receipts exist. Missing evidence is reported clearly as an
enforcement blocker, not hidden as a generic validation error.

### P1: External signer completion is not imported

The CubeSigner Wasm key policy and the partner-operated Attestation Signer
runtime policy are different controls:

- the CubeSigner policy governs use of the TEE signing key;
- the Attestation Signer evaluates `attestation_evidence_v2`, RPC source sets,
  verifier material, and rotation allowlists.

`export-signer-policy` correctly leaves the three RPC source sets and rotation
allowlists operator-owned. The CLI must not invent them. It should define an
`attestation-signer-policy-validation-v1.json` receipt that a partner can return
after merging and validating the bundle. The receipt binds signer ID/public
key, input bundle manifest, final redacted configuration digest, policy mode,
release identity, and validation timestamp. Endpoint credentials and full
private policy contents are not imported.

Proof enforcement readiness requires one matching receipt per active signer.
Observe mode may generate the handoff without them and list them as pending.

### P2: Seven internal stages are exposed as operator commands

The supported real-proof sequence currently spans release preparation, Worker
image checking, material import, topology selection/compilation, `prep-charts`,
signer-policy export, publication, and `proof-config-check`. These remain useful
diagnostic primitives, but they should not be seven mandatory production
operator steps. Compiler-owned outputs can also describe different generations
when one primitive fails or is rerun concurrently.

Keep the command surface small and configuration-only. The production interface
has one `setup proof-config` topic with two explicit trust-boundary operations:

```text
scrollsdk setup proof-config prepare
scrollsdk setup proof-config publish
```

`prepare` is locally transactional and has no external mutation. It may perform
read-only registry pulls to resolve the selected OCI artifacts; every producer
container itself runs without a network. Given a validated immutable proof
release, current protocol context, existing proof-AWS facts, high-level proof
posture, and Worker backend, it internally:

1. runs the receipt-pinned CPU preparation producer;
2. captures the native preparation handoff;
3. validates the release-pinned production Worker image;
4. imports proof materials;
5. compiles the topology and all proof-managed chart projections;
6. generates the CubeSigner policy projection/mount metadata, external
   Attestation Signer handoff, and provider-neutral Worker contract;
7. validates semantic managed blocks and emits an immutable S3 publication
   plan.

Every stage still writes a typed internal receipt, but the complete candidate is
first built beneath a sibling staging directory. No active `.data` pointer or
production values file changes until all stages succeed. `prepare` performs no
AWS write, Kubernetes call, GPU operation, remote signer operation, or policy
attachment.

`publish` consumes only the immutable prepared receipt. It revalidates all
local inputs, uses the release-pinned publisher image to upload the complete
program bundle, performs authenticated and public readback, writes the
publication receipt, finalizes the proof deployment contract, and runs the
final configuration check. S3 publication is its only external mutation.

Mock configuration finishes with `prepare`; it has no real-program publication
step. Real configuration uses both operations so the operator can review the
release identity, protocol-context digest, immutable images, 11 files, bundle
ID, and target S3 prefix before `publish --apply`.

The existing fine-grained setup commands remain temporarily available as
advanced diagnostics and migration interfaces. They call the same libraries
and produce the same receipt schemas; the two-step path must not recursively
launch CLI commands. `export-signer-policy` remains an explicit re-export, and
`proof-worker` remains optional credential hydration/local rendering after the
final configuration exists.

No `deploy`, `install`, `cleanup`, GPU rental, Worker launch, SSH, or
server-management command is introduced. Environment test runners may chain
the two commands, but the production CLI retains the S3 review boundary rather
than hiding publication inside the offline preparation action.

## Target configuration model

The source configuration distinguishes reviewed intent from resolved facts:

```yaml
signing:
  cubesigner:
    mode: production_verifier_key_policy
    policyReleaseReceipt: .data/cubesigner-policy-release-v1.json
    policyAttachmentReceipt: .data/cubesigner-policy-attachment-v1.json

proofTopology:
  mode: active
  generation: real
  enforcement: observe
  observeRealProofDeadlineMs: 300000
  deployment:
    artifactStoreRef: ethereumDa.blobArchive.s3
    workerBackend: external

proofRelease:
  manifest: dogeos69/dogeos-proof-release@sha256:<digest>

proofPolicy:
  partnerValidationReceipts:
    - .data/signer-0-policy-validation-v1.json
    - .data/signer-1-policy-validation-v1.json
    - .data/signer-2-policy-validation-v1.json
```

Paths are examples. DeploymentSpec and doge-config need one canonical mapping;
they must not acquire two semantically different representations.

Receipt references are resolved relative to the deployment root. Every input
must be a bounded regular non-symlink file, use a known schema, and carry a
content digest. Unknown schema versions fail closed. Secret values never enter
release, topology, or readiness receipts.

## Generated outputs

`proof-config prepare` should stage one generation and publish its local
configuration atomically:

```text
.data/proof-config/<generation-id>/
  proof-config-prepared-v1.json
  publication-plan-v1.json
  proof-deployment-contract-v2.json
  proof-topology/
  worker-contract/
  cubesigner-policy/
    runtime-projection.json
    live-evidence-mount.yaml
    release-receipt.json
    attachment-receipt.json
  attestation-signer-policy/
    signer-policy.json
    signer-policy.env
    protocol_context.json
    advance-l2-agg-verifying-key.bin
    PARTNER-COMMANDS.md
    signer-policy-manifest.json
  managed-values-digests.json
```

After a successful real `proof-config publish`, the same immutable generation
also contains:

```text
  proof-program-publication-v1.json
  proof-config-final-v1.json
```

For mock generation, `proof-config-prepared-v1.json` is already final and
records that publication is not applicable.

The environment's existing production values may remain at their established
paths. They receive the generated managed blocks only after the staged tree and
all values mutations validate. The deployment contract records the final
semantic digests and the relative path of every generated artifact.

The contract should bind at least:

- mode, generation, enforcement, and observation deadline;
- protocol-context path and digest;
- proof-materials and publication receipt paths/digests;
- artifact-store receipt and immutable store identity;
- topology bundle revision;
- compiler and Worker image validation receipts;
- Worker contract/bundle ID and credential-pending state;
- Attestation Signer bundle manifest and returned validation receipts;
- CubeSigner mode, selected key/material/role identities, policy release, policy
  attachment, resolver authority, and live-evidence digest/mount;
- semantic digest for every proof-managed values block;
- generator version, source-intent path/digest, generation ID, and timestamp.

## Validation matrix

| Mode | Generation | Enforcement | Required configuration |
| --- | --- | --- | --- |
| `disabled` | `mock` | `observe` | Staged inactive topology; no Worker. |
| `active` | `mock` | `observe` | Internal mock generation; no real materials or Worker. |
| `active` | `real` | `observe` | Real materials, publication when externally fetched, immutable Worker contract, artifact store; missing policy-readiness receipts are reported as pending. |
| `active` | `real` | `enforce` | Everything required by real/observe plus matching partner-signer validation receipts and production CubeSigner policy release/attachment/live-evidence readiness. |

All other combinations fail validation. In particular, mock/enforce and
disabled/enforce are invalid, and CubeSigner `transport_only` is incompatible
with proof enforcement.

## Worker and compute-provider boundary

The generated Worker contract describes what must run, not where compute is
purchased. It contains immutable image identity, command/arguments, protocol
and topology identities, artifact endpoints, resource requirements, health
contract, and a credential reference placeholder.

Optional renderers may produce Compose or Kubernetes configuration from that
contract. A production operator may instead receive a server and access key or
use another scheduler. Provider-specific provisioning, rental, billing limits,
fleet shutdown, and SSH remain outside `scrollsdk`.

Credential hydration is a separate local operation and must not alter the
Worker contract or bundle ID. This preserves identical proof configuration
across manual servers, dstack, and future providers.

## Operator command sequence

After the environment has a protocol context, proof-AWS configuration, and an
approved immutable proof release, the production-facing real-proof sequence is
two commands:

```bash
scrollsdk setup proof-config prepare \
  --release <proof-release-manifest@digest> \
  --protocol-context .data/protocol_context.json \
  --mode active --generation real --enforcement observe \
  --worker-backend external \
  --output .data/proof-config-prepared.json \
  --json

scrollsdk setup proof-config publish \
  --prepared .data/proof-config-prepared.json \
  --aws-profile <profile> \
  --apply \
  --output .data/proof-config-final.json \
  --json
```

The first command reads `.data/proof-aws.json` by default; an explicit
`--proof-aws-config` selects a non-default receipt path, not alternate bucket or
prefix values. It accepts no cloud credential and produces the exact S3 plan to
review. The second accepts no new release, protocol, topology, or file-path
choices; those are frozen by the prepared receipt. Omitting `--apply` performs
the publication preflight without writing S3.

For mock/observe, only `proof-config prepare` is required and its prepared
receipt is the final configuration receipt.

CubeSigner policy build/push/test/attach/readback is an explicit operator step
using dogeos-core policy tooling. The resulting release and attachment receipts
become inputs to `doge-config`/`prep-charts`; the CLI does not silently perform
the provider mutation.

`export-signer-policy` remains available when an operator needs to regenerate
only the partner handoff from the already selected deployment contract.

## Implementation plan

### Phase 0: fix correctness gaps

1. Add explicit CubeSigner policy mode to DeploymentSpec and doge-config.
2. Make both values-generation paths derive mode identically; eliminate blank
   production-policy placeholders.
3. Document and validate the current source-build preparation fallback; never
   imply that `proof-release-prepare` creates its input or that a production
   CUDA Worker image is a preparation producer.
4. Define the source-free `dogeos-proof-release-v1` contract and reject mixed
   producer, publisher, compiler, Worker, and program-bundle revisions.
5. Make DeploymentSpec/doge-config the only artifact-store input; deprecate
   duplicate `proof-aws-init --bucket/--key-prefix` flags and add source
   provenance to the generated proof-AWS receipt.
6. Make `export-signer-policy` resolve real verifier material from the selected
   deployment contract instead of the default receipt.
7. Make signer-policy output transactional.
8. Add semantic managed-block digests and enforce them in
   `proof-config-check`.

### Phase 1: receipt-backed policy configuration

1. Define and validate CubeSigner policy release and attachment schemas.
2. Bind attachment evidence to the key selected by `cubesigner-init`.
3. Generate or validate the live-evidence mount.
4. Define the external Attestation Signer policy-validation receipt.
5. Add the full enforcement-readiness gate and actionable pending evidence in
   observe mode.

### Phase 2: simplify public proof intent

1. Add a receipt-backed, offline `proof-image-tools prepare-real` producer path
   after dogeos-core publishes its stable producer image/release contract.
2. Change `proof-bundle-publish` to use the receipt-pinned publisher image and
   release file mapping; remove `--core-dir` from the production path.
3. Extract the existing preparation, image-check, material-import, compiler,
   chart-projection, signer-export, publication, and validation implementations
   into reusable typed libraries.
4. Implement transactional `setup proof-config prepare` over those libraries,
   including the immutable publication plan and atomic local commit.
5. Implement `setup proof-config publish` as the sole S3-mutating step, bound
   exclusively to a prepared receipt.
6. Move derived `realScroll` identities and paths into an internal resolved
   type populated from receipts.
7. Version the expanded proof deployment contract.
8. Retain backward-compatible receipt import for one release, with warnings and
   an explicit migration command/path; do not silently infer missing evidence.

## Test requirements

- Unit-test the full mode/generation/enforcement/CubeSigner-policy matrix.
- Prove initial values generation and `prep-charts` produce identical
  CubeSigner mode and evidence projection.
- Reject mixed release, attachment, key, role, protocol, publication, Worker,
  resolver-authority, and live-evidence identities.
- Reject `latest`, mutable image references, unknown receipt schemas, symlinks,
  missing evidence mounts, and empty production evidence.
- Verify `export-signer-policy` never consults the default materials receipt
  when the selected contract names another receipt.
- Verify `prepare-real` accepts only an immutable producer/release whose full
  core revision matches, binds output to the exact protocol-context digest, and
  cannot access the network, credentials, host source tree, or GPU.
- Verify publication uses only the receipt-pinned publisher image and versioned
  11-file mapping, with no dogeos-core checkout or implicit current-directory
  source lookup.
- Verify `proof-config prepare` performs no AWS write or other external mutation,
  commits no partial generation after injected failures, and freezes every
  input accepted by `publish`.
- Verify `proof-config publish` accepts no replacement release/protocol/topology
  inputs, does nothing without explicit `--apply`, and is safely repeatable for
  the same content-addressed bundle.
- Verify bucket, artifact region, and key prefix have exactly one desired-state
  source; the proof-AWS receipt carries source provenance and stale receipts are
  rejected after canonical configuration changes.
- Verify deprecated bucket/prefix assertion flags cannot override canonical
  values and are absent from the final production interface.
- Verify mock preparation is final without publication and real preparation is
  never reported final before publication/readback succeeds.
- Inject failure before every staged output is committed and prove the previous
  complete generation remains unchanged.
- Permit unrelated production-values overlays while rejecting modifications to
  each proof-managed field.
- Verify partner-owned RPC source sets and rotation allowlists are never
  invented or overwritten.
- Verify no generated receipt contains CubeSigner sessions, Worker tokens,
  provider API keys, private keys, or other secret payloads.
- Golden-test provider-neutral Worker contracts and optional Compose/Kubernetes
  renderers for identical bundle identity.

## Completion criteria

This design is complete when:

1. An operator selects proof posture and immutable receipts without manually
   copying commitments, verifying-key paths, or policy digests.
2. CubeSigner `transport_only` and `production_verifier_key_policy` are explicit,
   validated choices with no divergence between initial and regenerated values.
3. A production policy configuration proves that the built policy, attached
   immutable version, selected CubeSigner key, resolver authority, verifier
   identities, and mounted live evidence all agree.
4. The external Attestation Signer handoff is generated from the selected proof
   contract, and returned partner validation can gate enforcement without
   importing partner secrets or policy contents.
5. One failed or concurrent generation cannot leave chart values, signer
   handoff, Worker contract, and proof deployment contract at different
   generations.
6. `proof-config-check` detects changes to proof-managed fields while allowing
   legitimate environment overlays.
7. A provider-neutral Worker contract can be deployed on operator-supplied
   infrastructure without the CLI renting, installing, or managing that
   infrastructure.
8. No general deployment automation is added to `scroll-sdk-cli`; environment
   repositories remain free to automate the atomic setup commands for testing.
9. The normal proof configuration and publication path needs no dogeos-core
   source checkout or local Rust/OpenVM toolchain; all executable tooling and
   generic materials come from one validated immutable proof release contract.
10. A production operator needs one configuration command for mock and exactly
    two for real: a non-mutating atomic local prepare followed by an explicitly
    reviewed S3 publish/finalize operation.
11. An operator enters bucket, artifact region, and key-prefix policy exactly
    once; every proof-AWS, topology, values, Worker, and publication value is
    derived from that canonical store and checked through receipt provenance.
