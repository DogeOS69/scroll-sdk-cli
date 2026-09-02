# Proof material preparation

`scrollsdk setup proof-materials` prepares the inputs consumed by the
proof-topology compiler. It has two intentionally different paths:

- `--generation mock` generates the same verifier-consistent synthetic identity
  table used by dogeos-core's PR #937 harness fixtures and records the
  compiler/mock Worker images. It does **not** require `real-identity.env`,
  `.vmexe`, aggregate-VK, materializer, Bridge bake, or production Worker inputs.
- `--generation real` imports the complete real proving files, deployment-bound
  Bridge bake, and production Worker image in addition to those identities.

It is an operator import workflow, not a proof-software publication authority.

## What is produced

The command writes `.data/proof-materials-v1.json` with schema
`scrollsdk/proof-materials/v1`. Every receipt contains:

1. a complete Chunk, Batch, Bridge, and L2-range identity table (synthetic for
   mock-only preparation; identity-probe-derived for real preparation);
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
batch-aggregation.vmexe
batch-aggregation-openvm.toml
```

and one JSON object containing the Bridge and aggregation identities.

The Bridge verification key is shared recursive software identity; the Bridge
program commitment and `.vmexe` are deployment-bound because the guest embeds
the deployment genesis.

## Guided import

`scrollsdk setup proof-materials` first asks whether to prepare mock or real
materials. For mock it generates dogeos-core's synthetic identity table and
asks only for image references. For real it additionally asks for
`real-identity.env`, the producer manifest, both materializers,
production Worker, and optional Bridge bake. It does not reimplement or hide
the Rust/OpenVM build commands.

The compiler and mock Worker prompts default to the dogeos-core
current mock rehearsal releases:

```text
dogeos69/dogeos-proof-topology:v0.3.0-beta.1
dogeos69/prover-worker-mock:0.3.0-beta.1d-rc2
```

The CLI resolves each release tag through the OCI registry and records the
resulting `repository@sha256:...` manifest reference. An explicitly supplied
digest skips that lookup. The production Worker remains an explicit input
because dogeos-core publishes its CUDA Worker through a separate hardware-
specific workflow.

For disabled/mock operation, no OpenVM build or identity probe is needed:

```bash
scrollsdk setup proof-materials \
  --generation mock
```

PR #937 deliberately gives mock no separate verifier mode: mock material is
recognized by its hash-committed `ProofMode::Mock` tag, and without aggregate
VK material the coordinator selects the dev verifier under `observe`. The
compiler still requires one structurally complete shared identity table for
every active topology, so the CLI mirrors
`dogeos_proof_topology::fixtures::synthetic_identities()` and records its
provenance as `dogeos_core_synthetic_mock_v1`. These values are not real proof
identities and cannot be used with `generation = "real"`.

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

## Required validation

Before writing a mock receipt, the CLI requires:

- the exact supported receipt schema;
- the exact verifier-consistent synthetic table defined by PR #937;
- commitment hashes derived from their synthetic raw app commitments;
- compiler and mock Worker tags resolved to immutable image digests.

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
