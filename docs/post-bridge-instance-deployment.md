# Post-Bridge instance deployment

This guide describes the environment-owned runner
`scripts/deploy/post-bridge.mjs` in a DogeOS deployment repository. It is not a
new `scrollsdk` command: it orchestrates existing CLI commands and Helm charts
after Bridge initialization. Credentials, transcripts and acceptance records
belong in the deployment repository, not this manual.

## Prepare inputs first

1. Configure the instance domain, chain settings, existing KMS signers and
   shared AWS infrastructure using the documented setup commands.
2. Use `scrollsdk setup cubesigner-init` for a new role/key when required and
   the normal session commands. Never remove/replace another role/key's policies.
   The provided environment uses the approved testnet `transport_only` lane.
3. Run `setup gen-l2-artifacts` for native Reth genesis. The `gen-configs-*`,
   `deploy-*` and `verify-*` images must use the same approved contracts revision.
   `gen-configs-*` is a contracts tag, not a Reth/core tag. Preserve the fixed
   `[contracts.overrides].L2_NATIVE_DOGE_TOKEN` address from the config example;
   it is distinct from wrapped DOGE and installed at genesis.
4. Complete Bridge initialization and its funding/confirmation requirements.
   An environment may wrap this in `bridge-init-with-shadowfork-mining.sh`.
   Do not rerun Bridge initialization to resume post-Bridge deployment.
5. Ensure genesis/protocol projections, signer descriptors, native config and
   the verified proof-materials receipt exist. The runner checks their hashes
   and rejects mismatched projections.

Prerequisites: Node.js, the adjacent installed/built CLI checkout and dependencies,
Helm, kubectl, AWS CLI, Docker for CLI generation, and SSH/SCP to the approved
signer host. EC2 needs Python 3, Docker Compose, the existing identity/operator
files and access to configured RPC sources. The adjacent SDK checkout supplies
local contracts/eager charts. The runner needs no dogeos-core source checkout.

## Review and execute

Review `deployment/post-bridge.json` in the deployment repository. The initial
runner deliberately restricts context, namespace, account and region; it is not
a generic multi-cluster tool. Review image/chart pins, domain, artifact prefix,
proof receipt, storage, funding floor, confirmation profile and the **current**
EC2 signer source directory. Update that directory for the next instance after
a successful replacement; do not change the profile midway through a resume.

```bash
node scripts/deploy/post-bridge.mjs --instance devnet-next --plan
node scripts/deploy/post-bridge.mjs --instance devnet-next --check
node scripts/deploy/post-bridge.mjs --instance devnet-next --apply --switch-signers
```

`--plan` is default: it only validates local inputs, invokes no external commands
and writes no outputs. `--check` performs read-only inventory/account checks.
Neither proves AWS mutation permissions, image availability or runtime success.
`--apply` executes the workflow. To stop before EC2 cutover:

```bash
node scripts/deploy/post-bridge.mjs --instance devnet-next --apply --through services
node scripts/deploy/post-bridge.mjs --instance devnet-next --apply --switch-signers
```

The ID scopes artifact prefixes, evidence and fresh storage, **not** all Helm
releases, endpoints or default AWS Secret paths. This is a replacement workflow
for a cleared instance, not concurrent deployment in one namespace. Conflicting
resources and old PVCs stop execution. Normal apply never cleans them up.

For a later fresh instance, first clean up the previous instance using its
recorded ownership receipt, then run the Bridge wrapper, then the post-Bridge
apply. Use the same script's explicit cleanup mode:

```bash
node scripts/deploy/post-bridge.mjs --instance previous-instance --cleanup --plan
node scripts/deploy/post-bridge.mjs --instance previous-instance --cleanup --check
node scripts/deploy/post-bridge.mjs --instance previous-instance --cleanup --apply
```

The runner writes `artifacts/deployment/INSTANCE/ownership.json` during deployment.
Cleanup is restricted to those recorded releases and PVCs. Before the first
uninstall it checks all target UIDs, release revision/manifest and PVC consumers;
replaced resources and foreign Pods block cleanup. Uninstall uses no hooks and
waits for workloads before deleting exact PVC names. PVC deletion may destroy
data irrecoverably without snapshots. AWS resources, EC2 signers/volumes, shared
infrastructure and local inputs are preserved. Do not perform bulk namespace or
prefix-based cleanup. Older/manual deployments and interrupted installs lacking
complete receipts need a separate explicit ownership audit; the runner cannot
infer ownership from names. A cleaned instance ID must not be reused.

Some environments retain unrelated historical resources whose names share a
service prefix. Do not delete these merely to pass preflight. The environment
profile can record audited `preservedDormantDeployments` (exact name, UID,
expected PVC names, and zero replicas) and `preservedConfigMaps` (exact name,
UID and data hash). Preflight verifies these pins and leaves the objects alone;
this grants no adoption, modification or cleanup authority. A changed object
blocks deployment, and an exact collision with a rendered chart still blocks
installation. Keep environment-specific names and audit evidence in the
deployment repository, not this manual.

The Bridge wrapper's persistent attempt fence remains separate. Inspect/archive
the completed old attempt and prepare fresh inputs using its documented workflow;
cleanup does not erase that fence or replay funding transactions.

## Phases

| Phase | Actions |
| --- | --- |
| `prepare` | Set operator values/fresh storage; run `setup eth-da-submitter`, `proof-aws-init`, scoped eager IAM setup, `doge-config --proof-topology`, `cubesigner-refresh`, `prep-charts`, `gen-secrets`, `export-signer-policy`, `proof-config-check`. |
| `secrets` | Selectively push required service Secrets and CubeSigner session with `--aws-prefix dogeos`. Proof-AWS manages split proof-token ownership separately. |
| `core` | Install common config, L1 and six Reth nodes with fresh storage; check genesis agreement, chain ID, gas limit and empty blocks. |
| `contracts` | Install the pinned native-genesis-compatible chart; wait for the one-shot Pod to succeed. |
| `services` | Fund the configured KMS fee oracle to its reviewed floor if needed; install DA, fee oracle, CubeSigner, TSO, PC, eager, WP and frontends. |
| `signers` | Prepare isolated EC2 projects/fresh SQLite volumes with exported policy and existing identities; validate all old-container ownership before authorized cutover. |
| `start-l1-sync` | Wait for service readiness, read genesis-hold state, release if held, and verify release. |
| `verify` | Recheck readiness, L2 progress, signer identity, DA status and hold release; write readiness evidence. |

Choose any phase with `--through`. Services install before collective readiness
checks to avoid installation-order dependency deadlocks. Mock generation is
internal to proof-coordinator: **do not deploy a mock worker**. Eager remains
enabled. Shared Dogecoin/Shadowfork, monitoring and existing proxies are untouched;
Blockscout and test activity are excluded. Real-proof enforcement and withdrawal/
Batch acceptance are separate tasks.

Generation stays in the CLI; the runner does not hand-edit sessions or compiled
proof outputs. Operator edits precede `prep-charts`; the proof contract is checked
before installation. Short devnet confirmations belong in the environment's
override script, not SDK examples. DA submission interval is not shortened.

## Genesis hold is intentional

Fresh sequencer deployments must preserve
`DOGEOS_L1_INTERFACE_SEQUENCER_GENESIS_MODE: "true"`. After setup, the manual
command `make start-l1-sync` calls
`POST http://l1-interface:9091/disable-genesis-hold` inside the cluster.
The automated phase uses the same request from an existing RPC Pod, without
creating/deleting a helper Pod.

Read `GET http://l1-interface:9090/health/detailed` before and after release.
`components.genesis_hold.details.enabled=true, activated=false` means held;
`enabled=true, activated=true` means released. Resume skips POST only when
persisted state is already released, including a lost previous response.
Missing state, disabled configuration, HTTP errors or an unsuccessful POST
are not silently accepted. Do not turn off the configuration to bypass the step.

## Side effects and recovery

Apply writes local configs, refreshes the CubeSigner session, provisions instance
proof/eager IAM and updates the existing DA archive permissions. It pushes selected
default-path AWS Secrets and creates Helm/PVC resources. Old live deployments
must no longer consume those shared Secret names. EC2 cutover additionally needs
`--switch-signers`: identity files are copied only on EC2, never downloaded.
Only exact approved source-directory/service-labeled containers may be stopped;
CubeSigner role/key policies and shared proxy containers are not changed.

Checkpoints live in `artifacts/deployment/INSTANCE/`; logs go in
`logs/deployment/INSTANCE/`, never `.data`. Resume with the same ID, Bridge/genesis
and profile. The repository-wide `artifacts/deployment/apply.lock` prevents
concurrent runs sharing inputs/release names. A process kill can leave a lock
and outstanding operations: inspect host/PID, child processes, Helm and EC2
before removing only that confirmed-stale lock. Never bypass it with another ID.

Contracts use `restartPolicy: Never`. Failed/incomplete installation stops for
inspection; do not delete/recreate the Pod and replay already mined transactions.
The funding hash is saved **before broadcast**; a missing/pending/failed receipt
on resume stops execution rather than sending another transfer. Inspect the
stored transaction/nonce and chain state before manual recovery. Completed steps
are skipped, but final health checks always rerun.

Failed signer cutovers retain directories/volumes. Resume requires identical
inputs and does not recreate containers or automatically roll back signing state.
Remote `/tmp/dogeos-*` staging bundles are retained for diagnostics; no copied
private identity files are placed there. Inspect incomplete directories rather
than deleting them to force a new attempt.

Readiness is not withdrawal, real-proof or zero-RPC Batch acceptance. Run the
deployment repository's acceptance tools and record results there. The initial
runner has offline tests and chart rendering checks; a complete clean-instance
rollout remains an integration test, not an established guarantee of this guide.
