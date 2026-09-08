# DogeOS deployment status and runbook corrections

This page consolidates findings from the 2026-09-08 from-scratch devnet deployment.
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

- Domain: devnet.doge.xyz. L2 chain ID: 221122. Ethereum DA: Sepolia (11155111).
- Bridge setup and ten deposit-seed transactions are already confirmed; the
  canonical protocol context has been generated. **Do not regenerate genesis,
  change seed/salt, or repeat Bridge setup/funding to resume this instance.**
- gen-secrets, prep-charts, proof-config-check, selected Secret uploads, the new
  contracts image's offline None/verify-config simulation, and a Reth server-side
  dry-run have passed. None of these proves full runtime readiness.
- scroll-common and l1-interface Helm releases were installed. Their canonical
  ConfigMaps match local artifacts; L1 Interface's ExternalSecret synchronized.
- L1 Interface v0.3.0-beta.3e fails on a fresh PVC because /data/replay.sqlite
  does not exist. [Core #1139](https://github.com/DogeOS69/dogeos-core/issues/1139)
  requires initialization inside the service binary, before strict startup
  validation. A separate mandatory initializer/init container is not the intended
  fix. Do not disable replay or import another instance's database.
- Reth, L2 contracts, fee-oracle, DA and proof services are not installed in this
  run. EC2 signer/worker replacement and DNS/TLS/end-to-end validation remain
  pending. Blockscout is explicitly deferred because RDS admin credentials are
  unavailable. Do not reset RDS or deploy retired PostgreSQL consumers to proceed.

## Corrections that must carry into the final runbook

1. **Use Reth, not retired l2geth setup instructions.** For this deployment the
   rollup-node image exception is v0.3.0-beta.1c; core services otherwise use
   v0.3.0-beta.3e, with the unresolved L1 cold-start limitation above. The frontend
   exception is dogeos69/scroll-sdk-frontends:0.3.0-rc3. These are recorded pins,
   not a claim that all runtime images have passed acceptance.
2. **Contracts have three independent-purpose tags from one build.** Follow
   [the contracts guide](contracts-placeholder-compatibility.md#fee-oracle-address-only-contracts-release)
   for exact gen-configs/deploy/verify tags and the already-bound genesis exception.
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
   Dogecoin recipient. A Reth-mounted genesis adapter must use this instance's
   virtual L1 genesis height (62634568 here), never another deployment's hardcoded
   height, and must preserve the canonical genesis rather than edit it in place.
8. **Do not claim strict JSON automation is verified for all commands.** See
   [the automation wrapper limitation](automation.md#minimal-shell-wrapper) for
   observed prep-charts progress output before its JSON result.

The final consolidated manual will incorporate the actual successful runtime,
partner handoff and end-to-end steps after the blocker is fixed and those steps
have been executed. Until then, a generated file or proposed workaround must not
be labeled a successfully tested deployment step.
