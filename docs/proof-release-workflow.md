# Real-proof release handoff workflow

This workflow turns native dogeos-core preparation output into validated,
digest-pinned deployment input and a publicly readable program bundle. It is
designed so a new core image cut changes release inputs, not the operator's
sequence of hand-written paths.

The commands in this document do not rent a GPU, start dstack, deploy a Worker,
change Kubernetes, or activate proof enforcement. Only the final
`proof-bundle-publish --apply` command writes to S3, and it never changes the
shared bucket policy.

## 1. Produce the native files

Use the approved dogeos-core revision's native preparation tools. The CLI does
not reproduce OpenVM commitment, VK, identity-probe, verifier, or Bridge-bake
algorithms in TypeScript.

Place the resulting files in this conventional layout:

```text
release-root/
├── identity-full.env
├── real-proving-artifacts.json
├── protocol_context.json
├── bin/
│   ├── materialize-chunk-oneshot
│   └── scroll-runtime-materializer
└── bridge/
    ├── bridge-state.vmexe
    ├── openvm.toml
    ├── bridge-artifact-manifest.json
    ├── worker-identity-bundle.json
    ├── batch-aggregation.vmexe
    └── batch-aggregation-openvm.toml
```

The five Scroll software files referenced by
`real-proving-artifacts.json` may live elsewhere. The producer manifest carries
their absolute paths, sizes, and SHA-256 values; `proof-materials` verifies and
copies them later.

Capture the native handoff:

```bash
scrollsdk setup proof-release-prepare \
  --artifact-root /secure/build/release-root \
  --expected-core-revision <full-40-character-core-sha> \
  --output .data/proof-release-preparation-v1.json \
  --json
```

Use `--chunk-materializer`, `--batch-materializer`, `--identity-env`,
`--producer-manifest`, or `--protocol-context` only when a native build cannot
use the conventional layout. The command refuses symlinks, empty files,
malformed identity exports, producer/core revision drift, changed files, and an
existing output receipt. It records absolute paths because this is a local
build handoff, not an artifact to distribute to Workers.

## 2. Build and validate the production Worker image

The CUDA image build remains an explicit dogeos-core CI/release action. It may
consume paid build capacity and is intentionally not dispatched by scrollsdk.
Pass the preparation receipt's Batch and Aggregation raw commitments to the
approved `prover-worker-cuda-image.yml` workflow.

After the image is published, validate it without a GPU:

```bash
scrollsdk setup proof-worker-image-check \
  --image dogeos69/prover-worker-cuda:<release-tag> \
  --preparation-receipt .data/proof-release-preparation-v1.json \
  --output .data/proof-worker-image-check-v1.json \
  --json
```

The tag is resolved once to an immutable digest. The command pulls that digest
and checks the OCI source revision, all-family CUDA component/service labels,
compiled Batch commitment, compiled standalone Aggregation commitment, and
advertised CUDA architectures. It does not execute the CUDA binary: a real GPU
smoke and proof are still required on the selected provider.

## 3. Import the complete real materials

The two receipts replace the long list of native file and mutable image flags:

```bash
scrollsdk setup proof-materials \
  --generation real --non-interactive \
  --preparation-receipt .data/proof-release-preparation-v1.json \
  --production-worker-receipt .data/proof-worker-image-check-v1.json \
  --mock-worker-image '<approved-mock-worker-image-or-digest>' \
  --compiler-image '<approved-topology-compiler-image-or-digest>' \
  --materials-dir .data/proof-materials/<release-name> \
  --output .data/proof-materials-<release-name>.json \
  --json
```

The command rejects a preparation/Worker core-SHA mismatch, then performs the
existing strict software identity, Bridge identity, manifest hash, protocol
context, and file-boundary validation. The resulting
`proof-materials-v1.json` remains the input to the normal topology wizard and
compiler.

## 4. Compile an installable real topology

Select `mode = active`, `generation = real`, and initially
`enforcement = observe`, then run the normal generation flow. The publication
command requires the final installable compiler bundle, not a preflight-only
directory, because the compiler-generated tag-5 manifest is one of the 11
Worker program files.

```bash
scrollsdk setup doge-config --proof-topology
scrollsdk setup proof-topology-compile --deployment-dir . --preflight real
scrollsdk setup prep-charts
scrollsdk setup proof-config-check --json
```

Review the generated configuration before any cluster apply. In particular,
the production Worker digest in the compiler contract must equal the digest in
the checked materials receipt.

## 5. Plan and publish the 11-file program bundle

First run the read-only plan:

```bash
scrollsdk setup proof-bundle-publish \
  --core-dir /path/to/clean/dogeos-core \
  --materials .data/proof-materials-<release-name>.json \
  --topology-bundle .data/generated/proof-topology \
  --proof-aws-config .data/proof-aws.json \
  --json
```

The clean core checkout must be at the same full SHA recorded in the material
receipt. Scrollsdk reads the authoritative 11-entry `BUNDLE_FILES` mapping from
that revision's `tools/real-proving/publish-real-proving-bundle.sh`. It fails if
the upstream contract changed instead of silently publishing an incomplete
layout.

The release key is content-addressed:

```text
<canonical-da-prefix>/proof-programs/<bundle-id>/...
```

`bundle-id` commits to every relative path, SHA-256, and byte length. A retry
therefore writes the same bytes to the same keys; different content receives a
different prefix.

After reviewing the plan, perform the only S3-writing step:

```bash
scrollsdk setup proof-bundle-publish \
  --core-dir /path/to/clean/dogeos-core \
  --materials .data/proof-materials-<release-name>.json \
  --topology-bundle .data/generated/proof-topology \
  --proof-aws-config .data/proof-aws.json \
  --output .data/proof-program-publication-<release-name>.json \
  --aws-profile <profile> \
  --apply --json
```

Scrollsdk always invokes the core publisher with `--skip-bucket-setup`; it
cannot replace or remove the policy of a shared DA bucket. The core publisher
uploads and performs authenticated S3 readback. Scrollsdk then performs an
unsigned HTTP GET of every emitted URL and verifies its SHA-256 and exact byte
length. The publication receipt is written only after all 11 public reads pass.
The Worker bearer token is removed from the publisher environment and is never
part of the program bundle.

## 6. What remains explicit

After publication, render/hydrate the normal Worker handoff and run
`proof-worker-check` on the Worker host. Starting dstack, selecting a Vast/dstack
offer, renting a GPU, and enabling real enforcement remain separately approved
operator actions. A label check and successful S3 publication are preparation
evidence; they are not proof-generation acceptance.

When dogeos-core publishes a stable CPU preparation image/entrypoint, it may be
added as a producer for step 1. Until then, the CLI captures and validates the
native output without taking ownership of core's build algorithms.
