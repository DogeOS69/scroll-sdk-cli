# Preparing a fresh instance before Bridge initialization

The environment-owned `scripts/deploy/pre-bridge.mjs` runner in the devnet
deployment repository automates preparation before the existing Shadowfork
Bridge wrapper. It invokes the installed `scrollsdk`; it introduces no direct
dogeos-core source/binary dependency and never fabricates identity/session files.

```text
post-bridge --cleanup (previous instance, explicit authorization)
    → pre-bridge (new gamma TEE identity/session and native genesis)
    → bridge-init-with-shadowfork-mining.sh (Bridge and protocol context)
    → post-bridge (contracts, services, attestors, start-l1-sync, verification)
```

This creates a fresh chain/Bridge **in an already configured environment**, not
AWS/EKS/DNS/TLS/partner infrastructure on an empty machine. Fixed release names
and Secret paths mean it is not side-by-side deployment. Run these sequentially.

## Reusable inputs and prerequisites

Run from the deployment repository root, using the approved installed CLI build.
The checked-in devnet environment already contains these reusable inputs:

- `setup doge-config` and `setup domains`: testnet/Shadowfork RPC, Sepolia DA,
  domain, frontend/ingress settings and chain IDs.
- `signer init`, `setup eth-da-submitter`, `setup fee-oracle`: existing KMS
  signers and archive bucket. The fee oracle genesis whitelist uses its address
  without a private key. Preserve the documented legacy contracts commit-sender
  placeholder compatibility; the actual service uses KMS.
- `setup l2-sequencer-reth`, `setup l2-bootnode-reth`: configured instances 0
  and 1. Existing Reth identities are retained; new genesis and fresh PVCs
  define the fresh chain. No L2 Geth setup is used.
- `setup attestation-signer`: three partner descriptors and matching public
  keys in doge-config/setup defaults. Partner identities are retained; their
  EC2 cutover belongs to post-Bridge deployment.
- [Proof image tools](proof-image-tools.md) and [proof materials](proof-materials.md):
  verified material receipt and referenced files. Reuse matching materials for
  the same approved release. Prepare/verify matching materials separately when
  changing releases; this runner does not certify arbitrary image/material pairs.

Preparation validates these instead of overwriting them with generic defaults.
Missing inputs stop the run with the relevant setup command. Its checks are
deliberately scoped to the devnet profile's cluster/default namespace, domain,
bucket, chain IDs and KMS addresses.

Required tools: Node.js and adjacent built/installed CLI dependencies,
`scrollsdk`, `cs`, Docker, Helm, kubectl and AWS CLI. Log in to CubeSigner
**gamma** first. `cubesigner-refresh --environment gamma` does not switch an
existing management login. The runner checks `cs about`'s exact
`signer_api_root`, without printing login contents.

Review `deployment/post-bridge.json` before starting. Its `contractsTag` must
be `deploy-<full revision>`; preparation derives `gen-configs-<same revision>`.
The verification image must likewise be `verify-<same revision>`. A core or
Reth tag is not a genesis-generator tag. Do not edit the profile during resume.

## Execute

Use real lowercase instance IDs instead of the examples below:

```bash
# Local-only plan, safe before cleanup. Default mode if no mode flag is given.
node scripts/deploy/pre-bridge.mjs \
  --instance devnet-next --previous-instance devnet-previous --plan

# Destructive: only after explicitly approving old-instance replacement.
node scripts/deploy/post-bridge.mjs --instance devnet-previous --cleanup --check
node scripts/deploy/post-bridge.mjs --instance devnet-previous --cleanup --apply

# Read-only inventory/provider checks after cleanup.
node scripts/deploy/pre-bridge.mjs \
  --instance devnet-next --previous-instance devnet-previous --check

# Local generation and NEW gamma role/key/session creation, no service rollout.
node scripts/deploy/pre-bridge.mjs \
  --instance devnet-next --previous-instance devnet-previous --apply
```

`--instance` is required, with the same syntax as post-Bridge IDs.
`--previous-instance` identifies old local outputs and their cleanup receipts;
it never authorizes this runner to delete remote resources. Omit it only for
first preparation in a configured repository with no old Bridge/genesis
outputs. Manual deployments without receipts need a separate ownership audit;
names alone cannot establish ownership.

`--plan` writes nothing and executes no external command; it does not prove
cleanup is complete. `--check` requires completed cleanup and checks inventory,
AWS account, CubeSigner login and Docker without generating outputs or creating
keys. Neither proves mutation permissions, image availability or runtime success.

## What apply changes

1. Check cleanup receipts and frozen old Bridge/genesis hashes. Refuse an
   incomplete Bridge attempt. Move only the explicit old-output allowlist into
   `artifacts/deployment/NEW/pre-bridge/previous-inputs/`, preserving relative
   paths. Snapshot overwritten config/session inputs. Retain reusable proof
   image tools/materials, partner descriptors and unrelated files in place.
2. Clear old `base_funding_utxos` and `seed_string` in setup defaults; the Bridge
   wrapper discovers new funding and supplies the new seed. For replacement,
   set profile `signerSourceRoot` to `/home/ubuntu/dogeos-instances/PREVIOUS`
   for the later cutover. No EC2 service is changed now.
3. Run `scrollsdk setup domains -N --json` using existing domain inputs.
4. Run `setup cubesigner-init --new --role-prefix ... --doge-config
   .data/doge-config.toml -N --json`. Instance hyphens become underscores:
   `devnet-next` produces role `devnet_next_tee0`. Conflicting names stop before
   creating another key. Check saved new key/TEE public-key agreement. Never
   remove/replace policies on old keys or roles.
5. Run `setup cubesigner-refresh --environment gamma --doge-config
   .data/doge-config.toml -N --json`; check the generated session environment.
6. Run `setup gen-l2-artifacts` with the matching contracts tag,
   `--deployment-salt NEW`, `--skip-l1-fee-vault-update`,
   `--skip-l1-plonk-verifier-update`, `--doge-config .data/doge-config.toml`,
   `-N --json`. Validate chain 221122, 10M genesis gas limit, native DOGE
   predeploy and contracts outputs. This generates `values/genesis.yaml`;
   the Bridge CLI later extracts `.data/genesis.json` and builds protocol seed.
7. Create `.data/pre-bridge-NEW.seed` with fresh randomness and mode 0600.
   Write `ready.json` with its path, not the seed/session contents.

Identity/session/genesis contents remain CLI-generated. The explicit environment
edits (funding/seed reset and next signer source path) are recorded in
`archive.json`. No KMS/partner-key rotation, S3/IAM change, Secret push, Helm
installation or acceptance transaction is performed. There is no mock worker.
The post-Bridge runner still applies runtime 10M builder gas, empty blocks,
service versions, fresh PVCs and dev confirmations. Fresh L1 genesis hold stays
intentionally enabled until post-Bridge `start-l1-sync` releases it.

## Handoff to the existing scripts

After successful preparation, run the Bridge wrapper and then post-Bridge:

```bash
# Do not enable shell tracing or print the seed.
SEED="$(<.data/pre-bridge-devnet-next.seed)" \
  scripts/shadowfork/bridge-init-with-shadowfork-mining.sh \
  --image-tag v0.3.0-beta.4f \
  --kube-context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster \
  --log-dir logs/shadowfork/devnet-next \
  --maturity-confirmations 100

node scripts/deploy/post-bridge.mjs --instance devnet-next --plan
node scripts/deploy/post-bridge.mjs --instance devnet-next --check
node scripts/deploy/post-bridge.mjs --instance devnet-next --apply --switch-signers
```

Use the profile's reviewed **coreTag** for Bridge initialization; beta.4f above
is the current environment pin, not the contracts genesis tag. If using
`--profile`, pass the same file to both Node runners. Preparation's `ready.json`
is not evidence that the Bridge exists, services run or acceptance has passed.
See [Post-Bridge instance deployment](post-bridge-instance-deployment.md).

## Checkpoints and failures

`--through archive|domains|cubesigner|session|genesis|handoff` stops at a phase.
Resume successful checkpoints with the same instance, previous-instance and
profile; completed commands are skipped, hashes reject intervening edits.
Preparation shares the repository apply lock with post-Bridge/cleanup. The
Bridge wrapper has a separate persistent fence: never run them concurrently.

Failed/interrupted phases are **not automatically retried**. A lost provider
response can mean a key/session was created; a Docker timeout can leave work
running. Inspect logs and provider/Docker state first. Do not delete checkpoints,
switch IDs to bypass a failure, or recreate keys blindly. Interrupted archives
may be partially moved and need reconciliation. There is no force/reset/adopt
switch. Once Bridge initialization starts, do not rerun preparation.

- Checkpoints, archive/edit inventory and handoff:
  `artifacts/deployment/NEW/pre-bridge/`.
- Private seed/core input: `.data/pre-bridge-NEW.seed`.
- Raw CLI/provider/Docker logs: `logs/deployment/NEW/pre-bridge/` (ignored).

Review config/history before committing. Never copy instance credentials or
acceptance reports into this CLI manual repository.

Run offline regressions from the deployment repository:

```bash
node --test scripts/deploy/*.test.mjs
```

Mocks test order, context binding, gamma checks, archive/provenance guards,
ambiguous creation, successful resume and genesis validation. They do not
constitute a live fresh-deployment test of this wrapper.
