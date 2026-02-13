# Agent Handoff Log (2026-02-12)

## Summary

Built a "DogeOS-Minimal Local Stack" across multiple sessions. All 3 phases are functionally complete. **The full Dogecoin deposit pipeline works end-to-end on regtest.**

## Architecture

DogeOS has a dual-L1 architecture:
- **Anvil** (chain-id 111111): Writable ETH-compatible L1 with bridge contracts (used for `test contracts`)
- **l1-interface**: Read-only Dogecoin→ETH facade (translates Dogecoin blocks to ETH-compatible JSON-RPC)
- **L2 geth** (chain-id 221122): Scroll-based L2 rollup reading from l1-interface
- **L2DogeOsMessenger**: Custom messenger that only relays messages to the Moat contract

Key insight: `test e2e` (ETH bridge) does NOT work with DogeOS because L2DogeOsMessenger restricts relay to Moat-only. `test dogeos` (Dogecoin bridge via Moat) is the correct test.

## Phase Status

### Phase 1: Anvil + L2 geth ✅ COMPLETE
- Anvil on port 8545, L2 geth on ports 8546/8547
- L2 geth reads from l1-interface (port 8548) for deposit pipeline

### Phase 2: Contract Deployment ✅ COMPLETE
- Bridge contracts deployed to both Anvil (L1) and L2 geth
- L2 contracts deployed post-genesis via Docker (blocks 2-12)
- `test contracts` passes: 22/22 contracts verified (Deployed, Initialized, Correctly Owned)

### Phase 3: DogeOS Deposit Pipeline ✅ COMPLETE
- Dogecoin regtest on port 44556 (instant mining)
- l1-interface: running, indexing regtest deposits
- **Full deposit verified**: 100 DOGE deposited → detected by l1-interface → served via ETH RPC → L2 geth processed as L1 message → L2ScrollMessenger → L2DogeOsMessenger/Moat → recipient received ~50 ETH on L2

## Running Services

| Service | Port | Container/Process | Status |
|---------|------|-------------------|--------|
| Anvil (L1) | 8545 | background process | ✅ Running |
| L2 geth HTTP | 8546 | dogeos-l2geth (Docker) | ✅ Running (block 14) |
| L2 geth WS | 8547 | dogeos-l2geth (Docker) | ✅ Running |
| l1-interface API | 8548 | background process | ✅ Running (ready) |
| l1-interface beacon | 3500 | background process | ✅ Running |
| l1-interface health | 9091 | background process | ✅ Running |
| Dogecoin regtest | 44556 | dogeos-dogecoin-regtest (OrbStack) | ✅ Running (500+ blocks) |

## Deposit Pipeline (Proven Working)

```
Dogecoin regtest (port 44556)
  → sendrawtransaction (100 DOGE to bridge + OP_RETURN with version+address)
  → mine block (generate 1)
  → mine 200 more blocks (for finality)
  ↓
l1-interface (port 8548)
  → dogecoin_indexer detects deposit in SQLite
  → eth_getLogs returns QueueTransaction event
  → eth_getBlockByNumber serves simulated L1 block
  ↓
L2 geth (port 8546)
  → L1 sync service polls eth_getLogs from l1-interface
  → Receives L1Message (queueIndex=N)
  → NOTE: needs a user L2 tx to trigger mining (relaxed_period=true)
  → Mines block with L1 message as cross-chain tx
  ↓
L2 Contracts
  → L2ScrollMessenger.relayMessage()
  → L2DogeOsMessenger.handleL1Message()
  → Moat contract processes deposit
  → Recipient receives ETH on L2
```

### Deposit OP_RETURN Format
```
Script: 6a (OP_RETURN) + 15 (push 21 bytes) + 00 (version V0) + <20-byte EVM address>
Data field for createrawtransaction: "00" + hex_evm_address (no 0x prefix)
Example: "00ded06046416d6ba20c1e2bad51b3a3e2f267d33f"
```

### Creating a Deposit (Dogecoin CLI)
```bash
# Get change address
CHANGE=$(curl -s -X POST --user doge:doge_pass -H 'Content-Type: application/json' \
  -d '{"method":"getrawchangeaddress","params":[],"id":1}' http://127.0.0.1:44556/ | jq -r .result)

# Create raw tx: outputs is a single object (v1.14.9 format)
RAW=$(curl -s -X POST --user doge:doge_pass -H 'Content-Type: application/json' \
  -d '{"method":"createrawtransaction","params":[[{"txid":"<utxo_txid>","vout":0}],{"2MwBbwpBBNH93rzeo2vBSJ7tFTewYjtXj6c":100.0,"data":"00<recipient_hex>","'$CHANGE'":499899.0}],"id":1}' \
  http://127.0.0.1:44556/ | jq -r .result)

# Sign and send
SIGNED=$(curl -s -X POST --user doge:doge_pass -H 'Content-Type: application/json' \
  -d '{"method":"signrawtransaction","params":["'$RAW'"],"id":1}' http://127.0.0.1:44556/ | jq -r .result.hex)

TXID=$(curl -s -X POST --user doge:doge_pass -H 'Content-Type: application/json' \
  -d '{"method":"sendrawtransaction","params":["'$SIGNED'"],"id":1}' http://127.0.0.1:44556/ | jq -r .result)

# Mine blocks (1 for confirmation + 200 for finality)
curl -s -X POST --user doge:doge_pass -H 'Content-Type: application/json' \
  -d '{"method":"generate","params":[201],"id":1}' http://127.0.0.1:44556/

# Trigger L2 mining with any L2 transaction
cast send --rpc-url http://localhost:8546 --private-key 0x76273b5b... --legacy --gas-price 100000000 \
  0x0000000000000000000000000000000000000001 --value 0
```

## Key Files

### Created
- `local-stack/start.sh` - Orchestration (Phase 1/2/3)
- `local-stack/stop.sh` - Cleanup
- `local-stack/l1-interface.toml` - l1-interface config (regtest, port 44556)
- `local-stack/genesis.json` - L2 genesis
- `local-stack/contracts-volume/config.toml` - Contract deployment config
- `local-stack/contracts-volume/config-contracts.toml` - All deployed addresses
- `local-stack/dogecoin-regtest-data/` - Persistent regtest chain data
- `local-stack/l1_interface.sqlite` - l1-interface indexed state

### Modified
- `config.toml` - Local endpoints
- `config-contracts.toml` - All contract addresses (L1 + L2)

## Technical Findings

### L2 geth mining with relaxed_period
L2 geth uses `relaxed_period=true` (from genesis clique config). This means it ONLY produces blocks when there are pending transactions. L1 messages are received and stored, but a user L2 transaction is needed to trigger the miner. The miner then includes both the user tx AND pending L1 messages.

### L1 finality for deposit processing
L2 geth uses `--l1.confirmations` to determine when L1 messages are eligible for inclusion. Additionally, l1-interface's beacon API serves finality checkpoints based on Dogecoin block depth. The finalized block must be past the deposit block for L2 geth to process it. Mine ~200 regtest blocks to ensure finality.

### Dogecoin regtest vs testnet
Using `network_str = "testnet"` in l1-interface.toml works with regtest because testnet and regtest share address prefixes in Dogecoin. The bridge address `2MwBbwpBBNH93rzeo2vBSJ7tFTewYjtXj6c` is tagged as Testnet-format but works on regtest.

### L2 contract deployment order
Genesis only includes predeploy contracts (L1GasPriceOracle, L2MessageQueue, etc.). Bridge contracts (L2DogeOsMessenger, Moat, gateways) must be deployed post-genesis via the contracts Docker image. Any L1 messages processed BEFORE L2 contracts are deployed will hit empty addresses and silently succeed without effect.

## Contract Addresses
```
L1_SCROLL_CHAIN_PROXY_ADDR = "0xB272Bb21B7B6e23Ec079A2DF90Adb52000768B4d"
L1_SCROLL_MESSENGER_PROXY_ADDR = "0xFaF5Fb29de81735a7c48B3aE7Df5646B9f01714f"
L1_ETH_GATEWAY_PROXY_ADDR = "0x6c92a022D04158b542125e95d718c219864Bd7a4"
L1_MESSAGE_QUEUE_V2_PROXY_ADDR = "0xe0FF161D1a68DbED9404bD34bD7f93198Fc33f45"
L2_DOGEOS_MESSENGER_PROXY_ADDR = "0x98185147ac03eDe6C9D3809395D095D4d19b0860"
L2_ETH_GATEWAY_PROXY_ADDR = "0x9a2A27A43BBA08B0616b7d6eE99DDC2eB499D1Ae"
L2_MOAT_PROXY_ADDR = "0xC486ae5107517EA9CD80924D59463AA089FbBe15"
L2_BASCULE_MOCK_VERIFIER_ADDR = "0x9494E33161e6081B7565a42e68DC11B4a08cEd79"
```

## Quick Start

```bash
cd scroll-sdk-cli

# Start Phase 1+2 (Anvil + L2 geth + contracts)
./local-stack/start.sh 2

# Start Phase 3 (Dogecoin regtest + l1-interface)
./local-stack/start.sh 3

# Verify contracts
node bin/run.js test contracts

# Stop everything
./local-stack/stop.sh
```

## Deployer Keys
- Contract deployer: `0x76273b5b6fc7eb6e931ee8f1e74a88d1fdd7ae225a4c8a664858b4cccb083827` (address: `0xdED06046416d6bA20c1e2baD51B3A3e2f267d33F`)
- L2 sequencer: keystore in `local-stack/data/keystore/` (address: `0xa7CdA54170FFD9F9C7A6DC72f8a5E6E15ca32fA3`)
- Dogecoin RPC: user=`doge`, pass=`doge_pass`

## Remaining Work

### For `test dogeos` command
- The `test dogeos` command currently expects a Blockbook API and testnet-specific infrastructure
- It needs to be adapted to work with regtest (direct Dogecoin RPC instead of Blockbook)
- Or: implement a test that directly creates deposits via RPC (as proven above)

### For full rollup stack (optional)
- da-publisher: needs Celestia node (or mock)
- rollup-relayer: needs PostgreSQL + da-publisher
- These are only needed for withdrawal tests, not deposit tests
