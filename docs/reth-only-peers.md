# Pure Reth configuration

For database, Blockbook and frontend bridge API removal, see
[Configuration cleanup](config-cleanup.md).

L2 node identities now belong exclusively to `.data/doge-config.toml`.
Root `config.toml` no longer supplies Geth node keys or peer lists.
`gen-l2-artifacts` still projects the public index-0 Reth signer into
`sequencer.L2GETH_SIGNER_ADDRESS` for contracts compatibility. Existing root
private keys are preserved but ignored by Reth node setup.
There is no longer an empty-array switch or a Geth peer fallback.

## Setup flow

For external nodes, also follow [Reth bootnode public P2P access](bootnode-public-p2p.md):
the `setup bootnode-public-p2p` command is deprecated. Configure
`reth.p2pExternal` for selected bootnodes after `prep-charts`, deploy those
releases, then export public peers with `setup gen-rpc-package` once LB endpoints exist.

This is the node-configuration subset of [CLI setup order](setup-order.md),
not a complete deployment sequence.

After preparing the root accounts and doge-config, run:

```bash
# Deployment accounts only; add --activity-helper if required.
scrollsdk setup gen-keystore --accounts --non-interactive --json

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

`gen-keystore` is the unified identity entrypoint. Use `--service sequencer-reth`,
`--service bootnode-reth`, `--service fee-oracle`, or `--service eth-da-submitter`
to prepare one service. `--from-spec`, `--sequencer-count` and `--bootnode-count`
prepare Reth identities; they do not restore Geth keystore generation. Existing
identities are retained, and conflicting replacements are rejected. The direct
Reth commands above remain available. See [signing identities](keystore.md).

## Follower restart on signer rotation

Enable `--consensus.exit-on-signer-rotation` for Reth followers: internal RPC,
public RPC, and bootnodes. Add this item to each follower's existing
`reth.extraArgs` list in its deployment values:

```yaml
- "--consensus.exit-on-signer-rotation"
```

Preserve the other arguments when editing the list; Helm replaces lists rather
than appending to them. **Do not add this flag to sequencer values.** Reth rejects
it when sequencing is enabled; sequencer rotation remains a separate manual
operation.

The flag requires `--l1.url` and system-contract consensus (the node default).
Do not combine it with `--consensus.authorized-signer`, because a pinned signer
would stay pinned after restart. Once a follower confirms an authorized-signer
change from L1, it shuts down with exit code `70`. A supervisor must restart the
node so it can load the new signer. The SDK's Kubernetes workloads restart their
containers; retain that behavior when adapting the deployment.

For generated values, select a committed SDK template revision containing the
follower setting and review the output after `setup prep-charts` or `setup render`.
The CLI reads committed SDK templates, so editing an SDK working-tree file alone
does not change generation. Existing operator-owned `reth.extraArgs` lists are
preserved, including empty lists; add the flag explicitly to existing follower
values when needed. See [SDK template and runtime policy ownership](spec-projection.md#start-a-fresh-directory-from-a-pinned-sdk-template).

The standalone `dogeos-rpc-package` already includes the flag in
`scripts/l2reth_entrypoint.sh`. Its `l2reth-node` service uses
`restart: on-failure`, which restarts the process after exit code `70`.
`setup gen-rpc-package` exports node configuration; it does not replace the
package's entrypoint or restart policy. Keep both when adapting that package;
signer rotation does not require resetting chain data.

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
