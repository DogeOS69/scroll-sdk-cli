# DeploymentSpec workflow and configuration ownership

For resumable orchestration of the full preparation sequence, see
[Prepare a deployment with plan and apply](spec-preparation.md).


DeploymentSpec generation and `setup prep-charts` share the following inputs.
The core service image fallback is `v0.3.0-beta.6`; explicit image overrides
remain authoritative. Contracts use `dogeos-v0.3.0-rc.4`. Reth is independently
released and still requires an explicit approved image tag.

## Fresh-chain gas and fee policy

```yaml
genesis:
  gasLimit: 30000000
contracts:
  l2BaseFeeOverheadWei: "420000000000"
feeOracle:
  contractWriteMode: live
```

These are the defaults when the fields are omitted in a new spec. The base fee
overhead is a decimal uint256 string in wei; it is different from genesis
`baseFeePerGasWei`. Gas limit must be a safe integer of at least 5000.

The generated Reth values use 30,000,000 gas, a 2000 ms block interval and a
1400 ms payload build window. The same genesis gas limit enters `config.toml`
for rc.4 genesis generation. During prep, an explicit `genesis.GAS_LIMIT` in
that file also sets the concrete Reth nodes' builder gas limit. If the field is
absent from an older deployment, prep preserves its values setting. Prep does
not rewrite the operator's existing block interval/build window or image pin.

For a fee-oracle rehearsal, select `contractWriteMode: dry_run` explicitly.
Both the generated values and doge-config retain this choice, and prep applies
it to the fee-oracle environment. If an older doge-config has no write-policy
field, prep leaves the existing chart policy alone. This projection does not
grant writer permission, fund an account or execute a fee update. Other sampling
and update-policy settings remain template-owned.

## Bridge fee units

The examples select a 1 DOGE deposit fee (`depositFeeSats: "100000000"`),
a 0.1 DOGE withdrawal fee (`withdrawalFeeWei: "100000000000000000"`) and
a 1 DOGE minimum withdrawal (`minWithdrawalAmountWei: "1000000000000000000"`).
The generator multiplies deposit satoshis by 10^10 when writing
`contracts.DEPOSIT_FEE`, which uses L2 wei. Zero and integer precision are
preserved. The deprecated `fees.deposit` field retains its historical direct
wei meaning; converting to `depositFeeSats` requires dividing by 10^10.
These are explicit example policies, not a new fallback for omitted fees.

## Preserved service intent

`dogecoin.kubernetes` is copied into doge-config, including custom service and
RPC/ZMQ/P2P ports. The direct values generator and later reconciliation therefore
resolve the same in-cluster endpoint.

The following `ethereumDa` fields survive the default four-TOML generation path
and the direct `--with-values` path:

| Group | Fields |
| --- | --- |
| Confirmation | `confirmationDepth`, `finalizationDepth`, `confirmerPollIntervalMs` |
| L2 fetch | `l2RpcUrl`, `l2Confirmations`, `fetchLimit` |
| Fee limits | `maxBlobBaseFeeWei`, `maxFeePerGasWei`, `minPriorityFeeWei` |
| State paths | `submitterDbPath`, `lifecycleDbPath` |

Only explicit doge-config values replace corresponding existing submitter
settings during prep. Zero values are preserved. An explicit `submitterDbPath`
also supplies `lifecycleDbPath` when the latter is absent, consistently with
direct values generation. Custom submitter L2 RPC selection is retained through
both generic environment reconciliation and submitter-specific reconciliation.
Batch, publication, archive and proof-store inputs keep their existing paths.

## Initial signer selection

```yaml
bridge:
  initialAttestationKeyset:
    signerIds: [partner-c, partner-a]
    threshold: 1
```

The generator records the selected IDs and threshold in doge-config and uses
their count/threshold in setup defaults. IDs must be unique DNS labels and the
threshold must be between one and the selected signer count.

`setup attestation-signer` still requires real partner-generated public
descriptors. Without explicit selection flags, it preserves the configured
active set and its order rather than selecting every descriptor it imports.
Every selected ID must be present. Additional descriptors may be registered
without entering the initial active set. `--active-signer-ids` and `--threshold`
remain explicit operator overrides. A deployment without a configured active
set retains the command's existing selection behavior.

Identity provisioning, descriptor acquisition, Bridge initialization and proof
material preparation remain separate steps; recording intent does not perform
them. Do not rerun `generate-from-spec --force` over prepared identity/state
files as a substitute for a state-preserving update workflow.

## Proof intent handoff

When a spec includes `proofTopology`, configuration generation writes it to
`.data/doge-config.toml` as `[proof_topology]`. The accompanying
`[proofDeployment]` table retains the deployment name, coordinator settings
(including Secret references) and the selected public coordinator URL. Relative
material and identity paths remain relative to the deployment directory; the
generator does not copy or create those inputs.

This handoff works with a custom spec filename and a separate `--output`
directory. Subsequent proof commands do not need the original spec file.
An explicit `--spec` takes precedence. Otherwise the saved doge-config topology
is authoritative, and conventional `deployment-spec.yaml` / `.yml` discovery
is used only when that topology is absent. This ordering is the same whether
the calling command has already loaded doge-config or asks the resolver to read
it. Editing the original spec alone does not update the saved deployment intent.
`--values-only` does not create this handoff because it does not write TOML.

## Separate DA and proof buckets

The raw blob archive at `ethereumDa.blobArchive.s3.bucket` must have a different
bucket name from `proofArtifacts.s3.bucket` and any configured proof topology or
coordinator artifact bucket. Different key prefixes or endpoints do not satisfy
this requirement. Configured bucket names are checked even when proof is staged
in disabled mode. A missing store is still allowed while preparing an incomplete
spec; the command consuming it retains its existing required-field checks.

Spec validation compares resolved bucket environment references. Artifact-store
readers and `prep-charts` also reject shared bucket configuration. An archive
override through `setup eth-da-submitter` is checked before cloud provisioning
or saving the file. These checks do not migrate existing objects or change
existing bucket policies. Disabling archive writes remains available.

## Field validation and the TSO endpoint

Unknown fields are rejected before normalization, environment expansion or
output generation can silently discard them. Errors identify the field path,
including array indices, without printing its value. This applies to all CLI
output modes and direct config/values generation. Known retired service fields
still use the existing migration cleanup; declared legacy aliases retain their
existing behavior and semantic checks.

The full example no longer advertises unsupported cluster creation fields
(`nodeType`, `nodeCount`, `kubernetesVersion`, or GCP `machineType`). Provision
the cluster separately and reference it through the supported infrastructure
fields. Likewise, `contracts.l1FeeVaultAddr` and `bridge.baseFundingUtxos` were
previously ignored and now produce an unknown-field error; the fixed fee vault
and the setup funding-input workflow retain their existing behavior.

The field table is generated from `DeploymentSpec` and its referenced TypeScript
types. Object and array shapes are checked recursively; dictionaries such as
annotations, metadata tags and resource limits keep their arbitrary keys. This
is field/structure validation, not a replacement for semantic, required-input
or runtime acceptance checks. When changing the spec types, run
`npm run spec:fields` and include `src/generated/deployment-spec-fields.ts` in
the change. The build rejects a stale generated table.

`signing.tsoServiceUrl` was declared but never consumed. It is now explicitly
rejected with migration guidance. Set `frontend.hosts.tso` (or
`frontend.subdomains.tso` with `baseDomain`) for the public signer endpoint.
The WP and in-cluster CubeSigner continue using `http://tso-service:3000`;
a public hostname override does not redirect their internal traffic.

## Validation and remaining scope

`test/utils/spec-projection.test.ts` covers defaults and overrides, native
configuration handoff, non-default DA and Dogecoin settings, repeated real
chart reconciliation, invalid selections, and actual CLI descriptor import in
an isolated directory. Disposable descriptor keys are generated at runtime.
`test/utils/deployment-spec-fields.test.ts` covers nested typos, open
dictionaries, malformed containers, TSO migration guidance and rejection before
writing files in each CLI output mode. Controller validation retains its
existing error code for callers that distinguish controller configuration errors.

`test/utils/spec-workflow.test.ts` exercises actual CLI configuration generation,
local identity creation/import/reuse, KMS adapter calls and recovery, incompatible
identity rejection, bootstrap prerequisites, pinned template reads and policy
merging. KMS tests use a stubbed provider; they do not establish live AWS access.
The partner Phase A tests also check operator ownership of the policy directory.

Production acceptance still requires the deployment's actual cloud permissions,
funding transactions, genesis, protocol context, approved Reth binary and proof
materials. Mock/observe configuration tests do not establish real/enforce proving
or full deposit/block/proof/withdrawal acceptance.


## Start a fresh directory from a pinned SDK template

Plain generation remains a pure projection into TOML; `--with-values` also emits
service values. For a fresh deployment, `--bootstrap` provides the required SDK
base files as well:

```bash
scrollsdk setup generate-from-spec --spec /private/intent.yaml \
  --output /private/deployment --bootstrap --sdk-dir /path/to/scroll-sdk --dry-run
scrollsdk setup generate-from-spec --spec /private/intent.yaml \
  --output /private/deployment --bootstrap --sdk-dir /path/to/scroll-sdk
cd /private/deployment
scrollsdk setup gen-keystore --plan --json
scrollsdk setup gen-keystore -N --json
```

The spec must contain `templates.sdkRevision` (a full 40-character SDK commit),
`identities`, `proofTopology`, and explicit Reth image tags for RPC and each
selected node role. The commit must exist in `--sdk-dir`. Missing bootstrap
inputs are reported together before files are written. The CLI reads committed
Git objects, ignoring local edits; it does not fetch, install charts, provision
AWS resources or send transactions. The tag check rejects placeholders; release
approval and binary compatibility remain the operator's responsibility.

Bootstrap provides the Makefile, WP/PC native TOML, monitoring base values and
SDK example helpers. It merges generated service inputs into the pinned values,
retaining template-owned policies such as fee-oracle sampling/update settings,
resource requests, storage and placement. Explicit generated values win; named
environment entries merge by name. Makefile node install/delete targets and
required values follow the declared sequencer/bootnode counts. Review chart pins,
enabled optional services and operational policy before installation. The optional
capacity-manager service has no standard SDK release here; configuring dstack
does not implicitly configure capacity management.

`.data/spec-bootstrap.json` records the SDK revision, source template hashes and
stages still requiring execution. Bootstrap does not create fake genesis,
protocol context, contract deployment facts or proof artifacts. Generate these
with the commands in [setup order](setup-order.md) after identity preparation.
The fee-vault default is consistently projected into both Reth values and
`config.toml`, so reconciliation of a minimal spec uses the same address.

Use bootstrap once in a fresh private directory. Regeneration with `--force`
replaces configuration, including identity/state files; it is not an upgrade or
resume command. Resume identity preparation and later setup commands from their
saved outputs instead.

## Declare identity operations separately from configuration

The following intent matches one sequencer and one bootnode:

```yaml
identities:
  feeOracle:
    action: create
    backend: aws_kms
  ethDaSubmitter:
    action: reuse
    backend: aws_kms
    kms:
      keyId: EXISTING_KMS_KEY_ID
      roleArn: arn:aws:iam::000000000000:role/EXISTING_ROLE
  sequencers:
    - index: 0
      nodekey: {action: create}
      signer:
        action: import
        backend: local
        privateKeyEnv: SEQUENCER_SIGNING_KEY
  bootnodes:
    - index: 0
      nodekey: {action: create}
```

Provide real resource references privately. `privateKeyEnv` is the name of an
environment variable, not the key or a `$ENV:` expression. Configuration
projection saves this public intent without reading that variable or contacting
AWS. Supply the variable when applying `gen-keystore`. Every configured node
index must appear exactly once; the two service signers are required when the
identity block is present.

Local signers and nodekeys support create/import/reuse. Create preserves existing
saved identities on reruns; it never means rotate. Import resolves the declared
variable at application time and rejects a key that would replace an existing
identity. Reuse requires an already saved local key. An optional signer
`expectedAddress` checks imported/reused public identity; it is incompatible
with create.

KMS supports create/reuse. Create may allocate a KMS key and IAM role through the
existing provider; reuse requires both a key reference and a role ARN and reads
the key's public identity. Region and EKS cluster default from
`infrastructure.aws`; namespace and resource alias default from the deployment.
They can be overridden under `kms`, together with service-account name. These
inputs identify an existing cluster; they do not create one. Do not duplicate
KMS identities in `accounts.l1CommitSender` or `accounts.l2GasOracleSender`.

`setup gen-keystore` consumes saved intent automatically. `--from-spec` explicitly
selects another spec's identity intent. `--plan` reports selections without key
generation, writes or AWS access; it cannot verify a remote key's address. Actual
execution validates local inputs before applying tasks and saves each completed
service's resolved public address, key reference and role. A later failure can
resume from completed tasks. Backend/key replacement and conflicting explicit
flags fail rather than silently migrating an identity. As with existing provider
commands, an interruption during an AWS operation may require reconciliation of
that operation's resource before retrying.

Deployer/owner accounts retain the existing `--accounts` behavior. Explicit
`--accounts` without a service, node-count override or `--from-spec` prepares
only deployment accounts even when service identity intent is saved; it does not
provision the declared service KMS resources. `--no-accounts` selects service
identities only. Archive IAM/S3 reconciliation is separate:
`setup eth-da-submitter` configures archive access after signer preparation.
Partner attestation descriptors and CubeSigner sessions likewise come from their
own owners and setup steps; spec intent does not fabricate those credentials.

## Blob archive read URL and example fee units

For an enabled AWS S3 blob archive, `bucket` and `region` are required.
`publicBaseUrl` is optional: configuration and values generation derive
`https://<bucket>.s3.<region>.amazonaws.com` when it is omitted. An explicit
`publicBaseUrl` overrides the read origin, for example for a CDN or public gateway
serving the same objects. Keep `keyPrefix` separate; consumers append it. This
configuration does not grant bucket access. A custom S3-compatible write endpoint
is not necessarily its public read origin; provide the read URL explicitly there.

The example specs match the SDK's `config.toml.example` withdrawal policy:
`withdrawalFeeWei: "100000000000000000"` is 0.1 DOGE and
`minWithdrawalAmountWei: "1000000000000000000"` is 1 DOGE. L2 native amounts use
18 decimals, independently of Dogecoin L1's satoshi denomination.

## Derived endpoints and retired coordinator timing

Set `frontend.baseDomain` once. If omitted, `proofTopology.deployment.proverPublicUrl`
is derived from the selected frontend protocol and proof-coordinator host.
An enabled dstack ingress without explicit hosts uses `dstack.<baseDomain>`.
Explicit URL/host overrides take precedence; an explicit empty host list is still
invalid. These defaults are spec projections, not chart-default changes.

The retired `rollup.coordinator` collection timers are ignored when importing old
specs and no longer appear in generated config. `rollup` is optional and only
retains the supported verifier-digest overrides. The beta.6 native proof service
configuration is owned by its pinned compiler and templates.
