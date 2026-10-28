# Export configuration for a self-contained RPC package

Use `scrollsdk rpc export-network` with the network-isolated layout of
`dogeos-rpc-package`. The existing `scrollsdk rpc export` remains available for
the older root Compose layout with `configs/<network>/` and `envs/<network>/`.
The new command does not migrate an installed RPC node or launch services.

Run from the source deployment directory:

```bash
scrollsdk rpc export-network \
  --dogeos-rpc-package-dir /path/to/dogeos-rpc-package \
  --doge-config .data/doge-config.toml \
  --values-dir values \
  --namespace default \
  --kube-context YOUR_SOURCE_CLUSTER_CONTEXT \
  --spec deployment-spec.yaml
```

`-d` points to the repository root, not its `testnet/` or `mainnet/` directory.
The network comes from `doge-config.network` and must match the L1 Interface
values. Only existing self-contained `testnet/` and `mainnet/` packages are
supported; the command never substitutes testnet for regtest or scaffolds a
network by copying another network's files.

Released L1 Interface versions such as beta.8 spell Dogecoin mainnet as
`bitcoin` in `NETWORK_STR`. That runtime spelling is accepted for a `mainnet`
DogeConfig and preserved in the generated environment; the output directory
remains `mainnet/`. It is not accepted for a testnet source.

The inputs are `genesis.yaml`, `protocol_context.yaml`,
`l1-interface-production.yaml`, and `l2-reth-rpc-production.yaml` under
`--values-dir`, plus the deployment's DogeConfig. Legacy genesis conversion also
requires `l2-rpc-production.yaml`. Peer discovery reuses the existing exporter:
Service-owned public endpoints come from Kubernetes, and independent NLBs come
from AWS using `--spec` (and optional `--aws-profile`). Already-public peers can
be exported without Kubernetes discovery. An unresolved or empty peer list is
an error. The package requires an enabled Ethereum DA S3 blob archive.

When `--spec` is supplied, its enabled existing-NLB entries select the AWS
resources to read, even if saved Helm values still have `p2pExternal.enabled:
false` from before activation. This only reads endpoint metadata; it does not
enable bindings or change network access. Without a spec, enabled existing-NLB
references in values remain an error requiring `--spec`.

For testnet, the destination files are:

```text
dogeos-rpc-package/
└── testnet/
    ├── docker-compose.yml       # Only the two runtime image fields are updated
    └── config/
        ├── l2reth-genesis.json
        ├── protocol_context.json
        ├── l1-interface.env
        └── l2reth.env
```

The four chain configuration files and both image references are validated
before the destination is written. Repeating the export with the same inputs
produces the same content. Chain configuration files are fully regenerated;
operator changes belong in the network's `.env` instead. Other networks,
`dogecoin.conf`, `.env`, `env.example`, scripts, volumes, bootstrap services,
snapshots, data and P2P identity files are not changed. No cluster Secret is fetched.

Runtime images follow the same source values as the exported configuration:

| Source values | Compose service |
| --- | --- |
| `l2-reth-rpc-production.yaml` → `image` | `l2reth-node.image` |
| `l1-interface-production.yaml` → `image` | `l1-interface.image` |

`image.repository` and `image.tag` produce `repository:tag`. If an explicit
`image.digest` is supplied, `repository@sha256:…` takes precedence. Missing or
invalid versions fail before output is written; package placeholder images are
never silently retained. The exporter preserves Compose formatting, comments,
anchors and scripts outside those two image lines, and verifies that only the
two image fields changed semantically. It reads the selected local values;
it does not select a newer image or pull images from a registry.

The new exporter translates cluster paths to the package's fixed layout:

| Setting | Exported value |
| --- | --- |
| L1 database | `sqlite:///data/l1-interface.sqlite` |
| Replay database | `/data/replay.sqlite` |
| Protocol context | `/app/protocol_context.json` |
| Genesis | `/app/genesis/genesis.json` |
| Testnet historical artifact | `/data/l1-interface-historical-artifact.sqlite` |
| L2's L1 endpoint | `http://l1-interface:8545` |
| L2's L1 readiness endpoint | `http://l1-interface:9090/api/v1/health/ready` |
| Public peer variable | `L2RETH_PEER_LIST` |

L1 Interface sequencer genesis mode is forced off. Cluster Dogecoin credentials,
provider RPC endpoints, secret-like environment fields and retired Celestia
settings are excluded. Credential-bearing or parameterized URLs in exported
environment settings are rejected without displaying their values.

Set `DOGEOS_ETHEREUM_RPC_URL` in `<network>/.env` after export, even if the
previous package configuration supplied a default RPC. The exporter does not
copy the source cluster's provider endpoint or preserve a previous generated
default. Configure `DOGEOS_EXTERNAL_DOGECOIN_RPC_*` there only when deliberately
using an external Dogecoin node; otherwise the package uses its bundled node
and operator-provided Docker secrets.

Follow the destination network README for static Compose checks, P2P identity,
allowlisting, startup and acceptance. The command deliberately does not copy
Kubernetes initContainers into Compose: the new package owns its ordered
startup, checksum-verified bootstrap and snapshot workflow. Release maintainers
must ensure that the exported images, historical bootstrap artifacts and
snapshot groups match the exported chain configuration.

Mainnet configuration export is a maintainer preparation step, not a claim
that mainnet is released. Mainnet input must not contain testnet historical
bootstrap settings. Its package release checklist still controls image/script
compatibility, fresh-genesis replay initialization and end-to-end verification.
