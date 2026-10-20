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
* [`scrollsdk check prerequisites`](#scrollsdk-check-prerequisites)
* [`scrollsdk doge wallet new`](#scrollsdk-doge-wallet-new)
* [`scrollsdk doge wallet send`](#scrollsdk-doge-wallet-send)
* [`scrollsdk doge wallet sync`](#scrollsdk-doge-wallet-sync)
* [`scrollsdk help [COMMAND]`](#scrollsdk-help-command)
* [`scrollsdk helper activity`](#scrollsdk-helper-activity)
* [`scrollsdk helper clear-accounts`](#scrollsdk-helper-clear-accounts)
* [`scrollsdk helper derive-enode NODEKEY`](#scrollsdk-helper-derive-enode-nodekey)
* [`scrollsdk helper fund-accounts`](#scrollsdk-helper-fund-accounts)
* [`scrollsdk helper set-scalars`](#scrollsdk-helper-set-scalars)
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
* [`scrollsdk setup attestation-signer`](#scrollsdk-setup-attestation-signer)
* [`scrollsdk setup bootnode-public-p2p`](#scrollsdk-setup-bootnode-public-p2p)
* [`scrollsdk setup bridge-init`](#scrollsdk-setup-bridge-init)
* [`scrollsdk setup cubesigner-init`](#scrollsdk-setup-cubesigner-init)
* [`scrollsdk setup cubesigner-policy handoff`](#scrollsdk-setup-cubesigner-policy-handoff)
* [`scrollsdk setup cubesigner-policy import`](#scrollsdk-setup-cubesigner-policy-import)
* [`scrollsdk setup cubesigner-policy import-acceptance`](#scrollsdk-setup-cubesigner-policy-import-acceptance)
* [`scrollsdk setup cubesigner-policy prepare`](#scrollsdk-setup-cubesigner-policy-prepare)
* [`scrollsdk setup cubesigner-policy prepare-input`](#scrollsdk-setup-cubesigner-policy-prepare-input)
* [`scrollsdk setup cubesigner-policy prepare-session`](#scrollsdk-setup-cubesigner-policy-prepare-session)
* [`scrollsdk setup cubesigner-policy reconcile`](#scrollsdk-setup-cubesigner-policy-reconcile)
* [`scrollsdk setup cubesigner-policy verify-activation`](#scrollsdk-setup-cubesigner-policy-verify-activation)
* [`scrollsdk setup cubesigner-refresh`](#scrollsdk-setup-cubesigner-refresh)
* [`scrollsdk setup db-init`](#scrollsdk-setup-db-init)
* [`scrollsdk setup deployment-preflight`](#scrollsdk-setup-deployment-preflight)
* [`scrollsdk setup dstack-config`](#scrollsdk-setup-dstack-config)
* [`scrollsdk setup doge-config`](#scrollsdk-setup-doge-config)
* [`scrollsdk setup dogecoin-wallet-import`](#scrollsdk-setup-dogecoin-wallet-import)
* [`scrollsdk setup domains`](#scrollsdk-setup-domains)
* [`scrollsdk setup eth-da-submitter`](#scrollsdk-setup-eth-da-submitter)
* [`scrollsdk setup export-deployment-kit`](#scrollsdk-setup-export-deployment-kit)
* [`scrollsdk setup gen-keystore`](#scrollsdk-setup-gen-keystore)
* [`scrollsdk setup gen-l2-artifacts`](#scrollsdk-setup-gen-l2-artifacts)
* [`scrollsdk setup gen-rpc-package`](#scrollsdk-setup-gen-rpc-package)
* [`scrollsdk setup gen-secrets`](#scrollsdk-setup-gen-secrets)
* [`scrollsdk setup generate-from-spec`](#scrollsdk-setup-generate-from-spec)
* [`scrollsdk setup policy-prepare`](#scrollsdk-setup-policy-prepare)
* [`scrollsdk setup prep-charts`](#scrollsdk-setup-prep-charts)
* [`scrollsdk setup proof-aws-init`](#scrollsdk-setup-proof-aws-init)
* [`scrollsdk setup proof-bundle-publish`](#scrollsdk-setup-proof-bundle-publish)
* [`scrollsdk setup proof-config-check`](#scrollsdk-setup-proof-config-check)
* [`scrollsdk setup proof-image-tools`](#scrollsdk-setup-proof-image-tools)
* [`scrollsdk setup proof-materials`](#scrollsdk-setup-proof-materials)
* [`scrollsdk setup proof-publish`](#scrollsdk-setup-proof-publish)
* [`scrollsdk setup protocol-context`](#scrollsdk-setup-protocol-context)
* [`scrollsdk setup proof-release-prepare`](#scrollsdk-setup-proof-release-prepare)
* [`scrollsdk setup proof-topology-compile`](#scrollsdk-setup-proof-topology-compile)
* [`scrollsdk setup proof-worker`](#scrollsdk-setup-proof-worker)
* [`scrollsdk setup proof-worker-check`](#scrollsdk-setup-proof-worker-check)
* [`scrollsdk setup proof-worker-image-check`](#scrollsdk-setup-proof-worker-image-check)
* [`scrollsdk setup push-secrets`](#scrollsdk-setup-push-secrets)
* [`scrollsdk setup render`](#scrollsdk-setup-render)
* [`scrollsdk setup signer-kit`](#scrollsdk-setup-signer-kit)
* [`scrollsdk setup signer-kit-publish`](#scrollsdk-setup-signer-kit-publish)
* [`scrollsdk setup tls`](#scrollsdk-setup-tls)
* [`scrollsdk setup upload-secrets`](#scrollsdk-setup-upload-secrets)
* [`scrollsdk setup verify-contracts`](#scrollsdk-setup-verify-contracts)
* [`scrollsdk signer init`](#scrollsdk-signer-init)
* [`scrollsdk signer kms-pubkey`](#scrollsdk-signer-kms-pubkey)
* [`scrollsdk signer preflight`](#scrollsdk-signer-preflight)
* [`scrollsdk test contracts`](#scrollsdk-test-contracts)
* [`scrollsdk test dependencies`](#scrollsdk-test-dependencies)
* [`scrollsdk test dogeos [CASENAME]`](#scrollsdk-test-dogeos-casename)
* [`scrollsdk test e2e`](#scrollsdk-test-e2e)
* [`scrollsdk test ingress`](#scrollsdk-test-ingress)

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

Sync wallet UTXOs and balance using Electrs/Esplora.

```text
USAGE
  $ scrollsdk doge wallet sync [-c <value>] [-p <value>] [--electrs-url <value>]

FLAGS
  -c, --config=<value>       Path to Dogecoin config file
  -p, --path=<value>         Wallet file path (overrides wallet.path)
      --electrs-url=<value> Electrs/Esplora API URL
```

The endpoint comes from `--electrs-url`, optional `rpc.electrsAPIUrl`, or the
existing testnet Electrs default. Mainnet and regtest require an explicit
endpoint. Setup does not prompt for or require an indexer configuration.

```bash
scrollsdk doge wallet sync --config .data/doge-config.toml --electrs-url http://localhost:3002
```

_See code: [src/commands/doge/wallet/sync.ts](src/commands/doge/wallet/sync.ts)_

## `scrollsdk help [COMMAND]`

Display help for scrollsdk.

```
USAGE
  $ scrollsdk help [COMMAND...] [-n]

ARGUMENTS
  COMMAND...  Command to show help for.

FLAGS
  -n, --nested-commands  Include all nested commands in the output.

DESCRIPTION
  Display help for scrollsdk.
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/v6.2.15/src/commands/help.ts)_

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

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.4/src/commands/plugins/index.ts)_

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

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.4/src/commands/plugins/inspect.ts)_

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

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.4/src/commands/plugins/install.ts)_

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

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.4/src/commands/plugins/link.ts)_

## `scrollsdk plugins remove [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ scrollsdk plugins remove [PLUGIN...] [-h] [-v]

ARGUMENTS
  PLUGIN...  plugin to uninstall

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

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.4/src/commands/plugins/reset.ts)_

## `scrollsdk plugins uninstall [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ scrollsdk plugins uninstall [PLUGIN...] [-h] [-v]

ARGUMENTS
  PLUGIN...  plugin to uninstall

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

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.4/src/commands/plugins/uninstall.ts)_

## `scrollsdk plugins unlink [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ scrollsdk plugins unlink [PLUGIN...] [-h] [-v]

ARGUMENTS
  PLUGIN...  plugin to uninstall

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

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.4/src/commands/plugins/update.ts)_

## `scrollsdk setup attestation-signer`

Import signer-init descriptors from partner-operated attestation-signers and select the bootstrap bridge keyset. This command consumes only the attestation and transport public keys and never provisions keys, deployments, or network probes. Signers dial out to the TSO, so no signer endpoint is imported. Current dogeos-core runtime preflight occurs after partners install the post-genesis canonical-context bundle.

```
USAGE
  $ scrollsdk setup attestation-signer [--active-signer-ids <value>] [-c <value>] [--descriptor <value>...] [--descriptor-dir
    <value>] [--json] [--threshold <value>]

FLAGS
  -c, --config=<value>             Path to doge-config.toml
      --active-signer-ids=<value>  Comma-separated signer IDs entering initial bridge setup (default: every imported
                                   descriptor)
      --descriptor=<value>...      attestation-signer-descriptor JSON file; repeat per signer
      --descriptor-dir=<value>     Directory whose *.json files are all loaded as descriptors (default: descriptors/
                                   when it exists and no --descriptor is given)
      --json                       Output structured JSON
      --threshold=<value>          Initial bridge attestation threshold (T of the active set)

DESCRIPTION
  Import signer-init descriptors from partner-operated attestation-signers and select the bootstrap bridge keyset. This
  command consumes only the attestation and transport public keys and never provisions keys, deployments, or
  network probes. Signers dial out to the TSO, so no signer endpoint is imported. Current dogeos-core runtime
  preflight occurs after partners install the post-genesis canonical-context bundle.

EXAMPLES
  $ scrollsdk setup attestation-signer --descriptor partner-a.json --descriptor partner-b.json --descriptor ours.json --threshold 2

  $ scrollsdk setup attestation-signer --descriptor-dir descriptors/ --threshold 3 --active-signer-ids partner-a,partner-b,ours-0
```

_See code: [src/commands/setup/attestation-signer.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/attestation-signer.ts)_

## `scrollsdk setup bootnode-public-p2p`

Update selected bootnode bindings from an explicit spec and discover public enodes.
See [Reth bootnode public P2P access](docs/bootnode-public-p2p.md).

```text
Generate selected bootnode P2P bindings from spec and discover public enodes using read-only AWS queries

USAGE
  $ scrollsdk setup bootnode-public-p2p --spec <value> [--aws-profile <value>] [--dir
    <value>] [--doge-config <value>] [--dry-run] [--json] [-N] [--values-dir
    <value>]

FLAGS
  -N, --non-interactive      Compatibility flag; this command never prompts
  --aws-profile=<value>
      --dir=<value>          [default: .] Deployment directory; relative paths
                             resolve here
      --doge-config=<value>  [default: .data/doge-config.toml] Existing saved
                             public bootnode identities; never creates keys
      --dry-run              Validate and show endpoints without writing values
  --json
      --spec=<value>         (required) Editable deployment spec (no implicit
                             saved-intent fallback)
      --values-dir=<value>   [default: values] Directory containing existing
                             indexed bootnode production values

DESCRIPTION
  Generate selected bootnode P2P bindings from spec and discover public enodes
  using read-only AWS queries

EXAMPLES
  $ scrollsdk setup bootnode-public-p2p --spec ../deployment-spec.yaml --dry-run

  $ scrollsdk setup bootnode-public-p2p --spec ../deployment-spec.yaml
```

## `scrollsdk setup bridge-init`

Initialize DogeOS bridge after L2 artifacts and CubeSigner keys are ready

```
USAGE
  $ scrollsdk setup bridge-init [--docker-platform <value>] [--image-tag <value>] [--json] [--kube-context <value>]
    [-N] [-s <value>] [--step <value>]

FLAGS
  -N, --non-interactive
      Run without prompts. Requires --seed for --step all or --step 1-prepare.

  -s, --seed=<value>
      seed which will regenerate the sequencer and fee wallet

  --docker-platform=<value>
      [default: linux/amd64] Docker platform for bridge-genesis-tools image.

  --image-tag=<value>
      Specify the Docker image tag to use (defaults to dev-20260707-043e7f3)

  --json
      Output in JSON format (stdout for data, stderr for logs)

  --kube-context=<value>
      Explicit Kubernetes context for the Ethereum DA RPC probe (defaults to KUBE_CONTEXT).

  --step=<value>
      [default: all] Bridge init step to run. all runs 1-prepare, 2-setup, 3-bridge-info, 4-fund, and 5-protocol-context.
      1-prepare requires values/genesis.yaml, extracts .data/genesis.json, and prepares protocol_seed.toml. 2-setup is NOT
      idempotent: generate test keys and broadcast the setup transaction. 3-bridge-info is idempotent: generate namespace
      and bridge.json. 4-fund is NOT idempotent: broadcast the configured bridge-funding and/or deposit-seed transactions.
      5-protocol-context is idempotent: generate protocol_context.json. Numeric aliases 1, 2, 3, 4, and 5 are accepted.

DESCRIPTION
  Initialize DogeOS bridge after L2 artifacts and CubeSigner keys are ready

EXAMPLES
  $ scrollsdk setup bridge-init

  $ scrollsdk setup bridge-init --step 1-prepare

  $ scrollsdk setup bridge-init --step 2-setup

  $ scrollsdk setup bridge-init --step 3-bridge-info

  $ scrollsdk setup bridge-init --step 4-fund

  $ scrollsdk setup bridge-init --step 5-protocol-context

  $ scrollsdk setup bridge-init --step 2

  $ scrollsdk setup bridge-init -s 123456

  $ scrollsdk setup bridge-init --seed 123456

  $ scrollsdk setup bridge-init --image-tag dev-20260707-043e7f3

  $ scrollsdk setup bridge-init --non-interactive --seed 123456 --image-tag dev-20260707-043e7f3

  $ scrollsdk setup bridge-init --non-interactive --seed 123456 --image-tag dev-20260707-043e7f3 --docker-platform linux/amd64

  $ scrollsdk setup bridge-init --non-interactive --json --seed 123456
```

_See code: [src/commands/setup/bridge-init.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/bridge-init.ts)_

## `scrollsdk setup cubesigner-init`

Setup a CubeSigner TEE key and role, preserving the provider key and dogeos-core compressed identity

```
USAGE
  $ scrollsdk setup cubesigner-init [--count <value>] [--doge-config <value>] [--json] [--new] [-N] [--role-prefix <value>]
    [--roles <value>...] [--threshold <value>]

FLAGS
  -N, --non-interactive      Run without prompts. Requires --doge-config and either --new (with --role-prefix) or
                             --roles.
      --count=<value>        Number of TEE keys/roles to create (must be 1; default 1)
      --doge-config=<value>  Path to Dogecoin config file
      --json                 Output in JSON format (stdout for data, stderr for logs)
      --new                  Create new roles and keys
      --role-prefix=<value>  Prefix for role names (when using --new)
      --roles=<value>...     Comma-separated list of existing role names to use
      --threshold=<value>    Deprecated; ignored because cubesigner-init configures the single TEE key.

DESCRIPTION
  Setup a CubeSigner TEE key and role, preserving the provider key and dogeos-core compressed identity

EXAMPLES
  $ scrollsdk setup cubesigner-init --roles tee_role

  $ scrollsdk setup cubesigner-init --new --role-prefix tee

  $ scrollsdk setup cubesigner-init --roles tee_role --doge-config .data/doge-config.toml

  $ scrollsdk setup cubesigner-init

  $ scrollsdk setup cubesigner-init --non-interactive --new --role-prefix tee --doge-config .data/doge-config.toml

  $ scrollsdk setup cubesigner-init --non-interactive --json --roles tee_role --doge-config .data/doge-config.toml
```

_See code: [src/commands/setup/cubesigner-init.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/cubesigner-init.ts)_

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
  --organization=<value>              (required)
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

Read back an already attached immutable policy and generate the release/attachment
receipts consumed by staged preparation. Preserves the role restriction; performs
no provider mutation or signing. Requires reviewed release and test evidence.

```sh
scrollsdk setup cubesigner-policy reconcile --dir deployment --input .data/policy-review.json --json
```

See the [external policy runbook](docs/cubesigner-external-policy.md#4-reconcile-an-already-approved-attachment)
for the input format, permission requirements, validation and resumption steps.

## `scrollsdk setup cubesigner-policy import`

Import an existing externally built policy Wasm into staged preparation without
building, publishing, attaching, or changing preparation checkpoints.

```text
USAGE
  $ scrollsdk setup cubesigner-policy import --dir deployment
    --wasm <deployment-relative-path> --expected-wasm-sha256 <sha256>
    --expected-protocol-context-sha256 <sha256> --core-revision <commit>
    --build-script-revision <commit> --source-repo <core-repository> [--json]
```

See the [external policy runbook](docs/cubesigner-external-policy.md) for build
provenance, Council approval, receipt boundaries, and signer-side acceptance.
The import checks local evidence; it does not assert governance or live tests passed.

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

_See code: [src/commands/setup/cubesigner-policy/verify-activation.ts](src/commands/setup/cubesigner-policy/verify-activation.ts)_

## `scrollsdk setup cubesigner-refresh`

Refresh cubesigner session secrets

```
USAGE
  $ scrollsdk setup cubesigner-refresh [--doge-config <value>] [--email <value>] [--environment <value>] [--json] [-N]
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
  Refresh cubesigner session secrets

  Generated signer sessions use fixed service lifetimes:
  session-lifetime=31536000s (365 days), auth-lifetime=7200s (2 hours), refresh-lifetime=604800s (7 days), and
  grace-lifetime=30s.

  This command writes local files under ./secrets. Push the refreshed secrets with setup push-secrets --cubesigner-only,
  then restart CubeSigner signer pods after clearing /app/.sessions/main_cs_session.json so the new Secret seed is
  copied into the active session cache.

EXAMPLES
  $ scrollsdk setup cubesigner-refresh

  $ scrollsdk setup cubesigner-refresh --doge-config .data/doge-config.toml

  $ scrollsdk setup cubesigner-refresh --non-interactive --doge-config .data/doge-config.toml

  $ scrollsdk setup cubesigner-refresh --non-interactive --json --doge-config .data/doge-config.toml --org-id Org#xxx --email user@example.com
```

_See code: [src/commands/setup/cubesigner-refresh.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/cubesigner-refresh.ts)_

## `scrollsdk setup db-init`

Initialize Blockscout and dstack PostgreSQL databases, or update their permissions

```
USAGE
  $ scrollsdk setup db-init [-c] [-d] [--json] [-N] [-u] [--update-port <value>]
    [--databases blockscout|dstack] [--doge-config <value>]

FLAGS
  -N, --non-interactive      Run without prompts, using config.toml values. Requires [db.admin] section with
                             PUBLIC_HOST, PUBLIC_PORT, USERNAME, PASSWORD (or $ENV: refs)
  -c, --clean                Recreate selected databases and reset their user passwords
  -d, --debug                Show debug output including SQL queries
  -u, --update-permissions   Update permissions for existing users
      --json                 Output in JSON format (stdout for data, stderr for logs)
      --databases=<option>   Initialize only selected services; repeat to select both
      --doge-config=<value>  Doge config containing dstackController; defaults to .data/doge-config.toml
      --update-port=<value>  Update the port of current database values

DESCRIPTION
  Initialize Blockscout and dstack PostgreSQL databases, or update their permissions

EXAMPLES
  $ scrollsdk setup db-init

  $ scrollsdk setup db-init --update-permissions

  $ scrollsdk setup db-init --update-permissions --debug

  $ scrollsdk setup db-init --clean

  $ scrollsdk setup db-init --update-port=25061

  $ scrollsdk setup db-init --non-interactive

  $ scrollsdk setup db-init --databases dstack --non-interactive

  $ scrollsdk setup db-init --non-interactive --json --clean
```

_See code: [src/commands/setup/db-init.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/db-init.ts)_

## `scrollsdk setup deployment-preflight`

Check deployment inputs, with explicit optional cluster/RPC probes and isolated local Reth startup

```
USAGE
  $ scrollsdk setup deployment-preflight [--deployment-dir <value>] [--doge-config <value>] [--dogecoin-rpc-env <value>
    --signer-container <value>] [--dstack-deployment <value>] [--ethereum-chain-id <value>] [--ethereum-rpc-env
    <value>...] [--ethereum-rpc-quorum <value>] [--json] [--namespace <value>] [--rendered-manifest <value>...
    --kube-context <value>] [--require-dstack] [--reth-image <value>]

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
  --kube-context=<value>          Explicit context for optional read-only dstack runtime check; omitted means no
                                  Kubernetes calls
  --namespace=<value>             [default: default]
  --rendered-manifest=<value>...  Rendered Helm manifest to check against cluster resources and ALB prerequisites;
                                  repeat for each release
  --require-dstack                Treat missing controller configuration/values as an error
  --reth-image=<value>            Run an isolated local startup canary for this exact Reth image with the deployment
                                  genesis; no network or persistent data
  --signer-container=<value>      Probe Dogecoin RPC from this running container network namespace using a disposable
                                  curl container

DESCRIPTION
  Check deployment inputs, with explicit optional cluster/RPC probes and isolated local Reth startup
```

_See code: [src/commands/setup/deployment-preflight.ts](src/commands/setup/deployment-preflight.ts)_

## `scrollsdk setup doge-config`

Configure Dogecoin/DA settings and optionally initialize compiler-backed proof topology

The base configuration flow also configures Grafana's admin username (default
`admin`) and password. It offers secure password generation or masked manual
entry, and preserves an existing password unless you choose to replace it.
Non-interactive runs generate a password only when none is configured. The
`--proof-topology` shortcut for an existing configuration leaves these credentials
unchanged.

Credentials are stored in the selected doge-config file under `[grafana]` as
`adminUser` and `adminPassword`. You can set `adminPassword = "$ENV:GRAFANA_ADMIN_PASSWORD"`
to keep an environment reference in the configuration; it is resolved by
`setup gen-secrets`. Local credential files use mode `0600`, are excluded from Git
before writing, and cannot overwrite Git-tracked files.

The normal `setup gen-secrets` flow generates `secrets/grafana-admin.yaml`, matching
the scroll-monitor example's `grafana.admin.existingSecret: grafana-admin`, with
keys `admin-user` and `admin-password`. `setup prep-charts` writes that reference
into scroll-monitor values and removes inline admin credentials. Optional
`[grafana]` fields `existingSecret`, `userKey`, and `passwordKey` customize both
outputs. Configurations without `[grafana]` retain their existing behavior.

Apply the generated Secret in the scroll-monitor release namespace before
installation, for example `kubectl -n <monitoring-namespace> apply -f secrets/grafana-admin.yaml`.
This YAML is applied directly; `setup push-secrets` handles ENV/JSON files and does
not publish it. These commands prepare bootstrap credentials and do not reset the
password in an already running Grafana database.

```
USAGE
  $ scrollsdk setup doge-config [-c <value>] [--json] [-N] [--proof-artifact-source existing-s3|prepared-aws
    --proof-topology] [--proof-bucket <value> ] [--proof-coordinator-url <value> ] [--proof-endpoint-url <value> ]
    [--proof-enforcement observe|enforce ] [--proof-force-path-style ] [--proof-generation mock|real ]
    [--proof-key-prefix <value> ] [--proof-materials <value> ] [--proof-mode active|disabled ]
    [--proof-observe-real-proof-deadline-ms <value> ] [--proof-public-s3-endpoint <value> ] [--proof-region <value> ]
    [--proof-topology-compiler-binary <value> ] [--proof-witness-dir <value> ] [--proof-witness-rpc-url <value> ]
    [--proof-witness-source block_witness_dir|rpc ] [--proof-worker-deployment-backend docker_compose|kubernetes ]
    [--proof-worker-launch external|local_cpu|local_cuda ]

FLAGS
  -N, --non-interactive                               Run without prompts, using existing config values
  -c, --config=<value>                                Path to config file
      --json                                          Output in JSON format (stdout for data, stderr for logs)
      --proof-artifact-source=<option>                Artifact resource source used by --proof-topology
                                                      <options: existing-s3|prepared-aws>
      --proof-bucket=<value>                          Existing S3-compatible proof artifact bucket
      --proof-coordinator-url=<value>                 HTTPS Proof Coordinator URL reachable by production Workers
      --proof-endpoint-url=<value>                    Worker-visible S3-compatible endpoint root
      --proof-enforcement=<option>                    Proof enforcement switch; keep observe until real proofs are
                                                      validated
                                                      <options: observe|enforce>
      --[no-]proof-force-path-style                   Use path-style S3 object URLs for an existing compatible store
      --proof-generation=<option>                     Proof generation implementation selected for active services
                                                      <options: mock|real>
      --proof-key-prefix=<value>                      Base proof artifact key prefix before compiler digest scoping
      --proof-materials=<value>                       Prepared proof-materials-v1.json receipt
      --proof-mode=<option>                           Initial proof mode (default: existing value or disabled)
                                                      <options: active|disabled>
      --proof-observe-real-proof-deadline-ms=<value>  Required positive observe fallback deadline in milliseconds; also
                                                      required for mock (no default)
      --proof-public-s3-endpoint=<value>              External Worker/signer-visible S3 endpoint when different from the
                                                      store endpoint
      --proof-region=<value>                          Existing S3-compatible proof artifact region
      --proof-topology                                Initialize or replace compiler-backed proof topology
      --proof-topology-compiler-binary=<value>        Development-only local dogeos-proof-topology binary used for both
                                                      initialization preflights
      --proof-witness-dir=<value>                     Production block witness directory relative to the prepared
                                                      material root
      --proof-witness-rpc-url=<value>                 Scroll witness RPC URL used when --proof-witness-source=rpc
      --proof-witness-source=<option>                 Chunk witness source used by real materialization
                                                      <options: block_witness_dir|rpc>
      --proof-worker-deployment-backend=<option>      Deployment adapter backend for local_cpu/local_cuda Workers
                                                      <options: docker_compose|kubernetes>
      --proof-worker-launch=<option>                  Staged real Worker compute/ownership placement from the
                                                      dogeos-core contract
                                                      <options: external|local_cpu|local_cuda>

DESCRIPTION
  Configure Dogecoin/DA settings and optionally initialize compiler-backed proof topology

EXAMPLES
  $ scrollsdk setup doge-config

  $ scrollsdk setup doge-config --config .data/doge-config.toml

  $ scrollsdk setup doge-config --proof-topology

  $ scrollsdk setup doge-config --proof-topology --proof-mode disabled --proof-generation mock --proof-enforcement observe

  $ scrollsdk setup doge-config --proof-topology --proof-mode active --proof-generation mock

  $ scrollsdk setup doge-config --non-interactive

  $ scrollsdk setup doge-config --non-interactive --json
```

_See code: [src/commands/setup/doge-config.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/doge-config.ts)_

## `scrollsdk setup dogecoin-wallet-import`

Dogecoin wallet import

```
USAGE
  $ scrollsdk setup dogecoin-wallet-import [--all-replicas] [--doge-config <value>] [--image-tag <value>] [--namespace <value>]
    [--replicas <value>] [--rpc-password <value>] [--rpc-port <value>] [--rpc-url <value>] [--rpc-user <value>]
    [--service-name <value>]

FLAGS
  --all-replicas          Import watch-only addresses into every Dogecoin StatefulSet replica using in-cluster pod DNS
  --doge-config=<value>   Path to Dogecoin config file
  --image-tag=<value>     Docker image tag
  --namespace=<value>     [default: default] Kubernetes namespace for --all-replicas mode
  --replicas=<value>      Dogecoin replica count for --all-replicas mode. Defaults to the StatefulSet replica count.
  --rpc-password=<value>  Dogecoin RPC password
  --rpc-port=<value>      Dogecoin RPC port for --all-replicas mode
  --rpc-url=<value>       Dogecoin RPC URL
  --rpc-user=<value>      Dogecoin RPC username
  --service-name=<value>  Stable Dogecoin Kubernetes service name for --all-replicas mode

DESCRIPTION
  Dogecoin wallet import
```

_See code: [src/commands/setup/dogecoin-wallet-import.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/dogecoin-wallet-import.ts)_

## `scrollsdk setup domains`

Set up domain configurations for external services

```
USAGE
  $ scrollsdk setup domains [--json] [-N] [--values-dir <value>]

FLAGS
  -N, --non-interactive         Run without prompts, using config.toml values
      --json                    Output in JSON format (stdout for data, stderr for logs)
      --values-dir=<value>      [default: values] Directory containing Helm values files to prepare for bootstrap charts

DESCRIPTION
  Set up domain configurations for external services

EXAMPLES
  $ scrollsdk setup domains

  $ scrollsdk setup domains --non-interactive

  $ scrollsdk setup domains --non-interactive --json
```

_See code: [src/commands/setup/domains.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/domains.ts)_

## `scrollsdk setup eth-da-submitter`

```text
Configure the eth-da-submitter S3 archive and optional writer IAM permissions

USAGE
  $ scrollsdk setup eth-da-submitter [--archive-bucket <value>]
    [--archive-key-prefix <value>] [--archive-public-base-url <value>]
    [--archive-region <value>] [--aws-profile <value>] [--aws-region <value>]
    [--create-archive-bucket] [--disable-archive] [--doge-config <value>]
    [--json] [-N] [--role-arn <value>]

FLAGS
  -N, --non-interactive
      --archive-bucket=<value>           S3 blob archive bucket.
      --archive-key-prefix=<value>       Deployment prefix for raw DA blobs; proof sidecars use proofArtifacts.s3.
                                        Core owns the relative object paths.
      --archive-public-base-url=<value>  Public HTTPS base URL used by blob
                                         consumers.
      --archive-region=<value>           Region owning the archive bucket.
      --aws-profile=<value>              AWS profile for archive resource
                                         operations.
      --aws-region=<value>               Fallback archive region; existing
                                         archive region takes precedence.
      --[no-]create-archive-bucket       Create/reuse the bucket. Defaults to
                                         enabled for a configured AWS KMS
                                         submitter, disabled for a local signer.
      --disable-archive                  Disable archive configuration without
                                         deleting buckets or IAM policies.
      --doge-config=<value>              Dogecoin configuration file.
  --json
      --role-arn=<value>                 Existing archive writer IAM role.
                                         Defaults to the submitter signer
                                         service-account role.

DESCRIPTION
  Configure the eth-da-submitter S3 archive and optional writer IAM permissions

EXAMPLES
  $ scrollsdk setup eth-da-submitter --archive-bucket dogeos-da --archive-region us-east-1 --archive-key-prefix devnet -N

  $ scrollsdk setup eth-da-submitter --no-create-archive-bucket --role-arn arn:aws:iam::123456789012:role/archive-writer -N

  $ scrollsdk setup eth-da-submitter --disable-archive -N
```

See [deployment signing identities](docs/keystore.md) for scope, repeat execution,
and the separate archive workflow.

## `scrollsdk setup export-deployment-kit`

Export the signer deployment kit from the selected proof deployment contract and its bound materials receipt; its version is derived from the signer-relevant inputs. Publish it unchanged, then record the publication with --published-url

```
USAGE
  $ scrollsdk setup export-deployment-kit [-c <value>] [--contract <value>] [--json] [--out <value>]
    [--protocol-context <value>] [--published-url <value>] [--signer-proof-artifact-base-url <value>] [--spec <value>]
    [--tso-url <value>]

FLAGS
  -c, --config=<value>                          Path to doge-config.toml
      --contract=<value>                        [default: .data/proof-deployment.json] Selected deployment contract;
                                                binds the materials receipt and protocol context
      --json                                    Output structured JSON
      --out=<value>                             Kit output directory [default: deployment-kit-<kit version>]; an
                                                existing one must already hold this exact kit
      --protocol-context=<value>                [default: .data/protocol_context.json] Canonical protocol_context.json
                                                produced by setup bridge-init
      --published-url=<value>                   https URL where this exact kit is published; records it in
                                                doge-config [attestationSigner.deploymentKit]. Uses the deployment
                                                inputs only: not with --out, --tso-url or
                                                --signer-proof-artifact-base-url
      --signer-proof-artifact-base-url=<value>  Public GET base used by signers; default: compiler output in
                                                withdrawal-processor/WithdrawalProcessor.toml
      --spec=<value>                            Optional DeploymentSpec proof source; conflicts with doge-config
                                                [proof_topology]
      --tso-url=<value>                         TSO base URL reachable from signer networks; default: config.toml
                                                [ingress].TSO_HOST

DESCRIPTION
  Export the signer deployment kit from the selected proof deployment contract and its bound materials receipt; its
  version is derived from the signer-relevant inputs. Publish it unchanged, then record the publication with
  --published-url

EXAMPLES
  $ scrollsdk setup export-deployment-kit

  $ scrollsdk setup export-deployment-kit --published-url https://downloads.dogeos.example/deployment-kit-k-0123456789ab.tar.gz
```

The kit directory holds `deployment-kit.json`, `deployment-kit.env`,
`protocol_context.json`, `advance-l2-agg-verifying-key.bin` and
`deployment-kit-manifest.json`. Its identity is the SHA-256 of
`deployment-kit-manifest.json`, which the command prints with the network,
`protocol_instance_id` and kit version for the deployment record. The version,
`k-<12 hex>`, is derived from the signer-relevant fields (network, protocol
instance, TSO URL, artifact origin, policy mode, protocol context and verifier
material), so the same inputs always give the same kit and a rerun is a no-op;
a changed endpoint or verifier gives a new version. The kit holds no signer
roster, current Bridge key or rotation material, so an ordinary attestation
rotation needs no new kit. `setup apply` produces the same kit for enforcing
deployments.

_See code: [src/commands/setup/export-deployment-kit.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/export-deployment-kit.ts)_

## `scrollsdk setup gen-keystore`

```text
Prepare Reth node and service signing identities using local keys or AWS KMS

USAGE
  $ scrollsdk setup gen-keystore [--aws-profile <value>] [--aws-region <value>]
    [--doge-config <value>] [--eks-cluster <value>] [-i <value>] [--json]
    [--kms-key-id <value>] [--namespace <value>] [--network-alias <value>]
    [--nodekey <value>] [--nodekey-secret-mode external-secret|plain] [-N]
    [--role-arn <value>] [--service-account <value>] [--signer-mode
    aws-kms|external-secret|plain] [--signer-private-key <value>] [--accounts]
    [--activity-helper] [--bootnode-count <value>] [--from-spec <value>]
    [--secret-mode external-secret|plain] [--sequencer-count <value>] [--service
    sequencer-reth|bootnode-reth|fee-oracle|eth-da-submitter] [--signer-backend
    local|aws-kms]

FLAGS
  -N, --non-interactive               Run without prompts. Generates missing
                                      local keys.
  -i, --index=<value>                 One sequencer index; requires --service
                                      sequencer-reth.
      --[no-]accounts                 Also prepare/reuse the deployer account in
                                      config.toml and validate an existing
                                      OWNER_ADDR.
      --activity-helper               Also prepare the optional testnet activity
                                      account in config.toml.
      --aws-profile=<value>           AWS CLI profile to use for KMS signer
                                      provisioning.
      --aws-region=<value>            AWS region for the EKS cluster and KMS
                                      key.
      --bootnode-count=<value>        Prepare Reth bootnode indices 0 through
                                      count-1; never deletes existing
                                      identities.
      --doge-config=<value>           Path to Dogecoin config file (defaults to
                                      .data/doge-config.toml)
      --eks-cluster=<value>           EKS cluster name or ARN used for IRSA
                                      trust binding.
      --from-spec=<value>             Use DeploymentSpec node counts after
                                      generating doge-config from that spec.
      --json                          Output in JSON format (stdout for data,
                                      stderr for logs)
      --kms-key-id=<value>            Existing KMS key id, ARN, or alias for the
                                      reth sequencer signer.
      --namespace=<value>             [default: default] Kubernetes namespace
                                      for the KMS signer service account.
      --network-alias=<value>         Resource alias used to derive
                                      deterministic KMS aliases and IAM role
                                      names.
      --nodekey=<value>               Existing reth P2P nodekey private key as
                                      64 hex chars, with or without 0x.
      --nodekey-secret-mode=<option>  How P2P nodekey material is referenced
                                      from values YAML. AWS KMS signer mode
                                      only; local signer mode uses
                                      --signer-mode.
                                      <options: external-secret|plain>
      --role-arn=<value>              Existing IAM role ARN to annotate on the
                                      sequencer service account.
      --secret-mode=<option>          Secret reference mode for the selected
                                      Reth node.
                                      <options: external-secret|plain>
      --sequencer-count=<value>       Prepare Reth sequencer indices 0 through
                                      count-1; never deletes existing
                                      identities.
      --service=<option>              Prepare only this service. Omit to select
                                      services interactively; -N/--json
                                      processes declared identities.
                                      <options: sequencer-reth|bootnode-reth|fee
                                      -oracle|eth-da-submitter>
      --service-account=<value>       Kubernetes service account used by this
                                      sequencer.
      --signer-backend=<option>       Backend for the selected signing identity;
                                      otherwise reuse its configured backend.
                                      <options: local|aws-kms>
      --signer-mode=<option>          How the reth sequencer block signer is
                                      configured.
                                      <options: aws-kms|external-secret|plain>
      --signer-private-key=<value>    Existing local sequencer signer private
                                      key, with or without 0x.

DESCRIPTION
  Prepare Reth node and service signing identities using local keys or AWS KMS

EXAMPLES
  $ scrollsdk setup gen-keystore

  $ scrollsdk setup gen-keystore -N

  $ scrollsdk setup gen-keystore --service sequencer-reth --index 0 --signer-backend aws-kms --aws-region us-east-1 --eks-cluster dogeos-devnet --network-alias devnet -N

  $ scrollsdk setup gen-keystore --service bootnode-reth --bootnode-count 2 -N

  $ scrollsdk setup gen-keystore --service fee-oracle --signer-backend local -N

  $ scrollsdk setup gen-keystore --service eth-da-submitter -N

  $ scrollsdk setup gen-keystore --accounts -N
```

See [deployment signing identities](docs/keystore.md) for scope, repeat execution,
and the separate archive workflow.

## `scrollsdk setup gen-l2-artifacts`

For development without Docker, run from a prepared deployment directory:

```bash
scrollsdk setup gen-l2-artifacts --contracts-source /path/to/scroll-contracts \
  --non-interactive --json --skip-deployment-salt-update --skip-l1-fee-vault-update
```

Requires Foundry, bash, jq and installed contract dependencies. `--contracts-source`
is mutually exclusive with `--image-tag`. Source `volume/` is preserved; compiler
caches are reused in `.data/contracts-build/`. See the [operation guide](docs/config-cleanup.md#developing-contract-generation-without-docker).


Generate L2 deployment artifacts, including genesis, public config, contract config, and Helm config values

Artifact generation does not require `sequencer.L2GETH_SIGNER_ADDRESS` or a
configured Reth signer. Current contracts initialize SystemConfig with the zero
signer and generate empty genesis `extraData`; configure the Reth runtime signer
separately with `setup l2-sequencer-reth`.

The command no longer prompts for or updates `L1_PLONK_VERIFIER_ADDR`. The old
`--l1-plonk-verifier-addr` and `--skip-l1-plonk-verifier-update` flags are accepted
for script compatibility and ignored. `--doge-config` is only used for legacy
contracts placeholder validation.

```
USAGE
  $ scrollsdk setup gen-l2-artifacts [--base-fee-per-gas <value>] [--configs-dir <value>] [--contracts-source <value>] [--deployment-salt <value>]
    [--doge-config <value>] [--image-tag <value>] [--json] [--l1-fee-vault-addr <value>]
    [--l2-bridge-fee-recipient-addr <value>] [-N] [--skip-deployment-salt-update] [--skip-l1-fee-vault-update]

FLAGS
  -N, --non-interactive                       Run without prompts. Uses config values or sensible defaults.
      --base-fee-per-gas=<value>              Base fee per gas (non-interactive mode). Uses existing config value if not
                                              provided.
      --configs-dir=<value>                   [default: values] Directory name to copy configs to
      --contracts-source=<value>              Local scroll-contracts checkout; use Foundry instead of Docker.
      --deployment-salt=<value>               Deployment salt value (non-interactive mode). If not provided, keeps
                                              existing or auto-increments.
      --doge-config=<value>                   Path to Dogecoin config containing the Reth genesis signer (defaults to
                                              .data/doge-config.toml when present)
      --image-tag=<value>                     Specify the Docker image tag to use
      --json                                  Output in JSON format (stdout for data, stderr for logs)
      --l1-fee-vault-addr=<value>             L1 fee vault address (non-interactive mode). Defaults to OWNER_ADDR.
      --l2-bridge-fee-recipient-addr=<value>  L2 bridge fee recipient address (non-interactive mode). Defaults to zero
                                              address.
      --skip-deployment-salt-update           Skip deployment salt update (non-interactive mode)
      --skip-l1-fee-vault-update              Skip L1 fee vault address update (non-interactive mode)

DESCRIPTION
  Generate L2 deployment artifacts, including genesis, public config, contract config, and Helm config values

EXAMPLES
  $ scrollsdk setup gen-l2-artifacts

  $ scrollsdk setup gen-l2-artifacts --image-tag gen-configs-v0.2.0-debug

  $ scrollsdk setup gen-l2-artifacts --configs-dir ./configs-override
```

_See code: [src/commands/setup/gen-l2-artifacts.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/gen-l2-artifacts.ts)_

## `scrollsdk setup gen-rpc-package`

Generate configuration files for dogeos-rpc-package to enable external RPC nodes

```
USAGE
  $ scrollsdk setup gen-rpc-package -d <value> [--config-path <value>] [--doge-config <value>] [-n <value>] [--values-dir
    <value>]

FLAGS
  -d, --dogeos-rpc-package-dir=<value>  (required) Path to dogeos-rpc-package project directory (clone from
                                        https://github.com/dogeos69/dogeos-rpc-package)
  -n, --namespace=<value>               Kubernetes namespace
      --config-path=<value>             [default: ./config.toml] Path to config.toml file containing cluster
                                        configuration
      --doge-config=<value>             Path to Dogecoin config file
      --values-dir=<value>              [default: ./values] Directory containing Helm values files (must include
                                        genesis.yaml)

DESCRIPTION
  Generate configuration files for dogeos-rpc-package to enable external RPC nodes

EXAMPLES
  # Generate RPC package (dogeos-rpc-package directory is required)

  $ scrollsdk setup gen-rpc-package -d ~/github/dogeos-rpc-package/



  # Generate mainnet RPC package with specific config and namespace

  $ scrollsdk setup gen-rpc-package --doge-config .data/doge-config.toml -d ~/github/dogeos-rpc-package/ -n scroll-mainnet



  # First clone the project: git clone https://github.com/dogeos69/dogeos-rpc-package

  $ scrollsdk setup gen-rpc-package -d ./dogeos-rpc-package/ --namespace default
```

_See code: [src/commands/setup/gen-rpc-package.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/gen-rpc-package.ts)_

## `scrollsdk setup dstack-config`

```text
Import Vast.ai/GCP credentials locally and configure dstack controller Secret references

USAGE
  $ scrollsdk setup dstack-config [--doge-config <value> | --spec <value>]
    [--gcp-project-id <value>] [--gcp-service-account <value>] [--json] [-N]
    [--project <value>] [--provider vastai|gcp...] [--vastai-api-key-file
    <value>]

FLAGS
  -N, --non-interactive              Use supplied files and existing state; fail
                                     on missing credentials
      --doge-config=<value>          Public TOML configuration to update
                                     (default .data/doge-config.toml)
      --gcp-project-id=<value>       GCP project to provision in (default
                                     service account project_id)
      --gcp-service-account=<value>  Path to GCP service-account JSON; imported
                                     into private local state
      --json                         Output metadata as JSON; never print
                                     credentials
      --project=<value>              Dstack project name (default main on first
                                     import)
      --provider=<option>...         Exact enabled provider set; repeat for
                                     multiple providers. Omit to retain existing
                                     and add supplied providers.
                                     <options: vastai|gcp>
      --spec=<value>                 Update an existing DeploymentSpec YAML
                                     instead of doge-config TOML
      --vastai-api-key-file=<value>  Path to a file containing only the Vast.ai
                                     API key; avoids credentials in command
                                     arguments

DESCRIPTION
  Import Vast.ai/GCP credentials locally and configure dstack controller Secret
  references

EXAMPLES
  $ scrollsdk setup dstack-config

  $ scrollsdk setup dstack-config --vastai-api-key-file /private/vastai-key --gcp-service-account /private/service-account.json -N

  $ scrollsdk setup dstack-config --spec deployment-spec.yaml --provider vastai --vastai-api-key-file /private/vastai-key -N
```

_See code: [src/commands/setup/dstack-config.ts](src/commands/setup/dstack-config.ts)_

See [dstack controller credential setup](docs/dstack-controller.md) for the Vast.ai/GCP workflow.

## `scrollsdk setup gen-secrets`

```text
Generate local secret files from config.toml, Dogecoin config, and bridge initialization outputs

USAGE
  $ scrollsdk setup gen-secrets [--doge-config <value>] [--dogecoin-only |
    --dstack-only] [--json] [-N] [--spec <value>]

FLAGS
  -N, --non-interactive      Run without prompts. Uses config values or fails
                             fast.
      --doge-config=<value>  Path to Dogecoin config file (defaults to
                             .data/doge-config.toml)
      --dogecoin-only        Generate only the Dogecoin RPC Secret; no config.toml
                             or bridge initialization required
      --dstack-only          Generate only dstack controller Secrets; no bridge
                             initialization required
      --json                 Output in JSON format (stdout for data, stderr for
                             logs)
      --spec=<value>         DeploymentSpec YAML for --dstack-only

DESCRIPTION
  Generate local secret files from config.toml, Dogecoin config, and bridge
  initialization outputs

EXAMPLES
  $ scrollsdk setup gen-secrets

  $ scrollsdk setup gen-secrets --doge-config .data/doge-config.toml

  $ scrollsdk setup gen-secrets --non-interactive --json --doge-config .data/doge-config.toml

  $ scrollsdk setup gen-secrets --dstack-only --non-interactive

  $ scrollsdk setup gen-secrets --dogecoin-only --non-interactive
```

_See code: [src/commands/setup/gen-secrets.ts](src/commands/setup/gen-secrets.ts)_

Before Dogecoin is deployed, use `scrollsdk setup gen-secrets --dogecoin-only -N`.
This reads `dogecoinClusterRpc.username` and `password` from the selected Dogecoin
config and writes only `secrets/dogecoin-secret.env` with mode `0600`. `$ENV:NAME`
references are resolved locally. It does not connect to Dogecoin, read bridge-init
outputs, generate other services' Secrets, or upload anything. Missing credentials
fail before writing. The option is mutually exclusive with `--dstack-only`.
After deploying Dogecoin and completing `bridge-init`, run the full command to
generate the remaining service Secrets.

See [dstack controller credential setup](docs/dstack-controller.md) for the Vast.ai/GCP workflow.

## `scrollsdk setup generate-from-spec`

Generate configuration files from a DeploymentSpec YAML file

```
USAGE
  $ scrollsdk setup generate-from-spec [-s <value>] [--config-only] [--dry-run] [--env-file <value>] [-f] [--json] [-o <value>]
    [--values-only] [--with-values]

FLAGS
  -f, --force             Overwrite existing files without warning
  -o, --output=<value>    [default: .] Output directory for generated files
  -s, --spec=<value>      [default: deployment-spec.yaml] Path to DeploymentSpec YAML file
      --config-only       Only generate config.toml and .data/*.toml. This is the default.
      --dry-run           Validate spec and show what would be generated without writing files
      --env-file=<value>  Private NAME=value file (default: ./deployment.env when present);
                          process environment takes precedence.
      --json              Output in JSON format (stdout for data, stderr for logs)
      --values-only       Only generate values/*.yaml Helm files
      --with-values       Also generate values/*.yaml Helm files

DESCRIPTION
  Generate configuration files from a DeploymentSpec YAML file

EXAMPLES
  # Generate configs in current directory

  $ scrollsdk setup generate-from-spec



  # Generate configs to specific output directory

  $ scrollsdk setup generate-from-spec --output ./my-deployment



  # Generate with JSON output for automation

  $ scrollsdk setup generate-from-spec --json



  # Load private keys/passwords from an env file before deriving account addresses

  $ scrollsdk setup generate-from-spec --env-file custom.env



  # Dry run - validate and show what would be generated

  $ scrollsdk setup generate-from-spec --dry-run



  # Generate Helm values files explicitly

  $ scrollsdk setup generate-from-spec --with-values

  $ scrollsdk setup generate-from-spec --values-only
```

_See code: [src/commands/setup/generate-from-spec.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/generate-from-spec.ts)_

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

## `scrollsdk setup prep-charts`

```text
Validate Makefile and prepare Helm charts for Scroll SDK

USAGE
  $ scrollsdk setup prep-charts [--doge-config <value>] [--dogecoin-only | --dstack-only]
    [--github-token <value>] [--github-username <value>] [--json] [-N]
    [--proof-materials-receipt <value>] [--proof-publication-receipt <value>]
    [--proof-topology-compiler-binary <value> | --proof-topology-compiler-image
    <value>] [--skip-auth-check] [--skip-l2-contract-deployment-block] [--spec
    <value>] [--values-dir <value>]

FLAGS
      --dogecoin-only          Prepare only Dogecoin production values without bridge initialization
  -N, --non-interactive                         Run without prompts.
                                                Auto-applies all detected
                                                changes.
      --doge-config=<value>                     Path to Dogecoin config file
      --dstack-only                             Generate only dstack controller
                                                production values without chain
                                                initialization or registry
                                                checks
      --github-token=<value>                    GitHub Personal Access Token
      --github-username=<value>                 GitHub username
      --json                                    Output in JSON format (stdout
                                                for data, stderr for logs)
      --proof-materials-receipt=<value>         Selected real proof-materials
                                                receipt to bind into the
                                                deployment contract
      --proof-publication-receipt=<value>       Selected program-publication
                                                receipt to bind into the
                                                deployment contract
      --proof-topology-compiler-binary=<value>  Development-only local
                                                dogeos-proof-topology binary;
                                                production uses the
                                                digest-pinned configured image
      --proof-topology-compiler-image=<value>   Override the digest-pinned
                                                proof-topology compiler image
      --skip-auth-check                         Skip authentication check for
                                                individual charts
      --skip-l2-contract-deployment-block       Do not overwrite L2GETH_L1_CONTR
                                                ACT_DEPLOYMENT_BLOCK in L2
                                                production values files
      --spec=<value>                            Optional DeploymentSpec for
                                                proof topology and dstack
                                                controller values; proof
                                                topology conflicts with
                                                doge-config [proof_topology]
      --values-dir=<value>                      [default: ./values] Directory
                                                containing values files; must be
                                                inside the deployment root for
                                                transactional generation

DESCRIPTION
  Validate Makefile and prepare Helm charts for Scroll SDK

EXAMPLES
  $ scrollsdk setup prep-charts

  $ scrollsdk setup prep-charts --spec deployment-spec.yaml

  $ scrollsdk setup prep-charts --dstack-only --non-interactive

  $ scrollsdk setup prep-charts --github-username=your-username --github-token=your-token

  $ scrollsdk setup prep-charts --values-dir=./custom-values

  $ scrollsdk setup prep-charts --skip-auth-check

  $ scrollsdk setup prep-charts --skip-l2-contract-deployment-block
```

_See code: [src/commands/setup/prep-charts.ts](src/commands/setup/prep-charts.ts)_

See [dstack controller credential setup](docs/dstack-controller.md) for the Vast.ai/GCP workflow.

For the initial Dogecoin deployment, run:

```bash
scrollsdk setup gen-secrets --dogecoin-only -N
scrollsdk setup prep-charts --dogecoin-only -N
```

The chart preparation command updates only `values/dogecoin-production.yaml`
from the selected Dogecoin config. Copy this production values template into
place first. It supports `--doge-config` and `--values-dir`, reuses the full
command's network and port rules, and preserves unrelated files. Both modes
preserve all Dogecoin storage settings, including `storage.size`; they do not
fill in a missing size or resize storage based on the selected network.
`config.toml` is optional; when present, `ingress.DOGECOIN_HOST` updates the
existing Dogecoin ingress. Bridge initialization, L2 artifacts, Makefile and
registry checks are not required. This mode cannot be combined with
`--dstack-only`, `--spec` or proof compiler inputs. It prepares local values;
installing Dogecoin and uploading its Secret remain separate operations.

## `scrollsdk setup proof-aws-init`

Provision proof AWS resources and persist their non-secret resource facts as prep-charts input; never read or modify generated Helm values

```
USAGE
  $ scrollsdk setup proof-aws-init [--artifact-public-endpoint-url <value>] [--artifact-public-read-mode
    direct-s3|existing-public-s3|existing-gateway] [--artifact-read-route-table-id <value>...]
    [--artifact-read-vpc-endpoint-id <value>] [--aws-profile <value>] [--aws-region <value>] [--bucket <value>]
    [--config <value>] [--coordinator-service-account <value>] [--deployment-alias <value>] [--doge-config <value>]
    [--eks-cluster <value>] [--json] [--key-prefix <value>] [--namespace <value>] [-N] [--rotate-tokens] [--secret-name
    <value>] [--skip-vpc-endpoint] [--withdrawal-service-account <value>] [-y]

FLAGS
  -N, --non-interactive                          Run without prompts; missing values must be discoverable, already
                                                 configured, or passed as flags
  -y, --yes                                      Apply the displayed AWS resource plan without confirmation
      --artifact-public-endpoint-url=<value>     Existing credential-free HTTPS S3-compatible gateway root; used only
                                                 with --artifact-public-read-mode=existing-gateway
      --artifact-public-read-mode=<option>       Public proof artifact delivery: CLI-managed direct S3, operator-managed
                                                 public S3, or an existing HTTPS gateway backed by private S3
                                                 <options: direct-s3|existing-public-s3|existing-gateway>
      --artifact-read-route-table-id=<value>...  Advanced override: EKS subnet route table to associate with the S3
                                                 gateway endpoint (repeatable; normally auto-discovered)
      --artifact-read-vpc-endpoint-id=<value>    Advanced override: existing S3 Gateway VPC endpoint (normally
                                                 auto-discovered or created)
      --aws-profile=<value>                      AWS CLI profile used for provisioning
      --aws-region=<value>                       AWS region containing EKS and the proof token secret (auto-detected
                                                 when omitted)
      --bucket=<value>                           Advanced consistency assertion for the proof artifact bucket; the
                                                 value is read from doge-config proofArtifacts.s3
      --config=<value>                           [default: .data/proof-aws.json] Output config file consumed by setup
                                                 prep-charts
      --coordinator-service-account=<value>      Kubernetes service account used by proof-coordinator (default:
                                                 proof-coordinator)
      --deployment-alias=<value>                 Unique deployment instance alias used to derive deterministic bucket
                                                 and IAM role names
      --doge-config=<value>                      [default: .data/doge-config.toml] DogeOS config containing the
                                                 canonical proofArtifacts.s3 store
      --eks-cluster=<value>                      EKS cluster name used by the IRSA trust policies (selected
                                                 interactively when omitted)
      --json                                     Output structured JSON
      --key-prefix=<value>                       Advanced consistency assertion for the proof artifact key prefix; the
                                                 value is read from doge-config proofArtifacts.s3
      --namespace=<value>                        Kubernetes namespace of the proof workloads (default: default)
      --rotate-tokens                            Replace the proof-work/prover-worker tokens in an existing secret (both
                                                 workloads must be restarted afterwards)
      --secret-name=<value>                      Secrets Manager secret holding proof-work-token and prover-worker-token
                                                 (default: scroll/<deployment-alias>/proof-coordinator-secrets)
      --skip-vpc-endpoint                        Do not auto-discover or create an S3 Gateway VPC endpoint for
                                                 EKS-internal S3 traffic
      --withdrawal-service-account=<value>       Kubernetes service account used by withdrawal-processor (default:
                                                 withdrawal-processor)

DESCRIPTION
  Provision proof AWS resources and persist their non-secret resource facts as prep-charts input; never read or modify
  generated Helm values

EXAMPLES
  $ scrollsdk setup proof-aws-init

  $ scrollsdk setup proof-aws-init --aws-region us-west-2 --eks-cluster dogeos-testnet --deployment-alias dev0829 --artifact-public-read-mode direct-s3 -N

  $ scrollsdk setup proof-aws-init --artifact-public-read-mode existing-public-s3

  $ scrollsdk setup proof-aws-init --artifact-public-read-mode existing-gateway --artifact-public-endpoint-url https://objects.example.com

  $ scrollsdk setup proof-aws-init --rotate-tokens
```

_See code: [src/commands/setup/proof-aws-init.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/proof-aws-init.ts)_

## `scrollsdk setup proof-bundle-publish`

Plan or publish the complete content-addressed 11-file real-proof program bundle; shared bucket policy is never modified

```
USAGE
  $ scrollsdk setup proof-bundle-publish --core-dir <value> [--apply] [--aws-profile <value>] [--deployment-dir <value>]
    [--json] [--materials <value>] [--output <value>] [--proof-aws-config <value>] [--topology-bundle <value>]

FLAGS
  --apply                     Perform S3 writes and anonymous readback; omission prints a read-only plan
  --aws-profile=<value>       AWS profile used by the dogeos-core publisher
  --core-dir=<value>          (required) Clean dogeos-core checkout matching the materials source revision
  --deployment-dir=<value>    [default: .] Deployment root
  --json                      Output structured JSON
  --materials=<value>         [default: .data/proof-materials-v1.json] Real proof-materials-v1.json
  --output=<value>            [default: .data/proof-program-publication-v1.json] New publication receipt written only
                              after all public GET checks pass
  --proof-aws-config=<value>  [default: .data/proof-aws.json] proof-aws.json containing the canonical proof artifact
                              store
  --topology-bundle=<value>   [default: .data/generated/proof-topology] Installable active/real compiler bundle
                              containing the tag-5 manifest

DESCRIPTION
  Plan or publish the complete content-addressed 11-file real-proof program bundle; shared bucket policy is never
  modified

EXAMPLES
  $ scrollsdk setup proof-bundle-publish --core-dir /data/dogeos-core

  $ scrollsdk setup proof-bundle-publish --core-dir /data/dogeos-core --apply --aws-profile devnet
```

_See code: [src/commands/setup/proof-bundle-publish.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/proof-bundle-publish.ts)_

## `scrollsdk setup proof-config-check`

Validate generated proof configs, bundle revision, two switches, Worker bundle and the published deployment kit; --live also requires every registered Attestation signer to be polling the TSO (the final acceptance check after rollout)

```
USAGE
  $ scrollsdk setup proof-config-check [-c <value>] [--contract <value>] [--deployment-dir <value>] [--json] [--kube-context
    <value> --live] [--namespace <value> ] [--scope activation|preparation] [--spec <value>]

FLAGS
  -c, --config=<value>          doge-config.toml path
      --contract=<value>        [default: .data/proof-deployment.json] Proof deployment contract path
      --deployment-dir=<value>  [default: .] Deployment root
      --json                    Output structured JSON
      --kube-context=<value>    Kubernetes context for --live
      --live                    After rollout: also require a fresh authenticated TSO poll from every Attestation signer
                                in the WP tsoSigners
      --namespace=<value>       [default: default] Kubernetes namespace for --live
      --scope=<option>          [default: activation] Preparation validates expected policy materials; it never
                                authorizes signer installation
                                <options: activation|preparation>
      --spec=<value>            Optional DeploymentSpec proof source

DESCRIPTION
  Validate generated proof configs, bundle revision, two switches, Worker bundle and the published deployment kit;
  --live also requires every registered Attestation signer to be polling the TSO (the final acceptance check after
  rollout)
```

_See code: [src/commands/setup/proof-config-check.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/proof-config-check.ts)_

## `scrollsdk setup proof-image-tools`

Run pinned native proof image tools offline; export identities/materializers or derive Scroll identity evidence without deploying Workers

```
USAGE
  $ scrollsdk setup proof-image-tools --expected-core-revision <value> --output <value> [--action export|derive-scroll]
    [--artifact-root <value>] [--coordinator-image <value>] [--deployment-dir <value>] [--json] [--producer-image
    <value>] [--require-real-materialization] [--worker-image <value>]

FLAGS
  --action=<option>                 [default: export]
                                    <options: export|derive-scroll>
  --artifact-root=<value>           Candidate release directory containing chunk/, batch/ and verifier/aggregate-vk
  --coordinator-image=<value>       PC image containing the matching materialize-chunk-oneshot and
                                    scroll-runtime-materializer binaries
  --deployment-dir=<value>          [default: .]
  --expected-core-revision=<value>  (required) Full approved core Git SHA; every selected image and compiled Worker
                                    identity must match
  --json
  --output=<value>                  (required) New output directory inside deployment-dir; existing output is never
                                    replaced
  --producer-image=<value>          CPU producer image with /usr/local/libexec/dogeos-proof-release-producer
                                    (derive-scroll only)
  --require-real-materialization    Reject a placeholder Batch identity during export; use before real-materialization
                                    activation
  --worker-image=<value>            CPU Worker/tool image providing --print-identity-json; no Worker service is started

DESCRIPTION
  Run pinned native proof image tools offline; export identities/materializers or derive Scroll identity evidence
  without deploying Workers
```

_See code: [src/commands/setup/proof-image-tools.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/proof-image-tools.ts)_

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

Generate canonical protocol context from completed Bridge funding; stop before policy builds and proof preparation.

```text
USAGE
  $ scrollsdk setup protocol-context [--dir <value>] [--json]

FLAGS
  --dir=<value>  [default: deployment] Saved deployment directory (alias: --deployment-dir).
  --json         Output structured stage status and the next command.
```

Saved plans must match the current workflow; older step layouts are not migrated.
For external policy builds, stop here and follow the approved build/governance procedure.
See [preparation stage boundaries](docs/spec-preparation.md#commands).

## `scrollsdk setup proof-materials`

Resume the saved proof-materials stage; --generation or --preparation-receipt explicitly selects standalone material preparation

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
  Resume the saved proof-materials stage; --generation or --preparation-receipt explicitly selects standalone material
  preparation

EXAMPLES
  $ scrollsdk setup proof-materials --generation mock

  $ scrollsdk setup proof-materials --generation mock --identity-env /build/real-identity.env --worker-identity-bundle /build/worker-identity-bundle.json

  $ scrollsdk setup proof-materials --generation real --artifact-root /build/bake --expected-core-revision <40-hex-sha> --identity-env /build/bake/real-identity.env --chunk-materializer /build/materialize-chunk-oneshot --batch-materializer /build/scroll-runtime-materializer --production-worker-image repo/worker@sha256:... --compiler-image repo/compiler@sha256:...

  $ scrollsdk setup proof-materials --generation real --bridge-artifact-dir /build/bake/bridge --protocol-context .data/protocol_context.json

  $ scrollsdk setup proof-materials --preparation-receipt .data/proof-release-preparation-v1.json --production-worker-receipt .data/proof-worker-image-check-v1.json --chunk-materializer /build/materialize-chunk-oneshot --batch-materializer /build/scroll-runtime-materializer --compiler-image repo/compiler@sha256:...
```

_See code: [src/commands/setup/proof-materials.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/proof-materials.ts)_

## `scrollsdk setup proof-release-prepare`

Validate and capture native dogeos-core real-proof preparation output as one immutable local handoff receipt

```
USAGE
  $ scrollsdk setup proof-release-prepare --artifact-root <value> --expected-core-revision <value> [--batch-materializer <value>]
    [--chunk-materializer <value>] [--deployment-dir <value>] [--identity-env <value>] [--json] [--output <value>]
    [--producer-manifest <value>] [--protocol-context <value>]

FLAGS
  --artifact-root=<value>           (required) Native preparation root containing identity-full.env, manifest, protocol
                                    context and bridge/
  --batch-materializer=<value>      Override artifact-root/bin/scroll-runtime-materializer
  --chunk-materializer=<value>      Override artifact-root/bin/materialize-chunk-oneshot
  --deployment-dir=<value>          [default: .] Deployment root used to resolve the output receipt
  --expected-core-revision=<value>  (required) Full approved dogeos-core Git SHA
  --identity-env=<value>            Override artifact-root/identity-full.env
  --json                            Output structured JSON
  --output=<value>                  [default: .data/proof-release-preparation-v1.json] New local preparation receipt;
                                    existing files are never replaced
  --producer-manifest=<value>       Override artifact-root/real-proving-artifacts.json
  --protocol-context=<value>        Override artifact-root/protocol_context.json

DESCRIPTION
  Validate and capture native dogeos-core real-proof preparation output as one immutable local handoff receipt

EXAMPLES
  $ scrollsdk setup proof-release-prepare --artifact-root /build/release --expected-core-revision <40-hex-sha>

  $ scrollsdk setup proof-release-prepare --artifact-root /build/release --chunk-materializer /build/materialize-chunk-oneshot --batch-materializer /build/scroll-runtime-materializer --expected-core-revision <40-hex-sha>
```

_See code: [src/commands/setup/proof-release-prepare.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/proof-release-prepare.ts)_

## `scrollsdk setup proof-topology-compile`

Compile the selected proof topology through the pinned dogeos-core compiler without touching Kubernetes

```
USAGE
  $ scrollsdk setup proof-topology-compile [--compiler-binary <value> | --compiler-image <value>] [--deployment-dir <value>]
    [--doge-config <value>] [--eth-da-submitter-config <value>] [--json] [--output <value>] [--preflight mock|real]
    [--proof-coordinator-config <value>] [--spec <value>] [--withdrawal-processor-config <value>]

FLAGS
  --compiler-binary=<value>              Development-only local dogeos-proof-topology binary
  --compiler-image=<value>               Override the configured digest-pinned compiler image
  --deployment-dir=<value>               [default: .] Deployment root
  --doge-config=<value>                  doge-config.toml path
  --eth-da-submitter-config=<value>      Deployment-relative eth-da-submitter native base config
  --json                                 Output structured JSON
  --output=<value>                       [default: .data/generated/proof-topology] Deployment-relative output directory
  --preflight=<option>                   Validate the staged active profile for this generation
                                         <options: mock|real>
  --proof-coordinator-config=<value>     [default: proof-coordinator/ProofCoordinator.toml] Proof Coordinator base
                                         config
  --spec=<value>                         Optional DeploymentSpec proof source
  --withdrawal-processor-config=<value>  [default: withdrawal-processor/WithdrawalProcessor.toml] Withdrawal Processor
                                         base config

DESCRIPTION
  Compile the selected proof topology through the pinned dogeos-core compiler without touching Kubernetes

EXAMPLES
  $ scrollsdk setup proof-topology-compile --deployment-dir .

  $ scrollsdk setup proof-topology-compile --preflight mock
```

_See code: [src/commands/setup/proof-topology-compile.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/proof-topology-compile.ts)_

## `scrollsdk setup proof-worker`

Provision a per-worker credential for a compiler-generated Compose bundle or local Kubernetes worker (never the coordinator master)

```
USAGE
  $ scrollsdk setup proof-worker [--aws-profile <value>] [--aws-region <value>]
    [--deployment-dir <value>] [--json] [--kube-context <value>] [--namespace
    <value>] [--secret-name <value>] [--worker-token-env <value>]

FLAGS
  --aws-profile=<value>       AWS CLI profile used to read the worker-credential
                              master (only the minted credential is written)
  --aws-region=<value>        AWS region of the proof coordinator secret;
                              inferred from .data/proof-aws.json when omitted
  --deployment-dir=<value>    [default: .] Deployment root containing
                              .data/proof-deployment.json
  --json                      Output structured JSON
  --kube-context=<value>      Explicit Kubernetes context for a compiled-local
                              worker
  --namespace=<value>         Explicit Kubernetes namespace for a compiled-local
                              worker
  --secret-name=<value>       Secrets Manager secret containing
                              prover-worker-master; inferred from
                              .data/proof-aws.json when omitted
  --worker-token-env=<value>  [default: DOGEOS_PROVER_WORKER_TOKEN] Environment
                              variable containing an already minted credential
                              for this Worker id; when unset, mint one from the
                              Secrets Manager master

DESCRIPTION
  Provision a per-worker credential for a compiler-generated Compose bundle or
  local Kubernetes worker (never the coordinator master)

EXAMPLES
  $ scrollsdk setup proof-worker

  $ scrollsdk setup proof-worker --deployment-dir /srv/dogeos/testnet --aws-profile staging
```

_See code: [src/commands/setup/proof-worker.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/proof-worker.ts)_

## `scrollsdk setup proof-worker-check`

Verify a compiler-generated Docker Compose prover-worker bundle, selected resources, secret-file mode, and optional expected bundle ID

```
USAGE
  $ scrollsdk setup proof-worker-check --bundle-dir <value> [--expected-bundle-id <value>] [--json] [--resources-root
  <value>]

FLAGS
  --bundle-dir=<value>          (required) Compiler-generated Worker Compose bundle directory
  --expected-bundle-id=<value>  Expected bundle ID written by prep-charts; use on the worker host to reject a stale
                                synchronized bundle
  --json                        Output structured JSON
  --resources-root=<value>      Compiler-backed Worker resources root on this host; defaults to PROOF_RESOURCES_ROOT
                                from the bundle .env

DESCRIPTION
  Verify a compiler-generated Docker Compose prover-worker bundle, selected resources, secret-file mode, and optional
  expected bundle ID

EXAMPLES
  $ scrollsdk setup proof-worker-check --bundle-dir /srv/dogeos/prover-worker-production/docker-compose --resources-root /srv/dogeos/proof-resources --expected-bundle-id <sha256>
```

_See code: [src/commands/setup/proof-worker-check.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/proof-worker-check.ts)_

## `scrollsdk setup proof-worker-image-check`

Validate a digest-pinned production CUDA Worker image against native preparation identities without requiring a GPU

```
USAGE
  $ scrollsdk setup proof-worker-image-check --image <value> [--deployment-dir <value>] [--expected-core-revision <value>]
    [--identity-env <value>] [--json] [--output <value>] [--preparation-receipt <value>]

FLAGS
  --deployment-dir=<value>          [default: .] Deployment root
  --expected-core-revision=<value>  Full approved dogeos-core Git SHA; implied by --preparation-receipt
  --identity-env=<value>            Native full identity env; excludes --preparation-receipt
  --image=<value>                   (required) Production CUDA Worker tag or immutable digest
  --json                            Output structured JSON
  --output=<value>                  [default: .data/proof-worker-image-check-v1.json] New image-check receipt; existing
                                    files are never replaced
  --preparation-receipt=<value>     Validated proof-release-preparation-v1.json

DESCRIPTION
  Validate a digest-pinned production CUDA Worker image against native preparation identities without requiring a GPU

EXAMPLES
  $ scrollsdk setup proof-worker-image-check --image dogeos69/prover-worker-cuda:TAG --preparation-receipt .data/proof-release-preparation-v1.json

  $ scrollsdk setup proof-worker-image-check --image repo/worker@sha256:... --identity-env /build/identity-full.env --expected-core-revision <40-hex-sha>
```

_See code: [src/commands/setup/proof-worker-image-check.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/proof-worker-image-check.ts)_

## `scrollsdk setup push-secrets`

Upload configured service secrets, including enabled dstack Secrets; does not deploy services or start GPU workers

```
USAGE
  $ scrollsdk setup push-secrets [--aws-prefix <value>] [--aws-region <value>] [--aws-service-account <value>] [-d]
    [--doge-config <value> | --spec <value>] [--dry-run] [--dstack-only | -c | -f <value>] [--exclude-cubesigner |  | ]
    [--json] [--kube-context <value>] [--namespace <value>] [-N] [--provider aws|vault|kubernetes] [--skip-yaml-update]
    [--values-dir <value>] [--values-file <value>] [--vault-path <value>] [--vault-server <value>]
    [--vault-token-secret-key <value>] [--vault-token-secret-name <value>] [--vault-version <value>]

FLAGS
  -N, --non-interactive                  Run without prompts. Auto-overrides existing secrets.
  -c, --cubesigner-only                  Only push CubeSigner related secrets (cubesigner-signer-* files)
  -d, --debug                            Show debug output
  -f, --secret-file=<value>              Local secret file to push (supports .env and .json files)
      --aws-prefix=<value>               AWS Secrets Manager path prefix (defaults to generated deployment
                                         configuration; no shared fallback)
      --aws-region=<value>               AWS region for secrets (e.g., us-east-1)
      --aws-service-account=<value>      [default: external-secrets] AWS IAM service account
      --doge-config=<value>              Dstack public TOML configuration (default .data/doge-config.toml)
      --dry-run                          Plan selected Secret uploads and validate dstack files locally; no remote
                                         requests or changes
      --dstack-only                      Upload only dstack Secrets to Kubernetes; omit to include all configured
                                         services
      --exclude-cubesigner               Defer CubeSigner runtime Secret upload; exclude even stale signer files
      --json                             Output in JSON format (stdout for data, stderr for logs)
      --kube-context=<value>             Explicit Kubernetes context required when uploading dstack Secrets
      --namespace=<value>                Existing Kubernetes namespace required when uploading dstack Secrets
      --provider=<option>                [default: aws] Destination for .env/.json secrets (aws or vault); kubernetes
                                         accepts dstack bundles. Dstack always uses Kubernetes.
                                         <options: aws|vault|kubernetes>
      --skip-yaml-update                 Skip updating production YAML files with new secret provider
      --spec=<value>                     Dstack DeploymentSpec YAML
      --values-dir=<value>               [default: values] Directory containing the values files
      --values-file=<value>              Specific Helm values YAML file to update after pushing secrets
      --vault-path=<value>               [default: scroll] Vault path prefix
      --vault-server=<value>             [default: http://vault.default.svc.cluster.local:8200] Vault server URL
      --vault-token-secret-key=<value>   [default: token] Vault token secret key
      --vault-token-secret-name=<value>  [default: vault-token] Vault token secret name
      --vault-version=<value>            [default: v2] Vault version

DESCRIPTION
  Upload configured service secrets, including enabled dstack Secrets; does not deploy services or start GPU workers

EXAMPLES
  $ scrollsdk setup push-secrets

  $ scrollsdk setup push-secrets --debug

  $ scrollsdk setup push-secrets --values-dir custom-values

  $ scrollsdk setup push-secrets --secret-file secrets/l2-reth-bootnode-0-secret.env --values-file values/l2-reth-bootnode-production-0.yaml

  $ scrollsdk setup push-secrets --cubesigner-only

  $ scrollsdk setup push-secrets -c --debug

  $ scrollsdk setup push-secrets --provider kubernetes --dstack-only --kube-context isolated-e2e --namespace default --dry-run -N

  $ scrollsdk setup push-secrets --provider aws --aws-region us-east-1 --kube-context isolated-e2e --namespace default -N
```

_See code: [src/commands/setup/push-secrets.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/push-secrets.ts)_

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

_See code: [src/commands/setup/render.ts](src/commands/setup/render.ts)_

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

_See code: [src/commands/setup/signer-session.ts](src/commands/setup/signer-session.ts)_

## `scrollsdk setup tls`

Configure ACM TLS on enabled AWS ALB ingresses in local deployment values.
Requires an issued certificate in the ALB region covering the enabled hosts.
No Kubernetes access, cert-manager or ingress-nginx is required.

```text
USAGE
  $ scrollsdk setup tls [--certificate-arn <value>] [-N] [--json] [--values-dir <value>]

FLAGS
  -N, --non-interactive          Require an explicit certificate ARN without prompting
      --certificate-arn=<value> Issued ACM certificate ARN(s), comma-separated
      --json                    Output updated file paths as JSON
      --values-dir=<value>      [default: values] Deployment Helm values directory
```

```bash
scrollsdk setup tls --certificate-arn "$ACM_CERTIFICATE_ARN" --non-interactive
```

Disabled ingresses remain disabled. Set individual certificates in values when
a single certificate set does not cover every enabled host. Review and install
these values through the normal Helm process; DNS/controller migration is an
operator action.

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

## `scrollsdk setup verify-contracts`

Set up contracts verification

```
USAGE
  $ scrollsdk setup verify-contracts [--config-dir <value>] [--image-tag <value>] [--preinstalls | --preinstalls-only]
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
  Set up contracts verification

EXAMPLES
  $ scrollsdk setup verify-contracts

  $ scrollsdk setup verify-contracts --image-tag verify-v0.2.0-debug

  $ scrollsdk setup verify-contracts --preinstalls --config-dir ./deployment

  $ scrollsdk setup verify-contracts --preinstalls-only --preinstalls-image dogeos69/preinstalls:v0.2.1
```

_See code: [src/commands/setup/verify-contracts.ts](src/commands/setup/verify-contracts.ts)_

Use `--require-verified --wait-seconds 120` to require full Blockscout verification
following submission, or `--status-only` to read final results without Docker or
resubmission. Both status modes fail for partial, pending or unavailable targets.
Without a status flag, final verification is reported as `not-checked`. See the
[operator examples](docs/deployment-preflight.md#8-check-final-contract-verification).

Without a status or preinstalls flag, this command retains the existing DogeOS contracts
verification behavior. `--preinstalls` runs that verifier first, then submits the
standard preinstalls sources; `--preinstalls-only` retries only the latter. A
failure in either selected verifier makes the command fail. Preinstalls settings
are validated before either container starts.

The preinstalls path reads `[contracts.verification]` in `config.toml` under
`--config-dir`: `VERIFIER_TYPE_L2` must be `blockscout`, `EXPLORER_URI_L2` must be a
Blockscout site URL or its `/api` root, and `EXPLORER_API_KEY_L2` must be empty.
For example, `https://explorer.example/chain/` and
`https://explorer.example/chain/api/` both select
`https://explorer.example/chain/api`. The script appends `/v2/...`; do not pass an
`/api/v2` URL. Credential-bearing URLs, query strings and fragments are rejected.
This requires a **real Blockscout v2 API**: l2scan or another Etherscan-compatible
API is not supported even when its Forge verifier type is called `blockscout`.

`--image-tag` selects only the DogeOS contracts verifier. The independent
`--preinstalls-image` defaults to `dogeos69/preinstalls:v0.2.2`; set it to the
preinstalls release actually deployed so the source set matches. The CLI
overrides the image's deployment entrypoint with
`bash /app/lib/verify-blockscout.sh` and passes the API root as one Docker command
argument. It does not mount the deployment directory or pass signing keys, RPC
credentials, or explorer API keys into this container. It uses Docker host
networking to reach the configured API.

This submits source verification requests and never deploys contracts. A zero
exit means Blockscout accepted submissions or reported them already verified;
check the explorer for final asynchronous verification results. Preinstalls
must already be deployed and indexed. `scrollsdk test contracts` remains the
separate codehash/runtime check.


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
  --force                                   Overwrite an existing env file in the output directory
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

## `scrollsdk signer preflight`

Probe your running attestation-signer from your own infrastructure and verify its runtime identity against your descriptor. Signers dial out to the TSO, so the probe targets the signer's local HTTP port. Add --require-production-ready after selecting enforcement=enforce to require dogeos-core attestation_evidence_v2 and all four production capabilities.

```
USAGE
  $ scrollsdk signer preflight [--dir <value>] [--endpoint <value>] [--expected-public-key <value>] [--json]
    [--network mainnet|regtest|testnet] [--require-production-ready]

FLAGS
  --dir=<value>                  signer init output directory; its descriptor.json provides the expected network and
                                 public key
  --endpoint=<value>             [default: http://127.0.0.1:4040] Signer local HTTP base URL to probe (the partner-kit
                                 compose binds 4040 to host loopback; no inbound signer access is required)
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
  -c, --config=<value>     [default: ./config.toml] Path to config.toml file
  -n, --contracts=<value>  [default: ./config-contracts.toml] Path to config-contracts.toml file
  -p, --pod                Run inside Kubernetes pod
      --preinstalls-image  [default: dogeos69/preinstalls:v0.2.2] Image for runtime codehash verification

DESCRIPTION
  Test L2 contracts and preinstalls by checking deployment, initialization and ownership
```

Progress, contract results, and pass/fail/optional-absent counts are grouped by
repository (`scroll-contracts` and `dogeos-preinstalls`), followed by an overall
summary. A failed contract check in one group does not skip the other group.

The `scroll-contracts` group checks 16 L2 contracts: the 14 contracts deployed
or reused and configured by Docker `deploy.sh`, using addresses from
`config-contracts.toml`, plus the genesis-only NativeDogeToken and EIP-2935
BlockHashHistory at their fixed canonical addresses. The latter two require no
config entries and are checked for code presence, without owner or proxy
initialization checks. This does not compare live storage against genesis.
Legacy L1 contracts and retired Gateway/Bascule entries are ignored. L1 RPC
configuration is not required.

Also checks the 21 required canonical addresses from `dogeos-preinstalls`,
including Multicall3, CreateX, Arachnid, Permit2, nine canonical Safe v1.3.0
contracts, and EntryPoint/SenderCreator v0.6–v0.9. These fixed addresses do not
need entries in `config-contracts.toml`. Arachnid is a genesis prerequisite;
the image does not deploy it. Safe Singleton Factory and the six legacy Safe
EIP-155 entries remain optional even when the factory exists, matching the
canonical-only deployment policy in preinstalls v0.2.2.

Deployment checks require nonempty runtime code. Initialization checks inspect
proxy initialization flags and the queue messenger, oracle whitelist, and fee
vault adapter references. Ownership checks apply to the eight owned core
contracts. Missing required addresses/code, failed checks, and unreadable
initialization/ownership cause exit status 1. Optional missing preinstalls are
reported separately. These native CLI checks do not compare runtime codehashes.

After both groups, a separate **preinstalls image verification** step runs
`/app/lib/verify.sh` from `dogeos69/preinstalls:v0.2.2`, overriding the image's
default deployment entrypoint. It uses the same L2 RPC and verifies runtime
codehashes using the image's chain-specific expectations. It runs even if the
native CLI checks report missing or misconfigured contracts; either phase
failing causes a nonzero command exit. The original CLI catalogs and checks
remain in place.

Docker must be available. The verifier container uses host networking, so the
Docker host must be able to reach the chosen RPC, including internal endpoints
selected with `--pod`. No private key or deployment volume is passed to the
container. RPC credentials in verifier output are redacted. Use
`--preinstalls-image <repository:tag-or-digest>` to select the verifier image
matching your deployment; the default matches the SDK preinstalls production example.

The default image has codehash expectations for chain IDs 1, 31337, 1122005 and
6281971. An unsupported chain ID fails verification. Confirm that the RPC
reports the intended chain ID; supporting a new network requires an image with
expected hashes for Permit2 and EntryPoint v0.8/v0.9.
This command does not query explorer source-verification status or validate
every deployment parameter, proxy implementation, or genesis storage value.

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
  CASENAME  The name of the case to run

FLAGS
  -b, --electrs-url=<value>  Electrs/Esplora API URL (testnet default; explicit URL required for other networks)
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
  $ scrollsdk test ingress [-c <value>] [-d] [-n <value>]

FLAGS
  -c, --config=<value>     Path to config.toml file
  -d, --dev                Include development ingresses
  -n, --namespace=<value>  [default: default] Kubernetes namespace

DESCRIPTION
  Check for required ingress hosts and validate frontend URLs
```

_See code: [src/commands/test/ingress.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/test/ingress.ts)_
<!-- commandsstop -->

## Status-page configuration

Use `scrollsdk setup status-page` for offline generation from a deployment,
`--plan` for a read-only Instatus comparison, and `--apply` for explicit page/component
reconciliation. See [the status-page workflow](docs/status-page.md) for configuration,
Secret ownership and rollout boundaries. `setup prep-charts` also generates enabled
status-page values during normal preparation.

Use `--plan --create-webhook` followed by `--apply --create-webhook` for first
Grafana webhook initialization. The CLI obtains the URL from Instatus and saves
a private binding plus a Kubernetes Secret artifact under
`secrets/status-page/`. Later `--apply` runs reuse it. Apply the
Secret separately in the existing Grafana namespace; public routing remains
disabled until configured. Back up this private directory; recovery/import and
the limits of remote integration discovery are documented in the workflow above.
