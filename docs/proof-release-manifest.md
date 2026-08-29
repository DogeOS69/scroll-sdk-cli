# Proof inputs and ownership

The proof deployment has two deliberately different setup paths.

- `disabled` and `mock` use normal digest-pinned service images and do not
  require a proof release manifest.
- `production` additionally consumes two dogeos-core contracts:
  `dogeos/proof-software-release/v1` and
  `dogeos/proof-bridge-material/v1`.

There is no scroll-sdk deployment-lock schema and no data-only proof-release
OCI image. The dogeos-core topology compiler validates the two production
documents directly and projects their files, identities, and production Worker
image into strict WP, PC, Worker, and submitter configuration.

## Operator-owned inputs

The deployment operator chooses or supplies:

- the initial mode;
- the immutable topology-compiler image;
- the immutable mock Worker image;
- the S3-compatible artifact bucket, prefix, and read endpoint;
- the Proof Coordinator URL reachable by Workers;
- the canonical `.data/protocol_context.json` produced by Bridge setup;
- production Worker placement and witness source; and
- the cluster-specific read-only storage used for production materials.

The usual CLI interaction rule applies. An explicit flag suppresses its
prompt. If a flag is omitted, the wizard displays any existing or discovered
value as an editable default. Non-interactive mode requires every value that
cannot be recovered from existing configuration.

## Producer-owned production input

`ProofSoftwareReleaseV1` is a directory manifest supplied with its referenced
static files. It binds:

- chunk, batch, and L2-range `.vmexe` and OpenVM configuration files;
- the aggregate verification key;
- chunk and batch materializer binaries;
- reviewed chunk, batch, and L2-range proof identities;
- source/build identity; and
- immutable compiler, CPU Bridge baker, mock Worker, and production Worker
  image references.

The deployment CLI does not derive VKs or commitments and does not decide
which source revisions are compatible. It performs transport-oriented checks,
then the dogeos-core baker/compiler performs the authoritative validation.

`ProofBridgeMaterialV1` is deployment-bound because the Bridge guest embeds
the finalized protocol/genesis context. The normal operator flow creates it on
CPU with the digest-pinned baker selected by `ProofSoftwareReleaseV1`. No GPU
and no host Rust toolchain are required.

## Disabled/mock flow

After preparing the artifact store, initialize the topology directly:

```bash
scrollsdk setup proof-aws-init
scrollsdk setup doge-config --proof-topology --proof-mode mock
scrollsdk setup prep-charts -N
scrollsdk setup proof-config-check --deployment-dir .
```

When `doge-config` has no existing image defaults, it prompts for:

```text
dogeos-proof-topology compiler image: repository@sha256:...
mock prover-worker image:           repository@sha256:...
```

The generated topology contains a dormant mock profile even when the selected
mode is `disabled`. It contains no production profile, release path, production
PVC, Bridge material, or production Worker image.

## Adding production

Production preparation happens only after both an extracted software release
directory and the deployment protocol context are available:

```bash
scrollsdk setup proof-release-init \
  --software-release /srv/dogeos-proof/software/proof-software-release-v1.json \
  --protocol-context .data/protocol_context.json

scrollsdk setup doge-config --proof-topology --proof-mode disabled
scrollsdk setup prep-charts -N
scrollsdk setup proof-config-check --deployment-dir .
```

Without the two path flags, the interactive command asks for them and shows
conventional or previously prepared paths as defaults. `--bridge-material`
may import an already baked `ProofBridgeMaterialV1`; the normal path omits it
and runs the release-selected CPU baker through Docker.

`proof-release-init`:

1. loads the software manifest and verifies that all referenced files are
   regular, non-symlink files with matching byte lengths and SHA-256 values;
2. copies the software tree into a private staging directory;
3. runs the immutable baker with read-only software/protocol inputs, no
   network, no Linux capabilities, a read-only root filesystem, and a private
   output mount;
4. validates the resulting Bridge manifest and its software/protocol binding;
5. atomically installs the result; and
6. writes a local receipt used only to rediscover those two manifests.

The installed tree is:

```text
.data/proof-production/
├── software/
│   ├── proof-software-release-v1.json
│   └── <manifest-referenced static files>
├── bridge/
│   ├── proof-bridge-material-v1.json
│   └── <manifest-referenced Bridge files>
└── scrollsdk-proof-production-inputs-v1.json
```

The receipt is not a proof identity contract or a deployment lock. It records
the local paths and digests needed to rediscover the two authoritative
dogeos-core documents. `doge-config`, `prep-charts`, and
`proof-config-check` reload and validate the manifests rather than trusting the
receipt alone.

## Compiler boundary

For a production compile, scroll-sdk-cli invokes the pinned compiler with:

```text
dogeos-proof-topology compile \
  --source <generated-source.toml> \
  --deployment-context <generated-context.json> \
  --software-release-manifest <.../proof-software-release-v1.json> \
  --software-release-root <.../software> \
  --bridge-material-manifest <.../proof-bridge-material-v1.json> \
  --bridge-material-root <.../bridge> \
  --protocol-context-source <.../protocol_context.json> \
  --output <bundle>
```

The operator-facing production source stores only the manifest/root
references, their canonical digests, and deployment choices such as witness
source and Worker placement. Release-owned program paths, VKs, commitments,
Bridge identities, and the production Worker image must not be copied into
`doge-config.toml`; dogeos-core fills them after validating both manifests.

Mock/disabled compilation does not pass any of these production flags. The
compiler rejects production flags in a non-production selection and rejects a
production selection without both manifests and the protocol-context source.

## Production storage and mode changes

The local `.data/proof-production` tree is the validation source. Production
WP, PC, and a local Worker also need byte-identical static files at the
configured read-only runtime mount. The CLI records the existing PVC name
(default `dogeos-proof-release`) but does not choose a cluster-specific storage
implementation or upload the files. Populate that storage before production
activation.

After mock and production are both staged and preflighted, an ordinary mode
transition changes only:

```toml
[proof_topology]
mode = "production"
```

Then rerun normal generation/apply operations. Configuration regeneration is
expected: the compiler selects strict mode-specific daemon configs, service
lifecycle, Worker image/argv, and digest-scoped artifact prefixes. Preparing a
new software release or rebaking Bridge material is a release upgrade, not an
ordinary mode transition.
