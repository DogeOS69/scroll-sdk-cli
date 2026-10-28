# Deployment preparation and application checks

Run `scrollsdk setup deployment-preflight --json` after `setup render` and before
installing Helm releases. It validates local application inputs. Optional proof,
RPC, Kubernetes and startup checks verify application behavior. The command does
not install releases or audit AWS resource compliance.

AWS resources and permissions are prepared with the external infrastructure
workflow. The old `--alb`, `--nlb`, `--artifact-access` and associated AWS audit
flags have been removed. `setup aws` reads metadata for production YAML instead.
Use `test ingress` after installation for target health and application
reachability; configuration generation alone does not prove runtime readiness.

`--proof-live --kube-context <context>` requires activation scope and checks fresh
signer polls. `--require-dstack` with a selected context checks the installed
controller. `--rendered-manifest` checks Kubernetes prerequisites; the RPC and
Reth canary options remain explicit application checks.

## 1. Prepare and reuse the CubeSigner identity

Select an existing CubeSigner role/key in `bridge.cubesigner.identity.roleId`
(and `keyId` when the role contains multiple keys) before `setup plan`. Authenticate
`cs` first; planning reads and freezes the public identity without creating a
provider key or role. New provider identities must be provisioned through the
operator's CubeSigner administration workflow before planning. Existing prepared
identity files are retained when resuming the same deployment directory.

For a saved staged plan, run `setup signer-session --dir .` after `setup render --dir .` and
before `setup upload-secrets --dir .` when running from the deployment directory.
Production mode uses `setup cubesigner-policy prepare-session`, including its
reviewed lifetimes and interrupted-creation journal. Transport mode reuses valid
local files or calls `cubesigner refresh-session` when both files are absent.
Completed session steps are skipped on retry. Rendering
alone no longer creates a remote session. If a provider request failed without a
recorded result, inspect the remote session state before retrying. See the
[staged preparation workflow](spec-preparation.md#commands) for the
complete sequence. `cubesigner refresh-session` remains available for explicit
session recovery; it consumes the prepared identity and does not create keys or
roles.

For optional backup and recovery before archiving/replacing deployment inputs,
use the `cubesigner` maintenance group:

```bash
scrollsdk cubesigner checkpoint --action export \
  --directory .data/private-cubesigner --instance devnet-instance \
  --organization 'Org#YOUR_ORGANIZATION' \
  --signer-api-root https://gamma.signer.cubist.dev --json

# Later, from the same deployment root or a prepared new root:
scrollsdk cubesigner checkpoint --action import \
  --directory .data/private-cubesigner --instance devnet-instance \
  --organization 'Org#YOUR_ORGANIZATION' \
  --signer-api-root https://gamma.signer.cubist.dev --json
```

The checkpoint contains signing credentials. Exclude the directory from version
control. Files are created with mode 0600 in a 0700 directory. Export refuses an
existing output directory; import verifies hashes, instance, signing API origin,
organization, role/key/public key, session expiration and refresh expiration.
Import preserves unrelated config and policy selection, rejects another active
TEE identity, and makes no CubeSigner provider calls. It does not establish that
a locally valid session remains unrevoked. If the signing session is expired,
use `cubesigner refresh-session`; a checkpoint cannot extend its lifetime.

## 2. Generate and check current configuration

Start with the current `scroll-sdk/examples` templates. The WP template uses
current native fields, and `prep-charts` derives the DA batcher allowlist from the
submitter signer. Set `cubesigner.mode` explicitly in the source configuration:
`transport_only` is available on non-mainnet with either `observe` or `enforce`.
WP proof enforcement and CubeSigner proof verification are independent choices.
Use WP's `plain` correctness-policy transport with a `transport_only` signer.
Mainnet requires `production_verifier_key_policy` and matching `policyReceipts`.
The CLI's bundled
devnet DeploymentSpec templates select `transport_only` explicitly. The SDK's
production CubeSigner values retain the production policy posture.

```bash
scrollsdk setup render --dir .
scrollsdk setup deployment-preflight --json
```

By default, `deployment-preflight` checks local configuration. It checks the contract owner signing
configuration, the fixed 42,069,000 sat genesis sequencing output, WP fees, the DA batcher allowlist,
the relationship between chunk gas and genesis block gas, CubeSigner policy
selection, dstack configuration, and the proof deployment contract when proof is
configured. Missing proof receipts/contracts fail; an absent proof configuration
is reported as not-configured. `--proof-scope preparation` checks preparation
evidence only and does not authorize signer installation. The default scope is
activation. `--proof-live` requires an explicit Kubernetes context and cannot
be used with preparation scope. It consumes doge-config and conventional
values/native paths. It does not rewrite configuration, choose a release, inspect
live database schemas or perform database recovery.

Optional runtime probes are described below. Kubernetes operations are read-only;
the signer and Reth probes create disposable local Docker containers.

`setup gen-keystore --accounts` fills an empty owner with the deployer address;
an explicit owner is preserved. Missing local owner signing access is reported
as a warning because externally controlled wallets and multisigs are supported.
Confirm those wallets can sign before deploying. Invalid or zero owner
addresses and locally supplied mismatching keys are errors.

After replacing a Bridge, a hosted CubeSigner policy must be rebuilt and
attached for the new protocol context even in `transport_only` mode. If policy
receipts are supplied, generation checks their release, attachment and current
`.data/protocol_context.json` binding. Without attachment receipts it explicitly
reports remote policy state as unverified; it cannot discover remote policies
from local configuration alone. `transport_only` does not require C2F egress.

## 3. Prepare artifact access outside the CLI

The infrastructure owner prepares archive/proof prefixes and signer-kit delivery
before publication. Use `render-artifact-policy.py` in the CloudFormation pack to
preserve a current complete bucket policy and add a reviewed HTTPS-read grant.
Apply it in the bucket's region using the owner's infrastructure workflow. The
publisher verifies uploaded content but does not edit bucket policies.

## 4. Check signer-host Docker routing

Run on **each Docker signer host**, against the Docker daemon used by Compose:

```bash
scrollsdk signer network-check \
  --cluster-cidr 192.168.0.0/16 \
  --proposed-subnet 10.253.12.0/24 --json
```

Pass the deployment's actual VPC/pod/service IPv4 CIDRs, repeating the flag as
needed. This example is not a universal subnet allocation. The command includes
unused Docker networks: an old network with zero containers can still install a
route that captures EKS replies. It also checks a proposed subnet against all
existing Docker networks. It does not validate IPv6 or every host/VPN route.

Resolve collisions by assigning non-overlapping explicit Compose IPAM. Remove
old networks only after checking ownership and attached containers. The CLI
never deletes networks or restarts partner signers.

## 5. Require and verify the Kubernetes dstack controller

Follow [the dstack controller guide](dstack-controller.md) to import credentials,
prepare its database, generate/upload Secrets and install the separate chart.
Mock proof generation does not require a GPU, but deployments intending to use
the dstack architecture should explicitly include this gate:

```bash
# Require source configuration and generated controller values:
scrollsdk setup deployment-preflight \
  --require-dstack --json

# After controller installation, require its current Deployment to be available:
scrollsdk setup deployment-preflight \
  --require-dstack --kube-context YOUR_EXPLICIT_CONTEXT \
  --namespace default --dstack-deployment dstack-controller --json
```

For the dstack check, without a selected Kubernetes context no Kubernetes calls occur and runtime is reported as
`not-checked`. With it, the command checks updated/available replicas and observed
generation, without mutations. Customize namespace/deployment for chart name
overrides. This is Deployment availability, not provider authentication, GPU
allocation, worker readiness or proof acceptance. Controller installation and
GPU fleet/task submission remain separate actions.

## 6. Opt into cluster, RPC and Reth startup checks

Prepare manifests with `helm template` using the same chart version, namespace
and values planned for installation. Paths passed to `--rendered-manifest` are
relative to `--deployment-dir`. Load authenticated RPC URLs into the named
environment variables through your private configuration; pass only variable
names on the command line.

```bash
scrollsdk setup deployment-preflight --deployment-dir . --json \
  --kube-context YOUR_EXPLICIT_CONTEXT \
  --rendered-manifest rendered/reth.yaml \
  --rendered-manifest rendered/ingress.yaml \
  --ethereum-rpc-env SEPOLIA_RPC_A --ethereum-rpc-env SEPOLIA_RPC_B \
  --ethereum-chain-id 11155111 --ethereum-rpc-quorum 2 \
  --signer-container local-attestation-signer \
  --dogecoin-rpc-env DOGECOIN_RPC_URL \
  --reth-image example.invalid/approved-rollup-node:reviewed-tag
```

Replace the example image with the exact reviewed image. Select only the probes
you need; omitted probes report `not-checked`.

| Flags | Check and limit |
| --- | --- |
| `--rendered-manifest` and `--kube-context` | Per-Pod CPU/memory fit on ready nodes; ALB manifests also require the Load Balancer Controller and TargetGroupBinding CRD. This excludes current utilization, aggregate capacity, taints, affinity and storage topology. |
| `--ethereum-rpc-env`, `--ethereum-chain-id`, `--ethereum-rpc-quorum` | A four-call batch checks chain ID and latest/safe/finalized headers, then compares a shared finalized block across the required number of endpoints. Defaults are Sepolia chain ID 11155111 and quorum 1. This does not test Beacon APIs or ongoing reliability. |
| `--signer-container` and `--dogecoin-rpc-env` | Both flags are required together. Disposable curl calls `getblockchaininfo` from the running signer's network namespace, with credentials on stdin. This checks RPC reachability, not attestation or proof acceptance. |
| `--reth-image` | Starts the selected image with `.data/genesis.json` and a local L1 fixture in two disposable containers with external networking disabled. Requires HTTP startup and a short stability window. It does not test real DA, chain sync or production readiness. |

Docker and the probe images must be available for container checks; missing images
may be pulled. Temporary containers and Reth data are removed after the check.

## 7. Verify CubeSigner activation before installation

The matching SDK Makefile's `install-cubesigner-signer` target invokes this gate
before Helm. To inspect the gate directly after Secret upload:

```bash
scrollsdk setup cubesigner-policy verify-activation --dir . \
  --kube-context YOUR_EXPLICIT_CONTEXT --namespace default \
  --values values/cubesigner-signer-production.yaml \
  --chart oci://ghcr.io/dogeos69/scroll-sdk/helm/cubesigner-signer \
  --chart-version 0.1.9 --json
```

Use the same chart/version, namespace and values as your installation. Provider
read access and Kubernetes access are required; `--session-file` optionally
selects a private management session file. The gate renders the workload, checks
remote key/role/policy/session state and compares delivered Secrets and protocol
context. Non-mainnet `transport_only` must be explicit; production mode requires
expected material bindings, executed attachment and fresh governance evidence,
plus the reviewed runtime-session limits. `--policy-only` checks production
policy without runtime delivery, returns pending activation, and cannot authorize
installation; full activation requires an explicit `--kube-context`. Unknown
attached policies fail even in transport mode. This command does not create sessions, approve policies, install releases,
inspect a running Pod's refresh cache or establish real-proof acceptance.

## 8. Check final contract verification

After Blockscout is available, submit source and require full verification, or
read the final status without resubmitting:

```bash
scrollsdk contracts verify --config-dir . --preinstalls \
  --require-verified --wait-seconds 120
scrollsdk contracts verify --config-dir . --preinstalls --status-only
```

`--preinstalls` includes the required preinstalls alongside business contracts;
use `--preinstalls-only` to restrict the target set. `--status-only` performs no
Docker invocation or submission. Both status modes fail if any selected target
is partial, pending or unavailable; only full verification passes. The optional
polling window defaults to zero and is limited to 600 seconds. Without either
status flag, successful submission reports final status as `not-checked`.
Block-hash history has no Solidity source and remains a separate bytecode check.

### Capacity Manager diagnostics

For a rendered spec selecting `capacityManager`, use these separate runtime
commands. Select `--kube-context` explicitly; `--namespace` defaults to the prepared
target and `--deployment-dir` defaults to the current directory:

- `scrollsdk capacity-manager status --kube-context YOUR_CONTEXT` reads Deployment replicas and recent reconcile log
  evidence. Raw logs are omitted; GPU allocation and proof acceptance remain
  unverified.
- `scrollsdk capacity-manager probe --kube-context YOUR_CONTEXT` creates and deletes a temporary Pod using manager
  labels and existing Secret references. It checks DNS, dstack TLS/project/backend
  access and WP capacity API access, without fleet or Worker mutations. The local
  CLI never reads Secret values. This command explicitly opts into creating the probe Pod.

Results are returned by the runtime command, separately from deployment preflight.
A failed check exits unsuccessfully. Fleet creation belongs to the manager chart's initialization
Job during installation/upgrade; diagnostics do not initialize fleets.
