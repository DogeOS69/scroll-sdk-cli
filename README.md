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

1. ```bash
   scrollsdk setup domains
   ```

2. ```bash
   scrollsdk setup db-init --clean
   ```

3. ```bash
   scrollsdk setup gen-keystore
   ```

4. ```bash
   scrollsdk setup doge-config
   ```

5. ```bash
   scrollsdk setup gen-l2-artifacts
   ```

6. ```bash
   scrollsdk setup cubesigner-init
   ```

7. ```bash
   scrollsdk setup dummy-signers
   ```

8. ```bash
   scrollsdk setup bridge-init
   ```
   **Note:** If you encounter an "Insufficient base funds" error like this:
   ```
   2025-05-31T00:32:08.308083Z  INFO generate_test_keys: Checking funding for distribution helper address: nmCrhAu4STRor8Tmv4rNHt6JXeqUXFxeo1
   ......
   Error: Insufficient base funds for setup tx after selecting all UTXOs. Needed: 6049001000 sats, Have: 3950999000 sats
   ```
  or
  ```
  ? Enter the seed string 123456
  Pulling Docker Image: docker.io/dogeos69/generate-test-keys:v0.1.1-test
  Image pulled successfully
  Creating Docker Container...
  Starting Container
  M--- Running Test Setup & Key Generation (with OP_RETURN bridge funding) ---
  PLoading configuration from: "./.data/setup_defaults.toml"...
  'Starting setup for network: Testnet...
  )Using RPC URL: https://testnet.doge.xyz/
  :Using Blockbook URL: https://dogebook-testnet.nownodes.io
  �2025-05-31T03:19:48.077868Z  INFO generate_test_keys: Using OP_RETURN payload (hex): 00151a64570e4997739458455ba4ab5a535fd2e306 for script (hex): 6a1500151a64570e4997739458455ba4ab5a535fd2e306
  TDistribution Helper Address (derived from seed): nqBXoHUiH92gxgrsmFYjqcBNWZ7VMPFNJY
  {2025-05-31T03:19:48.077948Z  INFO generate_test_keys: Initializing Dogecoin RPC client...
  �2025-05-31T03:19:48.144522Z  INFO generate_test_keys: Checking funding for distribution helper address: nqBXoHUiH92gxgrsmFYjqcBNWZ7VMPFNJY
  �2025-05-31T03:19:49.671868Z ERROR generate_test_keys: Distribution Helper address nqBXoHUiH92gxgrsmFYjqcBNWZ7VMPFNJY has no funds on testnet!

  EPlease send some testnet DOGE to: nqBXoHUiH92gxgrsmFYjqcBNWZ7VMPFNJY
  Then re-run this script.
  ```   
   Send Dogecoin to the displayed helper address and retry the command. Please keep the same seed string, or the helper address will change.



8. ```bash
   scrollsdk setup gen-secrets
   ```

9. ```bash
   scrollsdk setup prep-charts
   ```

10. ```
    scrollsdk setup cubesigner-refresh
    ```

10. ```
    scrollsdk setup push-secrets
    ```

11. ```bash
    scrollsdk setup tls
    ```

1. `scrollsdk helper fund-accounts -i -f 2 -d`
1. `scrollsdk helper fund-accounts -l 1 -f 2 -d`
1. `scrollsdk helper fund-accounts -l 2 -d`
<!-- installationstop -->

## Non-Interactive / CI Mode

Steps 1-11 support `--non-interactive` (`-N`) and `--json` flags for automated pipelines. Steps 12-14 (`helper fund-accounts`) are flag-driven for L1 devnet funding, while some L2 funding paths may still prompt for bridge/direct/manual selection. See [docs/automation.md](docs/automation.md) for the full automation guide including required flags per step, JSON output format, error codes, environment variable substitution, and example scripts.

## Ethereum DA S3 Archive

`eth-da-submitter` can archive submitted EIP-4844 blob bytes to S3, and
`l1-interface` / `withdrawal-processor` can later rehydrate those blobs through
an unauthenticated HTTP `aws_s3` blob source. This is useful after Beacon API
blob retention expires.

The CLI does not create S3 buckets or bucket policies. Configure the bucket,
public read path, and submitter write permissions before running
`scrollsdk setup prep-charts`. The CLI only reads
`.data/doge-config.toml` and writes the corresponding Helm environment values.

The resolver performs one anonymous HTTP GET per blob:

```text
GET {publicBaseUrl}/{0x-versioned-hash}
```

The response body must be the raw EIP-4844 blob bytes. It is not JSON, and the
expected size is `131072` bytes.

### AWS S3 Direct Bucket

Create a dedicated bucket for one environment, for example:

```text
dogeos-eth-da-archive-testnet
```

Use the real bucket region and direct virtual-hosted S3 URL:

```toml
[ethereumDa.blobArchive.s3]
enabled = true
bucket = "dogeos-eth-da-archive-testnet"
region = "us-west-2"
publicBaseUrl = "https://dogeos-eth-da-archive-testnet.s3.us-west-2.amazonaws.com/"
timeoutMs = 15000
treatForbiddenAsMissing = false
```

`bucket` and `region` are used by `eth-da-submitter` for `PutObject`. The
`publicBaseUrl` is used by `l1-interface` and `withdrawal-processor` for
anonymous HTTP reads. These values must point at the same object namespace.
Object keys are the `0x`-prefixed versioned hashes; there is no separate prefix
setting.

Grant the submitter's AWS identity, such as the IRSA role for the
`eth-da-submitter` service account, write access and read-back access for
conflict checks:

```json
{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject"],
  "Resource": "arn:aws:s3:::dogeos-eth-da-archive-testnet/*"
}
```

If using direct public S3 reads, configure the bucket policy to allow anonymous
`s3:GetObject` on archive objects while keeping writes private:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadEthDaBlobArchive",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::dogeos-eth-da-archive-testnet/*"
    }
  ]
}
```

### CloudFront Or Custom Public Read URL

You can keep the bucket private and expose reads through CloudFront or another
HTTP proxy. In that case `bucket` and `region` still describe the S3 upload
target, while `publicBaseUrl` is the public read endpoint:

```toml
[ethereumDa.blobArchive.s3]
enabled = true
bucket = "dogeos-eth-da-archive-testnet"
region = "us-west-2"
publicBaseUrl = "https://da-archive.example.com/"
timeoutMs = 15000
treatForbiddenAsMissing = false
```

The URL `https://da-archive.example.com/0xabc...` must return the object stored
at `s3://dogeos-eth-da-archive-testnet/0xabc...`.

### S3-Compatible Endpoints

For MinIO or another S3-compatible service, configure the upload endpoint and
path-style addressing when required:

```toml
[ethereumDa.blobArchive.s3]
enabled = true
bucket = "dogeos-da"
region = "us-east-1"
endpointUrl = "http://minio.default.svc.cluster.local:9000"
forcePathStyle = true
publicBaseUrl = "http://minio.default.svc.cluster.local:9000/dogeos-da"
timeoutMs = 15000
treatForbiddenAsMissing = false
```

The resolver will request
`http://minio.default.svc.cluster.local:9000/dogeos-da/0xabc...`.

### Field Reference

| Field | Required | Used by | Description |
|-------|----------|---------|-------------|
| `enabled` | yes | submitter, l1-interface, withdrawal-processor | Enables S3 upload and readback when `true`. |
| `bucket` | yes when enabled | eth-da-submitter | Existing bucket name. The CLI does not create it. |
| `region` | yes when enabled | eth-da-submitter | Bucket region. Must match the real bucket region. |
| `publicBaseUrl` | yes when enabled | l1-interface, withdrawal-processor | Public HTTP base URL used for anonymous `GET {base}/{0x-versioned-hash}`. |
| `timeoutMs` | no | l1-interface, withdrawal-processor | HTTP GET timeout. `15000` is a reasonable starting point. |
| `treatForbiddenAsMissing` | no | l1-interface, withdrawal-processor | Keep `false` unless the read endpoint intentionally returns 403 for absent objects and you want fallback providers to continue. |
| `endpointUrl` | no | eth-da-submitter | Custom S3-compatible upload endpoint. Usually omitted for AWS S3. |
| `forcePathStyle` | no | eth-da-submitter | Set `true` for most MinIO/S3-compatible endpoints that require path-style URLs. |
| `pollIntervalMs`, `initialBackoffMs`, `maxBackoffMs`, `maxRetries`, `uploadingTimeoutMs` | no | eth-da-submitter | Upload worker retry and timeout tuning. Defaults are normally sufficient. |

### Verify The Public URL

After `eth-da-submitter` has uploaded an object, verify that the read URL works
from a network that can reach `l1-interface` and `withdrawal-processor`:

```bash
curl -I "https://dogeos-eth-da-archive-testnet.s3.us-west-2.amazonaws.com/0x..."
curl -s "https://dogeos-eth-da-archive-testnet.s3.us-west-2.amazonaws.com/0x..." | wc -c
```

Expected results:

- Existing object: HTTP `200`
- Existing object body size: `131072`
- Missing object: ideally HTTP `404`; some deny policies return `403`

Keep `treatForbiddenAsMissing = false` first so ACL or public-read mistakes are
visible. Set it to `true` only after confirming that 403 is the intended
missing-object behavior for the read endpoint.

Run `scrollsdk setup prep-charts` after updating `.data/doge-config.toml` to
sync the S3 settings into `eth-da-submitter`, `l1-interface`, and
`withdrawal-processor` values.

# Usage

<!-- usage -->
```sh-session
$ npm install -g @scroll-tech/scroll-sdk-cli
$ scrollsdk COMMAND
running command...
$ scrollsdk (--version)
@scroll-tech/scroll-sdk-cli/0.1.3 darwin-arm64 node-v22.19.0
$ scrollsdk --help [COMMAND]
USAGE
  $ scrollsdk COMMAND
...
```
<!-- usagestop -->

# Commands

<!-- commands -->
- [Scroll SDK CLI](#scroll-sdk-cli)
  - [Introduction](#introduction)
    - [Other Scroll SDK Repos](#other-scroll-sdk-repos)
- [Installation](#installation)
- [Commands](#commands)
  - [`scrollsdk check prerequisites`](#scrollsdk-check-prerequisites)
  - [`scrollsdk doge wallet new`](#scrollsdk-doge-wallet-new)
  - [`scrollsdk doge wallet send`](#scrollsdk-doge-wallet-send)
  - [`scrollsdk doge wallet sync`](#scrollsdk-doge-wallet-sync)
  - [`scrollsdk help [COMMAND]`](#scrollsdk-help-command)
  - [`scrollsdk helper activity`](#scrollsdk-helper-activity)
  - [`scrollsdk helper clear-accounts`](#scrollsdk-helper-clear-accounts)
  - [`scrollsdk helper derive-enode NODEKEY`](#scrollsdk-helper-derive-enode-nodekey)
  - [`scrollsdk helper fund-accounts`](#scrollsdk-helper-fund-accounts)
  - [`scrollsdk helper set-scalars`](#scrollsdk-helper-set-scalars)
  - [`scrollsdk plugins`](#scrollsdk-plugins)
  - [`scrollsdk plugins add PLUGIN`](#scrollsdk-plugins-add-plugin)
  - [`scrollsdk plugins:inspect PLUGIN...`](#scrollsdk-pluginsinspect-plugin)
  - [`scrollsdk plugins install PLUGIN`](#scrollsdk-plugins-install-plugin)
  - [`scrollsdk plugins link PATH`](#scrollsdk-plugins-link-path)
  - [`scrollsdk plugins remove [PLUGIN]`](#scrollsdk-plugins-remove-plugin)
  - [`scrollsdk plugins reset`](#scrollsdk-plugins-reset)
  - [`scrollsdk plugins uninstall [PLUGIN]`](#scrollsdk-plugins-uninstall-plugin)
  - [`scrollsdk plugins unlink [PLUGIN]`](#scrollsdk-plugins-unlink-plugin)
  - [`scrollsdk plugins update`](#scrollsdk-plugins-update)
  - [`scrollsdk setup bootnode-public-p2p`](#scrollsdk-setup-bootnode-public-p2p)
  - [`scrollsdk setup bridge-init`](#scrollsdk-setup-bridge-init)
  - [`scrollsdk setup cubesigner-init`](#scrollsdk-setup-cubesigner-init)
  - [`scrollsdk setup cubesigner-refresh`](#scrollsdk-setup-cubesigner-refresh)
  - [`scrollsdk setup db-init`](#scrollsdk-setup-db-init)
  - [`scrollsdk setup disable-internal`](#scrollsdk-setup-disable-internal)
  - [`scrollsdk setup doge-config`](#scrollsdk-setup-doge-config)
  - [`scrollsdk setup dogecoin-wallet-import`](#scrollsdk-setup-dogecoin-wallet-import)
  - [`scrollsdk setup domains`](#scrollsdk-setup-domains)
  - [`scrollsdk setup dummy-signers`](#scrollsdk-setup-dummy-signers)
  - [`scrollsdk setup gas-token`](#scrollsdk-setup-gas-token)
  - [`scrollsdk setup gen-keystore`](#scrollsdk-setup-gen-keystore)
  - [`scrollsdk setup gen-l2-artifacts`](#scrollsdk-setup-gen-l2-artifacts)
  - [`scrollsdk setup gen-rpc-package`](#scrollsdk-setup-gen-rpc-package)
  - [`scrollsdk setup gen-secrets`](#scrollsdk-setup-gen-secrets)
  - [`scrollsdk setup generate-from-spec`](#scrollsdk-setup-generate-from-spec)
  - [`scrollsdk setup prep-charts`](#scrollsdk-setup-prep-charts)
  - [`scrollsdk setup push-secrets`](#scrollsdk-setup-push-secrets)
  - [`scrollsdk setup tls`](#scrollsdk-setup-tls)
  - [`scrollsdk setup verify-contracts`](#scrollsdk-setup-verify-contracts)
  - [`scrollsdk test contracts`](#scrollsdk-test-contracts)
  - [`scrollsdk test dependencies`](#scrollsdk-test-dependencies)
  - [`scrollsdk test dogeos [CASENAME]`](#scrollsdk-test-dogeos-casename)
  - [`scrollsdk test e2e`](#scrollsdk-test-e2e)
  - [`scrollsdk test ingress`](#scrollsdk-test-ingress)

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
  $ scrollsdk setup bridge-init [--image-tag <value>] [--json] [-N] [-s <value>] [--step <value>]

FLAGS
  -N, --non-interactive
      Run without prompts. Requires --seed for --step all or --step 1-prepare.

  -s, --seed=<value>
      seed which will regenerate the sequencer and fee wallet

  --image-tag=<value>
      Specify the Docker image tag to use (defaults to 0.2.0-rc.3)

  --json
      Output in JSON format (stdout for data, stderr for logs)

  --step=<value>
      [default: all] Bridge init step to run. all runs 1-prepare, 2-setup, 3-bridge-info, 4-fund, and 5-protocol-context.
      1-prepare requires values/genesis.yaml, extracts .data/genesis.json, and prepares protocol_seed.toml. 2-setup is NOT
      idempotent: generate test keys and broadcast the setup transaction. 3-bridge-info is idempotent: generate namespace
      and bridge.json. 4-fund is NOT idempotent: broadcast 10 initial bridge funding transactions. 5-protocol-context is
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

  $ scrollsdk setup bridge-init --image-tag 0.2.0-debug

  $ scrollsdk setup bridge-init --non-interactive --seed 123456 --image-tag 0.2.0-rc.3

  $ scrollsdk setup bridge-init --non-interactive --json --seed 123456
```

_See code: [src/commands/setup/bridge-init.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/bridge-init.ts)_

## `scrollsdk setup cubesigner-init`

Setup a CubeSigner TEE key and role

```
USAGE
  $ scrollsdk setup cubesigner-init [--count <value>] [--doge-config <value>] [--json] [--new] [-N] [--role-prefix <value>]
    [--roles <value>...] [--threshold <value>]

FLAGS
  -N, --non-interactive      Run without prompts. Requires --doge-config and either --new (with --role-prefix) or --roles.
      --count=<value>        Number of TEE keys/roles to create (must be 1; default 1)
      --doge-config=<value>  Path to Dogecoin config file
      --json                 Output in JSON format (stdout for data, stderr for logs)
      --new                  Create new roles and keys
      --role-prefix=<value>  Prefix for role names (when using --new)
      --roles=<value>...     Comma-separated list of existing role names to use
      --threshold=<value>    Deprecated; ignored because cubesigner-init configures the single TEE key.

DESCRIPTION
  Setup a CubeSigner TEE key and role

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

Configure Dogecoin settings and bridge setup defaults for deployment

```
USAGE
  $ scrollsdk setup doge-config [-c <value>] [--json] [-N]

FLAGS
  -N, --non-interactive   Run without prompts, using existing config values
  -c, --config=<value>    Path to config file
      --json              Output in JSON format (stdout for data, stderr for logs)

DESCRIPTION
  Configure Dogecoin settings and bridge setup defaults for deployment

EXAMPLES
  $ scrollsdk setup doge-config

  $ scrollsdk setup doge-config --config .data/doge-config.toml

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
  $ scrollsdk setup domains [--json] [-N]

FLAGS
  -N, --non-interactive  Run without prompts, using config.toml values
      --json             Output in JSON format (stdout for data, stderr for logs)

DESCRIPTION
  Set up domain configurations for external services

EXAMPLES
  $ scrollsdk setup domains

  $ scrollsdk setup domains --non-interactive

  $ scrollsdk setup domains --non-interactive --json
```

_See code: [src/commands/setup/domains.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/domains.ts)_

## `scrollsdk setup dummy-signers`

Set up three dummy attestation signers (local Docker or AWS with KMS)

```
USAGE
  $ scrollsdk setup dummy-signers [--aws-account-id <value>] [--aws-ecs-cluster <value>] [--aws-image-source
    dockerhub|ecr|ecr-sync] [--aws-image-uri <value>] [--aws-network-alias <value>] [-a] [--aws-region <value>] [-c <value>]
    [--from-spec <value>] [--generate-wif-keys] [--image-tag <value>] [--json] [-l] [-N]

FLAGS
  -N, --non-interactive            Run without prompts. Uses config values or sensible defaults.
  -a, --aws-only                   Set up AWS KMS attestation signers only
  -c, --config=<value>             Path to Dogecoin config file
  -l, --local-only                 Set up local Docker attestation signers only
      --aws-account-id=<value>     AWS account ID
      --aws-ecs-cluster=<value>    ECS cluster for AWS ECS Express dummy attestation signer services. Defaults to
                                   awsSigner.ecsClusterName or "default".
      --aws-image-source=<option>  AWS attestation signer image source: dockerhub uses the public image directly, ecr requires
                                   an existing ECR image, ecr-sync syncs Docker Hub to ECR from this machine
                                   <options: dockerhub|ecr|ecr-sync>
      --aws-image-uri=<value>      Full container image URI for AWS attestation signers. Overrides --aws-image-source.
      --aws-network-alias=<value>  Network alias for AWS resources
      --aws-region=<value>         AWS region for KMS attestation signers
      --from-spec=<value>          Path to DeploymentSpec YAML. Uses dummy attestation signer defaults from signing.awsKms or
                                   signing.local.
      --[no-]generate-wif-keys     Generate new attestation WIF keys (non-interactive mode)
      --image-tag=<value>          Specify the Docker image tag to use
      --json                       Output in JSON format (stdout for data, stderr for logs)
DESCRIPTION
  Set up three dummy attestation signers (local Docker or AWS with KMS)

EXAMPLES
  $ scrollsdk setup dummy-signers

  $ scrollsdk setup dummy-signers --config .data/doge-config.toml

  $ scrollsdk setup dummy-signers --local-only

  $ scrollsdk setup dummy-signers --aws-only

  $ scrollsdk setup dummy-signers --image-tag newda

  $ scrollsdk setup dummy-signers --aws-only --aws-image-source ecr-sync

  $ scrollsdk setup dummy-signers --aws-only --aws-image-uri dogeos69/dummy-signer:newda
```

_See code: [src/commands/setup/dummy-signers.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/dummy-signers.ts)_

## `scrollsdk setup gas-token`

Set up gas token configurations

```
USAGE
  $ scrollsdk setup gas-token

DESCRIPTION
  Set up gas token configurations

EXAMPLES
  $ scrollsdk setup gas-token
```

_See code: [src/commands/setup/gas-token.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/gas-token.ts)_

## `scrollsdk setup gen-keystore`

Generate keystore and account keys for L2 Geth

```
USAGE
  $ scrollsdk setup gen-keystore [--accounts] [--bootnode-count <value>] [--json] [-N] [--regenerate-bootnodes]
    [--regenerate-sequencers] [--sequencer-count <value>] [--sequencer-password <value>]

FLAGS
  -N, --non-interactive             Run without prompts. Uses existing keys or generates new ones based on flags.
      --[no-]accounts               Generate account key pairs
      --bootnode-count=<value>      [default: 2] Number of bootnodes. In non-interactive mode, generates if not enough
                                    exist.
      --json                        Output in JSON format (stdout for data, stderr for logs)
      --regenerate-bootnodes        Force regeneration of all bootnode keys (non-interactive mode)
      --regenerate-sequencers       Force regeneration of all sequencer keys (non-interactive mode)
      --sequencer-count=<value>     [default: 2] Number of sequencers (including primary). In non-interactive mode,
                                    generates if not enough exist.
      --sequencer-password=<value>  Password for sequencer keystores (or use $ENV:VAR_NAME pattern). Defaults to a
                                    generated random password for new sequencers in non-interactive mode.

DESCRIPTION
  Generate keystore and account keys for L2 Geth

EXAMPLES
  $ scrollsdk setup gen-keystore

  $ scrollsdk setup gen-keystore --no-accounts

  $ scrollsdk setup gen-keystore --non-interactive

  $ scrollsdk setup gen-keystore --non-interactive --json --sequencer-count 2 --bootnode-count 2
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
  $ scrollsdk setup gen-secrets [--configs-dir <value>] [--doge-config <value>] [--json] [-N]

FLAGS
  -N, --non-interactive      Run without prompts. Uses config values or sensible defaults.
      --configs-dir=<value>  [default: values] Directory containing generated values files
      --doge-config=<value>  Path to config file (e.g., .data/doge-config-mainnet.toml or
                             .data/doge-config-testnet.toml)
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
  $ scrollsdk setup generate-from-spec -s <value> [--config-only] [--dry-run] [--env-file <value>] [-f] [--json]
    [-o <value>] [--values-only] [--with-values]

FLAGS
  -f, --force           Overwrite existing files without warning
  -o, --output=<value>  [default: .] Output directory for generated files
  -s, --spec=<value>    (required) Path to DeploymentSpec YAML file
      --config-only     Only generate config.toml and .data/*.toml. This is the default.
      --dry-run         Validate spec and show what would be generated without writing files
      --env-file=<value>
                         Load dotenv-style environment variables before parsing the spec. Defaults to .env.local/.env next
                         to the spec and current directory when present.
      --json            Output in JSON format (stdout for data, stderr for logs)
      --values-only     Only generate values/*.yaml Helm files
      --with-values     Also generate values/*.yaml Helm files

DESCRIPTION
  Generate configuration files from a DeploymentSpec YAML file

EXAMPLES
  # Generate configs in current directory

  $ scrollsdk setup generate-from-spec --spec deployment-spec.yaml



  # Generate configs to specific output directory

  $ scrollsdk setup generate-from-spec --spec deployment-spec.yaml --output ./my-deployment



  # Generate with JSON output for automation

  $ scrollsdk setup generate-from-spec --spec deployment-spec.yaml --json



  # Dry run - validate and show what would be generated

  $ scrollsdk setup generate-from-spec --spec deployment-spec.yaml --dry-run



  # Load private keys/passwords from an env file before deriving account addresses

  $ scrollsdk setup generate-from-spec --spec deployment-spec.yaml --env-file .env.local



  # Generate Helm values files explicitly

  $ scrollsdk setup generate-from-spec --spec deployment-spec.yaml --with-values

  $ scrollsdk setup generate-from-spec --spec deployment-spec.yaml --values-only
```

_See code: [src/commands/setup/generate-from-spec.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/generate-from-spec.ts)_

## `scrollsdk setup prep-charts`

Validate Makefile and prepare Helm charts for Scroll SDK

```
USAGE
  $ scrollsdk setup prep-charts [--doge-config <value>] [--github-token <value>] [--github-username <value>] [--json]
    [-N] [--skip-auth-check] [--values-dir <value>]

FLAGS
  -N, --non-interactive          Run without prompts. Auto-applies all detected changes.
      --doge-config=<value>      Path to Dogecoin config file
      --github-token=<value>     GitHub Personal Access Token
      --github-username=<value>  GitHub username
      --json                     Output in JSON format (stdout for data, stderr for logs)
      --skip-auth-check          Skip authentication check for individual charts
      --values-dir=<value>       [default: ./values] Directory containing values files

DESCRIPTION
  Validate Makefile and prepare Helm charts for Scroll SDK

EXAMPLES
  $ scrollsdk setup prep-charts

  $ scrollsdk setup prep-charts --github-username=your-username --github-token=your-token

  $ scrollsdk setup prep-charts --values-dir=./custom-values

  $ scrollsdk setup prep-charts --skip-auth-check
```

_See code: [src/commands/setup/prep-charts.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/prep-charts.ts)_

## `scrollsdk setup push-secrets`

Push secrets to the selected secret service

```
USAGE
  $ scrollsdk setup push-secrets [--aws-prefix <value>] [--aws-region <value>] [--aws-service-account <value>] [-c] [-d]
    [-f <value>] [--json] [-N] [--provider aws|vault] [--skip-yaml-update] [--values-dir <value>] [--vault-path <value>]
    [--vault-server <value>] [--vault-token-secret-key <value>] [--vault-token-secret-name <value>] [--vault-version
    <value>]

FLAGS
  -N, --non-interactive                  Run without prompts. Auto-overrides existing secrets.
  -c, --cubesigner-only                  Only push CubeSigner related secrets (cubesigner-signer-* files)
  -d, --debug                            Show debug output
  -f, --file=<value>                     Specific secret file to push (e.g., my-secret.json)
      --aws-prefix=<value>               [default: dogeos] AWS Secrets Manager path prefix (e.g., dogeos/testnet)
      --aws-region=<value>               [default: us-west-2] AWS region for secrets (e.g., us-east-1)
      --aws-service-account=<value>      [default: external-secrets] AWS IAM service account
      --json                             Output in JSON format (stdout for data, stderr for logs)
      --provider=<option>                [default: aws] Secret service provider (aws or vault)
                                         <options: aws|vault>
      --skip-yaml-update                 Skip updating production YAML files with new secret provider
      --values-dir=<value>               [default: values] Directory containing the values files
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

  $ scrollsdk setup push-secrets --cubesigner-only

  $ scrollsdk setup push-secrets -c --debug
```

_See code: [src/commands/setup/push-secrets.ts](https://github.com/dogeos69/scroll-sdk-cli/blob/v0.1.3/src/commands/setup/push-secrets.ts)_

## `scrollsdk setup tls`

Update TLS configuration in Helm charts

```
USAGE
  $ scrollsdk setup tls [--cluster-issuer <value>] [--create-issuer] [-d] [--issuer-email <value>] [--json]
    [-N] [--values-dir <value>]

FLAGS
  -N, --non-interactive         Run without prompts. Requires --cluster-issuer or (--create-issuer with --issuer-email)
  -d, --debug                   Show debug output and confirm before making changes
      --cluster-issuer=<value>  Specify the ClusterIssuer to use (for non-interactive mode)
      --create-issuer           Create a letsencrypt-prod ClusterIssuer if none exists (for non-interactive mode)
      --issuer-email=<value>    Email address for the ClusterIssuer (required with --create-issuer)
      --json                    Output in JSON format (stdout for data, stderr for logs)
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
