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
- Kubernetes resources not deployed by this deployment agent must not be
  deleted or modified. Unknown ownership means leave untouched. Inventory
  names and establish ownership before acting; no namespace deletion, `--all`
  cleanup, or blanket `make delete-all`.
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

- CLI branch: `fix/fresh-devnet-cubesigner-runbook`, starting at `7c504e1`.
- Private workspace: `/data/dogeos-devnet-fresh-20260909.grtp5c` (0700).
  Staging is its `staging/` subdirectory, an ordinary directory, not a worktree.
- Archive: `deployment-before-reset.tar.gz` (private; contains credentials).
  Archive completion/integrity must be checked before any destructive cutover.
- Read-only Helm/pod/PVC inventory completed. No Kubernetes resource has been
  deleted, scaled or replaced during this fresh-redeployment checkpoint.
- New CubeSigner role created through `setup cubesigner-init --new`:
  `devnet_fresh_20260909_0`,
  `Role#18b81c3c-ea4f-4324-87bb-25fc813af7c1`.
- New key: `Key#DogeTest_nhmKn9X9XfCPoww6vGrB9fmTaxR9ZZFmiW`.
  Compressed TEE public key:
  `028eaa9e96f368ef71e39628cbfa482436011d4f760d4b5fda69d9d7696b332909`.
  No policy create/update/set-policy operation was performed.

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

## Pending deployment sequence

1. Finish backup/inventory; record an exact agent-owned cutover allowlist.
2. Review fresh canonical input files: domain, Sepolia/KMS, Reth identities,
   release pins, 10M gas limit, empty blocks, DA interval and new archive prefix.
3. Generate L2 artifacts once with the approved contracts gen-configs image;
   validate with the actual Reth image and freeze the resulting genesis hash.
4. Prepare a fresh Bridge seed/funding UTXO; execute `bridge-init` steps 1–5
   individually, recording transaction IDs before any retry. Do not copy old
   Bridge/protocol/replay outputs into the new instance.
5. Regenerate proof topology, native configurations, service Secrets and signer
   policy bundles in documented order. Use isolated protocol-bound state.
6. Stop only verified agent-owned old consumers before switching shared chain
   ConfigMaps. Reset only the corresponding explicitly identified instance
   storage, then install from the repaired values and charts.
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
