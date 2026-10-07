# Native proof tools from published images

`scrollsdk setup proof-image-tools` invokes dogeos-core tools from Docker images.
It does not implement commitments in TypeScript, initialize a Bridge, generate
proofs, run a Worker service, or rewrite deployment configuration. Use it before
the material import and compiler preflight in [the operator runbook](proof-operator-runbook.md).
For normal configuration, [the composed prepare/publish flow](proof-config-transactions.md)
runs both actions for you from one release manifest.

Every image must have an `org.opencontainers.image.revision` label equal to the
explicit full `--expected-core-revision` for `export`, or to the release
manifest's `revision` for `prepare-real`. Tags are resolved once; execution and
receipts use immutable digests. Pulling requires registry access; the tools
themselves run with no network, credentials or GPU. This isolation is not a
substitute for selecting trusted images.

## Bake a deployment with the release producer

dogeos-core's `proof-release.yml` publishes `dogeos-proof-release-v1.json`
(`schema`, `revision` and five digest-pinned images keyed by image name) as the
`proof-release-<tag>` pre-release.

```bash
scrollsdk setup proof-image-tools --action prepare-real \
  --deployment-dir . --release dogeos-proof-release-v1.json \
  --release-sha256 "$PROOF_RELEASE_SHA256" \
  --protocol-context .data/protocol_context.json \
  --output .data/preparation-candidate --json
```

The CLI checks the `proof-preparation-producer` revision label, then runs the
producer exactly as dogeos-core documents it:

```bash
docker run --rm --network none \
  --mount type=bind,src=<copy of protocol_context.json>,dst=/in/protocol_context.json,readonly \
  --mount type=bind,src=<staging dir>,dst=/out \
  <producer> /in/protocol_context.json /out/artifacts
```

Only the protocol context and a new staging directory are mounted. The
producer runs the runbook's `--emit-bridge-identity --stage-bridge-artifact`
bake, so dogeos-core's bake guard still refuses identity drift, and chowns its
output to the staging directory's owner. The output uses the Worker
`ARTIFACT_ROOT` layout: `chunk/`, `batch/`, `verifier/aggregate-vk`,
`protocol_context.json`, `bridge/` and `real-identity.env` with the 11 identity
exports. The CLI refuses symlinks and empty files, checks that the baked
protocol context is the input and that `bridge/worker-identity-bundle.json`
carries the release revision, then writes
`proof-release-preparation-v1.json` and makes the directory visible with one
rename.

## Export matching binaries and a compiled identity

```bash
scrollsdk setup proof-image-tools --action export \
  --deployment-dir . --output .data/generated/proof-image-tools-<release> \
  --expected-core-revision <full-40-character-core-sha> \
  --worker-image dogeos69/prover-worker-mock@sha256:<digest> \
  --coordinator-image dogeos69/proof-coordinator@sha256:<digest> \
  --json
```

This runs only `prover-worker --print-identity-json`, verifies its structure and
compiled revision, and copies two binaries from a new **stopped** Proof
Coordinator container:

- `worker-identity-bundle.json`
- `materialize-chunk-oneshot`
- `scroll-runtime-materializer`
- `image-tools-receipt.json` (source revision, image digests and file hashes)

The temporary container is removed after copying. Existing output directories
are never overwritten. The materializers are not part of the producer bake:
they ship in the release's `proof-coordinator` image, which is also the image
whose init container installs them at runtime.

A standard mock Worker build carries an all-zero `batch_guest` placeholder;
inspection mode reports it as a warning and `--require-real-materialization`
rejects it with no final output directory. Mock proving with real
materialization does not need a mock image: use the bake's
`real-identity.env` and its `bridge/worker-identity-bundle.json` without the
`bridge_guest` section (the compiler requires mock bundles to omit it), which
is the release Worker's own `--print-identity-json`.

The former `derive-scroll` action and `--scroll-identity-evidence` import were
retired with the `derive-scroll-identities` producer entrypoint: the same
values are in the bake's `real-identity.env`. Existing material receipts with
source `dogeos_core_scroll_identity_v1` still load.
