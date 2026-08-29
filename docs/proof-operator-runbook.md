# DogeOS Proof System Operator Runbook

This is the single official end-to-end runbook for the DogeOS bridge operator.
It covers proof configuration, partner attestation-signer handoff, Kubernetes
services, the external prover worker, and lifecycle acceptance for the
deployment-wide `disabled`, `mock`, and `production` proof postures. Production
configuration includes either a compiler-selected local Worker or a generated,
release-pinned external GPU Worker bundle.

This document is not for partner signer operators. Send partners the
`scroll-sdk/partner-kit/attestation-signer/` directory and, after bridge
genesis, the generated `signer-policy-bundle/`. For exact CLI flags, use
`scrollsdk <command> --help` or the generated command reference in the root
README instead of copying flag lists into this runbook.

## 1. Deployment boundary

| Component | Operator | Runtime |
|---|---|---|
| `attestation-signer` | each partner, or us following the same external-operator procedure | partner-owned Docker Compose host |
| `tso-service` | bridge operator | Kubernetes |
| `withdrawal-processor` | bridge operator | Kubernetes |
| `proof-coordinator` | bridge operator | Kubernetes |
| `prover-worker` | bridge operator / proving operator | Kubernetes on an ordinary node in mock; local or external GPU placement in production |
| L2 nodes, `l1-interface`, fee oracle, CubeSigner signer, supporting services | bridge operator | Kubernetes |

There is no attestation-signer Helm chart. The bridge operator never receives
a partner's private key and never deploys the partner's signer. The exchange is
artifact-based:

1. the partner sends `descriptor.json` before bridge genesis;
2. the bridge operator sends `signer-policy-bundle/` after bridge genesis.

## 2. Deployment-wide proof modes

One declarative compiler source controls the complete generated proof posture:
`.data/doge-config.toml [proof_topology].mode` in the normal operator flow, or
DeploymentSpec `proofTopology.mode` in the alternative automation flow. Both
stage mock and production blocks before initial deployment; defining both
authorities is rejected. The removed `proofSystem` source is not accepted.
`setup export-signer-policy` reads the same selected intent, so partners never
pass a separate proving-mode flag.

| Property | `disabled` | `mock` | `production` |
|---|---|---|---|
| Withdrawal proof runtime | off | on | on |
| Proof coordinator / worker | not required | complete real lifecycle | complete release lifecycle |
| Attestation signer | direct-sign | proof-backed validation | fail-closed proof enforcement |
| Signer policy | `dev_permissive`, proof fetch disabled | audited `staging_scaffold`, HTTP proof fetch | `production_enforce`, HTTP proof fetch |
| Proof bytes | none | deterministic, non-cryptographic | release prover output |
| Worker host | none | ordinary Linux allowed | GPU/release-specific host |
| Proof release files | staged but inactive | pinned release material when the selected mock profile materializes real statements | required reviewed release artifacts |

Mock is a lifecycle and configuration test lane. Never enable it on a bridge
that carries assets of value.

A disabled deployment may stage both artifact stores, release material,
digest-pinned Worker images, coordinator infrastructure, and the shared proof
resource PVC. These are dormant resource facts, not proof activation. Changing
only the authority's `mode` field selects them. The pinned dogeos-core compiler then
regenerates strict mode-specific WP, PC, Worker, and submitter projections; the
operator never edits those generated service files.

Configuration compilation is expected on every selected-mode generation.
Durable proof-layer regeneration is a different operation and occurs only when
the compiler rollout plan says the canonical proof-generation digest changed.
Worker drain/start/stop and moving from an ordinary mock host/node to the
production GPU host remain explicit operational actions.

Every active Worker must receive a Proof Coordinator URL over HTTPS. The only
plaintext exception accepted by dogeos-core is `http://127.0.0.1` behind an
explicit loopback tunnel; a cluster-local URL such as
`http://proof-coordinator:7788` is deliberately rejected. PC-to-WP can remain
plain HTTP on the trusted cluster link because the generated deployment
context records the separate explicit acknowledgements required by core.

## 3. Standard deployment layout

Run commands from one deployment root. Normal operation should not pass a list
of file paths. Run `setup prep-charts` with the deployment root as the current
working directory.

```text
deployment/
├── deployment-spec.yaml                 # optional alternative proof authority
├── config.toml
├── .data/
│   ├── doge-config.toml                  # normal proof authority
│   ├── proof-aws.json                    # stable AWS resource facts; active AWS modes
│   ├── proof-production/                 # absent for disabled/mock-only deployments
│   │   ├── software/                     # producer-supplied ProofSoftwareReleaseV1 tree
│   │   ├── bridge/                       # deployment-bound ProofBridgeMaterialV1 tree
│   │   └── scrollsdk-proof-production-inputs-v1.json
│   ├── proof-deployment.json             # generated deployment contract
│   ├── generated/proof-topology/         # validated dogeos-core compiler bundle
│   ├── setup_defaults.toml
│   ├── GenerateBridgeInfo.toml
│   ├── protocol_context.json
│   └── protocol_context.protocol_id
├── descriptors/                         # partner descriptor.json files
├── values/
│   ├── proof-coordinator-production.yaml
│   ├── prover-worker-production.yaml     # local Worker; replicas 0 when absent/external
│   ├── tso-service-production.yaml
│   └── withdrawal-processor-production.yaml
├── withdrawal-processor/
│   └── WithdrawalProcessor.toml
├── proof-coordinator/
│   └── ProofCoordinator.toml
├── prover-worker-production/            # generated for external production Worker
│   └── docker-compose/
└── signer-policy-bundle/                # generated after genesis
    ├── PARTNER-COMMANDS.md
    ├── advance-l2-agg-verifying-key.bin # production only
    ├── protocol_context.json
    ├── signer-policy.env
    ├── signer-policy.json
    └── signer-policy-manifest.json
```

For the selected proof topology, `prep-charts` gives the WP and PC base files to the pinned
compiler and atomically installs its complete strict outputs. It does not patch
mode-specific verifier or materializer blocks itself. The compiler also emits
generated materials beneath `.data/generated/proof-topology/materials`, a
Worker contract, submitter projection, resolved sidecar, and rollout plan.
Every signer operator maintains an independent `attestation-signer.toml` with
its Dogecoin, Ethereum, and L2 source sets plus rotation allowlists. The bridge
compiler does not invent or centralize partner RPC quorum policy.

`prep-charts` does not execute a durable proof database regeneration. When the
compiler plan reports `requires_proof_regeneration`, the CLI emits an explicit
warning and records the plan in the required-integrity bundle. Stop/drain the
old Worker and PC, perform the reviewed one-shot WP regeneration procedure,
and only then activate the new PC/Worker generation. Treating configuration
generation as proof-row regeneration is unsafe.

`withdrawal-processor/WithdrawalProcessor.toml` is different: it is a required
native application-config template supplied by
`scroll-sdk/examples/withdrawal-processor/WithdrawalProcessor.toml`. Copy the
scroll-sdk examples layout into a new deployment before running the CLI.
`prep-charts` does not create this file or embed its TOML in a values YAML
document. The compiler copies and renders it, and Helm receives the rendered
native file through a required-integrity `--set-file` binding.

## 4. Address contract

Agree all cross-operator addresses before a partner creates its descriptor.

| Address | Chosen by | Must be reachable from | Recorded in |
|---|---|---|---|
| signer ID | bridge + signer operator | n/a | `signer init --id`, descriptor |
| signer base URL | signer operator | TSO network | descriptor, WP `tsoSigners` |
| TSO callback base URL | bridge operator | signer network | policy bundle |
| proof-object GET root | bridge operator | worker and signer networks | WP proof config and policy bundle |
| proof-coordinator prover API | bridge operator | external worker host | worker bundle/config |

Production normally uses TLS domains. An isolated mock/VPN exercise may use a
private address such as `http://10.20.30.40:4040`. Never exchange `localhost`,
a Docker-only hostname, or a Kubernetes-only service name as a cross-operator
endpoint.

## 5. Phase A — collect partner descriptors before genesis

Send the partner the complete `scroll-sdk/partner-kit/attestation-signer/`
directory. The partner follows its README to:

1. initialize a local WIF or AWS KMS signer;
2. review the derived public key and endpoint in `descriptor.json`;
3. keep the generated partner-owned `attestation-signer.toml` private;
4. send `signer-<id>/descriptor.json` to the bridge operator.

Place all descriptors under the standard `descriptors/` directory, then import
and probe them before bridge genesis:

```bash
scrollsdk setup attestation-signer \
  --threshold <T> \
  --active-signer-ids <signer-a,signer-b,signer-c>
```

The command validates descriptor schema, network, endpoint, public-key curve
membership, and global uniqueness of signer IDs, keys, and endpoints. Current
dogeos-core requires canonical protocol context in every mode, so the signer
cannot start until the post-genesis bundle exists. Runtime public-key preflight
happens after bundle installation. Descriptor import itself makes no network
calls; after deployment the bridge operator also verifies each `/health`
endpoint from the TSO namespace.

The imported public keys are written to `.data/setup_defaults.toml` and enter
the bridge redeem script permanently at genesis. A later descriptor re-import
is not key rotation; rotation is an on-chain coordinated ceremony.

## 6. Generate bridge identity

Run the normal bridge initialization after descriptor import:

```bash
scrollsdk setup bridge-init -N --json --step all --seed <stable-seed>
```

Keep the same seed when retrying a funding-gated setup. The required downstream
identity outputs are:

```text
.data/GenerateBridgeInfo.toml
.data/protocol_context.json
.data/protocol_context.protocol_id
```

CubeSigner may return a 65-byte uncompressed SEC1 TEE public key. The CLI keeps
that original value as `public_key` for reconciliation and records
`public_key_compressed` as the DogeOS canonical identity. `setup_defaults.toml`
uses the compressed form for new deployments. Legacy uncompressed inputs are
accepted and canonicalized; the mathematical key, redeem script, bridge hash,
and protocol ID do not change.

## 7. Prepare Kubernetes and proof control-plane resources

Generate the base secrets first:

```bash
scrollsdk setup gen-secrets -N --json
```

For a mock or production AWS topology, provision the S3/IRSA proof bucket
roles, service accounts, and two distinct bearer tokens before generating
charts:

```bash
scrollsdk setup proof-aws-init
```

The interactive wizard presents the AWS region discovered from the environment
or AWS CLI configuration as an editable default, lists EKS clusters only after
the operator confirms that region, and presents the deployment directory name
as the editable deployment-instance alias. Dogecoin `mainnet` or `testnet` is
not a sufficient alias because either network can have multiple deployments.
An explicitly supplied flag skips only its corresponding prompt.

The wizard then selects one public proof-artifact read mode:

- `direct-s3` derives `https://s3.<region>.amazonaws.com`, keeps public ACLs,
  bucket listing, writes, and deletes blocked, and adds exactly one anonymous
  `s3:GetObject` statement for `<key-prefix>/*`;
- `existing-gateway` keeps S3 Public Access Block enabled and asks for the
  credential-free HTTPS S3-compatible gateway root reachable by external
  Workers and partner-operated Attestation Signers.

dogeos-core uses virtual-host addressing, so an existing gateway such as
`https://objects.example.com` must serve the deployment bucket at
`https://<bucket>.objects.example.com/<key-prefix>/...`.

By default the wizard also derives the EKS VPC and subnets, resolves the route
table actually used by each cluster subnet, reuses a regional S3 Gateway VPC
endpoint, or creates one when absent. `vpce-*` and `rtb-*` are not ordinary
operator inputs. Advanced overrides remain available for audited automation,
but are unnecessary in the normal flow.

For unattended automation, provide values that cannot be discovered or reused:

```bash
scrollsdk setup proof-aws-init \
  --non-interactive \
  --aws-region <region> \
  --eks-cluster <cluster> \
  --deployment-alias <unique-deployment-instance> \
  --artifact-public-read-mode direct-s3
```

To retain a private S3 origin behind an existing gateway instead:

```bash
scrollsdk setup proof-aws-init \
  --non-interactive \
  --aws-region <region> \
  --eks-cluster <cluster> \
  --deployment-alias <unique-deployment-instance> \
  --artifact-public-read-mode existing-gateway \
  --artifact-public-endpoint-url https://objects.example.com
```

This step is idempotent and writes only non-secret resource facts to
`.data/proof-aws.json`; it neither reads nor modifies `values/`. The
coordinator/WP control-plane token and the external prover-worker token are
separate credentials. Their Secrets Manager secret defaults to
`scroll/<deployment-alias>/proof-coordinator-secrets`, so separate DogeOS
deployment instances do not share proof tokens. In `direct-s3`, only proof objects below the selected
prefix are public: the CLI never grants anonymous `ListBucket`, `PutObject`, or
`DeleteObject`. It also refuses to disable public-policy blocking when an
unrelated wildcard grant is already present. AWS account-level Block Public
Access can still reject direct public reads; use `existing-gateway` or change
that account control deliberately rather than weakening it implicitly. In
`existing-gateway`, the bucket remains private and the endpoint is
operator-managed. The VPC endpoint bucket-policy statement remains restricted
by both `aws:SourceVpce` and `<key-prefix>/*`.

Neither mode is treated as reachable merely because provisioning succeeded.
Before proof activation, require HTTP 200 for one exact digest-scoped object
from every external Worker and partner Signer network. The CLI does not
provision the production GPU Worker and does not probe partner networks.

Only a deployment that will never use the AWS proof topology should skip
`proof-aws-init`. Resource preparation is valid while the selected mode is
disabled. For disabled/mock, the next step is directly
`setup doge-config --proof-topology`; `proof-release-init` is production-only.
Then run `prep-charts` as described in section 8. `prep-charts` fails if the native
WithdrawalProcessor template is absent. The maintained values template must
use the native-file layout and must not contain an inline
`configMaps.config.data.WithdrawalProcessor.toml` copy.

## 8. Select and generate the proof posture

The configured public endpoint must be a stable credential-free HTTPS
S3-compatible endpoint root. The compiler combines it with the bucket and
digest-scoped key prefix to produce concrete object URLs. External Workers use
those URLs to read inputs, and partner Signers receive them in signing requests
to fetch accepted proof artifacts. With prepared AWS resources,
`setup doge-config --proof-topology` reuses the endpoint recorded by
`proof-aws-init`; it does not ask the operator to enter it again.

Disabled and mock do not require a proof release manifest. Initialize them
directly:

```bash
scrollsdk setup doge-config --proof-topology --proof-mode mock
```

The wizard asks for the digest-pinned topology compiler and mock Worker images
when they are not already configured. Those are ordinary service-release
inputs. It writes a dormant mock profile even when the initial mode is
disabled. It does not ask for VKs, commitments, `.vmexe` paths, Bridge
material, a production Worker image, or a production PVC.

If production must be staged from the first deployment so that future
`disabled -> mock -> production` transitions change only `mode`, wait until
`.data/protocol_context.json` exists and obtain an extracted
`ProofSoftwareReleaseV1` directory from the proof software producer. Then run:

```bash
scrollsdk setup proof-release-init \
  --software-release /srv/dogeos-proof/software/proof-software-release-v1.json \
  --protocol-context .data/protocol_context.json
```

The command copies the software tree and runs its digest-pinned CPU Bridge
baker against the canonical protocol context. The bake compiles a
deployment-specific `.vmexe`, but performs no proof and requires no GPU. The
build is network-disabled and needs no host Rust installation. It installs
`ProofSoftwareReleaseV1`, `ProofBridgeMaterialV1`, and a local discovery receipt
under `.data/proof-production/`; it does not create a third deployment-lock
contract.

Now run:

```bash
scrollsdk setup doge-config --proof-topology
```

The initializer always writes and preflights the mock profile. If
`.data/proof-production/scrollsdk-proof-production-inputs-v1.json` exists, it
also validates the two dogeos-core manifests, writes the dormant production
profile, and preflights it before committing `.data/doge-config.toml`.
`--proof-production-inputs` selects a non-conventional prepared root or receipt.
The initial mode defaults to the existing value or `disabled`; an explicit
`--proof-mode` suppresses the mode prompt.

DeploymentSpec remains an alternative authority for automation-oriented
deployments. This abbreviated example shows its equivalent selection boundary;
use `src/config/deployment-spec.example.yaml` for the complete generated shape:

```yaml
proofTopology:
  # This is the only field changed for an ordinary mode transition.
  mode: disabled # disabled | mock | production
  compiler:
    image:
      repository: dogeos69/dogeos-proof-topology
      digest: sha256:<compiler-image-digest>
  deployment:
    resourcesMountPath: /app/data/proof-release
    resourcesPersistentVolumeClaim: dogeos-proof-release
  mock:
    profile: withdrawal_mock_prover
    artifactStore: {kind: local_fs}
    workerImage:
      repository: dogeos69/prover-worker-mock
      digest: sha256:<mock-worker-image-digest>
  production:
    profile: real_scroll_withdrawal_full_topology
    workerLaunch: external
    artifactStore:
      kind: s3_compatible
      bucket: dogeos-testnet-proofs
      region: us-west-2
      keyPrefix: proof-topology
      endpointUrl: https://s3.us-west-2.amazonaws.com
    release:
      resourcesRoot: .data/proof-production
      softwareRoot: software
      softwareManifest: software/proof-software-release-v1.json
      softwareReleaseDigest: sha256:<software-release-digest>
      bridgeRoot: bridge
      bridgeManifest: bridge/proof-bridge-material-v1.json
      bridgeMaterialDigest: sha256:<bridge-material-digest>
    realScroll:
      chunkWitnessSource: rpc
      chunkWitnessRpcUrl: https://l2-rpc.example.com
      s3PublicEndpointUrl: https://s3.us-west-2.amazonaws.com
```

The production Worker image, programs, VKs, commitments, and Bridge identities
come from the two manifests. The prepared `.data/proof-production/` directory
is the operator-host `resourcesRoot` mounted read-only into the compiler. For production, the
existing PVC must contain identical bytes at `resourcesMountPath` for WP, PC,
and any local Worker. External Worker launch uses the same runtime path
contract on its host. Mock does not mount dormant production programs.

The ordinary doge-config wizard derives `resourcesRoot` from the prepared inputs
and defaults `resourcesPersistentVolumeClaim=dogeos-proof-release`; it does not
ask the operator to invent a second release directory. Use
`--proof-resources-pvc` only when the deployment already has a different
storage convention. Creating the storage backend and copying the validated
release directory remain explicit infrastructure operations because the
correct ReadOnlyMany/RWX implementation is cluster-specific.

`.data/doge-config.toml [proof_topology]` and DeploymentSpec `proofTopology`
are alternative proof authorities. Defining both is rejected. There is no
separate `[proof_release]` wrapper. The production profile references the two
manifest roots and canonical digests directly; subsequent compilation
revalidates their files and protocol-context binding.

Disabled compiler mode still requires the WP base template but deliberately
does not open dormant profile resources. `setup doge-config --proof-topology`
preflights both profiles during initialization. They can also be revalidated
later without changing the selected mode:

```bash
scrollsdk setup proof-topology-compile --preflight mock
scrollsdk setup proof-topology-compile --preflight production
```

Preflight does not edit `proofTopology.mode`; its output is marked
`preflight_only` and cannot be installed. Ordinary compilation defaults to
`.data/generated/proof-topology` and supplies its previous `resolved-v2.json`
together with `bundle-manifest-v1.json` to derive topology and rendered-bundle
transition evidence.

### Temporary pre-Tsuki direct-sign recovery (Issue #843)

PR #847 adds a bounded, testnet-only recovery posture for already-persisted
pre-Tsuki work. It is not a fourth proof mode. Declare it only under disabled
mode, using the reviewed Tsuki-boundary L2 batch height:

```yaml
proofTopology:
  mode: disabled
  recovery:
    preTsukiDirectSignMaxEndBatchHeight: 6863
```

`setup prep-charts` writes the same pin to
`[proof_system.pre_tsuki_direct_sign].max_end_batch_height` in the native WP
TOML and `TSO_PRE_TSUKI_DIRECT_SIGN_MAX_END_BATCH_HEIGHT` in TSO values. The
schema-v5 compiler deployment contract records the pin and
`setup proof-config-check` rejects disagreement or residual runtime
configuration. `setup export-signer-policy` writes the same value as
`ATTESTATION_SIGNER_PRE_TSUKI_DIRECT_SIGN_MAX_END_BATCH_HEIGHT` in the Rust
attestation-signer policy bundle.

The CLI rejects this posture on mainnet, with mock/production mode, or with an
invalid/non-positive/u32-overflow pin. CubeSigner has no corresponding setting;
the attestation role requires the Rust signer. During the recovery window,
follow dogeos-core's PR #847 runbook for enable order, `/policy` capability
checks, the WP-only TSO `/propose` network boundary, completion, and reverse
retirement. Do not switch to proof mode until the authoritative completion
predicate is stable and the temporary pins have been removed.

Production consumes the producer-supplied software manifest and the CPU-baked
Bridge manifest directly. The operator does not transcribe their paths, hashes,
VKs, commitments, or image digests into `realScroll`. The prepared tree is:

```text
.data/proof-production/
├── software/
│   ├── proof-software-release-v1.json
│   └── <referenced files>
├── bridge/
│   ├── proof-bridge-material-v1.json
│   └── <referenced files>
└── scrollsdk-proof-production-inputs-v1.json
```

The receipt is local discovery metadata, not another proof contract. The
dogeos-core compiler validates both authoritative manifests and builds the
complete production service and Worker projection.

Now run the normal chart command for every mode:

```bash
scrollsdk setup prep-charts -N --json
```

`prep-charts` first performs its ordinary WP/TSO/chart work, then invokes the
digest-pinned dogeos-core compiler when `proofTopology` is present. It installs
only a fully validated, non-preflight bundle. The compiler-backed projection:

- replaces WP/PC native TOML with complete strict compiler outputs;
- mounts compiler-generated program manifests and statement namespace through
  required-integrity ConfigMap bindings;
- mounts the pre-populated release PVC at the source-declared runtime root;
- applies the compiler's digest-scoped submitter patch and proof-digest,
  deployment-revision, and bundle-revision rollout annotations;
- projects the exact Worker contract into local Worker Helm values or a
  manifest-bearing external Compose bundle without reconstructing argv;
- writes schema-v5 `.data/proof-deployment.json` with proof digest, deployment
  revision, rollout plan, compiler bundle, and Worker contract paths.

The schema-v5 deployment contract uses a fail-closed integrity boundary:

- Compiler-owned WP and PC files use required whole-file integrity.
- Proof manifests and other proof-critical `--set-file` inputs retain
  whole-file integrity and block installation when changed.
- WP, PC, Worker, submitter, and TSO values use required integrity because they
  carry mode, image, argv, namespace, recovery, or replica lifecycle state.
- The contract generation ID, proof mode/posture, required files, and worker
  bundle verification remain mandatory.

The proof digest identifies reusable proof work. The deployment revision also
captures Worker placement, while the bundle revision captures image, URL,
tuning, native config, and generated-material bytes. Consequently an image- or
URL-only change rolls the affected deployment even when it correctly leaves
the proof digest unchanged.

Compiler-owned native configs, Worker contract, bundle manifest, resolved
sidecar, rollout plan, and generated materials are required-integrity inputs.
Use `scrollsdk setup proof-config-check` before installation. Contract schemas
older than v5 are rejected and must be regenerated with `setup prep-charts`.

Missing selected endpoints, release material, or protocol context is rejected
before proof-owned files are committed. The complete command runs in
a copy-on-write generation workspace: ordinary chart changes, native TOML,
proof manifests, worker bundles, and the deployment contract are committed
together only after every step succeeds. On failure the staging workspace is
discarded and the deployment directory is unchanged. JSON output includes the
committed `generation.changedFiles` list.

The mode-agnostic Helm adapter consumes only this contract. Makefiles must not
select manifests or reinterpret disabled/mock/production state.

`prep-charts` reads `.data/proof-aws.json` when it exists and projects its
bucket, IRSA roles, service accounts, secret name, and region into the final
proof values before validation. It never treats an existing generated values
field as the source for those facts. With unchanged intent, resource facts,
templates, and release inputs, rerunning `prep-charts` is byte-idempotent and
reports an empty `generation.changedFiles` list.

For mock/production without a DeploymentSpec, `.data/proof-aws.json` is
required; `prep-charts` does not silently reuse infrastructure coordinates from
an earlier values output. A non-AWS `ambient` deployment declares its
`proofCoordinator` infrastructure explicitly in DeploymentSpec instead.

## 9. Prepare the selected prover Worker

The compiler decides Worker placement. Mock uses a local Kubernetes Worker;
production `workerLaunch: local_cpu|local_cuda` also uses a local Worker.
For either case, `prep-charts` writes
`values/prover-worker-production.yaml` directly from the compiler's image,
argv, environment, readiness path, and topology digest. The deployment
contract enables the local Helm component. No token hydration command is
needed: Kubernetes mounts the existing `prover-worker-token` Secret key at the
exact compiler-selected path.

For `workerLaunch: external`, `prep-charts` keeps the local Worker replica count
at zero and writes `prover-worker-production/docker-compose/`. First hydrate
its credential from the deployment root. `DOGEOS_PROVER_WORKER_TOKEN` may
supply the token; otherwise the command reads the existing proof secret from
AWS Secrets Manager:

```bash
scrollsdk setup proof-worker --deployment-dir .
```

This explicit second phase keeps deterministic configuration generation free
of secret reads. The stable bundle ID excludes the credential and does not
change when the raw `prover-worker.token` file is written with mode `0600`.

Sync both the selected `resourcesRoot` (the prepared `.data/proof-production/`
directory) and
`prover-worker-production/docker-compose/` to the GPU host while preserving
their relative layout. If the layout changes, pass the new root explicitly:

```bash
scrollsdk setup proof-worker-check \
  --bundle-dir prover-worker-production/docker-compose \
  --resources-root .data/proof-production \
  --expected-bundle-id <bundleId-from-proof-deployment.json>

docker compose --project-directory prover-worker-production/docker-compose config --quiet
docker compose --project-directory prover-worker-production/docker-compose up -d prover-worker
```

The check verifies the exact compiler Worker contract, digest-pinned image,
Compose and protocol-context hashes, generated material hashes, every
Worker-referenced release file, topology digest, bundle ID, and secret-file
mode without printing the token. Compose mounts release resources and generated
materials read-only, passes authentication through `--worker-token-file`,
publishes no inbound port, requests GPU access for a production build class,
and grants a seven-minute graceful stop window.

Validate the complete deployment contract before Helm installation. This also
validates and requires a hydrated external bundle when one is selected:

```bash
scrollsdk setup proof-config-check --deployment-dir .
```

## 10. Phase B — export and deliver signer policy

After bridge identity and proof topology are both staged, generate the common
policy bundle:

```bash
scrollsdk setup export-signer-policy
```

The command consumes canonical protocol context and the selected proof intent.
It derives the TSO URL and proof GET origin from deployment outputs. Production
copies the aggregate verifying key and both required program commitments from
the validated `ProofSoftwareReleaseV1`; operators do not repeat those identities
in `proofTopology.production.realScroll`. The output manifest records every
payload's SHA-256 and size.

The bundle deliberately does not contain partner RPC sources or rotation
targets. Each partner fills those in the `attestation-signer.toml` generated by
`signer init`. The retired verifier registry, generic source set, proof triples,
and TEE envelope allowlists are not accepted by the current signer.

Send the entire generated directory to every signer operator:

```text
signer-policy-bundle/
```

`PARTNER-COMMANDS.md` is the authoritative deployment-specific instruction
file. It contains the selected mode, signer IDs/endpoints/public keys, TSO URL,
proof GET root, partner apply commands, and bridge-side reachability probes.
The static partner README explains the generic process; do not maintain a
second set of deployment addresses by hand.

Partners run basic `signer preflight` after installing disabled/mock bundles.
For production they run `signer preflight --require-production-ready`, which
requires `/ready` HTTP 200, contract `attestation_evidence_v2`, disabled
scaffold bypasses, identity agreement, and all four production capabilities.

## 11. Install Kubernetes services

The canonical Helm invocations live in `scroll-sdk/examples/Makefile.example`.
With that Makefile copied into the deployment root:

```bash
make install-withdrawal-processor
make install-proof-coordinator
make install-prover-worker # skips automatically for disabled/external placement
make install-proof-submitter-projection
make install-tso
```

The WP, PC, local Worker, and compiler submitter-projection targets use
`scrollsdk helper proof-helm`. That
helper validates `.data/proof-deployment.json`, skips components marked absent,
and supplies every compiler-owned native file or generated material through
the contract's required-integrity `--set-file` bindings. Makefiles do not infer
mode, choose manifests, or reconstruct paths. Maintained values remain
responsible only for Kubernetes shape, Secret/ConfigMap/PVC mounting, and pod
placement; they contain no inline proof manifest.

Validate:

- WP readiness and proof-work API wiring;
- coordinator storage, auth, prover API, and verifier identities;
- TSO ingress and signer routing;
- pod access to S3 and Secrets Manager/ExternalSecret material;
- cluster-to-partner signer `/health` reachability.

Do the last check from the Kubernetes namespace, not only from a workstation:

```bash
kubectl -n <namespace> run signer-reachability-<id> --rm -i --restart=Never \
  --image=curlimages/curl:8.20.0 -- \
  curl -fsS https://signer.example.com:4040/health
```

## 12. Enter mock mode and run lifecycle acceptance

After all partners have applied the generated policy bundle, change only
`proofTopology.mode` from `disabled` to `mock`, then regenerate and install the
compiler projection.

```bash
scrollsdk setup prep-charts -N
scrollsdk setup proof-config-check --deployment-dir .
make install-proof-submitter-projection install-withdrawal-processor install-proof-coordinator install-prover-worker install-tso
```

Run a real L2 → Dogecoin withdrawal through the complete stack. Where the
deployment test accounts and contracts are prepared, the existing multi-
withdrawal case can be used:

```bash
scrollsdk test dogeos 4
```

A mock acceptance is not complete merely because files render or pods are
green. Collect evidence for every boundary:

1. WP submits real proof work to the coordinator.
2. The selected local or external worker claims work, heartbeats, and posts results.
3. The coordinator accepts receipts and WP observes readiness before signing.
4. TSO sends real `POST /sign` calls to descriptor endpoints.
5. Each signer fetches every concrete proof URL and validates size/SHA-256.
6. Each signer persists its request, policy verdict, and audit trail in SQLite.
7. Each signer submits its callback to the configured TSO address.
8. TSO accepts the Attestation-role callbacks.
9. The withdrawal completes beyond proof-file creation.

The partner commands and network directions are identical in mock and
production. Only the generated proof implementation and signer safety profile
differ.

## 13. Move mock to production

Prepare and preflight the dormant production block before allocating or
starting the GPU host. The only source edit is:

```diff
 proofTopology:
-  mode: mock
+  mode: production
```

The host move itself is an operational drain/start procedure, not an IP-address
edit in WP, PC, or Worker config:

1. Stop the local mock Worker Deployment from accepting new claims and let its
   SIGTERM drain finish. Scaling it to zero is an operational action.
2. Scale PC to zero and poll WP's read-only
   `GET /v1/proof-work/capacity/summary` endpoint until every family reports
   `active_leases == 0`.
3. Change the source mode, run `prep-charts`, inspect the rollout plan, and do
   not continue while any selected production input fails validation.
4. Apply `install-proof-submitter-projection`, then roll WP. If the plan requires
   proof regeneration, complete the reviewed one-shot WP procedure and remove
   its temporary declaration after the startup evidence is captured.
5. Install PC and verify that its reported topology digest equals WP and the
   deployment contract.
6. For `workerLaunch: external`, hydrate and sync the generated bundle plus the
   selected resources to host Y, run `proof-worker-check`, and start it there.
   For a local production Worker, apply `install-prover-worker` instead.
7. Require Worker readiness evidence to bind the expected digest, Worker ID,
   build class, and proving mode before resuming proof work and submission.

`install-prover-worker` applies a zero-replica projection when the selected
production Worker is external, so a previously installed local Worker cannot
remain accidentally active. The production PC URL, artifact endpoint, Secret
reference, image, argv, and resources mount all come from the pre-staged source
and compiler contract; operators do not reconstruct them on host Y.

## 14. Production limitation

The current Rust attestation signer implements the V2 AdvanceL1, AdvanceL2,
RotateKey, and RotateSequencerSigner evaluators. Production remains fail-closed
until all four report `production_serving`; use
`signer preflight --require-production-ready` as the deployment check.

Mock `staging_scaffold` uses deterministic non-cryptographic proofs.
AdvanceL1 never bypass-signs, while incomplete eligible AdvanceL2 and rotation
policies may use explicit audited scaffold bypasses. Mock success is therefore
not production evidence.

The separate CubeSigner/TEE production-policy path still has recorded
cryptographic-closure gaps in dogeos-core: deployed verifier-program/AggVK
provenance, namespace/policy evidence, restart ambiguity, and final E2E
evidence. Keep asset-bearing production activation blocked until the selected
dogeos-core release closes those gaps. A successful Rust-signer preflight does
not waive the CubeSigner boundary.

## 15. Troubleshooting

| Symptom | Action |
|---|---|
| descriptor import fails | validate the signer-init descriptor schema/network/key/endpoint and rerun `setup attestation-signer`; runtime preflight occurs after bundle installation |
| no external attestation signers | import descriptors before bridge genesis; doge-config must use `attestationSigner.mode = "external"` |
| missing `protocol_context.protocol_id` | rerun bridge-init protocol-context step with a current dogeos-core image |
| no staged proof GET base URL | verify the selected `proofTopology` artifact store/public endpoint, then rerun `setup prep-charts` |
| compiler preflight fails | fix only the selected dormant profile's missing release paths, identities, image, or endpoint; do not edit generated WP/PC files |
| compiled external Worker check fails | sync the generated Compose bundle and selected resources root together; pass `--resources-root` if their relative layout changed |
| production signer `/ready` returns 503 | inspect `/policy` capability blocks; fill that partner's three source sets and two rotation allowlists, verify the bundled AggVK/commitments, then rerun `signer preflight --require-production-ready` |
| proof AWS config missing during preparation | run `setup proof-aws-init` first, or restore the reviewed `.data/proof-aws.json` resource-facts file |
| materializer configuration rejected | verify the pinned release materials and rerun `setup doge-config --proof-topology` with the correct witness/RPC choice; do not edit generated PC materializer sections |
| signer health key differs from descriptor | stop; do not generate genesis with that descriptor |
| signer cannot fetch proof | inspect the full URL in the sign request from the signer host; verify DNS/TLS/object permissions |
| callback fails | test the generated TSO URL from the signer network and verify callback phase is `attestation` |

There is currently no application-layer authentication on the signer↔TSO HTTP
path. Use private connectivity such as VPN/WireGuard or an IP-allowlisted TLS
reverse proxy, and record the selected mechanism with each partner.
