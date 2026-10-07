# dogeos-core PR #1177: proof release tools review

Reviewed on 2026-09-21 against
[the CubeSigner/proof configuration design](cubesigner-proof-configuration-design.md)
and [dogeos-core PR #1177](https://github.com/DogeOS69/dogeos-core/pull/1177).
The reviewed branch is `feat/proof-release-contract`, at
`fc75a1196fa9bcdf77c250c2e7bd2176d5a69dbc`. The PR is open at review time.

## Implementation follow-up (2026-09-21)

The original audit below is historical. Work continues on the **same open PR
branch**, with no merge. Current code adds:

- a governed five-file input lock, CI downloader and complete CPU preparation producer;
- a coherent six-image pipeline, with runtime images copied from the producer's
  exact binaries and CUDA child commitments derived from the same native identity;
- revision/native-identity/materializer-byte checks before manifest assembly,
  plus a retention-independent OCI carrier for the release manifest;
- CLI release validation, networkless preparation, image-based 11-file
  publication and transactional `proof-config prepare` / `publish` commands;
- explicit CubeSigner mode and receipt validation/live-evidence projections,
  contract-selected signer export, semantic managed-values checks and an
  enforcement evidence gate.

The existing core CI variable pins release
`proving-openvm17-0badaf7a-eef62d3` with manifest SHA-256
`a0652b8176358f0d46eceb5190ab24e4e71fa0d59c5a3810c3438bff022093b6`.
The five files were downloaded, every size/SHA checked, and native Scroll
identity derivation succeeded. [The input lock](proof-scroll-inputs-pr1177.json)
records immutable checksums and source/toolchain provenance. Older core
materializers in that release are deliberately excluded and rebuilt in CI.

User update (2026-09-21): a newer Scroll five-file program/VK bundle release was
expected soon. That release is now verified in the 2026-09-24 follow-up below.
Do not mix new core materializers with the coherent candidate images or treat
input verification as production policy approval.

The first complete producer build (74ab8b1) succeeded, but its actual non-root,
read-only runtime failed because OpenVM rewrites guest init files; a further
check exposed guest build logs on stdout. Both are fixed in 6700d4b. That initial
image is recorded as **do not use**, not as a supported preparation release.
All six image jobs in [the image build](https://github.com/DogeOS69/dogeos-core/actions/runs/35559535311)
succeeded at compiled revision `6700d4baca0830bb5ac26bfee5a17c53aa725c42`.
Its original manifest step failed because the CUDA dependency initializes GPU
memory before `main`, so a CPU runner cannot execute its identity command.
A vendor linker stub was also checked and correctly rejected by that dependency;
no simulated GPU result was accepted.

Native CUDA identity was then captured on an existing RTX 3060 (compute 8.6)
with NVIDIA driver 595.97. The [GPU receipt](proof-cuda-identity-pr1177.json)
binds actual native output to the image digest and binary SHA-256.
Commit `d85ac570463f9f1fd0356a5ec5ca6a82621a33ea`, on the same unmerged PR branch,
adds capture/finalization tooling and that evidence; it changes no compiled
runtime source. All six software images remain at the same 6700d4b revision.

[Finalization run 35562852527](https://github.com/DogeOS69/dogeos-core/actions/runs/35562852527)
**passed**. It independently verified all image revisions/contracts, the GPU
receipt's image and binary checksum, native child identities and coordinator
materializer bytes. [The complete release manifest](dogeos-proof-release-pr1177.json)
has SHA-256
`51645abda8736504dfb82ae16578297b66ec4b7fa26a718885c95c21aff2a2ef`.
Its persistent OCI carrier is
`dogeos69/proof-release@sha256:3bf1790f0d9babb394994227460bf60756480094e691bc23106961c6692b2a12`.
[The image inventory](proof-tool-images-pr1177.json) records all actual tags,
digests and both build/finalization results.

Local verification: TypeScript type-check and build; 547 full-suite tests passed
with 13 pre-existing pending tests. Changed TypeScript files have no ESLint errors (complexity/type
warnings remain). Core release tests: 7 passed.

The published 6700d4b producer was exercised locally against a copy of the
existing AWS devnet's public protocol context. It completed native
Bridge/aggregation baking without network, GPU, credentials or host sources,
with a read-only root, non-root UID and only two input/output binds. All 16
receipt files matched their recorded sizes and SHA-256 hashes. The producer
receipt SHA-256 is
`850661d14ac9190ba9ab2e1655e10cc4578c8be24529cb8ed1144011b5253b33`.
This verifies the published image itself; it is not a GPU real-proof result.

For that specific devnet context, the baked Bridge program commitment and genesis
Bridge namespace differ from the policy's existing candidate pins; the aggregate
VK digest matches. Consequently, those candidate policy pins cannot be treated
as an approved policy for this deployment without the corresponding policy
build, verification and provider readback.

The composed CLI flows also passed against temporary candidates using a copy
of the existing devnet's public protocol context and offline validation URLs:

- `proof-config prepare` for mock, followed by `proof-config-check`;
- the actual, unmodified real `proof-config prepare` command using the published
  manifest and producer (458,701 ms, including native baking);
- `proof-config publish` without `--apply`, producing the frozen 11-file plan.

The real prepared receipt SHA-256 is
`5b61eb203a1eb6ce20f718db67c29f0660c219170bb86376e8b21a9cb336677f`.
All 132 frozen files were checked; the signer handoff contains six files. The
candidate retains a prepared contract, with no fabricated publication receipt
or final active contract. Initial integration failures exposed real-identity
`bridge_guest` parsing and mock signer artifact-URL selection; both were fixed
and covered by regression checks. Existing deployment files were read as input.

Production activation remains separately blocked on the selected deployment
and real policy/provider/signer evidence. The existing core policy README marks
its embedded pins as candidate/test material. The CLI consumes and checks policy
release/attachment receipts; it does not fabricate them, approve existing test
pins, attach policies, deploy services or provision GPU capacity. A real-proof
end-to-end run has not been performed by this follow-up.

## Isolated E2E follow-up (2026-09-24)

The user selected **isolated E2E only**, with no updates to the existing
devnet/testnet deployments. PR #1177 remains open at `d85ac570`; it is not merged.

The newly selected upstream input release is
[`proving-openvm17-0badaf7a-d4e65b65`](https://github.com/DogeOS69/dogeos-core/releases/tag/proving-openvm17-0badaf7a-d4e65b65),
published 2026-09-24T03:22:47Z. Its manifest SHA-256 is
`1ad8be98f1f818a211c70adb799d71c65497101a7b5a308093c05f02925b4ec2`.
All seven assets were downloaded and their bytes checked against the manifest.
The five circuit files are identical to the existing locked inputs; only the two
core materializers changed. The actual CLI `proof-image-tools --action
derive-scroll` used the published 6700d4b producer on the newly downloaded files
and independently matched all seven manifest identities. See the
[download verification](proof-proving-inputs-20260924.json) and
[native identity evidence](proof-scroll-identities-20260924.json).

The current immutable six-image release remains unchanged. The updated standalone
materializers are not substituted into its producer/coordinator. The new upstream
manifest still selects a different, older GPU Worker (`51caece7`) for its own
Scroll proving workflow; that is not the PR #1177 six-image candidate.

The new [isolated publisher integration script](../scripts/proof-publisher-e2e.mjs)
passed with the CLI's frozen real preparation receipt and actual published
publisher image. It uploaded all 11 files to a fresh MinIO on an internal Docker
network, verified authenticated readback, all anonymous object hashes/sizes, the
exact object inventory, and HTTP 403 after removing the test read policy. The
temporary containers/network were removed. The
[passing report](proof-publisher-e2e-20260924.json) deliberately does not claim
`proof-config publish --apply` final-contract, real GPU proof, or signer coverage.
The existing deployment directory and AWS bucket were not modified.

[Isolated GPU run 35953123367](https://github.com/DogeOS69/dogeos-core/actions/runs/35953123367)
was dispatched on the unmerged PR branch with the new input manifest pinned by
SHA-256, RTX 4090, a $1/hour offer cap, and a 90-minute rental execution deadline
(cleanup and transfer billing are separate). It creates its own test services;
the workflow performs CPU preflight before renting and has rental cleanup.
The CPU preflight passed. The run then attempted a real Vast rental, but allocation
failed with HTTP 400 `invalid_args` / `no_such_ask`: offer `35283310` was no longer
available. No instance ID was returned and proving never started. The evidence
records `last_phase: allocation`; cleanup found no owned instance to destroy,
and the separate cleanup job passed. The workflow result is **failure**, not a
real-proof pass. No retry was dispatched during the user's follow-up inquiry.
Its scope is Scroll chunk/batch prove/verify/import, not Bridge proof, CubeSigner,
or CLI-generated deployment topology acceptance.

## Original review result

The PR supplies two useful partial tools. It does **not** satisfy the complete
source-free proof release or CubeSigner configuration design. Publishing its
images closes an artifact-availability gap, not the remaining implementation gaps.

| Design requirement | Reviewed implementation | Result |
| --- | --- | --- |
| Native CPU Scroll identity derivation | `dogeos-proof-release-producer derive-scroll-identities` accepts five caller-supplied public program/VK files and emits `dogeos/proof-scroll-identities/v1`; the Docker build embeds the core revision. | Implemented; compatible with the existing CLI `proof-image-tools --action derive-scroll` interface. |
| Complete offline `prepare-real` producer | Producer has only the `derive-scroll-identities` subcommand, takes no protocol context, and does not bake deployment-bound Bridge/Aggregation artifacts or emit a complete preparation root. | Missing. |
| Immutable generic program/VK bundle | The five public files must be supplied by the caller; neither new Dockerfile packages them. | Missing from this PR. |
| Unified `dogeos-proof-release-v1.json` | No release manifest binds toolchains, generic files, producer, publisher/mapping, compiler, Coordinator, mock/CUDA Worker and optional policy evidence. | Missing. A pair of image digests is not this manifest. |
| Packaged 11-file publisher | Image packages the existing S3 upload/readback script and forces `--skip-bucket-setup`; labels identify the revision and mapping version. Readback uses authenticated S3 GET, not unsigned public GET. | Tool implemented. The release manifest mapping, CLI receipt-pinned execution and public readback remain missing. |
| Source-free CLI publication | Current `proof-bundle-publish` still reads the file mapping and invokes the script from `--core-dir`. | CLI integration missing; recording the publisher image does not change that behavior. |
| CubeSigner policy release and attachment receipts | PR changes no CubeSigner receipt producer or provider-readback contract. | Missing. Existing policy CI success is not release/attachment evidence. |
| CLI policy mode, evidence mounts, managed-block checks and transactional prepare/publish | These are CLI work, outside the PR's nine changed files. Initial values still hardcode `production_verifier_key_policy`; `proof-image-tools` exposes only `export` and `derive-scroll`. | Not fulfilled by this core PR. |

Source:
[core tool contract](https://github.com/DogeOS69/dogeos-core/blob/fc75a1196fa9bcdf77c250c2e7bd2176d5a69dbc/docs/engineering/proof-release-images.md),
[producer implementation](https://github.com/DogeOS69/dogeos-core/blob/fc75a1196fa9bcdf77c250c2e7bd2176d5a69dbc/crates/prover_worker/src/bin/proof_release_producer.rs),
[publisher Dockerfile](https://github.com/DogeOS69/dogeos-core/blob/fc75a1196fa9bcdf77c250c2e7bd2176d5a69dbc/tools/real-proving/Dockerfile.publisher).
CLI sources:
[proof-image-tools](../src/commands/setup/proof-image-tools.ts),
[proof-bundle-publish](../src/commands/setup/proof-bundle-publish.ts),
[values generator](../src/utils/values-generator.ts).

## Image publication

Before dispatch, the branch had no `docker-build.yml` runs, and public Docker Hub
queries for both new repositories returned HTTP 404. PR CI had passed, but it
had not published these images.

The first publisher build
[35555295547](https://github.com/DogeOS69/dogeos-core/actions/runs/35555295547)
failed because the AWS CLI base image includes `coreutils-single`, which conflicts
with the Dockerfile's `dnf install coreutils`. Commit
[`30e20987357316307d45362baebb866a9255585b`](https://github.com/DogeOS69/dogeos-core/commit/30e20987357316307d45362baebb866a9255585b)
on the same PR branch uses `coreutils-single` and explicitly installs `gawk`,
which the publication script uses. The original producer build was cancelled
so both final tools can identify the same corrected source revision.

Both builds were then requested with `build_arm64=false`, revision
`30e20987357316307d45362baebb866a9255585b`, and tag `pr-1177-30e2098`:

| Image | GitHub Actions run |
| --- | --- |
| `dogeos69/proof-release-producer:pr-1177-30e2098` | [35555523088](https://github.com/DogeOS69/dogeos-core/actions/runs/35555523088) |
| `dogeos69/proof-bundle-publisher:pr-1177-30e2098` | [35555521369](https://github.com/DogeOS69/dogeos-core/actions/runs/35555521369) |

The publisher run succeeded. Its registry index digest is
`sha256:3fcbe5646bfc56f92235bcde3d450515d9d993df673b55e711a0f141eedfc2a3`.
Pulling by digest succeeded, the OCI revision label matches the corrected source
revision, and the entrypoint includes `--skip-bucket-setup`. Offline read-only
container checks passed for `--help`, script syntax and required commands
(`aws`, `sha256sum`, `awk`, `mktemp`, `mv`, `rm`).

The producer run also succeeded. Its registry index digest is
`sha256:19df08b7abf3b1dee82349184cd141da5da0f9626949574019a0367cb0182e82`.
Pulling by digest succeeded and the OCI revision label matches
`30e20987357316307d45362baebb866a9255585b`. The
`derive-scroll-identities --help` smoke check passed with network disabled, a
read-only root filesystem, dropped capabilities, `no-new-privileges`, a bounded
`/tmp` and non-root UID/GID `1000:1000`.

Both published images target `linux/amd64`.

Machine-readable tags, references and build provenance are recorded in
[proof-tool-images-pr1177.json](proof-tool-images-pr1177.json). This inventory is
not the missing unified proof release manifest, and is not loaded automatically
as deployment configuration.

These are short-lived tools, not chart workloads. Do not put their tags into
Worker, Coordinator, CubeSigner signer, or topology compiler image overrides.
The full core revision must match all selected proof materials and runtime
identities. Existing beta.4e examples describe another revision and cannot be
combined with these tools as one approved release.

## Validation scope

`npx mocha --forbid-only test/utils/proof-image-tools.test.ts`: **8 passing**.
These tests cover offline invocation, staged inputs, revision mismatch,
placeholder identities and cleanup. Image smoke checks establish packaging and
startup only. No deployment-bound preparation, real proof generation, S3 write,
CubeSigner attachment, or Kubernetes deployment is performed by this review.
