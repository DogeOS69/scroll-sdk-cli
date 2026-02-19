# DogeOS Local Stack

Local development environment for the DogeOS L2 rollup. Runs the full stack on your machine using Docker containers and native binaries.

## Architecture

```
Dogecoin (regtest)
    │
    ▼
l1-interface ─── simulates EVM L1 ──► L2 geth (scroll-l2geth)
    │                                      │
    │                                      ▼
    │                              rollup-relayer
    │                                      │
    ▼                                      ▼
Celestia ◄── da-publisher          TSO ◄── dummy-signer
                                           │
                                           ▼
                                   withdrawal-processor
                                   fee-oracle
```

### Why there's no Anvil/EVM L1

DogeOS uses Dogecoin as its L1, not Ethereum. The `l1-interface` service translates between Dogecoin blocks and the EVM block format that L2 geth expects. It **simulates** L1 EVM behavior — emitting synthetic transactions and events using contract addresses as identifiers only. No EVM bytecode is executed on L1.

This means L1 contracts (ScrollChain, L1ScrollMessenger, etc.) don't need to be deployed to any real EVM chain. Their addresses are computed deterministically via CREATE2 during the `forge script ... "None" "write-config"` simulation step and written to `config-contracts.toml`. All services reference these addresses as identifiers.

L2 contracts (L2ScrollMessenger, gateways, etc.) ARE deployed to L2 geth via forge because geth actually executes them.

### Contract deployment

Address generation and L2 deployment are separate steps, run by different scripts inside the `scroll-stack-contracts` Docker image:

1. **Generate addresses** (`generate-addresses.sh`, `"None"` mode) — computes all deterministic CREATE2 addresses, writes `config-contracts.toml`. No RPC needed.
2. **Simulate L2** (`deploy-contracts.sh`) — dry-run against L2 geth to verify deployment will succeed
3. **Deploy L2** (`deploy-contracts.sh`) — broadcasts real transactions to L2 geth

L1 deployment is skipped entirely. The simulation step produces the same deterministic addresses regardless.

**Note on `contracts-volume/config.toml`**: The forge scripts read `./volume/config.toml` inside the container, which maps to `contracts-volume/config.toml` on the host. This file must include a `[sequencer]` section with `L2GETH_SIGNER_ADDRESS` — `start.sh` generates it automatically from the project root config.toml.

## Prerequisites

- **OrbStack** (recommended) or Docker Desktop — OrbStack's Rosetta emulation works better than Docker Desktop's QEMU for amd64 Go binaries
- **Foundry** (`cast` CLI) — used for L2 account setup
- **dogeos-core binaries** — `l1_interface`, `da_publisher`, `fee_oracle`, `withdrawal_processor` built from `~/work/DogeOS69/dogeos-core`
- **Docker images** — `scrolltech/l2geth`, `scrolltech/rollup-relayer`, `dogeos69/dogecoin`, `dogeos69/tso-service`, `dogeos69/dummy-signer`, `dogeos69/scroll-stack-contracts`

## Usage

```bash
# Start the full stack
./start.sh

# Stop everything
./stop.sh
```

The stack starts all services in a single linear sequence — no phases or manual steps required.

## Port Map

| Service              | Port  | Protocol |
|----------------------|-------|----------|
| L2 geth (HTTP)       | 8546  | JSON-RPC |
| L2 geth (WebSocket)  | 8547  | WS       |
| l1-interface         | 8548  | JSON-RPC |
| Dogecoin RPC         | 18445 | JSON-RPC |
| PostgreSQL           | 5432  | Postgres |
| da-publisher         | 3001  | HTTP     |
| withdrawal-processor | 3002  | HTTP     |
| TSO                  | 3003  | HTTP     |
| dummy-signer         | 4000  | HTTP     |
| fee-oracle (health)  | 8080  | HTTP     |
| Celestia consensus   | 26657 | RPC      |
| Celestia bridge      | 26658 | JSON-RPC |
| Celestia gRPC        | 9090  | gRPC     |

## Startup Sequence

1. **Generate config.toml** from deployment spec (first pass, without contract addresses)
2. **Prepare contracts-volume/config.toml** (copy config + add `[sequencer]` section for forge)
3. **Generate deterministic addresses** (forge simulation, no RPC needed)
4. **Regenerate service configs** (second pass — writes real contract addresses into l1-interface.toml, etc.)
5. Dogecoin regtest node + auto-miner (110 initial blocks)
6. PostgreSQL
7. l1-interface (Dogecoin → EVM block translation, now has correct addresses)
8. L2 geth (initialized with genesis.json, points to l1-interface)
9. Celestia devnet (consensus + bridge node)
10. da-publisher (L2 blobs → Celestia)
11. **Deploy L2 contracts** (forge broadcast to L2 geth, if not already deployed)
12. L2 account setup (fund fee-oracle sender, whitelist)
13. L2 tx generator (continuous block production)
14. Service databases + rollup DB migration
15. rollup-relayer
16. TSO + dummy-signer
17. fee-oracle + withdrawal-processor

## Logs

- **L2 geth**: `docker logs dogeos-l2geth`
- **Dogecoin**: `docker logs dogeos-dogecoin`
- **l1-interface**: `local-stack/l1-interface.log`
- **da-publisher**: `local-stack/da-publisher.log`
- **rollup-relayer**: `docker logs dogeos-rollup-relayer`
- **TSO**: `docker logs dogeos-tso`
- **dummy-signer**: `docker logs dummy-signer-0`
- **fee-oracle**: `local-stack/fee-oracle.log`
- **withdrawal-processor**: `local-stack/withdrawal-processor.log`
