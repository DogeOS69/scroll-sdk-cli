# Prepare a deployment with plan and apply

`setup plan` and `setup apply` orchestrate fresh-deployment preparation. They reuse
the existing setup commands, persist completed steps and stop for external inputs.
They do not install Helm releases or claim that a running chain has passed acceptance.

A complete operator starter is available in the scroll-sdk repository at
`examples/deployment-spec.example.yaml`, with the companion guide
`examples/deployment-spec.md`. It selects testnet production Bridge preparation
and active/real/enforce proofs; it generates real identities from an approved
proof release after the protocol context exists. Apply waits for partner enforcing-policy receipts, verifies them and regenerates
the configuration before the final enforcing check.

## Prepare the private environment file

Start with [deployment.env.example](../src/config/deployment.env.example). The
same operator template is available as `examples/deployment.env.example` in
scroll-sdk. Copy it to your private directory outside either checkout, then edit
the copy before running plan. For example, with an existing `/private` directory:

```bash
install -m 600 /path/to/scroll-sdk-cli/src/config/deployment.env.example /private/deployment.env
```

Every assignment is an intentionally unusable placeholder. Fill the entries
referenced by your selected spec, and remove unused entries. Both shipped spec
examples reference all six base variables below; if a configuration branch is
unused, remove its environment references from the spec as well. Planning resolves
the spec's environment references even when a later step would not use them.

| Variables | Where they are used | What the operator supplies |
| --- | --- | --- |
| `DB_ADMIN_PASSWORD` | `database.admin.password` | Existing PostgreSQL administrator password. |
| `OWNER_ADDRESS` | `accounts.owner.address` | Public Ethereum/L2 owner or multisig address; no private key. |
| `DOGECOIN_EXTERNAL_RPC_USERNAME`, `DOGECOIN_EXTERNAL_RPC_PASSWORD` | `dogecoin.externalRpc` | Credentials for the RPC reached by the operator. |
| `DOGECOIN_CLUSTER_RPC_USERNAME`, `DOGECOIN_CLUSTER_RPC_PASSWORD` | `dogecoin.clusterRpc` | Credentials used by deployed services. |
| `DOGECOIN_SEQUENCER_KEY`, `DOGECOIN_FEE_WALLET_KEY` | Production Bridge `sequencerKeyEnv` / `feeWalletKeyEnv` | Independently provisioned Dogecoin WIF keys matching the declared public keys and network. |
| `SEQUENCER_SIGNING_KEY` | Optional `identities.sequencers[0].signer.privateKeyEnv` import | L2 Reth signer private key, distinct from the Dogecoin sequencer key. Omit for create/KMS. |
| `VASTAI_API_KEY` | `preparation.dstack.vastaiApiKeyEnv` | Vast.ai key string; no separate credential file is needed. |
| `DSTACK_DATABASE_URL` | Optional `preparation.dstack.databaseUrlEnv` | Existing `postgresql+asyncpg` connection URL using `ssl`, not `sslmode`. Omit for SQLite or database initialization. |

Environment variable names are selected by the spec; these are the names used
by the shipped examples and this guide. Add an entry for every custom reference.
Adding a variable alone does not select an import operation or override a spec
field: the spec must explicitly reference it. Keep each value on one line, place
comments on separate lines, and do not use shell substitutions. AWS credentials
use the normal provider chain; GCP credential files, partner descriptors
and Bridge funding outpoints use their separately declared files.

## Commands

```bash
scrollsdk setup plan --spec ./deployment-spec.yaml \
  --output /private/deployment --sdk-dir /path/to/scroll-sdk \
  --env-file /private/deployment.env
scrollsdk setup apply --dir /private/deployment
```

`--env-file` is optional. It is parsed as `NAME=value` data, never sourced as a
shell script. Existing process environment variables take precedence. The file
reference is retained for subsequent apply invocations. Keep it private and
available when applying. Planning resolves spec environment references into a
private intent snapshot; wallet import references still identify environment
variable names resolved at execution time.

With all inputs available, these are two commands. External funding and partner
handoffs can require additional invocations of the same `apply` command. No
underlying setup command is required during normal execution. Starting with no
funding normally means four invocations: one `plan`, then three `apply` calls
(initial wallet wait, final Bridge wait, completion). If the independently known
wallet addresses are funded and their outpoints are supplied before the first
apply, this becomes one `plan` and two `apply` calls.

Planning validates the spec and pinned SDK templates, writes the private plan,
and lists local, read-only, cloud and chain steps. It does not provision resources
or send transactions. Applying is authorization to execute the operations listed
in that saved plan, including expressly selected cloud provisioning and test-helper
broadcasts. Production Bridge mode delegates payments to the operator's wallet;
the CLI verifies those payments without signing or broadcasting funding transactions.

The output directory must be empty. Keep it outside a source checkout. Plans,
resolved intent, state and logs live under `.scrollsdk/`; these may contain
credentials and must not be published. The workflow writes ignore rules and uses
private directory/file permissions. The terminal/JSON summary excludes credentials.

## Additional spec intent

The existing `identities`, `proofTopology`, image pins and service configuration
remain required. `templates` is optional: plan locks the committed HEAD of
`--sdk-dir`; `templates.sdkRevision` is an explicit full-commit override. Apply
uses that frozen revision even after the checkout changes. Add `preparation`, with explicit operations and
external file references. Paths are relative to the deployment directory unless
absolute; they are not relative to the source spec. Descriptor and material files
may arrive after planning. User-supplied artifacts are inputs, not generated facts.

A production Bridge example (replace public-key placeholders before planning):

```yaml
preparation:
  attestationDescriptors:
    - /private/partner-a/descriptor.json
  bridge:
    mode: production
    image: dogeos69/bridge-genesis-tools@sha256:27e646fd5d9c340926df82f47f7d352fd5333de4e6178c5a8c56aa9637769262
    fundingFile: .scrollsdk/inputs/bridge-funding.json
    production:
      sequencerPublicKey: REPLACE_WITH_COMPRESSED_DOGECOIN_SEQUENCER_PUBKEY
      sequencerKeyEnv: DOGECOIN_SEQUENCER_KEY
      feeWalletPublicKey: REPLACE_WITH_COMPRESSED_FEE_WALLET_PUBKEY
      feeWalletKeyEnv: DOGECOIN_FEE_WALLET_KEY
      recoveryPublicKeys:
        - REPLACE_WITH_FIRST_RECOVERY_PUBLIC_KEY
        - REPLACE_WITH_SECOND_RECOVERY_PUBLIC_KEY
      ethereumAnchor:
        blockTag: finalized
  proofMaterials:
    mode: existing
    receipt: .data/proof-materials-v1.json
```

The image digest above was pulled as `v0.3.0-beta.6` during local verification.
Select and review the intended release for your environment. Select
`signing.cubesigner.identity: {roleId: ...}` (plus `keyId` for multi-key roles);
plan uses the authenticated `cs` CLI to query membership and normalize/freeze the
TEE public key. An explicit `bridge.teePubkey` remains supported. The recovery
threshold and future block-height `bridge.timelock` must also be explicit. Attestation public keys and their order come from the imported
partner descriptors and selected initial keyset. Recovery and TEE keys are never
derived from `bridge.seedString` in production mode. Omit that test-helper field
from a production spec; production output contains no helper funding placeholders.

The two Dogecoin wallet identities are distinct from the L2 Reth signer and the
Ethereum DA/fee-oracle identities. This production adapter currently imports
independently managed local Dogecoin wallet keys through the named environment
variables; it verifies that each key matches its declared compressed public key.
It does not provision a WP Dogecoin KMS signer. Runtime Secret generation resolves
those private references; the public construction manifest retains references.

## Production funding and resume

The beta.6 production order is defined in
[core's pinned production guide](https://github.com/DogeOS69/dogeos-core/blob/56007d3c413ad07f33d0e08b272004089c911f78/docs/bridge-genesis-deployment.md).
The workflow:

1. Prepares service identities, descriptors, actual L2 genesis and protocol seed.
2. Checks the Ethereum RPC chain ID, selects the finalized DA boundary once
   (transaction index 0), and persists its exact height/hash. Explicit historical
   block/index overrides remain available; an unavailable finalized tag never
   falls back to latest. Resumes reuse the saved boundary.
3. Displays the independently managed sequencer and fee-wallet addresses and
   required amounts. The genesis sequencer output must be exactly **42,069,000
   satoshis (0.42069 DOGE)**. Fund them using the deployment wallet.
4. Reads the operator's outpoints, checks the live unspent outputs, raw transaction
   IDs, exact scripts, amounts, confirmation depth and active-chain block anchors.
5. Runs the core namespace and bridge-artifact tools against that verified
   sequencer outpoint. No placeholder namespace is presented as a funding target.
6. Displays the final Bridge address and the required funding marker. Waits for
   a confirmed marked funding output, verifies it, then generates the canonical
   protocol context and continues service/proof configuration.

The default funding input is `.scrollsdk/inputs/bridge-funding.json`; omit
`fundingFile` unless a custom location is needed. No file is required at plan
time. Apply creates it at the funding wait and prints both wallet addresses,
amounts and a JSON template. Fill only real outpoints, then rerun `apply`:

```json
{
  "sequencer": {"txid": "REPLACE_WITH_SEQUENCER_FUNDING_TXID", "vout": 0},
  "feeWallet": {"txid": "REPLACE_WITH_FEE_WALLET_FUNDING_TXID", "vout": 1}
}
```

After the final Bridge address has been generated, add a `bridge` entry with its
funding `txid` and `vout`. The CLI obtains amounts, raw transactions and block
facts from the RPC; users do not hand-edit generated TOML. The RPC must support
`gettxout`, historical `getrawtransaction`, `getblockheader` and `getblockhash`.
Use an appropriately indexed Dogecoin node.

Bridge funding must contain exactly one zero-value OP_RETURN output with the
recommended core marker: script `6a4901` followed by 72 zero bytes. The pause
report includes the full script. An ordinary payment to the Bridge address or a
deposit transaction is not accepted as initial Bridge inventory. This adapter
requires the recommended marker rather than accepting arbitrary WF-shaped
payloads. It also rechecks the sequencer anchor, fee-wallet funding and future recovery
timelock before accepting Bridge funding.

No automatic wallet scan or wallet signing/broadcast is performed in production
mode. The external wallet constructs and sends the payments. Confirmation waits
return a resumable result instead of holding an interactive prompt open.

## Test-helper compatibility

Choose `preparation.bridge.mode: helper` only for testnet/regtest experiments.
Mainnet network/environment selection rejects this mode. The existing
`generate_test_keys` helper still requires funding its seed-derived P2PKH helper
address, followed by configured `base_funding_utxos`; beta.6 does not remove that
requirement. It is explicitly described as test scaffolding in core.

Supply `helper: [{"txid": "...", "vout": 0}]` in the same funding input file.
The adapter validates the UTXOs and writes `[[base_funding_utxos]]` into
`.data/setup_defaults.toml`, including the verified amount and raw transaction.
It then invokes the existing setup/fund phases. The seed is passed through a
private environment variable, not a command-line argument.

These helper phases broadcast transactions and cannot safely be replayed after
an ambiguous failure. Such a failure returns `recovery-required`; further apply
invocations do not send another transaction. Inspect on-chain results and partial
artifacts before performing an explicit recovery outside the normal fresh-flow
interface. There is deliberately no force-retry switch for broadcasts.

## Optional preparation operations

| Spec field | Effect |
| --- | --- |
| `archive.action: configure/create` | Reconcile archive configuration/writer permissions; create permits bucket creation. Optional `awsProfile` and `writerRoleArn`. |
| `proofAws.action: create` | Provision/reconcile the declared proof store, workload roles and token Secret; generate `.data/proof-aws.json`. Explicit `publicReadMode` selects delivery policy. Role ARNs are generated, not hand-entered. |
| `proofAws.action: reuse` | Query existing resources only, verify account/region/EKS trust/current Secret metadata, and generate the same resource record. Use `existing-public-s3` or `existing-gateway`. Optional `coordinatorRoleName`, `withdrawalRoleName`, `secretName` select existing resources; otherwise names derive from alias/cluster. Permissions and external reachability are still checked by publication. |
| `proofMaterials.mode: mock` | Invoke the material tool using the topology compiler pin and explicit `mockWorkerImage`, then derive topology identities from the receipt. |
| `proofRelease` | Select a version. Plan downloads the official manifest/checksum and freezes compiler/Worker pins; apply runs the context-bound producer, exports materializers and checks the CUDA image before importing real materials. |
| `proofMaterials.mode: real` | With `proofRelease`, consume the generated receipts and materializers. Without it, import explicitly supplied `preparationReceipt`, materializers and Worker receipt. |
| `proofMaterials.mode: existing` | Consume the specified receipt; without a receipt, consume the explicitly staged compiler identity and existing topology. Production acceptance still depends on final proof checks. |
| `proofPublication` | Publish the manifest selected by `release` and `releaseSha256`, then reconcile values again with the publication receipt. Uses proof AWS resource facts. An empty object selects publication from `proofRelease`; an explicit release/hash pair remains supported. |
| `dstack.mode: import` | Import the selected `providers` and credential file/environment references; optional project/GCP project; does not rent GPUs. |
| `dstack.mode: external` | Use externally managed controller credential Secrets; does not import provider credentials. |
| `dstack.databaseUrlEnv` | Import an existing PostgreSQL asyncpg URL through an environment variable; mutually exclusive with `initializeDatabase`. |
| `dstack.initializeDatabase` | Initialize dstack on the existing PostgreSQL server; does not create a cloud database service. |
| `databases: [blockscout]` | Initialize Blockscout on the configured existing PostgreSQL server. |
| `inputs` | Import explicitly declared external runtime files as `source`/`destination` pairs; cannot replace managed Bridge or deployment state. |
| `secretUpload` | Upload generated Secrets using the selected existing provider; AWS region is required (or inherited from infrastructure); dstack upload requires an explicit Kubernetes context. |

For example, enabling dstack in the spec also requires declaring its preparation
mode. For an imported Vast.ai credential:

```yaml
preparation:
  # ...bridge, descriptors and proof inputs as above...
  dstack:
    mode: import
    providers: [vastai]
    vastaiApiKeyEnv: VASTAI_API_KEY
    initializeDatabase: true
```

PostgreSQL mode requires either `initializeDatabase: true` or `databaseUrlEnv`.
SQLite mode needs neither. External credential mode still requires an actionable
database configuration; it only delegates controller credentials to existing Secrets.

Receipt-derived topology currently requires an S3 proof artifact store. For a
local-filesystem proof store, supply an existing explicit topology and compiler
identity without a material receipt.

Real proof baking is performed by apply using the selected producer image.
CubeSigner account/session authorization and partner Phase A remain owner
operations. Apply waits for external inputs instead of inventing facts. The workflow does not create an
EKS cluster, rent GPU capacity or install releases.

## State and outcomes

JSON output returns `status`, `currentStep`, `completed` and optional `waiting`
instructions. Exit codes: `0` prepared, `2` waiting for external input, `1` failed
or requiring reconciliation. A successfully printed JSON result with
`status: waiting` is not a completed deployment.

Each completed step and the managed artifact hashes are saved before proceeding.
Reruns preserve completed identities and artifacts. An apply lock excludes
concurrent execution. Unexpected edits to recorded artifacts stop the run;
external funding inputs remain editable under `.scrollsdk/inputs/`. Do not edit
generated TOML to bypass the state checks.

The initial interface is for fresh deployments. Saved plans are immutable: the
same spec can be planned again, but a changed spec requires a new deployment
directory. It does not implement in-place upgrades, key rotation or destructive
migration. After an abrupt process termination, inspect the lock's host/PID and
any child/provider activity before removing a stale lock; interrupted broadcasts
remain blocked regardless. Runtime deployment acceptance remains a separate step.

## Container integration verification

The integration driver uses a mock/observe test spec, a public partner descriptor
and the matching public compiler identity as fixture inputs. It replaces wallet
identities with disposable keys and uses a local synthetic Dogecoin/Ethereum RPC;
it never broadcasts or provisions cloud resources. Use fixtures for the pinned
SDK/core versions and SQLite dstack configuration, not a live deployment spec.

```bash
npm run build
node scripts/test-preparation-e2e.mjs /path/to/scroll-sdk \
  /private/test-spec.yaml /private/partner-descriptor.json \
  /private/compiler-identity.json
```

It runs real rc.4 genesis and beta.6 Bridge/compiler containers, verifies both
funding pauses, resumes to `prepared`, then reruns to verify completion is stable.
Private generated files and child logs remain in the reported temporary directory;
only sanitized step outcomes and RPC method names are printed. Docker must be
available. This verifies orchestration and artifact compatibility, not real chain
confirmation, AWS permissions, real proofs or cluster deployment acceptance.

## Generated proof identities and external completion evidence

The SDK starter uses `preparation.proofRelease: {version: v0.3.0-beta.6}` plus
`proofMaterials: {mode: real}`. Plan obtains the manifest and checksum from the official core GitHub release and
pins all five proof images. Missing releases/assets fail before resource changes;
the release owner must publish them. The operator does not locate or compute a
digest. Optional `GH_TOKEN` / `GITHUB_TOKEN` supports private GitHub access.
For an offline approved release, use `{manifest, sha256}` instead of `version`. Apply generates `.data/proof-release-preparation/` from the
canonical protocol context, including `bridge/worker-identity-bundle.json`;
exports the coordinator materializers; checks the production CUDA image; and
imports `.data/proof-materials-v1.json`. Operators do not invent identity hashes
or copy a generic compiler identity from another deployment. Image/receipt
mismatches fail validation. These image checks do not execute a GPU proof.

For enforce, apply exports the signer policy and pauses at `signer-receipts`.
`.scrollsdk/inputs/signer-receipts/request.json` identifies each active signer and
its numbered receipt filename. Send `signer-policy-bundle/` to each partner and
save their returned validation receipts at those paths. Rerun `setup apply`.
It computes hashes, checks all active signer identities, bundle/revision/policy
bindings and successful validation, imports the accepted bytes into managed
state, regenerates charts with the publication receipt and runs the final check.
Missing evidence produces `waiting`; mismatched evidence produces `failed` and
may be corrected in the inbox before retrying. Completed cloud and proof steps
are preserved. See `docs/proof-config-transactions.md` for receipt semantics.
Synthetic receipt tests are not evidence of real partner acceptance.

## Real release consumer verification

Once the core release workflow has published all five images and the manifest,
run this separate rehearsal with a canonical public protocol-context fixture:

```bash
npm run build
node scripts/test-proof-release-e2e.mjs v0.3.0-beta.6-proofexp.20261009.1 \
  /path/to/dogeos-core/crates/dogeos_protocol/test-data/protocol-context-corpus/valid-canonical.json \
  /path/to/scroll-sdk
```

It creates a private temporary deployment, resolves the actual release by version,
bakes real Bridge identities with the producer, exports release materializers,
checks the CUDA image, imports real materials and compiles the active/real/enforce
topology. The output directory contains private step logs and `validation.json`
only after success. Docker needs enough free image storage. `DOCKER_HOST` may
select a dedicated test daemon; its bind mounts must see the temporary paths.
This rehearsal does not publish S3 objects, run a GPU proof or validate a partner's
runtime policy. A queued/running core build is not a passing rehearsal result.
