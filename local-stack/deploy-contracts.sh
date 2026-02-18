#!/bin/sh
# Deploys scroll bridge contracts to L2 geth only.
# L1 contracts are NOT deployed — l1-interface simulates the L1 EVM and uses
# contract addresses as identifiers only (no bytecode execution). The "None"
# simulation step computes deterministic CREATE2 addresses and writes them to
# config-contracts.toml so all services agree on the same addresses.
export PS4='$(date "+%Y-%m-%dT%H:%M:%S%z") ${0##*/}:${LINENO}: '
echo "=== LOCAL DEPLOY START ==="
export FOUNDRY_EVM_VERSION="cancun"
export FOUNDRY_BYTECODE_HASH="none"
set -ex

CONFIG_FILE="./volume/config.toml"
L2_RPC_ENDPOINT="${L2_RPC_ENDPOINT}"
BATCH_SIZE="7"

echo "using L2_RPC_ENDPOINT = $L2_RPC_ENDPOINT"

# Use write-config mode for fresh deployment (writes addresses to config-contracts.toml)
SCRIPT_MODE="write-config"

# simulate all (computes deterministic CREATE2 addresses, writes config-contracts.toml)
echo ""
echo "simulating (computing deterministic addresses)"
forge script scripts/deterministic/DeployScroll.s.sol:DeployScroll --sig "run(string,string)" "None" "$SCRIPT_MODE"

# simulate L2 (dry-run against L2 geth)
echo ""
echo "simulating on L2"
forge script scripts/deterministic/DeployScroll.s.sol:DeployScroll --rpc-url "$L2_RPC_ENDPOINT" --sig "run(string,string)" "L2" "$SCRIPT_MODE" --legacy

# deploy L2 (broadcast real transactions to L2 geth)
echo ""
echo "deploying on L2"
forge script scripts/deterministic/DeployScroll.s.sol:DeployScroll --rpc-url "$L2_RPC_ENDPOINT" --batch-size "$BATCH_SIZE" --sig "run(string,string)" "L2" "$SCRIPT_MODE" --broadcast --legacy --json

echo "=== LOCAL DEPLOY END ==="
