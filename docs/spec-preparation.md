# Prepare a deployment with plan and apply

`setup plan` and `setup apply` orchestrate fresh-deployment preparation. They reuse
the existing setup commands, persist completed steps and stop for external inputs.
They do not install Helm releases or claim that a running chain has passed acceptance.

After preparation, install the frontend and monitoring releases from the generated
directory with `make install-frontends` and `make install-scroll-monitor`, passing
explicit `KUBE_CONTEXT` and `NAMESPACE`. Monitoring belongs early in the Helm
deployment sequence because it supplies Prometheus Operator CRDs. The `secrets`
step initializes the bundled Grafana admin credentials once and preserves them on
resume. `secrets/grafana-admin.env` is uploaded by `setup push-secrets` to AWS
Secrets Manager or Vault, like Dogecoin RPC credentials. The monitor chart's
ExternalSecret synchronizes the referenced Kubernetes Secret; do not upload a
standalone Grafana admin YAML.
See the SDK's `examples/deployment-spec.md` for the two releases' values and
verification. Do not rerun `install-all` to add missing releases after contracts
have already been deployed.

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
| `DOGECOIN_FEE_WALLET_KEY` | Production Bridge, fixed environment variable | Compressed Dogecoin WIF for the selected network; apply derives the public key/address. Fee-wallet KMS is not supported by beta.6-kms. |
| `DOGECOIN_SEQUENCER_KEY` | Optional local Bridge `sequencerKeyEnv` | Omit when selecting `sequencerKms`; local mode requires the matching `sequencerPublicKey`. |
| `SEQUENCER_SIGNING_KEY` | Optional `identities.sequencers[0].signer.privateKeyEnv` import | L2 Reth signer private key, distinct from the Dogecoin sequencer key. Omit for create/KMS. |
| `VASTAI_API_KEY` | `preparation.dstack.vastaiApiKeyEnv` | Vast.ai key string; no separate credential file is needed. |
| `DSTACK_DATABASE_URL` | Optional `preparation.dstack.databaseUrlEnv` | Existing `postgresql+asyncpg` connection URL using `ssl`, not `sslmode`. Omit for SQLite or database initialization. |

Environment variable names are selected by the spec; these are the names used
by the shipped examples and this guide. Add an entry for every custom reference.
Adding a variable alone does not select an import operation or override a spec
field: the spec must explicitly reference it. Keep each value on one line, place
comments on separate lines, and do not use shell substitutions. AWS credentials
use the normal provider chain; GCP credential files
and Bridge funding outpoints use their separately declared files.

## Commands

The complete bridge-operator sequence (inputs, funding, external Secrets,
installation order, partner handoff, GPU startup and runtime acceptance) is in
[`scroll-sdk/examples/bridge-operator-deployment.md`](https://github.com/DogeOS69/scroll-sdk/blob/feat/spec-preparation-examples/examples/bridge-operator-deployment.md).
`plan` / `apply` are preparation entrypoints; they do not replace Helm installation
or automatically rent a GPU.


```bash
# From the private working directory containing the edited inputs:
scrollsdk setup plan
scrollsdk setup apply
```

| Path | Convention | Optional override |
| --- | --- | --- |
| Spec | `./deployment-spec.yaml` | `plan --spec <file>` |
| Private environment | `./deployment.env` when present | `plan --env-file <file>` |
| SDK checkout | `../scroll-sdk` | `plan --sdk-dir <directory>` |
| Output | `./deployment/` | `plan --output <directory>` |
| Plan to apply | `./deployment/` | `apply --dir <directory>` (alias `--deployment-dir`) |

Paths are relative to the working directory; keep running plan/apply there.
A custom plan output requires the matching apply override. Plan prints that command.
The lower-level `generate-from-spec` command uses the same spec and environment
conventions, writes to `.` by default, and uses `../scroll-sdk` for `--bootstrap`.
It does not search `.env` or `.env.local`; select another filename explicitly.
After entering the generated deployment or its runtime copy, `proof-worker`,
`proof-config-check` and `monitoring-secrets` use `.` for `--deployment-dir`.
Monitoring reuses the plan's environment-file reference, falling back to
`deployment.env` in the deployment directory only if no reference was saved.

`--env-file` is optional. An absent conventional file permits process-environment
inputs; an explicitly selected missing file is an error. The file is parsed as
`NAME=value` data, never sourced as a shell script. Existing process environment
variables take precedence. The file reference is retained for subsequent apply invocations. Keep it private and
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
absolute; they are not relative to the source spec. Material files may arrive
after planning. Signer identities belong in the top-level `attestationSigners`
list and must be filled before plan. Copy the paired attestation/transport public
keys from approved Governance records; no descriptor file handoff is required.
Governance API synchronization is not part of this workflow: the operator copies
approved public identities into the spec. Names must be unique stable identifiers;
both keys must be distinct compressed secp256k1 public keys. The network is
inherited from `dogecoin.network`.

`bridge.initialAttestationKeyset.signerIds` selects names and fixes their Bridge
key order; its `threshold` defines the required signature count. If this selection
is omitted, all entries are selected in list order, using
`bridge.thresholds.attestation`. Plan freezes these public identities along with
the rest of the intent. Apply writes the selected Bridge keyset and the TSO signer
directory without waiting for descriptor files.
User-supplied artifacts are inputs, not generated facts.

A production Bridge example (replace public-key placeholders before planning):

```yaml
attestationSigners:
  - name: partner-a
    attestationPubkey: REPLACE_WITH_PARTNER_A_ATTESTATION_PUBLIC_KEY
    transportPubkey: REPLACE_WITH_PARTNER_A_TRANSPORT_PUBLIC_KEY
  # Add one entry per approved signer; the Bridge threshold must fit the selection.

preparation:
  bridge:
    mode: production
    image: dogeos69/bridge-genesis-tools@sha256:27e646fd5d9c340926df82f47f7d352fd5333de4e6178c5a8c56aa9637769262
    fundingFile: .scrollsdk/inputs/bridge-funding.json
    production:
      sequencerKms: {action: create}
      # Fee wallet: set DOGECOIN_FEE_WALLET_KEY in private deployment.env.
      # Apply derives its public key and funding address automatically.
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
threshold and future block-height `bridge.timelock` must also be explicit. Attestation public keys and their order come from
`attestationSigners` and the selected initial keyset. Recovery and TEE keys are never
derived from `bridge.seedString` in production mode. Omit that test-helper field
from a production spec; production output contains no helper funding placeholders.

The two Dogecoin wallet identities are distinct from the L2 Reth signer and the
Ethereum DA/fee-oracle identities. With
`images.services.withdrawalProcessor: {repository: dogeos69/withdrawal-processor, tag: v0.3.0-beta.6-kms}`,
select `sequencerKms: {action: create}`. Apply creates or reuses
`alias/dogeos/<metadata.name>/<eksClusterName>/bridge-sequencer`, pins the key ARN
and compressed public key in `.data/bridge-sequencer-kms.json`, and derives the
funding address. No sequencer private key is exported or requested.

For an existing key, use `sequencerKms: {action: reuse, keyId: <key ARN or alias>}`.
The workload role comes from the selected proof AWS receipt, or from an explicit
`sequencerKms.roleArn`. Reuse queries the key, checks role trust and simulates its
`kms:GetPublicKey` / `kms:Sign` permissions without changing AWS resources.
`region` defaults to `infrastructure.aws.region`; `awsProfile` is optional.
Create adds a dedicated KMS policy to the same WP role used for proof access;
it preserves the role's proof-store policies and does not replace its trust.
Without proof AWS resources or an explicit role, create provisions a dedicated
WP IRSA role. Proof/KMS role mismatches fail instead of overwriting annotations.

`sequencerKms` is mutually exclusive with `sequencerPublicKey` and
`sequencerKeyEnv`. Local sequencing still accepts that pair. For the fee wallet,
set only `DOGECOIN_FEE_WALLET_KEY` in the private environment file. Spec fields
`feeWalletPublicKey` and `feeWalletKeyEnv` are not accepted. Apply validates its
compressed WIF and Dogecoin network, derives the public key and funding address,
and pins that public identity in `.data/bridge-fee-wallet.json` before cloud
provisioning. No private key is written to that record. Resume rejects a changed
fee-wallet key so funding cannot silently switch to another wallet.
Runtime native TOML receives `[sequencer_signer_kms]` with `key_id`, `region` and
`expected_pubkey`; the sequencer WIF entry is absent from Secrets/ExternalSecrets.
The funding, confirmation and Bridge construction steps are unchanged.

The image was checked against OCI source revision
`7a9bc0761f4b35e7c32fcdfbcc491294471d826b`: only sequencing supports KMS.
The fee wallet still requires a local key. Plan makes no KMS calls; apply performs
the declared resource operations. AWS access and runtime signing require a live
deployment test in addition to the local adapter tests.

## Production funding and resume

New deployments require the initial sequencer payment at **vout 0**. Build it as
the first output and place change afterwards; inspect the final signed transaction
before broadcasting. Apply rejects nonzero sequencer output indices. Existing
nonzero deployments require a separately reviewed recovery path; do not rewrite
an already funded outpoint.

The beta.6 production order is defined in
[core's pinned production guide](https://github.com/DogeOS69/dogeos-core/blob/56007d3c413ad07f33d0e08b272004089c911f78/docs/bridge-genesis-deployment.md).
The workflow:

1. Projects the declared public signer identities and prepares service identities,
   actual L2 genesis and protocol seed.
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

For the standard AWS deployment, declare
`preparation.archive: {action: create, publicRead: true}`. Apply first resolves
the separate proof bucket, then creates/reuses the raw-blob bucket and grants
the DA writer access to its blobs and the proof bucket's segmentation sidecars.
It applies prefix-scoped anonymous blob GET and TLS-only bucket policies;
anonymous writes remain denied. Explicit `publicRead: true` also allows public
bucket policies while retaining blocked ACLs. Account-level public access
protection is never changed, and unrelated anonymous grants stop the operation.
Use `action: configure` for an existing bucket. Omitting `publicRead` preserves
the existing read policy; `false` removes this deployment's public grant and
requires a usable S3 VPC endpoint read path. External signers need their own
reachable delivery path when anonymous reads are disabled.


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
  # ...bridge and proof inputs as above; attestationSigners is top-level...
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

After a CLI runtime-generation fix, `setup apply --dir /private/deployment
--refresh-runtime` archives the previous publication receipt and signer bundle,
then resumes at `charts`. It preserves the frozen plan, identities, genesis,
funding outpoints and baked proof materials. Publication is performed and read
back again; signer receipts must match the resulting bundle. It never reruns
cloud resource creation or Bridge funding. If older per-instance preparation lost
a declared bootnode entry, chart preparation restores the missing local P2P
identity and verifies that every existing bootnode identity is unchanged. Managed
artifact drift still stops the run.

For a corrected internal Dogecoin route, additionally pass
`--dogecoin-routing-spec /private/deployment-spec.yaml`. This imports **only**
`dogecoin.kubernetes`, requires the same Dogecoin network, and reads the conventional
`DOGECOIN_CLUSTER_RPC_USERNAME` / `DOGECOIN_CLUSTER_RPC_PASSWORD` environment entries.
Other spec changes are not imported. The runtime override is recorded in private
`.scrollsdk/runtime-refresh/` history; it does not replace the original intent.

## Contracts configuration source

The contracts portion of generated `config.toml` follows
[`docker/templates/config.toml` at contracts rc.5](https://github.com/DogeOS69/scroll-contracts/blob/be94674ec64383c1cea61770e64d3b1586bd298e/docker/templates/config.toml),
checked against that revision's `Configuration.sol`, `GenerateGenesis.s.sol` and
`DeployScroll.s.sol`. The generator supplies the following values; operators
should not have to copy protocol addresses into the spec:

| Input | Generated configuration |
| --- | --- |
| Canonical protocol defaults | All six `contracts.overrides` predeploy addresses, including the message queue and gas oracle |
| Stable genesis timestamp | `genesis.TIMESTAMP = 0`, never the generation time |
| Spec supply intent | `genesis.L2_MAX_NATIVE_DOGE_SUPPLY`, using the existing `genesis.maxEthSupplyWei` input name |
| Gas policy | Explicit genesis gas limit and base fee; Galileo scalars and penalty factor; L2 system-config base fee overhead |
| Prepared identities | Deployer/owner addresses and the L2 gas oracle service's public address, including KMS identities |
| Fee-vault withdrawal destination | `contracts.feeVaultDogeRecipientAddress` is a Dogecoin P2PKH address. The CLI validates the network and derives its hash160 for `FEE_VAULT_DOGE_RECIPIENT_ADDR`. This is not an EVM account or an automatic choice of the Bridge fee-wallet. |
| Optional components | Blockscout database, explorer verification, Ethereum devnet and public service hostnames are configured only for the selected components |

Keep the fee-vault recipient key under separate custody. The spec needs only its
public receiving address; services and attestation signers do not need that key.
An omitted recipient retains the upstream template's zero placeholder and emits
a warning: it must be selected before deploying L2 contracts.

`setup gen-l2-artifacts` passes `config.toml` to
`dogeos69/scroll-stack-contracts:gen-configs-dogeos-v0.3.0-rc.5`. The contracts
image produces `genesis.yaml`; the CLI checks mandatory predeploy code before
copying the result to `values/genesis.yaml`. It never synthesizes or patches
contract bytecode or genesis storage. A regression fixture records every field
and predeploy address from the pinned contracts template, with explicit
exceptions for optional components. Review and refresh it when the contracts
release changes.

Do not replace genesis in an already prepared deployment without regenerating
its protocol context, proof materials and signer handoff. Use a new preparation
directory and preserve existing identities and funding records for review.

## Container integration verification

The integration driver uses a mock/observe test spec and the matching public
compiler identity as fixture inputs. It generates disposable wallet and public
signer identities and uses a local synthetic Dogecoin/Ethereum RPC;
it never broadcasts or provisions cloud resources. Use fixtures for the pinned
SDK/core versions and SQLite dstack configuration, not a live deployment spec.

```bash
npm run build
node scripts/test-preparation-e2e.mjs /path/to/scroll-sdk \
  /private/test-spec.yaml /private/compiler-identity.json
```

It runs real rc.5 genesis and beta.6 Bridge/compiler containers, verifies both
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
digest. Private GitHub access uses `GH_TOKEN`, then `GITHUB_TOKEN`, then the
existing `gh auth login` session for github.com. Credentials are not stored in
the plan or downloaded release files.
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

The contracts deployment environment uses rc.5's `DEPLOYER_PRIVATE_KEY`,
`L1_RPC_ENDPOINT`, and `L2_RPC_ENDPOINT` names. Both spec generation and
`setup prep-charts` set Foundry's `ETH_GAS_PRICE` to twice the configured
`L2_BASE_FEE_OVERHEAD`. The deployment activates this fee floor before its final
transactions, so an estimate taken against the initial genesis state can leave
those transactions underpriced. A zero configured floor leaves Foundry's
automatic estimation enabled. This does not require enabling empty blocks.
After an interrupted broadcast, reconcile saved transactions and on-chain
receipts before retrying; the full rc.5 script is not a read-only verification
command and may fail after ownership has already moved to the configured owner.

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


## Slack notifications

`monitoring.slack.enabled: true` enables the spec-owned Grafana `slack-alerts`
integration. Supply the fixed `SLACK_WEBHOOK_URL` in private `deployment.env`.
Generation emits Secret references only; `gen-secrets` writes the private Slack
Secret and rejects missing/placeholder values without exposing them. Preparation
with `secretUpload.kubeContext` also runs `setup monitoring-secrets --apply` for
Grafana/Slack Secrets; an AWS JSON/env upload by itself does not create them.
For manual upload, run `setup monitoring-secrets --apply --kube-context CONTEXT --namespace NAMESPACE` from the generated directory,
then `make install-scroll-monitor`. Webhook rotation requires restarting Grafana
after Secret upload. Explicitly disabling Slack removes only the spec-owned
receiver; no test message is sent by this command. The existing monitor YAML selects Grafana or Prometheus/Alertmanager; generation
only patches notification wiring and preserves other template values. See the SDK operator guide for the
full examples and delivery behavior.


## Grafana admin secret storage

Fresh spec preparation generates a random admin password once, preserves it on
resume, and writes `secrets/grafana-admin.env` (0600). The ordinary `setup
push-secrets` uploads it to AWS Secrets Manager or Vault exactly like Dogecoin
RPC credentials. The default remote name is `<prefix>/grafana-admin-env`.
`values/scroll-monitor-production.yaml` contains only ExternalSecret references;
scroll-monitor 0.1.44-dogeos synchronizes `grafana-admin` for the Grafana chart.
Custom Secret names and data keys follow the existing values template.
`setup monitoring-secrets --apply` applies only Slack to Kubernetes; it does not
bypass the external store for Grafana. Keep the private deployment directory in
backup, and use Grafana's supported admin-password workflow for an existing
Grafana database; changing a bootstrap Secret is not password rotation.
