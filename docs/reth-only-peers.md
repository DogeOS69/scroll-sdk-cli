# Pure Reth configuration

For database, Blockbook and frontend bridge API removal, see
[Configuration cleanup](config-cleanup.md).

L2 node identities now belong exclusively to `.data/doge-config.toml`.
Root `config.toml` does not need `[sequencer]`, `[bootnode]`, any `L2GETH_*`
keys, or `L2_GETH_STATIC_PEERS` / `L2_GETH_PUBLIC_PEERS`.
Existing root keys are preserved but are ignored by node setup and generation.
There is no longer an empty-array switch or a Geth peer fallback.

## Setup flow

For external nodes, also follow [Reth bootnode public P2P access](bootnode-public-p2p.md):
run `setup bootnode-public-p2p` after `prep-charts`, deploy the bootnode releases,
then export public peers with `setup gen-rpc-package` once LB endpoints exist.

This is the node-configuration subset of [CLI setup order](setup-order.md),
not a complete deployment sequence.

After preparing the root accounts and doge-config, run:

```bash
# Deployment and activity accounts only. Requires accounts.OWNER_ADDR.
scrollsdk setup gen-keystore --non-interactive --json

# Run once for each desired sequencer index; index 0 supplies the RPC signer.
scrollsdk setup l2-sequencer-reth --index 0 --signer-mode external-secret --non-interactive
scrollsdk setup l2-bootnode-reth --count 1 --secret-mode external-secret --non-interactive

# After bridge-init and service signer setup have produced their required inputs:
scrollsdk setup prep-charts --non-interactive
scrollsdk setup gen-secrets --non-interactive
```

For sequencer KMS signing, use `setup l2-sequencer-reth --signer-mode aws-kms`
and its KMS/IRSA options. `setup eth-da-submitter / setup fee-oracle` still configures application
signers such as the DA submitter and fee oracle. These are independent of the
Reth block signer and P2P key. The bridge's Dogecoin sequencer transaction and
signing material are also independent and remain required.

`gen-keystore` reuses existing account private keys, validates their projected
addresses, and generates missing deployment/activity keys. It no longer accepts
Geth node count/password/regeneration flags or `--from-spec`; it no longer writes
node metadata or deployment-state.yaml. `--no-accounts` is a no-op. To retain a
specific node identity, supply it to the Reth setup command with `--nodekey` and,
for a local sequencer signer, `--signer-private-key`.

## Generated files and peer sources

- `gen-secrets` emits `l2-reth-sequencer-N-secret.env` and
  `l2-reth-bootnode-N-secret.env` from configured Reth instances. It stops emitting
  old `l2-sequencer-N-secret.env` and `l2-bootnode-N-secret.env`.
- `push-secrets` skips old Geth node secret files during batch uploads and rejects
  explicitly selecting one. Local files and previously uploaded secrets remain
  intact; no remote key or live Kubernetes resource is deleted.
- `prep-charts` constructs `reth.trustedPeers` exclusively from Reth sequencers.
  Archived root Geth peers and keys cannot enter this list.
- `generate-from-spec --with-values` emits native `l2-reth-*` templates, including separate internal witness and public RPC nodes. Only the public RPC gets ingress; it excludes the debug API. Set
  `images.services.l2Sequencer`, `l2Bootnode`, and `l2Rpc` to the Reth image/tag
  intended for the deployment. Defaults deliberately retain a tag placeholder.
  The spec's old node metadata is not projected into root Geth configuration.
- `prep-charts` and values generation archive retired `l2-{sequencer,bootnode,rpc}`
  production YAML under `values/.retired-geth/values-*/`, with `.bak` extensions,
  so old values cannot be picked up as active deployment files. The backup
  directory may contain private keys; retain the same access restrictions as
  the source configuration.
- `bootnode-public-p2p --doge-config ...` uses actual Reth bootnode indices and
  modifies native Reth P2P values. Missing topology fails instead of defaulting
  to two bootnodes. AWS provisioning itself still requires the normal cloud
  prerequisites; GCP remains unimplemented.

`gen-rpc-package` reads the L1 endpoint and network ID from
`l2-reth-rpc-production.yaml`. External peers come from Reth bootnodes, or from
Reth trustedPeers if no bootnodes are configured. It no longer requires Geth RPC
values for native genesis. `L2RETH_VALID_SIGNER` comes only from
`sequencerReth.instances[index=0].signer.address`; malformed, zero, duplicated,
or missing index 0 among configured sequencers causes an error. With no
sequencers configured, it warns and removes any stale signer from the exported
file. The contract deployment itself does not require this signer address.

The RPC package still uses the historical environment name `L2GETH_PEER_LIST`
because its Reth entrypoint consumes that name. Its value contains only the
Reth peer sources above. Importing legacy genesis retains a separate compatibility
conversion; this does not restore Geth node configuration generation.

For native Reth genesis, new generated values explicitly set
`--network.legacy-geth-header-transform false`. Existing Reth values retain their
operator settings: set this flag to `false` for a fresh native deployment.
Storage size, image versions, public endpoints, and secret provider paths remain
deployment-specific settings. The `l2-rpc` service alias remains available for
applications using the shared `L2_RPC_ENDPOINT`.
