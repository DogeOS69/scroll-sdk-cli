# L1 Interface beta.4e: fresh replay initialization and verified rollout

This 2026-09-09 devnet checkpoint supersedes the #1139 blocking status in older
deployment records. The [new Bridge/genesis](devnet-new-bridge-20260909.md) is
unchanged; **do not regenerate genesis or repeat Bridge setup/funding**.

## Release and required opt-in

The user approved trying `dogeos69/l1-interface:v0.3.0-beta.4e`.
[Image build 34296832837](https://github.com/DogeOS69/dogeos-core/actions/runs/34296832837)
succeeded at source revision `eef62d3e40a387b1f53b24825c2e85af54facbc8` and
includes merged [PR #1147](https://github.com/DogeOS69/dogeos-core/pull/1147).

- Image index: `sha256:12bd5cc7cafd6e5fca8054179c71a4ac52dbd8d28fe69d482a87b66df579a0b6`.
- linux/amd64 manifest: `sha256:203bf4d9675d5650eb3cdadcf8e0b97a1524267f4f01cd2b2be43453f1c4570b`.
- Only L1 Interface changes to beta.4e in this checkpoint. Other core services
  and the pinned proof compiler remain on their previously reviewed versions.

Image replacement alone is insufficient. In this **fresh-genesis instance's**
values/l1-interface-production.yaml, manually configure:

```yaml
image:
  repository: dogeos69/l1-interface
  tag: v0.3.0-beta.4e
configMaps:
  env:
    data:
      DOGEOS_L1_INTERFACE_REPLAY_READ__ENABLED: "true"
      DOGEOS_L1_INTERFACE_REPLAY_READ__MAINTAINER_ENABLED: "true"
      DOGEOS_L1_INTERFACE_REPLAY_READ__FRESH_GENESIS_INIT: "true"
```

Merge these fields into the existing values, keeping RPC, paths, context,
probes and Secret mappings. The new flag defaults false. It is an explicit
fresh-instance assertion, not a global default for upgrades. Do not enable the
read-only upgrade-test override. Normal l1_interface startup invokes the shared
core seeding library before validation, only when the replay path is absent;
existing valid state is preserved, and invalid existing state still fails closed.
No init container, external seeding binary, empty SQLite file or validation bypass.
After later prep-charts generation, check that this operator setting and the
instance-specific volume binding remain present before applying any release.

## Offline image checks actually executed

Private test workspace:
`/mnt/wsl/data/github/dogeos69/dogeos-beta4e-validation.stxXm8`.
Its test-start.mjs wrapper reads generated ConfigMap environment and local
l1-interface-secret.env, passing environment names to Docker without printing
private values. It mounts canonical .data/genesis.json and protocol_context.json
read-only, and mounts a newly created local data directory. Docker uses the
immutable image index above, `--network none`, a read-only root filesystem,
and tmpfs /tmp. The wrapper has a bounded timeout and stops its own container
if needed; test databases/logs remain in the private directory.

Commands, in order:

```bash
node /mnt/wsl/data/github/dogeos69/dogeos-beta4e-validation.stxXm8/test-start.mjs without-opt-in
node /mnt/wsl/data/github/dogeos69/dogeos-beta4e-validation.stxXm8/test-start.mjs fresh
node /mnt/wsl/data/github/dogeos69/dogeos-beta4e-validation.stxXm8/test-start.mjs restart
```

The first failed without creating replay.sqlite and explained the opt-in.
The second created replay.sqlite and passed authoritative protocol/genesis
validation. The third reported an already-present DB and no-op initialization,
then passed validation again. The latter two exited at Dogecoin RPC because
network access was deliberately disabled; do not label those exit codes as a
fully running service. Container root-owned 0600 test DB files were not readable
by the host user; host sqlite/hash diagnostics failed, and were not reported as
successful integrity or byte-preservation tests. In-service startup validation
and the subsequent cluster health/restart checks are the acceptance evidence.

## Coordinated new-instance cluster switch

All commands below ran from the deployment project with this explicit context:

```bash
export DOGEOS_KUBE_CONTEXT=arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster
```

Before mutation, Helm values for old l1-interface and scroll-common plus the
old PVC manifest were saved in the private test directory. The old PVC is
`l1-interface-data`, backed by `pvc-4092d5c4-ddcc-4bf6-aca9-bba228736555`.
Its Helm resource-policy is keep; it is retained, not emptied or reused.

Created manifests/l1-interface-data-devnet-20260909.yaml in the deployment
project: namespace default, storageClassName gp3, ReadWriteOnce, 100Gi. Added
`persistence.data.existingClaim: l1-interface-data-devnet-20260909` to the L1
values. This claim did not exist before this deployment. Helm chart 0.0.22
renders the new binding and no managed replacement PVC; a server-side dry-run
of the new PVC passed. No unrelated PVC is removed.

```bash
kubectl --context "$DOGEOS_KUBE_CONTEXT" -n default scale statefulset l1-interface --replicas=0
kubectl --context "$DOGEOS_KUBE_CONTEXT" -n default wait --for=delete pod/l1-interface-0 --timeout=45s
kubectl --context "$DOGEOS_KUBE_CONTEXT" -n default apply -f manifests/l1-interface-data-devnet-20260909.yaml
make install-scroll-common install-l1-interface
kubectl --context "$DOGEOS_KUBE_CONTEXT" -n default wait --for=condition=Ready pod/l1-interface-0 --timeout=45s
```

Stopping the old Pod before replacing shared ConfigMaps avoids exposing an old
process/database to the new protocol. The Makefile supplies the explicit context
to both Helm commands. Both releases upgraded to revision 2. The new claim is
bound to `pvc-1e173311-d9fd-4f8c-9cd9-df853c2d35b2`; the old claim remains Bound.

## Observed acceptance and remaining scope

- At 2026-09-09T02:27:23Z, normal service startup initialized replay.sqlite on
  the fresh Kubernetes PVC and validated the new protocol/genesis commitments.
- Dogecoin historical scan completed to height 62639340 in about 6.22 seconds,
  including ten deposits at height 62638964. Missing optional watch-only imports
  caused a logged fallback to full block scan, not a startup failure; no shared
  Dogecoin wallet was modified to silence that warning.
- Pod became Ready, zero crash restarts; running imageID matches the approved
  image index. Startup/readiness/liveness probes returned HTTP 200.
- genesis-config and protocol-context-config JSON compare exactly equal to the
  canonical local new-instance artifacts. ExternalSecret is SecretSynced=True
  and references dogeos/devnet-20260909/l1-interface-secret-env.
- Direct health GET via localhost-only kubectl port-forward returned ready=true,
  healthy database and replay model, fully_validated=true, wf_tx=0, and protocol
  ID b7e9425fda9ad99b782a10b5575521bca67f4842da4923f00d690a8a5947beaa.
- JSON-RPC returned eth_chainId=0x1b207 (111111, the virtual L1, not L2's
  221122) and eth_blockNumber=0x0. The synthetic chain remains at wf_tx=0;
  indexing ten Dogecoin deposits is not proof of completed L2 deposit execution.

Controlled restart verification used:

```bash
kubectl --context "$DOGEOS_KUBE_CONTEXT" -n default rollout restart statefulset/l1-interface
kubectl --context "$DOGEOS_KUBE_CONTEXT" -n default rollout status statefulset/l1-interface --timeout=45s
```

The first 45-second wait expired while replacement was still progressing;
running the status command again succeeded (do not repeat rollout restart).
At 2026-09-09T02:33:15Z the new process reported that replay DB already exists
and fresh initialization is a no-op. It loaded indexer height 62639340, skipped
already completed historical sync, passed validation and became Ready again,
still using the same new PVC. The new Pod has zero crash restarts. Initial and
restart logs are retained privately as cluster-first-start.log and
cluster-restart.log. No data volume was deleted during this restart.

Read-only endpoint checks use:

The runtime image does not include curl; a kubectl exec curl diagnostic failed
for that reason. Use the host-side method below instead of changing the image.
Stop the old port-forward and recreate it after Pod replacement; otherwise its
old listeners may still occupy the local ports. Stop the diagnostic forwarding
process after verification; it is not a deployment service.

```bash
kubectl --context "$DOGEOS_KUBE_CONTEXT" -n default port-forward service/l1-interface 28545:8545 29090:9090
# In another terminal:
curl --fail --silent --show-error http://127.0.0.1:29090/api/v1/health/ready
curl --fail --silent --show-error http://127.0.0.1:28545 \
  -H 'content-type: application/json' \
  --data '[{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},{"jsonrpc":"2.0","id":2,"method":"eth_blockNumber","params":[]}]'
```

This verifies L1 Interface cold start for the new instance, not full DogeOS
end-to-end operation. Reth/L2 contracts, DA/WP/proof runtime, EC2 partner handoff,
DNS/TLS and end-to-end tests remain separate subsequent steps. Blockscout stays
deferred without RDS admin credentials. Preserve the existing Bridge and resume
deployment after this successfully initialized L1 Interface.
