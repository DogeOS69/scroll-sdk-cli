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

The `deploy-contracts.sh` script runs inside the `scroll-stack-contracts` Docker image:

1. **Simulate** (`"None"` mode) — computes all deterministic CREATE2 addresses, writes `config-contracts.toml`
2. **Simulate L2** — dry-run against L2 geth to verify deployment will succeed
3. **Deploy L2** — broadcasts real transactions to L2 geth

L1 deployment is skipped entirely. The simulation step produces the same deterministic addresses regardless.

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

1. **Generate deterministic addresses** (forge simulation, no RPC needed)
2. **Regenerate service configs** (writes addresses into l1-interface.toml, etc.)
3. Dogecoin regtest node + auto-miner (110 initial blocks)
4. PostgreSQL
5. l1-interface (Dogecoin → EVM block translation, now has correct addresses)
6. L2 geth (initialized with genesis.json, points to l1-interface)
7. Celestia devnet (consensus + bridge node)
8. da-publisher (L2 blobs → Celestia)
9. **Deploy L2 contracts** (forge broadcast to L2 geth, if not already deployed)
10. L2 account setup (fund fee-oracle sender, whitelist)
11. L2 tx generator (continuous block production)
12. Service databases + rollup DB migration
13. rollup-relayer
14. TSO + dummy-signer
15. fee-oracle + withdrawal-processor

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
