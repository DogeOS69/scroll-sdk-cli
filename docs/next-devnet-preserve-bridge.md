# Next-devnet upgrade: preserve the existing Bridge

Checkpoint: 2026-09-09. Operator decision: **do not initialize another Bridge**.
This is an upgrade of the existing devnet, not another chain deployment.

## Verified boundary

Cluster: `arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster`,
namespace `default`, domain `devnet.doge.xyz`, L2 chain ID `221122`.

- Bridge: `2NDLYMxd7SH4U94k3HfgmQtgBZE3FAPJe4H`.
- Protocol ID: `b7e9425fda9ad99b782a10b5575521bca67f4842da4923f00d690a8a5947beaa`.
- Genesis sequencer outpoint:
  `05065e3b9950481c3bdbe12a8a0c0182f24b422f7df96076cc77f59dbada017f:0`.
- L2 genesis block:
  `0x4c315c169df5fa7ef747c5a79c956fd291dbbb804e92d0fc42a563c022f8ba58`.
- Existing raw DA/proof bucket/prefix:
  `s3://dogeos-dev0829-proof-artifacts/devnet-20260908/instance-20260909`.

Read-only checks at approximately 04:52–04:54 UTC found:

- Dogecoin `gettxout(txid, 0, true)` returned an unspent 4.2069 DOGE output,
  including the mempool check, with 394 confirmations. This is the sequencer
  P2PKH output, **not** the Bridge P2SH output; do not compare their scripts.
- WP replay `wf_transitions` count: 0. `validated_up_to = discovered_up_to = 0`.
  `genesis_state_hash = validated_tip_state_hash`; only snapshot WF #0 exists.
- One `advance_l2_build` job is queued and its spec is planned. No signed txid;
  `wf_consumed_outpoints` count: 0. A queued job is not an on-chain WF.

These observations support preserving the bridge. Repeat them immediately
before cutover because the live state can advance. If an outpoint is spent,
a signed transaction appears or replay has advanced, stop and reassess recovery;
**do not respond by silently creating a new bridge**.

```bash
KUBE_CONTEXT=arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster
kubectl --context "$KUBE_CONTEXT" -n default exec withdrawal-processor-0 -- \
  sqlite3 -readonly /app/data/replay.sqlite \
  'SELECT count(*) FROM wf_transitions; SELECT protocol_id,validated_up_to,discovered_up_to,genesis_state_hash=validated_tip_state_hash FROM replay_manifest;'
kubectl --context "$KUBE_CONTEXT" -n default exec withdrawal-processor-0 -- \
  sqlite3 -readonly /app/data/withdrawal_processor.sqlite \
  'SELECT action_kind,status,signed_txid FROM protocol_action_jobs; SELECT count(*) FROM wf_consumed_outpoints;'
ssh ec2-dev 'curl --fail-with-body -sS --max-time 20 \
  -H "content-type: application/json" \
  --data '\''{"jsonrpc":"1.0","id":"bridge-preserve-preflight","method":"gettxout","params":["05065e3b9950481c3bdbe12a8a0c0182f24b422f7df96076cc77f59dbada017f",0,true]}'\'' \
  http://192.168.30.65:22555/'
```

## Release and prerequisite status

PR #1136 merged as `8b1d22ecb55544456b0d4846bafbb30e952ff7a4`.
GitHub comparison confirms `v0.3.0-beta.4e` contains it (30 commits ahead,
zero behind). The beta.4e build is run `34296832837`, commit
`eef62d3e40a387b1f53b24825c2e85af54facbc8`.

The compiler was pulled and run using:

```text
dogeos69/dogeos-proof-topology@sha256:c48946dc0af058d839cf064034c805e681fa8439e377ba8ecf4afbbefb02620a
```

The eager image `dogeos69/eager-materializer:v0.3.0-beta.4e` exists; its amd64
manifest is `sha256:2467dccfa4a28dd78136fa660f7afba2449d3010a873173e8adbf92700d7adba`.
The initial guessed repository `proof-topology-compiler` was wrong; use
`dogeos-proof-topology` above.

**Current blocker is real materialization identity, not a Bridge reset.** The
existing material receipt uses synthetic identities and the Worker identity
bundle has an all-zero `batch_guest`. Native beta.4e eager-profile preflight
rejects that placeholder because Batch commitment is cross-checked at runtime.
Do not fill in arbitrary nonzero bytes, disable the check, or relabel synthetic
materials as real.

The first search missed the repository's historical **Proof Software Release**
workflow: the normal beta.4e image-build run is not the only artifact source.
The user-directed GitHub search subsequently found and downloaded real programs
and the aggregate VK, detailed below. The remaining prerequisite is deriving and
validating a compatible current identity bundle, not finding any material at all.
The materializer binaries must also match the deployed PC image. Import/bake
against the **existing** `protocol_context.json`; stop if the producer requires
changing protocol identity.

### Located proof release (follow-up GitHub search)

- Successful [Proof Software Release run 33255802647](https://github.com/DogeOS69/dogeos-core/actions/runs/33255802647),
  2026-08-29, source `aa856ab3f9718f914326bd3fc4b0ea8f809016f8` on
  `ci/proof-pr935-e2e-publish-v3`.
- Downloadable artifact ID `9716098804`,
  `proof-software-release-publishable-proof-pr935-e2e-v3-aa856ab3f9718f914326bd3fc4b0ea8f809016f8`;
  162795686 bytes, not expired at inspection. The separate producer-output
  artifact has expired; the publishable archive is the usable download.
- Data-only OCI image (registry manifest verified and pulled):
  `dogeos69/proof-release@sha256:1a8f6a09d67679dc65ad1cad3060f1065f99ffb927676bfda16f1972434939ae`.
- Extracted inspection copy:
  `/tmp/dogeos-proof-release-inspect.s0RPdp/proof-release/`.
  The Actions download also completed as `proof-software-release.tar` in its
  parent. This is temporary inspection storage, not installed deployment input.

The package contains `proof-software-release-v1.json`, Chunk/Batch
`app.vmexe` and `openvm.toml`, L2-range exe/config, `verifier/aggregate-vk`,
and `bin/chunk-materializer` / `bin/batch-materializer`. All nine material
files passed size and SHA256 comparison against the manifest. The recorded
software release digest is
`sha256:582084c940e5ad5f5216308c2f7826bcc15022a0d2d8584e0eea84bcc2879b97`.
This file-hash check is not a claim of native beta.4e compatibility validation.

Its Scroll prover revision is `0badaf7aebe407bc7e50a5eb713a0ab44668a362`, matching
beta.4e; it reports OpenVM `1.7` (beta.4e pins SDK `v1.7.0`). However, its core
revision diverges from beta.4e, and its L2-range commitment is not the current
compiled-default commitment. The old release pins an old compiler and old
Workers. **Do not overwrite beta.4e component pins or import the whole package
as if it were a beta.4e release.**

The publication workflow and OCI release tooling were on the old PR #935
validation branch, not beta.4e. [PR #935](https://github.com/DogeOS69/dogeos-core/pull/935)
was closed without merging and explicitly superseded by #937. The historical
[producer README](https://github.com/DogeOS69/dogeos-core/blob/aa856ab3f9718f914326bd3fc4b0ea8f809016f8/tools/proof-release/README.md)
explains the package; current
[real-proving guidance](https://github.com/DogeOS69/dogeos-core/blob/v0.3.0-beta.4e/docs/engineering/real-proving-runner.md)
and the current compiler contract govern compatibility and identity export.

Next: check the candidate Chunk/Batch/VK with current native tooling, obtain or
generate the non-placeholder identity bundle from matching build inputs, and
use beta.4e materializer binaries. A file-hash match and the same OpenVM major
line alone are insufficient to approve aggregation/Bridge artifacts. No old
binary was executed during this inspection; the temporary stopped Docker
container used to copy the data-only image was removed after extraction.

## Local changes already made (not rolled out)

Subsequent image-tool checkpoint: beta.4e materializers and the placeholder
Worker identity were exported; the historical CPU producer successfully derived
Scroll identities from the five candidate inputs. This does not certify current
Batch/Aggregation compatibility. See [native proof image tools](proof-image-tools.md)
for exact commands, hashes, strict rejection and the remaining core packaging gap.

The deployment's private `.data/doge-config.toml` now explicitly contains:

```toml
[proof_topology]
mode = "disabled" # remains unchanged until the materialization prerequisite passes
generation = "mock"
enforcement = "observe"
observeRealProofDeadlineMs = 1800000

[proof_topology.deployment.eagerMaterializer]
listenPort = 3007
startBatchHeight = 0
stateDir = "/app/data"
```

The compiler image pin was updated to the digest above. The obsolete deployment
`mockWorkerImage` table was removed; the separate old material receipt is
unchanged. Source changes mean the old generated deployment contract is stale:
**rerun prep-charts and proof-config-check before any future install**.
The `Makefile` gained a guarded `install-eager-materializer` target using the
local chart until publication. No Helm install or service restart was performed
in this upgrade checkpoint. No WP/PC database, PVC, Secret or EC2 service was
deleted or switched.

Successful existing-profile preflight:

```bash
scrollsdk setup proof-topology-compile --deployment-dir . --preflight mock \
  --output .data/generated/next-devnet-preflight --json
```

It emitted no Worker contract; bundle revision:
`d5168d3be4423b1b4283cea9754677cf053ce5c1b313dcad3990119869ee170a`.
This is **preflight-only**, synthetic materialization; it does not validate eager
operation or prove that an end-to-end withdrawal succeeds.

Validation of the adapter change: TypeScript build and 189 proof/deployment/UX
unit tests passed. Targeted lint has no errors (complexity/dynamic-type warnings
remain). Helm lint passed, and rendered manifests were checked for the command,
Service port, liveness/readiness/startup paths and 5Gi PVC. Rendering without
compiler config fails as intended. The genesis YAML and protocol-context SHA256
remain `ef936991667e3010fd081ede6235c109257c7a36077e46738996a435aa86edc8`
and `c24bff010e525e4992eee41511bdd5cbd2f84313fd0cd3952881a1ced0ff73e7`.

## Remaining cutover, in order

1. Import matching real materialization inputs using the commands in
   [the proof operator runbook](proof-operator-runbook.md). Preserve old materials
   as an isolated backup; never overwrite an identity receipt in place. Select
   `withdrawal_mock_prover_real_materialize`, RPC witness source, mock/observe.
   Preflight with the new compiler and all three eager placement inputs.
2. Use a clean PC base. Remove retired Batch subprocess witness-source settings
   from the **base template**, then compile; do not patch generated identities or
   artifact paths. Compiler output must declare `eager_materializer` and omit
   `prover_worker`. Inspect the deadline and DA segmentation-sidecar enablement.
3. Copy `scroll-sdk/examples/values/eager-materializer-production.yaml` to local
   `values/`, set deployment resources and a dedicated prefix-scoped IAM role.
   Scope its trust to the devnet OIDC provider and `default/eager-materializer`.
   Grant prefix listing, read and create-object access needed by the producer;
   no delete permission or broad shared administrative role. The CLI preserves
   operator ServiceAccount settings; it does not provision eager IAM automatically.
4. Run `scrollsdk setup prep-charts`, inspect all values changes, then
   `scrollsdk setup proof-config-check`. Eager gets compiler-owned TOML, the same
   namespace materials and existing `genesis-config/genesis.json`. Do not type
   a second bucket/prefix/RPC authority into its production YAML.
5. Stop WP scheduling before the final no-WF recheck. Take a consistent backup
   of existing WP/PC SQLite files (including WAL), then provision a **fresh WP
   claim/database**, not an in-place beta.3 migration. Preserve Bridge, deployed
   contracts, protocol context, L2 genesis, all Reth PVCs and DA submitter state.
   Do not clear the shared raw DA prefix or its nonce/history state.
6. Pin PC, WP, attestation signer and DA submitter to the approved matching
   beta.4e release; retain user exceptions (rollup-node beta.1c, frontends rc3,
   existing contract tags). Keep CubeSigner `transport_only`, ECDSA, KMS roles,
   local DA `MAX_OPEN_L2_TIME=300` and all signer protocol identities unchanged.
   Render/review Helm manifests before applying. Update EC2 signers only after
   staging and checking their matching configs and rollback files.
7. Install active WP/PC and the sidecar-enabled DA submitter; then run
   `make install-eager-materializer KUBE_CONTEXT="$KUBE_CONTEXT"` after chart
   dependency resolution. No mock Worker deployment is needed. The separate
   producer install is explicit, not silently enabled for a synthetic profile.
8. Check PC internal-mock/deadline logs, succeeded proof rows with zero Workers,
   eager `/ready`, prepared chunks and PC locate-and-register cache hits. Verify
   Batch child uses stored witnesses with zero node RPC, and finally a
   post-Tsuki withdrawal end to end. Check producer outage/invalid-bundle fallback
   only on controlled work after the normal path succeeds.

Do not mark the checklist complete based on Pod Ready alone. Real/observe
fallback and later enforce cutover are distinct follow-up acceptance steps;
enforce changes statement identity and needs a fresh/regenerated proof store.
