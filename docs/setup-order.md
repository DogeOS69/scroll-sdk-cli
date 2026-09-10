# CLI setup order

This guide describes the dependency order of the CLI setup commands for a new
DogeOS instance with native Reth genesis. Run them from your deployment directory
with the current built/installed CLI and matching release inputs. It is not an
infrastructure bootstrap script or evidence of production deployment acceptance.
Provision the RPC endpoints, Kubernetes infrastructure, DNS, signer access and
storage required by your chosen deployment separately.

See [Local setup-order validation](setup-order-validation.md) for executed checks,
findings and the cloud/proof/runtime steps that remain unverified.

Bridge initialization uses **`scrollsdk setup bridge-init`** with the configured
Dogecoin network's actual funding and confirmation process.

## 1. Prepare configuration and identities

Prepare the deployment layout before running setup. A lone `config.toml` is not
sufficient for chart preparation. Use the matching `scroll-sdk` release's
`examples/values/`, `examples/withdrawal-processor/` and
`examples/proof-coordinator/` as the starting templates, and supply the
deployment's reviewed `Makefile`. Keep the native TOML files at
`withdrawal-processor/WithdrawalProcessor.toml` and
`proof-coordinator/ProofCoordinator.toml`. `prep-charts` updates those files;
it does not bootstrap all application templates from an empty directory.
Select the services, node counts and chart versions in the Makefile for this
deployment; historical SDK Makefile examples may still contain retired targets.
Copy templates only when creating the directory, before generating identities
or artifacts, so later copies do not overwrite generated values.

Start from `scroll-contracts/docker/templates/config.toml` and fill the required
environment inputs, including an explicit `accounts.OWNER_ADDR`. See
[Configuration cleanup](config-cleanup.md) for supported fields and image pins.
Configure the following before generating genesis or initializing Bridge:

| Inputs | Commands | Dependency |
| --- | --- | --- |
| Deployment/activity accounts | `scrollsdk setup gen-keystore` | Explicit owner; this does not generate Reth node identities. |
| Dogecoin RPC, Ethereum DA and domains | `scrollsdk setup doge-config`, then `scrollsdk setup domains` | Use the intended network and service endpoints. |
| Application signers | `scrollsdk setup eth-da-submitter`; `scrollsdk setup fee-oracle` | Select local or AWS KMS signing in each command. Configure DA archive settings; the fee oracle public address is needed for genesis. |
| Reth node identities | `scrollsdk setup l2-sequencer-reth --index 0`; `scrollsdk setup l2-bootnode-reth` | Configure additional instances as needed; see [Pure Reth configuration](reth-only-peers.md). |
| Attestation signer inputs | Each signer operator runs `scrollsdk signer init --id <id> --network <network> --endpoint <url>` on their own infrastructure, then the bridge operator runs `scrollsdk setup attestation-signer` | Collect the public descriptors in `descriptors/` or pass `--descriptor` for each file. This signer identity flow is independent of DA/Fee Oracle KMS provisioning. |
| TEE identity and session | `scrollsdk setup cubesigner-init`, then `scrollsdk setup cubesigner-refresh` | Use the intended CubeSigner environment and identity lifecycle; gamma is not a universal requirement. |

These are configuration tasks, not a script to rerun blindly on an existing
instance. Select the signer backends and instance counts for your environment.
Prepare matching proof image tools/material inputs for the selected release;
Bridge-bound real materials must be completed after protocol context exists.

For non-interactive commands, pass `-N --json` only where supported and supply
the required flags. `attestation-signer` and `signer init` use explicit inputs
and `--json`, without `-N`. CubeSigner setup requires a prior `cs login`;
`cubesigner-init -N` requires `--doge-config` and either `--roles` or
`--new --role-prefix`. `cubesigner-refresh -N` also requires `--doge-config`.

After `setup domains`, verify the RPC endpoints used by both the operator and
the service network. In regtest, domains projects the public Dogecoin ingress
URL into `doge-config.rpc.url` and `setup_defaults.toml.dogecoin_rpc_url`.
If using a directly reachable local RPC instead, configure that endpoint before
Bridge setup. It must also be reachable from the Bridge tools container.

## 2. Generate native L2 genesis

```bash
scrollsdk setup gen-l2-artifacts
```

The generator, deployer and verification images use `gen-configs-<revision>`,
`deploy-<revision>` and `verify-<revision>` with the same full contracts revision.
Choose a new deployment salt for a new instance. This produces
`values/genesis.yaml`, which Bridge preparation consumes.

For local contract development, use `--contracts-source /path/to/scroll-contracts`
instead of building the generator Docker image. This option applies to contract
artifact generation; Bridge initialization still uses its own tools image.

## 3. Initialize Bridge using the CLI

```bash
scrollsdk setup bridge-init
```

Select the Bridge tools image matching the intended core release with
`--image-tag` or the interactive prompt. This is a
`dogeos69/bridge-genesis-tools` tag, not a contracts `gen-configs-*` tag.
The command's default `--step all` executes these stages in order:

| Stage | Explicit command | Purpose |
| --- | --- | --- |
| 1 | `scrollsdk setup bridge-init --step 1-prepare` | Extract genesis and prepare protocol seed inputs. |
| 2 | `scrollsdk setup bridge-init --step 2-setup` | Generate setup outputs and broadcast the setup transaction. |
| 3 | `scrollsdk setup bridge-init --step 3-bridge-info` | Generate namespace and Bridge information. |
| 4 | `scrollsdk setup bridge-init --step 4-fund` | Broadcast the configured funding and/or deposit-seed transactions. |
| 5 | `scrollsdk setup bridge-init --step 5-protocol-context` | Generate protocol context for downstream services. |

Use either the full command or the individual stages, not both in succession.
When executing stages separately, use the same selected image tag throughout.
Non-interactive preparation requires `--seed`; preserve the instance's seed and
outputs privately. Setup and funding stages broadcast transactions and are not
idempotent. Resume from the appropriate stage after inspecting existing outputs
and transactions, rather than restarting the full initialization.

Provide valid funding inputs and satisfy the selected network's confirmation
requirements. Bridge outputs, including `.data/protocol_context.json`, must exist
before preparing dependent service values and Secrets.
The funding inputs are `base_funding_utxos` in `.data/setup_defaults.toml`; replace
the template placeholders with confirmed, unspent outputs controlled by the
helper derived from this instance's seed. Ethereum DA height discovery uses a
temporary Kubernetes curl pod, so configure access to the intended cluster as
well as its reachable Ethereum execution RPC. The CLI's fresh Ethereum devnet
fallback to start block zero is not a successful cluster/RPC check.

## 4. Prepare proof and service configuration

Follow the [Proof operator runbook](proof-operator-runbook.md) for the selected
proof mode. For AWS storage, its dependency order is:

```text
eth-da-submitter archive configuration
  → setup proof-aws-init
  → setup proof-materials
  → setup doge-config --proof-topology
```

Reuse existing material receipts only when they match the release and instance
inputs. Real proof materials require the Bridge context and baking process
described in [Proof material preparation](proof-materials.md).
`proof-aws-init` requires the enabled canonical Ethereum DA S3 archive first;
it does not create the archive configuration from nothing. Non-interactive
`proof-materials --generation mock` requires explicit `--compiler-image` and
`--mock-worker-image` from the matching release. A skipped or failed proof setup
does not qualify the later policy export or `proof-config-check` to succeed:
configure an explicit topology even when the selected proof mode is disabled.

After all required Bridge and service signer inputs are ready:

```bash
scrollsdk setup prep-charts
scrollsdk setup gen-secrets
scrollsdk setup export-signer-policy
scrollsdk setup proof-config-check
```

Wait for `prep-charts` to finish before exporting the signer policy. If ingress
TLS is needed, run `scrollsdk setup tls` against the generated values and review
the final configuration before deployment. TSO and active Proof Coordinator
ingress use `TSO_HOST` and `PROOF_COORDINATOR_HOST`; see the
[ingress configuration notes](config-cleanup.md#active-ingress-hosts).

For Blockscout, run `scrollsdk setup db-init` only when its database or permissions
need initialization, before generating its Secrets and deploying it.
`BLOCKSCOUT_DB_CONNECTION_STRING` is the only retained database setting.

For external Reth/RPC nodes, run `scrollsdk setup bootnode-public-p2p` after
`prep-charts` creates the indexed bootnode values and before deploying those
bootnode releases. Identity generation alone does not enable public P2P.
The AWS command requires the cluster name and region; use
`--skip-controller-setup` when the controller is already managed by the
environment. See [Reth bootnode public P2P access](bootnode-public-p2p.md) for
the full command, controller setup and deployment boundary.

## 5. Upload and deploy

Selectively upload the required Secrets with `scrollsdk setup push-secrets`,
using the intended backend, AWS region and prefix where applicable. The order is
`prep-charts` → `gen-secrets` → selective `push-secrets`. Follow the proof AWS
runbook for separately managed proof tokens.

Apply the reviewed Helm values through the deployment environment's rollout
procedure: core configuration and nodes, contracts, dependent services, and
partner signer handoff. Complete the signer handoff before enabling Withdrawal
Processor proposals for the new protocol. Mock proof generation is internal to
Proof Coordinator; it does not require a separate mock worker.

Where genesis hold is enabled, release it with the environment's `start-l1-sync`
operation after service/signer readiness, then verify synchronization, L2
progress, DA and ingress. Configuration generation and static proof checks alone
do not establish runtime readiness or transaction/proof acceptance.

After public bootnode Services have usable LoadBalancer endpoints, run
`scrollsdk setup gen-rpc-package --dogeos-rpc-package-dir /path/to/dogeos-rpc-package
--namespace YOUR_NAMESPACE` from this deployment directory using the intended
cluster's kubeconfig. Then start and verify the external RPC node. Public P2P
values preparation does not itself deploy the bootnodes or establish peering.

## Existing instances

For configuration cleanup on an existing instance, follow
[Updating an existing deployment directory](config-cleanup.md#updating-an-existing-deployment-directory).
Do not recreate identities, genesis or Bridge as part of a configuration refresh.
