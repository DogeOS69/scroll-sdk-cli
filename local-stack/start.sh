#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOGEOS_CORE_DIR="${HOME}/work/DogeOS69/dogeos-core"

ANVIL_BIN="${HOME}/.foundry/bin/anvil"
L2GETH_IMAGE="scrolltech/l2geth:scroll-v5.9.6"
DOGECOIN_IMAGE="dogeos69/dogecoin:latest"
SIGNER_ADDR="0xa7CdA54170FFD9F9C7A6DC72f8a5E6E15ca32fA3"

# Use OrbStack for amd64 emulation (Rosetta) - Docker Desktop QEMU crashes Go runtime
ORBSTACK_SOCK="${HOME}/.orbstack/run/docker.sock"
if [ -S "${ORBSTACK_SOCK}" ]; then
  export DOCKER_HOST="unix://${ORBSTACK_SOCK}"
  DOCKER_CMD="docker"
else
  DOCKER_CMD="docker"
fi

# Ports
ANVIL_PORT=8545
L2_HTTP_PORT=8546
L2_WS_PORT=8547
L1_INTERFACE_PORT=8548
DA_PUBLISHER_PORT=3001
DOGECOIN_RPC_PORT=44556
POSTGRES_PORT=5432

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[local-stack]${NC} $*"; }
warn() { echo -e "${YELLOW}[local-stack]${NC} $*"; }
err() { echo -e "${RED}[local-stack]${NC} $*" >&2; }
section() { echo -e "\n${CYAN}=== $* ===${NC}"; }

# Parse args
PHASE="${1:-1}"
case "${PHASE}" in
  1|2|3) ;;
  *) err "Usage: $0 [1|2|3]  (phase number, default=1)"; exit 1 ;;
esac

cleanup_existing() {
  log "Cleaning up existing containers..."
  ${DOCKER_CMD} rm -f dogeos-l2geth 2>/dev/null || true
  ${DOCKER_CMD} rm -f dogeos-dogecoin 2>/dev/null || true
  ${DOCKER_CMD} rm -f dogeos-postgres 2>/dev/null || true

  if lsof -ti:${ANVIL_PORT} >/dev/null 2>&1; then
    warn "Killing existing process on port ${ANVIL_PORT}"
    kill $(lsof -ti:${ANVIL_PORT}) 2>/dev/null || true
    sleep 1
  fi

  # Kill l1-interface and da-publisher if running
  for pidfile in "${SCRIPT_DIR}/l1-interface.pid" "${SCRIPT_DIR}/da-publisher.pid"; do
    if [ -f "${pidfile}" ]; then
      PID=$(cat "${pidfile}")
      if kill -0 "${PID}" 2>/dev/null; then
        log "Stopping PID ${PID} ($(basename "${pidfile}" .pid))..."
        kill "${PID}" 2>/dev/null || true
      fi
      rm -f "${pidfile}"
    fi
  done
}

start_anvil() {
  log "Starting Anvil (L1) on port ${ANVIL_PORT}..."
  "${ANVIL_BIN}" \
    --host 0.0.0.0 \
    --port "${ANVIL_PORT}" \
    --chain-id 111111 \
    --slots-in-an-epoch 3 \
    --hardfork cancun \
    > "${SCRIPT_DIR}/anvil.log" 2>&1 &
  echo $! > "${SCRIPT_DIR}/anvil.pid"
  log "Anvil PID: $(cat "${SCRIPT_DIR}/anvil.pid")"
}

wait_for_rpc() {
  local url="$1"
  local name="$2"
  local max_attempts="${3:-30}"
  local attempt=0

  while [ $attempt -lt $max_attempts ]; do
    if curl -sf "${url}" -X POST -H 'Content-Type: application/json' \
      -d '{"method":"eth_blockNumber","params":[],"id":1,"jsonrpc":"2.0"}' >/dev/null 2>&1; then
      log "${name} is ready"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  err "${name} failed to start after ${max_attempts}s"
  return 1
}

wait_for_dogecoin() {
  local max_attempts="${1:-30}"
  local attempt=0

  while [ $attempt -lt $max_attempts ]; do
    if curl -sf --user doge:doge_pass --data-binary '{"jsonrpc":"1.0","method":"getblockcount","params":[],"id":1}' \
      -H 'content-type: text/plain;' http://localhost:${DOGECOIN_RPC_PORT}/ >/dev/null 2>&1; then
      log "Dogecoin node is ready"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  err "Dogecoin node failed to start after $((max_attempts * 2))s"
  return 1
}

init_l2geth() {
  log "Initializing L2 geth data directory..."
  rm -rf "${SCRIPT_DIR}/data/geth/chaindata" "${SCRIPT_DIR}/data/geth/lightchaindata" "${SCRIPT_DIR}/data/geth/nodes" "${SCRIPT_DIR}/data/geth/triecache"

  ${DOCKER_CMD} run --rm --platform linux/amd64 --entrypoint="" \
    -v "${SCRIPT_DIR}:/l2geth" \
    "${L2GETH_IMAGE}" \
    geth --datadir /l2geth/data init /l2geth/genesis.json

  log "L2 geth initialized"
}

start_l2geth() {
  local l1_endpoint="${1:-http://host.docker.internal:${ANVIL_PORT}}"

  log "Starting L2 geth on ports ${L2_HTTP_PORT}/${L2_WS_PORT} (L1: ${l1_endpoint})..."
  ${DOCKER_CMD} run -d --name dogeos-l2geth --platform linux/amd64 --entrypoint="" \
    -v "${SCRIPT_DIR}:/l2geth" \
    -p "${L2_HTTP_PORT}:8545" \
    -p "${L2_WS_PORT}:8546" \
    "${L2GETH_IMAGE}" \
    geth --datadir /l2geth/data \
      --networkid 221122 --port 30303 --nodiscover --syncmode full \
      --http --http.port 8545 --http.addr 0.0.0.0 --http.vhosts='*' --http.corsdomain '*' \
      --http.api 'eth,scroll,net,web3,debug' \
      --ws --ws.port 8546 --ws.addr 0.0.0.0 --ws.api 'eth,scroll,net,web3,debug' \
      --unlock "${SIGNER_ADDR}" --password /l2geth/password --allow-insecure-unlock --mine \
      --scroll-mpt --gcmode archive \
      --cache.noprefetch --cache.snapshot=0 --snapshot=false \
      --miner.gasprice 1000000 --miner.gaslimit 10000000 --rpc.gascap 0 \
      --l1.endpoint "${l1_endpoint}" --l1.confirmations 0x6 --l1.sync.startblock 0 \
      --l1.sync.fetchblockrange 8

  log "L2 geth container: dogeos-l2geth"
}

set_anvil_signer() {
  SYSTEM_CONTRACT="0xB38EB8335F32e681163e404Fe52d80398bb5F8c2"
  SIGNER_SLOT="0x0000000000000000000000000000000000000000000000000000000000000067"
  SIGNER_VALUE="0x000000000000000000000000a7CdA54170FFD9F9C7A6DC72f8a5E6E15ca32fA3"
  log "Setting system contract signer on Anvil..."
  curl -sf "http://localhost:${ANVIL_PORT}" -X POST -H 'Content-Type: application/json' \
    -d "{\"method\":\"anvil_setStorageAt\",\"params\":[\"${SYSTEM_CONTRACT}\",\"${SIGNER_SLOT}\",\"${SIGNER_VALUE}\"],\"id\":1,\"jsonrpc\":\"2.0\"}" >/dev/null
}

deploy_contracts() {
  log "Deploying contracts to Anvil + L2 geth..."

  # Fund deployer on Anvil
  DEPLOYER="0xdED06046416d6bA20c1e2baD51B3A3e2f267d33F"
  curl -sf "http://localhost:${ANVIL_PORT}" -X POST -H 'Content-Type: application/json' \
    -d "{\"method\":\"anvil_setBalance\",\"params\":[\"${DEPLOYER}\",\"0x56BC75E2D63100000\"],\"id\":1,\"jsonrpc\":\"2.0\"}" >/dev/null

  ${DOCKER_CMD} run --rm --platform linux/amd64 --entrypoint="/bin/sh" \
    -e L1_RPC_ENDPOINT=http://host.docker.internal:${ANVIL_PORT} \
    -e L2_RPC_ENDPOINT=http://host.docker.internal:${L2_HTTP_PORT} \
    -e DEPLOYER_PRIVATE_KEY=0x76273b5b6fc7eb6e931ee8f1e74a88d1fdd7ae225a4c8a664858b4cccb083827 \
    -e L1_COMMIT_SENDER_PRIVATE_KEY=0x3f37a3239c8c909c23f6a2ec01c9c26485b9d2a2cd47b089876d2be5c38f328f \
    -e L1_FINALIZE_SENDER_PRIVATE_KEY=0x8a6d51138c05463e0c9b4501f5bb99d4774aa5ddeb46042832ac4e38aef02fdc \
    -e L1_GAS_ORACLE_SENDER_PRIVATE_KEY=0x1805b8b581a4710cf29881fb3eb80ceaf1d5a395a5ace8012d01953a2c1795db \
    -e L2_GAS_ORACLE_SENDER_PRIVATE_KEY=0x96cba5a694704477d6186aebc79a7ff50ba7ed95caacfe62a085a2d78be57597 \
    -v "${SCRIPT_DIR}/contracts-volume:/contracts/volume" \
    -v "${SCRIPT_DIR}/deploy-contracts.sh:/contracts/docker/scripts/local-deploy.sh" \
    dogeos69/scroll-stack-contracts:deploy-20251010 \
    /contracts/docker/scripts/local-deploy.sh

  # Copy generated config-contracts.toml to project root
  cp "${SCRIPT_DIR}/contracts-volume/config-contracts.toml" "${PROJECT_DIR}/config-contracts.toml"
  log "Contracts deployed and config-contracts.toml updated"
}

start_dogecoin() {
  log "Starting Dogecoin testnet node (v1.14.9) on port ${DOGECOIN_RPC_PORT}..."

  # Create persistent volume directory
  mkdir -p "${SCRIPT_DIR}/dogecoin-data"

  ${DOCKER_CMD} run -d --name dogeos-dogecoin --platform linux/amd64 --entrypoint="" \
    -v "${SCRIPT_DIR}/dogecoin-data:/data" \
    -p "${DOGECOIN_RPC_PORT}:44555" \
    "${DOGECOIN_IMAGE}" \
    /dogecoin/bin/dogecoind \
      -testnet \
      -datadir=/data \
      -server=1 \
      -txindex=1 \
      -rpcuser=doge \
      -rpcpassword=doge_pass \
      -rpcport=44555 \
      -rpcbind=0.0.0.0 \
      -rpcallowip=0.0.0.0/0 \
      -printtoconsole=1 \
      -maxconnections=32

  log "Dogecoin container: dogeos-dogecoin"
}

start_postgres() {
  log "Starting PostgreSQL on port ${POSTGRES_PORT}..."
  ${DOCKER_CMD} run -d --name dogeos-postgres \
    -p "${POSTGRES_PORT}:5432" \
    -e POSTGRES_USER=rollup_node \
    -e POSTGRES_PASSWORD=localdev \
    -e POSTGRES_DB=scroll_rollup \
    postgres:16-alpine

  # Wait for PostgreSQL
  local attempt=0
  while [ $attempt -lt 30 ]; do
    if ${DOCKER_CMD} exec dogeos-postgres pg_isready -U rollup_node >/dev/null 2>&1; then
      log "PostgreSQL is ready"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  err "PostgreSQL failed to start"
  return 1
}

start_l1_interface() {
  local binary="${DOGEOS_CORE_DIR}/target/debug/l1_interface"
  local config="${SCRIPT_DIR}/l1-interface.toml"

  if [ ! -f "${binary}" ]; then
    err "l1-interface binary not found at ${binary}"
    err "Build it: cargo build --manifest-path ${DOGEOS_CORE_DIR}/Cargo.toml -p l1_interface"
    return 1
  fi

  log "Starting l1-interface on port ${L1_INTERFACE_PORT}..."
  RUST_LOG=info "${binary}" -c "${config}" \
    > "${SCRIPT_DIR}/l1-interface.log" 2>&1 &
  echo $! > "${SCRIPT_DIR}/l1-interface.pid"
  log "l1-interface PID: $(cat "${SCRIPT_DIR}/l1-interface.pid")"
}

start_da_publisher() {
  local binary="${DOGEOS_CORE_DIR}/target/debug/da_publisher"
  local config="${SCRIPT_DIR}/da-publisher.toml"

  if [ ! -f "${binary}" ]; then
    err "da-publisher binary not found at ${binary}"
    err "Build it: cargo build --manifest-path ${DOGEOS_CORE_DIR}/Cargo.toml -p da_publisher"
    return 1
  fi

  log "Starting da-publisher on port ${DA_PUBLISHER_PORT}..."
  RUST_LOG=info "${binary}" -c "${config}" \
    > "${SCRIPT_DIR}/da-publisher.log" 2>&1 &
  echo $! > "${SCRIPT_DIR}/da-publisher.pid"
  log "da-publisher PID: $(cat "${SCRIPT_DIR}/da-publisher.pid")"
}

show_status() {
  echo ""
  log "=== Stack is running (Phase ${PHASE}) ==="
  log ""

  # Anvil (only for Phase 1/2)
  if [ "${PHASE}" -lt 3 ]; then
    if curl -sf "http://localhost:${ANVIL_PORT}" -X POST -H 'Content-Type: application/json' \
      -d '{"method":"eth_blockNumber","params":[],"id":1,"jsonrpc":"2.0"}' >/dev/null 2>&1; then
      local anvil_block=$(curl -sf "http://localhost:${ANVIL_PORT}" -X POST -H 'Content-Type: application/json' \
        -d '{"method":"eth_blockNumber","params":[],"id":1,"jsonrpc":"2.0"}' | python3 -c "import sys,json; print(int(json.load(sys.stdin)['result'],16))")
      log "  Anvil (build-time): http://localhost:${ANVIL_PORT}  block=${anvil_block}"
    fi
  fi

  # L2 geth
  if curl -sf "http://localhost:${L2_HTTP_PORT}" -X POST -H 'Content-Type: application/json' \
    -d '{"method":"eth_blockNumber","params":[],"id":1,"jsonrpc":"2.0"}' >/dev/null 2>&1; then
    local l2_block=$(curl -sf "http://localhost:${L2_HTTP_PORT}" -X POST -H 'Content-Type: application/json' \
      -d '{"method":"eth_blockNumber","params":[],"id":1,"jsonrpc":"2.0"}' | python3 -c "import sys,json; print(int(json.load(sys.stdin)['result'],16))")
    log "  L2 geth:           http://localhost:${L2_HTTP_PORT}  block=${l2_block}"
    log "  L2 geth WS:        ws://localhost:${L2_WS_PORT}"
  fi

  # Dogecoin (Phase 3)
  if [ "${PHASE}" -ge 3 ]; then
    if curl -sf --user doge:doge_pass --data-binary '{"jsonrpc":"1.0","method":"getblockcount","params":[],"id":1}' \
      -H 'content-type: text/plain;' http://localhost:${DOGECOIN_RPC_PORT}/ >/dev/null 2>&1; then
      local doge_block=$(curl -sf --user doge:doge_pass --data-binary '{"jsonrpc":"1.0","method":"getblockcount","params":[],"id":1}' \
        -H 'content-type: text/plain;' http://localhost:${DOGECOIN_RPC_PORT}/ | python3 -c "import sys,json; print(json.load(sys.stdin)['result'])")
      log "  Dogecoin:          http://localhost:${DOGECOIN_RPC_PORT}  block=${doge_block}"
    fi

    if [ -f "${SCRIPT_DIR}/l1-interface.pid" ] && kill -0 "$(cat "${SCRIPT_DIR}/l1-interface.pid")" 2>/dev/null; then
      log "  l1-interface:      http://localhost:${L1_INTERFACE_PORT}"
    fi

    if [ -f "${SCRIPT_DIR}/da-publisher.pid" ] && kill -0 "$(cat "${SCRIPT_DIR}/da-publisher.pid")" 2>/dev/null; then
      log "  da-publisher:      http://localhost:${DA_PUBLISHER_PORT}"
    fi

    if ${DOCKER_CMD} ps -q -f name=dogeos-postgres 2>/dev/null | grep -q .; then
      log "  PostgreSQL:        localhost:${POSTGRES_PORT}"
    fi
  fi

  log ""
  log "Logs:"
  [ "${PHASE}" -lt 3 ] && log "  Anvil:          ${SCRIPT_DIR}/anvil.log"
  log "  L2 geth:        docker logs dogeos-l2geth"
  [ "${PHASE}" -ge 3 ] && log "  Dogecoin:        docker logs dogeos-dogecoin"
  [ "${PHASE}" -ge 3 ] && log "  l1-interface:    ${SCRIPT_DIR}/l1-interface.log"
  [ "${PHASE}" -ge 3 ] && log "  da-publisher:    ${SCRIPT_DIR}/da-publisher.log"
}

# --- Main ---

section "DogeOS Local Stack - Phase ${PHASE}"

cleanup_existing

# Phase 1/2: Anvil is needed temporarily for contract deployment (L1 address generation).
# Phase 3: L2 geth connects to l1-interface; Anvil is not started.
if [ "${PHASE}" -lt 3 ]; then
  section "Phase 1: Starting Anvil (build-time) + L2 geth"
  start_anvil
  wait_for_rpc "http://localhost:${ANVIL_PORT}" "Anvil"
  set_anvil_signer
else
  section "Phase 1: Starting L2 geth (l1-interface mode)"
fi

init_l2geth

if [ "${PHASE}" -ge 3 ]; then
  start_l2geth "http://host.docker.internal:${L1_INTERFACE_PORT}"
else
  start_l2geth "http://host.docker.internal:${ANVIL_PORT}"
fi

wait_for_rpc "http://localhost:${L2_HTTP_PORT}" "L2 geth"

# Phase 2: Deploy contracts (L1 + L2 via forge; L1 is needed for deterministic address generation)
if [ "${PHASE}" -ge 2 ]; then
  # Only deploy if config-contracts.toml is missing or empty
  if [ ! -s "${SCRIPT_DIR}/contracts-volume/config-contracts.toml" ] || \
     grep -q 'L1_SCROLL_CHAIN_PROXY_ADDR = ""' "${SCRIPT_DIR}/contracts-volume/config-contracts.toml" 2>/dev/null; then
    section "Phase 2: Deploying contracts"
    deploy_contracts
  else
    log "Contracts already deployed (config-contracts.toml exists)"
  fi
fi

# Phase 3: DogeOS services
if [ "${PHASE}" -ge 3 ]; then
  section "Phase 3: Starting DogeOS services"

  # Start Dogecoin (v1.14.9 with integer verbosity support)
  # Check if existing compatible node is available on the port
  if curl -sf --user doge:doge_pass --data-binary '{"jsonrpc":"1.0","method":"getblockcount","params":[],"id":1}' \
    -H 'content-type: text/plain;' http://localhost:${DOGECOIN_RPC_PORT}/ >/dev/null 2>&1; then
    warn "Dogecoin node already running on port ${DOGECOIN_RPC_PORT} - using existing node"
    warn "Note: If RPC errors occur, replace with dogeos69/dogecoin:latest (v1.14.9+)"
  else
    start_dogecoin
    wait_for_dogecoin
  fi

  # Start PostgreSQL
  start_postgres

  # Start l1-interface
  start_l1_interface
  sleep 2

  # Start da-publisher
  start_da_publisher
  sleep 1
fi

show_status
