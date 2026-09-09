# DogeOS deployment status and runbook corrections

This page consolidates findings from the 2026-09-08/09 from-scratch devnet deployment.
It is a **partial, verified-progress record**, not a completed end-to-end manual.
The README command reference lists available commands, not their execution order.
Never run the entire command list sequentially as an installation script.

## Documentation is part of deployment acceptance

When execution exposes a wrong command, outdated default, missing prerequisite,
incorrect order, manual edit, or misleading success criterion, correct the relevant
CLI manual in the same work phase as the repair; do not leave it only in chat or
an issue. Commit each verified repair and its documentation. Historical failures
may remain in a dated log, but actionable instructions must reflect the current
decision and must not contradict the current resume boundary.

Each step in the eventual complete runbook must state its prerequisites, exact
command/working directory, generated or edited files, validation, and safe retry
rules. Record private configuration field names but not private keys, seeds,
session tokens, or full unredacted traces. Mark steps as executed-and-verified,
failed, or not-yet-executed. Generation, preflight, Helm installation, runtime
readiness, and end-to-end acceptance are different milestones.

## Current checkpoint

- On 2026-09-09 the user explicitly authorized a **new Bridge**, with native
  Reth genesis from contracts commit 56a4cac. The verified procedure, release
  pins, identity, manual changes and retry rules are consolidated in
  [the new-instance runbook](devnet-new-bridge-20260909.md). It supersedes the
  old-instance observations wherever identity or output format differs.
- Domain: devnet.doge.xyz. L2 chain ID: 221122. Ethereum DA: Sepolia (11155111).
- Bridge setup and ten deposit-seed transactions are already confirmed; the
  canonical protocol context has been generated. **Do not regenerate genesis,
  change seed/salt, or repeat Bridge setup/funding to resume this instance.**
- New Bridge: `2NDLYMxd7SH4U94k3HfgmQtgBZE3FAPJe4H`; protocol ID:
  `b7e9425fda9ad99b782a10b5575521bca67f4842da4923f00d690a8a5947beaa`.
  New gen-secrets, prep-charts, policy export, proof-config-check and actual
  offline Reth init passed. Reth's hash matches the protocol context exactly.
- scroll-common and l1-interface now serve the **new** instance (Helm revision 2).
  ConfigMaps match canonical artifacts; L1 Interface beta.4e is Ready on a new
  dedicated 100Gi PVC. The old PVC/Secrets are retained, not reused or deleted.
  The new deploy image's offline None/verify-config passed with only the deployer
  key. New service Secrets were uploaded under dogeos/devnet-20260909. Historical
  server-side dry-run success must not be attributed to the new instance.
- [Core #1139](https://github.com/DogeOS69/dogeos-core/issues/1139) is resolved
  for this instance by beta.4e plus explicit fresh_genesis_init=true. Normal
  service startup created replay DB and passed validation before syncing and
  serving. See [the verified rollout and opt-in instructions](l1-interface-beta4e-cold-start.md).
  Do not disable replay, add an external initializer or reuse another protocol DB.
- All six Reth nodes initially became Ready with fresh 100Gi volumes. Contracts
  passed the repaired RPC init check and broadcast seven transactions, but block 1
  was rejected by all five followers because gas limit jumped from 10M to 20M.
  The operator then authorized a [six-volume recovery](reth-gas-limit-recovery.md):
  rebuilt with the same genesis, explicit 10M builder limit and empty blocks.
  All six nodes now accept the same empty blocks. Contracts deployment was
  restarted after verifying common block hashes and genesis deployer nonce.
  Contracts then completed successfully: all 77 receipts have status 0x1,
  29 configured L2 addresses have code, and the actual KMS fee-oracle address
  is whitelisted. Do not repeat the successful broadcast to resume.
  See [Reth/contracts runtime](reth-contracts-runtime.md)
  for Service-name alignment, the local chart fix, exact commands and safe retries.
  Fee-oracle, DA and proof rollout, EC2 signer/worker replacement and DNS/TLS/end-to-end validation remain
  pending. Blockscout is explicitly deferred because RDS admin credentials are
  unavailable. Do not reset RDS or deploy retired PostgreSQL consumers to proceed.

## Corrections that must carry into the final runbook

1. **Use Reth, not retired l2geth setup instructions.** For this deployment the
   rollup-node image exception is v0.3.0-beta.1c; core services otherwise use
   v0.3.0-beta.3e, except L1 Interface now uses verified v0.3.0-beta.4e. The frontend
   exception is dogeos69/scroll-sdk-frontends:0.3.0-rc3. These are recorded pins,
   not a claim that all runtime images have passed acceptance.
2. **Contracts have three independent-purpose tags from one build.** Follow
   [the new-instance runbook](devnet-new-bridge-20260909.md)
   for exact gen-configs/deploy/verify tags and the already-bound genesis warning.
   Never pass the rollup-node/core image tag as the gen-l2-artifacts image tag.
3. **fee-oracle requires its actual address, not an exportable KMS private key.**
   The new contracts release authorizes the real address directly. The public
   L1 commit compatibility placeholder is not a fee-oracle identity. Record the
   removal of stale root fee-key fields and contracts ExternalSecret key mappings.
4. **KMS region and EKS region can differ.** An old-cluster IAM role is not usable
   just because the key alias exists. Bind a role to this cluster's OIDC/SA and
   keep the key in its actual region; see the cross-region command caveat in the
   contracts guide. Runtime signing remains an explicit acceptance check.
5. **Generate values before uploading Secrets.** The verified sequence is
   prep-charts → gen-secrets → selective push-secrets with explicit AWS region
   and deployment prefix. Current Reth generation can reconstruct default remote
   paths, so repeat the prefix-aware upload/reconciliation after later generation.
   Inspect references; never upload every old secret file indiscriminately.
6. **WP service keys and proof bearer token have different owners.** Keep the
   proof-aws-managed token in its separate Secret; never duplicate its value into
   the service-key Secret merely to satisfy an old mixed mapping.
7. **Reth fee recipient and genesis normalization need explicit verification.**
   prep-charts must resolve the EVM L2 FeeVault address, not leave `<TODO>` or use a
   Dogecoin recipient. Native Reth genesis from 56a4cac mounts directly and has
   scan startL1Block=0; virtual L1 genesis height 62638951 is a separate setting.
   Do not apply the old Geth adapter or replace the canonical scan start.
8. **Do not claim strict JSON automation is verified for all commands.** See
   [the automation wrapper limitation](automation.md#minimal-shell-wrapper) for
   observed prep-charts progress output before its JSON result.

The final consolidated manual will incorporate the actual successful runtime,
partner handoff and end-to-end steps after those remaining steps
have been executed. Until then, a generated file or proposed workaround must not
be labeled a successfully tested deployment step.
