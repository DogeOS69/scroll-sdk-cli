# Deployment signing identities

`scrollsdk setup gen-keystore` prepares local keys or AWS KMS identities for
`sequencer-reth`, `bootnode-reth`, `fee-oracle`, and `eth-da-submitter`.
It writes canonical service identities to `.data/doge-config.toml`.
It does not generate Geth keystores, deploy services, upload Secrets, or configure
S3 archives.

## Select services

```bash
# Interactive: select services, node counts, and local keys or AWS KMS.
scrollsdk setup gen-keystore

# Process identities already declared in doge-config or service-account inputs
# imported from config.toml. Prepare/reuse the deployer if config.toml exists.
scrollsdk setup gen-keystore -N

# Fresh Reth nodes; counts select indices 0 through count-1.
scrollsdk setup gen-keystore --service sequencer-reth --sequencer-count 1 -N
scrollsdk setup gen-keystore --service bootnode-reth --bootnode-count 2 -N

# Select one node or service.
scrollsdk setup gen-keystore --service sequencer-reth --index 0 -N
scrollsdk setup gen-keystore --service fee-oracle --signer-backend local -N
scrollsdk setup gen-keystore --service eth-da-submitter --signer-backend local -N

# Use node counts from a DeploymentSpec whose configuration was already generated.
scrollsdk setup gen-keystore --from-spec deployment-spec.yaml -N
```

Without flags, the command opens a service selector with all four services
selected. For new node services it asks for the instance count (default 1),
and for new signers it asks for the backend and whether to generate or import
a local key. AWS KMS selection prompts for missing provisioning inputs.
Existing identities are reused without prompting to replace their keys.
Private-key import is masked. All choices and local identity checks complete
before any configuration is written or AWS provisioning begins; cancelling
an input prompt leaves files unchanged.

With `-N` or `--json`, no prompts are shown. Without `--service` or explicit
counts, these automation modes process only declared service identities;
they do not invent node instances. Output explicitly reports when only
deployment accounts were prepared.
A selected new node service defaults to index 0. Existing sparse indices are
preserved. A count that would remove an existing identity is rejected.

Use `--accounts` alone to prepare only the deployer, or `--no-accounts` to skip deployer preparation. A targeted `--service` operation
does not prepare deployment accounts unless `--accounts` is also supplied.
`--activity-helper` explicitly enables the optional testnet activity account.
With `--accounts`, an empty `OWNER_ADDR` defaults to the prepared deployer,
whose private key is already available. An explicit owner is never replaced.
Zero/invalid addresses and mismatched owner/deployer keys are rejected. If an
explicit owner has no matching local owner/deployer key, the CLI warns that
external wallet or multisig access must be confirmed before deployment.
No separate owner key is generated. `gen-l2-artifacts` and
`deployment-preflight` repeat the check. These checks cannot establish access
to an external wallet, and editing `OWNER_ADDR` never transfers an existing
contract's on-chain ownership.

## Local keys and KMS

A sequencer has two separate identities: its P2P nodekey and block-signing key.
A bootnode only needs a P2P nodekey. P2P nodekeys remain local Secret material,
including when the sequencer's block signer uses KMS.

```bash
scrollsdk setup gen-keystore --service sequencer-reth --index 0 \
  --signer-backend aws-kms \
  --aws-region us-east-1 --eks-cluster dogeos-devnet --network-alias devnet -N

scrollsdk setup gen-keystore --service fee-oracle \
  --signer-backend aws-kms \
  --aws-region us-east-1 --eks-cluster dogeos-devnet --network-alias devnet -N

# Import a local key without including the literal key in shell history.
scrollsdk setup gen-keystore --service eth-da-submitter \
  --signer-backend local --signer-private-key '$ENV:DA_SIGNER_PRIVATE_KEY' -N
```

The backend comes from the existing identity when omitted. Interactive execution
asks for the backend of a new signer; automation uses local signing unless
AWS KMS is explicitly selected. `--secret-mode` chooses
`external-secret` (default for new Reth keys) or `plain` for the selected node.
`plain` embeds key material into generated Helm values through the existing
chart Secret mechanism. `--signer-mode` remains available for Reth-specific
compatibility; do not combine it with `--signer-backend`.

An explicit KMS key, signer private key, nodekey, or backend override applies to
one selected identity. The CLI rejects reusing a single supplied key across a
multi-instance request. AWS provisioning uses existing deterministic resource
names and may create missing KMS keys and signing IAM resources. Completed KMS
identities are checked through their public keys on repeat execution, without
creating replacement keys. These checks require AWS read access.

Repeated preparation reuses existing keys and checks derived addresses. An
existing address without its required private key or KMS reference is an error.
Changing an established signing identity or P2P key is not an implicit operation;
plan identity migrations separately, including genesis and contract authorities.

The command validates selected local identities before writing and persists each
completed service. If a later provider operation fails, correct the failure and
rerun: earlier successful identities remain available for reuse. This is not an
atomic transaction across AWS and local files, and provider resources are not
deleted as an implicit rollback.

Use `--json` for one public result object; private keys are not printed. Keep the
private deployment configuration out of version control.

## Archive setup remains separate

The name `setup eth-da-submitter` is retained for archive configuration. It no
longer creates signing keys. Prepare its signer through `gen-keystore` first
when the archive should use that signer's IAM role:

```bash
scrollsdk setup gen-keystore --service eth-da-submitter \
  --signer-backend aws-kms \
  --aws-region us-east-1 --eks-cluster dogeos-devnet --network-alias devnet -N

scrollsdk setup eth-da-submitter \
  --archive-bucket dogeos-da --archive-region us-east-1 \
  --archive-key-prefix devnet --no-create-archive-bucket -N
```

Archive setup can create a missing bucket and attach its existing archive
GetObject/PutObject IAM policy to an existing writer role. `--role-arn` overrides
the writer role; otherwise the submitter's service-account role is used.
It does not change KMS keys, signer addresses, or role trust. Bucket creation
retains the previous default for a configured KMS submitter; for a local signer,
request it explicitly with `--create-archive-bucket`. Disabling the archive does
not delete buckets or policies. See [the archive guide](ethereum-da-s3.md) for
public-read configuration and proof storage integration.

Then run `setup gen-secrets` and `setup prep-charts`; use `setup push-secrets`
when ready to upload the generated credentials.

## Existing scripts

`setup l2-sequencer-reth`, `setup l2-bootnode-reth`, and `setup fee-oracle` remain
callable compatibility entrypoints, but are hidden from the main help and point
to `gen-keystore`. The old Geth `gen-keystore` behavior and its regeneration /
keystore-password flags are retired. Existing key files are not deleted.

Move signer-related flags previously passed to `setup eth-da-submitter` onto
`setup gen-keystore --service eth-da-submitter`; keep archive flags on the former.
