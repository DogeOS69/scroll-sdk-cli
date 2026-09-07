# DogeOS proof operator runbook

This is the operator-facing procedure for preparing and deploying DogeOS proof
services. It follows dogeos-core PR #937's two-switch model. The generated
Withdrawal Processor, Proof Coordinator, Worker, submitter, and signer files are
compiler outputs; do not edit them by hand.

## 1. The three operator fields

The normal source of truth is `.data/doge-config.toml`:

```toml
[proof_topology]
mode = "disabled"       # disabled | active
generation = "mock"     # mock | real
enforcement = "observe" # observe | enforce
```

The fields are independent:

| Field | Meaning |
|---|---|
| `mode` | Whether Proof Coordinator and Worker topology is running. |
| `generation` | Whether Workers produce hash-tagged mock material or real cryptographic proof material. |
| `enforcement` | Whether failed, missing, or mock proof outcomes are observed and allowed, or rejected. |

Use these postures in order:

| Stage | `mode` | `generation` | `enforcement` |
|---|---|---|---|
| Proof services off | `disabled` | `mock` | `observe` |
| Exercise the complete topology cheaply | `active` | `mock` | `observe` |
| Generate and validate real proofs | `active` | `real` | `observe` |
| Require real verified proofs | `active` | `real` | `enforce` |

Never use `generation = "mock"` with `enforcement = "enforce"`. Mock and real
proof statements share the same verifier-identity table and artifact namespace;
the hash-committed proof-kind tag distinguishes their output.

`observe` is a staging posture and Attestation Signer refuses it on Dogecoin
mainnet. A mainnet deployment must not activate proof-conditioned signing until
real generation is healthy and all enforcement/policy surfaces use `enforce`.

Changing a switch means editing the one high-level value, rerunning
`scrollsdk setup prep-charts`, reviewing the generated diff, and applying the
normal Helm deployment. It does not mean editing native service files.

## 2. Ownership boundary

| Component | Responsibility |
|---|---|
| `scroll-zkvm-prover` | Build Chunk/Batch `.vmexe`, OpenVM configs, and aggregate VK. |
| dogeos-core identity probe | Derive Chunk, Batch, and recursive program identities. |
| dogeos-core Bridge baker | Bake deployment-bound Bridge/L2-range artifacts from `protocol_context.json`. |
| `scroll-sdk-cli` | Prompt for and import those tools' outputs, parse allow-listed evidence, store local material facts, and prepare compiler inputs. |
| `dogeos-proof-topology` | Strictly validate the selected source/context and render service configuration. |
| Helm/Kubernetes operator | Apply generated values, drain or move Workers, and verify readiness. |
| Partner operator | Deploy and operate each Attestation Signer and apply the exported observe/enforce policy. |

`scroll-sdk-cli` does not implement VK or program-commitment algorithms in
TypeScript. It treats the Rust/OpenVM outputs as inputs and lets the dogeos-core
compiler perform final validation.

## 3. Files in a deployment

```text
deployment/
├── .data/
│   ├── doge-config.toml
│   ├── genesis.json
│   ├── proof-aws.json
│   ├── proof-materials-v1.json
│   ├── proof-materials/
│   │   ├── software/
│   │   │   ├── chunk/app.vmexe
│   │   │   ├── chunk/openvm.toml
│   │   │   ├── batch/app.vmexe
│   │   │   ├── batch/openvm.toml
│   │   │   └── verifier/root_verifier_vk
│   │   └── bridge/
│   │       ├── bridge-state.vmexe
│   │       ├── openvm.toml
│   │       ├── bridge-artifact-manifest.json
│   │       ├── batch-aggregation.vmexe
│   │       └── batch-aggregation-openvm.toml
│   └── generated/proof-topology/
│       ├── bundle-manifest-v1.json
│       ├── resolved-v2.json
│       ├── withdrawal-processor.toml
│       ├── proof-coordinator.toml
│       ├── prover-worker-v1.json
│       └── eth-da-submitter.toml
└── values/
```

`.data/proof-materials-v1.json` is local deployment state owned by
`scroll-sdk-cli`. It is not a dogeos-core protocol object or a publication
authority. It records exactly which source revisions, artifacts, identities,
and deployment-bound Bridge bake were used.

## 4. Normal setup

### Step 1: establish the shared DA/proof object namespace

`eth-da-submitter` has one `[s3]` client. Raw EIP-4844 blobs and proof-system
objects therefore share the canonical bucket, region, and key prefix recorded
under `[ethereumDa.blobArchive.s3]` in `.data/doge-config.toml`; logical object
keys separate raw blobs, segmentation sidecars, Worker inputs, and proofs.

Configure the archive first, for example with `setup eth-da-submitter`, and
then run:

```bash
scrollsdk setup proof-aws-init
```

This reuses the configured DA bucket/prefix, creates or reconciles the proof
IAM roles and token secret, configures the selected external read transport,
and writes `.data/proof-aws.json`. It never invents a second proof-only bucket.
Choose the public-read mode according to who owns the bucket-level policy:

- `existing-public-s3` uses the regional S3 endpoint and preserves the existing
  bucket policy and Public Access Block settings. Use it for a shared bucket
  whose anonymous `GetObject` policy is already managed by the operator, such
  as a testnet DA archive. The CLI still manages the selected prefix's IRSA
  roles, optional EKS S3 Gateway endpoint statement, and proof token secret.
- `direct-s3` makes the CLI manage anonymous reads for the required external
  proof paths. Use it only where the CLI is allowed to manage the bucket-wide
  Public Access Block posture. It rejects an unmanaged public `GetObject`
  statement that overlaps the selected prefix before creating a VPC endpoint
  or changing IAM/secrets.
- `existing-gateway` keeps S3 private and records an operator-managed
  credential-free HTTPS gateway.

`existing-public-s3` does not narrow or otherwise endorse a pre-existing broad
policy such as `arn:aws:s3:::bucket/*`; it records that policy as
operator-managed and unverified. Review that policy independently.
If the bucket is in a different AWS region from EKS, the command keeps the
EKS/Secrets region separate from the artifact region and skips the regional S3
Gateway endpoint; cross-region access uses the normal S3 endpoint or an
operator-managed gateway. It does not prepare proof programs.

The resulting `dogeos/proof-aws/v4` document records these independently as
`artifactStore.region`, `kubernetes.awsRegion`, and `secret.region`. The latter
two must match; the artifact region may differ.

### Step 2: prepare proof materials and identities

```bash
scrollsdk setup proof-materials --generation mock
```

For disabled/mock operation, the interactive command extracts the canonical
identity JSON shipped by the selected digest-pinned mock Worker image. Mock
proofs are recognized by their hash-committed proof-kind tag,
and the coordinator selects the dev verifier when aggregate-VK material is
absent. The mock path does not ask for `real-identity.env`, real-proving
`.vmexe`, aggregate VK file,
materializers, Bridge bake, or production Worker image. The topology compiler
defaults to the current identity-file-capable compiler release. The mock Worker
defaults to the matching current rehearsal release. Generated Proof Coordinator
values must be pinned to the rollout lineage listed in the operator release
note. The CLI
resolves and stores immutable OCI digests rather than retaining mutable tags in
the Worker contract.

The command above intentionally selects development exact-mock materialization:
each DA batch is represented by one batch-wide chunk. It is useful for a cheap
topology smoke test, but it does not exercise the DA-owned segmentation sidecar
or provide production-shaped materializer timings.

To run real segmentation and the real Chunk/Batch subprocess materializers
while keeping proof generation mock and enforcement in observe, import the
release identity probe as part of the mock receipt:

```bash
scrollsdk setup proof-materials \
  --generation mock \
  --identity-env /secure/build/real-identity.env
```

`setup doge-config --proof-topology` then selects
`withdrawal_mock_prover_real_materialize`. The compiled bundle enables all
three ends of the contract: the submitter publishes the segmentation sidecar,
the coordinator reads and validates it, and Withdrawal Processor requests the
materialized segmentation before creating per-chunk work. The selected proof
Worker remains the mock Worker.

Prepare the larger real-only input set later with:

```bash
scrollsdk setup proof-materials --generation real
```

The command must finish with a strict `.data/proof-materials-v1.json`. The mock
receipt binds the copied Worker identity file by path, size, SHA-256, and the
digest-pinned image from which it was extracted. The topology compiler, not the
deployment CLI, validates and derives the recursive commitment fields.
The real receipt additionally rejects artifact hash drift, path escape/symlink
input, and Bridge material that does not match `protocol_context.json`.

See [Proof material preparation](proof-materials.md) for the exact inputs.

### Step 3: initialize the high-level proof topology

```bash
scrollsdk setup doge-config --proof-topology
```

The wizard reads `.data/proof-aws.json` and `.data/proof-materials-v1.json`,
asks for the future real Worker placement, the deployment backend for
adapter-managed Workers, and the Worker-visible Proof Coordinator URL. It
writes the staged active profile and defaults to:

```toml
mode = "disabled"
generation = "mock"
enforcement = "observe"
```

It runs compiler preflight before replacing the existing topology.

Under PR #937, a mock Worker renders as `local_cpu`/`mock_capable`; that is a
compute and ownership contract, not a Kubernetes requirement. The independent
`deployment.workerDeploymentBackend` tells scroll-sdk-cli to install an
adapter-managed Worker as either `docker_compose` (the default, suitable for a
managed EC2 host) or `kubernetes`. `active.workerLaunch` remains the staged real
Worker placement used after `generation = "real"`.

### Step 4: generate charts and native configuration

```bash
scrollsdk setup prep-charts
```

This invokes the pinned dogeos-core compiler, validates its complete bundle,
installs it atomically, and projects the selected WP/PC/Worker/submitter values.
The compiler-rendered native TOML and generated text manifests are embedded in
those final values, so ordinary Helm commands need no dynamic `--set-file`
arguments or scrollsdk deployment helper. It does not contact Kubernetes.

For beta.3 and later real-materialize profiles, the deployment context includes
`proof_coordinator.l2_genesis_json = "/app/genesis/genesis.json"`. The generated
Proof Coordinator values mount `genesis-config/genesis.json` read-only at that
same path, including in the initially disabled posture. The CLI owns this
deployment convention: operators do not copy genesis contents into the native
Proof Coordinator TOML or change the path in a post-generation environment
overlay.

The post-#937 Worker handoff bundle has its own `bundleId`, derived from the
Worker contract, immutable image, Compose document, protocol context,
materials, and required resources. It does not contain or consume the retired
`topologyDigest`, `expected_topology_digest`, or
`DOGEOS_PROOF_TOPOLOGY_DIGEST` fields. Their presence is treated as evidence of
a stale pre-#937 bundle and fails generation or validation.

### Step 5: validate the deployment contract

```bash
scrollsdk setup proof-config-check
```

This checks the source switches, compiler bundle, Helm projection, native
configuration, Worker contract, material hashes, and secret-file modes without
network probes or printing secrets. Compiler-owned bundle files, sidecars, and
the Worker handoff bundle remain strict. Helm values must exist but are not
required to remain byte-identical: deployment-specific overlays such as the
shadowfork RPC/network projection are intentionally applied after
`prep-charts`. The Worker bundle's own manifest still verifies all of its
security-relevant files.

## 5. Switch operations

### Disabled to active mock

Edit only:

```diff
 [proof_topology]
-mode = "disabled"
+mode = "active"
```

Then regenerate and validate. With `workerDeploymentBackend =
"docker_compose"`, run `setup proof-worker`, synchronize the generated bundle
to the managed Worker host, and start it with Docker Compose. With
`workerDeploymentBackend = "kubernetes"`, deploy the generated Worker Helm
values. In both cases verify WP, PC, and the mock Worker are ready while
Attestation Signers remain in `observe`.

### Mock to real generation

Drain/stop the CPU mock Worker through its selected deployment backend. If the
already-staged `workerLaunch` is `external`, start the real Worker on the
operator-selected GPU host using the newly generated Compose handoff bundle.
Edit only:

```diff
 [proof_topology]
-generation = "mock"
+generation = "real"
```

Regenerate and deploy while enforcement remains `observe`. Watch coordinator
routing warnings and proof outcomes until real proofs are consistently
produced and verified. Worker movement is an operational action, not a proof
identity change.

### Observe to enforce

After a clean observation window, edit only:

```diff
 [proof_topology]
-enforcement = "observe"
+enforcement = "enforce"
```

Regenerate and deploy WP/PC configuration, export the matching signer policy,
and have every partner apply it. This switch does not change Worker image,
program identity, or artifact prefix.

## 6. Partner signer handoff

Attestation Signers are partner-operated and may be outside AWS. They need:

- their own descriptor and signing key;
- the exported `observe` or `enforce` policy bundle;
- static verifier/program material distributed by the operator;
- credential-free HTTPS GET access to exact proof artifact objects.

They do not need S3 list, write, or delete permission. The CLI does not deploy
partner Signers or prove their network reachability.

## 7. Safety and recovery

- `observe` still verifies and records failures; it is not proof-disabled.
- Roll back enforcement to `observe` if real proof availability regresses.
- Do not change protocol version, proof generation, and enforcement in one
  unreviewed deployment.
- Keep proof material generation outputs immutable after the receipt is
  written; rerun `proof-materials` to create a new receipt after any change.
- A software/OpenVM/circuit or deployment genesis change requires regenerated
  identities and a new Bridge bake. A normal mock/real switch does not.
- Feynman/Tsuki activation is determined by canonical protocol context, not by
  these deployment switches.
