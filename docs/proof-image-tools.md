# Native proof tools from published images

`scrollsdk setup proof-image-tools` invokes dogeos-core tools from Docker images.
It does not implement commitments in TypeScript, initialize a Bridge, generate
proofs, run a Worker service, or rewrite deployment configuration. Use it before
the material import and compiler preflight in [the operator runbook](proof-operator-runbook.md).

Every image must have an `org.opencontainers.image.revision` label equal to the
explicit full `--expected-core-revision`. Tags are resolved once; execution and
the receipt use immutable digests. Pulling/resolving requires registry access;
tool execution has no network, credentials, GPU, capabilities or writable root
filesystem. This isolation is not a substitute for selecting trusted images.

## Export matching binaries and a compiled identity

```bash
scrollsdk setup proof-image-tools --action export \
  --deployment-dir . --output .data/generated/proof-image-tools-beta4e \
  --expected-core-revision eef62d3e40a387b1f53b24825c2e85af54facbc8 \
  --worker-image dogeos69/prover-worker-mock@sha256:e5de8a3782b88590eda0083977cf882c61b1eb2994fdd647e464984cb1f69a38 \
  --coordinator-image dogeos69/proof-coordinator@sha256:33fcd96d753612ab23a1b0f65139ea66e53e9d61ee9a80d815059a7f63099073 \
  --json
```

This runs only `prover-worker --print-identity-json`, verifies its structure and
compiled revision, and copies two binaries from a new **stopped** PC container:

- `worker-identity-bundle.json`
- `materialize-chunk-oneshot`
- `scroll-runtime-materializer`
- `image-tools-receipt.json` (source revision, image digests and file hashes)

The temporary PC container is removed after copying. Existing output directories
are never overwritten. Use a new output name for each attempt.

**Verified 2026-09-09:** beta.4e exports successfully, but the mock image contains
an all-zero `batch_guest`. Inspection mode reports this as a warning. Add
`--require-real-materialization` to reject this placeholder with a nonzero exit
and no final output directory. A non-placeholder value alone is not certification:
the imported native identity, material files and compiler cross-checks must also
agree. Runtime environment overrides cannot change compiled Worker identities.

## Derive candidate Scroll identity evidence on CPU

The following is a **historical inspection command**, not approval to deploy an
old release. The producer is from PR #935, not beta.4e. The candidate package and
its verified provenance are documented in [the bridge-preserving upgrade notes](next-devnet-preserve-bridge.md).
Set `CANDIDATE_RELEASE` to its extracted `proof-release` directory first.

```bash
scrollsdk setup proof-image-tools --action derive-scroll \
  --deployment-dir . --output .data/generated/proof-scroll-identities-pr935-inspection \
  --expected-core-revision aa856ab3f9718f914326bd3fc4b0ea8f809016f8 \
  --producer-image dogeos69/proof-artifact-baker@sha256:29bda56763c1b1adc5e6b5ee8d090c11deab4904ff54201cf88ca6b3cf80fc88 \
  --artifact-root "$CANDIDATE_RELEASE" --json
```

The native `/usr/local/libexec/dogeos-proof-release-producer
derive-scroll-identities` receives only five staged public files:
`chunk/app.vmexe`, `chunk/openvm.toml`, `batch/app.vmexe`, `batch/openvm.toml`,
and `verifier/aggregate-vk`. Neighboring files, source trees and deployment
secrets are not mounted. It produces `proof-scroll-identities-v1.json`; the
receipt records all five input hashes and the output hash. CLI checks the native
output schema but does not convert it into an approved Worker identity bundle.

Actual devnet inspection on 2026-09-09 completed in 179 seconds on CPU. The
derived file SHA-256 is
`7a09451ec218275a5ec794b8a657172fb4e7c378a0cad1e834195ae737fc9f9a`.
The beta.4e exported materializer SHA-256 values are
`c1b4bc963b3d36da8d9942f58d5cea7dc31fcdf3f9de90ca173448de9927fddc`
(Chunk) and `32d1b9d0f19a168af13dc01e216bdaa3c629b06189ff280564cc3449dadbd1be`
(Batch). Strict export was also run: it correctly exited 1 with
`E717_PROOF_IMAGE_TOOL_FAILED` for the placeholder Batch and created no final
output directory. TypeScript build and 196 proof/deployment tests passed;
targeted lint has no errors and one complexity warning.

## Current release gap and the next activation gate

The inspected Docker Hub repositories contain a historical CPU artifact baker,
beta.4e PC materializers and beta.4e mock Worker. No matching beta.4e CPU identity
producer was found in that inspection. The historical producer's outputs cannot
certify a beta.4e Batch/Aggregation build.

Core already has the source workflow:
`tools/real-proving/run-local-real-verifier-e2e.sh --check-only ENV_FILE`
derives Batch and then Aggregation identities through the CPU identity probe,
rebuilding with the derived compile-time commitments. The resulting matching
Worker can export its native JSON. `check-real-verifier-start.sh` checks verifier
construction without generating a proof. These workflows still need their
documented inputs and matching toolchain; a stock mock Worker invocation is not
a replacement for that derivation.

**Core packaging follow-up (record only; no core source changes made):** publish
the current CPU identity/probe and verifier-start tooling, with provenance and
an interface consuming the approved Scroll inputs, or provide the corresponding
matching build outputs. Do not invent commitments or reuse the old aggregation
identity merely to pass compilation.

After matching native identities and validation are available, import them with
`setup proof-materials`, compile `withdrawal_mock_prover_real_materialize`, and
follow the preserved-Bridge cutover. The target remains internal `mock + observe`
with real materialization, eager producer and no Worker deployment. Neither of
the commands above completes that activation or the end-to-end checklist.
