# Fresh devnet redeployment acceptance (2026-09-09)

## Current operator decision

This supersedes the earlier preserve-Bridge upgrade plan. The operator approved
starting again from zero, including new Bridge/protocol context, regenerated L2
genesis, fresh L2 databases and contract deployment, to exercise the deployment
fixes. End-to-end acceptance is **not complete**. Full workflow automation is a
later task; execute and verify the documented CLI steps individually now.

Hard boundaries:

- Do not remove or replace any policy on existing CubeSigner roles or keys.
  Keep the existing `Devnet` role and key untouched. Create a separate role/key
  for this instance and use the documented plain `transport_only` testnet lane.
  This is not CubeSigner proof-enforcement acceptance.
- Updated after user cleanup: **all remaining Kubernetes resources are
  protected from deletion**, including earlier agent-owned resources. This
  overrides old cutover cleanup plans. No uninstall, force replacement,
  cascading deletion, namespace deletion, `--all`, or blanket `make delete-all`.
  Other-owned/unknown resources remain untouched. Ask before resolving any
  protected name, storage or Helm ownership conflict; create new resources only
  within the fresh deployment's scope.
- Explicit later exception: the user confirmed `scroll-common` and `contracts`
  were forgotten during cleanup and authorized uninstalling precisely those
  releases. Exact-name uninstall succeeded; all other baseline resources stay
  protected. New deployment can recreate the two releases with fresh configs.
- Preserve shared Dogecoin/Shadowfork/orchestrator workloads and storage,
  monitoring infrastructure, other test workloads, EKS, DNS/TLS, S3 bucket,
  existing KMS keys/roles and external databases. Blockscout remains deferred.
- Fresh chain does not require recreating shared infrastructure or rotating
  approved KMS identities. Old on-chain deposits do not migrate to a new bridge.
- Back up current inputs before changing them; isolate generation from the
  live deployment. Never point old service databases at a new protocol context.
- SDK/CLI fixes require a branch based on the approved v0.3.0 fix lineage and
  a commit per verified fix; no worktrees. Core fixes are recorded, not edited.
- Mirror service configuration repairs into SDK examples. Never copy instance
  credentials there. Keep local DA interval 300s versus example 3000s.

## Execution checkpoint

### Latest override: default service Secret prefix

The operator selected `--aws-prefix dogeos`, superseding custom prefixes below.
Ten service Secrets were uploaded at their default paths, then the corresponding
Helm references updated. Do not push unrelated Dogecoin/coordinator-cron Secrets.
Proof-AWS split token ownership and S3 artifact prefix remain unchanged.
Existing custom-prefix Secrets were not deleted. Contracts already completed:
updating its Secret reference must not delete/recreate the Completed Pod.

Reth setup/prep helpers previously hardcoded the default remote path, discarding
custom paths set by push-secrets. This could silently load another instance's
node/signing keys. Both helpers now preserve each existing remoteRef.key;
defaults apply only to newly configured fields. Changing a prefix is an explicit
push-secrets operation, not a side effect of prep-charts. Focused tests cover
repeated generation and separate node/signer Secret paths.

Fresh rollout has completed contracts (77 successful receipts), L1, Reth, DA,
fee oracle, TSO, CubeSigner, WP, PC, eager and frontends. EC2 signers use the new
protocol and separate databases with existing identities. One AdvanceL1 has
been signed/broadcast/confirmed and L1 replay canonicalized ten deposits.
Full deposit/withdrawal and eager-hit/Batch no-RPC acceptance remains pending.
Use `reth.sequencer.l1InclusionMode: finalized:0` for the WF-backed synthetic L1:
`finalized:2` waits for two additional WF transitions, not two Dogecoin blocks.
Preserve standby autoStart=false, gas 10M and empty blocks. PC ingress is opt-in,
not automatically enabled by active proof mode.

Fresh instances intentionally start with genesis hold enabled. Set
`DOGEOS_L1_INTERFACE_SEQUENCER_GENESIS_MODE: "true"` before installing L1
Interface. After contracts have completed and the services and attestation
signers are prepared, run `make start-l1-sync` to call
`POST http://l1-interface:9091/disable-genesis-hold`. Verify
`GET http://l1-interface:9090/health/detailed` reports
`components.genesis_hold.details.enabled=true` and `activated=true` afterwards:
`activated` means the hold has been released, not that it is still holding.
On resume, read this state first and skip the POST only when already released.
Do not suppress arbitrary HTTP 400 responses. The earlier deployment returned
400 because its configuration explicitly set the mode to false; that observation
does not describe the intended fresh-instance workflow.

Mock proof generation is handled inside proof-coordinator. Do not install or
start the deprecated mock worker; this is independent of genesis-hold release.

### Current run: repository-root wrapper (supersedes staging phase 1)

The operator discarded the isolated phase-1 preparation and requested using
the existing shell helper, not new direct core-tool integration. The current
working directory is `/mnt/wsl/data/github/dogeos69/dogeos-aws-devnet`.

- Repaired `scripts/shadowfork/bridge-init-with-shadowfork-mining.sh` in that
  project (commit `77dc7db`), retaining its two full scrollsdk invocations.
  Twelve offline tests passed. No new direct Docker/core runtime dependency
  was added to the wrapper; see its adjacent README for guards and limits.
- Archived old local Bridge/protocol outputs plus pre-change configs to
  `/data/dogeos-devnet-fresh-20260909.grtp5c/root-before-wrapper/`. This is
  recoverable local archival, not deletion of protected Kubernetes resources.
- In the project root, ran `setup cubesigner-init --roles
  devnet_fresh_20260909_0 --doge-config .data/doge-config.toml -N --json`, then
  `setup cubesigner-refresh` with the same config. New identity/session are now
  in the actual project; no additional CubeSigner key was created.
- Reran `setup gen-l2-artifacts` with the approved 56a4cac gen-configs image
  and reviewed existing salt/fee-vault inputs. Current genesis YAML SHA256:
  `545d0286a9a4efd387605cc87e482b3ef386bf98ad87985cc31df65fd9b05309`.
  Actual offline Reth init passed; genesis block:
  `0x7c0c97b0f50e788567d1d7bf7b4cc660445588c9d74f9eadf04c1d53fa6e2f64`.
- Started the repaired wrapper with a fresh random SEED passed privately via
  environment, explicit beta.4e/context and maturity-confirmations=100. Its
  first CLI call stopped at the expected preflight of the old spent funding
  UTXO, with no setup output; helper is `noRnKtSTqeXq6Kin9G16rGQR23STHrvWYK`.
  The wrapper subsequently completed successfully, recording status=complete
  and 118 mining requests. It waited for 100 coinbase confirmations, wrote the
  verified funding UTXO and stopped its miner after the second CLI call.
  Funding input: `2af2ba42052aeb30b341f8454a40e69dcedcf5fea6d089139cc08f83626a9359:0`.
  New Bridge: `2NG2hXDaLonSY7pVGojdXFv4v77bjQ6KUQG`.
  Protocol ID: `fe5d2bf4bdd76afd384aa665c1fde2323cfd3e1b96db936f3c385e71b1c51182`.
  Setup outpoint: `fab25097677dcc57f3354690ac5cbcf6b6ef39359053c7be15f02129cbf3b3d9:0`.
  Independent read-only RPC audit verified all 11 setup/deposit-seed transactions
  confirmed (setup 9 confirmations, deposits 5–7 at that check), 10 × 5 DOGE.
  Do not rerun funding or remove the persistent attempt fence.
- Used `setup eth-da-submitter` with the existing KMS key/role and
  `--archive-key-prefix devnet-20260908/instance-20260909/fresh-0731`, then
  `setup proof-aws-init` with the same canonical prefix, existing-public-s3,
  --skip-vpc-endpoint and the existing infrastructure alias devnet-20260908.
  No bucket or token rotation; IAM artifact policies now target the new prefix.
  Used `setup doge-config --proof-topology` with the validated beta.4e mock
  material receipt, active/mock/observe and 1800000ms fallback deadline. Native
  mock preflight passed. These software identities are reusable; generated
  per-protocol bundles are not reused. prep-charts is now running for this
  identity, before any new workload installation.

Commands (SEED is a privately prepared fresh value, never a literal example):

```bash
cd /mnt/wsl/data/github/dogeos69/dogeos-aws-devnet
scrollsdk setup cubesigner-init --roles devnet_fresh_20260909_0 \
  --doge-config .data/doge-config.toml -N --json
scrollsdk setup cubesigner-refresh --doge-config .data/doge-config.toml -N --json
scrollsdk setup gen-l2-artifacts \
  --image-tag gen-configs-56a4cacda6046c9445af023aefee15a42fda2fdd \
  --doge-config .data/doge-config.toml --configs-dir values \
  --skip-deployment-salt-update --skip-l1-fee-vault-update \
  --skip-l1-plonk-verifier-update -N --json
./scripts/shadowfork/bridge-init-with-shadowfork-mining.sh \
  --image-tag v0.3.0-beta.4e \
  --kube-context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster \
  --maturity-confirmations 100
```

### Earlier staging checkpoint (historical, not the current output identity)

- Deployment resumed after the user's cleanup report. Read-only inventory found
  remaining `scroll-common` and `contracts` Helm releases, including their
  `genesis-config`, `protocol-context-config`, `contracts-deployment-env` and
  `scroll-smart-contracts-config` ConfigMaps and contracts ExternalSecret.
  User subsequently authorized uninstalling precisely these two releases.
  Exact-name uninstall exited 0, resolving that configuration conflict. Neither
  release manifest contains a PVC/PV. No other existing resource was selected.
  The existing sqlite-debug Deployments both have zero replicas and remain
  untouched. No Bridge broadcast has occurred at this checkpoint.
- CLI branch: `fix/fresh-devnet-cubesigner-runbook`, starting at `7c504e1`.
- Private workspace: `/data/dogeos-devnet-fresh-20260909.grtp5c` (0700).
  Staging is its `staging/` subdirectory, an ordinary directory, not a worktree.
- Archive: `deployment-before-reset.tar.gz` (private; contains credentials).
  Completed, mode 0600, 661419686 bytes; `gzip -t` passed. This is a local
  configuration/artifact archive, not a backup of live Kubernetes databases.
- Read-only Helm/pod/PVC inventory completed. No Kubernetes resource has been
  deleted, scaled or replaced during this fresh-redeployment checkpoint.
- New CubeSigner role created through `setup cubesigner-init --new`:
  `devnet_fresh_20260909_0`,
  `Role#18b81c3c-ea4f-4324-87bb-25fc813af7c1`.
- New key: `Key#DogeTest_nhmKn9X9XfCPoww6vGrB9fmTaxR9ZZFmiW`.
  Compressed TEE public key:
  `028eaa9e96f368ef71e39628cbfa482436011d4f760d4b5fda69d9d7696b332909`.
  No policy create/update/set-policy operation was performed.
- `setup cubesigner-refresh` succeeded at 06:58:07 UTC for the new role,
  creating local session/key-reference files in staging. They have not been
  uploaded or activated in Kubernetes. Old service session/cache remain intact.
- `setup gen-l2-artifacts` succeeded in staging with the approved
  `gen-configs-56a4cacda6046c9445af023aefee15a42fda2fdd` image. New
  `values/genesis.yaml` SHA256:
  `5b03183fc8a473f35cc9b7b2f2246a1e9c563e125cdd50357b9d99f6908e03da`.
  `bridge-init --step 1-prepare` subsequently succeeded with beta.4e at
  07:16:10 UTC, extracting `.data/genesis.json` and generating the protocol seed.
  A fresh random seed was passed through the CLI; its JSON echo was suppressed.
  Actual `rollup-node:v0.3.0-beta.1c init` then passed with no network and tmpfs
  storage. Frozen L2 genesis block:
  `0x5357626ba823a474967d72f7e1ce88c1d2df95864b44498aff5edce744c79811`.
  Bridge setup/funding have not yet run. The staged source still contains the
  previous instance's spent funding UTXO; supply a fresh verified input before
  step 2. Do not repeat step 1 with another random seed when resuming.

## CubeSigner initialization and safe resume

Run from the **staging deployment root**, not the CLI repository or live root:

```bash
cd /data/dogeos-devnet-fresh-20260909.grtp5c/staging
export DOGEOS_CLI=/mnt/wsl/data/github/dogeos69/scroll-sdk-cli/bin/run.js
# New instance only; do not rerun --new after it has succeeded.
"$DOGEOS_CLI" setup cubesigner-init --new \
  --role-prefix devnet_fresh_20260909_ \
  --doge-config .data/doge-config.toml -N --json
```

Observed working-directory pitfall: `--doge-config` selects that file, but
`setup_defaults.toml` is still resolved from the current working directory.
The first creation call used an absolute staging doge-config from the live root
and updated its TEE field. That local field was restored to its exact previous
value (file compared equal to the pre-call copy), without deploying it. Resume
from staging with the already-created role, not by creating a second key:

```bash
"$DOGEOS_CLI" setup cubesigner-init --roles devnet_fresh_20260909_0 \
  --doge-config .data/doge-config.toml -N --json
```

Before Bridge generation, independently verify the new key is owned/usable by
the current account, its role membership and policy attachments, and confirm
that the existing Devnet role/key/policy remain unchanged.

Use the existing CLI for session generation too; do not hand-edit a session,
copy the old role's session, or manually substitute key IDs:

```bash
# Same staging deployment working directory as above. Executed successfully.
"$DOGEOS_CLI" setup cubesigner-refresh \
  --doge-config .data/doge-config.toml -N --json
```

Outputs are `secrets/cubesigner-signer-session.json` and
`secrets/cubesigner-signer.env`. The command configures a 365-day session,
2-hour auth, 7-day refresh and 30-second grace period. Keep files private.
After the new values and isolated Secret prefix are ready, use the existing
`setup push-secrets --cubesigner-only` command to upload/reconcile references.
That upload is pending, not a completed step. Use a fresh instance session cache
at cutover; do not clear the running old instance's cache during preparation.

Operator rule: whenever a setup/generation command exists, use it rather than
manually editing its generated output. If that command is defective, repair
and test the CLI on the approved branch, commit the fix, and rerun safely.

## Pending deployment sequence

1. Finish protected-baseline inventory; resolve the existing scroll-common and
   contracts configuration conflict with the user before any cluster mutation
   (resolved by the explicit two-release removal authorization above).
2. Review fresh canonical input files: domain, Sepolia/KMS, Reth identities,
   release pins, 10M gas limit, empty blocks, DA interval and new archive prefix.
3. Generate L2 artifacts once with the approved contracts gen-configs image;
   validate with the actual Reth image and freeze the resulting genesis hash.
4. Prepare a fresh Bridge seed/funding UTXO; execute `bridge-init` steps 1–5
   individually, recording transaction IDs before any retry. Do not copy old
   Bridge/protocol/replay outputs into the new instance.
5. Regenerate proof topology, native configurations, service Secrets and signer
   policy bundles in documented order. Use isolated protocol-bound state.
6. Install new instance resources from the repaired values/charts. All resources
   remaining after user cleanup are protected; do not execute the old
   stop/reset/delete sequence. Existing chain ConfigMap updates require the
   separately confirmed boundary above; do not reuse old protocol databases.
7. Deploy contracts on the fresh L2; start DA, fee oracle, signers, WP and proof
   services. Verify cold start/restart, receipts and matching chain identities.
8. Complete an actual deposit and withdrawal through signing, broadcast and
   confirmation. Keep mock witness/proof acceptance distinct from real proving.

Use [the previous new-Bridge run](devnet-new-bridge-20260909.md) and subsequent
runtime repair guides as evidence, not as a blind replay script: their old
identities, funding inputs, dates, claims, prefixes and checkpoints are stale
for this new instance. `transport_only` does not bypass an attached WASM policy;
the no-policy devnet lane is documented in core's
`docs/engineering/cubesigner-compact-psbt-implementation-tracker.md` (D023/D029).
