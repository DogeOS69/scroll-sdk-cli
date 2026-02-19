#!/usr/bin/env bash
set -e

CHAINID="test"
APP_PATH="/home/celestia/.celestia-app"
NODE_PATH="/home/celestia/bridge/"

# Clean previous state
rm -rf "$APP_PATH" "$NODE_PATH"

# Initialize celestia-appd
coins="1000000000000000utia"
celestia-appd init "$CHAINID" --chain-id "$CHAINID" 2>&1
celestia-appd keys add validator --keyring-backend="test" 2>&1
celestia-appd add-genesis-account "$(celestia-appd keys show validator -a --keyring-backend="test")" "$coins" 2>&1
celestia-appd gentx validator 5000000000utia \
  --keyring-backend="test" \
  --chain-id "$CHAINID" \
  --fees 210000utia 2>&1
celestia-appd collect-gentxs 2>&1

# Configure for local dev
sed -i 's#"tcp://127.0.0.1:26657"#"tcp://0.0.0.0:26657"#g' ~/.celestia-app/config/config.toml
sed -i 's/^timeout_commit\s*=.*/timeout_commit = "2s"/g' ~/.celestia-app/config/config.toml
sed -i 's/^timeout_propose\s*=.*/timeout_propose = "2s"/g' ~/.celestia-app/config/config.toml

# Copy keyring for bridge node
mkdir -p "$NODE_PATH/keys"
cp -r "$APP_PATH/keyring-test/" "$NODE_PATH/keys/keyring-test/"

# Start celestia-appd in background
echo "Starting celestia-appd..."
celestia-appd start --grpc.enable --force-no-bbr &

# Wait for first block
echo "Waiting for first block..."
GENESIS=""
CNT=0
MAX=60
while [ "${#GENESIS}" -le 4 ] && [ "$CNT" -ne "$MAX" ]; do
  GENESIS=$(curl -s http://127.0.0.1:26657/block?height=1 | jq '.result.block_id.hash' | tr -d '"')
  CNT=$((CNT + 1))
  sleep 1
done

if [ "${#GENESIS}" -le 4 ]; then
  echo "ERROR: Failed to get genesis hash after ${MAX}s"
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
