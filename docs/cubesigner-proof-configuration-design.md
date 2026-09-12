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

### P1: Low-level proof fields are editable source intent

`ProofTopologySpec.active.realScroll` exposes values such as commitments,
verifying-key paths, materializer paths, and release roots. These are outputs of
proof-material and publication receipts, not independent operator choices.
Manually copying them into a DeploymentSpec creates another opportunity to mix
releases.

The reviewed input should contain only high-level posture and receipt
references. The compiler derives all low-level `realScroll` data:

```yaml
proofTopology:
  mode: active | disabled
  generation: mock | real
  enforcement: observe | enforce
  observeRealProofDeadlineMs: 300000
  materialsReceipt: .data/proof-materials-v1.json
  publicationReceipt: .data/proof-program-publication-v1.json
  deployment:
    artifactStore: <named store reference>
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

### P2: Proof output generation is not one transaction

The supported operator sequence currently spans `doge-config`, `prep-charts`,
`export-signer-policy`, optional `proof-worker`, and `proof-config-check`.
The commands are useful independently, but compiler-owned outputs can describe
different generations when one command fails or is rerun concurrently.

Keep the command surface small. Do not add a generic deployment workflow.
Instead:

- enhance `setup prep-charts` so one internal generation transaction stages all
  proof-managed chart projections, the proof deployment contract, CubeSigner
  policy projection/mount metadata, Attestation Signer handoff bundle, and
  provider-neutral Worker contract;
- keep `setup export-signer-policy` as an explicit re-export command, but make
  it consume the selected contract and use the same transaction library;
- enhance the existing `setup proof-config-check` to validate the whole
  generation and imported readiness receipts;
- keep `setup proof-worker` limited to optional credential hydration and local
  rendering of an already compiled Worker contract.

No `deploy`, `install`, `cleanup`, GPU rental, or server-management command is
introduced.

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
  materialsReceipt: .data/proof-materials-v1.json
  publicationReceipt: .data/proof-program-publication-v1.json
  deployment:
    artifactStore: proof-artifacts
    workerBackend: external

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

`prep-charts` should stage one generation and publish it atomically:

```text
.data/proof-config/<generation-id>/
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

The production-facing sequence remains a series of reviewable setup commands:

```text
scrollsdk setup cubesigner-init
scrollsdk setup proof-release-prepare        # when producing a new release
scrollsdk setup proof-worker-image-check     # for real proving
scrollsdk setup proof-materials
scrollsdk setup proof-bundle-publish         # when Workers fetch a bundle
scrollsdk setup doge-config                  # high-level posture and receipt refs
scrollsdk setup prep-charts                  # atomic proof config generation
scrollsdk setup proof-config-check
scrollsdk setup proof-worker                 # optional credential hydration/render
```

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
3. Make `export-signer-policy` resolve real verifier material from the selected
   deployment contract instead of the default receipt.
4. Make signer-policy output transactional.
5. Add semantic managed-block digests and enforce them in
   `proof-config-check`.

### Phase 1: receipt-backed policy configuration

1. Define and validate CubeSigner policy release and attachment schemas.
2. Bind attachment evidence to the key selected by `cubesigner-init`.
3. Generate or validate the live-evidence mount.
4. Define the external Attestation Signer policy-validation receipt.
5. Add the full enforcement-readiness gate and actionable pending evidence in
   observe mode.

### Phase 2: simplify public proof intent

1. Move derived `realScroll` identities and paths into an internal resolved
   type populated from receipts.
2. Make `prep-charts` publish all proof-managed outputs in one transaction.
3. Version the expanded proof deployment contract.
4. Retain backward-compatible receipt import for one release, with warnings and
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
