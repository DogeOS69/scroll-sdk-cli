# Production input review and configuration rehearsal

Reviewed on 2026-10-08 against the production input inventory in
`dogeos-core/docs/production-service-inputs-and-generation.md`.
That document owns the service inventory, current configuration fields,
generation dependencies and production readiness requirements. This report
records the cross-repository corrections and the scope actually executed.

Source baselines:

| Repository | Revision before these changes |
| --- | --- |
| dogeos-core | `76ed074429564ffad5007f2da88f2c133085b877` |
| scroll-sdk-cli | `7184d0ab1c78663e688360ffb9f64d868422d3a2` |
| scroll-sdk | `330968980898764372ecf0e2a5370e2ba90696f2` |
| scroll-contracts | `c6aed1aff10635a98fd4a82fad2cd260e0033117` |

## Corrected behavior

| Area | Correction and reason |
| --- | --- |
| New bridge lifecycle | Successful `bridge-init` setup records `defaults.freshGenesisInit = true`; chart preparation projects it into WP and L1I. Missing intent remains false. Snapshot continuation cannot request fresh initialization. Failure to persist the post-transaction lifecycle now fails the command with recovery guidance. |
| Funding inputs | Preparation returns the compressed-P2PKH helper address without returning the seed. Mainnet, testnet and native regtest use their own address prefixes. This avoids manually reproducing the core helper's key derivation. |
| Ethereum DA height | `bridge-init --ethereum-da-probe direct` explicitly queries from the operator machine and fails on RPC errors. The default remains the cluster probe. Docker log streams are demultiplexed before display. |
| Configuration refresh | `setup doge-config` preserves existing DA archive, batch/cutover and continuation settings while updating the connection fields. |
| Native service configuration | Removed retired WP/proof and submitter fields from current templates and generation; L1I requests full replay validation. Chart production values now match the maintained SDK examples. Image defaults in the touched producers agree with the SDK examples; operators still choose an approved release. |
| Installed CLI | Build copies TOML templates into `dist/config`; runtime loads templates beside the compiled module. Published packages no longer require an unpublished `src/config` directory. |
| Fresh Reth installation | The SDK Makefile no longer requires unshipped genesis-upgrade files for every new node. An existing-chain migration can explicitly supply both normalizer files. Retired Celestia targets were removed. |
| Contract integration test | Validation uses temporary deployments and logs outside their input directories. No changes are retained in `scroll-contracts`. |
| Core image publication | Added preparation producer, publisher and an opt-in proof-release workflow based on the existing `7d877069` implementation. The producer invokes the current ignored identity probe explicitly. The manifest has the CLI's five image entries; CUDA embeds the source revision in its compiled identity. CI publication is tracked separately in the PR image validation below. |
| CubeSigner deployment tools | Added an offline compiler-image command, exact-version upload/attachment with provider hash/readback checks, and resolver HTTP-egress preview/apply using the existing management session. A deployment receipt records these operations without claiming production live-proof acceptance. |
| Publisher preflight | The publisher checks all 11 required files before any AWS call. A missing later file previously caused partial uploads. The actual-image negative test now rejects the incomplete bundle before contacting AWS. |

Changed SDK chart versions are WP `0.1.23`, L1I `0.0.23`, submitter `0.1.4`
and fee oracle `0.0.11`. The example Makefile selects those versions. They must
be published, or consumed from local charts, before a registry-based rollout.

## Initial scoped checks

All generated deployment inputs, credentials and transaction artifacts were kept
under `/tmp/scrollsdk-production-review-181u9lw2`. The source repositories were
not used as deployment working directories. The sanitized results are in
`evidence/summary.json`, `evidence/cli-results.jsonl`,
`evidence/bridge-confirmations.json` and `evidence/deployment-helm-results.json`.
Command logs are private and may contain credentials emitted by tools; do not
publish that temporary directory.

The CLI subprocess sequence was:

1. `setup doge-config`, deployment accounts and the four Reth/service keystore
   selections; three `signer init` operations and `setup attestation-signer`.
2. `setup cubesigner-init` with an existing testnet role/key, then
   `setup cubesigner-refresh`. The test-created session was revoked after the
   checks. Existing keys, policies and bindings were not changed.
3. `setup gen-l2-artifacts --contracts-source ...`, using the isolated Foundry
   backend, followed by all five `setup bridge-init --step ...` stages.
4. `setup prep-charts` and `setup gen-secrets` for ordinary services.
5. Offline producer bake for this new bridge; `setup proof-image-tools --action
   export`, `setup proof-release-prepare` and `setup proof-materials` to validate
   the resulting identities/materializers and record receipts.
6. `setup doge-config --proof-topology`, followed by `prep-charts`, `gen-secrets`,
   `export-signer-policy` and `proof-config-check`, first for disabled mock
   observe and then for active mock observe with real materialization inputs.
   A topology change uses a new versioned signer-bundle output directory.

| Check | Result | Boundary |
| --- | --- | --- |
| Dogecoin bridge | 11 unique transactions independently confirmed on the authorized testnet shadowfork; sequencer output is 42,069,000 koinu | Shadowfork only. The setup helper is not production key-custody acceptance. |
| Genesis consumption | Actual Reth `init` completed from generated native genesis | Database initialization, not a running sequencer/DA/reorg test. |
| Contracts | Two temporary Anvil deployments; bytecode at 31 addresses and 16 state reads compared; 11 Secret files and 11 values files compared | Actual local broadcasts; external explorer verification requests use the existing test double. |
| Real preparation | Container ran with `--network none`; complete Bridge/aggregation artifacts and preparation receipt validated | A bake is not proof generation or verification of a live withdrawal. |
| Proof configuration | Both `disabled/mock/observe` and `active/mock/observe` completed through `proof-config-check` | CubeSigner explicitly uses testnet `transport_only`; no production Wasm enforcement claimed. |
| Enforcement rejection | Actual CLI rejects mock + enforce and leaves both original configuration files unchanged | No readiness evidence was fabricated to pass the production gate. |
| Helm | 12 generated service/node values rendered; both production-values entry points for four changed charts passed lint and matched | Rendering only; no Kubernetes installation. |
| Package | Packed CLI loaded from an extracted package with no `src/` tree | Installed dependencies were supplied from the local test environment. |
| Regression | 846 CLI tests passed, 15 pending; final targeted rerun 160 passed; 7 Solidity tests; 10 verification-script tests; 20 publisher tests; producer success/failure/overwrite checks; 5 SDK Makefile tests | Pending tests are not counted as passed coverage. Build and changed-file lint passed; lint retains existing warnings. |

The producer/compiler/coordinator images exercised here are from
`7d87706931c1517979a10724396b694283e3385a`; the bridge tools are
`v0.3.0-beta.5b`, and the Reth initialization image is `v0.3.0-beta.1c`.
They must not be represented as builds of the reviewed core baseline or of this
unpublished working tree. PC values were pinned to the coordinator digest that
owns the imported materializers. A disposable local MinIO bucket supplied the
configuration's S3 endpoint; no AWS resources were provisioned.

## Current-image complete-flow validation

The follow-up uses a fresh temporary deployment at
`/tmp/scrollsdk-complete-proof-review`, a dedicated new CubeSigner test key and
role, and a local core validation snapshot
`e11578a1290174e8a74cd1ad1695bcd1fb8f5c74`. This local validation preceded the PR and GitHub Actions publication work. All
images in this historical validation use this snapshot revision; the earlier
`7d877069` images are not substitutes.

The authorized artifact-generation/publication/policy-binding path has now been
executed with these images. Full runtime and production acceptance remains
blocked by the prerequisites listed below; a testnet fallback is not proof
verification success.

| Step | Observed result |
| --- | --- |
| New deployment | CLI identity, signer topology, role import, L2 genesis, all five bridge stages, signing-session refresh, chart preparation and secret generation passed. The 11 bridge transactions were independently confirmed; Reth initialized the newly generated genesis. |
| Current images | All five release images (preparation producer, CUDA worker, coordinator, topology compiler, publisher) and the separate policy compiler built from the validation snapshot. Each was pushed to the existing local registry and selected by digest. No hosted CI or external registry publication occurred. |
| Real preparation | Actual `proof-image-tools --action prepare-real` completed in 484 seconds with `--network none`, followed by image-tool export, production worker identity checks and real materials generation. Both independently derived batch and aggregation commitments matched the CUDA image. This is preparation, not GPU proof generation. |
| Topology and consumers | Actual `active/real/observe` configuration generated charts, secrets and versioned signer handoffs, then regenerated them with the publication receipt. An initial coordinator URL/ingress mismatch was correctly rejected; correcting the test input allowed generation. All 12 generated service/node values rendered with the local SDK charts. |
| S3 publication | The actual immutable publisher image uploaded all 11 files through `proof-bundle-publish --artifact-source doge-config`. Authenticated S3 and anonymous HTTPS readback passed for every file. Only the authorized independent prefix received an anonymous GetObject rule; other bucket rules remained intact. Nine incomplete smoke-test objects were deleted by exact key. |
| New bridge Wasm | Actual `cubesigner-policy build` produced a 1,086,699-byte component from the new bridge preparation/context and exact WP resolver prefix. SHA256: `92ee944acf2351caa42e2cb9ce618150c1bb1b80b2068d20e5f0fdce18938a6d`. The compiler fixture gate separately passed import-subset 26/26 and private SDK source-absence checks. |
| Upload and binding | Actual deploy uploaded `scrollsdk_e2e_20261008/v0`, verified the remote Wasm hash, observed empty-request Deny, bound the dedicated test key and verified its canonical provider policy ID. The live test exposed a name-versus-provider-ID readback bug; the CLI now checks both identities and safely resumes a partial attachment without creating another version. |
| Hosted policy cases | Six synthetic, non-broadcastable cases matched expected verdicts: empty request, wrong namespace and sign-all were denied; missing/invalid proof cases took the documented testnet fallback. The two HTTPS cases recorded `resolver_unavailable`, so no hosted proof fetch or strict proof acceptance is claimed. The uploaded committed proof fixture belongs to another bridge. |
| Resolver prerequisite | Real CLI preview succeeded. The provider rejected the organization update with HTTP 403 `UserRoleUnprivileged`; fresh readback confirmed no change to the five existing authorities. An organization administrator must allow the selected S3 bucket domain before hosted HTTPS delivery can pass. |
| AWS service identities | Existing dev0829 roles do not authorize the new test prefix. Creation of separate test roles and a token secret awaits explicit authorization. Existing roles have not been modified. Standalone S3 publication does not supply workload IAM evidence. |
| Final configuration gate | `proof-config-check` refuses final active/real acceptance without the artifact-store receipt. This prerequisite is retained. The combined `proof-config prepare/publish` transaction is still unexecuted for this deployment because actual test IAM facts are missing. |
| Regression | Final full CLI suite: 859 passing, 15 pending. The policy/resolver targeted suite passed 17 tests, including retry after a partial attachment. Build and full lint passed (zero errors, 231 warnings). The packed CLI loaded the new commands without a source tree; local installed dependencies supplied its test runtime. |

The proof release manifest records these local immutable digests:

| Image | SHA256 |
| --- | --- |
| `proof-preparation-producer` | `83092d08b2e3a769d951d7f6db2f47a5247e5c5e78cd15a4e325acf9346ab368` |
| `prover-worker-cuda` | `5b167dc5fb9f86058ca8a9048b08f3a7a22765222ef702ff73b49972239abd2c` |
| `proof-coordinator` | `50f2b5a42610834863412afc833da1af1e082bca265241e9b8389fc6c0666191` |
| `dogeos-proof-topology` | `198762e0e7b4a9663fab477b15cef3e5ab1a75963e5aeb9d81f1b914897803f6` |
| `proof-bundle-publisher` | `d467ae06f6a299d8270bb7258a89024525e8ea832fec0edeb5cf6aa13db7fe2d` |
| Separate `cubesigner-policy-compiler` | `81e0e550cd5e732a726ee67cf7b31c27cae24aef6b18fe2b985dcbf5fd2381db` |

`evidence/cli-results.jsonl`, `evidence/bridge-confirmations.json`,
`evidence/available-images.json`, `evidence/producer-cuda-identity-match.json`,
`evidence/cuda-image-smoke.json`, `evidence/deployment-helm-results.json` and
`evidence/live-policy-vectors.json` retain scoped results. The actual artifacts
are `deployment/.data/standalone-preparation/`,
`deployment/.data/proof-program-publication-v1.json`, `policy-artifact/` and
`policy-deployment/` beneath the temporary root. The test-created signing session was revoked and the dedicated Anvil stopped;
refresh the signing session before continuing service setup. The test key, role,
policy, S3 artifacts and local images remain available for review. Private logs,
signing sessions and AWS credentials remain outside the repositories and must
not be published.

## PR image validation in progress

The core PR now provides an explicit `proof-release-preview` option in the
existing **Build and Push Docker Images** workflow. The
[actual CI run](https://github.com/DogeOS69/dogeos-core/actions/runs/37742120516)
builds revision `d0c9ce11a3c2a3ebc111bfb7f1d77e78c730ff3a`. It must publish all
five release images plus the separate policy compiler, pass their gates, and
emit a revision-checked digest manifest before this run can replace the local
validation inputs above. At this checkpoint publication and CLI consumption
are still in progress; the earlier local result does not establish CI success.

## Production conditions still outside this acceptance

The fresh configuration/artifact rehearsal and actual Wasm binding do not
certify a mainnet deployment. The default policy crate retains candidate pins;
the compiler image injects deployment-specific pins from checked preparation
inputs. The new policy's testnet fallback permits proof failure after structural
checks. Six expected hosted verdicts therefore do not demonstrate strict
mainnet proof acceptance or a valid proof for the new bridge.

Remaining prerequisites are resolver egress permission, actual AWS workload
identities for the selected prefix, the combined preparation/publication
transaction and final configuration gate, valid/invalid new-bridge GPU proofs,
external signer enforce receipts, and a running cross-service/Kubernetes
acceptance. The host used for this test has no GPU. A production release must
publish matching images and charts, supply those inputs and evidence, and pass
the existing enforcement gate with `active/real/enforce`.

Use [setup order](setup-order.md), [proof material preparation](proof-materials.md)
and [proof operator runbook](proof-operator-runbook.md) for the operator commands.
