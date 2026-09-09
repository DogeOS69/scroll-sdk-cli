# Reth rollout and contracts readiness (2026-09-09)

This continues [the frozen new-Bridge instance](devnet-new-bridge-20260909.md).
Do not regenerate genesis or repeat Bridge setup/deposit funding. All commands
below run in `/mnt/wsl/data/github/dogeos69/dogeos-aws-devnet` unless stated otherwise.

## Reth: verified runtime and operator-owned values

Six nodes (two sequencers, two bootnodes, private/public RPC) were installed with
chart 0.1.4 and `dogeos69/rollup-node:v0.3.0-beta.1c`. All became Ready with zero
crash restarts. Each has a fresh **100Gi** gp3 PVC, explicitly approved by the
operator. Primary sequencer status reports L1/L2 Synced; RPC chain ID is 221122,
genesis hash matches the frozen context, and private RPC has two peers.

Before prep-charts, follow [Reth-only peer configuration](reth-only-peers.md).
Set `reth.data.size: 100Gi` and disable `--network.legacy-geth-header-transform`
in both template and generated indexed values. An explicit empty
`sequencer.L2_GETH_STATIC_PEERS = []` disables retired Geth peer derivation after
CLI fix b3eff5b. Preserve archived private keys. Do not duplicate the TOML key:
an initial manual duplicate failed parsing and was corrected before deployment.
Repeat selective prefix-aware Secret uploads after the final successful prep.

```bash
make install-l2-reth-sequencer
make install-l2-reth-bootnode
make install-l2-reth-rpc
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster -n default get pods,pvc -l app.kubernetes.io/name=l2-reth
```

**Check Service naming before contracts.** This instance's config.toml uses
`general.L2_RPC_ENDPOINT = "http://l2-reth-rpc:8545"`. The example's operator-owned
`values/l2-reth-rpc-production.yaml` originally retained
`service.main.fullname: l2-rpc`. Change it to `l2-reth-rpc` for this endpoint,
then upgrade only the private RPC release:

```bash
helm --kube-context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster upgrade l2-reth-rpc oci://ghcr.io/dogeos69/scroll-sdk/helm/l2-reth --version 0.1.4 -n default --values values/l2-reth-rpc-production.yaml --wait --timeout 120s
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster -n default get svc l2-reth-rpc
```

This is an environment naming alignment, not a global rule to rename every
`l2-rpc` Service. Review legacy/deferred consumers before enabling them. Reth
StatefulSet serviceName and storage identities were unchanged by this upgrade.

## Contracts chart readiness repair

The first contracts install did **not** reach its deployment container. Its L2
init container first failed DNS lookup, then (after the naming correction) got
HTTP 405: chart 0.1.22 used HTTP GET and required 200. Reth JSON-RPC requires POST.
The Makefile's 600-second wait expired; this was not a failed contract transaction.

SDK branch `fix/contracts-reth-rpc-readiness`, commit `0985857`, bumps the local
chart to 0.1.23 and replaces the GET check with bounded curl POST `eth_chainId`
requests. It requires a hexadecimal result and matches `CHAIN_ID_L2` when set.
It uses the existing pinned scroll-alpine image (curl/grep available; jq is not).
Lint passed. The rendered command ran in that actual image against devnet RPC:
221122 passed; chain ID 1 kept waiting and was stopped by the test timeout.
The diagnostic container was explicitly stopped afterward.

An evaluated wait4x POST alternative was not used: combining response matchers
consumed its body, and repeated requests returned 400. No runtime jq installation
or change to the contracts image is required by the final repair.

### Safe replacement of the blocked Pod (already executed)

This chart creates a standalone Pod. Its init command is immutable. Before
replacing it, inspect container statuses; require main container waiting with
`reason: PodInitializing`, restartCount 0 and no containerID. If the main container
ever started, reconcile broadcast receipts/nonces before any retry instead.

```bash
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster -n default get pod contracts-contracts-deployment -o jsonpath='{.status.initContainerStatuses}{"\n"}{.status.containerStatuses}{"\n"}'
# Only after confirming that the deployment container has never started:
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster -n default delete pod contracts-contracts-deployment --wait=true --timeout=60s
helm --kube-context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster dependency build /mnt/wsl/data/github/dogeos69/scroll-sdk/charts/contracts --skip-refresh
make install-contracts CONTRACTS_CHART=/mnt/wsl/data/github/dogeos69/scroll-sdk/charts/contracts CONTRACTS_CHART_VERSION=0.1.23
```

The Makefile now supports these two overrides. **0.1.23 is a local source chart,
not a claim of an already published OCI release.** Keep the deploy image pinned
to `deploy-56a4cacda6046c9445af023aefee15a42fda2fdd`.
An unrelated configured onechart repository DNS refresh failed during the initial
dependency build, but the required external-secrets-lib 0.0.4 OCI download succeeded.

The replacement release is revision 2. Its L2 init check passed and the main
container started. Initial broadcast was observed on-chain: L2 block 1 and
deployer nonce advanced from 1 to 8. **Broadcast has now started; do not repeat
the deletion/retry commands above without transaction reconciliation.** Completion
and receipt checks must be recorded separately, not inferred from Helm success.

## Historical blocker: block 1 rejected by every follower

This incident was subsequently addressed by the operator-authorized
[six-volume rebuild and gas-limit correction](reth-gas-limit-recovery.md).
The text below records the state before recovery, not the current empty-block setting.

The primary built block 1 with gasLimit 20,000,000 (0x1312d00), whereas frozen
genesis has 10,000,000 (0x989680). The RPC log reports:

```text
child gas_limit 20000000 exceeds the max allowed increase (10000000/1024)
```

Read-only RPC checks confirmed primary head 1, but standby sequencer, both
bootnodes and both RPC nodes remain at head 0 with no block 1. The primary's
block hash is `0x811107b01c11aea6f34ddbfc1f9489dcb29a18591b263920f808346d376cd4cb`.
It contains seven transactions; deployer nonce is 8 there. Forge's broadcast
record has 77 planned transactions, seven pending hashes and zero receipts
through its RPC. This is **not** a successful contracts deployment or merely
an empty-block scheduling issue.

The configured `reth.builderGasLimit` was empty, leaving the builder's effective
20M limit. The initial runtime acceptance missed this genesis/builder mismatch;
readiness and matching genesis alone were insufficient. Before first broadcast,
set an explicit builder limit consistent with the actual genesis (10,000,000 for
this instance), and verify that a first block is accepted by every node.
Changing the builder setting now cannot repair the already-produced invalid block.
Do not mutate the frozen genesis to 20M as a workaround.

The broadcast directory, Pod manifest and deployment/RPC logs are privately
archived under `/mnt/wsl/data/github/dogeos69/dogeos-reth-rollout.bGMM5p`.
No databases have been deleted or reset, and no post-broadcast rerun was attempted.
The source exposes `rollupNodeAdmin_revertToL1Block`, but it is not verified to
rewind this unsafe L2 head; do not assume it is a generic safe chain reset.
Recovery must reconcile/rewind or isolate the invalid state before retrying.

The operator subsequently requested empty blocks. The sequencer template and
both indexed values now set `reth.sequencer.allowEmptyBlocks: true`; standby
`autoStart: false` is retained. **This change is staged, not applied to the live
primary**, to avoid extending a chain rejected by the five followers. Apply and
verify it together with the explicitly approved chain-recovery procedure.
