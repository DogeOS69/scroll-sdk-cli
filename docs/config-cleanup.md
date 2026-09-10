# DogeOS configuration cleanup and retired services

Updated 2026-09-11. This is the current configuration procedure for the local
CLI and the matching `scroll-contracts` workspace. Existing deployment status
reports describe their historical deployments; use this page for the supported
configuration fields and prompts.

For the general command sequence, see [CLI setup order](setup-order.md).

## Matching contracts release

The CLI defaults are pinned to contracts commit
`dd1747862ee11e5feab45ca76c462957fb0d8bfa` in `DogeOS69/scroll-contracts`.
The existing [image release workflow](https://github.com/DogeOS69/scroll-contracts/actions/runs/34494482916)
was dispatched for that exact commit. Images use the repository
`dogeos69/scroll-stack-contracts` and the existing role-prefix/full-SHA format:

- `gen-configs-dd1747862ee11e5feab45ca76c462957fb0d8bfa`
- `deploy-dd1747862ee11e5feab45ca76c462957fb0d8bfa`
- `verify-dd1747862ee11e5feab45ca76c462957fb0d8bfa`

`CONTRACTS_DOCKER_DEFAULT_TAG` supplies the common revision for genesis generation,
verification, and the deployment image in generated contracts values. Explicit
image overrides and existing deployment values should be reviewed when upgrading.
The workflow also publishes `base-<same full SHA>` for both amd64 and arm64.
Check the linked workflow has completed before using a newly dispatched image.

## Supported inputs

Use `scroll-contracts/docker/templates/config.toml` as the shared contracts/CLI
template. It now contains 50 fields: 46 original fields removed and two active ingress hosts added. Fill the account,
fee recipient, RPC, domain and enabled database placeholders for your environment.
Keep the matching contract scripts and CLI changes together when building releases.
The contract repository's `docs/config-template-audit.md` records the field audit
and local deployment verification.

| Input | Current owner and purpose |
| --- | --- |
| Root `[accounts]` | Deployer, owner and application signer addresses. `setup gen-keystore` creates/reuses deployer and activity helper accounts. Supply `OWNER_ADDR` explicitly. |
| `.data/doge-config.toml` Reth instances | Sequencer block signer, P2P nodekeys and bootnodes. Use `setup l2-sequencer-reth` and `setup l2-bootnode-reth`. |
| Dogecoin RPC | `setup doge-config` configures and checks the Dogecoin JSON-RPC endpoint. Bridge setup and transaction broadcast use RPC. |
| Electrs URL | Wallet UTXO synchronization uses `doge wallet sync --electrs-url URL`, or optional `rpc.electrsAPIUrl` in doge-config. Mainnet/regtest require an explicit URL; testnet retains its existing default Electrs endpoint. |
| Ethereum DA, proof and bridge settings | Still required by their respective services and setup commands. Removing old indexers does not remove protocol identities or the Dogecoin bridge sequencer transaction. |

`setup doge-config` no longer asks for an Internal Blockbook API URL, API key,
public host or Kubernetes service/ports. There is no Blockbook network fallback.
Bridge genesis transaction byte recovery uses Dogecoin `getrawtransaction`.

Contracts generation no longer requests a genesis signer in root
`sequencer.L2GETH_SIGNER_ADDRESS` or asks for `L1_PLONK_VERIFIER_ADDR`.
The Reth RPC package still uses the configured Reth sequencer index 0 signer;
it is independent of the contract generator. See [Pure Reth configuration](reth-only-peers.md).

## Gas-token and rollup sections

The shared template has no `[gas-token]` section. Current contracts do not read
`ALTERNATIVE_GAS_TOKEN_ENABLED`, and new DeploymentSpec generation no longer emits
alternative-token settings. Saving old configurations removes that section.
Legacy `helper fund-accounts`, `test contracts` and `test e2e` still understand
old manually supplied alternative-token settings; they default to false when the
section is absent. This compatibility does not enable alternative tokens in the
current DogeOS contract deployment.

`MAX_TX_IN_CHUNK` is removed: `ScrollChain.initialize` only stores it in the
obsolete `__maxNumTxInChunk` slot, which no contract reads. Deployment scripts
pass zero to the retained initializer ABI argument; the storage layout is unchanged.
The generator also stops reintroducing previously retired `MAX_BLOCK_IN_CHUNK`,
`MAX_BATCH_IN_BUNDLE` and root `TEST_ENV_MOCK_FINALIZE_TIMEOUT_SEC` projections.

DogeOS uses Dogecoin as its actual L1. The Ethereum/Scroll L1 contracts used by
the deployment scripts are simulated for deployment/address derivation; they are
not contracts deployed on Dogecoin. Removing their configuration is independent
of whether the L2 execution client is Reth or Geth. The Reth node identity cleanup
described elsewhere on this page is a separate change.

The entire root `[rollup]` section is removed. None of its remaining fields
entered L2 contract initialization:

| Removed field | Former destination |
| --- | --- |
| `MAX_L1_MESSAGE_GAS_LIMIT` | L1 `SystemConfig.MessageQueueParameters.maxGasLimit`. |
| `FINALIZE_BATCH_DEADLINE_SEC` | L1 `SystemConfig.EnforcedBatchParameters.maxDelayEnterEnforcedMode`. |
| `RELAY_MESSAGE_DEADLINE_SEC` | L1 `SystemConfig.EnforcedBatchParameters.maxDelayMessageQueue`. |
| `TEST_ENV_MOCK_FINALIZE_ENABLED` | L1 `ScrollChain` implementation selection. |

The contracts repository no longer reads these fields in `Configuration.sol`.
The deterministic generator always selects the real `ScrollChain`, matching the
old template's default `false`. Its explicitly invoked legacy L1 initialization
path reads the three numeric inputs from same-named environment variables,
consistent with the standalone `InitializeL1BridgeContracts` script. They are
not required by `gen-configs.sh`, the L2-only `deploy.sh`, or CLI setup commands.
The environment inputs belong only to the retained standalone Ethereum/Scroll
L1 deployment capability, not to the normal DogeOS workflow. Do not add them to
the DogeOS root template.

CLI generation, validation and old-config migration no longer emit or require
these fields. Imported DeploymentSpecs lose `rollup.finalization`,
`rollup.maxL1MessageGasLimit` and retired test mock-finalization flags. The unused
`test e2e` reads and doge-config mock-finalization projection are removed too.
The remaining DeploymentSpec `rollup.coordinator` / `verifierDigests` compatibility
inputs are separate from the deleted TOML section; this does not remove native
Reth gas limits, Ethereum DA configuration or proof finality settings.

## Database initialization

`setup db-init` handles only `scroll_blockscout` / role `blockscout`. It no
longer asks which optional service database to create. Initialization, `--clean`,
`--update-permissions` and `--update-port` operate only on Blockscout.

The shared template and generated root configuration retain exactly one database
connection string:

```toml
[db]
BLOCKSCOUT_DB_CONNECTION_STRING = ""
```

Rollup, Gas Oracle, Coordinator, Rollup Explorer and Admin System DSNs and aliases
are removed, alongside Bridge History, Chain Monitor and L1 Explorer. Old
per-service passwords and `CREATE_*` database switches are discarded when saving
configuration. `db-init` no longer projects its result into other service DSNs.

For automation, provide administrator connection settings separately:

```toml
[db.admin]
PUBLIC_HOST = "postgres.example.internal"
PUBLIC_PORT = "5432"
USERNAME = "postgres"
PASSWORD = "$ENV:POSTGRES_ADMIN_PASSWORD"
DATABASE = "postgres"
```

Add these administrator settings to the deployment config. They are connection
inputs for initialization, not additional service DSNs. Export the
referenced password using your environment's normal secret handling, then run
from the deployment directory:

```bash
scrollsdk setup db-init --non-interactive --json
```

`--clean` resets the Blockscout database; use it only when intending to reset
its data. Running `db-init` is unnecessary when reusing an existing valid
Blockscout database and DSN.

## Frontend and deployment outputs

Bridge History API/fetcher, Chain Monitor, L1 Explorer and Blockbook no longer
have active secret mappings. Old database-dependent Gas Oracle, Rollup Explorer
Backend and Admin System Backend/Cron values are also no longer generated.
Their local files are archived during preparation. Native `fee-oracle` and
`proof-coordinator` remain supported with their own service configuration.
TLS and ingress tests no longer target the retired Bridge History API chart.

`BRIDGE_API_URI`, `BRIDGE_HISTORY_API_HOST`, DeploymentSpec `bridgeApi` /
`bridgeHistoryApi`, and `REACT_APP_BRIDGE_API_URI` have been removed from domain
setup, contracts frontend generation and CLI frontend projection. Existing
frontend env payloads lose the retired API assignment during `prep-charts`.
The unused legacy Scroll withdrawal API helper and already-disabled claim code
have also been removed; `test e2e` is not a Dogecoin bridge withdrawal acceptance
test. Use the DogeOS/proof acceptance workflow for the current protocol.

External L1 explorer links remain useful for viewing Dogecoin transactions:
`EXTERNAL_EXPLORER_URI_L1` is retained. Blockscout and the native withdrawal
processor remain supported.

## Active ingress hosts

The shared template includes both bridge/proof service endpoints:

```toml
[ingress]
BLOCKSCOUT_HOST = "blockscout.example.com"
TSO_HOST = "tso.example.com"
PROOF_COORDINATOR_HOST = "proof-coordinator.example.com"
```

| Host | Generated values / route | Consumer |
| --- | --- | --- |
| `BLOCKSCOUT_HOST` | `blockscout-production.yaml`: frontend `/`, backend `/api`, same hostname | Browser UI and `NEXT_PUBLIC_API_HOST`. |
| `TSO_HOST` | `tso-service-production.yaml`: `/` to service port 3000 | External signer callbacks; signer policy derives `https://<TSO_HOST>`. In-cluster services can still use `http://tso-service:3000`. |
| `PROOF_COORDINATOR_HOST` | `proof-coordinator-production.yaml`: `/` to named `prover` port 7788 | Worker-facing prover API; native proof configuration uses the corresponding public URL. |

`BLOCKSCOUT_BACKEND_HOST` was a dead input: neither the current values generator
nor `prep-charts` used it to select the backend hostname. It is removed. This
configuration supports a single Blockscout hostname with separate path routes.

`ROLLUP_EXPLORER_API_HOST`, `COORDINATOR_API_HOST`,
`ADMIN_SYSTEM_DASHBOARD_HOST` and `L1_EXPLORER_HOST` are removed, including their
prompts, old-spec host/subdomain projections and stale saved fields. The related
admin dashboard and rollup API frontend URLs are removed as well. Old dashboard,
coordinator-api and explorer values are archived during preparation and skipped
by TLS setup. `EXTERNAL_EXPLORER_URI_L1` remains a link to an external Dogecoin
explorer; it does not create a self-hosted L1 Explorer ingress. The active
`proof-coordinator` is separate from the retired `coordinator-api`.

Run `setup domains` to configure these hosts, then `setup prep-charts` to update
values. Non-interactive domain setup preserves explicitly configured TSO and
Proof Coordinator hosts. DeploymentSpec generation derives missing service hosts
from `frontend.baseDomain`, including when an older spec already lists other
hosts; override them with `frontend.hosts.tso` / `proofCoordinator`.

For active proof mode, an explicit `PROOF_COORDINATOR_HOST` opts into generating
and enabling the prover ingress. Merely switching proof mode to active does not
enable ingress without a configured host. If
`proofTopology.deployment.proverPublicUrl` is supplied, its host must match
`PROOF_COORDINATOR_HOST`; a mismatch fails before the compiler runs. Native
proof reconciliation retains existing ingress annotations, ingress class and TLS
secret while updating the primary route. Disabled mode does not newly enable
the ingress and retains existing operator settings.

`setup tls -N --cluster-issuer letsencrypt-prod` handles both services and writes
cert-manager annotations and TLS hosts, using `tso-service-tls` and
`proof-coordinator-tls`. It updates local values; apply the reviewed values through
the normal Helm rollout. DNS and an ingress controller must route these public
hostnames to the cluster. `test ingress` checks TSO at `/health` and Proof Coordinator at `/healthz`.

## Updating an existing deployment directory

1. Build/install the updated CLI (`npm run build` in the CLI checkout) and use
   contract generator/deployer images containing the matching contract changes.
   An already-running prompt uses the old process; exit it and rerun the command.
2. Back up the deployment inputs. Re-run `setup doge-config` to save the current
   RPC/DA configuration and remove retired fields from root config, doge-config
   and setup defaults. Re-run `setup domains` to refresh frontend/domain outputs.
3. Run `setup db-init` only if Blockscout database initialization or permissions changes are
   needed. A config refresh does not require recreating databases.
4. After bridge/service signer inputs are ready, run `setup prep-charts`, then
   `setup gen-secrets`, before selectively uploading Secrets. Declarative deployments can regenerate using
   `setup generate-from-spec --with-values` with their reviewed spec.
5. Review generated changes and follow the environment's rollout procedure.

Secret generation and values preparation move retired local service files to
`.retired-services/backup-*/<original-name>.bak` under the corresponding secrets
or values directory. The archive directory has private permissions. Batch secret
uploads skip retired files, and explicitly selecting one fails. Legacy Geth
values use the separate `.retired-geth` archive described in the Reth guide.
These archives may contain credentials and need the same protection as the source.

These commands do not delete existing PostgreSQL databases, cloud secrets,
Helm releases or live Kubernetes resources. Retiring previously installed
services is a separate environment rollout operation.

## Developing contract generation without Docker

Use an explicit local checkout to test source changes without building an image:

```bash
# Run from the deployment directory containing the prepared config.toml.
scrollsdk setup gen-l2-artifacts \
  --contracts-source /home/qxr/github/dogeos69/scroll-contracts \
  --non-interactive --json \
  --skip-deployment-salt-update --skip-l1-fee-vault-update
```

Install the contracts dependencies and Foundry first; `bash`, `forge`, and `jq`
must be on PATH. The CLI executes that checkout's `docker/scripts/gen-configs.sh`
inside an isolated temporary project. It copies the current source, reuses
compiler artifacts, and reads the deployment directory's `config.toml`; it does
not replace or write to the checkout's existing `volume/`.

The local backend generates the same contract, genesis and frontend artifacts,
then applies normal CLI values-file processing. Final files include root
`config-contracts.toml`, `values/genesis.yaml`, `values/frontends-config.yaml`,
`values/scroll-common-config.yaml` and `values/scroll-common-config-contracts.yaml`
(or the selected `--configs-dir`).
Generation must succeed and produce all three outputs before they are copied
back. Generator logs go to stderr with `--json`; the JSON result reports
`backend: "local"` and `contractsSource` instead of an image tag.

Compiler caches live under `.data/contracts-build/<source-path-hash>/`. They
can be deleted to force recompilation. Concurrent generation against the same
cache is rejected. After an interrupted process, check that no generator is
running before removing the reported stale `.lock` directory.

`--contracts-source` and `--image-tag` are mutually exclusive. Omitting the local
source flag retains the Docker backend. This command only generates artifacts;
it does not deploy transactions. For repeated comparisons, keep the same salt,
account settings and fee recipients; genesis timestamps are intentionally variable.

Local validation on 2026-09-10 ran the source backend twice: approximately
41.6 seconds initially and 2.6 seconds with the compiler cache. Contract and
frontend outputs matched byte-for-byte; genesis matched after excluding its
wall-clock timestamp. The source checkout's `volume/config.toml` stayed unchanged.
Evidence: `/tmp/scrollsdk-local-contracts-e2e-hf9dflud/summary.json`.

After removing the whole root `[rollup]` section, the current source backend was
run again through the real CLI with the 53-field template (48.2 seconds, including
compilation). Contract addresses and genesis matched the deployment audit, and
the source checkout's `volume/config.toml` remained unchanged. Evidence:
`/tmp/rollup-cli-local-rpbvsfzk/summary.json`. The full audit passed 551 CLI tests
(13 existing pending), 7 Foundry tests and 10 contract verification script tests;
it also compared actual L2 deployments to the saved pre-change snapshot.

The 2026-09-11 ingress audit uses the current 50-field template. Both TSO and
Proof Coordinator passed Helm rendering against the sibling SDK charts, including
backend Service names, numeric ports 3000/7788 and TLS hosts. The common chart
requires a numeric ingress port; active Proof Coordinator values also disable its
inherited empty HTTP port and select the native prover port. The full CLI suite
passed 560 tests (13 existing pending). Contract generation and local L2 deployment
remain identical to the saved pre-ingress-cleanup snapshot. Evidence:
`/tmp/contracts-config-audit-hiy673zr/evidence/summary.json`; rendered resources:
`/tmp/contracts-config-audit-hiy673zr/evidence/ingress-render/`.
