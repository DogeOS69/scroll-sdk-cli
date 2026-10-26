# DogeOS proof operator runbook

This is the operator-facing procedure for preparing and deploying DogeOS proof
services. It follows dogeos-core PR #937's two-switch model, updated for PR #1136
(coordinator-internal mock proving and eager materialization). The generated
Withdrawal Processor, Proof Coordinator, Worker, submitter, and signer files are
compiler outputs; do not edit them by hand.

For current configuration checks before deployment, including new-instance
S3/IAM grants and signer Docker routing, follow
[deployment preflight](deployment-preflight.md). These checks do not replace
proof acceptance or perform database recovery.

## 1. The three operator fields

The normal source of truth is `.data/doge-config.toml`:

```toml
[proof_topology]
mode = "disabled"       # disabled | active
generation = "mock"     # mock | real
enforcement = "observe" # observe | enforce
observeRealProofDeadlineMs = 1800000 # Explicit example: 30 minutes, no implicit default
```

The fields are independent:

| Field | Meaning |
|---|---|
| `mode` | Whether proof work is active; disabled keeps an idle Coordinator. |
| `generation` | `mock`: Coordinator produces proofs internally; `real`: production Workers produce proofs. |
| `enforcement` | Whether failed, missing, or mock proof outcomes are observed and allowed, or rejected. |

Use these postures in order:

| Stage | `mode` | `generation` | `enforcement` |
|---|---|---|---|
| Proof services off | `disabled` | `mock` | `observe` |
| Exercise the complete topology cheaply | `active` | `mock` | `observe` |
| Generate and validate real proofs | `active` | `real` | `observe` |
| Require real verified proofs | `active` | `real` | `enforce` |

Never use `generation = "mock"` with `enforcement = "enforce"`. Mock and real
proof statement mode is derived from **enforcement**, not generation. Changing
observe to enforce changes statement identities and requires a fresh/regenerated
proof store; do not migrate old proof rows into the new statement namespace.

The source deadline is required even for mock and disabled modes. CLI emits
`[proof_topology].observe_real_proof_deadline_ms`, and the compiler emits
`[verifier].observe_real_proof_deadline_ms`. Under real/observe a deadline,
permanent prover failure or verification failure can trigger internal mock
fallback; enforce continues to reject mock material.

For the preserve-existing-bridge upgrade and its release-material prerequisite,
see [Next-devnet upgrade without bridge reinitialization](next-devnet-preserve-bridge.md).

`observe` is a staging posture and Attestation Signer refuses it on Dogecoin
mainnet. A mainnet deployment must not activate proof-conditioned signing until
real generation is healthy and all enforcement/policy surfaces use `enforce`.

Changing a switch means editing the one high-level value, rerunning
`scrollsdk setup prep-charts`, reviewing the generated diff, and applying the
normal Helm deployment. It does not mean editing native service files.

In disabled mode Kubernetes retains one idle Coordinator process, but the native
configuration has no prover HTTP listener. CLI generation therefore uses exec
process-presence probes (`kill -0 1`) for this mode, not `/healthz` or `/readyz`.
Idle Ready means only that the daemon is alive; it does not certify proof work,
gateway health or Worker readiness. Active generation restores the prover-port
HTTP probes. Both transitions explicitly null the previous probe handler because
Helm otherwise merges it with chart defaults. Do not enable a fake prover gateway
or remove active HTTP checks to make an idle deployment appear functional.

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

For repeatable real releases, it additionally captures the complete native
handoff, checks the production CUDA image's compiled labels, and safely invokes
the matching dogeos-core 11-file publisher. See the
[real-proof release handoff workflow](proof-release-workflow.md). GPU rental,
dstack startup, proof execution, and enforcement activation remain explicit
operator actions.

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
│   │       ├── worker-identity-bundle.json
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

### Step 1: establish the proof artifact store

Raw EIP-4844 blobs and proof-system objects live in separate buckets. The DA
archive is `[ethereumDa.blobArchive.s3]`; the proof artifact store (chunk
inputs, segmentation sidecars, materializer outputs, proofs) is
`[proofArtifacts.s3]` in `.data/doge-config.toml`. eth-da-submitter writes DA
blobs to the first and only its segmentation sidecars to the second. See
[ethereum-da-s3.md](ethereum-da-s3.md#three-buckets).

Configure `[proofArtifacts.s3]` (bucket, region, keyPrefix) first, and then
run:

```bash
scrollsdk setup proof-aws-init
```

This uses the configured proof bucket/prefix, creates or reconciles the proof
IAM roles and token secret, configures the selected external read transport,
and writes `.data/proof-aws.json`. The DA archive configuration is independent.
Choose the public-read mode according to who owns the bucket-level policy:

- `existing-public-s3` uses the regional S3 endpoint on an existing, possibly
  shared, bucket. The CLI makes the selected prefix's external-consumer paths
  (including `deployment-kits/`) anonymously readable: when the policy already
  grants them it is left unchanged, otherwise the CLI adds only this
  deployment's own prefix-scoped statement. It never edits other statements or
  any Public Access Block, and stops before IAM/secret changes when a Public
  Access Block or Deny statement would prevent the reads. The CLI also manages
  the prefix's IRSA roles, optional EKS S3 Gateway endpoint statement, and
  proof token secret.
- `direct-s3` makes the CLI manage anonymous reads for the required external
  proof paths. Use it only where the CLI is allowed to manage the bucket-wide
  Public Access Block posture. It rejects an unmanaged public `GetObject`
  statement that overlaps the selected prefix before creating a VPC endpoint
  or changing IAM/secrets.
- `existing-gateway` keeps S3 private and records an operator-managed
  credential-free HTTPS gateway.

Every mode keeps proof artifacts forever: the CLI owns an abort-only lifecycle rule
for the prefix and refuses a rule that would expire, permanently delete or archive
its objects (see [deployment preflight](deployment-preflight.md)).

`existing-public-s3` does not narrow a pre-existing broad policy such as
`arn:aws:s3:::bucket/*`; it only confirms that the required paths are readable.
Review broader exposure independently.
If the bucket is in a different AWS region from EKS, the command keeps the
EKS/Secrets region separate from the artifact region and skips the regional S3
Gateway endpoint; cross-region access uses the normal S3 endpoint or an
operator-managed gateway. It does not prepare proof programs.

When `existing-gateway` is selected, the bucket policy and S3 Public Access
Block settings remain entirely operator-managed: `proof-aws-init` does not
change either one. This matters when the shared archive bucket already serves
raw DA objects publicly. The operator must verify that the supplied HTTPS
endpoint permits the required exact-key reads; selecting this mode is not
evidence that the route is reachable or that the bucket is private.

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

The identity env and Worker bundle come from the release producer's bake
(`real-identity.env`, and `bridge/worker-identity-bundle.json` with its
`bridge_guest` section removed, as the compiler requires for mock). See
[image tools](proof-image-tools.md).

```bash
scrollsdk setup proof-materials \
  --generation mock \
  --identity-env /secure/build/real-identity.env \
  --worker-identity-bundle /secure/build/worker-identity-bundle.json \
  --aggregate-verifying-key /secure/build/verifier/root_verifier_vk \
  --chunk-materializer /secure/build/materialize-chunk-oneshot \
  --batch-materializer /secure/build/scroll-runtime-materializer
```

`setup doge-config --proof-topology` then selects
`withdrawal_mock_prover_real_materialize`. The compiled bundle enables all
three ends of the contract: the submitter publishes the segmentation sidecar,
the coordinator reads and validates it, and Withdrawal Processor requests the
materialized segmentation before creating per-chunk work. Proof Coordinator
produces mock proofs internally; no mock Worker is rendered or deployed.
The identity bundle must come from the same dogeos-core bake as the env values;
the CLI rejects the all-zero `batch_guest` shipped by the ordinary mock image.
The aggregate VK and two materializer binaries are also required by the
dogeos-core selected-profile preflight even though proof generation remains
mock. Only the proving `.vmexe` files and production Worker image stay absent.

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
asks for the Worker-visible Proof Coordinator URL, and stages external real
Workers managed by Capacity Manager. It defaults to disabled/mock/observe and
runs compiler preflight before replacing the topology.

Mock generation produces no Worker contract or Worker service. Real Workers use
the compiler's external contract; the CLI no longer selects a Compose or local
Kubernetes worker backend.

### Step 4: generate charts and native configuration

```bash
scrollsdk setup prep-charts
```

This invokes the pinned dogeos-core compiler, validates its complete bundle,
installs it atomically, and projects the selected WP/PC/Worker/submitter values.
The compiler-rendered native TOML and generated text manifests are embedded in
those final values, so ordinary Helm commands need no dynamic `--set-file`
arguments or scrollsdk deployment helper. It does not contact Kubernetes.

The same pass resolves the eth-da-submitter `L1_COMMIT_SENDER` and writes it
into Withdrawal Processor's `ethereum_da.inbox_worker.expected_batchers`
allowlist. Operators must not maintain a second sender address in WP. For KMS,
generation fails if the account projection and signer-bound expected address
have drifted, preventing the submitter and WP from selecting different DA
publisher authorities.

For a real-materialize profile without a pre-populated proof-material PVC, the
generated PC values stage the two materializer executables at the exact
compiler runtime paths. They are not embedded in a ConfigMap: the init
container copies them from the selected PC image and verifies both against the
SHA-256 values of the files imported by `setup proof-materials`. A mismatched
PC image therefore fails before the coordinator starts. When generation is
`real`, the generated WP and PC values additionally stage the binary root VK
through a release-scoped Kubernetes Secret. Mock generation deliberately does
not mount the root VK, because its absence under observe enforcement selects
the development verifier that accepts mock proof envelopes. The adapter also
removes only the compiler-rendered executable real-verifier blocks in this
mock case; the canonical verifier identities and real materializer sections
remain intact. Without that projection, beta.3 PC selects `real_scroll` from
the block's presence and rejects the mock envelope before observe-mode policy
can use it. When
`resourcesPersistentVolumeClaim` is configured, that operator-populated,
read-only release PVC remains authoritative instead.

For beta.3 and later real-materialize profiles, the deployment context includes
`proof_coordinator.l2_genesis_json = "/app/genesis/genesis.json"`. The generated
Proof Coordinator values mount `genesis-config/genesis.json` read-only at that
same path, including in the initially disabled posture. The CLI owns this
deployment convention: operators do not copy genesis contents into the native
Proof Coordinator TOML or change the path in a post-generation environment
overlay.

Capacity Manager consumes the compiler Worker contract, the immutable image
receipt and the verified program publication. Its generated launch command
checks resource hashes before running the Worker. There is no transferable
Compose Worker bundle or separate host hydration step.

### Step 5: export the signer deployment kit

After the final `prep-charts` pass of an active/real/enforce deployment, export
the deployment kit for the external Attestation Signer operators (`setup apply`
does this itself for enforcing specs):

Wait for `prep-charts` to finish before starting this command. Chart preparation
transactionally replaces `.data`; a concurrently created kit export can be
discarded by that replacement.

```bash
scrollsdk setup export-deployment-kit
# publish deployment-kit-<version>/ unchanged at an immutable https URL, then record it:
scrollsdk setup export-deployment-kit --published-url <URL>
```

The command derives the public TSO URL from `config.toml [ingress].TSO_HOST`,
the canonical protocol identity from `.data/protocol_context.json`, and the
signer-readable proof artifact base URL from the generated Withdrawal
Processor configuration. The kit version is derived from those signer-relevant
inputs: a rerun is a no-op, and a changed endpoint or verifier is a new kit
version in a new directory, never an overwrite. Publish the directory (or an
archive of it) unchanged at an immutable URL, copy the printed
`protocol_instance_id`, kit version and manifest SHA-256 into the deployment
record, and record the URL with `--published-url`. Only the canonical kit built
from the deployment inputs can be recorded; to change an endpoint, update the
deployment input and export again. `deployment-preflight` requires the recorded
kit for enforcement.

### Step 6: validate the deployment contract

```bash
scrollsdk setup deployment-preflight
```

This checks the source switches, compiler bundle, Helm projection, native
configuration, Worker contract, material hashes, and secret-file modes without
network probes or printing secrets. Compiler-owned bundle files, sidecars, and
the Worker contract and publication receipts remain strict. Helm values must exist but are not
required to remain byte-identical: deployment-specific overlays such as the
shadowfork RPC/network projection are intentionally applied after
`prep-charts`. Capacity Manager's generated launch command verifies published
resource hashes before starting a Worker.

## 5. Switch operations

### Disabled to active mock

Edit only:

```diff
 [proof_topology]
-mode = "disabled"
+mode = "active"
```

Then regenerate and validate. Deploy WP and PC; keep all legacy mock Workers
stopped. Mock generation needs no GPU Worker. When the compiler declares
`eager_materializer`, deploy that service with the matching genesis, namespace
and prefix-scoped store credential. Verify proof rows reach `succeeded` with
zero Worker pods/containers, while Attestation Signers remain in `observe`.

### Mock to real generation

There is no CPU mock Worker to drain on PR #1136. Stage `workerLaunch: external`
and Capacity Manager intent, then edit:

```diff
 [proof_topology]
-generation = "mock"
+generation = "real"
```

Regenerate and deploy the proof services and Capacity Manager while enforcement
remains `observe`. The manager starts external GPU Workers. Watch coordinator
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

Regenerate and deploy WP/PC configuration, export and publish the deployment
kit (`export-deployment-kit`, then `--published-url`), and have every partner
import it. The switch is not accepted until `scrollsdk setup deployment-preflight
--live --kube-context <context> --namespace <namespace>` passes: every
Attestation signer in the WP `tsoSigners` must show a fresh authenticated TSO
poll. A failure means liveness, not safety; signing stalls until they poll. This switch does not change Worker image,
program identity, or artifact prefix.

## 6. Partner signer handoff

Attestation Signers are partner-operated and may be outside AWS. They need:

- their own descriptor and signing key;
- for an enforcing deployment, its published deployment kit and the kit's
  manifest SHA-256 from the governance record (observe and mock deployments have
  no kit);
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
- Any topology recompile that changes the compiled Worker identity-bundle
  revision changes proof identity. Do not preserve successful rows from the
  previous identity. Stop every Proof Coordinator and Worker, wait until no
  proof-work lease is live, and perform the Withdrawal Processor's one-shot
  global regeneration before resuming proof execution:

  ```toml
  [proof_execution.regenerate]
  created_before_ms = <current epoch milliseconds when the operation is written>
  scope = "global"
  ```

  Roll Withdrawal Processor once and require its startup log to report the
  completed reset and control-plane-store rotation. Remove the block
  immediately, roll Withdrawal Processor again, then restart Proof Coordinator
  and Workers. Never leave this block in durable production values. Global
  regeneration supersedes all matching proof rows, including successful rows,
  and discards accepted remote receipts; it does not delete the derived
  artifact store or alter an already-built WF transaction.
- Feynman/Tsuki activation is determined by canonical protocol context, not by
  these deployment switches.

## 8. Worker credentials

Since dogeos-core #1591 the Proof Coordinator holds one coordinator-only
**master** secret (`prover_api.worker_auth_token_file`). Every Worker
authenticates with its own credential,
`<name>.<hex HMAC-SHA256(master, "dogeos-prover-worker-v1" || 0x00 || name)>`,
and its `--worker-id` must equal `name`. The old shared raw token is rejected.
See `crates/proof_coordinator/README.md` and the "Worker credentials" section of
`docs/engineering/aws-gpu-dstack.md` in dogeos-core (#1598) for the core rules.

**Never copy the master to a Worker.** Anyone holding it can mint a credential
for any worker name. A Worker handed the master fails at startup, because the
master has no `<name>.` prefix.

Where each value lives:

| Value | Stored in | Read by |
| --- | --- | --- |
| Master | Secrets Manager property `prover-worker-master`, synced to the coordinator Secret key `prover-worker-token` | Proof Coordinator, capacity manager |
| Worker credential | Per Worker, minted for that Worker's id | That Worker only |

Capacity Manager mounts the master from the coordinator Secret as
`--worker-credential-master-file`. The Core controller mints a credential for
each run; the CLI does not mint or distribute Worker credentials. No dstack
project secret is used for the Worker credential.

The beta.8 compiler receives separate runtime paths: `workerTokenFile` names
only the coordinator master (default `/app/secrets/prover-worker-token`), while
`prover_worker.worker_credential_file` is `/app/secrets/prover-worker-credential`.
The two paths must differ. The generated Capacity Manager launch command maps
the Worker credential to its own private file.

Select compiler and runtime images that support separate coordinator-master and
worker credentials. For custom Core tags, verify that every participating image
supports the `worker_credential_file` schema; tag ordering alone does not establish
compatibility. If the compiler reports `unknown field worker_credential_file`,
select a compatible compiler and runtime release while retaining the field and
credential separation. Verify compiler schema compatibility before deployment in
addition to the proof manifest and image-pin checks performed by `setup plan`.

**Upgrading from a shared token.** `setup proof-aws-init` adds a fresh
`prover-worker-master` to an existing secret. It does not reuse the old
`prover-worker-token`, which every existing Worker knows. The old property stays
in place until you pass `--rotate-tokens`, so a running coordinator keeps
syncing until `setup prep-charts` repoints it.

**Rotation**, from a shared token or for a later rotation:

1. Drain the old fleet using the Capacity Manager operational procedure. Stop
   scheduling and confirm all owned runs have stopped before rotating credentials.
   Legacy manual sessions must be retired with their original tooling.
2. For the first migration, run `scrollsdk setup proof-aws-init` to add a fresh
   master while preserving `proof-work-token`. For full rotation, use
   `--rotate-tokens`: it replaces both `prover-worker-master` and
   `proof-work-token`.
3. Re-render with `setup prep-charts` and apply the updated Secret mappings.
   Wait for all affected ExternalSecrets and Kubernetes Secrets to synchronize.
   After full rotation, restart **WP, the Proof Coordinator, and the capacity
   manager**. WP's token uses a `subPath` mount, so Secret synchronization alone
   does not refresh it. For first-time migration with the proof-work token
   unchanged, restart the coordinator and manager to load the master.
4. Resume Capacity Manager after its new master is loaded. The Core controller
   mints new credentials when it starts Worker runs.
