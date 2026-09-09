# Scroll SDK CLI

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

- [Post-Bridge instance deployment](docs/post-bridge-instance-deployment.md) — environment-owned automation, intentional genesis hold, no mock worker, safe checkpoints and explicit signer cutover. Runtime acceptance stays in the deployment repository.
- [Fresh devnet redeployment acceptance](docs/devnet-fresh-redeployment.md) — current operator decision: new independent CubeSigner role/key, new Bridge and fresh L2; preserve all existing policies and Kubernetes resources not deployed by this agent.
- [L1 Interface beta.4e cold start](docs/l1-interface-beta4e-cold-start.md) — required fresh-instance opt-in, isolated storage and verified Kubernetes rollout.
- [New Bridge / native Reth devnet runbook](docs/devnet-new-bridge-20260909.md) — verified 2026-09-09 steps, manual edits, release pins and the remaining runtime blocker.
- [Monitoring account balances](docs/monitoring-balances.md) — `prep-charts`
  generation for fee-oracle on L2, eth-da-submitter on Ethereum DA, and fee-wallet
  UTXO thresholds, including canonical signer validation and Secret-owned RPCs.
- [DogeOS deployment status and runbook corrections](docs/dogeos-deployment-status.md)
  — verified progress, current blockers, safe resume boundaries, and corrections
  found during the from-scratch devnet deployment. This is not yet a completed
  end-to-end deployment manual; the command reference below is not execution order.
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
- [CLI automation reference](docs/automation.md) — `--non-interactive`, JSON,
  environment references, retries, and secret handling; it does not define
  deployment order.
- [Ethereum DA S3 archive reference](docs/ethereum-da-s3.md) — S3 upload and
  public readback configuration.
- [Partner attestation-signer kit](https://github.com/dogeos69/scroll-sdk/tree/v0.3.0-develop/partner-kit/attestation-signer)
  — the generic manual sent to signer operators. The generated
  `signer-policy-bundle/PARTNER-COMMANDS.md` is authoritative for one concrete
  deployment.

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
* [`scrollsdk setup cubesigner-refresh`](#scrollsdk-setup-cubesigner-refresh)
* [`scrollsdk setup db-init`](#scrollsdk-setup-db-init)
* [`scrollsdk setup disable-internal`](#scrollsdk-setup-disable-internal)
* [`scrollsdk setup doge-config`](#scrollsdk-setup-doge-config)
* [`scrollsdk setup dogecoin-wallet-import`](#scrollsdk-setup-dogecoin-wallet-import)
* [`scrollsdk setup domains`](#scrollsdk-setup-domains)
* [`scrollsdk setup eth-da-submitter`](#scrollsdk-setup-eth-da-submitter)
* [`scrollsdk setup export-signer-policy`](#scrollsdk-setup-export-signer-policy)
* [`scrollsdk setup fee-oracle`](#scrollsdk-setup-fee-oracle)
* [`scrollsdk setup gen-keystore`](#scrollsdk-setup-gen-keystore)
* [`scrollsdk setup gen-l2-artifacts`](#scrollsdk-setup-gen-l2-artifacts)
* [`scrollsdk setup gen-rpc-package`](#scrollsdk-setup-gen-rpc-package)
* [`scrollsdk setup gen-secrets`](#scrollsdk-setup-gen-secrets)
* [`scrollsdk setup generate-from-spec`](#scrollsdk-setup-generate-from-spec)
* [`scrollsdk setup l2-bootnode-reth`](#scrollsdk-setup-l2-bootnode-reth)
* [`scrollsdk setup l2-sequencer-reth`](#scrollsdk-setup-l2-sequencer-reth)
* [`scrollsdk setup prep-charts`](#scrollsdk-setup-prep-charts)
* [`scrollsdk setup proof-aws-init`](#scrollsdk-setup-proof-aws-init)
* [`scrollsdk setup proof-config-check`](#scrollsdk-setup-proof-config-check)
* [`scrollsdk setup proof-materials`](#scrollsdk-setup-proof-materials)
* [`scrollsdk setup proof-topology-compile`](#scrollsdk-setup-proof-topology-compile)
* [`scrollsdk setup proof-worker`](#scrollsdk-setup-proof-worker)
* [`scrollsdk setup proof-worker-check`](#scrollsdk-setup-proof-worker-check)
* [`scrollsdk setup push-secrets`](#scrollsdk-setup-push-secrets)
* [`scrollsdk setup tls`](#scrollsdk-setup-tls)
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

Sync wallet UTXOs and balance (mainnet/testnet/regtest aware)

```
USAGE
  $ scrollsdk doge wallet sync [-k <value>] [-c <value>] [-p <value>]

FLAGS
  -c, --config=<value>   Path to Dogecoin config file
  -k, --api-key=<value>  NowNodes API key (overrides API key from config)
  -p, --path=<value>     Custom path for the wallet file (overrides path from config)

DESCRIPTION
  Sync wallet UTXOs and balance (mainnet/testnet/regtest aware)

EXAMPLES
  $ scrollsdk doge:wallet sync --config .data/doge-config.toml
```

_See code: [src/commands/doge/wallet/sync.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/doge/wallet/sync.ts)_

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

Derive enode and L2_GETH_STATIC_PEERS from a nodekey

```
USAGE
  $ scrollsdk helper derive-enode NODEKEY

ARGUMENTS
  NODEKEY  Nodekey of the geth ethereum node

DESCRIPTION
  Derive enode and L2_GETH_STATIC_PEERS from a nodekey

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

Import signer-init descriptors from partner-operated attestation-signers and select the bootstrap bridge keyset. This command consumes only endpoint + public key and never provisions keys, deployments, or network probes. Current dogeos-core runtime preflight occurs after partners install the post-genesis canonical-context bundle.

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
  command consumes only endpoint + public key and never provisions keys, deployments, or network probes. Current
  dogeos-core runtime preflight occurs after partners install the post-genesis canonical-context bundle.

EXAMPLES
  $ scrollsdk setup attestation-signer --descriptor partner-a.json --descriptor partner-b.json --descriptor ours.json --threshold 2

  $ scrollsdk setup attestation-signer --descriptor-dir descriptors/ --threshold 3 --active-signer-ids partner-a,partner-b,ours-0
```

_See code: [src/commands/setup/attestation-signer.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/attestation-signer.ts)_

## `scrollsdk setup bootnode-public-p2p`

Enable external nodes to form P2P network with cluster bootnodes by setting up static IPs and LoadBalancer services

```
USAGE
  $ scrollsdk setup bootnode-public-p2p [--cluster-name <value>] [--json] [-N] [--provider aws|gcp] [--region <value>]
    [--values-dir <value>]

FLAGS
  -N, --non-interactive       Run without prompts. Requires --provider flag.
      --cluster-name=<value>  Kubernetes cluster name for resource tagging and identification
      --json                  Output in JSON format (stdout for data, stderr for logs)
      --provider=<option>     Cloud provider for static IP allocation (aws, gcp)
                              <options: aws|gcp>
      --region=<value>        Cloud provider region where resources will be created
      --values-dir=<value>    [default: ./values] Directory containing Helm values files for configuration

DESCRIPTION
  Enable external nodes to form P2P network with cluster bootnodes by setting up static IPs and LoadBalancer services

EXAMPLES
  # Setup static IPs with interactive provider selection

  $ scrollsdk setup bootnode-public-p2p



  # Setup static IPs for AWS with specific cluster and region

  $ scrollsdk setup bootnode-public-p2p --provider=aws --cluster-name=my-cluster --region=us-west-2



  # Setup with custom values directory

  $ scrollsdk setup bootnode-public-p2p --values-dir=./custom-values



  # Non-interactive mode (requires --provider)

  $ scrollsdk setup bootnode-public-p2p --non-interactive --provider=aws --cluster-name=my-cluster --region=us-west-2



  # JSON output mode

  $ scrollsdk setup bootnode-public-p2p --non-interactive --json --provider=aws --cluster-name=my-cluster --region=us-west-2
```

_See code: [src/commands/setup/bootnode-public-p2p.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/bootnode-public-p2p.ts)_

## `scrollsdk setup bridge-init`

Initialize DogeOS bridge after L2 artifacts and CubeSigner keys are ready

```
USAGE
  $ scrollsdk setup bridge-init [--docker-platform <value>] [--image-tag <value>] [--json] [-N] [-s <value>] [--step
    <value>]

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

  --step=<value>
      [default: all] Bridge init step to run. all runs 1-prepare, 2-setup, 3-bridge-info, 4-fund, and 5-protocol-context.
      1-prepare requires values/genesis.yaml, extracts .data/genesis.json, and prepares protocol_seed.toml. 2-setup is NOT
      idempotent: generate test keys and broadcast the setup transaction. 3-bridge-info is idempotent: generate namespace
      and bridge.json. 4-fund is NOT idempotent: broadcast configured bridge-funding and/or deposit-seed transactions. 5-protocol-context is
      idempotent: generate protocol_context.json. Numeric aliases 1, 2, 3, 4, and 5 are accepted.

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

Initialize databases with new users and passwords interactively or update permissions

```
USAGE
  $ scrollsdk setup db-init [-c] [-d] [--json] [-N] [-u] [--update-port <value>]

FLAGS
  -N, --non-interactive      Run without prompts, using config.toml values. Requires [db.admin] section with
                             PUBLIC_HOST, PUBLIC_PORT, USERNAME, PASSWORD (or $ENV: refs)
  -c, --clean                Delete existing database and user before creating new ones
  -d, --debug                Show debug output including SQL queries
  -u, --update-permissions   Update permissions for existing users
      --json                 Output in JSON format (stdout for data, stderr for logs)
      --update-port=<value>  Update the port of current database values

DESCRIPTION
  Initialize databases with new users and passwords interactively or update permissions

EXAMPLES
  $ scrollsdk setup db-init

  $ scrollsdk setup db-init --update-permissions

  $ scrollsdk setup db-init --update-permissions --debug

  $ scrollsdk setup db-init --clean

  $ scrollsdk setup db-init --update-db-port=25061

  $ scrollsdk setup db-init --non-interactive

  $ scrollsdk setup db-init --non-interactive --json --clean
```

_See code: [src/commands/setup/db-init.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/db-init.ts)_

## `scrollsdk setup disable-internal`

Disable ingress for internal services (Dogecoin, Anvil L1)

```
USAGE
  $ scrollsdk setup disable-internal [--dry-run] [-f] [--list-k8s |  | [--disable <value> | --list | --enable <value> |
    --disable-internal] |  | ] [-n <value>] [--skip-helm] [--values-dir <value>]

FLAGS
  -f, --force               Skip confirmation prompts
  -n, --namespace=<value>   [default: default] Kubernetes namespace
      --disable=<value>     Disable ingress for a service
      --disable-internal    Disable all internal services (Dogecoin, Anvil L1) using kubectl
      --dry-run             Show what would be deleted without actually deleting
      --enable=<value>      Enable ingress for a service
      --list                List current ingress status from local values files
      --list-k8s            List current ingress status from Kubernetes cluster
      --skip-helm           Skip helm upgrade
      --values-dir=<value>  [default: ./values] Directory containing values files

DESCRIPTION
  Disable ingress for internal services (Dogecoin, Anvil L1)

EXAMPLES
  $ scrollsdk setup disable-internal

  $ scrollsdk setup disable-internal --namespace scroll

  $ scrollsdk setup disable-internal --dry-run

  $ scrollsdk setup disable-internal --list

  $ scrollsdk setup disable-internal --list-k8s

  $ scrollsdk setup disable-internal --enable l2-rpc

  $ scrollsdk setup disable-internal --disable frontends
```

_See code: [src/commands/setup/disable-internal.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/disable-internal.ts)_

## `scrollsdk setup doge-config`

Configure Dogecoin/DA settings and optionally initialize compiler-backed proof topology

```
USAGE
  $ scrollsdk setup doge-config [-c <value>] [--json] [-N] [--proof-artifact-source existing-s3|prepared-aws
    --proof-topology] [--proof-bucket <value> ] [--proof-coordinator-url <value> ] [--proof-endpoint-url <value> ]
    [--proof-enforcement observe|enforce ] [--proof-force-path-style ] [--proof-generation mock|real ]
    [--proof-key-prefix <value> ] [--proof-materials <value> ] [--proof-mode active|disabled ]
    [--proof-public-s3-endpoint <value> ] [--proof-region <value> ] [--proof-topology-compiler-binary <value> ]
    [--proof-witness-dir <value> ] [--proof-witness-rpc-url <value> ] [--proof-witness-source block_witness_dir|rpc ]
    [--proof-worker-deployment-backend docker_compose|kubernetes ] [--proof-worker-launch external|local_cpu|local_cuda
    ]

FLAGS
  -N, --non-interactive                           Run without prompts, using existing config values
  -c, --config=<value>                            Path to config file
      --json                                      Output in JSON format (stdout for data, stderr for logs)
      --proof-artifact-source=<option>            Artifact resource source used by --proof-topology
                                                  <options: existing-s3|prepared-aws>
      --proof-bucket=<value>                      Existing S3-compatible proof artifact bucket
      --proof-coordinator-url=<value>             HTTPS Proof Coordinator URL reachable by mock and production Workers
      --proof-endpoint-url=<value>                Worker-visible S3-compatible endpoint root
      --proof-enforcement=<option>                Proof enforcement switch; keep observe until real proofs are validated
                                                  <options: observe|enforce>
      --[no-]proof-force-path-style               Use path-style S3 object URLs for an existing compatible store
      --proof-generation=<option>                 Proof generation implementation selected for active services
                                                  <options: mock|real>
      --proof-key-prefix=<value>                  Base proof artifact key prefix before compiler digest scoping
      --proof-materials=<value>                   Prepared proof-materials-v1.json receipt
      --proof-mode=<option>                       Initial proof mode (default: existing value or disabled)
                                                  <options: active|disabled>
      --proof-public-s3-endpoint=<value>          External Worker/signer-visible S3 endpoint when different from the
                                                  store endpoint
      --proof-region=<value>                      Existing S3-compatible proof artifact region
      --proof-topology                            Initialize or replace compiler-backed proof topology
      --proof-topology-compiler-binary=<value>    Development-only local dogeos-proof-topology binary used for both
                                                  initialization preflights
      --proof-witness-dir=<value>                 Production block witness directory relative to the prepared material
                                                  root
      --proof-witness-rpc-url=<value>             Scroll witness RPC URL used when --proof-witness-source=rpc
      --proof-witness-source=<option>             Chunk witness source used by real materialization
                                                  <options: block_witness_dir|rpc>
      --proof-worker-deployment-backend=<option>  Deployment adapter backend for local_cpu/local_cuda Workers
                                                  <options: docker_compose|kubernetes>
      --proof-worker-launch=<option>              Staged real Worker compute/ownership placement from the dogeos-core
                                                  contract
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
  $ scrollsdk setup domains [--cluster-issuer <value>] [--json] [--no-bootstrap-tls] [-N] [--values-dir <value>]

FLAGS
  -N, --non-interactive         Run without prompts, using config.toml values
      --cluster-issuer=<value>  [default: letsencrypt-prod] ClusterIssuer name to write into bootstrap chart TLS
                                annotations
      --json                    Output in JSON format (stdout for data, stderr for logs)
      --no-bootstrap-tls        Do not write TLS settings into bootstrap dogecoin/l1-devnet values
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

Configure the eth-da-submitter L1_COMMIT_SENDER signer

```
USAGE
  $ scrollsdk setup eth-da-submitter [--archive-bucket <value>] [--archive-key-prefix <value>] [--archive-public-base-url
    <value>] [--archive-region <value>] [--aws-profile <value>] [--aws-region <value>] [--create-archive-bucket]
    [--disable-archive] [--doge-config <value>] [--eks-cluster <value>] [--json] [--kms-key-id <value>] [--namespace
    <value>] [--network-alias <value>] [-N] [--role-arn <value>] [--service-account <value>] [--signer-backend
    local|aws-kms]

FLAGS
  -N, --non-interactive                  Run without prompts. Uses existing config or provided flags.
      --archive-bucket=<value>           S3 bucket whose read/write permissions should be granted to the
                                         eth-da-submitter KMS IAM role.
      --archive-key-prefix=<value>       Object key prefix under the archive bucket.
      --archive-public-base-url=<value>  Public HTTPS base URL used by blob consumers to read archived Ethereum DA
                                         blobs.
      --archive-region=<value>           Region that owns the archive bucket (defaults to --aws-region).
      --aws-profile=<value>              AWS CLI profile to use for KMS signer provisioning.
      --aws-region=<value>               AWS region for the EKS cluster and KMS key.
      --[no-]create-archive-bucket       Create the archive bucket if --archive-bucket is set and the bucket does not
                                         exist.
      --disable-archive                  Skip S3 blob archive setup for the eth-da-submitter KMS signer.
      --doge-config=<value>              Path to Dogecoin config file (defaults to .data/doge-config.toml)
      --eks-cluster=<value>              EKS cluster name or ARN used for IRSA trust binding.
      --json                             Output in JSON format (stdout for data, stderr for logs)
      --kms-key-id=<value>               Existing KMS key id, ARN, or alias for L1_COMMIT_SENDER / eth-da-submitter.
      --namespace=<value>                [default: default] Kubernetes namespace for the KMS signer service account.
      --network-alias=<value>            Resource alias used to derive deterministic KMS aliases and IAM role names.
      --role-arn=<value>                 Existing IAM role ARN to annotate on the eth-da-submitter service account.
      --service-account=<value>          [default: eth-da-submitter] Kubernetes service account used by
                                         eth-da-submitter.
      --signer-backend=<option>          Signer backend for L1_COMMIT_SENDER / eth-da-submitter.
                                         <options: local|aws-kms>

DESCRIPTION
  Configure the eth-da-submitter L1_COMMIT_SENDER signer

EXAMPLES
  $ scrollsdk setup eth-da-submitter

  $ scrollsdk setup eth-da-submitter --signer-backend aws-kms --aws-region us-west-2 --eks-cluster dogeos-testnet --network-alias testnet

  $ scrollsdk setup eth-da-submitter --non-interactive --json --signer-backend local
```

_See code: [src/commands/setup/eth-da-submitter.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/eth-da-submitter.ts)_

## `scrollsdk setup export-signer-policy`

Export the dogeos-core attestation_evidence_v2 policy selected by the current proof topology. The bundle contains bridge-owned protocol/verifier inputs; each signer operator keeps its RPC source sets, rotation allowlists, keys, and release pins.

```
USAGE
  $ scrollsdk setup export-signer-policy [-c <value>] [--json] [--out <value>] [--protocol-context <value>]
    [--signer-proof-artifact-base-url <value>] [--spec <value>] [--tso-url <value>]

FLAGS
  -c, --config=<value>                          Path to doge-config.toml
      --json                                    Output structured JSON
      --out=<value>                             [default: signer-policy-bundle] Bundle output directory
      --protocol-context=<value>                [default: .data/protocol_context.json] Canonical protocol_context.json
                                                produced by setup bridge-init
      --signer-proof-artifact-base-url=<value>  Public GET base used by signers; default: compiler output in
                                                withdrawal-processor/WithdrawalProcessor.toml
      --spec=<value>                            Optional DeploymentSpec proof source; conflicts with doge-config
                                                [proof_topology]
      --tso-url=<value>                         TSO base URL reachable from signer networks; default: config.toml
                                                [ingress].TSO_HOST

DESCRIPTION
  Export the dogeos-core attestation_evidence_v2 policy selected by the current proof topology. The bundle contains
  bridge-owned protocol/verifier inputs; each signer operator keeps its RPC source sets, rotation allowlists, keys, and
  release pins.

EXAMPLES
  $ scrollsdk setup export-signer-policy

  $ scrollsdk setup export-signer-policy --tso-url https://tso.dogeos.example
```

_See code: [src/commands/setup/export-signer-policy.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/export-signer-policy.ts)_

## `scrollsdk setup fee-oracle`

Configure the fee-oracle L2_GAS_ORACLE_SENDER signer

```
USAGE
  $ scrollsdk setup fee-oracle [--aws-profile <value>] [--aws-region <value>] [--doge-config <value>] [--eks-cluster
    <value>] [--json] [--kms-key-id <value>] [--namespace <value>] [--network-alias <value>] [-N] [--role-arn <value>]
    [--service-account <value>] [--signer-backend local|aws-kms]

FLAGS
  -N, --non-interactive          Run without prompts. Uses existing config or provided flags.
      --aws-profile=<value>      AWS CLI profile to use for KMS signer provisioning.
      --aws-region=<value>       AWS region for the EKS cluster and KMS key.
      --doge-config=<value>      Path to Dogecoin config file (defaults to .data/doge-config.toml)
      --eks-cluster=<value>      EKS cluster name or ARN used for IRSA trust binding.
      --json                     Output in JSON format (stdout for data, stderr for logs)
      --kms-key-id=<value>       Existing KMS key id, ARN, or alias for L2_GAS_ORACLE_SENDER / fee-oracle.
      --namespace=<value>        [default: default] Kubernetes namespace for the KMS signer service account.
      --network-alias=<value>    Resource alias used to derive deterministic KMS aliases and IAM role names.
      --role-arn=<value>         Existing IAM role ARN to annotate on the fee-oracle service account.
      --service-account=<value>  [default: fee-oracle] Kubernetes service account used by fee-oracle.
      --signer-backend=<option>  Signer backend for L2_GAS_ORACLE_SENDER / fee-oracle.
                                 <options: local|aws-kms>

DESCRIPTION
  Configure the fee-oracle L2_GAS_ORACLE_SENDER signer

EXAMPLES
  $ scrollsdk setup fee-oracle

  $ scrollsdk setup fee-oracle --signer-backend aws-kms --aws-region us-west-2 --eks-cluster dogeos-testnet --network-alias testnet

  $ scrollsdk setup fee-oracle --non-interactive --json --signer-backend local
```

_See code: [src/commands/setup/fee-oracle.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/fee-oracle.ts)_

## `scrollsdk setup gen-keystore`

Generate L2 node keys and deployment account keypairs

```
USAGE
  $ scrollsdk setup gen-keystore [--accounts] [--bootnode-count <value>] [--from-spec <value>] [--json] [-N]
    [--regenerate-bootnodes] [--regenerate-sequencers] [--sequencer-count <value>] [--sequencer-password <value>]

FLAGS
  -N, --non-interactive             Run without prompts. Uses existing keys or generates new ones based on flags.
      --[no-]accounts               Generate account key pairs
      --bootnode-count=<value>      [default: 2] Number of bootnodes. In non-interactive mode, generates if not enough
                                    exist.
      --from-spec=<value>           Path to DeploymentSpec YAML. Uses infrastructure.sequencerCount and bootnodeCount as
                                    count defaults.
      --json                        Output in JSON format (stdout for data, stderr for logs)
      --regenerate-bootnodes        Force regeneration of all bootnode keys (non-interactive mode)
      --regenerate-sequencers       Force regeneration of all sequencer keys (non-interactive mode)
      --sequencer-count=<value>     [default: 2] Number of sequencers (including primary). In non-interactive mode,
                                    generates if not enough exist.
      --sequencer-password=<value>  Password for sequencer keystores (or use $ENV:VAR_NAME pattern). Defaults to a
                                    generated random password for new sequencers in non-interactive mode.

DESCRIPTION
  Generate L2 node keys and deployment account keypairs

EXAMPLES
  $ scrollsdk setup gen-keystore

  $ scrollsdk setup gen-keystore --no-accounts

  $ scrollsdk setup gen-keystore --non-interactive

  $ scrollsdk setup gen-keystore --non-interactive --json --sequencer-count 2 --bootnode-count 2

  $ scrollsdk setup gen-keystore --non-interactive --sequencer-count 2 --bootnode-count 2
```

_See code: [src/commands/setup/gen-keystore.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/gen-keystore.ts)_

## `scrollsdk setup gen-l2-artifacts`

Generate L2 deployment artifacts, including genesis, public config, contract config, and Helm config values

```
USAGE
  $ scrollsdk setup gen-l2-artifacts [--base-fee-per-gas <value>] [--configs-dir <value>] [--deployment-salt <value>]
    [--image-tag <value>] [--json] [--l1-fee-vault-addr <value>] [--l1-plonk-verifier-addr <value>]
    [--l2-bridge-fee-recipient-addr <value>] [-N] [--skip-deployment-salt-update] [--skip-l1-fee-vault-update]
    [--skip-l1-plonk-verifier-update]

FLAGS
  -N, --non-interactive                       Run without prompts. Uses config values or sensible defaults.
      --base-fee-per-gas=<value>              Base fee per gas (non-interactive mode). Uses existing config value if not
                                              provided.
      --configs-dir=<value>                   [default: values] Directory name to copy configs to
      --deployment-salt=<value>               Deployment salt value (non-interactive mode). If not provided, keeps
                                              existing or auto-increments.
      --image-tag=<value>                     Specify the Docker image tag to use
      --json                                  Output in JSON format (stdout for data, stderr for logs)
      --l1-fee-vault-addr=<value>             L1 fee vault address (non-interactive mode). Defaults to OWNER_ADDR.
      --l1-plonk-verifier-addr=<value>        L1 plonk verifier address (non-interactive mode). If not provided, one
                                              will be deployed.
      --l2-bridge-fee-recipient-addr=<value>  L2 bridge fee recipient address (non-interactive mode). Defaults to zero
                                              address.
      --skip-deployment-salt-update           Skip deployment salt update (non-interactive mode)
      --skip-l1-fee-vault-update              Skip L1 fee vault address update (non-interactive mode)
      --skip-l1-plonk-verifier-update         Skip L1 plonk verifier address update (non-interactive mode)

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

## `scrollsdk setup gen-secrets`

Generate local secret files from config.toml, Dogecoin config, and bridge initialization outputs

```
USAGE
  $ scrollsdk setup gen-secrets [--doge-config <value>] [--json] [-N]

FLAGS
  -N, --non-interactive      Run without prompts. Uses config values or fails fast.
      --doge-config=<value>  Path to Dogecoin config file (defaults to .data/doge-config.toml)
      --json                 Output in JSON format (stdout for data, stderr for logs)

DESCRIPTION
  Generate local secret files from config.toml, Dogecoin config, and bridge initialization outputs

EXAMPLES
  $ scrollsdk setup gen-secrets

  $ scrollsdk setup gen-secrets --doge-config .data/doge-config.toml

  $ scrollsdk setup gen-secrets --non-interactive --json --doge-config .data/doge-config.toml
```

_See code: [src/commands/setup/gen-secrets.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/gen-secrets.ts)_

## `scrollsdk setup generate-from-spec`

Generate configuration files from a DeploymentSpec YAML file

```
USAGE
  $ scrollsdk setup generate-from-spec -s <value> [--config-only] [--dry-run] [--env-file <value>] [-f] [--json] [-o <value>]
    [--values-only] [--with-values]

FLAGS
  -f, --force             Overwrite existing files without warning
  -o, --output=<value>    [default: .] Output directory for generated files
  -s, --spec=<value>      (required) Path to DeploymentSpec YAML file
      --config-only       Only generate config.toml and .data/*.toml. This is the default.
      --dry-run           Validate spec and show what would be generated without writing files
      --env-file=<value>  Load dotenv-style environment variables before parsing the spec. Defaults to .env.local/.env
                          next to the spec and current directory when present.
      --json              Output in JSON format (stdout for data, stderr for logs)
      --values-only       Only generate values/*.yaml Helm files
      --with-values       Also generate values/*.yaml Helm files

DESCRIPTION
  Generate configuration files from a DeploymentSpec YAML file

EXAMPLES
  # Generate configs in current directory

  $ scrollsdk setup generate-from-spec --spec deployment-spec.yaml



  # Generate configs to specific output directory

  $ scrollsdk setup generate-from-spec --spec deployment-spec.yaml --output ./my-deployment



  # Generate with JSON output for automation

  $ scrollsdk setup generate-from-spec --spec deployment-spec.yaml --json



  # Load private keys/passwords from an env file before deriving account addresses

  $ scrollsdk setup generate-from-spec --spec deployment-spec.yaml --env-file .env.local



  # Dry run - validate and show what would be generated

  $ scrollsdk setup generate-from-spec --spec deployment-spec.yaml --dry-run



  # Generate Helm values files explicitly

  $ scrollsdk setup generate-from-spec --spec deployment-spec.yaml --with-values

  $ scrollsdk setup generate-from-spec --spec deployment-spec.yaml --values-only
```

_See code: [src/commands/setup/generate-from-spec.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/generate-from-spec.ts)_

## `scrollsdk setup l2-bootnode-reth`

Configure rollup-node reth bootnode P2P nodekeys

```
USAGE
  $ scrollsdk setup l2-bootnode-reth [-c <value>] [--doge-config <value>] [--json] [--nodekey <value>...] [-N]
    [--secret-mode external-secret|plain]

FLAGS
  -N, --non-interactive       Run without prompts. Generates missing nodekeys.
  -c, --count=<value>         Number of reth bootnode instances to configure.
      --doge-config=<value>   Path to Dogecoin config file (defaults to .data/doge-config.toml)
      --json                  Output in JSON format (stdout for data, stderr for logs)
      --nodekey=<value>...    Existing reth bootnode private key as 64 hex chars, with or without 0x. Repeat for
                              multiple instances.
      --secret-mode=<option>  How nodekey material is referenced from values YAML.
                              <options: external-secret|plain>

DESCRIPTION
  Configure rollup-node reth bootnode P2P nodekeys

EXAMPLES
  $ scrollsdk setup l2-bootnode-reth --count 2

  $ scrollsdk setup l2-bootnode-reth --count 2 --secret-mode external-secret --non-interactive

  $ scrollsdk setup l2-bootnode-reth --count 1 --nodekey 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

_See code: [src/commands/setup/l2-bootnode-reth.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/l2-bootnode-reth.ts)_

## `scrollsdk setup l2-sequencer-reth`

Configure a rollup-node reth sequencer signer key and P2P nodekey

```
USAGE
  $ scrollsdk setup l2-sequencer-reth [--aws-profile <value>] [--aws-region <value>] [--doge-config <value>] [--eks-cluster
    <value>] [-i <value>] [--json] [--kms-key-id <value>] [--namespace <value>] [--network-alias <value>] [--nodekey
    <value>] [--nodekey-secret-mode external-secret|plain] [-N] [--role-arn <value>] [--service-account <value>]
    [--signer-mode aws-kms|external-secret|plain] [--signer-private-key <value>]

FLAGS
  -N, --non-interactive               Run without prompts. Generates missing local keys.
  -i, --index=<value>                 Sequencer instance index to configure.
      --aws-profile=<value>           AWS CLI profile to use for KMS signer provisioning.
      --aws-region=<value>            AWS region for the EKS cluster and KMS key.
      --doge-config=<value>           Path to Dogecoin config file (defaults to .data/doge-config.toml)
      --eks-cluster=<value>           EKS cluster name or ARN used for IRSA trust binding.
      --json                          Output in JSON format (stdout for data, stderr for logs)
      --kms-key-id=<value>            Existing KMS key id, ARN, or alias for the reth sequencer signer.
      --namespace=<value>             [default: default] Kubernetes namespace for the KMS signer service account.
      --network-alias=<value>         Resource alias used to derive deterministic KMS aliases and IAM role names.
      --nodekey=<value>               Existing reth P2P nodekey private key as 64 hex chars, with or without 0x.
      --nodekey-secret-mode=<option>  How P2P nodekey material is referenced from values YAML. AWS KMS signer mode only;
                                      local signer mode uses --signer-mode.
                                      <options: external-secret|plain>
      --role-arn=<value>              Existing IAM role ARN to annotate on the sequencer service account.
      --service-account=<value>       Kubernetes service account used by this sequencer.
      --signer-mode=<option>          How the reth sequencer block signer is configured.
                                      <options: aws-kms|external-secret|plain>
      --signer-private-key=<value>    Existing local sequencer signer private key, with or without 0x.

DESCRIPTION
  Configure a rollup-node reth sequencer signer key and P2P nodekey

EXAMPLES
  $ scrollsdk setup l2-sequencer-reth --index 2

  $ scrollsdk setup l2-sequencer-reth --index 2 --signer-mode external-secret --non-interactive

  $ scrollsdk setup l2-sequencer-reth --index 2 --signer-mode aws-kms --aws-region us-west-2 --eks-cluster dogeos-testnet --network-alias testnet
```

_See code: [src/commands/setup/l2-sequencer-reth.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/l2-sequencer-reth.ts)_

## `scrollsdk setup prep-charts`

Validate Makefile and prepare Helm charts for Scroll SDK

```
USAGE
  $ scrollsdk setup prep-charts [--doge-config <value>] [--github-token <value>] [--github-username <value>] [--json]
    [-N] [--proof-topology-compiler-binary <value> | --proof-topology-compiler-image <value>] [--skip-auth-check]
    [--skip-l2-contract-deployment-block] [--spec <value>] [--values-dir <value>]

FLAGS
  -N, --non-interactive                         Run without prompts. Auto-applies all detected changes.
      --doge-config=<value>                     Path to Dogecoin config file
      --github-token=<value>                    GitHub Personal Access Token
      --github-username=<value>                 GitHub username
      --json                                    Output in JSON format (stdout for data, stderr for logs)
      --proof-topology-compiler-binary=<value>  Development-only local dogeos-proof-topology binary; production uses the
                                                digest-pinned configured image
      --proof-topology-compiler-image=<value>   Override the digest-pinned proof-topology compiler image
      --skip-auth-check                         Skip authentication check for individual charts
      --skip-l2-contract-deployment-block       Do not overwrite L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK in L2 production
                                                values files
      --spec=<value>                            Optional DeploymentSpec proof source; conflicts with doge-config
                                                [proof_topology]
      --values-dir=<value>                      [default: ./values] Directory containing values files; must be inside
                                                the deployment root for transactional generation

DESCRIPTION
  Validate Makefile and prepare Helm charts for Scroll SDK

EXAMPLES
  $ scrollsdk setup prep-charts

  $ scrollsdk setup prep-charts --spec deployment-spec.yaml

  $ scrollsdk setup prep-charts --github-username=your-username --github-token=your-token

  $ scrollsdk setup prep-charts --values-dir=./custom-values

  $ scrollsdk setup prep-charts --skip-auth-check

  $ scrollsdk setup prep-charts --skip-l2-contract-deployment-block
```

_See code: [src/commands/setup/prep-charts.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/prep-charts.ts)_

## `scrollsdk setup proof-aws-init`

Provision proof AWS resources and persist their non-secret resource facts as prep-charts input; never read or modify generated Helm values

```
USAGE
  $ scrollsdk setup proof-aws-init [--artifact-public-endpoint-url <value>] [--artifact-public-read-mode
    direct-s3|shared-s3|existing-public-s3|existing-gateway] [--artifact-read-route-table-id <value>...]
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
      --artifact-public-read-mode=<option>       Public artifact delivery: direct-s3 manages bucket settings; shared-s3
                                                 adds only this prefix read grant; existing modes preserve
                                                 operator-managed delivery
                                                 <options: direct-s3|shared-s3|existing-public-s3|existing-gateway>
      --artifact-read-route-table-id=<value>...  Advanced override: EKS subnet route table to associate with the S3
                                                 gateway endpoint (repeatable; normally auto-discovered)
      --artifact-read-vpc-endpoint-id=<value>    Advanced override: existing S3 Gateway VPC endpoint (normally
                                                 auto-discovered or created)
      --aws-profile=<value>                      AWS CLI profile used for provisioning
      --aws-region=<value>                       AWS region containing EKS and the proof token secret (auto-detected
                                                 when omitted)
      --bucket=<value>                           Advanced consistency assertion for the shared artifact bucket; the
                                                 value is read from doge-config
      --config=<value>                           [default: .data/proof-aws.json] Output config file consumed by setup
                                                 prep-charts
      --coordinator-service-account=<value>      Kubernetes service account used by proof-coordinator (default:
                                                 proof-coordinator)
      --deployment-alias=<value>                 Unique deployment instance alias used to derive deterministic bucket
                                                 and IAM role names
      --doge-config=<value>                      [default: .data/doge-config.toml] DogeOS config containing the
                                                 canonical ethereumDa.blobArchive.s3 store
      --eks-cluster=<value>                      EKS cluster name used by the IRSA trust policies (selected
                                                 interactively when omitted)
      --json                                     Output structured JSON
      --key-prefix=<value>                       Advanced consistency assertion for the shared artifact key prefix; the
                                                 value is read from doge-config
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

  $ scrollsdk setup proof-aws-init --artifact-public-read-mode shared-s3 --skip-vpc-endpoint

  $ scrollsdk setup proof-aws-init --artifact-public-read-mode existing-gateway --artifact-public-endpoint-url https://objects.example.com

  $ scrollsdk setup proof-aws-init --rotate-tokens
```

_See code: [src/commands/setup/proof-aws-init.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/proof-aws-init.ts)_

## `scrollsdk setup proof-config-check`

Validate generated proof configs, bundle revision, two switches, and Worker bundle without contacting Kubernetes

```
USAGE
  $ scrollsdk setup proof-config-check [-c <value>] [--contract <value>] [--deployment-dir <value>] [--json] [--spec
  <value>]

FLAGS
  -c, --config=<value>          doge-config.toml path
      --contract=<value>        [default: .data/proof-deployment.json] Proof deployment contract path
      --deployment-dir=<value>  [default: .] Deployment root
      --json                    Output structured JSON
      --spec=<value>            Optional DeploymentSpec proof source

DESCRIPTION
  Validate generated proof configs, bundle revision, two switches, and Worker bundle without contacting Kubernetes
```

_See code: [src/commands/setup/proof-config-check.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/proof-config-check.ts)_

## `scrollsdk setup proof-materials`

Prepare shared proof identities for mock, or identities plus real proving artifacts for production

```
USAGE
  $ scrollsdk setup proof-materials [--batch-materializer <value>] [--bridge-artifact-dir <value>] [--chunk-materializer
    <value>] [--compiler-image <value>] [--deployment-dir <value>] [--generation mock|real] [--identity-env <value>]
    [--json] [--materials-dir <value>] [--mock-worker-image <value>] [-N] [--output <value>] [--production-worker-image
    <value>] [--protocol-context <value>] [--software-manifest <value>]

FLAGS
  -N, --non-interactive                  Do not prompt; omitted generation defaults to mock
      --batch-materializer=<value>       Built dogeos-core Batch materializer binary; real only
      --bridge-artifact-dir=<value>      Optional output of prover-worker --stage-bridge-artifact; real only
      --chunk-materializer=<value>       Built dogeos-core Chunk materializer binary; real only
      --compiler-image=<value>           dogeos-proof-topology tag or digest from the approved release lineage
      --deployment-dir=<value>           [default: .] Deployment directory
      --generation=<option>              Materials to prepare: mock imports shared identities only; real imports the
                                         full proving release
                                         <options: mock|real>
      --identity-env=<value>             Optional real-identity.env for staging real identities during mock; required
                                         for real
      --json                             Output structured JSON
      --materials-dir=<value>            [default: .data/proof-materials] Deployment-relative material destination
      --mock-worker-image=<value>        Mock Worker tag or digest from the same approved release lineage
      --output=<value>                   [default: .data/proof-materials-v1.json] Deployment-relative receipt path
      --production-worker-image=<value>  Real Worker release tag or digest; real only
      --protocol-context=<value>         Deployment protocol_context.json required with --bridge-artifact-dir; real only
      --software-manifest=<value>        real-proving-artifacts.json written by dogeos-core --check-only; real only

DESCRIPTION
  Prepare shared proof identities for mock, or identities plus real proving artifacts for production

EXAMPLES
  $ scrollsdk setup proof-materials --generation mock

  $ scrollsdk setup proof-materials --generation mock --identity-env /build/real-identity.env

  $ scrollsdk setup proof-materials --generation real --software-manifest /build/real-proving-artifacts.json --identity-env /build/real-identity.env --chunk-materializer /build/materialize-chunk-oneshot --batch-materializer /build/scroll-runtime-materializer --mock-worker-image repo/mock@sha256:... --production-worker-image repo/worker@sha256:... --compiler-image repo/compiler@sha256:...

  $ scrollsdk setup proof-materials --generation real --bridge-artifact-dir /build/bridge --protocol-context .data/protocol_context.json
```

_See code: [src/commands/setup/proof-materials.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/proof-materials.ts)_

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

Hydrate a compiler-generated Docker Compose prover-worker bundle with its bearer token after deterministic configuration generation

```
USAGE
  $ scrollsdk setup proof-worker [--aws-profile <value>] [--aws-region <value>] [--deployment-dir <value>] [--json]
    [--secret-name <value>] [--worker-token-env <value>]

FLAGS
  --aws-profile=<value>       AWS CLI profile used to read the prover-worker token
  --aws-region=<value>        AWS region of the proof coordinator secret; inferred from .data/proof-aws.json when
                              omitted
  --deployment-dir=<value>    [default: .] Deployment root containing .data/proof-deployment.json
  --json                      Output structured JSON
  --secret-name=<value>       Secrets Manager secret containing prover-worker-token; inferred from .data/proof-aws.json
                              when omitted
  --worker-token-env=<value>  [default: DOGEOS_PROVER_WORKER_TOKEN] Environment variable containing the worker token;
                              when unset, read it from Secrets Manager

DESCRIPTION
  Hydrate a compiler-generated Docker Compose prover-worker bundle with its bearer token after deterministic
  configuration generation

EXAMPLES
  $ scrollsdk setup proof-worker

  $ scrollsdk setup proof-worker --deployment-dir /srv/dogeos/testnet --aws-profile staging
```

After synchronizing the hydrated bundle to the Worker host, run
`scrollsdk setup proof-worker-check` there, then use
`./prover-worker-compose config --quiet` and
`./prover-worker-compose up -d prover-worker`. The generated launcher runs the
container as the invoking host UID/GID so the bind-mounted `0600` token remains
private and readable; do not invoke raw `docker compose up` for this bundle.

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

## `scrollsdk setup push-secrets`

Push secrets to the selected secret service

```
USAGE
  $ scrollsdk setup push-secrets [--aws-prefix <value>] [--aws-region <value>] [--aws-service-account <value>] [-c] [-d]
    [--json] [-N] [--provider aws|vault] [-f <value>] [--skip-yaml-update] [--values-dir <value>] [--values-file
    <value>] [--vault-path <value>] [--vault-server <value>] [--vault-token-secret-key <value>]
    [--vault-token-secret-name <value>] [--vault-version <value>]

FLAGS
  -N, --non-interactive                  Run without prompts. Auto-overrides existing secrets.
  -c, --cubesigner-only                  Only push CubeSigner related secrets (cubesigner-signer-* files)
  -d, --debug                            Show debug output
  -f, --secret-file=<value>              Local secret file to push (supports .env and .json files)
      --aws-prefix=<value>               [default: dogeos] AWS Secrets Manager path prefix (e.g., dogeos/testnet)
      --aws-region=<value>               AWS region for secrets (e.g., us-east-1)
      --aws-service-account=<value>      [default: external-secrets] AWS IAM service account
      --json                             Output in JSON format (stdout for data, stderr for logs)
      --provider=<option>                [default: aws] Secret service provider (aws or vault)
                                         <options: aws|vault>
      --skip-yaml-update                 Skip updating production YAML files with new secret provider
      --values-dir=<value>               [default: values] Directory containing the values files
      --values-file=<value>              Specific Helm values YAML file to update after pushing secrets
      --vault-path=<value>               [default: scroll] Vault path prefix
      --vault-server=<value>             [default: http://vault.default.svc.cluster.local:8200] Vault server URL
      --vault-token-secret-key=<value>   [default: token] Vault token secret key
      --vault-token-secret-name=<value>  [default: vault-token] Vault token secret name
      --vault-version=<value>            [default: v2] Vault version

DESCRIPTION
  Push secrets to the selected secret service

EXAMPLES
  $ scrollsdk setup push-secrets

  $ scrollsdk setup push-secrets --debug

  $ scrollsdk setup push-secrets --values-dir custom-values

  $ scrollsdk setup push-secrets --secret-file secrets/l2-reth-bootnode-0-secret.env --values-file values/l2-reth-bootnode-production-0.yaml

  $ scrollsdk setup push-secrets --cubesigner-only

  $ scrollsdk setup push-secrets -c --debug
```

_See code: [src/commands/setup/push-secrets.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/push-secrets.ts)_

## `scrollsdk setup tls`

Update TLS configuration in Helm charts

```
USAGE
  $ scrollsdk setup tls [--cluster-issuer <value>] [--create-issuer] [-d] [--issuer-email <value>] [--json]
    [--kube-context <value>] [-N] [--values-dir <value>]

FLAGS
  -N, --non-interactive         Run without prompts. Requires --cluster-issuer or (--create-issuer with --issuer-email)
  -d, --debug                   Show debug output and confirm before making changes
      --cluster-issuer=<value>  Specify the ClusterIssuer to use (for non-interactive mode)
      --create-issuer           Create a letsencrypt-prod ClusterIssuer if none exists (for non-interactive mode)
      --issuer-email=<value>    Email address for the ClusterIssuer (required with --create-issuer)
      --json                    Output in JSON format (stdout for data, stderr for logs)
      --kube-context=<value>    Explicit Kubernetes context for issuer checks and creation
      --values-dir=<value>      [default: values] Directory containing the values files

DESCRIPTION
  Update TLS configuration in Helm charts

EXAMPLES
  $ scrollsdk setup tls

  $ scrollsdk setup tls --debug

  $ scrollsdk setup tls --values-dir custom-values

  $ scrollsdk setup tls --non-interactive --cluster-issuer letsencrypt-prod

  $ scrollsdk setup tls --non-interactive --json --cluster-issuer letsencrypt-prod

  $ scrollsdk setup tls --non-interactive --create-issuer --issuer-email admin@example.com
```

_See code: [src/commands/setup/tls.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/tls.ts)_

## `scrollsdk setup verify-contracts`

Set up contracts verification

```
USAGE
  $ scrollsdk setup verify-contracts [--image-tag <value>]

FLAGS
  --image-tag=<value>  Specify the Docker image tag to use

DESCRIPTION
  Set up contracts verification

EXAMPLES
  $ scrollsdk setup verify-contracts

  $ scrollsdk setup verify-contracts --image-tag verify-v0.2.0-debug
```

_See code: [src/commands/setup/verify-contracts.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/verify-contracts.ts)_

## `scrollsdk signer init`

Signer-operator tool: create key material, a public descriptor, secret deployment env, and a partner-owned V2 policy template. Run on your infrastructure; secrets and AWS calls never leave it. Send the descriptor before genesis, then deploy and preflight only after receiving the canonical-context policy bundle.

```
USAGE
  $ scrollsdk signer init --id <value> [--allowed-git-commit <value>] [--allowed-release-version <value>]
    [--allowed-signing-policy-version <value>] [--aws-profile <value>] [--backend local|aws-kms] [--create-key]
    [--endpoint <value>] [--force] [--json] [--kms-key-id <value>] [--kms-region <value>] [--network
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
  --endpoint=<value>                        HTTP(S) base URL reachable from the bridge operator/TSO network; use a TLS
                                            domain in production or a private IP in an isolated mock/VPN test (can be
                                            filled later via signer preflight)
  --force                                   Overwrite an existing env file in the output directory
  --id=<value>                              (required) Stable signer identifier (DNS-label shaped, agreed with the
                                            bridge operator)
  --json                                    Output structured JSON
  --kms-key-id=<value>                      aws-kms backend: key id, ARN, or alias/... of your existing ECC_SECG_P256K1
                                            signing key
  --kms-region=<value>                      aws-kms backend: AWS region of the key
  --network=<option>                        [default: testnet] Dogecoin network
                                            <options: mainnet|regtest|testnet>
  --out=<value>                             Output directory (default: ./signer-<id>)

DESCRIPTION
  Signer-operator tool: create key material, a public descriptor, secret deployment env, and a partner-owned V2 policy
  template. Run on your infrastructure; secrets and AWS calls never leave it. Send the descriptor before genesis, then
  deploy and preflight only after receiving the canonical-context policy bundle.

EXAMPLES
  $ scrollsdk signer init --id partner-a-signer-0 --network testnet --endpoint https://signer.partner-a.example:4040

  $ scrollsdk signer init --id partner-a-signer-0 --network mainnet --endpoint https://signer.partner-a.example:4040 --backend aws-kms --kms-key-id arn:aws:kms:... --kms-region us-east-1 --allowed-release-version 0.1.0 --allowed-git-commit 0123456789abcdef0123456789abcdef01234567

  $ scrollsdk signer init --id partner-a-signer-0 --network testnet --endpoint https://signer.partner-a.example:4040 --backend aws-kms --create-key --kms-region us-east-1 --allowed-release-version 0.1.0 --allowed-git-commit 0123456789abcdef0123456789abcdef01234567
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

Probe a deployed attestation-signer and verify its runtime identity. Add --require-production-ready after selecting enforcement=enforce to require dogeos-core attestation_evidence_v2 and all four production capabilities.

```
USAGE
  $ scrollsdk signer preflight [--dir <value>] [--endpoint <value>] [--expected-public-key <value>] [--id <value>]
    [--json] [--network mainnet|regtest|testnet] [--out <value>] [--require-production-ready]

FLAGS
  --dir=<value>                  signer init output directory; provides id/network/expected key from descriptor.json and
                                 receives the finalized descriptor
  --endpoint=<value>             Signer HTTP base URL to probe (with --dir, defaults to the descriptor endpoint if
                                 already set)
  --expected-public-key=<value>  Fail unless the runtime public key equals this compressed secp256k1 key (with --dir,
                                 defaults to the descriptor publicKey)
  --id=<value>                   Stable signer identifier for the emitted descriptor (required without --dir)
  --json                         Output structured JSON
  --network=<option>             Expected Dogecoin network (defaults to descriptor network with --dir, else to the
                                 network reported by /health)
                                 <options: mainnet|regtest|testnet>
  --out=<value>                  Write the descriptor JSON to this path (default with --dir: its descriptor.json;
                                 otherwise print to stdout)
  --require-production-ready     Also require /ready and /policy to prove all four attestation_evidence_v2 production
                                 capabilities are serving

DESCRIPTION
  Probe a deployed attestation-signer and verify its runtime identity. Add --require-production-ready after selecting
  enforcement=enforce to require dogeos-core attestation_evidence_v2 and all four production capabilities.

EXAMPLES
  $ scrollsdk signer preflight --dir signer-partner-a-signer-0 --endpoint https://signer.partner-a.example:4040

  $ scrollsdk signer preflight --endpoint https://signer.partner-a.example:4040 --id partner-a-signer-0 --out descriptor.json

  $ scrollsdk signer preflight --endpoint https://signer.partner-a.example:4040 --id partner-a-signer-0 --expected-public-key 02ab...

  $ scrollsdk signer preflight --dir signer-partner-a-signer-0 --require-production-ready
```

_See code: [src/commands/signer/preflight.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/signer/preflight.ts)_

## `scrollsdk test contracts`

Test contracts by checking deployment and initialization

```
USAGE
  $ scrollsdk test contracts [-c <value>] [-n <value>] [-p]

FLAGS
  -c, --config=<value>     [default: ./config.toml] Path to config.toml file
  -n, --contracts=<value>  [default: ./config-contracts.toml] Path to configs-contracts.toml file
  -p, --pod                Run inside Kubernetes pod

DESCRIPTION
  Test contracts by checking deployment and initialization
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
  CASENAME  The name of the case to run

FLAGS
  -b, --blockbookurl=<value>  [default: https://doge-electrs-testnet-demo.qed.me] blockbook url
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
