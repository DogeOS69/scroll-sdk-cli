# Scroll SDK CLI


For an attestation-signer rotation, download the proposal's rotation export
(`dogeos/rotation-export/v1`) from the governance portal, then, from the
deployment directory:

1. `scrollsdk bridge rotation register <export>`: merges every current and
   target signer into the WP `tsoSigners` (never removes one), renders the
   chart with `helm template` before writing, installs the WP and waits until
   the WP reports every key as registered. Re-running it is a no-op.
2. `scrollsdk bridge rotation online <export>`: passes when every target
   signer, and at least M of the live current signers, polled the TSO in the
   last 60 seconds. It is point-in-time and proves only an authenticated
   poll: not the release, enforce mode, RPC or key-backend health, the old
   signers' allowlist entry, or real signing. A deferred WP dispatch happens
   later without another check.
3. Fund the liveness output. The RotateKey spends one extra input that only the
   target signers can sign, which proves the new set is live. Pay at least
   1 DOGE to the export's `target.p2sh_address`, in a transaction that is not a
   deposit and whose only OP_RETURN is the zero-value bridge-funding marker
   `6a 49 01` followed by 72 zero bytes. Wait for the deposit confirmation
   depth. (A CLI command for this step is still to come.)
4. `scrollsdk bridge rotation send <export> --liveness-outpoint <txid>:<vout> --preview`:
   the same checks, then a non-durable WP build. The WP validates the outpoint
   over Dogecoin RPC; a rejection (HTTP 422) is printed with the WP's reason.
   `send <export> --liveness-outpoint <txid>:<vout>` submits once (`/propose`).
   A new intent needs `--liveness-outpoint`. Re-running `send` reports the
   stored intent and its outpoint instead of resubmitting.

Each command first checks the export against itself and the WP deployment
(`protocol_instance_id` and network), and rejects an export where any key holds
different roles (attestation, TEE, recovery) across the current and target
scripts. `register` and a new `send` also require the live bridge to still be
the export's current bridge. Signer operators use
the standalone Docker kit; they do not need this CLI.

Generated WP signer entries and proof bridge configuration use `mainnet`,
`testnet` or `regtest` and require Core with
[DogeOS69/dogeos-core#1627](https://github.com/DogeOS69/dogeos-core/pull/1627).
Coordinate the CLI and Core upgrade before regenerating or registering signers.
Rotation identity checks also accept older WP status responses using `dogecoin`
as the mainnet alias; this does not make new generated configuration compatible
with older Core binaries. Retained signer entries are normalized to `mainnet`.
Bridge-genesis helper inputs retain the `dogecoin` alias for pinned older tools;
Core #1627 still accepts that input alias. `bitcoin` is not a Dogecoin network.

Current configuration and migration procedure: [Pure Reth configuration and retired services](docs/config-cleanup.md).

[![Twitter Follow](https://img.shields.io/twitter/follow/Scroll_ZKP?style=social)](https://twitter.com/Scroll_ZKP)
[![Discord](https://img.shields.io/discord/984015101017346058?color=%235865F2&label=Discord&logo=discord&logoColor=%23fff)](https://discord.gg/scroll)

## Introduction

A tool for configuring, managing, and testing [Scroll SDK](https://docs.scroll.io/en/sdk/) deployments.

### Other Scroll SDK Repos

- [Scroll SDK](https://www.github.com/scroll-tech/scroll-sdk)
- [Scroll Proving SDK](https://www.github.com/scroll-tech/scroll-proving-sdk)

[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/@scroll-tech/scroll-sdk-cli.svg)](https://www.npmjs.com/package/@scroll-tech/scroll-sdk-cli)
[![Downloads/week](https://img.shields.io/npm/dw/scroll-sdk-cli.svg)](https://www.npmjs.com/package/@scroll-tech/scroll-sdk-cli)

<!-- toc -->
* [Scroll SDK CLI](#scroll-sdk-cli)
* [Installation](#installation)
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->

# Installation

<!-- installation -->

Install the published CLI:

```bash
npm install --global @scroll-tech/scroll-sdk-cli
scrollsdk --help
```

For repository development:

```bash
yarn install
yarn build
bin/run.js --help
```
<!-- installationstop -->

## Documentation

- [核心服务配置（中文）](docs/service-config-runbook.zh.md) — 当前 signer、Bridge、proof 与服务部署流程。
- [Branch integration decisions](docs/branch-integration.md) — resolutions for the v0.3.0 branch consolidation.

- [CubeSigner preparation and activation](docs/cubesigner-preparation.md) — expected configuration before approval, exact governance handoff, credential deferral and guarded installation.
- [Staged spec preparation](docs/spec-preparation.md) — plan plus twelve resumable stages, local genesis, funding handoffs and explicit Secret upload.
- [CLI setup order](docs/setup-order.md) — configuration prerequisites, native Reth genesis, `scrollsdk setup bridge-init`, service configuration and deployment handoff. Start here for command order.
- [Existing ALBs](docs/existing-alb.md) — select ALB/listener/target-group references in spec, verify them, and retain AWS edges when uninstalling Helm releases.
- [Configuration cleanup](docs/config-cleanup.md) — supported template fields, matching contracts images and updating an existing deployment.
- [Pure Reth configuration](docs/reth-only-peers.md) — Reth node identities and peer configuration.
- [Reth bootnode public P2P access](docs/bootnode-public-p2p.md) — spec-driven independent NLB bindings, read-only AWS discovery and public enode export.
- [Deployment signing identities](docs/keystore.md) — unified Reth and service
  key preparation, KMS reuse, and archive configuration.

- [Deployment preparation and checks](docs/deployment-preflight.md) —
  current configuration validation, optional `cubesigner checkpoint` backup/recovery, current-prefix S3/IAM
  grants, signer Docker network checks, optional cluster/RPC/Reth probes, CubeSigner activation and final contract verification.

- [dstack controller operator guide](docs/dstack-controller.md) — Vast.ai/GCP
  credential import, PostgreSQL/SQLite configuration, generated production values,
  Secret upload scope, and a temporary-directory configuration-only walkthrough
  that does not deploy services or request cloud resources.
- [CubeSigner and proof configuration generation design](docs/cubesigner-proof-configuration-design.md)
  — audited policy/proof provenance gaps, receipt-backed configuration,
  provider-neutral Worker handoff, validation rules, and implementation phases.
- [Fresh devnet redeployment acceptance](docs/devnet-fresh-redeployment.md) — current operator decision: new independent CubeSigner role/key, new Bridge and fresh L2; preserve all existing policies and Kubernetes resources not deployed by this agent.
- [L1 Interface beta.4e cold start](docs/l1-interface-beta4e-cold-start.md) — required fresh-instance opt-in, isolated storage and verified Kubernetes rollout.
- [New Bridge / native Reth devnet runbook](docs/devnet-new-bridge-20260909.md) — verified 2026-09-09 steps, manual edits, release pins and the remaining runtime blocker.
- [Monitoring account balances](docs/monitoring-balances.md) — `prep-charts`
  generation for fee-oracle on L2, eth-da-submitter on Ethereum DA, and fee-wallet
  UTXO thresholds, including canonical signer validation and Secret-owned RPCs.
- [Legacy contracts placeholder compatibility](docs/contracts-placeholder-compatibility.md)
  — isolate a real DA service signer from legacy contracts account validation
  in explicitly selected DogeOS testnet/regtest L2-only deployments.
- [DogeOS proof operator runbook](docs/proof-operator-runbook.md) — the single
  operator workflow for two-switch proof services, partner handoff, and
  mock/real/enforcement activation.
- [Proof material preparation](docs/proof-materials.md) — local
  `scroll-zkvm-prover`/dogeos-core derivation, Bridge bake, validation, and the
  CLI-owned material receipt.
- [Native proof image tools](docs/proof-image-tools.md) — invoke pinned CPU
  tools, export materializers/identities, and reject placeholder Batch identities
  before real-materialization activation.
- [Real-proof release handoff](docs/proof-release-workflow.md) — capture one
  native preparation receipt, validate the CUDA Worker image, import real
  materials, and plan/apply the content-addressed 11-file publication.
- [CLI automation reference](docs/automation.md) — `--non-interactive`, JSON,
  environment references, retries, and secret handling; it does not define
  deployment order.
- [Ethereum DA S3 archive reference](docs/ethereum-da-s3.md) — S3 upload and
  public readback configuration.
- [Partner attestation-signer kit](https://github.com/dogeos69/scroll-sdk/tree/v0.3.0-develop/partner-kit/attestation-signer)
  — the generic manual for signer operators. They import the deployment's
  published `deployment-kit-<version>/` with the manifest SHA-256 from its
  governance record.

### Development environment references

These documents describe a specific devnet/Shadowfork environment or historical
deployment evidence. Their CubeSigner gamma settings and cluster identifiers
are not general setup requirements.
The command reference below lists commands; it does not define execution order.

- [Fresh devnet redeployment acceptance](docs/devnet-fresh-redeployment.md) — environment-specific replacement decisions and recorded acceptance work.
- [L1 Interface beta.4e cold start](docs/l1-interface-beta4e-cold-start.md) — version-specific fresh-instance configuration and recorded Kubernetes rollout.
- [New Bridge / native Reth devnet runbook](docs/devnet-new-bridge-20260909.md) — recorded 2026-09-09 steps, manual edits, release pins and runtime blocker.
- [DogeOS deployment status and runbook corrections](docs/dogeos-deployment-status.md) — historical devnet progress and corrections; not a completed general deployment manual.

# Usage

<!-- usage -->
```sh-session
$ npm install -g @scroll-tech/scroll-sdk-cli
$ scrollsdk COMMAND
running command...
$ scrollsdk (--version)
@scroll-tech/scroll-sdk-cli/0.1.3 linux-x64 node-v22.19.0
$ scrollsdk --help [COMMAND]
USAGE
  $ scrollsdk COMMAND
...
```
<!-- usagestop -->

# Commands

<!-- commands -->
* [`scrollsdk artifacts access`](#scrollsdk-artifacts-access)
* [`scrollsdk bridge rotation online EXPORT`](#scrollsdk-bridge-rotation-online-export)
* [`scrollsdk bridge rotation register EXPORT`](#scrollsdk-bridge-rotation-register-export)
* [`scrollsdk bridge rotation send EXPORT`](#scrollsdk-bridge-rotation-send-export)
* [`scrollsdk capacity-manager [ACTION]`](#scrollsdk-capacity-manager-action)
* [`scrollsdk check prerequisites`](#scrollsdk-check-prerequisites)
* [`scrollsdk contracts verify`](#scrollsdk-contracts-verify)
* [`scrollsdk cubesigner checkpoint`](#scrollsdk-cubesigner-checkpoint)
* [`scrollsdk cubesigner refresh-session`](#scrollsdk-cubesigner-refresh-session)
* [`scrollsdk doge wallet new`](#scrollsdk-doge-wallet-new)
* [`scrollsdk doge wallet send`](#scrollsdk-doge-wallet-send)
* [`scrollsdk doge wallet sync`](#scrollsdk-doge-wallet-sync)
* [`scrollsdk help [COMMAND]`](#scrollsdk-help-command)
* [`scrollsdk helper activity`](#scrollsdk-helper-activity)
* [`scrollsdk helper clear-accounts`](#scrollsdk-helper-clear-accounts)
* [`scrollsdk helper derive-enode NODEKEY`](#scrollsdk-helper-derive-enode-nodekey)
* [`scrollsdk helper fund-accounts`](#scrollsdk-helper-fund-accounts)
* [`scrollsdk helper recovery-key`](#scrollsdk-helper-recovery-key)
* [`scrollsdk helper set-scalars`](#scrollsdk-helper-set-scalars)
* [`scrollsdk monitoring status-page`](#scrollsdk-monitoring-status-page)
* [`scrollsdk plugins`](#scrollsdk-plugins)
* [`scrollsdk plugins add PLUGIN`](#scrollsdk-plugins-add-plugin)
* [`scrollsdk plugins:inspect PLUGIN...`](#scrollsdk-pluginsinspect-plugin)
* [`scrollsdk plugins install PLUGIN`](#scrollsdk-plugins-install-plugin)
* [`scrollsdk plugins link PATH`](#scrollsdk-plugins-link-path)
* [`scrollsdk plugins remove [PLUGIN]`](#scrollsdk-plugins-remove-plugin)
* [`scrollsdk plugins reset`](#scrollsdk-plugins-reset)
* [`scrollsdk plugins uninstall [PLUGIN]`](#scrollsdk-plugins-uninstall-plugin)
* [`scrollsdk plugins unlink [PLUGIN]`](#scrollsdk-plugins-unlink-plugin)
* [`scrollsdk plugins update`](#scrollsdk-plugins-update)
* [`scrollsdk rpc export`](#scrollsdk-rpc-export)
* [`scrollsdk setup aws`](#scrollsdk-setup-aws)
* [`scrollsdk setup bridge-funding`](#scrollsdk-setup-bridge-funding)
* [`scrollsdk setup cubesigner-policy build`](#scrollsdk-setup-cubesigner-policy-build)
* [`scrollsdk setup cubesigner-policy deploy`](#scrollsdk-setup-cubesigner-policy-deploy)
* [`scrollsdk setup cubesigner-policy handoff`](#scrollsdk-setup-cubesigner-policy-handoff)
* [`scrollsdk setup cubesigner-policy import`](#scrollsdk-setup-cubesigner-policy-import)
* [`scrollsdk setup cubesigner-policy import-acceptance`](#scrollsdk-setup-cubesigner-policy-import-acceptance)
* [`scrollsdk setup cubesigner-policy prepare`](#scrollsdk-setup-cubesigner-policy-prepare)
* [`scrollsdk setup cubesigner-policy prepare-input`](#scrollsdk-setup-cubesigner-policy-prepare-input)
* [`scrollsdk setup cubesigner-policy prepare-runtime-secrets`](#scrollsdk-setup-cubesigner-policy-prepare-runtime-secrets)
* [`scrollsdk setup cubesigner-policy prepare-session`](#scrollsdk-setup-cubesigner-policy-prepare-session)
* [`scrollsdk setup cubesigner-policy reconcile`](#scrollsdk-setup-cubesigner-policy-reconcile)
* [`scrollsdk setup cubesigner-policy resolver`](#scrollsdk-setup-cubesigner-policy-resolver)
* [`scrollsdk setup cubesigner-policy verify-activation`](#scrollsdk-setup-cubesigner-policy-verify-activation)
* [`scrollsdk setup deployment-preflight`](#scrollsdk-setup-deployment-preflight)
* [`scrollsdk setup genesis`](#scrollsdk-setup-genesis)
* [`scrollsdk setup plan`](#scrollsdk-setup-plan)
* [`scrollsdk setup policy-prepare`](#scrollsdk-setup-policy-prepare)
* [`scrollsdk setup proof-materials`](#scrollsdk-setup-proof-materials)
* [`scrollsdk setup proof-publish`](#scrollsdk-setup-proof-publish)
* [`scrollsdk setup protocol-context`](#scrollsdk-setup-protocol-context)
* [`scrollsdk setup render`](#scrollsdk-setup-render)
* [`scrollsdk setup signer-kit`](#scrollsdk-setup-signer-kit)
* [`scrollsdk setup signer-kit-publish`](#scrollsdk-setup-signer-kit-publish)
* [`scrollsdk setup signer-session`](#scrollsdk-setup-signer-session)
* [`scrollsdk setup upload-secrets`](#scrollsdk-setup-upload-secrets)
* [`scrollsdk signer init`](#scrollsdk-signer-init)
* [`scrollsdk signer kms-pubkey`](#scrollsdk-signer-kms-pubkey)
* [`scrollsdk signer network-check`](#scrollsdk-signer-network-check)
* [`scrollsdk signer preflight`](#scrollsdk-signer-preflight)
* [`scrollsdk test contracts`](#scrollsdk-test-contracts)
* [`scrollsdk test dependencies`](#scrollsdk-test-dependencies)
* [`scrollsdk test dogeos [CASENAME]`](#scrollsdk-test-dogeos-casename)
* [`scrollsdk test e2e`](#scrollsdk-test-e2e)
* [`scrollsdk test ingress`](#scrollsdk-test-ingress)

## `scrollsdk artifacts access`

Plan, explicitly apply, or check the DA archive or bootstrap snapshot bucket: versioning, the keep-forever retention lifecycle rule, TLS-only, a read statement for the cluster's S3 VPC endpoint, an optional public read statement (the DA kill switch), and the writer role's IAM grant. Statements with other Sids are preserved. The proof artifact bucket is managed by setup aws.

```
USAGE
  $ scrollsdk artifacts access --store da|snapshot [--allow-bucket-public-policy] [--apply | --check] [--aws-profile
    <value>] [--deployment-dir <value>] [--doge-config <value>] [--json] [--proof-aws-config <value>] [--public-read]
    [--vpc-endpoint-id <value>] [--writer-role-arn <value>]

FLAGS
  --allow-bucket-public-policy  Explicitly allow bucket public policies for --public-read; retain blocked ACLs and
                                account-level protections
  --apply                       Apply the displayed changes and verify AWS readback
  --aws-profile=<value>         AWS CLI profile
  --check                       Fail if the bucket policy, versioning or retention lifecycle differ from the requested
                                state or writer IAM simulation denies access; no writes
  --deployment-dir=<value>      [default: .] Deployment root
  --doge-config=<value>         [default: .data/doge-config.toml] doge-config holding ethereumDa.blobArchive.s3,
                                proofArtifacts.s3 and snapshots.s3
  --json
  --proof-aws-config=<value>    [default: .data/proof-aws.json] proof-aws-init output; its S3 Gateway VPC endpoint is
                                reused when --vpc-endpoint-id is omitted
  --[no-]public-read            Add (--public-read) or remove (--no-public-read) the anonymous GetObject statement;
                                omitted leaves it unchanged. Removing it on the DA archive is the kill switch: our
                                services keep reading through the VPC endpoint
  --store=<option>              (required) Bucket to manage
                                <options: da|snapshot>
  --vpc-endpoint-id=<value>     S3 Gateway VPC endpoint the cluster reads through (same region as the bucket)
  --writer-role-arn=<value>     The only writer: the eth-da-submitter IRSA role (da) or the deploy role (snapshot); its
                                trust and other policies are preserved

DESCRIPTION
  Plan, explicitly apply, or check the DA archive or bootstrap snapshot bucket: versioning, the keep-forever retention
  lifecycle rule, TLS-only, a read statement for the cluster's S3 VPC endpoint, an optional public read statement (the
  DA kill switch), and the writer role's IAM grant. Statements with other Sids are preserved. The proof artifact bucket
  is managed by setup aws.

EXAMPLES
  $ scrollsdk artifacts access --store da --public-read --writer-role-arn arn:aws:iam::123456789012:role/eth-da-submitter --apply

  $ scrollsdk artifacts access --store da --no-public-read --apply

  $ scrollsdk artifacts access --store snapshot --writer-role-arn arn:aws:iam::123456789012:role/deploy --apply
```

_See code: [src/commands/artifacts/access.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/artifacts/access.ts)_

## `scrollsdk bridge rotation online EXPORT`

Check that every target signer and at least M live current signers polled the TSO in the last 60 seconds; read-only

```
USAGE
  $ scrollsdk bridge rotation online EXPORT [--context <value>] [--dir <value>] [--namespace <value>] [--wp-url <value>]
    [--tso-url <value>]

ARGUMENTS
  EXPORT  dogeos/rotation-export/v1 JSON downloaded from the governance portal

FLAGS
  --context=<value>    Kubernetes context; default: the deployment spec EKS cluster, else the current context
  --dir=<value>        [default: .] Deployment directory (or its parent with runtime/ or deployment/)
  --namespace=<value>  Kubernetes namespace; default: the deployment spec namespace, else default
  --tso-url=<value>    HTTPS or loopback TSO URL serving /metrics; default: a temporary kubectl port-forward
  --wp-url=<value>     HTTPS or loopback WP URL; default: a temporary kubectl port-forward

DESCRIPTION
  Check that every target signer and at least M live current signers polled the TSO in the last 60 seconds; read-only

EXAMPLES
  $ scrollsdk bridge rotation online ./rotation-export.json --dir ./deployment
```

_See code: [src/commands/bridge/rotation/online.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/bridge/rotation/online.ts)_

## `scrollsdk bridge rotation register EXPORT`

Register every current and target signer of a rotation export with the WP/TSO (merge only, rendered with helm template before any write); never submits a rotation

```
USAGE
  $ scrollsdk bridge rotation register EXPORT [--context <value>] [--dir <value>] [--namespace <value>] [--wp-url <value>]
    [--wait-seconds <value>]

ARGUMENTS
  EXPORT  dogeos/rotation-export/v1 JSON downloaded from the governance portal

FLAGS
  --context=<value>       Kubernetes context; default: the deployment spec EKS cluster, else the current context
  --dir=<value>           [default: .] Deployment directory (or its parent with runtime/ or deployment/)
  --namespace=<value>     Kubernetes namespace; default: the deployment spec namespace, else default
  --wait-seconds=<value>  [default: 300] How long to wait for the WP to report every key as registered
  --wp-url=<value>        HTTPS or loopback WP URL; default: a temporary kubectl port-forward

DESCRIPTION
  Register every current and target signer of a rotation export with the WP/TSO (merge only, rendered with helm template
  before any write); never submits a rotation

EXAMPLES
  $ scrollsdk bridge rotation register ./rotation-export.json --dir ./deployment
```

_See code: [src/commands/bridge/rotation/register.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/bridge/rotation/register.ts)_

## `scrollsdk bridge rotation send EXPORT`

Submit the rotation export to the WP once (POST /propose), or report the intent already stored under its idempotency key; --preview only builds (POST /build) and stores nothing

```
USAGE
  $ scrollsdk bridge rotation send EXPORT [--context <value>] [--dir <value>] [--namespace <value>] [--wp-url <value>]
    [--tso-url <value>] [--liveness-outpoint <value>] [--preview]

ARGUMENTS
  EXPORT  dogeos/rotation-export/v1 JSON downloaded from the governance portal

FLAGS
  --context=<value>            Kubernetes context; default: the deployment spec EKS cluster, else the current context
  --dir=<value>                [default: .] Deployment directory (or its parent with runtime/ or deployment/)
  --liveness-outpoint=<value>  Required for a new intent: <txid>:<vout> of a confirmed output of at least 1 DOGE paying
                               the target P2SH address, from a transaction carrying the bridge-funding marker OP_RETURN
  --namespace=<value>          Kubernetes namespace; default: the deployment spec namespace, else default
  --preview                    Run every check and POST /build only; never /propose
  --tso-url=<value>            HTTPS or loopback TSO URL serving /metrics; default: a temporary kubectl port-forward
  --wp-url=<value>             HTTPS or loopback WP URL; default: a temporary kubectl port-forward

DESCRIPTION
  Submit the rotation export to the WP once (POST /propose), or report the intent already stored under its idempotency
  key; --preview only builds (POST /build) and stores nothing

EXAMPLES
  $ scrollsdk bridge rotation send ./rotation-export.json --dir ./deployment --liveness-outpoint <txid>:<vout> --preview

  $ scrollsdk bridge rotation send ./rotation-export.json --dir ./deployment --liveness-outpoint <txid>:<vout>
```

_See code: [src/commands/bridge/rotation/send.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/bridge/rotation/send.ts)_

## `scrollsdk capacity-manager [ACTION]`

Inspect the installed Capacity Manager or probe its dependencies; GPU worker lifecycle is owned by the Core controller

```
USAGE
  $ scrollsdk capacity-manager [ACTION] --kube-context <value> [--deployment-dir <value>] [--json] [--namespace
    <value>]

ARGUMENTS
  [ACTION]  (status|probe) [default: status] status reads runtime evidence; probe creates and removes a temporary
            dependency-check Pod

FLAGS
  --deployment-dir=<value>  [default: .] Prepared deployment directory
  --json
  --kube-context=<value>    (required) Explicit Kubernetes context; must match the prepared target when recorded
  --namespace=<value>       Namespace; defaults to the prepared target and must match it

DESCRIPTION
  Inspect the installed Capacity Manager or probe its dependencies; GPU worker lifecycle is owned by the Core controller

EXAMPLES
  $ scrollsdk capacity-manager status --kube-context my-cluster

  $ scrollsdk capacity-manager probe --deployment-dir deployment --kube-context my-cluster
```

_See code: [src/commands/capacity-manager.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/capacity-manager.ts)_

## `scrollsdk check prerequisites`

Check that all required prerequisites are installed and configured

```
USAGE
  $ scrollsdk check prerequisites [--json] [-v]

FLAGS
  -v, --verbose  Show detailed output for each check
      --json     Output in JSON format (stdout for data, stderr for logs)

DESCRIPTION
  Check that all required prerequisites are installed and configured

EXAMPLES
  $ scrollsdk check prerequisites

  $ scrollsdk check prerequisites --json

  $ scrollsdk check prerequisites --verbose
```

_See code: [src/commands/check/prerequisites.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/check/prerequisites.ts)_

## `scrollsdk contracts verify`

Submit deployed contract sources for explorer verification or inspect verification status

```
USAGE
  $ scrollsdk contracts verify [--config-dir <value>] [--image-tag <value>] [--preinstalls | --preinstalls-only]
    [--preinstalls-image <value>] [--require-verified] [--status-only] [--wait-seconds <value>]

FLAGS
  --config-dir=<value>         [default: .] Directory containing config.toml and contract verification artifacts
  --image-tag=<value>          Specify the Docker image tag to use
  --preinstalls                Also submit preinstalls sources to the configured L2 Blockscout v2 API
  --preinstalls-image=<value>  Preinstalls image matching the deployed release (default: dogeos69/preinstalls:v0.2.2)
  --preinstalls-only           Only submit preinstalls sources; skip the DogeOS contracts verifier
  --require-verified           Fail unless every selected target has full Blockscout verification; submission success is
                               insufficient
  --status-only                Read final Blockscout source-verification status without submitting or running Docker
  --wait-seconds=<value>       Bounded polling window for --status-only or --require-verified

DESCRIPTION
  Submit deployed contract sources for explorer verification or inspect verification status

EXAMPLES
  $ scrollsdk contracts verify

  $ scrollsdk contracts verify --image-tag verify-v0.2.0-debug

  $ scrollsdk contracts verify --preinstalls --config-dir ./deployment

  $ scrollsdk contracts verify --preinstalls-only --preinstalls-image dogeos69/preinstalls:v0.2.1
```

_See code: [src/commands/contracts/verify.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/contracts/verify.ts)_

## `scrollsdk cubesigner checkpoint`

Export/import a private, instance-bound checkpoint of an existing CLI-created CubeSigner identity and signing session without management login or provider mutations

```
USAGE
  $ scrollsdk cubesigner checkpoint --action export|import --directory <value> --instance <value> --organization <value>
    --signer-api-root <value> [--deployment-dir <value>] [--json]

FLAGS
  --action=<option>          (required)
                             <options: export|import>
  --deployment-dir=<value>   [default: .]
  --directory=<value>        (required) Private checkpoint directory; export requires a new path; keep it outside
                             version control
  --instance=<value>         (required) Exact deployment instance binding
  --json
  --organization=<value>     (required) Expected CubeSigner organization ID
  --signer-api-root=<value>  (required) Expected HTTPS signing API origin (for example https://gamma.signer.cubist.dev)

DESCRIPTION
  Export/import a private, instance-bound checkpoint of an existing CLI-created CubeSigner identity and signing session
  without management login or provider mutations
```

_See code: [src/commands/cubesigner/checkpoint.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/cubesigner/checkpoint.ts)_

## `scrollsdk cubesigner refresh-session`

Create a replacement CubeSigner signer session and write its local Secret inputs

```
USAGE
  $ scrollsdk cubesigner refresh-session [--doge-config <value>] [--email <value>] [--environment <value>] [--json] [-N]
    [--org-id <value>]

FLAGS
  -N, --non-interactive      Run without prompts. Requires --doge-config. If not logged in, also requires --org-id and
                             --email.
      --doge-config=<value>  Path to Dogecoin config file
      --email=<value>        CubeSigner account email (for non-interactive login if not already logged in)
      --environment=<value>  [default: gamma] CubeSigner environment (default: gamma)
      --json                 Output in JSON format (stdout for data, stderr for logs)
      --org-id=<value>       CubeSigner organization ID (for non-interactive login if not already logged in)

DESCRIPTION
  Create a replacement CubeSigner signer session and write its local Secret inputs

  Generated signer sessions use fixed service lifetimes:
  session-lifetime=31536000s (365 days), auth-lifetime=7200s (2 hours), refresh-lifetime=604800s (7 days), and
  grace-lifetime=30s.

  This command writes local files under ./secrets. Push the refreshed secrets with setup push-secrets --cubesigner-only,
  then restart CubeSigner signer pods after clearing /app/.sessions/main_cs_session.json so the new Secret seed is
  copied into the active session cache.

EXAMPLES
  $ scrollsdk cubesigner refresh-session

  $ scrollsdk cubesigner refresh-session --doge-config .data/doge-config.toml

  $ scrollsdk cubesigner refresh-session --non-interactive --doge-config .data/doge-config.toml

  $ scrollsdk cubesigner refresh-session --non-interactive --json --doge-config .data/doge-config.toml --org-id Org#xxx --email user@example.com
```

_See code: [src/commands/cubesigner/refresh-session.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/cubesigner/refresh-session.ts)_

## `scrollsdk doge wallet new`

Create a new Dogecoin wallet (mainnet, testnet, or regtest)

```
USAGE
  $ scrollsdk doge wallet new [-c <value>] [-d] [-f] [--json] [-N] [-p <value>]

FLAGS
  -N, --non-interactive  Run without prompts (implies --force)
  -c, --config=<value>   [default: .data/doge-config.toml] Path to Dogecoin config file
  -d, --dry-run          Show what would be created without actually creating the wallet
  -f, --force            Skip confirmation prompt
  -p, --path=<value>     Path to save the wallet file (overrides path from config file)
      --json             Output in JSON format (stdout for data, stderr for logs)

DESCRIPTION
  Create a new Dogecoin wallet (mainnet, testnet, or regtest)

EXAMPLES
  $ scrollsdk doge:wallet new --config .data/doge-config.toml

  $ scrollsdk doge:wallet new --path ./my-custom-wallet.json --config .data/doge-config.toml

  $ scrollsdk doge:wallet new --dry-run

  $ scrollsdk doge:wallet new --force
```

_See code: [src/commands/doge/wallet/new.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/doge/wallet/new.ts)_

## `scrollsdk doge wallet send`

Send DOGE to an address or the bridge with cross-chain data (mainnet/testnet/regtest aware)

```
USAGE
  $ scrollsdk doge wallet send -a <value> [-c <value>] [-d] [-f] [--no-bridge | [--evm-address <value> | --hex-data
    <value> | --text-data <value>]] [-p <value>] [-t <value>]

FLAGS
  -a, --amount=<value>       (required) Amount to send in DOGE
  -c, --config=<value>       Path to Dogecoin config file
  -d, --dry-run              Simulate transaction without broadcasting
  -f, --force                Skip wallet sync prompt
  -p, --path=<value>         Path to wallet file (overrides config)
  -t, --to=<value>           Recipient Dogecoin address (required if --no-bridge and not using default recipient from
                             config)
      --evm-address=<value>  EVM address (20 bytes hex, 0x-prefixed) for bridge transactions
      --hex-data=<value>     Custom hex data for OP_RETURN (requires --no-bridge)
      --no-bridge            Send without bridge data (allows custom OP_RETURN data, or send to non-bridge address)
      --text-data=<value>    Text data for OP_RETURN (requires --no-bridge)

DESCRIPTION
  Send DOGE to an address or the bridge with cross-chain data (mainnet/testnet/regtest aware)

EXAMPLES
  $ scrollsdk doge:wallet send --amount 1.0

  $ scrollsdk doge:wallet send --amount 1.0 --evm-address 0xabc... --config .data/doge-config.toml

  $ scrollsdk doge:wallet send --amount 1.0 --no-bridge --to અનન્ય_ADDRESS

  $ scrollsdk doge:wallet send --amount 1.0 --hex-data 6a0468656c6c6f --no-bridge

  $ scrollsdk doge:wallet send --amount 1.0 --force
```

_See code: [src/commands/doge/wallet/send.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/doge/wallet/send.ts)_

## `scrollsdk doge wallet sync`

Sync wallet UTXOs and balance using Electrs/Esplora

```
USAGE
  $ scrollsdk doge wallet sync [-c <value>] [--electrs-url <value>] [-p <value>]

FLAGS
  -c, --config=<value>       Path to Dogecoin config file
  -p, --path=<value>         Wallet file path (overrides wallet.path in config)
      --electrs-url=<value>  Electrs/Esplora URL; defaults to rpc.electrsAPIUrl or the testnet Electrs endpoint

DESCRIPTION
  Sync wallet UTXOs and balance using Electrs/Esplora

EXAMPLES
  $ scrollsdk doge wallet sync --config .data/doge-config.toml --electrs-url http://localhost:3002
```

_See code: [src/commands/doge/wallet/sync.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/doge/wallet/sync.ts)_

## `scrollsdk help [COMMAND]`

Display help for scrollsdk.

```
USAGE
  $ scrollsdk help [COMMAND...] [-n]

ARGUMENTS
  [COMMAND...]  Command to show help for.

FLAGS
  -n, --nested-commands  Include all nested commands in the output.

DESCRIPTION
  Display help for scrollsdk.
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/v6.2.37/src/commands/help.ts)_

## `scrollsdk helper activity`

Generate transactions on the specified network(s) to produce more blocks

```
USAGE
  $ scrollsdk helper activity [-c <value>] [-d] [-i <value>] [-o] [-t] [-p] [-k <value>] [-x <value>] [-r <value>]
    [-s]

FLAGS
  -c, --config=<value>      [default: ./config.toml] Path to config.toml file
  -d, --debug               Enable debug mode for more detailed logging
  -i, --interval=<value>    [default: 3] Interval between transactions in seconds
  -k, --privateKey=<value>  Private key (overrides config)
  -o, --layer1              Generate activity on Layer 1
  -p, --pod                 Run inside Kubernetes pod
  -r, --rpc=<value>         RPC URL (overrides config for both layers)
  -s, --spam                with 110KB input while sending transaction
  -t, --[no-]layer2         Generate activity on Layer 2
  -x, --recipient=<value>   Recipient address (overrides config)

DESCRIPTION
  Generate transactions on the specified network(s) to produce more blocks
```

_See code: [src/commands/helper/activity.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/helper/activity.ts)_

## `scrollsdk helper clear-accounts`

Clear pending transactions and optionally transfer remaining funds on Layer 2

```
USAGE
  $ scrollsdk helper clear-accounts [-a <value>] [-c <value>] [-d] [-m <value>] [-p] [-k <value>] [-x <value>] [-r
  <value>]

FLAGS
  -a, --accounts=<value>    [default: 10] Number of accounts to generate from mnemonic
  -c, --config=<value>      [default: ./config.toml] Path to config.toml file
  -d, --debug               Run in debug mode
  -k, --privateKey=<value>  Private key to clear pending transactions
  -m, --mnemonic=<value>    Mnemonic to generate wallets
  -p, --pod                 Run in pod mode
  -r, --rpc=<value>         Layer 2 RPC URL
  -x, --recipient=<value>   Recipient address for remaining funds

DESCRIPTION
  Clear pending transactions and optionally transfer remaining funds on Layer 2
```

_See code: [src/commands/helper/clear-accounts.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/helper/clear-accounts.ts)_

## `scrollsdk helper derive-enode NODEKEY`

Derive a Reth enode and trustedPeers value from a nodekey

```
USAGE
  $ scrollsdk helper derive-enode NODEKEY

ARGUMENTS
  NODEKEY  Reth P2P nodekey

DESCRIPTION
  Derive a Reth enode and trustedPeers value from a nodekey

EXAMPLES
  $ scrollsdk helper derive-enode 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

_See code: [src/commands/helper/derive-enode.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/helper/derive-enode.ts)_

## `scrollsdk helper fund-accounts`

Fund L1 and L2 accounts for contracts

```
USAGE
  $ scrollsdk helper fund-accounts [-a <value>] [-f <value>] [-c <value>] [-n <value>] [-d] [-i] [-o <value>] [-t <value>]
    [-l 1|2] [-m] [-p] [-k <value>]

FLAGS
  -a, --account=<value>      Additional account to fund
  -c, --config=<value>       [default: ./config.toml] Path to config.toml file
  -d, --dev                  Use local L1 devnet funding logic
  -f, --amount=<value>       [default: 0.1] Amount to fund in ETH
  -i, --fund-deployer        Fund the deployer address only
  -k, --private-key=<value>  Private key for funder wallet
  -l, --layer=<option>       Specify layer to fund (1 for L1, 2 for L2)
                             <options: 1|2>
  -m, --manual               Manually fund the accounts
  -n, --contracts=<value>    [default: ./config-contracts.toml] Path to configs-contracts.toml file
  -o, --l1rpc=<value>        L1 RPC URL
  -p, --pod                  Run inside Kubernetes pod
  -t, --l2rpc=<value>        L2 RPC URL

DESCRIPTION
  Fund L1 and L2 accounts for contracts
```

_See code: [src/commands/helper/fund-accounts.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/helper/fund-accounts.ts)_

## `scrollsdk helper recovery-key`

Create or inspect a custodian recovery key offline; no Dogecoin node, RPC, AWS or deployment spec required

```
USAGE
  $ scrollsdk helper recovery-key --network mainnet|testnet|regtest --output <value> [--action create|inspect] [--json]

FLAGS
  --action=<option>   [default: create] Create a new key or verify an existing key/backup without changing it
                      <options: create|inspect>
  --json              Output public metadata only; never print the private key
  --network=<option>  (required) Deployment Dogecoin network
                      <options: mainnet|testnet|regtest>
  --output=<value>    (required) Custodian-owned directory outside source control; parent must exist, create refuses an
                      existing directory

DESCRIPTION
  Create or inspect a custodian recovery key offline; no Dogecoin node, RPC, AWS or deployment spec required
```

_See code: [src/commands/helper/recovery-key.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/helper/recovery-key.ts)_

## `scrollsdk helper set-scalars`

Set commit and blob scalars for Scroll SDK

```
USAGE
  $ scrollsdk helper set-scalars [--blobScalar <value>] [--commitScalar <value>] [-c <value>] [-n <value>] [-k <value>]
    [-p] [-r <value>]

FLAGS
  -c, --config=<value>        [default: ./config.toml] Path to config.toml file
  -k, --k=<value>             Private key of the Owner
  -n, --contracts=<value>     [default: ./config-contracts.toml] Path to configs-contracts.toml file
  -p, --pod                   Run inside Kubernetes pod
  -r, --rpc=<value>           RPC URL (overrides config)
      --blobScalar=<value>    Value for setBlobScalar
      --commitScalar=<value>  Value for setCommitScalar

DESCRIPTION
  Set commit and blob scalars for Scroll SDK
```

_See code: [src/commands/helper/set-scalars.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/helper/set-scalars.ts)_

## `scrollsdk monitoring status-page`

Initialize and maintain Instatus page bindings with --plan or --apply; setup render generates local configuration

```
USAGE
  $ scrollsdk monitoring status-page [--apply | --plan] [--config <value>] [--create-webhook | --webhook-url-file <value>]
    [--deployment-dir <value>] [--env-file <value>] [--json] [--probe-values <value>] [--values <value>]
    [--webhook-component <value> ]

FLAGS
  --apply                      Apply this network group's component metadata and shared page branding to Instatus using
                               INSTATUS_API_KEY
  --config=<value>             [default: config.toml] Chain config, relative to deployment directory
  --create-webhook             With --plan/--apply, initialize a Grafana integration if no private binding exists;
                               subsequent applies reuse it
  --deployment-dir=<value>     [default: .] Deployment root
  --env-file=<value>           Private NAME=value file for --plan/--apply; defaults to the saved preparation plan
                               reference, then deployment.env in the deployment directory
  --json                       Output structured JSON
  --plan                       Read-only remote comparison; do not write local files or Instatus
  --probe-values=<value>       Write values for the independent status-page-probe chart; --plan never writes
  --values=<value>             [default: values/scroll-monitor-production.yaml] Monitor values; source filenames resolve
                               beside this file
  --webhook-component=<value>  Component key for --webhook-url-file when using component publication
  --webhook-url-file=<value>   With --plan/--apply, import private component JSON {integrationId,url}, or a legacy
                               Grafana URL text file

DESCRIPTION
  Initialize and maintain Instatus page bindings with --plan or --apply; setup render generates local configuration
```

_See code: [src/commands/monitoring/status-page.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/monitoring/status-page.ts)_

## `scrollsdk plugins`

List installed plugins.

```
USAGE
  $ scrollsdk plugins [--json] [--core]

FLAGS
  --core  Show core plugins.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List installed plugins.

EXAMPLES
  $ scrollsdk plugins
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.56/src/commands/plugins/index.ts)_

## `scrollsdk plugins add PLUGIN`

Installs a plugin into scrollsdk.

```
USAGE
  $ scrollsdk plugins add PLUGIN... [--json] [-f] [-h] [-s | -v]

ARGUMENTS
  PLUGIN...  Plugin to install.

FLAGS
  -f, --force    Force npm to fetch remote resources even if a local copy exists on disk.
  -h, --help     Show CLI help.
  -s, --silent   Silences npm output.
  -v, --verbose  Show verbose npm output.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Installs a plugin into scrollsdk.

  Uses npm to install plugins.

  Installation of a user-installed plugin will override a core plugin.

  Use the SCROLLSDK_NPM_LOG_LEVEL environment variable to set the npm loglevel.
  Use the SCROLLSDK_NPM_REGISTRY environment variable to set the npm registry.

ALIASES
  $ scrollsdk plugins add

EXAMPLES
  Install a plugin from npm registry.

    $ scrollsdk plugins add myplugin

  Install a plugin from a github url.

    $ scrollsdk plugins add https://github.com/someuser/someplugin

  Install a plugin from a github slug.

    $ scrollsdk plugins add someuser/someplugin
```

## `scrollsdk plugins:inspect PLUGIN...`

Displays installation properties of a plugin.

```
USAGE
  $ scrollsdk plugins inspect PLUGIN...

ARGUMENTS
  PLUGIN...  [default: .] Plugin to inspect.

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Displays installation properties of a plugin.

EXAMPLES
  $ scrollsdk plugins inspect myplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.56/src/commands/plugins/inspect.ts)_

## `scrollsdk plugins install PLUGIN`

Installs a plugin into scrollsdk.

```
USAGE
  $ scrollsdk plugins install PLUGIN... [--json] [-f] [-h] [-s | -v]

ARGUMENTS
  PLUGIN...  Plugin to install.

FLAGS
  -f, --force    Force npm to fetch remote resources even if a local copy exists on disk.
  -h, --help     Show CLI help.
  -s, --silent   Silences npm output.
  -v, --verbose  Show verbose npm output.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Installs a plugin into scrollsdk.

  Uses npm to install plugins.

  Installation of a user-installed plugin will override a core plugin.

  Use the SCROLLSDK_NPM_LOG_LEVEL environment variable to set the npm loglevel.
  Use the SCROLLSDK_NPM_REGISTRY environment variable to set the npm registry.

ALIASES
  $ scrollsdk plugins add

EXAMPLES
  Install a plugin from npm registry.

    $ scrollsdk plugins install myplugin

  Install a plugin from a github url.

    $ scrollsdk plugins install https://github.com/someuser/someplugin

  Install a plugin from a github slug.

    $ scrollsdk plugins install someuser/someplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.56/src/commands/plugins/install.ts)_

## `scrollsdk plugins link PATH`

Links a plugin into the CLI for development.

```
USAGE
  $ scrollsdk plugins link PATH [-h] [--install] [-v]

ARGUMENTS
  PATH  [default: .] path to plugin

FLAGS
  -h, --help          Show CLI help.
  -v, --verbose
      --[no-]install  Install dependencies after linking the plugin.

DESCRIPTION
  Links a plugin into the CLI for development.

  Installation of a linked plugin will override a user-installed or core plugin.

  e.g. If you have a user-installed or core plugin that has a 'hello' command, installing a linked plugin with a 'hello'
  command will override the user-installed or core plugin implementation. This is useful for development work.


EXAMPLES
  $ scrollsdk plugins link myplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.56/src/commands/plugins/link.ts)_

## `scrollsdk plugins remove [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ scrollsdk plugins remove [PLUGIN...] [-h] [-v]

ARGUMENTS
  [PLUGIN...]  plugin to uninstall

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Removes a plugin from the CLI.

ALIASES
  $ scrollsdk plugins unlink
  $ scrollsdk plugins remove

EXAMPLES
  $ scrollsdk plugins remove myplugin
```

## `scrollsdk plugins reset`

Remove all user-installed and linked plugins.

```
USAGE
  $ scrollsdk plugins reset [--hard] [--reinstall]

FLAGS
  --hard       Delete node_modules and package manager related files in addition to uninstalling plugins.
  --reinstall  Reinstall all plugins after uninstalling.
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.56/src/commands/plugins/reset.ts)_

## `scrollsdk plugins uninstall [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ scrollsdk plugins uninstall [PLUGIN...] [-h] [-v]

ARGUMENTS
  [PLUGIN...]  plugin to uninstall

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Removes a plugin from the CLI.

ALIASES
  $ scrollsdk plugins unlink
  $ scrollsdk plugins remove

EXAMPLES
  $ scrollsdk plugins uninstall myplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.56/src/commands/plugins/uninstall.ts)_

## `scrollsdk plugins unlink [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ scrollsdk plugins unlink [PLUGIN...] [-h] [-v]

ARGUMENTS
  [PLUGIN...]  plugin to uninstall

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Removes a plugin from the CLI.

ALIASES
  $ scrollsdk plugins unlink
  $ scrollsdk plugins remove

EXAMPLES
  $ scrollsdk plugins unlink myplugin
```

## `scrollsdk plugins update`

Update installed plugins.

```
USAGE
  $ scrollsdk plugins update [-h] [-v]

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Update installed plugins.
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.56/src/commands/plugins/update.ts)_

## `scrollsdk rpc export`

Generate configuration files for dogeos-rpc-package to enable external RPC nodes

```
USAGE
  $ scrollsdk rpc export -d <value> [--aws-profile <value>] [--config-path <value>] [--doge-config <value>] [-n
    <value>] [--spec <value>] [--values-dir <value>]

FLAGS
  -d, --dogeos-rpc-package-dir=<value>  (required) Path to dogeos-rpc-package project directory (clone from
                                        https://github.com/dogeos69/dogeos-rpc-package)
  -n, --namespace=<value>               Kubernetes namespace
      --aws-profile=<value>             AWS profile for independently managed bootnode NLB discovery
      --config-path=<value>             [default: ./config.toml] Path to config.toml file containing cluster
                                        configuration
      --doge-config=<value>             Path to Dogecoin config file
      --spec=<value>                    Deployment spec required when values reference independent bootnode NLBs
      --values-dir=<value>              [default: ./values] Directory containing Helm values files (must include
                                        genesis.yaml)

DESCRIPTION
  Generate configuration files for dogeos-rpc-package to enable external RPC nodes

EXAMPLES
  # Generate RPC package (dogeos-rpc-package directory is required)

  $ scrollsdk rpc export -d ~/github/dogeos-rpc-package/



  # Generate mainnet RPC package with specific config and namespace

  $ scrollsdk rpc export --doge-config .data/doge-config.toml -d ~/github/dogeos-rpc-package/ -n scroll-mainnet



  # First clone the project: git clone https://github.com/dogeos69/dogeos-rpc-package

  $ scrollsdk rpc export -d ./dogeos-rpc-package/ --namespace default
```

_See code: [src/commands/rpc/export.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/rpc/export.ts)_

## `scrollsdk setup aws`

Read external AWS resource information before genesis and bind it to production configuration

```
USAGE
  $ scrollsdk setup aws [--defer-cubesigner] [--dir <value>] [--json]

FLAGS
  --defer-cubesigner  Defer signer session creation and upload; other preparation may proceed, signer activation remains
                      pending
  --dir=<value>       [default: deployment] Saved deployment directory created by setup plan
  --json              Output structured stage status and the next command

DESCRIPTION
  Read external AWS resource information before genesis and bind it to production configuration
```

_See code: [src/commands/setup/aws.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/aws.ts)_

## `scrollsdk setup bridge-funding`

Resume Bridge preparation through wallet and marked Bridge funding handoffs

```
USAGE
  $ scrollsdk setup bridge-funding [--defer-cubesigner] [--dir <value>] [--json]

FLAGS
  --defer-cubesigner  Defer signer session creation and upload; other preparation may proceed, signer activation remains
                      pending
  --dir=<value>       [default: deployment] Saved deployment directory created by setup plan
  --json              Output structured stage status and the next command

DESCRIPTION
  Resume Bridge preparation through wallet and marked Bridge funding handoffs
```

_See code: [src/commands/setup/bridge-funding.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/bridge-funding.ts)_

## `scrollsdk setup cubesigner-policy build`

Export the CubeSigner policy Wasm and its sha256 from an immutable compiler image, offline

```
USAGE
  $ scrollsdk setup cubesigner-policy build --compiler-image <value> --expected-core-revision <value> --output <value>
  [--json]

FLAGS
  --compiler-image=<value>          (required) ghcr.io/dogeos69/cubesigner-policy-compiler@sha256:<digest> (private;
                                    needs docker login ghcr.io with read:packages)
  --expected-core-revision=<value>  (required)
  --json
  --output=<value>                  (required)

DESCRIPTION
  Export the CubeSigner policy Wasm and its sha256 from an immutable compiler image, offline
```

_See code: [src/commands/setup/cubesigner-policy/build.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/cubesigner-policy/build.ts)_

## `scrollsdk setup cubesigner-policy deploy`

Limited initial policy upload/attachment; emits an operation record, not preparation receipts. For an already attached governed policy use setup cubesigner-policy reconcile

```
USAGE
  $ scrollsdk setup cubesigner-policy deploy --build-receipt <value> --build-receipt-sha256 <value> --key-id <value> --name <value>
    --organization <value> --output <value> [--json]

FLAGS
  --build-receipt=<value>         (required)
  --build-receipt-sha256=<value>  (required)
  --json
  --key-id=<value>                (required)
  --name=<value>                  (required)
  --organization=<value>          (required)
  --output=<value>                (required)

DESCRIPTION
  Limited initial policy upload/attachment; emits an operation record, not preparation receipts. For an already attached
  governed policy use setup cubesigner-policy reconcile
```

_See code: [src/commands/setup/cubesigner-policy/deploy.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/cubesigner-policy/deploy.ts)_

## `scrollsdk setup cubesigner-policy handoff`

Archive reviewed Core governance config, state, exact operation log and approval snapshots; never approves or executes an attachment

```
USAGE
  $ scrollsdk setup cubesigner-policy handoff --config <value> --kind initial-provisioning|sealed-upgrade --operations <value>
    --session-lifetime <value> --state <value> [--approval <value>...] [--dir <value>] [--initial-seal-last-reviewed]
    [--json] [--provisioning <value>]

FLAGS
  --approval=<value>...         [default: ] JSON captured by the pinned Core mfa command, one per pending operation
  --config=<value>              (required) Reviewed Core governance config JSON
  --dir=<value>                 [default: deployment]
  --initial-seal-last-reviewed  Explicitly declare reviewed unregistered/unfunded setup and sealing before Bridge
                                registration; not an on-chain check
  --json
  --kind=<option>               (required)
                                <options: initial-provisioning|sealed-upgrade>
  --operations=<value>          (required) Pinned Core governance-log.jsonl; preserve proposal and executed request
                                records
  --provisioning=<value>        Reviewed seal-last, unregistered/unfunded initial provisioning evidence
  --session-lifetime=<value>    (required) Reviewed maximum runtime session lifetime, seconds
  --state=<value>               (required) Core governance state JSON

DESCRIPTION
  Archive reviewed Core governance config, state, exact operation log and approval snapshots; never approves or executes
  an attachment
```

_See code: [src/commands/setup/cubesigner-policy/handoff.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/cubesigner-policy/handoff.ts)_

## `scrollsdk setup cubesigner-policy import`

Import an external policy Wasm for staged preparation; verify hashes and record operator-declared build provenance without publishing or attaching

```
USAGE
  $ scrollsdk setup cubesigner-policy import --build-script-revision <value> --core-revision <value>
    --expected-protocol-context-sha256 <value> --expected-wasm-sha256 <value> --source-repo <value> --wasm <value>
    [--dir <value>] [--json]

FLAGS
  --build-script-revision=<value>             (required) Full Core commit containing tools/cubesigner/build-verifier.sh
  --core-revision=<value>                     (required) Full policy source commit used for the external build
  --dir=<value>                               [default: deployment] Saved deployment directory
  --expected-protocol-context-sha256=<value>  (required) Reviewed SHA-256 of .data/protocol_context.json
  --expected-wasm-sha256=<value>              (required) Independently agreed Wasm SHA-256
  --json
  --source-repo=<value>                       (required) Local Core repository containing both commits; no checkout or
                                              fetch is performed
  --wasm=<value>                              (required) Existing Wasm path relative to the deployment directory

DESCRIPTION
  Import an external policy Wasm for staged preparation; verify hashes and record operator-declared build provenance
  without publishing or attaching
```

_See code: [src/commands/setup/cubesigner-policy/import.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/cubesigner-policy/import.ts)_

## `scrollsdk setup cubesigner-policy import-acceptance`

Import a reviewed real signing/denial report and update only signer evidence references; does not sign or certify installation

```
USAGE
  $ scrollsdk setup cubesigner-policy import-acceptance --report <value> [--dir <value>] [--json]

FLAGS
  --dir=<value>     [default: deployment]
  --json
  --report=<value>  (required) Actual reviewed exercise report; see docs/cubesigner-preparation.md

DESCRIPTION
  Import a reviewed real signing/denial report and update only signer evidence references; does not sign or certify
  installation
```

_See code: [src/commands/setup/cubesigner-policy/import-acceptance.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/cubesigner-policy/import-acceptance.ts)_

## `scrollsdk setup cubesigner-policy prepare`

Prepare expected production policy from reviewed artifacts and a concrete published version; no attachment required

```
USAGE
  $ scrollsdk setup cubesigner-policy prepare --input <value> [--dir <value>] [--json] [--output <value>]
  [--session-file <value>]

FLAGS
  --dir=<value>           [default: deployment]
  --input=<value>         (required) Reviewed release inputs JSON, relative to deployment; see
                          docs/cubesigner-external-policy.md
  --json
  --output=<value>        [default: .data/cubesigner-policy-prepared] New evidence directory relative to deployment;
                          existing output is never overwritten
  --session-file=<value>  Management session; defaults to the cs CLI session

DESCRIPTION
  Prepare expected production policy from reviewed artifacts and a concrete published version; no attachment required

EXAMPLES
  $ scrollsdk setup cubesigner-policy prepare --dir deployment --input .data/policy-review.json --json
```

_See code: [src/commands/setup/cubesigner-policy/prepare.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/cubesigner-policy/prepare.ts)_

## `scrollsdk setup cubesigner-policy prepare-input`

Derive the expected-policy input from actual artifacts; external reviewed identity digests and real test evidence are required, never synthesized

```
USAGE
  $ scrollsdk setup cubesigner-policy prepare-input --environment beta|gamma|prod --organization <value> --policy <value>
    --program-identity-digest <value> --requires-live-evidence --resolver-base-url <value> --tests <value>
    --verifier-identity-digest <value> [--build-receipt <value>] [--dir <value>] [--json] [--live-evidence <value>]
    [--materials <value>] [--output <value>] [--wasm <value>]

FLAGS
  --build-receipt=<value>             [default: .data/cubesigner-policy/build-receipt.json]
  --dir=<value>                       [default: deployment]
  --environment=<option>              (required)
                                      <options: beta|gamma|prod>
  --json
  --live-evidence=<value>             Reviewed real acceptance report, if already available; never generated by this
                                      command
  --materials=<value>                 [default: .data/proof-materials-v1.json]
  --organization=<value>              (required) Organization ID or alias; prepare verifies it and records the canonical
                                      ID
  --output=<value>                    [default: .scrollsdk/inputs/cubesigner-policy/preparation.json]
  --policy=<value>                    (required) Published concrete name/vN, v1 or later
  --program-identity-digest=<value>   (required) Reviewed release program identity digest; not the VM executable file
                                      hash
  --[no-]requires-live-evidence       (required) Selected release requirement; disabling a required check is not a
                                      canary workaround
  --resolver-base-url=<value>         (required) Exact compiled proof artifact root, including path
  --tests=<value>                     (required) Actual reviewed test report with result, source/Wasm/context and
                                      compiled bindings
  --verifier-identity-digest=<value>  (required)
  --wasm=<value>                      [default: .data/cubesigner-policy/cubesigner_verifier_policy.wasm]

DESCRIPTION
  Derive the expected-policy input from actual artifacts; external reviewed identity digests and real test evidence are
  required, never synthesized
```

_See code: [src/commands/setup/cubesigner-policy/prepare-input.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/cubesigner-policy/prepare-input.ts)_

## `scrollsdk setup cubesigner-policy prepare-runtime-secrets`

Prepare only CubeSigner SecretStore/ExternalSecret objects and wait for delivery; does not start a signer or authorize activation

```
USAGE
  $ scrollsdk setup cubesigner-policy prepare-runtime-secrets --kube-context <value> --namespace <value> [--chart <value>] [--chart-version <value>]
    [--dir <value>] [--json] [--values <value>]

FLAGS
  --chart=<value>          [default: oci://ghcr.io/dogeos69/scroll-sdk/helm/cubesigner-signer]
  --chart-version=<value>  [default: 0.1.9]
  --dir=<value>            [default: deployment]
  --json
  --kube-context=<value>   (required)
  --namespace=<value>      (required)
  --values=<value>         [default: values/cubesigner-signer-production.yaml]

DESCRIPTION
  Prepare only CubeSigner SecretStore/ExternalSecret objects and wait for delivery; does not start a signer or authorize
  activation
```

_See code: [src/commands/setup/cubesigner-policy/prepare-runtime-secrets.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/cubesigner-policy/prepare-runtime-secrets.ts)_

## `scrollsdk setup cubesigner-policy prepare-session`

Reuse a valid scoped signer session or explicitly create one when the role permits it, independently of attachment approval; no upload or pod restart

```
USAGE
  $ scrollsdk setup cubesigner-policy prepare-session [--dir <value>] [--json] [--session-file <value>]

FLAGS
  --dir=<value>           [default: deployment]
  --json
  --session-file=<value>  Management session file

DESCRIPTION
  Reuse a valid scoped signer session or explicitly create one when the role permits it, independently of attachment
  approval; no upload or pod restart
```

_See code: [src/commands/setup/cubesigner-policy/prepare-session.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/cubesigner-policy/prepare-session.ts)_

## `scrollsdk setup cubesigner-policy reconcile`

Validate reviewed release evidence and read back an already attached policy; write preparation receipts without changing CubeSigner

```
USAGE
  $ scrollsdk setup cubesigner-policy reconcile --input <value> [--dir <value>] [--json] [--output <value>]
  [--session-file <value>]

FLAGS
  --dir=<value>           [default: deployment]
  --input=<value>         (required) Reviewed release inputs JSON, relative to deployment; see
                          docs/cubesigner-external-policy.md
  --json
  --output=<value>        [default: .data/cubesigner-policy-reconciled] New evidence directory relative to deployment;
                          existing output is never overwritten
  --session-file=<value>  Management session; defaults to the cs CLI session

DESCRIPTION
  Validate reviewed release evidence and read back an already attached policy; write preparation receipts without
  changing CubeSigner

EXAMPLES
  $ scrollsdk setup cubesigner-policy reconcile --dir deployment --input .data/policy-review.json --json
```

_See code: [src/commands/setup/cubesigner-policy/reconcile.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/cubesigner-policy/reconcile.ts)_

## `scrollsdk setup cubesigner-policy resolver`

Preview or add a policy resolver to the CubeSigner organization HTTP authority allowlist, preserving its existing configuration

```
USAGE
  $ scrollsdk setup cubesigner-policy resolver --base-url <value> --organization <value> [--apply] [--json] [--output <value>]
    [--session-file <value>]

FLAGS
  --apply                 Add the resolver authority and verify provider readback
  --base-url=<value>      (required)
  --json
  --organization=<value>  (required)
  --output=<value>        Write the non-secret resolver configuration receipt to a new file
  --session-file=<value>  Management session file; defaults to the cs CLI session

DESCRIPTION
  Preview or add a policy resolver to the CubeSigner organization HTTP authority allowlist, preserving its existing
  configuration
```

_See code: [src/commands/setup/cubesigner-policy/resolver.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/cubesigner-policy/resolver.ts)_

## `scrollsdk setup cubesigner-policy verify-activation`

Check current rendered signer values, remote attachment, Council evidence and runtime session before installation; read-only provider calls, no Helm mutation

```
USAGE
  $ scrollsdk setup cubesigner-policy verify-activation [--chart <value>] [--chart-version <value>] [--dir <value>] [--governance <value>]
    [--json] [--kube-context <value>] [--namespace <value>] [--policy-only] [--session-file <value>] [--values <value>]

FLAGS
  --chart=<value>          [default: oci://ghcr.io/dogeos69/scroll-sdk/helm/cubesigner-signer]
  --chart-version=<value>  [default: 0.1.9]
  --dir=<value>            [default: deployment]
  --governance=<value>     [default: .scrollsdk/inputs/cubesigner-policy/governance.json]
  --json
  --kube-context=<value>   Cluster context used by the installation target
  --namespace=<value>      [default: default]
  --policy-only            Verify policy before preparing credentials; reports activation pending and cannot authorize
                           installation
  --session-file=<value>   Management session file; credentials are never printed
  --values=<value>         [default: values/cubesigner-signer-production.yaml]

DESCRIPTION
  Check current rendered signer values, remote attachment, Council evidence and runtime session before installation;
  read-only provider calls, no Helm mutation
```

_See code: [src/commands/setup/cubesigner-policy/verify-activation.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/cubesigner-policy/verify-activation.ts)_

## `scrollsdk setup deployment-preflight`

Check prepared application inputs before Helm installation; optionally check installed workloads

```
USAGE
  $ scrollsdk setup deployment-preflight [--deployment-dir <value>] [--doge-config <value>] [--dogecoin-rpc-env <value>
    --signer-container <value>] [--dstack-deployment <value>] [--ethereum-chain-id <value>] [--ethereum-rpc-env
    <value>...] [--ethereum-rpc-quorum <value>] [--json] [--namespace <value>] [--proof] [--proof-live --kube-context
    <value>] [--proof-scope activation|preparation] [--rendered-manifest <value>... ] [--require-dstack] [--reth-image
    <value>] [--spec <value>]

FLAGS
  --deployment-dir=<value>        [default: .]
  --doge-config=<value>           [default: .data/doge-config.toml]
  --dogecoin-rpc-env=<value>      Environment variable containing the authenticated Dogecoin RPC URL
  --dstack-deployment=<value>     [default: dstack-controller]
  --ethereum-chain-id=<value>     [default: 11155111]
  --ethereum-rpc-env=<value>...   Environment variable containing an Ethereum RPC URL; checks a four-call batch and
                                  finalized-block quorum
  --ethereum-rpc-quorum=<value>   [default: 1]
  --json
  --kube-context=<value>          Explicit context for optional cluster checks
  --namespace=<value>             Namespace for application checks; defaults to default
  --proof                         Require proof contract validation; automatic when proof configuration or a contract is
                                  present
  --proof-live                    After rollout: also require fresh authenticated TSO polls from every registered signer
  --proof-scope=<option>          [default: activation] Proof evidence scope; preparation does not authorize signer
                                  installation
                                  <options: activation|preparation>
  --rendered-manifest=<value>...  Rendered Helm manifest to check against cluster resources and ALB prerequisites;
                                  repeat for each release
  --require-dstack                Require controller configuration; with kube-context also require its installed
                                  Deployment to be available
  --reth-image=<value>            Run an isolated local startup canary for this exact Reth image with the deployment
                                  genesis; no network or persistent data
  --signer-container=<value>      Probe Dogecoin RPC from this running container network namespace using a disposable
                                  curl container
  --spec=<value>                  Spec path for selected checks, relative to deployment-dir; defaults to saved intent or
                                  deployment-spec.yaml

DESCRIPTION
  Check prepared application inputs before Helm installation; optionally check installed workloads
```

_See code: [src/commands/setup/deployment-preflight.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/deployment-preflight.ts)_

## `scrollsdk setup genesis`

Generate and pin local genesis artifacts after validating existing AWS resources

```
USAGE
  $ scrollsdk setup genesis [--defer-cubesigner] [--dir <value>] [--json]

FLAGS
  --defer-cubesigner  Defer signer session creation and upload; other preparation may proceed, signer activation remains
                      pending
  --dir=<value>       [default: deployment] Saved deployment directory created by setup plan
  --json              Output structured stage status and the next command

DESCRIPTION
  Generate and pin local genesis artifacts after validating existing AWS resources
```

_See code: [src/commands/setup/genesis.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/genesis.ts)_

## `scrollsdk setup plan`

Plan a fresh spec deployment preparation; save a private plan without cloud or chain mutations

```
USAGE
  $ scrollsdk setup plan [--env-file <value>] [--json] [--output <value>] [--sdk-dir <value>] [--spec <value>]

FLAGS
  --env-file=<value>  Private NAME=value file (default: ./deployment.env when present); saved for stage commands, never
                      executed as shell
  --json
  --output=<value>    [default: deployment] New private deployment directory
  --sdk-dir=<value>   [default: ../scroll-sdk] SDK checkout; plan locks committed HEAD unless templates.sdkRevision
                      overrides it
  --spec=<value>      [default: deployment-spec.yaml] DeploymentSpec YAML; environment references must resolve in this
                      process

DESCRIPTION
  Plan a fresh spec deployment preparation; save a private plan without cloud or chain mutations
```

_See code: [src/commands/setup/plan.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/plan.ts)_

## `scrollsdk setup policy-prepare`

Resume the saved policy-prepare stage; runs only its declared effects

```
USAGE
  $ scrollsdk setup policy-prepare [--defer-cubesigner] [--dir <value>] [--json]

FLAGS
  --defer-cubesigner  Defer signer session creation and upload; other preparation may proceed, signer activation remains
                      pending
  --dir=<value>       [default: deployment] Saved deployment directory created by setup plan
  --json              Output structured stage status and the next command

DESCRIPTION
  Resume the saved policy-prepare stage; runs only its declared effects
```

_See code: [src/commands/setup/policy-prepare.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/policy-prepare.ts)_

## `scrollsdk setup proof-materials`

Prepare the selected proof materials and compiled topology from the saved deployment plan

```
USAGE
  $ scrollsdk setup proof-materials [--aggregate-verifying-key <value>] [--artifact-root <value>] [--batch-materializer
    <value>] [--bridge-artifact-dir <value>] [--chunk-materializer <value>] [--compiler-image <value>] [--deployment-dir
    <value>] [--dir <value>] [--expected-core-revision <value>] [--generation mock|real] [--identity-env <value>]
    [--json] [--materials-dir <value>] [--mock-worker-image <value>] [-N] [--output <value>] [--preparation-receipt
    <value>] [--production-worker-image <value>] [--production-worker-receipt <value>] [--protocol-context <value>]
    [--worker-identity-bundle <value>]

FLAGS
  -N, --non-interactive                    Do not prompt; standalone preparation requires an explicit generation or
                                           preparation receipt
      --aggregate-verifying-key=<value>    Root aggregate verifying key; required with mock real-materialization and
                                           supplied by --artifact-root for real generation
      --artifact-root=<value>              prepare-real output holding chunk/, batch/ and verifier/aggregate-vk; real
                                           only
      --batch-materializer=<value>         scroll-runtime-materializer from the release proof-coordinator image (setup
                                           proof-image-tools --action export); required for real materialization
      --bridge-artifact-dir=<value>        Optional output of prover-worker --stage-bridge-artifact, including
                                           worker-identity-bundle.json; real only
      --chunk-materializer=<value>         materialize-chunk-oneshot from the release proof-coordinator image (setup
                                           proof-image-tools --action export); required for real materialization
      --compiler-image=<value>             dogeos-proof-topology tag or digest from the approved release lineage
      --deployment-dir=<value>             [default: .] Deployment directory
      --dir=<value>                        Saved deployment directory for stage mode (default: ./deployment); use
                                           --generation for standalone preparation
      --expected-core-revision=<value>     Full dogeos-core Git SHA that baked --artifact-root; real only
      --generation=<option>                Materials to prepare: mock imports shared identities only; real imports the
                                           full proving release
                                           <options: mock|real>
      --identity-env=<value>               Optional real-identity.env for staging real identities during mock; required
                                           for real
      --json                               Output structured JSON
      --materials-dir=<value>              [default: .data/proof-materials] Deployment-relative material destination
      --mock-worker-image=<value>          Mock Worker tag or digest; plain mock only, where it supplies the compiler
                                           identity
      --output=<value>                     [default: .data/proof-materials-v1.json] Deployment-relative receipt path
      --preparation-receipt=<value>        Validated proof-release-preparation-v1.json; supplies every real-material
                                           flag except the materializers
      --production-worker-image=<value>    Real Worker release tag or digest; real only
      --production-worker-receipt=<value>  Validated proof-worker-image-check-v1.json; excludes
                                           --production-worker-image
      --protocol-context=<value>           Deployment protocol_context.json required with --bridge-artifact-dir; real
                                           only
      --worker-identity-bundle=<value>     Canonical worker-identity-bundle.json from the matching dogeos-core bake;
                                           required for mock proving with real materialization

DESCRIPTION
  Prepare the selected proof materials and compiled topology from the saved deployment plan

EXAMPLES
  $ scrollsdk setup proof-materials --generation mock

  $ scrollsdk setup proof-materials --generation mock --identity-env /build/real-identity.env --worker-identity-bundle /build/worker-identity-bundle.json

  $ scrollsdk setup proof-materials --generation real --artifact-root /build/bake --expected-core-revision <40-hex-sha> --identity-env /build/bake/real-identity.env --chunk-materializer /build/materialize-chunk-oneshot --batch-materializer /build/scroll-runtime-materializer --production-worker-image repo/worker@sha256:... --compiler-image repo/compiler@sha256:...

  $ scrollsdk setup proof-materials --generation real --bridge-artifact-dir /build/bake/bridge --protocol-context .data/protocol_context.json

  $ scrollsdk setup proof-materials --preparation-receipt .data/proof-release-preparation-v1.json --production-worker-receipt .data/proof-worker-image-check-v1.json --chunk-materializer /build/materialize-chunk-oneshot --batch-materializer /build/scroll-runtime-materializer --compiler-image repo/compiler@sha256:...
```

_See code: [src/commands/setup/proof-materials.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/proof-materials.ts)_

## `scrollsdk setup proof-publish`

Resume the saved proof-publish stage; runs only its declared effects

```
USAGE
  $ scrollsdk setup proof-publish [--defer-cubesigner] [--dir <value>] [--json]

FLAGS
  --defer-cubesigner  Defer signer session creation and upload; other preparation may proceed, signer activation remains
                      pending
  --dir=<value>       [default: deployment] Saved deployment directory created by setup plan
  --json              Output structured stage status and the next command

DESCRIPTION
  Resume the saved proof-publish stage; runs only its declared effects
```

_See code: [src/commands/setup/proof-publish.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/proof-publish.ts)_

## `scrollsdk setup protocol-context`

Generate canonical protocol context from completed Bridge funding; stop before policy builds and proof preparation

```
USAGE
  $ scrollsdk setup protocol-context [--defer-cubesigner] [--dir <value>] [--json]

FLAGS
  --defer-cubesigner  Defer signer session creation and upload; other preparation may proceed, signer activation remains
                      pending
  --dir=<value>       [default: deployment] Saved deployment directory created by setup plan
  --json              Output structured stage status and the next command

DESCRIPTION
  Generate canonical protocol context from completed Bridge funding; stop before policy builds and proof preparation
```

_See code: [src/commands/setup/protocol-context.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/protocol-context.ts)_

## `scrollsdk setup render`

Render configuration and private Secrets without creating remote signer sessions; run signer-session separately

```
USAGE
  $ scrollsdk setup render [--defer-cubesigner] [--dir <value>] [--json]

FLAGS
  --defer-cubesigner  Defer signer session creation and upload; other preparation may proceed, signer activation remains
                      pending
  --dir=<value>       [default: deployment] Saved deployment directory created by setup plan
  --json              Output structured stage status and the next command

DESCRIPTION
  Render configuration and private Secrets without creating remote signer sessions; run signer-session separately
```

_See code: [src/commands/setup/render.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/render.ts)_

## `scrollsdk setup signer-kit`

Resume the saved signer-kit stage; runs only its declared effects

```
USAGE
  $ scrollsdk setup signer-kit [--defer-cubesigner] [--dir <value>] [--json]

FLAGS
  --defer-cubesigner  Defer signer session creation and upload; other preparation may proceed, signer activation remains
                      pending
  --dir=<value>       [default: deployment] Saved deployment directory created by setup plan
  --json              Output structured stage status and the next command

DESCRIPTION
  Resume the saved signer-kit stage; runs only its declared effects
```

_See code: [src/commands/setup/signer-kit.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/signer-kit.ts)_

## `scrollsdk setup signer-kit-publish`

Resume the saved signer-kit-publish stage; runs only its declared effects

```
USAGE
  $ scrollsdk setup signer-kit-publish [--defer-cubesigner] [--dir <value>] [--json]

FLAGS
  --defer-cubesigner  Defer signer session creation and upload; other preparation may proceed, signer activation remains
                      pending
  --dir=<value>       [default: deployment] Saved deployment directory created by setup plan
  --json              Output structured stage status and the next command

DESCRIPTION
  Resume the saved signer-kit-publish stage; runs only its declared effects
```

_See code: [src/commands/setup/signer-kit-publish.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/signer-kit-publish.ts)_

## `scrollsdk setup signer-session`

Validate/reuse or explicitly create the CubeSigner runtime session; completed steps are skipped on retry

```
USAGE
  $ scrollsdk setup signer-session [--defer-cubesigner] [--dir <value>] [--json]

FLAGS
  --defer-cubesigner  Defer signer session creation and upload; other preparation may proceed, signer activation remains
                      pending
  --dir=<value>       [default: deployment] Saved deployment directory created by setup plan
  --json              Output structured stage status and the next command

DESCRIPTION
  Validate/reuse or explicitly create the CubeSigner runtime session; completed steps are skipped on retry
```

_See code: [src/commands/setup/signer-session.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/signer-session.ts)_

## `scrollsdk setup upload-secrets`

Upload prepared runtime Secrets to the saved deployment destination

```
USAGE
  $ scrollsdk setup upload-secrets [--defer-cubesigner] [--dir <value>] [--json]

FLAGS
  --defer-cubesigner  Defer signer session creation and upload; other preparation may proceed, signer activation remains
                      pending
  --dir=<value>       [default: deployment] Saved deployment directory created by setup plan
  --json              Output structured stage status and the next command

DESCRIPTION
  Upload prepared runtime Secrets to the saved deployment destination
```

_See code: [src/commands/setup/upload-secrets.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/upload-secrets.ts)_

## `scrollsdk signer init`

Signer-operator tool: create key material, secret deployment env, and a partner-owned V2 policy template; with --identity, wrap the signer's --print-identity output into the public descriptor. Run on your infrastructure; secrets and AWS calls never leave it. Send the descriptor before genesis, then deploy and preflight only after receiving the canonical-context policy bundle.

```
USAGE
  $ scrollsdk signer init --id <value> [--allowed-git-commit <value>] [--allowed-release-version <value>]
    [--allowed-signing-policy-version <value>] [--aws-profile <value>] [--backend local|aws-kms] [--create-key]
    [--force] [--identity <value>] [--json] [--kms-key-id <value>] [--kms-region <value>] [--network
    mainnet|regtest|testnet] [--out <value>]

FLAGS
  --allowed-git-commit=<value>              Production release-policy pin: full 40-character git commit embedded in the
                                            approved signer image; must be paired with --allowed-release-version
  --allowed-release-version=<value>         Production release-policy pin: Cargo release version embedded in the
                                            approved signer image; must be paired with --allowed-git-commit
  --allowed-signing-policy-version=<value>  [default: 1] Signer binary policy version approved by the operator (written
                                            to attestation-signer.env)
  --aws-profile=<value>                     AWS CLI profile for KMS calls (aws-kms backend)
  --backend=<option>                        [default: local] Key backend
                                            <options: local|aws-kms>
  --create-key                              aws-kms backend: create the ECC_SECG_P256K1 signing key in your AWS account
                                            instead of passing --kms-key-id
  --force                                   Overwrite an existing env file; generates a NEW signing key for the local
                                            backend. Do not use to preserve a local identity. Partner-owned TOML is
                                            always retained.
  --id=<value>                              (required) Stable signer identifier (DNS-label shaped, agreed with the
                                            bridge operator)
  --identity=<value>                        File holding the one-line JSON from `attestation_signer --print-identity`;
                                            its network and public key must match this signer. Writes descriptor.json
                                            (identity + id)
  --json                                    Output structured JSON
  --kms-key-id=<value>                      aws-kms backend: key id, ARN, or alias/... of your existing ECC_SECG_P256K1
                                            signing key
  --kms-region=<value>                      aws-kms backend: AWS region of the key
  --network=<option>                        [default: testnet] Dogecoin network
                                            <options: mainnet|regtest|testnet>
  --out=<value>                             Output directory (default: ./signer-<id>)

DESCRIPTION
  Signer-operator tool: create key material, secret deployment env, and a partner-owned V2 policy template; with
  --identity, wrap the signer's --print-identity output into the public descriptor. Run on your infrastructure; secrets
  and AWS calls never leave it. Send the descriptor before genesis, then deploy and preflight only after receiving the
  canonical-context policy bundle.

EXAMPLES
  $ scrollsdk signer init --id partner-a-signer-0 --network testnet

  $ scrollsdk signer init --id partner-a-signer-0 --network testnet --identity signer-partner-a-signer-0/identity.json

  $ scrollsdk signer init --id partner-a-signer-0 --network mainnet --backend aws-kms --kms-key-id arn:aws:kms:... --kms-region us-east-1 --allowed-release-version 0.1.0 --allowed-git-commit 0123456789abcdef0123456789abcdef01234567

  $ scrollsdk signer init --id partner-a-signer-0 --network testnet --backend aws-kms --create-key --kms-region us-east-1 --allowed-release-version 0.1.0 --allowed-git-commit 0123456789abcdef0123456789abcdef01234567
```

_See code: [src/commands/signer/init.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/signer/init.ts)_

## `scrollsdk signer kms-pubkey`

Signer-operator tool: derive the compressed secp256k1 public key of an AWS KMS signing key (the value for ATTESTATION_SIGNER_KMS_EXPECTED_SIGNER_ID). Runs `aws kms get-public-key` with YOUR credentials; nothing is sent anywhere else.

```
USAGE
  $ scrollsdk signer kms-pubkey --key-id <value> --region <value> [--aws-profile <value>] [--json]

FLAGS
  --aws-profile=<value>  AWS CLI profile to use
  --json                 Output structured JSON
  --key-id=<value>       (required) KMS key id, ARN, or alias/... of the ECC_SECG_P256K1 signing key
  --region=<value>       (required) AWS region of the key

DESCRIPTION
  Signer-operator tool: derive the compressed secp256k1 public key of an AWS KMS signing key (the value for
  ATTESTATION_SIGNER_KMS_EXPECTED_SIGNER_ID). Runs `aws kms get-public-key` with YOUR credentials; nothing is sent
  anywhere else.

EXAMPLES
  $ scrollsdk signer kms-pubkey --key-id arn:aws:kms:us-east-1:123456789012:key/abcd-... --region us-east-1

  $ scrollsdk signer kms-pubkey --key-id alias/my-attestation-signer --region eu-west-1 --aws-profile signer-ops
```

_See code: [src/commands/signer/kms-pubkey.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/signer/kms-pubkey.ts)_

## `scrollsdk signer network-check`

Read-only IPv4 overlap check on the Docker signer host, including unused networks; run before deploying signer Compose

```
USAGE
  $ scrollsdk signer network-check --cluster-cidr <value>... [--json] [--proposed-subnet <value>]

FLAGS
  --cluster-cidr=<value>...  (required) VPC, pod or service IPv4 CIDR; repeat for each route the signer must reach
  --json
  --proposed-subnet=<value>  Also check an explicit IPv4 subnet planned for a new Compose network

DESCRIPTION
  Read-only IPv4 overlap check on the Docker signer host, including unused networks; run before deploying signer Compose
```

_See code: [src/commands/signer/network-check.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/signer/network-check.ts)_

## `scrollsdk signer preflight`

Probe your running attestation-signer from your own infrastructure and verify its runtime identity against your descriptor. Signers dial out to the TSO, so the probe targets the signer's local HTTP port. Add --require-production-ready after selecting enforcement=enforce to require dogeos-core attestation_evidence_v2 and all four production capabilities.

```
USAGE
  $ scrollsdk signer preflight [--dir <value>] [--endpoint <value>] [--expected-public-key <value>] [--json]
    [--network mainnet|regtest|testnet] [--require-production-ready]

FLAGS
  --dir=<value>                  signer init output directory; its descriptor.json provides the expected network and
                                 public key
  --endpoint=<value>             [default: http://127.0.0.1:4040] Signer local HTTP base URL to probe (the partner kit
                                 binds 4040 to host loopback; no inbound signer access is required)
  --expected-public-key=<value>  Fail unless the runtime public key equals this compressed secp256k1 key (with --dir,
                                 defaults to the descriptor publicKey)
  --json                         Output structured JSON
  --network=<option>             Expected Dogecoin network (defaults to descriptor network with --dir, else to the
                                 network reported by /health)
                                 <options: mainnet|regtest|testnet>
  --require-production-ready     Also require /ready and /policy to prove all four attestation_evidence_v2 production
                                 capabilities are serving

DESCRIPTION
  Probe your running attestation-signer from your own infrastructure and verify its runtime identity against your
  descriptor. Signers dial out to the TSO, so the probe targets the signer's local HTTP port. Add
  --require-production-ready after selecting enforcement=enforce to require dogeos-core attestation_evidence_v2 and all
  four production capabilities.

EXAMPLES
  $ scrollsdk signer preflight --dir signer-partner-a-signer-0

  $ scrollsdk signer preflight --endpoint http://127.0.0.1:4040 --expected-public-key 02ab... --network mainnet

  $ scrollsdk signer preflight --dir signer-partner-a-signer-0 --require-production-ready
```

_See code: [src/commands/signer/preflight.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/signer/preflight.ts)_

## `scrollsdk test contracts`

Test L2 contracts and preinstalls by checking deployment, initialization and ownership

```
USAGE
  $ scrollsdk test contracts [-c <value>] [-n <value>] [-p] [--preinstalls-image <value>]

FLAGS
  -c, --config=<value>             [default: ./config.toml] Path to config.toml file
  -n, --contracts=<value>          [default: ./config-contracts.toml] Path to config-contracts.toml file
  -p, --pod                        Run inside Kubernetes pod
      --preinstalls-image=<value>  [default: dogeos69/preinstalls:v0.2.2] Preinstalls image used for the additional
                                   runtime codehash check (requires Docker)

DESCRIPTION
  Test L2 contracts and preinstalls by checking deployment, initialization and ownership
```

_See code: [src/commands/test/contracts.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/test/contracts.ts)_

## `scrollsdk test dependencies`

Check for required dependencies

```
USAGE
  $ scrollsdk test dependencies [-d]

FLAGS
  -d, --dev  Include development dependencies

DESCRIPTION
  Check for required dependencies
```

_See code: [src/commands/test/dependencies.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/test/dependencies.ts)_

## `scrollsdk test dogeos [CASENAME]`

Run DogeOS integration tests.

```
USAGE
  $ scrollsdk test dogeos [CASENAME] [--attackValue <value>] [-b <value>] [--l2PrivateKey <value>] [-m <value>]
    [-c <value>] [-v <value>] [--verbose]

ARGUMENTS
  [CASENAME]  The name of the case to run

FLAGS
  -b, --electrs-url=<value>   Electrs/Esplora API URL
  -c, --outputcount=<value>   [default: 24] Number of P2PKH outputs when running the multiple-output scenario
  -m, --masterwif=<value>     [default: cftTTdqFUYi3Njx4VLZGATAFCuX8wetJddD71FGmC91wKJ2XidVY] master wif key, provide
                              test dogecoin
  -v, --outputvalue=<value>   [default: 1000000] Value per P2PKH output (in dogetoshis) when running the multiple-output
                              scenario
      --attackValue=<value>   [default: 100000000000] Output value in dogetoshis for bridge UTXO attack scenario
      --l2PrivateKey=<value>  [default: 0x713137ab6bfaf197200b4f1e033bb3abadaf76564f6b2ca4f00aaa90c3c8efe5]
      --verbose               Enable detailed verbose logging

DESCRIPTION
  Run DogeOS integration tests.

  Available Test Cases:
  - 1: Multiple OP_RETURN - Send a transaction with multiple OP_RETURN outputs
  - 2: Multiple Output - Send a transaction with many P2PKH outputs
  - 3: Bridge UTXO Attack - Simulate a UTXO fan-out attack on the bridge
  - 4: Multiple Withdrawal Per Tx - Test multiple withdrawals in a single L2 transaction
  - 5: Large PSBT - Construct and broadcast a large transaction with many inputs
  - 6: Fee Wallet 2000 Inputs - Send M+1 to the fee wallet using 2000 inputs via an agent
  - 7: Replace Mempool TXs (Master) - Bump-fee replace masterAddress mempool transactions with self-spends
  - 8: CPFP Master Mempool - Use CPFP to bump-fee unconfirmed masterAddress transactions
  - 0: Run All Cases - Execute all test cases sequentially

EXAMPLES
  $ scrollsdk test dogeos

  $ scrollsdk test dogeos multiple-opreturn

  $ scrollsdk test dogeos multiple-output --bridge=n...
```

_See code: [src/commands/test/dogeos.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/test/dogeos.ts)_

## `scrollsdk test e2e`

Test contracts by checking deployment and initialization

```
USAGE
  $ scrollsdk test e2e [-c <value>] [-n <value>] [-m] [-p] [-k <value>] [-r] [-s]

FLAGS
  -c, --config=<value>          [default: ./config.toml] Path to config.toml file
  -k, --private-key=<value>     Private key for funder wallet initialization
  -m, --manual                  Manually fund the test wallet.
  -n, --contracts=<value>       [default: ./config-contracts.toml] Path to configs-contracts.toml file
  -p, --pod                     Run inside Kubernetes pod
  -r, --resume                  Uses e2e_resume.json to continue last run.
  -s, --skip-wallet-generation  Manually fund the test wallet.

DESCRIPTION
  Test contracts by checking deployment and initialization
```

_See code: [src/commands/test/e2e.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/test/e2e.ts)_

## `scrollsdk test ingress`

Check for required ingress hosts and validate frontend URLs

```
USAGE
  $ scrollsdk test ingress [--aws-profile <value>] [-c <value>] [-d] [-n <value>] [--spec <value>] [--values-dir
    <value>]

FLAGS
  -c, --config=<value>       Path to config.toml file
  -d, --dev                  Include development ingresses
  -n, --namespace=<value>    Kubernetes namespace (existing ALB: must match spec)
      --aws-profile=<value>  AWS profile for existing ALB checks
      --spec=<value>         Existing ALB deployment spec; defaults to saved intent or deployment-spec.yaml
      --values-dir=<value>   [default: values]

DESCRIPTION
  Check for required ingress hosts and validate frontend URLs
```

_See code: [src/commands/test/ingress.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/test/ingress.ts)_
<!-- commandsstop -->

## Status-page configuration

Set `monitoring.statusPage.enabled` in the deployment spec; `scrollsdk setup render`
generates local configuration using `metadata.environment`. Use
`scrollsdk monitoring status-page --plan` for a read-only Instatus comparison and
`--apply` for explicit page/component reconciliation. See [the status-page workflow](docs/status-page.md) for configuration,
Secret ownership and rollout boundaries. `scroll-monitor` owns ongoing health
evaluation and status publication.

Use `--plan --create-webhook` followed by `--apply --create-webhook` for first
Grafana webhook initialization. The CLI obtains the URL from Instatus and saves
a private binding plus a Kubernetes Secret artifact under
`secrets/status-page/`. Later `--apply` runs reuse it. Apply the
Secret separately in the existing Grafana namespace; public routing remains
disabled until configured. Back up this private directory; recovery/import and
the limits of remote integration discovery are documented in the workflow above.
