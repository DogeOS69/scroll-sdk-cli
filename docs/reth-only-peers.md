# Reth-only peer configuration

For a fresh Reth-only deployment retaining legacy configuration keys, set this
explicit operator choice in root config.toml before setup prep-charts:

```toml
[sequencer]
L2_GETH_STATIC_PEERS = []
```

An explicit TOML array is authoritative, including an empty array. It prevents
prep-charts from deriving retired l2-sequencer-* peers from archived Geth node
keys. Reth peers still come from canonical doge-config sequencerReth instances.
Omitting the field preserves the legacy key-derived fallback; a populated list
continues to support deliberate mixed-client migration. Do not delete private
keys merely to suppress peer discovery, or hand-edit generated trustedPeers.

For native Reth genesis with no Geth migration, also explicitly disable the
operator-owned reth.extraArgs flag --network.legacy-geth-header-transform in
template and indexed values. That compatibility flag is for a one-way Geth
crossover, not fresh Reth operation. The deployment's 100Gi-per-node decision
belongs in reth.data.size in templates and generated values; it is not a new
global chart default. Record and validate those environment-specific choices.

After generation, reconcile deployment-specific Reth Secret paths with the
selective push-secrets step; generation may restore default remote paths.
