#!/bin/sh
# Computes deterministic CREATE2 contract addresses and writes config-contracts.toml.
# Does NOT deploy anything — no RPC endpoint needed. This is a pure computation step.
export PS4='$(date "+%Y-%m-%dT%H:%M:%S%z") ${0##*/}:${LINENO}: '
echo "=== GENERATING DETERMINISTIC ADDRESSES ==="
export FOUNDRY_EVM_VERSION="cancun"
export FOUNDRY_BYTECODE_HASH="none"
set -ex

CONFIG_FILE="./volume/config.toml"
SCRIPT_MODE="write-config"

# Simulate all contract deployments to compute deterministic CREATE2 addresses.
# Writes addresses to volume/config-contracts.toml.
forge script scripts/deterministic/DeployScroll.s.sol:DeployScroll --sig "run(string,string)" "None" "$SCRIPT_MODE"

echo "=== ADDRESSES GENERATED ==="
