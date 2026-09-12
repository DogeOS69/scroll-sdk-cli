# Proof material preparation

`scrollsdk setup proof-materials` prepares the inputs consumed by the
proof-topology compiler. It has two intentionally different paths:

- `--generation mock` extracts the canonical machine-readable identity from
  the selected digest-pinned mock Worker image and records the compiler/Worker
  images. Fields that no mock runtime component cross-checks remain structural
  placeholders. It does **not** require `real-identity.env`,
  `.vmexe`, aggregate-VK, materializer, Bridge bake, or production Worker inputs.
- `--generation real` imports the complete real proving files, deployment-bound
  Bridge bake, and production Worker image in addition to those identities.

It is an operator import workflow, not a proof-software publication authority.

For published Docker tools, start with [native proof image tools](proof-image-tools.md).
`setup proof-image-tools` exports or derives native evidence without a deployment
or GPU Worker. Its receipt is not a replacement for this command's validated
material receipt. Mock proof generation with **real materialization** additionally
requires non-placeholder matching identities and the real Scroll material files;
the lightweight mock path above covers synthetic materialization only.

For a complete real release, use the
[real-proof release handoff workflow](proof-release-workflow.md). It captures all
native paths and hashes in one preparation receipt, validates the production
CUDA image in a second receipt, and lets this command import both without
repeating the individual native flags.

## What is produced

The command writes `.data/proof-materials-v1.json` with schema
`scrollsdk/proof-materials/v1`. Every receipt contains:

1. the exact Worker identity JSON, its SHA-256, and a complete structural
   Chunk, Batch, Bridge, and L2-range table (identity-probe-derived for real);
2. the digest-pinned compiler and mock Worker image references.

A real receipt additionally contains:

1. software-bound Chunk, Batch, aggregate-VK, materializer, and L2-range inputs;
2. deployment-bound Bridge inputs baked from `protocol_context.json`;
3. exact file hashes, source revisions, and toolchain facts;
4. the digest-pinned real Worker image reference.

The receipt is local deployment configuration. It can be recreated from its
artifacts; it is not canonical protocol state.

## Software-bound inputs

The pinned `scroll-zkvm-prover` build produces:

```text
chunk/app.vmexe
chunk/openvm.toml
batch/app.vmexe
batch/openvm.toml
verifier/root_verifier_vk
```

The dogeos-core setup-only identity flow derives:

```text
DOGEOS_CHUNK_VK_HASH
DOGEOS_CHUNK_PROGRAM_COMMITMENT
DOGEOS_CHUNK_PROGRAM_COMMITMENT_RAW
DOGEOS_BATCH_VK_HASH
DOGEOS_BATCH_PROGRAM_COMMITMENT
DOGEOS_BATCH_PROGRAM_COMMITMENT_RAW
DOGEOS_BATCH_SCROLL_PROGRAM_COMMITMENT_RAW
DOGEOS_BATCH_AGGREGATION_PROGRAM_COMMITMENT_RAW
```

The CLI parses only those allow-listed assignments. It never evaluates or
sources producer output as shell code.

## Deployment-bound Bridge inputs

After `.data/protocol_context.json` exists, run the dogeos-core baker and pass
its output to the CLI. The baker operation is equivalent to:

```bash
prover-worker --mode real \
  --enable-prove-bridge-transition \
  --emit-bridge-identity \
  --stage-bridge-artifact /output/bridge \
  --proof-coordinator-url http://127.0.0.1:1 \
  --artifact-read-base-url http://127.0.0.1:1/v1/prover/objects \
  --worker-token bake-token \
  --worker-id bake
```

with `DOGEOS_BRIDGE_GENESIS_CONTEXT_PATH` set to the deployment protocol
context. The command exits before connecting or claiming work. It produces:

```text
bridge-state.vmexe
openvm.toml
bridge-artifact-manifest.json
worker-identity-bundle.json
batch-aggregation.vmexe
batch-aggregation-openvm.toml
```

and one JSON object containing the Bridge and aggregation identities.
The CLI copies `worker-identity-bundle.json` verbatim and uses it as the real
compiler's `--identity-file`. Its Batch and aggregation identities and shared
recursive VK must match the imported identity probe. The deployment-bound
`bridge_guest` must match the Bridge artifact manifest; its program commitment
may differ from a software probe built with a different genesis.
`bridge-artifact-manifest.json` remains the artifact integrity manifest.
Older receipts without the worker bundle must be prepared again before real
topology compilation.

The Bridge verification key is shared recursive software identity; the Bridge
program commitment and `.vmexe` are deployment-bound because the guest embeds
the deployment genesis.

## Guided import

`scrollsdk setup proof-materials` first asks whether to prepare mock or real
materials. For mock it copies `/etc/dogeos/proof-identity/worker-identity.json`
out of the digest-pinned mock Worker image and asks only for image references.
For real it additionally asks for
`real-identity.env`, the producer manifest, both materializers,
production Worker, and optional Bridge bake. It does not reimplement or hide
the Rust/OpenVM build commands.

The compiler and mock Worker have no hard-coded release defaults. Interactive
mode requires the operator to confirm both references; non-interactive mode
requires `--compiler-image` and `--mock-worker-image`. Take both from the same
approved dogeos-core release note. This prevents an old rehearsal tag from
silently entering a fresh deployment while a new lineage is being cut.

The CLI resolves each release tag through the OCI registry and records the
resulting `repository@sha256:...` manifest reference. An explicitly supplied
digest skips that lookup. The production Worker remains an explicit input
because dogeos-core publishes its CUDA Worker through a separate hardware-
specific workflow.

For disabled/mock operation, no OpenVM build or identity probe is needed:

```bash
scrollsdk setup proof-materials \
  --generation mock \
  --compiler-image '<approved-compiler-image-or-digest>' \
  --mock-worker-image '<approved-mock-worker-image-or-digest>'
```

PR #937 deliberately gives mock no separate verifier mode: mock material is
recognized by its hash-committed `ProofMode::Mock` tag, and without aggregate
VK material the coordinator selects the dev verifier under `observe`. The
compiler still requires one structurally complete shared identity table for
every active topology. The CLI retains placeholders only for fields that are
not runtime authorities in mock mode. It passes the Worker-owned identity file
to the compiler with `--identity-file`; the compiler derives the aggregation
commitment and records the input file's kind and digest in its bundle manifest.
The CLI does not derive recursive identities in TypeScript. Mock-only values
cannot be used with `generation = "real"`.

There are two supported mock preparations:

- `--generation mock` without `--identity-env` uses the pinned mock Worker's
  canonical identity document plus synthetic placeholders. The resulting
  `withdrawal_mock_prover` profile uses one batch-wide exact-mock chunk.
- `--generation mock --identity-env /path/to/real-identity.env
  --worker-identity-bundle /path/to/worker-identity-bundle.json` plus the root
  aggregate VK and the matching Chunk/Batch materializer binaries imports the
  release's real materializer identities without importing the real proving
  programs. The resulting `withdrawal_mock_prover_real_materialize` profile
  uses the DA segmentation sidecar and real Chunk/Batch materializers, while
  the Worker still emits mock proofs and enforcement can remain `observe`.

The second form is the correct pre-production rehearsal when materializer
correctness or per-chunk performance is under test.

On Kubernetes, these imported files are also deployment evidence. The adapter
does not place the multi-megabyte materializer executables in ConfigMaps;
instead PC copies the executables already present in its selected image and
checks that their SHA-256 values match the imported release files before
startup. For real generation, the adapter also uses the root VK to generate a
checksum-verified runtime seed for WP and PC. It deliberately leaves the VK
and removes the executable real-verifier config blocks during mock generation
so PC selects the development verifier instead of attempting to parse mock
bytes as real STARK proofs. The real verifier identities used to shape and
cross-check statements remain present. This keeps the
compiler's exact runtime paths valid while detecting a PC image/materializer
lineage mismatch early.

```bash
scrollsdk setup proof-materials \
  --generation mock \
  --identity-env /secure/build/real-identity.env \
  --worker-identity-bundle /secure/build/worker-identity-bundle.json \
  --aggregate-verifying-key /secure/build/verifier/root_verifier_vk \
  --chunk-materializer /secure/build/materialize-chunk-oneshot \
  --batch-materializer /secure/build/scroll-runtime-materializer
```

For real operation, run the producer/probe/baker first, then import the full
result:

```bash
scrollsdk setup proof-materials \
  --generation real \
  --software-manifest /secure/build/real-proving-artifacts.json \
  --identity-env /secure/build/real-identity.env \
  --bridge-artifact-dir /secure/build/bridge-artifact
```

The real path also requires the two materializer binaries and production Worker
image; use `--help` for the exact flags. Import copies regular files into
`.data/proof-materials`, rejects symlinks and
path traversal, recomputes every hash and identity relationship it can verify,
and writes the same receipt as the guided path.

The preferred repeatable form is:

```bash
scrollsdk setup proof-materials \
  --generation real --non-interactive \
  --preparation-receipt .data/proof-release-preparation-v1.json \
  --production-worker-receipt .data/proof-worker-image-check-v1.json \
  --mock-worker-image '<approved-image-or-digest>' \
  --compiler-image '<approved-image-or-digest>'
```

The preparation receipt supplies the identity env, producer manifest, both
materializers, Bridge directory, and protocol context. The Worker receipt
supplies the digest-pinned CUDA image and must carry the same core revision.

## Required validation

Before writing a synthetic mock receipt, the CLI requires:

- the exact supported receipt schema;
- the exact verifier-consistent synthetic table defined by PR #937;
- commitment hashes derived from their synthetic raw app commitments;
- compiler and mock Worker tags resolved to immutable image digests.

For identity-backed mock materialization, the CLI additionally applies the
identity-env allow-list and canonical-encoding checks used by the real path,
and requires the matching dogeos-core `worker-identity-bundle.json`. The bundle
must carry a non-placeholder `batch_guest`; its Batch and Aggregation
commitments must agree with the identity env. The mock Worker's all-zero Batch
placeholder is rejected for this profile. This path also requires the root
aggregate VK and both materializer binaries because dogeos-core validates every
runtime resource used by the selected profile. It does not require `.vmexe`,
Bridge bake, or a production Worker image.

The real path additionally requires:

- every allow-listed identity-probe output, with no unknown identity-env
  assignments;
- canonical lowercase `0x` hex at the required byte lengths;
- exact source revisions and toolchain values recorded by the producer;
- SHA-256 and byte length for every imported regular file;
- the L2-range and Bridge verification key hashes to be equal;
- the Bridge manifest genesis and sequencer outpoint to match
  `protocol_context.json`;
- no missing, symlinked, or escaping material path;
- a successful `dogeos-proof-topology preflight` before deployment config is
  installed.

## Rebuild conditions

Regenerate software identities when any of these changes:

- Chunk or Batch guest source;
- Scroll proof producer revision;
- dogeos-core recursive guest source;
- OpenVM/OpenVM-STARK version;
- Rust toolchain affecting guest output;
- aggregate verifying key;
- materializer/Worker implementation expected by the selected programs.

Regenerate the Bridge bake when any software identity above changes, or when
the deployment's `protocol_context.json`, genesis sequencer outpoint, Bridge
circuit, root verifier ASM, or OpenVM version changes.

Do not regenerate materials merely because `mode`, `generation`,
`enforcement`, Worker host, Kubernetes namespace, S3 endpoint, or artifact
prefix changes.
