# Prepare a deployment in explicit stages

For supported public applications on AWS, select [existing ALB references](existing-alb.md) in
`infrastructure.aws.alb`. Final preparation requires bindings for exposed
endpoints; Helm installs bindings without owning the ALB lifecycle.

`setup plan` saves a fresh deployment plan. Six stage commands execute only their
selected stage, persist completed steps and stop for external inputs. Run the
commands from the private working directory containing your spec and environment
file. A stage checks its prerequisites and never executes another stage for you.
They do not install Helm releases or claim that a running chain has passed acceptance.

The initial plan is written in a temporary sibling directory and published only
after all plan records are saved. If writing fails, rerun `setup plan` with the
same output directory. Bootstrap stages its generated files before publishing
them and rolls back if publication fails. An existing Makefile is preserved,
including with `generate-from-spec --bootstrap --force`, so retrying bootstrap
does not discard operator edits.

The CLI does not create or modify `.gitignore` in generated deployment directories
or bundles. Operators manage Git ignore rules; existing `.gitignore` files are
left untouched. `.scrollsdkignore` remains the CLI deployment-sync exclusion file
and is independent of Git.

After preparation, install the frontend and monitoring releases from the generated
directory with `make install-frontends` and `make install-scroll-monitor`, passing
explicit `KUBE_CONTEXT` and `NAMESPACE`. Monitoring belongs early in the Helm
deployment sequence because it supplies Prometheus Operator CRDs. Proof preparation
initializes the bundled Grafana admin credentials once before binding proof
configuration and preserves them on resume. The `render` stage exports the private
Secret files. `secrets/grafana-admin.env` is uploaded by `setup push-secrets` to AWS
Secrets Manager or Vault, like Dogecoin RPC credentials. The monitor chart's
ExternalSecret synchronizes the referenced Kubernetes Secret; do not upload a
standalone Grafana admin YAML.
See the SDK's `examples/deployment-spec.md` for the two releases' values and
verification. Use the individual installation targets and verify each release
before proceeding.

The SDK templates disable Grafana and Dogecoin ingress by default. The CLI
preserves the ingress switches in deployment values; generating domains does
not enable public access. Use local port forwarding, or explicitly configure
and enable ingress in the relevant values file. Existing operator choices are
preserved on regeneration. Blockscout values may be generated for later use,
and installation is explicit. Prepare its database and values, then install
Blockscout and its contract verifier with `make install-blockscout`.
Before final `setup render`, fill the enabled ingress certificate references and
TSO edge network-policy CIDRs in the deployment values. Intermediate chart
compilation inside `setup proof-materials` defers these edge inputs and status-page
reconciliation, while still validating internal callers and enabled isolation.
Local configuration may be edited between stages. Changes to recorded TOML,
genesis or other generated files produce warnings and do not block preparation.
Values YAML and Makefile remain excluded from fingerprint tracking.
These defaults come from the committed SDK revision selected by plan/bootstrap;
an older checkout or an existing deployment retains its own settings.

For Reth RPC and bootnode followers, review
[restart on signer rotation](reth-only-peers.md#follower-restart-on-signer-rotation)
when selecting SDK templates and checking generated values. The
`--consensus.exit-on-signer-rotation` flag must not be enabled on sequencers.

The canonical operator spec and environment templates live in the scroll-sdk
repository: [deployment-spec.example.yaml](https://github.com/DogeOS69/scroll-sdk/blob/v0.3.0-develop/examples/deployment-spec.example.yaml)
and [deployment.env.example](https://github.com/DogeOS69/scroll-sdk/blob/v0.3.0-develop/examples/deployment.env.example),
with the companion guide `examples/deployment-spec.md`. The CLI keeps test inputs
under `test/fixtures/deployment-spec/`; those are not operator templates.

The SDK example selects testnet production Bridge preparation and active/real/enforce
proofs; it generates real identities from an approved proof release after the protocol
context exists. `setup proof-materials` exports the signer deployment kit and waits
for its publication record. `setup render` regenerates configuration and Secrets
before the final enforcing check; no partner policy receipts are collected.

## Prepare the private environment file

Copy `examples/deployment.env.example` from the same scroll-sdk checkout used
for your spec and Helm templates. Copy it to your private directory outside either
checkout, then edit the copy before running plan. For example, with an existing
`/private` directory:

```bash
install -m 600 /path/to/scroll-sdk/examples/deployment.env.example /private/deployment.env
```

Secret assignments are intentionally unusable placeholders; Ethereum RPC entries
start with public provider defaults. Replace them with your production provider
URLs, including any API keys, in this private file. Fill the entries
referenced by your selected spec, and remove unused entries. The full spec
example references the provider variables below; if a configuration branch is
unused, remove its environment references from the spec as well. Planning resolves
the spec's environment references even when a later step would not use them.

| Variables | Where they are used | What the operator supplies |
| --- | --- | --- |
| `ETHEREUM_RPC_URL`, `ETHEREUM_BEACON_RPC_URL` | `ethereumDa.l1RpcUrl`, `ethereumDa.beaconRpcUrl` | Private execution and beacon endpoint URLs for the selected DA network. |
| `FEE_ORACLE_ETHEREUM_RPC_URL` | `feeOracle.ethereumRpcUrl` | Independent Ethereum fee-sampling endpoint; defaults to Ethereum mainnet even for devnet DA. |
| `DB_ADMIN_PASSWORD` | `database.admin.password` | Existing PostgreSQL administrator password. |
| `OWNER_ADDRESS` | `accounts.owner.address` | Public Ethereum/L2 owner or multisig address; no private key. |
| `DEPLOYER_PRIVATE_KEY` | Optional `accounts.deployer.privateKey` import | EVM private key: `0x` followed by 64 hexadecimal characters. The CLI derives the deployer address. |
| `DOGECOIN_EXTERNAL_RPC_USERNAME`, `DOGECOIN_EXTERNAL_RPC_PASSWORD` | `dogecoin.externalRpc` | Credentials for the RPC reached by the operator. |
| `DOGECOIN_CLUSTER_RPC_USERNAME`, `DOGECOIN_CLUSTER_RPC_PASSWORD` | `dogecoin.clusterRpc` | Credentials used by deployed services. |
| `DOGECOIN_FEE_WALLET_KEY` | Optional with helper funding; required with external funding | Compressed Dogecoin WIF for the selected network. Omit for a helper-derived local fee wallet. Fee-wallet KMS is not supported by beta.6-kms. |
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

### Optionally supply an existing deployer key

Before the first `setup plan` / `setup genesis`, uncomment the optional
`accounts.deployer.privateKey: "$ENV:DEPLOYER_PRIVATE_KEY"` entry in your copy of
the SDK spec, and the matching `DEPLOYER_PRIVATE_KEY` entry in your private
`deployment.env`. Replace the environment placeholder with your EVM private key;
Dogecoin WIF and KMS key IDs are not accepted here. Keep the key in the private
environment file, and let the CLI derive its address.

Leave both entries commented to have `setup genesis` generate a random deployer identity
and reuse the saved identity on resume. Setting the environment variable alone
does not enable import. This choice is for a fresh deployment; changing it after
genesis has been generated is not a deployer rotation procedure.

## Ethereum provider Secrets and deployment isolation

Provider URLs remain environment references in the frozen intent and private
Doge config. Local preparation resolves them only when making an RPC request;
`setup gen-secrets` exports resolved URLs to mode-600 files under `secrets/`.
`setup push-secrets` uploads those files and the existing chart ExternalSecrets
supply runtime environment variables. This covers eth-da-submitter, fee-oracle,
l1-interface, withdrawal-processor, proof-coordinator and DA balance monitoring.
Attestation signer configuration is managed separately. Frontend public URLs
never inherit the server provider credentials.

The default AWS prefix is
`dogeos/<eksClusterName>/<namespace>/<metadata.name>` (`namespace` defaults to
`default`). Values generation, `setup upload-secrets` and standalone uploads from the deployment
directory use the same destination persisted in `.data/doge-config.toml`.
Without that file, standalone uploads can read `deployment-spec.yaml`; without
sufficient deployment context or an explicit `--aws-prefix`, they refuse to use
a shared fallback. An explicit `infrastructure.aws.secretsPrefix` is preserved.
If `preparation.secretUpload.awsPrefix` is also set, it must match. Use distinct
explicit prefixes for independent deployments: choosing the same explicit prefix
still authorizes updating the same Secrets. No existing cloud Secrets are renamed
or migrated by changing these defaults.

After editing a provider URL in `deployment.env`, rerun `setup gen-secrets` and
`setup push-secrets` from the deployment directory, then restart the consumers to
load the changed Secret environment. Fee-oracle balance monitoring still uses
the L2 RPC; its fee sampling RPC is independent of that balance check and of DA.

## Commands

The complete bridge-operator sequence (inputs, funding, external Secrets,
installation order, partner handoff, GPU startup and runtime acceptance) is in
[`scroll-sdk/examples/bridge-operator-deployment.md`](https://github.com/DogeOS69/scroll-sdk/blob/feat/spec-preparation-examples/examples/bridge-operator-deployment.md).
`plan` and the eight stage commands are preparation entrypoints; they do not replace Helm installation
or automatically rent a GPU.


```bash
# From the private working directory containing the edited inputs:
scrollsdk setup plan
scrollsdk setup genesis
scrollsdk setup aws
scrollsdk setup bridge-funding
# Fund the displayed helper address and record helper.txid/vout, then rerun.
# Core distributes to the wallets and funds the final Bridge automatically.
scrollsdk setup bridge-funding
scrollsdk setup protocol-context
# Hand off the context before selecting the approved policy build route.
scrollsdk setup proof-materials
# For enforce mode: publish the kit via Governance and save published.json, then rerun.
scrollsdk setup proof-materials
scrollsdk setup render
scrollsdk setup signer-session  # only when CubeSigner is configured
scrollsdk setup upload-secrets
# Review deployment/Makefile and install releases manually.
```

| Path | Convention | Optional override |
| --- | --- | --- |
| Spec | `./deployment-spec.yaml` | `plan --spec <file>` |
| Private environment | `./deployment.env` when present | `plan --env-file <file>` |
| SDK checkout | `../scroll-sdk` | `plan --sdk-dir <directory>` |
| Output | `./deployment/` | `plan --output <directory>` |
| Saved plan | `./deployment/` | Any stage: `--dir <directory>` (alias `--deployment-dir`) |

Paths are relative to the working directory; keep running plan and stage commands there.
A custom plan output requires the matching `--dir` on each stage. Plan prints that command.
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

Each command returns naturally when its stage is complete or waiting. A successful
`genesis` produces `deployment/genesis.json`, `deployment/genesis.yaml` and their
runtime copies, then stops. It creates no AWS resources and does not prepare KMS
or service signing identities. The imported or generated deployer is saved before
generation so a retry uses the same identity.

| Command | Work performed | Boundary |
| --- | --- | --- |
| `setup genesis` | Bootstrap pinned templates; pin the deployer; generate local genesis and contract addresses. | No AWS calls, funding or service identity creation. |
| `setup aws` | Prepare declared service identities, proof store/IAM/token, archive access, Bridge sequencer KMS, controller credentials and selected existing databases. | Resource facts are saved automatically; no copy back into the spec. No GPU allocation. |
| `setup bridge-funding` | Bind genesis/DA anchor; verify helper funding; invoke Core setup and marked funding; verify all resulting outpoints. | One operator wallet handoff. Setup and Bridge funding broadcast transactions and require manual reconciliation after ambiguous failures. |
| `setup protocol-context` | Generate canonical `.data/protocol_context.json` and its runtime YAML from completed Bridge funding. | Stops before CubeSigner policy builds, proof baking, publication and governance. No funding is replayed. |
| `setup proof-materials` | Export the selected policy compiler output; import declared inputs; bake/import proof materials; compile/publish proof configuration; export the deployment kit and record its publication. | Preliminary chart compilation is needed to bind the kit. Wait for its immutable URL and manifest digest within this stage. |
| `setup render` | Render final values/native configuration with the recorded kit publication; generate private Secrets; prepare optional capacity-manager values and WP access; run proof checks. | Helm releases remain uninstalled; rendering does not create a remote CubeSigner session. |
| `setup signer-session` | Create the configured CubeSigner role session and save the private runtime seed. Completed steps are skipped on retry. | Contacts CubeSigner; explicit credential creation, separate from render. |
| `setup upload-secrets` | Upload using the saved provider, region, namespace and Secret prefix. | AWS defaults to the deployment-specific prefix; no retyping it. |

When CubeSigner is configured, `setup signer-session` runs `setup cubesigner-refresh -N
--doge-config .data/doge-config.toml` from the deployment directory after render.
It creates a fresh session for the saved role even when old session files exist.
An authenticated `cs` CLI is required; failure stops this stage and blocks upload.
A completed session step is checkpointed, so retrying the completed stage does not
issue another session. An interrupted remote request may have created a session;
inspect provider state before retrying after an ambiguous transport failure.
Saved plans with the previous render/session layout require their original CLI;
this change does not silently move completed credentials or replay funding.
The upload stage also checks that both session inputs remain present and nonempty.
Kubernetes Secret readiness is still checked separately after upload.

`setup proof-materials --generation ...` and other explicit material flags retain
the standalone material utility. Without material flags, the command runs the
saved stage and defaults to `deployment/`, like the other stage commands.

Existing v1 plans remain resumable with `setup apply`; new v2 plans require the
explicit stage commands. `setup apply` does not execute an unfinished staged plan.

`setup protocol-context` is an independent handoff boundary. It requires all
Bridge funding prerequisites to be completed and runs only the existing context
generation step. Rerunning a completed stage does not regenerate its artifacts.
The command accepts the same `--dir` / `--deployment-dir` options as other stages.

Older v2 plans that placed context generation inside `proof-materials` migrate
when resumed. Migration moves that same step before proof preparation, preserves
the frozen intent and every completed step, and does not replay genesis, AWS or
funding. A plan whose context is already completed keeps that completion. Other
unrecognized workflow changes are still rejected. No new plan is required.

For a release requiring an external reproducible policy build (for example,
`tools/cubesigner/build-verifier.sh <commit>`), stop after this context stage and
follow that release's build and governance instructions. Import the reviewed
artifact with `setup cubesigner-policy import` as described in the
[external policy runbook](cubesigner-external-policy.md). That command selects
the external build for the existing `cubesigner-policy-build` preparation step;
it does not mark any workflow step complete or grant approval. On resume, the
step revalidates the imported artifact and current context instead of exporting
a compiler image. Do not use an incompatible compiler to advance a checkpoint.


Planning validates the spec and pinned SDK templates, writes the private plan,
and lists local, read-only, cloud and chain steps. It does not provision resources
or send transactions. Running a stage authorizes its operations listed
in that saved plan, including expressly selected cloud provisioning and test-helper
broadcasts. In the default managed-helper production path, the operator funds the helper
once; the CLI verifies that payment and invokes Core to broadcast distribution
and marked Bridge funding. The explicit external path only verifies payments
made by the operator.

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
    image: dogeos69/bridge-genesis-tools@sha256:1de7db81356ea733fe4194e3813dd05b29b6028e27941272d2c3f1f1848b06fb
    fundingFile: .scrollsdk/inputs/bridge-funding.json
    production:
      funding: helper # Default for new plans; requires a reviewed fixed Core helper image.
      sequencerKms: {action: create}
      # Optional: DOGECOIN_FEE_WALLET_KEY in deployment.env preserves an existing wallet.
      # Otherwise Core derives it from a private, deployment-specific helper seed.
      recoveryPublicKeys:
        - REPLACE_WITH_FIRST_RECOVERY_PUBLIC_KEY
        - REPLACE_WITH_SECOND_RECOVERY_PUBLIC_KEY
      ethereumAnchor:
        blockTag: finalized
  proofMaterials:
    mode: existing
    receipt: .data/proof-materials-v1.json
```

The image digest above is the temporary amd64 build `test-pr1573-3ca0cf16f`,
verified against a disposable regtest node after the Core #1573 marker fix.
The old `v0.3.0-beta.6` helper emits a 71-byte funding payload instead of the
required 73 bytes and must not be used for this path. Select and review the
intended release for your environment; this example does not change an existing
plan's frozen image or funded outpoints. Select
`signing.cubesigner.identity: {roleId: ...}` (plus `keyId` for multi-key roles);
plan uses the authenticated `cs` CLI to query membership and normalize/freeze the
TEE public key. An explicit `bridge.teePubkey` remains supported. The recovery
threshold and future block-height `bridge.timelock` must also be explicit. Attestation public keys and their order come from
`attestationSigners` and the selected initial keyset. Recovery and TEE keys are never
derived from `bridge.seedString` in production mode. Omit that test-helper field
from a production spec. Helper funding uses a random seed saved privately in
`.data/bridge-helper-seed`, separate from the independently managed Bridge keys.

The two Dogecoin wallet identities are distinct from the L2 Reth signer and the
Ethereum DA/fee-oracle identities. With
`images.services.withdrawalProcessor: {repository: dogeos69/withdrawal-processor, tag: v0.3.0-beta.6-kms}`,
select `sequencerKms: {action: create}`. `setup aws` creates or reuses
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
optionally set `DOGECOIN_FEE_WALLET_KEY` in the private environment file when using
helper funding; external funding requires it. If omitted with helper funding,
the wallet is deterministically derived from the saved helper seed. Spec fields
`feeWalletPublicKey` and `feeWalletKeyEnv` are not accepted. Apply validates its
compressed WIF and Dogecoin network, derives the public key and funding address,
and pins that public identity in `.data/bridge-fee-wallet.json` at the start of
`bridge-funding`. No private key is written to that record. Resume rejects a changed
fee-wallet key so funding cannot silently switch to another wallet.
Runtime native TOML receives `[sequencer_signer_kms]` with `key_id`, `region` and
`expected_pubkey`; the sequencer WIF entry is absent from Secrets/ExternalSecrets.
Core may rewrite its construction manifest during funding; the CLI restores the
pinned KMS backend after both helper actions and never invents a sequencer WIF.

The image was checked against OCI source revision
`7a9bc0761f4b35e7c32fcdfbcc491294471d826b`: only sequencing supports KMS.
The fee wallet still requires a local key. Plan makes no KMS calls; apply performs
the declared resource operations. AWS access and runtime signing require a live
deployment test in addition to the local adapter tests.

## Production funding and resume

New `setup plan` plans default to `preparation.bridge.production.funding: helper`.
The choice is frozen into the plan. Existing plans without that field retain
external funding; they are not silently migrated after outpoints or bridge
addresses have been fixed. Use a new deployment directory for a different
funding path. This creates a different sequencer outpoint, namespace and bridge.

**Release prerequisite:** the old beta.6 image emits the obsolete
71-byte marker (`6a4701` + 70 zero bytes), but its protocol decoder requires
73 bytes (`6a4901` + 72 zero bytes). The CLI blocks that known image before
helper funding. Select a reviewed fixed Core release before using this path.
The isolated Docker test reproduces the bug with the old image and passes the
full funding verification with the fixed temporary image shown above. Run it
against a candidate digest with `RUN_HELPER_DOCKER_TESTS=1
HELPER_DOCKER_IMAGE=dogeos69/bridge-genesis-tools@sha256:... yarn mocha
test/utils/preparation-helper.test.ts`. Confirmation alone is insufficient;
the generated marker and all funding outputs must also pass validation.

With a compatible image, the operator sequence is:

1. Run `scrollsdk setup bridge-funding`. The CLI keeps the KMS/local sequencer,
   TEE, attestation and recovery identities selected by the spec. It supplies
   their public keys to Core. For the fee wallet, an existing
   `DOGECOIN_FEE_WALLET_KEY` is preserved; otherwise Core derives a local key
   from the saved helper seed. No private Bridge keys are generated by helper.
2. Send the displayed amount to the displayed helper P2PKH address. This is an
   ordinary payment; the operator does not construct an OP_RETURN. The requested
   amount includes sequencer funding, ten fee-wallet outputs, bridge funding and
   both transaction fees. Fees for the operator's payment are additional.
3. In `deployment/.scrollsdk/inputs/bridge-funding.json`, supply only:

   ```json
   {
     "helper": {
       "txid": "REPLACE_WITH_HELPER_FUNDING_TXID",
       "vout": "REPLACE_WITH_OUTPUT_INDEX"
     }
   }
   ```

   Replace `vout` with the actual numeric output index paying the helper.
   A decimal string such as `"0"` is also accepted. Transaction IDs may include
   a `0x` prefix; the CLI normalizes the input before querying RPC or saving facts.
   The helper input itself does not need to be vout 0.
4. Rerun `scrollsdk setup bridge-funding`. After confirmation checks, Core
   broadcasts its setup transaction: sequencer at **vout 0**, ten fee-wallet
   outputs, and helper-controlled funds reserved for Bridge funding. The CLI
   derives the final bridge address, invokes Core `fund-bridge`, and verifies
   the marked Bridge output. Test deposit-seed transactions are disabled.
5. Continue with `scrollsdk setup proof-materials`. No additional funding
   txid/vout needs to be entered. All child outpoints are recorded by Core.

Keep `.data/bridge-helper-seed` private and backed up: it controls helper change
and, when no external fee key was supplied, the fee wallet. Generated runtime
Secrets contain the fee-wallet WIF and follow the normal `upload-secrets` path;
the helper seed is not uploaded as a runtime Secret. Changing or removing the
original wallet identity on resume is rejected.

Core setup/funding are broadcasts, not safe-to-repeat rendering commands.
Completed steps are skipped. An interrupted/failed broadcast becomes
`recovery-required`; inspect the private logs and on-chain results before
reconciliation. Do not delete workflow state or blindly repeat `setup`.

### Explicit external-wallet funding

Set `preparation.bridge.production.funding: external` to retain the manual
sequencer/fee-wallet and marked Bridge funding handoffs below. Saved older plans
continue using this path.

Supply the actual sequencer output index; the CLI accepts zero and nonzero
indices without an opt-in flag. Address, amount, confirmations, unspent status
and canonical-chain checks remain enabled. Never relabel an existing output.

Some beta.6 WP builds compare the genesis output index against a compiled
circuit default of zero. Accepting an input here does not establish compatibility
with the selected WP/proof release. Helper distribution avoids this mismatch by
constructing its sequencer output at vout 0.

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
   a confirmed marked funding output, verifies it, then completes the funding stage. The next explicit command,
   `setup proof-materials`, generates protocol context and proof configuration.

The default funding input is `.scrollsdk/inputs/bridge-funding.json`; omit
`fundingFile` unless a custom location is needed. No file is required at plan
time. `setup bridge-funding` creates it at the funding wait and prints both wallet addresses,
amounts and a JSON template. Fill only real outpoints, then rerun `scrollsdk setup bridge-funding`:

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

No automatic wallet scan or wallet signing/broadcast is performed in external
funding mode. The external wallet constructs and sends the payments. Confirmation waits
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

Real proof baking is performed by `setup proof-materials` using the selected producer image.
CubeSigner account/session authorization remains an owner operation. CubeSigner
policy Wasm building is a separate `setup cubesigner-policy build` command using
a pinned private GHCR compiler image. The compiler takes only an output directory;
the CLI verifies the exported Wasm and its SHA-256 and writes a v2 build receipt.
See [the CubeSigner setup guide](setup-order.md#cubesigner-wasm-preparation-and-attachment)
for registry authentication and the implemented interface. For staged deployments
with `signing.cubesigner` configured (except explicit `mode: transport_only`),
`setup proof-materials` first prepares the policy Wasm using the selected build
source. The default is `setup cubesigner-policy build`; an explicit
`setup cubesigner-policy import` selection reuses a verified external artifact.
Neither preparation route publishes or attaches a policy.

The proof release manifest does not select the private policy compiler. On the
first run, the stage writes `.scrollsdk/inputs/cubesigner-policy/compiler.json`
under the deployment directory and waits. Replace its placeholders with the
immutable compiler image reference and full Core commit supplied by the approved
Core release owner:

```json
{
  "compilerImage": "ghcr.io/dogeos69/cubesigner-policy-compiler@sha256:REPLACE_WITH_RELEASE_IMAGE_DIGEST",
  "expectedCoreRevision": "REPLACE_WITH_RELEASE_CORE_COMMIT"
}
```

These are release provenance, not values an operator invents or the proof
producer's image digest. Authenticate Docker to private GHCR with a token granting
`read:packages`; keep the token out of this file. Rerun `scrollsdk setup proof-materials`.
The compiler exports offline, checks the image revision and Wasm checksum, and
writes `.data/cubesigner-policy/{cubesigner_verifier_policy.wasm,cubesigner_verifier_policy.wasm.sha256,build-receipt.json}`.
An interrupted step reuses a matching verified export; conflicting output is never
overwritten. Earlier staged plans acquire this local step without replaying
genesis, AWS provisioning or funding. No spec structure change is needed.

`.data/cubesigner-policy-governance-handoff.json` records the Wasm hash and build
provenance for the governance handoff. It is **not** approval or attachment
evidence. Use the approved governance tools to publish, propose the exact
attachment, collect Council approval and complete attachment with provider
readback. Preserve `RequireRoleSession`. Before `prep-charts`, the `charts` step
pauses when production receipts are absent and creates
`.scrollsdk/inputs/cubesigner-policy/receipts.json`. Its protocol-context path and
SHA-256 are already populated. Copy the governed release/attachment receipts,
Wasm and test report into the deployment directory, preserving receipt-relative
artifact paths. Fill the input's release/attachment paths and SHA-256 digests,
CubeSigner environment and organization; include `liveEvidence` if required by
the release. Input paths are relative to the deployment directory, not to
`receipts.json`. Obtain receipt hashes from the governance handoff and check the
received files with `sha256sum`.

Rerun `scrollsdk setup proof-materials`. The CLI verifies the exact key, role,
protocol context and policy evidence before importing the references into
managed configuration. Do not change the original spec, frozen plan or
`.data/doge-config.toml`. Existing plans use this handoff without replaying
completed steps; invalid evidence leaves managed configuration unchanged.
Already imported references remain authoritative on retries. See
[the receipt contract](proof-config-transactions.md#cubesigner-receipts-and-external-signer-evidence).

Building Wasm alone does not make the key ready to sign. This stage does not
invent governance commands, approve on behalf
of Council members, or configure the organization resolver.

The workflow does not create an EKS cluster, rent GPU capacity or install releases.

## State and outcomes

JSON output returns `stage`, `status`, `currentStep`, `completed`, `nextCommand`
and optional `waiting` instructions; the response's `warnings` lists detected
local file changes. Exit codes: `0` for `stage-complete` or
`prepared`, `2` for `waiting`, and `1` for failure or `recovery-required`.
`stage-complete` means only the selected stage is complete. `prepared` means all
all applicable stages are complete; running-service acceptance remains separate. A wait or
failure reports the same stage as the next command. A successfully printed JSON result with
`status: waiting` is not a completed deployment.

Each completed step and artifact fingerprints are saved before proceeding.
Fingerprints are diagnostic only: edited or missing files produce warnings,
and the next step runs using the files currently on disk. This also applies to
old saved plans, with no opt-out flag or manual state-file repair. Warnings name
files without printing their contents. Operator-owned `values/*.yaml` (including
nested YAML files) and `Makefile` remain excluded from fingerprint tracking.
External funding and governance inputs remain editable under `.scrollsdk/inputs/`.

Changes to the saved `plan.json` or `intent.json` content hashes also produce
warnings instead of stopping execution. The workflow still reads its saved
intent, not the original source spec, and skips completed steps: editing a file
does not automatically regenerate dependent artifacts, reprovision AWS resources
or replay funding. An apply lock still excludes concurrent execution. Required
input parsing, step prerequisites, ambiguous broadcast recovery and externally
pinned release/governance evidence validation remain in effect; a later step can
report a concrete missing or invalid input rather than a generic file-hash error.

The initial interface is for fresh deployments. Replanning from a changed source
spec still requires a new deployment directory; resume commands use the saved
plan and intent with the advisory file checks described above. This does not
implement in-place upgrades, key rotation or destructive
migration. After an abrupt process termination, inspect the lock's host/PID and
any child/provider activity before removing a stale lock; interrupted broadcasts
remain blocked regardless. Runtime deployment acceptance remains a separate step.

For legacy v1 plans only, after a CLI runtime-generation fix, `setup apply --dir /private/deployment
--refresh-runtime` archives the previous state, config and proof publication receipt,
then resumes at `charts`. It preserves the frozen plan, identities, genesis,
funding outpoints and baked proof materials. Publication is performed and read
back again; unchanged signer inputs reuse the same deployment kit and its
publication record, while changed inputs require a new kit publication. It never reruns
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

Final `setup render` packages the current `config.public.toml` and
`config-contracts.toml` into `values/scroll-common-config.yaml` and
`values/scroll-common-config-contracts.yaml`. These are the two TOML wrappers
consumed by the contracts Helm release. Packaging validates both sources before
replacing either wrapper and does not regenerate genesis or read private
`config.toml` into Helm values. The legacy `setup gen-l2-artifacts` path uses
the same packaging helper, including when a custom values directory is selected.

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
| Prepared identities | Genesis uses deployer/owner inputs. The isolated generator config uses the deployer for the shared reader's mandatory Fee Oracle address; this does not become the runtime Fee Oracle identity. The AWS stage prepares the actual service identity |
| Fee-vault withdrawal destination | Required: `contracts.feeVaultDogeRecipientAddress` is a Dogecoin P2PKH address. Plan rejects a missing or invalid recipient before SDK resolution, CubeSigner lookup or proof-release downloads; apply also rejects saved plans missing it before running any step. The CLI validates the network and derives its hash160 for `FEE_VAULT_DOGE_RECIPIENT_ADDR`. This is not an EVM account or an automatic choice of the Bridge fee-wallet. |
| Fee-vault genesis/bootstrap recipient | Optional: `contracts.l1FeeVaultAddress` projects to `L1_FEE_VAULT_ADDR`; defaults to `0x0000000000000000000000000000000000000001`. Use a nonzero 20-byte hex address only when deliberately preserving a previous genesis input. It is temporary: contract initialization replaces the vault recipient with `FEE_VAULT_DOGE_RECIPIENT_ADDR` before routing withdrawals through the adapter. Changing it changes genesis; create a new preparation plan and regenerate all artifacts consistently. Do not patch genesis storage directly. |
| Optional components | Blockscout database, explorer verification, Ethereum devnet and public service hostnames are configured only for the selected components |

Keep the fee-vault recipient key under separate custody. The spec needs only its
public receiving address; services and attestation signers do not need that key.
An omitted recipient retains the upstream template's zero placeholder and emits
a warning: it must be selected before deploying L2 contracts.

`setup gen-l2-artifacts` passes `config.toml` to
`dogeos69/scroll-stack-contracts:gen-configs-dogeos-v0.3.0-rc.9`. The contracts
image produces `genesis.yaml`; the CLI checks mandatory predeploy code before
copying the result to `values/genesis.yaml`. It never synthesizes or patches
contract bytecode or genesis storage. A regression fixture records every field
and predeploy address from the pinned contracts template, with explicit
exceptions for optional components. The rc.6 release introduced omission of
zero-valued storage allocations. The rc.7 upstream template changes its default
deployer balance to 10 DOGE; the CLI continues to pass the deployment's explicit
`genesis.deployerInitialBalanceWei` instead of silently changing that intent.
Review and refresh the fixture when the contracts template changes.

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

It runs the default contracts genesis and beta.6 Bridge/compiler containers, verifies both
funding pauses, explicitly completes proof preparation and rendering, then
reruns render to verify completion is stable. It stops before `upload-secrets`;
that cloud mutation is covered with a mocked destination-handoff test.
Private generated files and child logs remain in the reported temporary directory;
only sanitized step outcomes and RPC method names are printed. Docker must be
available. This verifies orchestration and artifact compatibility, not real chain
confirmation, AWS permissions, real proofs or cluster deployment acceptance.

## Generated proof identities and external completion evidence

Signer-kit publication can run automatically inside `setup proof-materials` for
new plans with `preparation.deploymentKitPublication: {mode: s3}` (optional
`awsProfile`). The plan marks this as a cloud operation. The selected
`proofArtifacts.s3` bucket and region determine the destination; each kit uses
`deployment-kits/<version>/`, separate from the proof prefix. The publisher
validates the canonical five files, creates a deterministic `.tar.gz`, uploads
only missing objects with a no-overwrite condition, and rejects conflicting
existing bytes. It preserves unrelated bucket policy statements and owns one
HTTPS-only `s3:GetObject` grant for the exact version prefix. It does not change
public-access blocks or grant listing, writes or deletes to anonymous users.
The publishing host needs GNU tar and an AWS CLI supporting S3 `IfNoneMatch`.

All six objects must pass authenticated and anonymous HTTPS byte comparisons
before the CLI records `published.json` and the doge-config publication entry.
The result prints the version, archive URL and manifest SHA-256 for Governance;
it does not post to Governance. Interrupted publication can be retried. Bucket
policy updates are re-read before writing, but S3 offers no policy compare-and-swap;
serialize concurrent bucket-policy administration during publication.

Omission or `mode: manual` preserves existing plans and their manual publication
inbox. For an already planned deployment, run `scrollsdk setup publish-deployment-kit`
from the generated directory to inspect the local kit/destination, then add
`--apply` to publish it explicitly. A subsequent stage resume consumes the saved
receipt. Both modes use the same canonical kit and readiness checks.

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

For enforce, `setup proof-materials` exports the signer deployment kit (`deployment-kit`, the
same writer as `setup export-deployment-kit`) and pauses at
`deployment-kit-published`. `.scrollsdk/inputs/deployment-kit/request.json`
names the kit directory, version and manifest SHA-256. Publish that directory
unchanged at an immutable https URL, put the URL and manifest SHA-256 on the
deployment's governance record, then save
`{"url": "<https URL>", "manifest_sha256": "<sha>"}` as
`.scrollsdk/inputs/deployment-kit/published.json` and rerun `setup proof-materials`. It
records the publication in `[attestationSigner.deploymentKit]` and completes
that stage. Then run `setup render` to regenerate values and Secrets and run the
final check. Legacy v1 plans resume with `setup apply`. The kit version is derived from the signer-relevant inputs, so a
rerun or a runtime refresh with unchanged inputs reuses the same kit and
publication. Observe and mock deployments have no kit. Plans created by an
earlier CLI migrate in place: their `signer-policy`, `signer-receipts` and
`charts-validated` steps are replaced by the kit steps (and `render-final`
for staged plans). Completed genesis, cloud provisioning and funding steps are
kept; no funding transaction is replayed. Old receipts do not satisfy the new
publication requirement. After rollout, run `setup proof-config-check --live` as the final
acceptance check.

The contracts deployment environment uses rc.5's `DEPLOYER_PRIVATE_KEY`,
`L1_RPC_ENDPOINT`, and `L2_RPC_ENDPOINT` names. Both spec generation and
`setup prep-charts` set Foundry's `ETH_GAS_PRICE` to twice the configured
`L2_BASE_FEE_OVERHEAD`. The deployment activates this fee floor before its final
transactions, so an estimate taken against the initial genesis state can leave
those transactions underpriced. A zero configured floor leaves Foundry's
automatic estimation enabled. This does not require enabling empty blocks.
This also satisfies the newer `check-deploy-gas.js` preflight, which requires an integer wei `ETH_GAS_PRICE`
of at least `2 * L2_BASE_FEE_OVERHEAD`: the default overhead of `420000000000`
therefore produces `ETH_GAS_PRICE="840000000000"`. Both generation paths also
set `BATCH_SIZE="10"` in the `contracts-deployment-env` ConfigMap, consumed through
the deployment pod's `envFrom`. `deploy.sh` passes that environment value to
Forge as `--batch-size "$BATCH_SIZE"`; it is not a positional script argument.
Regenerate values or run `setup prep-charts` to update existing files before
installing the contracts chart.
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

## Apply GPU capacity after service deployment

An optional `proofWorkers` spec block declares GPU intent. Preparation validates
its limits and shows the rental envelope, but does not rent GPUs. After installing
the coordinator/controller and publishing the bound proof artifacts, run from the
generated deployment or `runtime/` directory:

```bash
scrollsdk setup proof-worker
scrollsdk setup proof-workers plan
scrollsdk setup proof-workers apply
scrollsdk setup proof-workers status
scrollsdk setup proof-workers destroy
```

`plan` and `status` do not mutate cloud resources. The separate capacity `apply`
starts a persistent in-cluster watchdog before submitting through dstack 0.21.5.
Defaults: one RTX 3090, 8 CPUs, 64 GB RAM, 200 GB disk, 2 hours (8 hours maximum),
$0.80/instance-hour ceiling, $3 rental admission budget, 30-minute startup,
13-minute drain and 5-minute idle teardown. The default $2.27 rental envelope
includes those overheads and two polling minutes; storage, traffic, tax and
failed/delayed provider deletion are not a guaranteed billing cap. No retries or
unlimited sessions are generated. Exact CUDA image compatibility is checked.

The SDK's `examples/proof-workers.md` documents the complete spec, an eight-hour
two-worker example, ownership checks, cancellation, new sessions and outage
boundaries. It reuses `.scrollsdk/intent.json`, existing controller credentials and
the compiler Worker contract without additional input files or path flags.

## ALB edges, internal isolation and workload permissions

For the supported public applications, use [existing ALB mode](existing-alb.md). Their charts
own their bindings, while ALBs, certificates and forwarding rules remain
externally managed. The managed-Ingress annotation workflow below applies to
legacy deployments; it does not configure external ALBs.

The current SDK examples require AWS Load Balancer Controller for HTTPS;
ingress-nginx and cert-manager are not required. Set issued ACM certificate
ARNs on enabled ingress values, or run `setup tls --certificate-arn
"$ACM_CERTIFICATE_ARN" -N` for a certificate covering all enabled hosts.
Explicit nginx selections now fail with a migration instruction. This changes
local configuration only; migrate live DNS/controllers separately.
L1 devnet is excluded from production preparation. Its values are generated
only for `ethereumDa.chain: devnet`; `prep-charts` skips leftover L1 devnet
values when using external Ethereum. Private devnet clients use the internal
Service with ingress disabled by default. Public development access requires
an explicit ingress opt-in and a hostname/certificate.

Production TSO/WP NetworkPolicy is enabled. Before final render, fill the
TSO ALB subnet CIDRs; review same-namespace caller selectors before proof
preparation. Standalone `prep-charts` validates all of these inputs by default.
Empty selectors, unrestricted CIDRs and disabled isolation are rejected. Verify
the cluster CNI enforces the rendered rules before launch. Metrics/API share a
port, so monitoring peers also have management-port reachability.

WP and eth-da-submitter receive scoped S3 GetObject/PutObject, without listing
or deletion; Coordinator additionally receives prefix-scoped ListBucket and
DeleteObject for recovery. Role reconciliation/reuse audits other inline and
attached policies and rejects unprovable excess S3 grants. KMS reconciliation
also audits signing grants against the exact key. Identity-only preparation
defers S3 auditing to archive preparation, which has the full archive/sidecar
intent and can distinguish legitimate existing grants from excess access.
The caller needs IAM list/get
policy access; unknown policies are not removed automatically. This audit is
not an effective-permission proof: resource policies, permission boundaries
and node credentials still need a runtime check.

See the SDK's `examples/network-and-iam.md` for the permission matrix, optional
Blockscout ALB group configuration and pre-launch network checks. Anonymous
proof reads required by signers/workers remain supported; snapshot changes
are deferred.

## Core capacity-manager with staged preparation

SDK PR #145 supplies the independent chart, production template and Makefile
installation target. Use an SDK checkout/revision containing that PR; planning
rejects a missing capacity-manager template before provisioning resources. The
CLI reuses the capacity preparation from CLI PR #80.

Declare `capacityManager` in the spec **instead of** `proofWorkers`. Keep
`dstackController.enabled: true` and active real proving. For example (merge into
the spec, replacing the image and fleet references with approved values):

```yaml
capacityManager:
  image:
    repository: ghcr.io/dogeos69/capacity-manager
    digest: REPLACE_WITH_PUBLISHED_SHA256_DIGEST
  provider: aws
  gpu: L4
  project: dogeos-aws-provers
  fleets: [dogeos-aws-l4]
  fleet:
    action: create
    cpus: 16
    memoryGiB: 64
    diskSizeGiB: 200
    idleDurationSeconds: 600
  regions: [us-east-1]
  instanceTypes: [g6.4xlarge]
  minWorkers: 1
  maxWorkers: 2
  maxPricePerHourUsd: 1.50
  maxHourlyCostUsd: 3.00
```

These prices are example ceilings, not provider quotations. `L40S` is also
supported with a compatible checked Worker image (CUDA architecture 89); select
its fleet, instance type and price ceilings explicitly using the SDK's qualified
AWS profile guidance. SDK DevNet profiles are not copied into a new deployment.
For a checked Worker image built for CUDA architecture 86, AWS `A10G` is
supported (for example, `g5.4xlarge`). Select `gpu: A10G` and the instance type
explicitly; fleet selectors retain the AWS/dstack name `A10G`, and the planner
uses 22 GiB of usable VRAM. Verify the regional price and capacity before rental.
The manager image must be a compatible, separately published immutable image;
this workflow neither builds nor publishes it.

- `setup proof-materials` prepares and verifies the Worker programs and publication.
- `setup render` uses `prep-charts` to generate
  `values/capacity-manager-production.yaml` from those verified inputs, plus a
  same-namespace WP NetworkPolicy peer for the manager. It saves the spec's
  Kubernetes context and namespace for later credential/status commands.
- `setup upload-secrets` uses the normal secret destination. It does not connect
  to dstack or rent GPU workers.
- Install the supporting releases manually, including WP with the generated
  NetworkPolicy, proof token Secrets, and the dstack controller.
- For a newly planned deployment, no separate capacity preparation command is
  required. Make validates the project and prepares empty fleets before Helm
  installs the manager. The manager mounts existing Secret references and mints
  a separate credential for each Worker; no shared Worker token is copied to dstack.
- From `deployment/`, review the generated values and run
  `make install-capacity-manager`. **This explicit installation starts Core's
  capacity reconciliation and may rent paid workers.**

`setup capacity-manager` defaults to `./deployment` (override with `--dir`), and
`credentials` (used automatically by Make) / `status` use the saved spec context unless `--kube-context` is
explicitly supplied. `scrollsdk setup capacity-manager status` reports the manager
Deployment, not proof-worker acceptance. There is no SDK rental-duration cap on
Core's continuous manager. Follow the SDK drain/retirement instructions: pausing
or uninstalling the manager alone does not establish that remote billing stopped.

For an existing deployment, keep its frozen intent and preparation plan intact.
After completing the SDK's Worker retirement procedure (`status` / `destroy`
until the saved session is `destroyed`), select `capacityManager` in a separate
spec file, without `proofWorkers`, then prepare locally:

```bash
scrollsdk setup capacity-manager prepare --dir ./deployment \
  --spec ./capacity-manager-spec.yaml --sdk-dir /path/to/scroll-sdk \
  --dstack-url https://controller.example.invalid
```

Only the `capacityManager` section is read from `--spec`. Kubernetes targeting,
controller configuration and proof inputs remain those of the frozen deployment.
The selection is saved separately in `.scrollsdk/capacity-manager/config.json`
and reused on subsequent `prepare` and `prep-charts` runs. This command validates
and reuses the existing proof contract, publication and checked Worker image;
it does not replay genesis, funding, proof compilation or secret upload.

If the production values file is missing, preparation reads its template from
`templates.sdkRevision` in the frozen intent, using `--sdk-dir` or the SDK
checkout saved in the preparation plan. It does not update other templates or
the Makefile. The pinned SDK and existing Makefile must support Capacity Manager.
The controller URL must already have working HTTPS (HTTP is allowed only for a
literal loopback IP); `--dstack-url` records that endpoint, not a TLS deployment.
With frozen `dstackController.internalTls`, it must match that configured endpoint.
Without the flag, preparation preserves the URL in existing values or uses the
frozen internal TLS configuration.

Review the generated values, WP NetworkPolicy and empty fleet YAML before
installing. Preparation commits these local outputs together; failure leaves
existing files intact. It refuses an unretired SDK session and refuses to replace
a changed prepared capacity plan until the old manager is drained and its plan
archived. After a handoff, the saved capacity plan also blocks SDK Worker apply.

### Shared namespace and automatic capacity credentials

All spec-managed releases, including dstack and capacity-manager, use
`infrastructure.namespace` (default `default`). A conflicting
`dstackController.monitoring.namespace` is rejected. Do not set a separate
`DSTACK_NAMESPACE`.

`gen-secrets` generates existing controller credentials; capacity-manager reuses
the same dstack auth Secret and the prepared proof-work Secret. `push-secrets`
keeps the existing publication destinations: proof tokens in the external store,
and controller Secrets in Kubernetes. It does not need a running dstack server.
No extra capacity-manager admin-token Secret is created.

After uploading Secrets, install dstack and the proof services with the generated
Makefile. Then run `make install-capacity-manager`. That target first waits for
dstack's rollout and prepares the selected project fleets via the controller.
It then installs the manager with the existing dstack, proof-work and
worker-credential-master Secret references. Ensure the proof chart's ExternalSecret
has synchronized before installation. A fleet preparation failure stops the
recipe before Helm; retry the same Make target after fixing the cause.
The preflight first checks project/backend availability and creates missing
empty fleets (`fleet.action: create`, the default), or checks existing fleets
(`fleet.action: reuse`). Both modes compare the effective fleet configuration;
a difference stops installation without changing the existing fleet. It never
force-applies a fleet or starts a worker. The Helm installation can start paid
GPU allocation according to the declared policy.

The generated Makefile passes its context and namespace explicitly. Namespace
changes require regenerating the values, since service DNS and Secret references
are bound to that namespace.

### Project, backend and empty fleet preparation

With `preparation.dstack.mode: import`, the generated controller configuration
creates the project named by `capacityManager.project` at server startup. Omit
`preparation.dstack.project`; if supplied it must match. The imported providers
must include `capacityManager.provider`. External mode keeps project/backend
configuration operator-owned and the install preflight verifies that it exists.

For Vast, retain `providers: [vastai]` and `vastaiApiKeyEnv: VASTAI_API_KEY` in
`preparation.dstack`; the value stays in `deployment.env` and generated Secrets.
`capacityManager.minReliability` defaults to `0.95` and accepts values from `0.95`
to `1`. It is projected to Vast fleet `backend_options.min_reliability`, with
`offer_order: price`. Explicitly carry over any stricter reliability floor when
switching from bounded Workers. AWS fleets do not receive Vast backend options.
For AWS, use the controller's existing IRSA role and explicit existing VPCs:

```yaml
dstackController:
  enabled: true
  defaultCredentialsEnabled: true
  serviceAccount:
    annotations:
      eks.amazonaws.com/role-arn: arn:aws:iam::000000000000:role/REPLACE_WITH_DSTACK_ROLE
preparation:
  dstack:
    mode: import
    providers: [aws]
    aws:
      vpcIds:
        us-east-1: vpc-REPLACE_WITH_EXISTING_VPC_ID
      publicIps: false
```

Merge these into the existing blocks rather than duplicating YAML keys. Every
selected AWS region needs a VPC mapping. Private networking requires suitable
private subnets, outbound access and controller-to-worker reachability. Optional
`iamInstanceProfile` is an existing worker instance profile name. The CLI does
not create provisioning IAM roles, networks or quotas, and it does not fall back
to a default VPC. AWS static access keys are not imported by this path.

`setup render` saves reviewable definitions in
`.scrollsdk/capacity-manager/fleets/*.yaml` and records their hashes in the local
plan. Provider, GPU, regions, instance types, price ceiling and maximum node
count come from `capacityManager`. Each fleet starts with `min: 0, target: 0`;
creating it does not rent an initial instance. Fleet defaults are 16 CPUs,
64 GiB RAM (128 GiB for L40S), 200 GiB disk and 600 seconds of idle time, all
configurable under `capacityManager.fleet`. The idle timer releases unused
instances; it does not limit worker runtime. Core's `minWorkers` independently
controls warm workers after the manager starts. Existing fleets are reused only
when their effective configuration matches, including limits and idle policy.
Review and change spec before planning rather than editing locked fleet files.

When upgrading an existing controller's server-config Secret, restart/redeploy
that controller so it loads the new project/backend configuration before running
the install preflight. Initial installations load it automatically. No provider
API calls or GPU allocation occur during local render or offline tests. Live
acceptance still needs provider availability, a real proof, restart adoption and
confirmed instance cleanup.

Before final render, set `manager.dstack.serverUrl` in
`values/capacity-manager-production.yaml` to the controller's verified HTTPS
endpoint. Rendering preserves this operator-owned URL and rejects the old HTTP
ClusterIP default, which Core rejects outside IP loopback addresses. HTTP
`localhost` is also rejected. Intermediate proof preparation defers this runtime
input until final render. A private HTTPS proxy or internal ingress must have
working routing and a trusted certificate, including a renewal mechanism. The
optional `dstackController.internalTls` integration below generates an internal
ALB using ACM-managed renewal; existing operator-managed proxies remain supported.
Verify connectivity from the manager
Pod before accepting capacity readiness. Changing a previously prepared endpoint
still requires draining the old manager and archiving its local capacity plan.

### Proof publication content comparison

Operator decision (2026-10-15): do not compare the publication receipt's whole
topology bundle revision with the current runtime topology. Service configuration
edits must not require republishing unchanged proof programs. The deferred follow-up
now compares the eleven canonical published program/protocol files by SHA-256,
size, object key, and content-addressed bundle ID against the selected local
materials and compiler-generated tag-5 program manifest. Service endpoints,
credentials, and runtime topology revision do not participate in this comparison.
Changing a program, OpenVM config, Bridge manifest or protocol context requires
republishing that bundle. A legacy receipt without the complete file map must be
replaced by a verified publication receipt. Receipt digest, release, selected
artifact store and authenticated/anonymous readback evidence checks remain in place.
This is an offline integrity gate; it does not re-fetch remote objects or claim
that a GPU worker is operational.

## Internal dstack HTTPS with managed certificate renewal

For AWS deployments, `dstackController.internalTls` generates an internal ALB
Ingress and binds capacity-manager to its HTTPS hostname. This is an opt-in
alternative to an operator-managed HTTPS endpoint. It is mutually exclusive with
`dstackController.ingress` and owns the generated controller ingress, including
replacing stale annotations in existing values.

```yaml
dstackController:
  internalTls:
    hostname: dstack.example.invalid
    certificateArn: arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000
    subnets: [subnet-aaaaaaaa, subnet-bbbbbbbb]
    inboundCidrs: [10.20.0.0/16] # Replace with the manager callers' restricted CIDRs.
```

Replace all example identifiers with your own public references. Select subnets
in at least two availability zones of the EKS VPC; ensure the controller can
create an internal ALB and its backend security-group rules. The certificate must
be in `infrastructure.aws.region`. `prep-charts` calls only ACM DescribeCertificate
to require an issued, unexpired Amazon-managed certificate covering the hostname,
with successful DNS validation for every domain. Imported certificates and email
validation are rejected for this mode. Optional `internalTls.awsProfile` selects
the read profile. Pure `generate-from-spec` remains offline; perform `prep-charts`
before installing the controller.

Install with the generated `make install-dstack-controller`, then bind the
hostname to the internal ALB's DNS name in DNS visible to the manager. This does
not require a public controller endpoint. The ALB terminates TLS and forwards
HTTP within the VPC to dstack; it is not end-to-end pod TLS. AWS ALB charges apply
when installed. No certificate private key is copied to Kubernetes. ACM manages
renewal and ALB certificate replacement while the certificate remains attached
and its public DNS validation CNAMEs remain present. Keep those validation records
and monitor ACM renewal events; a local render cannot prove future renewal or
live reachability. See [ACM DNS renewal requirements](https://docs.aws.amazon.com/acm/latest/userguide/dns-renewal-validation.html).

The manager retains normal certificate verification. Final preparation rejects
controller values that disagree with the selected internal edge. Existing plans
without `internalTls` continue to preserve their operator-supplied HTTPS endpoint.
Moving an already prepared manager to a different endpoint still requires draining
it and archiving its local capacity plan before preparing its replacement. This
feature does not migrate the existing devnet proxy, install resources, modify DNS,
or allocate workers during preparation.

## TSO ALB subnet discovery

Set `preparation.tsoAlbEdge.enabled: true` to reconcile the TSO edge peers during
final `prep-charts`. This requires an explicit `infrastructure.aws.region`,
`infrastructure.aws.eksClusterName` and Kubernetes context. Optional `awsProfile`
and `ingressName` select the AWS profile and nonstandard Ingress resource name.
Proof preparation does not perform this discovery.

The CLI verifies that the context addresses the selected EKS cluster. For an
existing ALB it reads its actual subnets. Before ALB creation, it selects one
eligible role-tagged subnet per availability zone and pins those exact subnet IDs
in `alb.ingress.kubernetes.io/subnets`; it does not treat all public VPC subnets as
the load balancer's source. Explicit subnet annotations take precedence. Subnets
must belong to the selected VPC and span at least two availability zones.

Generated CIDRs and subnet ownership are recorded in `.scrollsdk/tso-alb-edge.json`.
On regeneration, a changed live ALB updates the previous generated annotation;
operator-edited annotations remain intentional subnet selections. During a pending
subnet migration, both current and desired subnet CIDRs remain allowed until AWS
reports the move. Only previously
generated peers are replaced. Additional edge peers and internal service peers
are preserved, including an operator CIDR overlapping an ALB subnet. Values and
the receipt participate in the same generation transaction. Discovery uses only
AWS describe calls and Kubernetes reads. Applying the rendered NetworkPolicy and
verifying CNI enforcement remain deployment acceptance steps.

## Reproducible Helm tuning and runtime checks

Optional `helmValues` maps a generated values filename to a YAML overlay. The
plan freezes the overlay text. Bootstrap and each chart-preparation pass merge
it into the standard `values/*.yaml` files consumed by the normal Make targets;
no private helper script or extra Helm arguments are needed. Existing operator
Makefiles are preserved. Use externally managed Secret references in overlays;
never place passwords, tokens or keys in this field. Arrays replace except
named `env` entries, which merge by name. Unknown filenames and invalid mappings
fail rather than silently producing unused files. Removing an override does not
undo existing operator edits; review/reset those fields explicitly.

```yaml
helmValues:
  l2-reth-rpc-production.yaml: |
    resources:
      requests: {cpu: 500m, memory: 2Gi}
      limits: {cpu: "2", memory: 4Gi}
  scroll-monitor-production.yaml: |
    loki:
      persistence: {size: 20Gi}
```

Missing recorded artifacts, including values and the Makefile, now stop preparation
with `recovery-required`. Restore the files from the deployment backup and retry;
completed funding or identity steps are never replayed to repair a missing file.
Edits to values/Makefile remain operator-owned. Other changed files remain advisory.
The sequencer KMS fingerprint binds AWS account, EKS cluster, region, namespace,
deployment name, service account and explicit KMS intent, not ALB/Secret routing.
Old KMS fingerprints or changed stage layouts are not automatically reinterpreted:
use the original CLI for those saved plans or perform a separately reviewed migration.

The generated SDK `install-cubesigner-signer` target invokes
`setup cubesigner-policy verify-activation` before Helm. This branch supports
explicit non-mainnet `transport_only` and receipt-backed production selection.
The check renders the selected chart, verifies singleton session mounts, reads
current remote key/role/policy/session state and compares delivered Kubernetes
Secrets and protocol context. Unknown attached policies fail closed even in
transport mode. The result does not claim real-proof acceptance, inspection of
an existing Pod's refresh cache, or completion of installation. Production
release/attachment receipts remain mandatory; no governance action is performed.

`setup deployment-preflight` keeps network/container probes explicit:

```bash
scrollsdk setup deployment-preflight --deployment-dir deployment --json \
  --kube-context example-context --rendered-manifest rendered/reth.yaml \
  --rendered-manifest rendered/ingress.yaml \
  --ethereum-rpc-env SEPOLIA_RPC_A --ethereum-rpc-env SEPOLIA_RPC_B \
  --ethereum-rpc-quorum 2 --ethereum-chain-id 11155111 \
  --signer-container local-attestation-signer --dogecoin-rpc-env DOGECOIN_RPC_URL \
  --reth-image example.invalid/approved-rollup-node:reviewed-tag
```

Prepare the manifest files with `helm template` using the same chart/version,
namespace and values as installation. The cluster check reads ready nodes and,
when ALB resources are present, the Load Balancer Controller and TargetGroupBinding
CRD. Per-Pod CPU/memory fit is a necessary condition only; it excludes existing
utilization, affinity, taints, storage topology and aggregate capacity.
The Ethereum probe sends `eth_chainId` and `latest`/`safe`/`finalized` block lookups
in one four-call batch, then checks quorum at a shared finalized height. It does
not establish Beacon availability or long-term provider reliability.
The signer probe runs disposable curl in the existing container's network
namespace and calls `getblockchaininfo`; credentials travel on stdin, not argv.
The Reth probe uses two disposable containers sharing a network-disabled namespace, with a readable temporary copy of public
genesis mounted read-only, a disposable public consensus signer address, a local deterministic L1 fixture
(`node:22-alpine`), mock blob input, bounded resources and ephemeral storage. It confirms
startup through the HTTP-server startup event and a three-second stability window; it does not establish sync or
full application acceptance. Both probes create only local disposable containers.
Omitted checks are explicitly `not-checked`, never implied to have passed.

Contract source submission and final verification are separate:

```bash
scrollsdk setup verify-contracts --config-dir deployment --preinstalls --require-verified --wait-seconds 120
scrollsdk setup verify-contracts --config-dir deployment --preinstalls --status-only
```

Without a status flag, the runner reports final status as `not-checked`.
`--status-only` performs no Docker invocation or submission. Blockscout results
are reported per target as `verified`, `partial`, `pending`, or `unavailable`;
only full verification of every selected target exits successfully. Block-hash
history has no Solidity source and remains a bytecode check. Optional preinstalls
are outside the required source-verification set.
