#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log() { echo -e "${GREEN}[local-stack]${NC} $*"; }

# Use OrbStack if available
ORBSTACK_SOCK="${HOME}/.orbstack/run/docker.sock"
if [ -S "${ORBSTACK_SOCK}" ]; then
  export DOCKER_HOST="unix://${ORBSTACK_SOCK}"
fi

log "=== Stopping DogeOS Local Stack ==="

# Stop native processes
for pidfile in "${SCRIPT_DIR}/l1-interface.pid" "${SCRIPT_DIR}/da-publisher.pid" \
               "${SCRIPT_DIR}/fee-oracle.pid" "${SCRIPT_DIR}/withdrawal-processor.pid" \
               "${SCRIPT_DIR}/l2-txgen.pid" "${SCRIPT_DIR}/dogecoin-miner.pid"; do
  if [ -f "${pidfile}" ]; then
    svc="$(basename "${pidfile}" .pid)"
    PID=$(cat "${pidfile}")
    if kill -0 "${PID}" 2>/dev/null; then
      log "Stopping ${svc} (PID ${PID})..."
      kill "${PID}" 2>/dev/null || true
    fi
    rm -f "${pidfile}"
  fi
done

# Stop Docker containers
for container in dogeos-l2geth dogeos-dogecoin dogeos-postgres \
                 dogeos-rollup-relayer dogeos-celestia \
                 dogeos-tso dummy-signer-0; do
  if docker ps -q -f name="${container}" 2>/dev/null | grep -q .; then
    log "Stopping ${container}..."
    docker stop "${container}" && docker rm "${container}"
  else
    docker rm -f "${container}" 2>/dev/null || true
  fi
done

# Kill anything still on the ports
for port in 8546 8547 8548 3000 3001 3002 3003 3500 4000 8080 9091 18445; do
  if lsof -ti:${port} >/dev/null 2>&1; then
    log "Killing remaining process on port ${port}"
    kill $(lsof -ti:${port}) 2>/dev/null || true
  fi
done

log "=== Stack stopped ==="
