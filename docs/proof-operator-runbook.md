# DogeOS Proof System Operator Runbook

This is the single official end-to-end runbook for the DogeOS bridge operator.
It covers proof configuration, partner attestation-signer handoff, Kubernetes
services, the external prover worker, and lifecycle acceptance for the
deployment-wide `disabled`, `mock`, and `production` proof postures. Production
configuration includes a generated, release-pinned external GPU worker bundle.

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
| `prover-worker` | bridge operator / proving operator | external GPU host in production; ordinary Linux is sufficient in mock |
| L2 nodes, `l1-interface`, fee oracle, CubeSigner signer, supporting services | bridge operator | Kubernetes |

There is no attestation-signer Helm chart. The bridge operator never receives
a partner's private key and never deploys the partner's signer. The exchange is
artifact-based:

1. the partner sends `descriptor.json` before bridge genesis;
2. the bridge operator sends `signer-policy-bundle/` after bridge genesis.

## 2. Deployment-wide proof modes

One declarative proof intent controls the complete generated proof posture:
`proofSystem.mode: disabled|mock|production`. A DeploymentSpec is optional.
When one exists it is authoritative; otherwise the CLI reads
`[proofSystem]` from `.data/doge-config.toml`. If neither file declares proof
intent, proof defaults to `disabled`. `setup export-signer-policy` reads the
same selected intent, so partners never pass a separate proving-mode flag.

| Property | `disabled` | `mock` | `production` |
|---|---|---|---|
| Withdrawal proof runtime | off | on | on |
| Proof coordinator / worker | not required | complete real lifecycle | complete release lifecycle |
| Attestation signer | direct-sign | proof-backed validation | fail-closed proof enforcement |
| Signer policy | `dev_permissive`, proof fetch disabled | audited `staging_scaffold`, HTTP proof fetch | `production_enforce`, HTTP proof fetch |
| Proof bytes | none | deterministic, non-cryptographic | release prover output |
| Worker host | none | ordinary Linux allowed | GPU/release-specific host |
| Proof release files | none | synthesized mock manifests | required signed/reviewed release artifacts |

Mock is a lifecycle and configuration test lane. Never enable it on a bridge
that carries assets of value.

There is no stable “mock topology staged but proof disabled” state. Use
`disabled` until the deployment is allowed to run proof work, then change the
selected proof intent to `mode = "mock"` and rerun `setup prep-charts`. That
transition atomically enables the proof runtime,
coordinator contract, mock worker bundle, and signer-policy posture.

## 3. Standard deployment layout

Run commands from one deployment root. Normal operation should not pass a list
of file paths. Run `setup prep-charts` with the deployment root as the current
working directory.

```text
deployment/
├── deployment-spec.yaml                 # optional; never required for proof
├── config.toml
├── .data/
│   ├── doge-config.toml
│   ├── proof-aws.json                    # stable AWS resource facts; active AWS modes
│   ├── proof-deployment.json             # generated deployment contract
│   ├── setup_defaults.toml
│   ├── GenerateBridgeInfo.toml
│   ├── protocol_context.json
│   └── protocol_context.protocol_id
├── descriptors/                         # partner descriptor.json files
├── values/
│   ├── proof-coordinator-production.yaml
│   ├── tso-service-production.yaml
│   └── withdrawal-processor-production.yaml
├── withdrawal-processor/
│   └── WithdrawalProcessor.toml
├── proof-coordinator/
│   └── ProofCoordinator.toml
├── proof-artifacts/                     # proof inputs and generated JSON
│   ├── release.json                     # production only
│   ├── worker-release.json              # production image + artifact hashes
│   ├── manifests/
│   │   ├── scroll-chunk.json            # production only
│   │   ├── scroll-batch.json            # production only
│   │   ├── advance-l2-aggregation.json  # production only
│   │   ├── bridge-transition.json       # production only
│   │   └── statement-namespace.json     # generated; passed with --set-file
│   ├── chunk/                            # production worker program
│   ├── batch/                            # production worker program
│   ├── bridge/                           # bridge + standalone aggregation programs
│   └── mock-manifests/                   # generated in mock mode
│       ├── scroll-chunk-topology-program.json
│       ├── scroll-batch-topology-program.json
│       ├── advance-l2-aggregation-topology-program.json
│       └── bridge-topology-program.json
├── configs/
│   └── source-set.toml                  # production signer policy only
├── prover-worker-mock/                  # generated in mock mode
│   └── docker-compose/
├── prover-worker-production/            # generated in production mode
│   └── docker-compose/
└── signer-policy-bundle/                # generated after genesis
    ├── PARTNER-COMMANDS.md
    ├── signer-policy.env
    ├── signer-policy.json
    ├── verifier-registry.toml
    └── source-set.toml
```

`prep-charts` scaffolds a missing `ProofCoordinator.toml` and reconciles two
explicitly marked blocks on every subsequent run: the materializer runtime
derived from the native withdrawal-processor configuration, and the verifier
registry derived from the selected proof mode. Content outside those marked
blocks remains operator-owned. A legacy CLI scaffold is adopted once when its
shape is unambiguous; an unmarked hand-written materializer configuration is
rejected instead of being silently overwritten. Production
`configs/source-set.toml` must contain real RPC sources reachable from partner
signer networks. The CLI cannot safely invent production RPC quorum policy.

`withdrawal-processor/WithdrawalProcessor.toml` is different: it is a required
native application-config template supplied by
`scroll-sdk/examples/withdrawal-processor/WithdrawalProcessor.toml`. Copy the
scroll-sdk examples layout into a new deployment before running the CLI.
`prep-charts` does not create this file or embed its TOML in a values YAML
document; it only updates marked blocks in the existing native file. Helm
receives the file through `--set-file`.

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
2. start the Docker Compose service;
3. verify `/health` and its public key;
4. run `scrollsdk signer preflight`;
5. send `signer-<id>/descriptor.json` to the bridge operator.

Place all descriptors under the standard `descriptors/` directory, then import
and probe them before bridge genesis:

```bash
scrollsdk setup attestation-signer \
  --threshold <T> \
  --active-signer-ids <signer-a,signer-b,signer-c>
```

The command validates descriptor schema, network, endpoint, public-key curve
membership, and global uniqueness of signer IDs, keys, and endpoints. The
partner's preceding `scrollsdk signer preflight` is the public-key/runtime
probe. After Kubernetes deployment, the bridge operator separately verifies
each `/health` endpoint from the TSO namespace; descriptor import itself makes
no network calls.

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
scrollsdk setup proof-aws-init \
  --aws-region <region> \
  --eks-cluster <cluster> \
  --network-alias <network-alias> \
  --namespace <namespace>
```

This step is idempotent and writes only non-secret resource facts to
`.data/proof-aws.json`; it neither reads nor modifies `values/`. The
coordinator/WP control-plane token and the external prover-worker token are
separate credentials. The default
`--artifact-read-mode external` deliberately leaves credential-free GET under
operator control and reports it as unverified; a successful command means the
private bucket and IRSA path are ready, not that an external worker can read an
artifact.

To let workers/signers in audited private subnets read through an existing S3
Gateway VPC endpoint, explicitly provide the endpoint and every target-network
route table:

```bash
scrollsdk setup proof-aws-init \
  --aws-region <region> \
  --eks-cluster <cluster> \
  --network-alias <network-alias> \
  --namespace <namespace> \
  --artifact-read-mode vpc-endpoint \
  --artifact-read-vpc-endpoint-id vpce-... \
  --artifact-read-route-table-id rtb-0123456789abcdef0 \
  --artifact-read-route-table-id rtb-0fedcba9876543210
```

The CLI verifies an available regional S3 Gateway endpoint, associates only
the explicitly supplied route tables, and merges a fixed-Sid bucket-policy
statement restricted by both `aws:SourceVpce` and `<key-prefix>/*`. It preserves
unrelated bucket-policy statements and keeps all Public Access Block settings.
Both IRSA policies are also restricted to the key prefix, including an
`s3:prefix` condition for `ListBucket`. This is still `configured-unverified`:
from every worker/signer network, GET one exact existing artifact key and
require HTTP 200 before activation.

Disabled mode skips `proof-aws-init`. Next select the proof posture and run
`prep-charts` as described in section 8. `prep-charts` fails if the native
WithdrawalProcessor template is absent. If a legacy values file still contains
`configMaps.config.data.WithdrawalProcessor.toml`, the command removes that
inline copy only after confirming the native template exists; it never uses the
inline content to create the native file.

## 8. Select and generate the proof posture

The proof-object base URL must be a stable credential-free HTTP(S) GET root.
The worker uses it to read inputs and partner signers use concrete object URLs
carried in signing requests to fetch accepted proof artifacts.

For an AWS-native virtual-hosted or path-style S3 URL, `prep-charts` requires
the URL path to include the configured artifact-store `key_prefix`; passing
only the bucket root fails before any generated file is written. A custom HTTPS
gateway may intentionally map its own root to the prefix, so it remains
supported but emits a warning requiring an exact-key preflight from every
worker/signer network.

Declare only the proof intent. With DeploymentSpec:

```yaml
proofSystem:
  mode: mock # disabled | mock | production
  artifactReadBaseUrl: https://proofs.example.com/<deployment>
  # release: proof-releases/v2026.07.1 # optional; default is proof-artifacts
```

Without DeploymentSpec, use the equivalent legacy-compatible TOML:

```toml
[proofSystem]
mode = "mock"
artifactReadBaseUrl = "https://proofs.example.com/<deployment>"
# release = "proof-releases/v2026.07.1"
```

Do not maintain both sources independently. If DeploymentSpec and doge config
both contain proof intent, the CLI rejects disagreement instead of choosing
whichever command happened to run last.

Disabled mode may omit the entire block. It requires no artifact URL, release,
coordinator, proof storage, or worker. Mock and production require
`artifactReadBaseUrl`; the CLI gets the coordinator host and L2 chain ID from
the existing `config.toml`.

### Temporary pre-Tsuki direct-sign recovery (Issue #843)

PR #847 adds a bounded, testnet-only recovery posture for already-persisted
pre-Tsuki work. It is not a fourth proof mode. Declare it only under disabled
mode, using the reviewed Tsuki-boundary L2 batch height:

```yaml
proofSystem:
  mode: disabled
  preTsukiDirectSign:
    maxEndBatchHeight: 6863
```

The equivalent doge-config form is:

```toml
[proofSystem]
mode = "disabled"

[proofSystem.preTsukiDirectSign]
maxEndBatchHeight = 6863
```

`setup prep-charts` writes the same pin to
`[proof_system.pre_tsuki_direct_sign].max_end_batch_height` in the native WP
TOML and `TSO_PRE_TSUKI_DIRECT_SIGN_MAX_END_BATCH_HEIGHT` in TSO values. The
schema-v3 proof deployment contract records the pin and
`setup proof-config-check --strict` rejects disagreement or residual runtime
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

For a production release, the release-producing pipeline stages this
conventional worker layout:

```text
proof-artifacts/
├── chunk/app.vmexe
├── chunk/openvm.toml
├── batch/app.vmexe
├── batch/openvm.toml
└── bridge/
    ├── bridge-state.vmexe
    ├── openvm.toml
    ├── bridge-artifact-manifest.json
    ├── protocol_context.json
    ├── batch-aggregation.vmexe
    └── batch-aggregation-openvm.toml
```

The release producer runs one command to bind those files to the exact
all-family image:

```bash
scrollsdk setup proof-worker-release \
  --release-root proof-artifacts \
  --image dogeos69/prover-worker-cuda@sha256:<64-lowercase-hex>
```

This writes `worker-release.json` with all ten content hashes. Deployment users
do not repeat the image, artifact paths, hashes, bridge genesis context, or L2
chain ID.

Now run the normal chart command for every mode:

```bash
scrollsdk setup prep-charts -N --json
```

`prep-charts` first performs its existing ordinary WP/TSO/chart work, then
reconciles only the proof-owned overlay. It does not replace TSO or WP
non-proof parameters. The proof reconciliation:

- synthesizes all four mock manifests, or validates all four production program
  manifests plus release identities and aggregate-verifying-key checksums;
- updates the marked proof blocks in native WP/coordinator TOML;
- generates the matching credential-pending mock or production Compose bundle;
- removes inactive CLI-generated worker bundle directories, including any
  previously hydrated token, when the selected mode changes;
- writes `.data/proof-deployment.json`, including integrity metadata, intent
  source, mode, and worker bundle ID.

The deployment contract uses a risk-based integrity boundary:

- Proof-owned blocks inside WP and coordinator TOML are required to match.
  Changes elsewhere in those shared operational files produce a warning.
- Proof manifests and other proof-critical `--set-file` inputs retain
  whole-file integrity and block installation when changed.
- Helm values retain an observed checksum for diagnostics, but ordinary values
  drift produces a warning because WP and TSO also contain non-proof settings.
- The contract generation ID, proof mode/posture, required files, and worker
  bundle verification remain mandatory.

This allows operators to tune unrelated WP/TSO settings without regenerating
proof artifacts. Use `scrollsdk setup proof-config-check --strict` in an
immutable-artifact CI pipeline when any values or shared-config drift should
also fail. Contracts generated by the removed `setup proof-config` command are
still readable: drift in legacy WP/coordinator native config is advisory until
the next `setup prep-charts` writes a schema-v2 managed-block digest; legacy
proof manifests remain strict.

Missing worker ingress, L2 chain ID, or production `worker-release.json` is
rejected before proof-owned files are mutated. The complete command now runs in
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

## 9. Start the external prover worker

First hydrate the generated bundle from the deployment root. The token may be
supplied by `DOGEOS_PROVER_WORKER_TOKEN`; otherwise the command reads the
existing proof secret from AWS Secrets Manager:

```bash
scrollsdk setup proof-worker --deployment-dir .
```

This explicit second phase keeps deterministic K8s config generation free of
secret reads. The stable bundle ID does not change when the credential is
injected.

Validate the complete deployment contract and generated worker bundle before
Helm installation:

```bash
scrollsdk setup proof-config-check --deployment-dir .
```

The default check has the same installation-safe boundary as the Helm adapter:
warnings are reported but do not block ordinary operational changes. For a
release artifact that should be byte-for-byte immutable, run:

```bash
scrollsdk setup proof-config-check --deployment-dir . --strict
```

### Mock worker

Copy `prover-worker-mock/docker-compose/` to an ordinary Linux worker host:

```bash
scrollsdk setup proof-worker-check \
  --bundle-dir prover-worker-mock/docker-compose \
  --expected-bundle-id <bundleId-from-proof-deployment.json>
docker compose --project-directory prover-worker-mock/docker-compose config --quiet
docker compose --project-directory prover-worker-mock/docker-compose up -d
```

The generated `prover-worker.env` is mode `0600`. The mock worker advertises
chunk, batch, standalone AdvanceL2 aggregation, and bridge-transition
capabilities, but emits deterministic non-cryptographic proofs.

### Production worker

Sync both `proof-artifacts/` (or the selected release root) and
`prover-worker-production/docker-compose/` to the GPU host while preserving
their relative layout. Then:

```bash
scrollsdk setup proof-worker-check \
  --bundle-dir prover-worker-production/docker-compose \
  --release-root proof-artifacts \
  --expected-bundle-id <bundleId-from-proof-deployment.json>

cd prover-worker-production/docker-compose
docker compose --profile tools run --rm preflight
docker compose up -d prover-worker
```

The production check verifies the digest-pinned CUDA image reference, all ten
release files against `worker-release.json`, all four capability flags, L2
chain ID, endpoints, bundle ID, and the raw `prover-worker.token` mode without
printing its contents. Compose mounts the release read-only, passes the token
through `--worker-token-file`, supplies the bridge genesis context, and grants
a seven-minute graceful stop window for the worker's default drain timeout.
Override the default ID per host without editing generated files:

```bash
PROVER_WORKER_ID=gpu-worker-a docker compose up -d prover-worker
```

## 10. Phase B — export and deliver signer policy

After bridge identity and proof topology are both staged, generate the common
policy bundle:

```bash
scrollsdk setup export-signer-policy
```

The command derives bridge namespace, protocol ID, TSO URL, proof GET root, and
proof triples from standard deployment artifacts. It generates the verifier
registry directly from the staged proof triples.

- mock generates an empty e2e-harness source-set scaffold and leaves both TEE
  allowlists empty by default;
- production requires `configs/source-set.toml` and a non-empty TEE signer ID;
  legacy `04+X+Y` keys are validated and normalized to `02/03+X`.

Send the entire generated directory to every signer operator:

```text
signer-policy-bundle/
```

`PARTNER-COMMANDS.md` is the authoritative deployment-specific instruction
file. It contains the selected mode, signer IDs/endpoints/public keys, TSO URL,
proof GET root, partner apply commands, and bridge-side reachability probes.
The static partner README explains the generic process; do not maintain a
second set of deployment addresses by hand.

## 11. Install Kubernetes services

The canonical Helm invocations live in `scroll-sdk/examples/Makefile.example`.
With that Makefile copied into the deployment root:

```bash
make install-withdrawal-processor
make install-proof-coordinator
make install-tso
```

The WP and coordinator install targets must pass their native TOML and program
manifest JSON files with `--set-file`. `setup prep-charts` also writes the
derived statement namespace to `proof-artifacts/manifests/statement-namespace.json`
and returns every required key/path binding under `helmSetFiles` in JSON mode;
human output prints the same bindings. Values remain responsible for
Kubernetes shape, secret wiring, and the proof activation switch, and contain
no inline JSON document.

For the conventional production layout, the coordinator bindings are:

```bash
--set-file 'proofCoordinator.config.content=proof-coordinator/ProofCoordinator.toml' \
--set-file 'configMaps.manifests.data.scroll-chunk\.json=proof-artifacts/manifests/scroll-chunk.json' \
--set-file 'configMaps.manifests.data.scroll-batch\.json=proof-artifacts/manifests/scroll-batch.json' \
--set-file 'configMaps.manifests.data.bridge-transition\.json=proof-artifacts/manifests/bridge-transition.json' \
--set-file 'configMaps.manifests.data.statement-namespace\.json=proof-artifacts/manifests/statement-namespace.json'
```

The withdrawal-processor uses the same three manifests under
`configMaps.proof-manifests.data`, in addition to its native TOML binding.
Mock manifest paths and basenames differ; consume the bindings printed by the
command instead of hard-coding the production list. The rendered Kubernetes
ConfigMap necessarily contains the file bytes in YAML `data`; the maintained
values source does not.

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

After the worker is registered and all partners have applied the generated
policy bundle, select `mode = "mock"` and the proof artifact URL in the
DeploymentSpec or `.data/doge-config.toml`, then regenerate:

```bash
scrollsdk setup prep-charts -N
scrollsdk setup proof-config-check --deployment-dir .
make install-withdrawal-processor install-proof-coordinator install-tso
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
2. The external worker claims work, heartbeats, and posts results.
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

## 13. Production limitation

The current `dogeos-core` attestation signer reports cryptographic STARK
proof-byte verification, TEE receipt signature verification, and some external
source checks as `NotImplemented`. Consequently:

- mock `staging_scaffold` may audit and explicitly bypass those unfinished
  checks while still exercising all implemented checks and the full service
  flow;
- production `production_enforce` correctly refuses proof-backed signing until
  the selected signer release implements every production-required check.

Do not interpret successful mock lifecycle acceptance as cryptographic proof
verification or production readiness.

## 14. Troubleshooting

| Symptom | Action |
|---|---|
| descriptor import fails | validate schema/network/key/endpoint; run the partner `scrollsdk signer preflight`, replace the collected descriptor, and rerun `setup attestation-signer` |
| no external attestation signers | import descriptors before bridge genesis; doge-config must use `attestationSigner.mode = "external"` |
| missing `protocol_context.protocol_id` | rerun bridge-init protocol-context step with a current dogeos-core image |
| no staged proof GET base URL | configure `proofSystem.artifactReadBaseUrl`, then run `setup prep-charts` |
| no staged proof triples | verify the managed coordinator verifier block or production manifests |
| production source set missing | create `configs/source-set.toml` with real partner-reachable Dogecoin, Ethereum execution, and DogeOS L2 RPC sets |
| proof AWS config missing during preparation | run `setup proof-aws-init` first, or restore the reviewed `.data/proof-aws.json` resource-facts file |
| materializer configuration rejected | complete the hand-maintained coordinator materializer section; the CLI does not invent backend/RPC choices |
| signer health key differs from descriptor | stop; do not generate genesis with that descriptor |
| signer cannot fetch proof | inspect the full URL in the sign request from the signer host; verify DNS/TLS/object permissions |
| callback fails | test the generated TSO URL from the signer network and verify callback phase is `attestation` |

There is currently no application-layer authentication on the signer↔TSO HTTP
path. Use private connectivity such as VPN/WireGuard or an IP-allowlisted TLS
reverse proxy, and record the selected mechanism with each partner.
