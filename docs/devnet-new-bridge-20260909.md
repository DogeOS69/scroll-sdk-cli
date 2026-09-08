# New Bridge / native Reth genesis: verified devnet checkpoint

This records the user-authorized **new instance**, created on 2026-09-09 JST.
It supersedes the 2026-09-08 instance; it is not an in-place genesis upgrade.
Steps through configuration and offline Reth initialization are verified.
Cluster rollout and end-to-end acceptance remain blocked by core #1139.

## Identity and release pins

| Setting | New instance |
| --- | --- |
| Bridge P2SH address | `2NDLYMxd7SH4U94k3HfgmQtgBZE3FAPJe4H` |
| Protocol ID | `b7e9425fda9ad99b782a10b5575521bca67f4842da4923f00d690a8a5947beaa` |
| L2 chain ID | `221122` |
| Domain | `devnet.doge.xyz` |
| Dogecoin chain / Ethereum DA | Shadowfork `111111` / Sepolia `11155111` |
| Virtual L1 genesis height | `62638951` |
| Reth chainspec scan start | `0` (not the virtual L1 genesis height) |
| Core / Bridge tools | `v0.3.0-beta.3e` |
| Reth | `dogeos69/rollup-node:v0.3.0-beta.1c` |
| Frontend | `dogeos69/scroll-sdk-frontends:0.3.0-rc3` |

All contracts images use `dogeos69/scroll-stack-contracts`:

| Purpose | Tag | Multi-platform digest |
| --- | --- | --- |
| Generate | `gen-configs-56a4cacda6046c9445af023aefee15a42fda2fdd` | `sha256:8e98ace73abc6df0a4fb54c8b8ceaca57c64ab7e2a6d62d1097709c84627e9ec` |
| Deploy | `deploy-56a4cacda6046c9445af023aefee15a42fda2fdd` | `sha256:6f4e8534fa6652947c0a22086c156eb8a5cc088f23fc78d2958ebd7f2a34e4ab` |
| Verify | `verify-56a4cacda6046c9445af023aefee15a42fda2fdd` | `sha256:46d99fe6ae9c76b7155c7cc6678d355e06d9ffb041d8f1bda0d6e0db2b085ba6` |

The real DA submitter remains KMS address
`0x809cb1378Cb2775816dD14d1a3754a536b066889`; fee-oracle remains KMS address
`0xbEEC0A88c46ad59AA82aA0208F914a1ba6b83e5c`. Do not substitute the public
legacy contracts placeholder for either runtime identity. The fee-vault
Dogecoin recipient remains `nqsFQaPawarYiFrtaAcjKoxwwEmYWaFNoQ`.

## 1. Preserve the previous instance before generating anything

The deployment directory is
`/mnt/wsl/data/github/dogeos69/dogeos-aws-devnet`; CLI is this repository's
`bin/run.js`. Work uses the cumulative fixes based on the user-approved local
`v0.3.0` lineage, not a fresh checkout of an older remote branch.

The private archive is
`/mnt/wsl/data/github/dogeos69/dogeos-devnet-archive-20260909.l4CZxA` (0700).
`deployment-before-new-bridge.tar.gz` (0600) preserves the complete deployment
directory excluding `.git`. It contains private keys and must not be committed.
The old Bridge is `2N5zeJqHrdQ8WRGDsNxoQFCGuYmUCmpqn3i`, protocol ID
`a8fe85fd94fcdbca397d58a9d3dc9f8ce61a93901dd53ac3c0db792689ba7c47`.
Its chain transactions, cloud Secrets, PVC and EC2 services were not deleted.

Before an equivalent reset, create a restrictive `mktemp -d` archive, snapshot
the deployment directory, and prepare an isolated ordinary staging directory
(not a Git worktree). Copy the approved root config and canonical doge-config,
but not the old protocol context, Bridge outputs, replay databases or generated
proof bundles. Reusing infrastructure/KMS/node keys is deliberate in this reset;
the Bridge seed, funding input, setup transaction and protocol identity are new.

## 2. Generate and freeze the new genesis

In the isolated generation directory, after configuring KMS, domain, Reth and
fee-vault inputs as described in the deployment status/linked guides:

```bash
umask 077
export DOGEOS_CLI=/mnt/wsl/data/github/dogeos69/scroll-sdk-cli/bin/run.js
export DOGEOS_KUBE_CONTEXT=arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster
"$DOGEOS_CLI" setup gen-l2-artifacts \
  --image-tag gen-configs-56a4cacda6046c9445af023aefee15a42fda2fdd \
  --doge-config .data/doge-config.toml \
  --skip-deployment-salt-update --skip-l1-fee-vault-update \
  --skip-l1-plonk-verifier-update --configs-dir values -N --json
```

The skip flags preserve this deployment's already reviewed salt and fee-vault
inputs; they are not substitutes for configuring them on a wholly empty project.
The command generates root public/contract config plus values/genesis.yaml,
frontend/common config, and legacy coordinator YAML. coordinator-cron-config.yaml
is not a selected runtime input; do not install coordinator-cron.

Compared with the archived genesis, all nine alloc accounts and deterministic
contract predictions are unchanged. Header/timestamp and schema changes mean
the genesis block and batch hashes **are different**. The image enables Tsuki
at zero, emits native Reth fields and empty extraData, and omits legacy
config.systemContract metadata. Its tests deliberately require startL1Block=0
even when L1_CONTRACT_DEPLOYMENT_BLOCK is nonzero.

Frozen values/genesis.yaml SHA-256:
`ef936991667e3010fd081ede6235c109257c7a36077e46738996a435aa86edc8`.

Do not regenerate after the following Bridge setup: generation uses a timestamp,
so rerunning the same image/config is not guaranteed to reproduce the same hash.

## 3. Prepare fresh Bridge funding and execute the five CLI steps

The actual Bridge work directory was `<archive>/new-instance`, copied from the
successful candidate generation. Copy the reviewed setup_defaults.toml there,
replace seed_string with a cryptographically random 32-byte hex seed, and clear
old base_funding_utxos before selecting a fresh funding input. Do not print the
seed or retain private success JSON in public logs. Step 1 was called with that
seed passed directly from the private config by a Node child-process wrapper.

Commands executed individually, with exit status checked before proceeding:

```bash
"$DOGEOS_CLI" setup bridge-init --step 1-prepare \
  --seed "$DOGEOS_NEW_BRIDGE_SEED" --kube-context "$DOGEOS_KUBE_CONTEXT" \
  --image-tag v0.3.0-beta.3e --docker-platform linux/amd64 -N --json
# STOP here until a fresh, mature, confirmed helper UTXO is configured.
"$DOGEOS_CLI" setup bridge-init --step 2-setup \
  --kube-context "$DOGEOS_KUBE_CONTEXT" --image-tag v0.3.0-beta.3e \
  --docker-platform linux/amd64 -N --json
"$DOGEOS_CLI" setup bridge-init --step 3-bridge-info \
  --kube-context "$DOGEOS_KUBE_CONTEXT" --image-tag v0.3.0-beta.3e \
  --docker-platform linux/amd64 -N --json
"$DOGEOS_CLI" setup bridge-init --step 4-fund \
  --kube-context "$DOGEOS_KUBE_CONTEXT" --image-tag v0.3.0-beta.3e \
  --docker-platform linux/amd64 -N --json
"$DOGEOS_CLI" setup bridge-init --step 5-protocol-context \
  --kube-context "$DOGEOS_KUBE_CONTEXT" --image-tag v0.3.0-beta.3e \
  --docker-platform linux/amd64 -N --json
```

`DOGEOS_NEW_BRIDGE_SEED` above denotes the private prepared seed, not a literal
example value. Never run these non-idempotent steps as a blind retry loop.

For the shadowfork helper, core derives the private scalar as SHA-256 of the
UTF-8 seed string and uses the **compressed** secp256k1 public key; encode its
hash160 as Dogecoin testnet P2PKH, version 0x71. The successful helper was
`nqwcSx6Jb7ptRAr5AjWazstSLcfNTv6CwS`. Mine a block to that address using the
project's documented shadowfork `/mine` request, inspect its coinbase via
getblock/getrawtransaction/gettxout, and wait for this shadowfork's required
coinbase maturity. Configure the verified txid/vout/amount_sats in
setup_defaults.toml base_funding_utxos. Do not copy this spent input for a retry:
`7bcf74603ecb082d92c9492a4c232ac26293dbed55dd66a5fee7e79a0f3593d4:0`,
1,000,000,000,000 satoshis. The private operations wrapper and full logs remain
in the archive; no private seed is included in this manual.

Recorded operator error: the first temporary helper script used an uncompressed
bitcore public key and mined to `nj96wGPAjgX3Lo3gNJujpfVkQmSan9nirF`.
Step 2 failed while signing, before broadcast. The unused coinbase
`c811a3091d9861994a150a1b6ee97db67bdc9feb6b26d8179bea6229fcc33b09:0`
remains recoverable from the archived seed. This was an operator-script error,
not a core/CLI defect. Correcting the compression and supplying a new confirmed
UTXO resolved it; the failed partial GenerateBridgeInfo.toml was archived.

Successful setup transaction:
`05065e3b9950481c3bdbe12a8a0c0182f24b422f7df96076cc77f59dbada017f:0`,
confirmed at height `62638953`, block
`a627fa108a823556c74846d766cd91bf37810209e2aa66a366f5072568b65105`.
Step 4 generated ten deposit-seed transactions of 5 DOGE each (50 DOGE total),
recorded in .data/output-test-data.json. An independent read-only RPC audit
found 74 confirmations for setup and 63 for every deposit. Do not fund again.

## 4. Adopt the complete identity, regenerate, and isolate cloud paths

Copy the successful generated files as a set into the deployment root:
root public/contract config, genesis/frontend/common/protocol values, all new
.data Bridge/context/seed/doge-config outputs, and the WP secret output.
Preserve private modes. This run used explicit patches, not a Git reset.
Old .data/generated, .data/signer-policy-bundle and proof-deployment.json were
moved into the archive before regeneration.

Recorded manual changes:

- values/contracts-production.yaml image.tag → the deploy-56a4cac tag above.
- Remove the old Geth genesis-normalizer values/script arguments from every
  Reth install recipe and required-values list in Makefile. Native genesis is
  mounted directly. Do not change its scan start to 62638951.
- In canonical doge-config, Ethereum DA archive keyPrefix and proof_topology
  deployment.artifactKeyPrefix → `devnet-20260908/instance-20260909`.
  Set .data/proof-aws.json artifactStore.keyPrefix to the same subdirectory.
  It stays inside the already authorized prefix; no bucket/IAM policy change.
- Set workerId/coordinatorId to the `dogeos-devnet-20260909-*` names. Retain
  existing IAM role names, proof-token resource ownership and KMS bindings:
  dates in those infrastructure names do not define protocol identity.
- Use new service Secret prefix `dogeos/devnet-20260909`. No old remote Secret
  is overwritten. Proof bearer tokens remain separately proof-aws-managed;
  do not merge them into WP's private service-key Secret.

Run from the deployment root, checking each result:

```bash
"$DOGEOS_CLI" setup prep-charts --doge-config .data/doge-config.toml \
  --skip-auth-check --skip-l2-contract-deployment-block -N --json
"$DOGEOS_CLI" setup gen-secrets --doge-config .data/doge-config.toml -N --json
"$DOGEOS_CLI" setup export-signer-policy --config .data/doge-config.toml \
  --out .data/signer-policy-bundle --json
```

After the final generation, selectively upload each required secret:

```bash
"$DOGEOS_CLI" setup push-secrets \
  --secret-file "secrets/${DOGEOS_SERVICE}-secret.env" \
  --values-file "values/${DOGEOS_VALUES}.yaml" \
  --aws-region us-east-1 --aws-prefix dogeos/devnet-20260909 -N --json
"$DOGEOS_CLI" setup proof-config-check --json
```

The service/values pairs are contracts/contracts-production,
l1-interface/l1-interface-production, metrics-exporter/metrics-exporter-production,
withdrawal-processor/withdrawal-processor-production, and both indices 0/1 for
l2-reth-sequencer and l2-reth-bootnode (values names put `production` before the
index). Do not upload unrelated legacy secrets. Later prep-charts runs can
reconstruct Reth remote references; reconcile uploads/references again afterward.
All eight uploads succeeded. The new prefix was confirmed empty before upload;
the final proof-config-check passed after upload with generation ID
`66441ad7cbf1754603ffc5fba2e852de0237a3e5de4004ddf15c6f87eba1ecbd` and bundle
revision `dd5e3403ca6874efe3014762458d8b4c4850c9a0638dcff6d4565c1f2e2710c8`.

Proof posture remains the reviewed `disabled / mock / observe`, not active real
proof. Mock-only synthetic verifier material must never be advertised as real
proof readiness. Regenerated signer/worker bundles must replace old bundles only
when the matching new services are ready; no EC2 handoff has been performed yet.

## 5. Validate the actual Reth image offline

Executed with no network and only disposable in-memory database storage:

```bash
docker run --rm --network none --read-only \
  --tmpfs /data:rw,size=512m --tmpfs /tmp:rw,size=64m \
  --mount type=bind,src=/mnt/wsl/data/github/dogeos69/dogeos-aws-devnet/.data/genesis.json,dst=/genesis.json,readonly \
  dogeos69/rollup-node:v0.3.0-beta.1c init --chain /genesis.json --datadir /data
```

Exit 0. Reth wrote genesis hash
`0x4c315c169df5fa7ef747c5a79c956fd291dbbb804e92d0fc42a563c022f8ba58`,
matching bridge-genesis-tools/protocol context. State root:
`0xa15e96da98b4480d02a41d03d7ab19e17ea106a1f9cd9643a8f484d0862af38d`.
Batch hash:
`0x10c26f3eeba8f5c5cf2f70b06754103817edb4185f3aeae7cbad38bfa239e399`.
This checks actual genesis parsing/initialization, not network operation.

CLI gen-rpc-package now accepts native Reth metadata and preserves its scan
height without requiring retired l2-rpc-production.yaml for genesis extraction.
Legacy Geth conversion retains its strict address/height conflict checks. Eleven
targeted tests, TypeScript build and targeted lint passed; the actual new genesis
also compares deeply equal before and after the updated normalizer.

The published l2-reth chart 0.1.4 also rendered successfully with the new
sequencer values. Its chain path is /app/genesis/genesis.json, mounted directly
from genesis-config, with no old normalizer init container and with the new
service Secret path. `make check-install-all-values` and the Reth recipe dry-run
passed. These are local rendering checks, not a server-side or runtime rollout.

The new deploy-56a4cac image separately passed its actual Forge simulation:

```text
forge script scripts/deterministic/DeployScroll.s.sol:DeployScroll \
  --sig 'run(string,string)' None verify-config
```

The Docker invocation used `--network none`, `--entrypoint forge`, read-only
mounts of config.public.toml as /contracts/volume/config.toml and
config-contracts.toml at the corresponding volume path, FOUNDRY_EVM_VERSION=cancun,
and FOUNDRY_BYTECODE_HASH=none. Only DEPLOYER_PRIVATE_KEY was passed by environment
name from the private contracts Secret; no legacy service keys or fee-oracle
private key were supplied. Exit 0, no broadcast. The deploy image's default
entrypoint DOES broadcast L2 transactions; do not use it for this offline check.

## Resume boundary — not yet a running new instance

The cluster still contains the **old** scroll-common/l1-interface deployment.
Do not apply only new genesis or only a new protocol context to its existing
database/PVC. No new-instance Helm rollout, L2 contract broadcast, EC2 replacement
or DNS/TLS/end-to-end acceptance has occurred.

Core #1139 is not fixed in v0.3.0-beta.4 (nor beta.4a): the tagged L1 Interface
source still rejects a missing replay SQLite file before service initialization.
Wait for a corrected approved image, then perform a coordinated instance switch
with fresh instance-specific storage and preserve the old storage. Initialization
belongs inside l1_interface; do not add a mandatory external initializer, create
an empty SQLite file, disable replay validation, or import another protocol DB.
Blockscout remains deferred without RDS administrator credentials.

**For this already-created new Bridge, resume at runtime rollout preparation —
never repeat genesis generation, Bridge setup or deposit funding.**
