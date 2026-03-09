#!/usr/bin/env bash
set -e

CHAINID="test"
APP_PATH="/home/celestia/.celestia-app"
NODE_PATH="/home/celestia/bridge/"

# Clean previous state
echo "Cleaning existing state in $APP_PATH and $NODE_PATH..."
rm -rf "$APP_PATH" "$NODE_PATH"
mkdir -p "$APP_PATH" "$NODE_PATH"

echo "Current user: $(whoami)"
echo "Permissions for /home/celestia:"
ls -ld /home/celestia

# Initialize celestia-appd
coins="1000000000000000utia"
echo "Initializing celestia-appd..."
celestia-appd init "$CHAINID" --chain-id "$CHAINID" 2>&1
celestia-appd keys add validator --keyring-backend="test" 2>&1
celestia-appd genesis add-genesis-account "$(celestia-appd keys show validator -a --keyring-backend="test")" "$coins" 2>&1
celestia-appd genesis gentx validator 5000000000utia \
  --keyring-backend="test" \
  --chain-id "$CHAINID" \
  --fees 210000utia 2>&1
celestia-appd genesis collect-gentxs 2>&1

# Increase max square size and max blob size to accommodate wrapped 128KB blobs
# GENESIS_FILE="$APP_PATH/config/genesis.json"
# jq '.app_state.blob.params.max_square_size = "64" | .app_state.blob.params.max_blob_size = "2097152"' "$GENESIS_FILE" > "$GENESIS_FILE.tmp" && mv "$GENESIS_FILE.tmp" "$GENESIS_FILE"

# Configure for local dev
sed -i 's#"tcp://127.0.0.1:26657"#"tcp://0.0.0.0:26657"#g' ~/.celestia-app/config/config.toml
sed -i 's/^timeout_commit\s*=.*/timeout_commit = "2s"/g' ~/.celestia-app/config/config.toml
sed -i 's/^timeout_propose\s*=.*/timeout_propose = "2s"/g' ~/.celestia-app/config/config.toml

# Copy keyring for bridge node
mkdir -p "$NODE_PATH/keys"
cp -r "$APP_PATH/keyring-test" "$NODE_PATH/keys/"

# Start celestia-appd in background
echo "Starting celestia-appd..."
celestia-appd start --grpc.enable --force-no-bbr &

# Wait for block 2 to ensure genesis and state are fully committed
# This prevents bridge initialization from crashing with 'nil commit for block hash'
echo "Waiting for block 2..."
HEIGHT=0
CNT=0
MAX=60
while [ "$HEIGHT" -lt 2 ] && [ "$CNT" -ne "$MAX" ]; do
  RES=$(curl -s http://127.0.0.1:26657/status || true)
  if [ -n "$RES" ]; then
    HEIGHT=$(echo "$RES" | jq -r '.result.sync_info.latest_block_height' 2>/dev/null)
    if [ -z "$HEIGHT" ] || [ "$HEIGHT" = "null" ]; then
      HEIGHT=0
    fi
  else
    HEIGHT=0
  fi
  CNT=$((CNT + 1))
  sleep 1
done

GENESIS=$(curl -s http://127.0.0.1:26657/block?height=1 | jq '.result.block_id.hash' | tr -d '"')

if [ "$HEIGHT" -lt 2 ] || [ "${#GENESIS}" -le 4 ]; then
  echo "ERROR: Failed to reach block 2 or get genesis hash after ${MAX}s"
  exit 1
fi

export CELESTIA_CUSTOM="test:$GENESIS"
echo "CELESTIA_CUSTOM=$CELESTIA_CUSTOM"

# Initialize and start bridge node
echo "Starting celestia bridge node..."
celestia bridge init --node.store "$NODE_PATH" 2>&1
celestia bridge start \
  --node.store "$NODE_PATH" \
  --core.ip 127.0.0.1 \
  --keyring.keyname validator \
  --rpc.addr 0.0.0.0 \
  --rpc.port 26658 \
  --rpc.skip-auth
