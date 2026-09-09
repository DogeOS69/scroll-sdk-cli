# Core services runtime checkpoint (2026-09-09)

Continue only after the same-instance contracts and Reth checks in
[the instance runbook](devnet-new-bridge-20260909.md). Do not rerun successful
contracts broadcasts or reset Bridge/genesis to resume.

## Withdrawal Processor

From the deployment directory, set these operator-owned values in
`values/withdrawal-processor-production.yaml`:

- `image.tag: v0.3.0-beta.4e` (fresh-genesis support verified against that source).
- `persistence.data.size: 100Gi` (explicitly approved for this devnet).
- `env` entry `DOGEOS_WITHDRAWAL_FRESH_GENESIS_INIT`, string value `"true"`.

The fresh flag permits the binary's own cold initialization against the canonical
protocol context/genesis. It is not permission to reuse another protocol's DB.
Do not set snapshot-continuation bootstrap height for this fresh instance. CLI
commit `2b4fb04` prevents prep-charts from stripping this runtime-only opt-in;
it does not enable it by default. Service signing keys remain ExternalSecret
inputs, and the proof bearer token remains separately proof-AWS-owned.

After generation, prefix-aware Secret reconciliation and proof-config-check:

```bash
helm --kube-context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster \
  template withdrawal-processor oci://ghcr.io/dogeos69/scroll-sdk/helm/withdrawal-processor \
  --version 0.1.21 -n default -f values/withdrawal-processor-production.yaml |
  kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster \
    -n default apply --dry-run=server -f -
make install-withdrawal-processor
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster \
  -n default exec l2-reth-rpc-0 -- \
  curl -fsS --max-time 10 http://withdrawal-processor:3000/healthz/ready
```

Verified revision 1 created a new Bound 100Gi `withdrawal-processor-data` claim.
At 04:01 UTC the beta.4e Pod was 1/1 Ready, zero restarts. Historical Dogecoin
and L2 indexing completed; readiness returned true for database and ingestion.
This is not yet a successful withdrawal/signature/settlement acceptance test.

## Idle Proof Coordinator

This instance still uses disabled/mock/observe. Two CLI corrections are needed:

- `08355c6`: do not inject S3-only environment fields into the generated idle
  `local_fs` configuration. AWS token/role ownership is retained.
- `55882ad`: idle mode has no HTTP listener; generate process-presence probes,
  and restore HTTP probes on activation. See [probe semantics](proof-operator-runbook.md).

For the fresh instance, a dedicated 10Gi gp3 RWO claim was applied from deployment
file `values/proof-coordinator-pvc-devnet-20260909.yaml`, then referenced via
`persistence.data.existingClaim`. The old 100Gi Coordinator claim was preserved.
Do not use the unsupported `fullname` field to select an existing claim.

The operator mirrored the CLI's three probe specs into production values and
verified Helm rendering: exec `sh -ec 'kill -0 1'`, `httpGet: null`,
`tcpSocket: null`. This manual edit is only the disabled-mode projection of the
committed generator fix; future prep-charts must own mode transitions.
`setup proof-config-check --json` passed before `make install-proof-coordinator`.
Revision 3 applied. The old unready Pod required deletion after checking the
desired StatefulSet revision; no claim was deleted. Its replacement reached
1/1 Ready with zero restarts. Idle Ready does not indicate a working prover API.

## Other verified services and remaining work

DA recovery and later timeout tuning are recorded in
[the DA runtime guide](eth-da-submitter-rpc-recovery.md). Fee-oracle is Ready and
its KMS-signed update transaction
`0xd847aa36e5a733de718657c57c74099352e332bd5c538d513241e1cee3355dc0`
has receipt status `0x1`. TSO is Ready. Fee-oracle and the activity account were
each funded with 0.2 native L2 DOGE using `helper fund-accounts --layer 2` and
the **Directly fund L2 wallet** choice. The helper's generic ETH label does not
mean Sepolia ETH was transferred. Never fund a compatibility placeholder.

EC2 signer/Worker replacement, active proof topology, external access and
end-to-end bridge tests remain unverified. Blockscout remains explicitly deferred.
