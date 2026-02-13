#!/bin/sh
export PS4='$(date "+%Y-%m-%dT%H:%M:%S%z") ${0##*/}:${LINENO}: '
echo "=== LOCAL DEPLOY START ==="
export FOUNDRY_EVM_VERSION="cancun"
export FOUNDRY_BYTECODE_HASH="none"
set -ex

CONFIG_FILE="./volume/config.toml"
L1_RPC_ENDPOINT="${L1_RPC_ENDPOINT}"
L2_RPC_ENDPOINT="${L2_RPC_ENDPOINT}"
BATCH_SIZE="7"

echo "using L1_RPC_ENDPOINT = $L1_RPC_ENDPOINT"
echo "using L2_RPC_ENDPOINT = $L2_RPC_ENDPOINT"

# Use write-config mode for fresh deployment (writes addresses to config-contracts.toml)
# verify-config mode would try to read addresses from config-contracts.toml and fail on empty strings
SCRIPT_MODE="write-config"

# simulate L1
echo ""
echo "simulating on L1"
forge script scripts/deterministic/DeployScroll.s.sol:DeployScroll --sig "run(string,string)" "None" "$SCRIPT_MODE"

# deploy L1 (ENABLED for local stack)
echo ""
echo "deploying on L1"
forge script scripts/deterministic/DeployScroll.s.sol:DeployScroll --rpc-url "$L1_RPC_ENDPOINT" --batch-size "${BATCH_SIZE}" --sig "run(string,string)" "L1" "$SCRIPT_MODE" --broadcast --json

# simulate L2
echo ""
echo "simulating on L2"
forge script scripts/deterministic/DeployScroll.s.sol:DeployScroll --rpc-url "$L2_RPC_ENDPOINT" --sig "run(string,string)" "L2" "$SCRIPT_MODE" --legacy

# deploy L2
echo ""
echo "deploying on L2"
forge script scripts/deterministic/DeployScroll.s.sol:DeployScroll --rpc-url "$L2_RPC_ENDPOINT" --batch-size "$BATCH_SIZE" --sig "run(string,string)" "L2" "$SCRIPT_MODE" --broadcast --legacy --json

echo "=== LOCAL DEPLOY END ==="
