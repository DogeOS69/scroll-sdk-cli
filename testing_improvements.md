# Problem

- DevEx for `dogeos-core` if very rough — testing for unit tests is fine, integration tests are scattered and for e2e (or upgrade) tests are very manual and time consuming.
- This has often looked like:
    - Daniel makes massive code changes with AI, builds docker images
    - 24 hours later, Shu and Unifra try upgrading a devnet
        - for small issues, they report the error and debug, Daniel debugs, takes a day or two
        - for larger issues, the network needs reset, lots of work for Unifra, long delays for iteration
    - Once “working” we still need to let the network run a bit to see if it works!
    - Then, if there are “hardfork” like characteristics, we still don’t have confidence to upgrade testnet

# Goal

- Spend the time between stabilized v0.2.0 and deployment-ready v0.3.0 to focus energy on our testing and CI stack
- With the changes we should:
    - Be able to run “testnet” or “mainnet” upgrades over and over in isolated environments until we’re very confident in them
    - Developer should be able to get quicker feedback on changes without getting pulled into devops

# Existing Work

- Local stack harness + manual sandbox for TSO/withdrawal/dummy signers exist and are the closest thing to a reproducible dev stack today (`crates/test_utils/README.md`,
  `crates/test_utils/src/bin/create_manual_sandbox.md`).
- Service-level mocks/harness patterns already exist but aren’t unified across services: TSO mock server (`crates/tso_service/README.md`), DogeOS RPC mock (`crates/
dogeos_utils/README.md`), and Wiremock-based multi-service harness in fee_oracle (`crates/fee_oracle/README.md`, `TEST_GUIDE.md`).
- Helm charts and devnet bootstrap scripts are present in the DogeOS fork of Scroll SDK (local devnet `Makefile`, chart structure, config generation scripts), but they’re
  still Scroll-centric and need DogeOS updates (`references/scroll-sdk/devnet/Makefile`, `references/scroll-sdk/devnet/prepare-config-files.sh`, `references/scroll-sdk/charts/
scroll-sdk/Chart.yaml`, `ARCHITECTURE.md`).
- The CLI for automating deployment/config is already non‑interactive and JSON‑friendly as of https://github.com/DogeOS69/scroll-sdk-cli/pull/56 (fixes to make in Linear), making it a good automation substrate (`references/scroll-sdk-cli/docs/automation.md`,
  `references/scroll-sdk-cli/README.md`).
- Shadowforking Dogecoin is now supported with a purpose-built orchestrator (fork-at-height, instant mining, reorgs, sentinel spend) that’s ideal for deterministic local
  testnets (`references/dogeos-shadow-orchestrator/README.md`) with the “forked chains” living on a remote server for fast deployment.
    - https://github.com/DogeOS69/dogecoin/tree/feat/shadow
    - https://github.com/DogeOS69/dogecoin-shadow-orchestrator

# Improvement Ideas

## **Upgrade testing (version‑to‑version)**

- Create a formal “upgrade suite” that runs old binaries on a fixture DB/chain snapshot, upgrades to new binaries, and replays the same flows; base the migration checks on
  shared schema and embedded migrations (`migrations/`, `crates/data_model/src/schema.rs`, `crates/indexer_manager/README.md`).
- Store and version “upgrade fixtures” (SQLite snapshots + expected output assertions for each service) under a dedicated area, reusing the existing sandbox/ and
  debug_assets/ convention called out in testing docs ([TESTING.md](http://testing.md/)).
- Add protocol‑compatibility tests that load historical common_types + da_codec fixtures and assert decode/encode invariants across versions; this catches subtle format
  drifts before runtime (`crates/common_types/README.md`, `crates/da_codec/SPEC.md`).
- Use shadowfork replays to validate reorg handling and upgrade safety on real chain state (fork at height N, replay historic blocks, then run new binaries against the fork)
  to mimic production upgrades without waiting on live networks (`references/dogeos-shadow-orchestrator/README.md`).

## Ephemeral networks and local forks

- Dogecoin: integrate the shadow‑orchestrator into test_utils so create_manual_sandbox can optionally spin a forked Dogecoin RPC and pre-fund accounts via sentinel spend;
  this makes the local stack fully self‑contained (`crates/test_utils/src/bin/create_manual_sandbox.md`, `references/dogeos-shadow-orchestrator/README.md`).
    - This also means we don’t have to use “new” signers here if we modify TSO, we just return sentinel values for shadowfork mode
- L2: revive the Scroll SDK devnet flow but cut it down to a “DogeOS‑minimal” profile; keep only the L2 RPC/sequencer + contracts + any DogeOS‑specific services
  (`l1_interface/da_publisher`). Use the existing devnet Makefile as the base and update images/values to DogeOS (references/scroll-sdk/devnet/Makefile, references/scroll-sdk/
  examples/config.toml.example).
    - Ideally this can support remote dogecoin shadow forks for Dogecoin L1
- Celestia: offer a local “single‑host” Celestia node profile that can be launched via Docker/helm (either as a lightweight stack or via a devnet container), and wire that
  into the same profile spec as above (`references/scroll-sdk/charts/celestia-node/Chart.yaml`).
    - I’m not convinced there isn’t a better approach here — maybe we need to add a shadow fork like function for Celestia too?
- Automation glue: make `scroll-sdk-cli` the single “driver” for ephemeral setup/tear‑down; non‑interactive mode + JSON output is already ready for CI and scripting
  (`/docs/automation.md`).

## Multiservice integration tests with mocks (service isolation)

- Expand the test_utils harness so it can bring up optional l1_interface, rollup-relayer and da_publisher alongside the current TSO/withdrawal/dummy signer set; this gives
  you “full bridge” integration with a single orchestrator (`crates/test_utils/README.md`).
- Build a shared “mock RPC kit” patterned after `fee_oracle`’s Wiremock harness and `dogeos_utils` MockDogeosRpc; this should cover Dogecoin RPC, Celestia RPC, and DogeOS L2 RPC so each service can be tested in isolation (`crates/fee_oracle/README.md`, `crates/dogeos_utils/README.md`).
- Add “contract tests” for inter‑service APIs (TSO, withdrawal_processor, l1_interface, da_publisher) that validate request/response compatibility without needing full external chains
    - this reduces k8s dependency for CI while still catching integration regressions (`crates/tso_service/README.md`, `crates/withdrawal_processor/README.md`,
      `crates/l1_interface/README.md`, `crates/da_publisher/README.md`).
    - Adding l2reth to this mix might be easier than l2geth would have been? may be worth exploring.

---

# February 9, 2026 Additional Improvements

- @Vladislav Markushin ~~may have need for regtest support for Shadow Forks~~
    - ~~Will decide if there is a “why” reason to add or if enable regtest functionality in testnet~~
    - We already have all the regtest RPC commands available in shadow-forks (e.g. `generatetoaddress`, `invalidateblock` , `setmocktime` , etc.), even for originally non-regtest chains
- Confirming UTXO tracking in shadow forks — we don’t have blockbook, so we need adding a wallet for tracking UTXOs (for some recent range, or at least just before reorg) to be a supported first class feature for grabbing UTXOs for test addresses
- API for a “faucet” where automated tooling can request funds to a specific address at the beginning of testing
    - Likely for testnet and mainnet
    - Ideally tests “cleanup” by sending funds back to the faucet
    - **NEW**: Can just use `generatetoaddress` RPC to mint