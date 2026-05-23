# Non-Interactive Automation Guide

This document describes how to run the Scroll SDK CLI installation workflow without interactive prompts, suitable for CI/CD pipelines, AI agents, and scripted deployments.

## Quick Start

Steps 1-11 support two flags for automation (steps 12-14 are already fully flag-driven with no prompts):

```bash
scrollsdk <command> --non-interactive --json
```

| Flag | Short | Description |
|------|-------|-------------|
| `--non-interactive` | `-N` | Disable all prompts; read values from `config.toml` |
| `--json` | | Output structured JSON to stdout; logs to stderr |

## Prerequisites

Before running non-interactively, you need:

1. A populated `config.toml` in the working directory
2. Docker running (for `setup gen-l2-artifacts`, `setup bridge-init`)
3. kubectl connected to the target cluster (for `setup push-secrets`, `setup prep-charts`)
4. Environment variables set for any `$ENV:VAR_NAME` references in config

## Environment Variable Substitution

Config values can reference environment variables using the `$ENV:VAR_NAME` pattern:

```toml
[db.admin]
DB_PASSWORD = "$ENV:POSTGRES_ADMIN_PASSWORD"

[accounts]
DEPLOYER_PRIVATE_KEY = "$ENV:DEPLOYER_KEY"
```

At runtime, `$ENV:POSTGRES_ADMIN_PASSWORD` resolves to `process.env.POSTGRES_ADMIN_PASSWORD`. If the variable is unset, the field is treated as missing.

## JSON Output Format

### Success Response

```json
{
  "success": true,
  "command": "setup domains",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "duration_ms": 1234,
  "data": { ... },
  "warnings": ["optional warning messages"]
}
```

### Error Response

```json
{
  "success": false,
  "command": "setup domains",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "error": {
    "code": "E601_MISSING_FIELD",
    "message": "Missing 2 required configuration value(s) for non-interactive mode",
    "category": "CONFIGURATION",
    "recoverable": true,
    "context": {
      "missingFields": [
        {
          "field": "EXTERNAL_RPC_URI_L1",
          "configPath": "[frontend].EXTERNAL_RPC_URI_L1",
          "description": "L1 RPC endpoint URL"
        }
      ]
    }
  }
}
```

### Error Categories

| Category | Meaning | Recovery Strategy |
|----------|---------|-------------------|
| `CONFIGURATION` | Missing/invalid config values | Add values to config.toml |
| `PREREQUISITE` | Missing dependency (Docker, kubectl) | Install/start the dependency |
| `NETWORK` | RPC/API endpoint unreachable | Check connectivity, retry |
| `DOCKER` | Container operation failed | Check Docker daemon, retry |
| `KUBERNETES` | K8s operation failed | Check cluster connectivity |
| `FUNDING` | Insufficient funds | Fund the specified address |
| `VALIDATION` | Input validation failed | Fix the invalid value |
| `INTERNAL` | Unexpected error | Report bug |

### Error Codes

| Code | Category | Recoverable | Description |
|------|----------|-------------|-------------|
| `E100_DOCKER_NOT_RUNNING` | PREREQUISITE | Yes | Docker daemon not running |
| `E101_CONFIG_NOT_FOUND` | CONFIGURATION | Yes | config.toml not found |
| `E102_DATA_DIR_MISSING` | CONFIGURATION | Yes | .data/ directory missing |
| `E103_DOGE_CONFIG_MISSING` | CONFIGURATION | Yes | doge-config.toml not found |
| `E104_KUBECTL_NOT_CONNECTED` | PREREQUISITE | Yes | kubectl not connected |
| `E200_HELPER_UNFUNDED` | FUNDING | Yes | Helper address has no funds |
| `E201_INSUFFICIENT_L1_BALANCE` | FUNDING | Yes | Not enough L1 balance |
| `E202_UTXO_SPENT` | FUNDING | No | UTXO already spent |
| `E300_L1_RPC_UNREACHABLE` | NETWORK | Yes | L1 RPC endpoint down |
| `E301_L2_RPC_UNREACHABLE` | NETWORK | Yes | L2 RPC endpoint down |
| `E302_BLOCKBOOK_UNREACHABLE` | NETWORK | Yes | Blockbook API unreachable |
| `E303_CELESTIA_RPC_UNREACHABLE` | NETWORK | Yes | Celestia RPC unreachable |
| `E304_DATABASE_UNREACHABLE` | NETWORK | Yes | Database connection failed |
| `E400_DOCKER_IMAGE_PULL_FAILED` | DOCKER | Yes | Cannot pull Docker image |
| `E401_DOCKER_CONTAINER_FAILED` | DOCKER | No | Container exited with error |
| `E402_DOCKER_TIMEOUT` | DOCKER | Yes | Docker operation timed out |
| `E500_K8S_NOT_CONNECTED` | KUBERNETES | Yes | Cluster not reachable |
| `E501_INGRESS_NOT_FOUND` | KUBERNETES | No | Ingress resource not found |
| `E502_SECRET_PUSH_FAILED` | KUBERNETES | Yes | Failed to push K8s secret |
| `E600_INVALID_ADDRESS` | VALIDATION | No | Invalid Ethereum address |
| `E601_MISSING_FIELD` | CONFIGURATION | Yes | Required config field missing |
| `E602_INVALID_CONFIG_FORMAT` | VALIDATION | No | Config file has invalid format |
| `E900_UNEXPECTED_ERROR` | INTERNAL | No | Unexpected internal error |

## Installation Workflow (Non-Interactive)

All commands below assume `config.toml` is fully populated. Run them in order:

### Step 1: Set up domains

```bash
scrollsdk setup domains -N --json
```

Reads domain and ingress values from `[frontend]` and `[ingress]` sections of config.toml.

**Required config fields:**
- `[general].CHAIN_NAME_L1` - L1 network name (used to infer network type)
- `[frontend].EXTERNAL_RPC_URI_L1` - L1 RPC endpoint
- `[frontend].EXTERNAL_RPC_URI_L2` - L2 RPC endpoint
- `[frontend].BRIDGE_API_URI` - Bridge API endpoint
- `[frontend].ROLLUPSCAN_API_URI` - Rollupscan API endpoint
- `[ingress].*` - Ingress hostnames

### Step 2: Initialize databases

```bash
scrollsdk setup db-init --clean -N --json
```

Creates PostgreSQL databases and roles. Attempts SSL connection first, falls back to non-SSL for local dev databases.

**Required config fields:**
- `[db.admin].PUBLIC_HOST` - Database host
- `[db.admin].PUBLIC_PORT` - Database port
- `[db.admin].USERNAME` - Admin username
- `[db.admin].PASSWORD` - Admin password (use `$ENV:` for secrets)
- `[db.*]` sections for each service database

### Step 3: Generate keystores

```bash
scrollsdk setup gen-keystore -N --json --sequencer-password '$ENV:SEQUENCER_KEYSTORE_PASSWORD'
```

Generates keystores for validator/sequencer accounts.

**Required flags (non-interactive):**
- `--sequencer-password` - Password for sequencer keystores (required when generating new sequencers). Supports `$ENV:VAR_NAME` pattern.
- `--sequencer-count` - Number of sequencers (optional, defaults to existing count)
- `--bootnode-count` - Number of bootnodes (optional, defaults to existing count)
- `--regenerate-sequencers` - Force regeneration of all sequencer keys
- `--regenerate-bootnodes` - Force regeneration of all bootnode keys

**Required config fields:**
- `[accounts]` section with private keys

### Step 4: Configure Dogecoin

```bash
scrollsdk setup doge-config -N --json --network testnet
```

Generates `.data/doge-config.toml` from config values.

**Required flags (non-interactive):**
- `--network mainnet|testnet|regtest` - Required when creating a new config

**Required config fields:**
- `[dogecoin]` section (network, RPC URLs, blockbook URL)

### Step 5: Generate L2 artifacts

```bash
scrollsdk setup gen-l2-artifacts -N --json
```

Runs the L2 config generation Docker container and prepares deployment artifacts.

**Generated files:**
- `values/genesis.yaml` - Required by `setup bridge-init`
- `config.public.toml`
- `config-contracts.toml`
- `values/scroll-common-config.yaml`
- `values/scroll-common-config-contracts.yaml`
- `values/*-config.yaml`

**Required config fields:**
- `config.toml` fully populated

### Step 6: Initialize CubeSigner attestation keys

```bash
scrollsdk setup cubesigner-init -N --json --new --count 3 --role-prefix attestor --threshold 2 --doge-config .data/doge-config.toml
```

Creates or selects CubeSigner roles and writes attestation public keys to `.data/setup_defaults.toml`. This must run before bridge initialization.

**Required flags (non-interactive):**
- `--doge-config <path>` - Path to doge-config file
- Either `--new --count <n> --role-prefix <prefix>` or `--roles <role...>`

### Optional: Generate a dummy TEE signer

```bash
scrollsdk setup dummy-signers -N --json --config .data/doge-config.toml
```

Creates a dummy TEE signer key for development. Production bridge initialization should use CubeSigner attestation keys from step 6.

**Required flags (non-interactive):**
- `--config <path>` - Path to doge-config file (required to avoid config selection prompt)
- `--generate-wif-keys` - Generate new WIF keys (otherwise existing keys must be in config)

**Required config fields:**
- `.data/doge-config.toml` must exist (run step 4 first)

### Step 7: Initialize bridge

```bash
scrollsdk setup bridge-init -N --json --seed 123456
```

Runs the bridge initialization Docker container. Requires Docker.

**Required flags (non-interactive):**
- `--seed <string>` - Seed for generating sequencer and fee wallet keys (required)
- `--image-tag <tag>` - Docker image tag (optional, has default)

**Required config fields:**
- `values/genesis.yaml` from `setup gen-l2-artifacts`
- `.data/setup_defaults.toml` with CubeSigner `attestation_pubkeys`
- `.data/doge-config.toml` with bridge parameters

**Note:** This step may require funding. If you receive error `E200_HELPER_UNFUNDED`, send Dogecoin to the address in the error context and retry.

### Step 8: Generate local secrets

```bash
scrollsdk setup gen-secrets -N --json
```

Generates local `secrets/*.env` files from `config.toml`, Dogecoin config, and bridge initialization outputs.

**Required config fields:**
- `.data/output-withdrawal-processor.toml` from `setup bridge-init`

### Step 9: Prepare Helm charts

```bash
scrollsdk setup prep-charts -N --json
```

Generates Helm values files and prepares chart directories.

**Required config fields:**
- `config.toml` and generated configs from step 7
- `[ingress]` hostnames (ports are stripped automatically)

### Step 9: Refresh CubeSigner tokens

```bash
scrollsdk setup cubesigner-refresh -N --json --doge-config .data/doge-config.toml
```

Refreshes CubeSigner authentication tokens.

**Required flags (non-interactive):**
- `--doge-config <path>` - Path to doge-config file (required)
- `--org-id <id>` - CubeSigner organization ID (required if not already logged in)
- `--email <email>` - CubeSigner account email (required if not already logged in)

### Step 10: Push secrets to Kubernetes

```bash
scrollsdk setup push-secrets -N --json
```

Pushes generated secrets to the Kubernetes cluster. Requires kubectl.

**Optional flags (non-interactive):**
- `--provider aws|vault` - Secret service provider (default: `aws`)
- `--aws-region <region>` - AWS region for Secrets Manager (default: `us-west-2`)
- `--aws-prefix <prefix>` - AWS Secrets Manager path prefix (default: `dogeos`)
- `--aws-service-account <name>` - AWS IAM service account (default: `external-secrets`)

### Step 11: Set up TLS

```bash
scrollsdk setup tls -N --json --cluster-issuer letsencrypt-prod
```

Configures TLS certificates for ingress.

**Required flags (non-interactive):**
- `--cluster-issuer <name>` - ClusterIssuer to use, OR:
- `--create-issuer --issuer-email <email>` - Create a letsencrypt-prod ClusterIssuer if none exists

### Steps 12-14: Fund accounts

`helper fund-accounts` does not yet support `--non-interactive`/`--json` flags. Some funding paths may prompt for user confirmation (for example, L2 bridge/direct/manual selection or manual funding instructions). Use the `-d` (dev mode) flag to fund L1 accounts from the local L1 devnet prefunded wallet where possible:

```bash
# Fund deployer on L1 (dev mode)
scrollsdk helper fund-accounts -i -f 2 -d

# Fund service accounts on L1
scrollsdk helper fund-accounts -l 1 -f 2 -d

# Fund service accounts on L2
scrollsdk helper fund-accounts -l 2 -d
```

| Flag | Description |
|------|-------------|
| `-i` | Fund deployer address only |
| `-f <amount>` | Amount in ETH to fund |
| `-l <1\|2>` | Target layer (1=L1, 2=L2) |
| `-d` | Use Anvil devnet funding logic |
| `-k <key>` | Private key for funder wallet |
| `-a <address>` | Additional account to fund |
| `-m` | Manual funding mode (displays QR codes) |

## Full Automation Script Example

```bash
#!/usr/bin/env bash
set -euo pipefail

# Export secrets as environment variables
export POSTGRES_ADMIN_PASSWORD="your-password"
export DEPLOYER_KEY="0x..."
export SEQUENCER_KEYSTORE_PASSWORD="your-keystore-password"

NETWORK="testnet"  # mainnet, testnet, or regtest
DOGE_CONFIG=".data/doge-config.toml"
SEED="your-bridge-seed-string"

run_step() {
  local desc="$1"; shift
  echo "Running: $desc"
  output=$(scrollsdk "$@" 2>/dev/null)
  success=$(echo "$output" | jq -r '.success')
  if [ "$success" != "true" ]; then
    echo "FAILED: $desc"
    echo "$output" | jq '.error'
    exit 1
  fi
}

# Steps 1-2: Domain and database setup
run_step "setup domains" setup domains -N --json
run_step "setup db-init" setup db-init --clean -N --json

# Step 3: Generate keystores
run_step "setup gen-keystore" setup gen-keystore -N --json \
  --sequencer-password '$ENV:SEQUENCER_KEYSTORE_PASSWORD'

# Steps 4-9: Dogecoin, L2 artifacts, CubeSigner, bridge, secrets, Helm charts
run_step "setup doge-config" setup doge-config -N --json --network "$NETWORK"
run_step "setup gen-l2-artifacts" setup gen-l2-artifacts -N --json
run_step "setup cubesigner-init" setup cubesigner-init -N --json \
  --new --count 3 --role-prefix attestor --threshold 2 --doge-config "$DOGE_CONFIG"
run_step "setup bridge-init" setup bridge-init -N --json --seed "$SEED"
run_step "setup gen-secrets" setup gen-secrets -N --json
run_step "setup prep-charts" setup prep-charts -N --json

# Step 10: CubeSigner sessions (requires prior login or --org-id/--email)
run_step "setup cubesigner-refresh" setup cubesigner-refresh -N --json \
  --doge-config "$DOGE_CONFIG"

# Step 10: Push secrets to K8s
run_step "setup push-secrets" setup push-secrets -N --json

# Step 11: TLS certificates
run_step "setup tls" setup tls -N --json --cluster-issuer letsencrypt-prod

# Steps 12-14: Fund accounts (no -N/--json support; some L2 paths may prompt)
scrollsdk helper fund-accounts -i -f 2 -d
scrollsdk helper fund-accounts -l 1 -f 2 -d
scrollsdk helper fund-accounts -l 2 -d

echo "Installation complete"
```

## DeploymentSpec Alternative

For fully declarative deployments, use a `deployment-spec.yaml` file:

```bash
scrollsdk setup generate-from-spec --spec deployment-spec.yaml --json
```

This generates base config files (`config.toml`, `doge-config.toml`, `setup_defaults.toml`, `values/*.yaml`) from a single YAML specification. Run `setup gen-l2-artifacts`, `setup cubesigner-init`, `setup bridge-init`, and `setup gen-secrets` afterward to produce the runtime L2 genesis, CubeSigner attestation keys, bridge outputs, and local secrets. See `src/types/deployment-spec.ts` for the full schema.

## Parsing JSON Output Programmatically

### Bash with jq

```bash
output=$(scrollsdk setup domains -N --json 2>/dev/null)
if echo "$output" | jq -e '.success' > /dev/null 2>&1; then
  echo "Success"
  echo "$output" | jq '.data'
else
  code=$(echo "$output" | jq -r '.error.code')
  msg=$(echo "$output" | jq -r '.error.message')
  echo "Error $code: $msg"
fi
```

### Python

```python
import subprocess, json

result = subprocess.run(
    ["scrollsdk", "setup", "domains", "-N", "--json"],
    capture_output=True, text=True
)
response = json.loads(result.stdout)
if response["success"]:
    print("Domains configured:", response["data"])
else:
    error = response["error"]
    if error["recoverable"]:
        for field in error["context"]["missingFields"]:
            print(f"Missing: {field['field']} in {field['configPath']}")
```

### Node.js / TypeScript

```typescript
import { execFileSync } from 'node:child_process';

const output = execFileSync('scrollsdk', ['setup', 'domains', '-N', '--json'], {
  encoding: 'utf-8',
  stdio: ['pipe', 'pipe', 'pipe'],
});
const response = JSON.parse(output);
if (response.success) {
  console.log('Duration:', response.duration_ms, 'ms');
} else if (response.error.code === 'E601_MISSING_FIELD') {
  // Add missing fields to config.toml and retry
}
```

## Stdout / Stderr Separation

When `--json` is enabled:
- **stdout**: Only the final JSON response object
- **stderr**: All human-readable logs, progress messages, Docker container output, and warnings

This allows clean parsing: `scrollsdk ... --json 2>/dev/null | jq .`

## Retry Strategy for Recoverable Errors

Errors with `"recoverable": true` can be retried after addressing the root cause:

| Error Code | Fix | Then |
|-----------|-----|------|
| `E100_DOCKER_NOT_RUNNING` | Start Docker daemon | Retry same command |
| `E101_CONFIG_NOT_FOUND` | Create/place config.toml | Retry same command |
| `E200_HELPER_UNFUNDED` | Send DOGE to address in context | Retry `setup bridge-init` |
| `E300_*` | Check network/DNS | Retry after delay |
| `E304_DATABASE_UNREACHABLE` | Check DB is running, SSL settings | Retry `setup db-init` |
| `E502_SECRET_PUSH_FAILED` | Check kubectl auth | Retry `setup push-secrets` |
| `E601_MISSING_FIELD` | Add fields listed in context | Retry same command |
