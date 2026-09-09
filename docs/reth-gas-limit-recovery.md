# Reth gas limit and empty-block recovery (2026-09-09)

This continues the [contracts first-block incident](reth-contracts-runtime.md).
The operator explicitly authorized deleting the six L2 PVCs and rebuilding with
the **same frozen genesis**, builder gas limit 10,000,000 and empty blocks enabled.
This is a destructive recovery procedure, not a routine deployment prerequisite.

## Configuration and root cause

In rollup-node tag v0.3.0-beta.1c, crates/node/src/context.rs uses
`builder.gas_limit().unwrap_or(SCROLL_GAS_LIMIT)`; constants.rs defines that fallback
as 20,000,000. An empty `reth.builderGasLimit` omits `--builder.gaslimit` from the
chart. It does not automatically inherit the genesis gas limit.

Set the following in the sequencer template and both generated indexed values:

```yaml
reth:
  builderGasLimit: "10000000"
  sequencer:
    allowEmptyBlocks: true
```

Keep primary `autoStart: true` and standby `autoStart: false`. Also explicitly
set builderGasLimit to 10000000 in bootnode/RPC templates and generated values;
their sequencing remains disabled. This instance's genesis gasLimit is 0x989680.
For a different genesis, verify its actual value rather than copying this number.

SDK branch fix/reth-example-gas-limit, commit d035e86, updates all four Reth
examples to an explicit 10M gas limit and enables empty blocks in the sequencer
example only. The live chart version remains 0.1.4. Rendered sequencer arguments
were checked for both flags and correct primary/standby auto-start behavior.

## Stop and delete only the authorized L2 storage

Working directory: /mnt/wsl/data/github/dogeos69/dogeos-aws-devnet.
Before stopping the old deployment, copied its broadcast directory again to
dogeos-reth-rollout.bGMM5p/contracts-broadcast-before-reset and saved its log plus
the six PVC manifests in the same private directory. Existing earlier diagnostic
archives remain. These are transaction/configuration records, **not disk snapshots**.

```bash
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster -n default delete pod contracts-contracts-deployment --wait=true --timeout=45s
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster -n default scale statefulset l2-reth-sequencer-0 l2-reth-sequencer-1 l2-reth-bootnode-0 l2-reth-bootnode-1 l2-reth-rpc l2-reth-rpc-public --replicas=0
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster -n default wait --for=delete pod -l app.kubernetes.io/name=l2-reth --timeout=45s
```

Inspect every remaining Pod's volume references; none may reference the six
claims below. Confirm exact claim names and PV reclaim policy before deletion.
All six policies were Delete: old disks are not recoverable from the local logs.
The six old PV objects were subsequently confirmed absent.

```bash
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster -n default delete pvc l2-reth-sequencer-0-data l2-reth-sequencer-1-data l2-reth-bootnode-0-data l2-reth-bootnode-1-data data-l2-reth-rpc-0 data-l2-reth-rpc-public-0 --wait=true --timeout=45s
make install-l2-reth-sequencer
make install-l2-reth-bootnode
make install-l2-reth-rpc
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster -n default wait --for=condition=Ready pod -l app.kubernetes.io/name=l2-reth --timeout=45s
```

All six claims were recreated at 100Gi gp3 with new PV IDs. The L1 Interface
current and historical PVCs were unchanged. Genesis YAML SHA256 remains
ef936991667e3010fd081ede6235c109257c7a36077e46738996a435aa86edc8.
No Bridge creation, genesis generation or Dogecoin deposit funding was repeated.

## Verify actual blocks before restarting contracts

Six Pods became Ready with zero restarts. Do not stop at that check: query all
six Services for a **fixed common block height**, its hash/gasLimit/transactions,
and the deployer nonce. Querying latest independently may observe different
heights simply because empty blocks continue to be produced every three seconds.

Observed common block 5:

- Hash: 0x640107c6608dc6671b5a78ea5b554f866f25a818bed9f79afbaeb4fd46bea102.
- gasLimit: 0x989680 (10,000,000), zero transactions on every node.
- Deployer nonce: 0x1 on every node, matching genesis (not zero).
- Primary, standby, both bootnodes and both RPC nodes all accepted that block.

The first diagnostic attempted this before a bootnode had fully caught up and
failed its preflight. No contracts were deployed at that point. Repeated RPC
checks after catch-up confirmed all six matching results; no further reset was
needed. The primary logs confirmed repeated canonical empty blocks with 10M gas.

Only after these checks, executed:

```bash
make install-contracts CONTRACTS_CHART=/mnt/wsl/data/github/dogeos69/scroll-sdk/charts/contracts CONTRACTS_CHART_VERSION=0.1.23
```

Keep deploy-56a4cacda6046c9445af023aefee15a42fda2fdd. Chart 0.1.23 is the local
source fix, not an asserted published OCI release. The prior invalid-chain
broadcast record is historical and must not be treated as receipts on this
rebuilt chain. Deployment completion and new receipts are separate acceptance
checks; never infer them from Helm success alone.

## Verified contracts result

At 2026-09-09T03:19:38Z, contracts Pod completed with exit code 0 and zero
restarts, release revision 3. The Makefile wait succeeded. The archived new log
contracts-success.log contains 77 unique successful transaction hashes in blocks
34 through 46. All **77 receipts** were queried again from the private RPC and
each returned status 0x1; total receipt gasUsed is 24,073,598.

All 29 nonzero L2 addresses in config-contracts.toml have deployed bytecode.
Whitelist.isSenderAllowed for the actual fee-oracle KMS address
0xbEEC0A88c46ad59AA82aA0208F914a1ba6b83e5c returns true at predeploy
0x5300000000000000000000000000000000000003.

This completes the Reth recovery and L2 contracts redeployment, **not** the
remaining DA/WP/proof/EC2/DNS/TLS/end-to-end deployment acceptance. Do not repeat
the destructive recovery commands or the successful contract broadcast to resume.
