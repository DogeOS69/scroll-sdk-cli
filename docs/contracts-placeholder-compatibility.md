# Legacy contracts compatibility without exporting a service key

**Version boundary:** the instructions below describe the historical 28f6ca
and ba832bb images. Current devnet uses contracts commit
`56a4cacda6046c9445af023aefee15a42fda2fdd` and a newly created Bridge; follow
[the new-instance runbook](devnet-new-bridge-20260909.md) for its exact pins and
resume boundary. That release removes the legacy L1 commit/finalize account
inputs, zeros the unused L1 gas-oracle and Geth signer fields, fixes the unused
coordinator JWT, and emits native Reth genesis. Its contracts scripts no longer
need those legacy keys. Existing CLI compatibility fields may remain locally
until the corresponding legacy CLI configuration path is retired; never fund
or authorize the public placeholder. The real fee-oracle address is still
required, and neither KMS service needs an exportable private key.

The historical #1139 startup blocker described below is now resolved in the
devnet trial using beta.4e and explicit fresh-genesis opt-in; see the
[verified L1 Interface rollout](l1-interface-beta4e-cold-start.md).

This is an opt-in compatibility mode for **DogeOS testnet/regtest L2-only
deployment**, not a general-purpose KMS workaround for Scroll L1 contracts.

The contracts release at `28f6ca9c44196d63bd39f3ea5e9e3227051332fa` requires
`accounts.L1_COMMIT_SENDER_PRIVATE_KEY` and verifies that it derives
`accounts.L1_COMMIT_SENDER_ADDR`, even when generating L2 genesis. Its deploy
entrypoint first simulates with layer `None`, then simulates/broadcasts only
layer `L2`; its L1 broadcast command is commented out. The legacy
`initializeScrollChain()` sender authorization is not broadcast in this flow.
Audit this boundary again before changing the contracts image or entrypoint.

For this specific deployment mode, put this **public, unfunded test vector**
in root `config.toml`:

```toml
[accounts]
L1_COMMIT_SENDER_ADDR = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
L1_COMMIT_SENDER_PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001"

[contracts]
LEGACY_COMMIT_SENDER_PLACEHOLDER = true
```

Merge these fields into the existing sections; do not duplicate TOML sections.
This key is public and has no confidentiality or account-security properties.
Never send funds to or grant on-chain permissions to this address.

The actual service identity remains exclusively in `.data/doge-config.toml`:
`[signers.l1CommitSender]` and its `[accounts]` address projection. Configure
it using `setup eth-da-submitter`, including the real KMS key and IAM role.
Do not copy the placeholder into that file. KMS mode has no local private key.

Run `setup gen-l2-artifacts --doge-config .data/doge-config.toml` with the
approved exact contracts image tag. Generation validates the placeholder pair,
restricts this mode to testnet/regtest, and checks that the real service
identity is valid, internally consistent and different from the placeholder.

`setup gen-secrets` supplies the public compatibility private key **only** to
the contracts Secret. It still produces no submitter private-key Secret in
KMS mode. `setup prep-charts` reads the real canonical signer for both the
submitter and Withdrawal Processor's `expected_batchers`; do not hand-edit
those generated outputs to match root config's compatibility address.

`helper fund-accounts` refuses implicit/L1 service funding while this mode is
enabled, since its legacy root-config target is the placeholder. L2 account
funding (`--layer 2`) and explicit deployer funding remain available. Fund the
real DA sender separately on its configured Ethereum DA network. Do not use
root config's commit address for monitoring the actual submitter balance.
`prep-charts` generates scroll-monitor balance settings from the real canonical
signer and Ethereum DA RPC, and monitors the fee-oracle separately on L2. See
[Monitoring account balances](monitoring-balances.md) for configuration sources
and thresholds.

Acceptance checks:

- The unchanged contracts image generates L2 artifacts successfully.
- L2 genesis chain ID, sequencer signer and commitments remain correct.
- Runtime submitter and WP allowlist select the real signer, not the placeholder.
- Contracts Secret contains the public compatibility key; the KMS service does not.
- No L1 Scroll deployment/authorization is broadcast using the placeholder.

This does not remove other legacy contracts account inputs, authorize L1
deployment, or make the complete deployment pass without subsequent chart,
secret, runtime and end-to-end checks.

## Fee-oracle address-only contracts release

The fee-oracle is different: its real address is authorized by the L2 Whitelist.
Never use the public L1 compatibility placeholder for this role.

Contracts commit `ba832bbd97a13aaee4cbc1b14d792966e86b412b` removes only the
L2_GAS_ORACLE_SENDER_PRIVATE_KEY declaration, input reads, validation, and
generated template field. A valid nonzero L2_GAS_ORACLE_SENDER_ADDR is required.
Existing deployments using a local signer remain compatible, but the contracts
configuration no longer depends on that signer's private key. Other legacy
account checks remain unchanged. Its deploy entrypoint retains the audited
None simulation followed by L2 simulation/broadcast, with L1 broadcast disabled.

The three application images were published together by
[Actions 34219590027](https://github.com/DogeOS69/scroll-contracts/actions/runs/34219590027):

| Purpose | dogeos69/scroll-stack-contracts tag |
| --- | --- |
| Fresh genesis generation | gen-configs-ba832bbd97a13aaee4cbc1b14d792966e86b412b |
| L2 deployment | deploy-ba832bbd97a13aaee4cbc1b14d792966e86b412b |
| Contract verification | verify-ba832bbd97a13aaee4cbc1b14d792966e86b412b |

For a new instance, configure the actual fee-oracle signer first, then run
gen-l2-artifacts with the exact gen-configs tag. For a Bridge already initialized
on Dogecoin, do **not** regenerate genesis or replay Bridge funding steps just
to adopt this configuration-only repair. Preserve the canonical genesis and
verify existing deterministic contract predictions with the new deploy image.

Reproducible configuration sequence:

1. Run `setup fee-oracle --signer-backend aws-kms` with the existing key and
   a role trusting this deployment's EKS OIDC and fee-oracle ServiceAccount.
   When the key and cluster regions differ, supply a pre-provisioned matching
   `--role-arn`; `--aws-region` selects the key region in that path. Do not reuse
   an old-cluster role just because the KMS alias contains that cluster's name.
2. Confirm root config.toml/config.public.toml contain the actual
   L2_GAS_ORACLE_SENDER_ADDR. Remove a stale local fee private-key field from
   root config.toml if one remains. Do not invent a KMS private key.
3. Set values/contracts-production.yaml image.tag to the matching deploy tag.
   Remove its ExternalSecret mapping for L2_GAS_ORACLE_SENDER_PRIVATE_KEY.
   This is a recorded operator edit for the new contracts image; do not remove
   the other legacy fields still required by Configuration.sol.
4. Run `setup prep-charts`, then `setup gen-secrets`, then selectively
   `setup push-secrets --secret-file ... --values-file ...` with the actual
   Secrets Manager region and deployment-specific prefix. Run secret upload
   after the final values generation, and verify the resulting remote refs.
5. Check contracts Secret includes deployer, legacy L1 finalize/oracle inputs,
   coordinator JWT, and the explicitly opted-in L1 commit placeholder if used.
   KMS fee-oracle and DA runtime services must have no local signer key Secret.
   WP proof bearer token uses its own proof-aws-managed Secret, not the service
   private-key Secret. Do not copy its value into the latter to silence errors.
6. Before broadcasting, run the new image's Forge `None / verify-config`
   simulation using the actual public config, contract predictions, and
   generated Secret environment. It must pass without a fee-oracle private key.

The 2026-09-08 devnet passed this offline image check, 27 targeted contracts
tests, generation, selective secret upload and proof config preflight. This is
**not** complete deployment acceptance: first L1 Interface startup on a fresh
PVC failed with `Replay SQLite file not found: /data/replay.sqlite` in core
v0.3.0-beta.3e. Core requires a valid protocol-bound manifest/bootstrap snapshot,
not an empty file. Do not disable replay checks or reuse another instance's DB.
The required resolution is automatic initialization in the normal l1_interface
binary startup, using reusable core library logic; a separate mandatory command
or init container is not the intended deployment solution. Track
[core issue #1139](https://github.com/DogeOS69/dogeos-core/issues/1139) and use a
validated corrected service image before continuing Reth and L2 deployment.
Full end-to-end deployment acceptance remains pending. See the
[deployment status and corrections](dogeos-deployment-status.md) for the current
resume boundary; do not treat historical generation examples as commands to rerun
against an already initialized Bridge.
