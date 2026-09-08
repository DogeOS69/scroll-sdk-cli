# Legacy contracts compatibility without exporting a service key

This is an opt-in compatibility mode for **DogeOS testnet/regtest L2-only
deployment**, not a general-purpose KMS workaround for Scroll L1 contracts.

The contracts release at `28f6ca9c44196d63bd39f3ea5e9e3227051332fa` requires
`accounts.L1_COMMIT_SENDER_PRIVATE_KEY` and verifies that it derives
`accounts.L1_COMMIT_SENDER_ADDR`, even when generating L2 genesis. Its deploy
entrypoint first simulates with layer `None`, then simulates/broadcasts only
layer `L2`; its L1 broadcast command is commented out. The legacy
`initializeScrollChain()` sender authorization is not broadcast in this flow.
Audit this boundary again before changing the contracts image or entrypoint.

For this specific deployment mode, put this **public, unfunded test vector**
in root `config.toml`:

```toml
[accounts]
L1_COMMIT_SENDER_ADDR = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
L1_COMMIT_SENDER_PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001"

[contracts]
LEGACY_COMMIT_SENDER_PLACEHOLDER = true
```

Merge these fields into the existing sections; do not duplicate TOML sections.
This key is public and has no confidentiality or account-security properties.
Never send funds to or grant on-chain permissions to this address.

The actual service identity remains exclusively in `.data/doge-config.toml`:
`[signers.l1CommitSender]` and its `[accounts]` address projection. Configure
it using `setup eth-da-submitter`, including the real KMS key and IAM role.
Do not copy the placeholder into that file. KMS mode has no local private key.

Run `setup gen-l2-artifacts --doge-config .data/doge-config.toml` with the
approved exact contracts image tag. Generation validates the placeholder pair,
restricts this mode to testnet/regtest, and checks that the real service
identity is valid, internally consistent and different from the placeholder.

`setup gen-secrets` supplies the public compatibility private key **only** to
the contracts Secret. It still produces no submitter private-key Secret in
KMS mode. `setup prep-charts` reads the real canonical signer for both the
submitter and Withdrawal Processor's `expected_batchers`; do not hand-edit
those generated outputs to match root config's compatibility address.

`helper fund-accounts` refuses implicit/L1 service funding while this mode is
enabled, since its legacy root-config target is the placeholder. L2 account
funding (`--layer 2`) and explicit deployer funding remain available. Fund the
real DA sender separately on its configured Ethereum DA network. Do not use
root config's commit address for monitoring the actual submitter balance.

Acceptance checks:

- The unchanged contracts image generates L2 artifacts successfully.
- L2 genesis chain ID, sequencer signer and commitments remain correct.
- Runtime submitter and WP allowlist select the real signer, not the placeholder.
- Contracts Secret contains the public compatibility key; the KMS service does not.
- No L1 Scroll deployment/authorization is broadcast using the placeholder.

This does not remove other legacy contracts account inputs, authorize L1
deployment, or make the complete deployment pass without subsequent chart,
secret, runtime and end-to-end checks.
