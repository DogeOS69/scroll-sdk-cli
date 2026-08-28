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
`proofTopology.mode: disabled|mock|production`. A compiler-backed deployment
uses DeploymentSpec as its authority and stages both the mock and production
blocks before initial deployment. `proofSystem` remains a legacy compatibility
source for deployments that have not adopted the dogeos-core compiler. Never
declare both. `setup export-signer-policy` reads the same selected intent, so
partners never pass a separate proving-mode flag.

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

A disabled deployment may stage both artifact stores, release material,
digest-pinned Worker images, coordinator infrastructure, and the shared proof
resource PVC. These are dormant resource facts, not proof activation. Changing
only `proofTopology.mode` selects them. The pinned dogeos-core compiler then
regenerates strict mode-specific WP, PC, Worker, and submitter projections; the
operator never edits those generated service files.

Configuration compilation is expected on every selected-mode generation.
Durable proof-layer regeneration is a different operation and occurs only when
the compiler rollout plan says the canonical proof-generation digest changed.
Worker drain/start/stop and moving from an ordinary mock host/node to the
production GPU host remain explicit operational actions.

## 3. Standard deployment layout

Run commands from one deployment root. Normal operation should not pass a list
of file paths. Run `setup prep-charts` with the deployment root as the current
working directory.

```text
deployment/
├── deployment-spec.yaml                 # authority for compiler-backed proof
├── config.toml
├── .data/
│   ├── doge-config.toml
│   ├── proof-aws.json                    # stable AWS resource facts; active AWS modes
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
├── proof-artifacts/                     # proof inputs and generated JSON
│   ├── release.json                     # optional legacy release metadata
│   ├── chunk/                            # production worker program
│   ├── batch/                            # production worker program
│   ├── bridge/                           # bridge + standalone aggregation programs
├── configs/
│   └── source-set.toml                  # production signer policy only
├── prover-worker-production/            # generated for external production Worker
│   └── docker-compose/
└── signer-policy-bundle/                # generated after genesis
    ├── PARTNER-COMMANDS.md
    ├── signer-policy.env
    ├── signer-policy.json
    ├── verifier-registry.toml
    └── source-set.toml
```

For `proofTopology`, `prep-charts` gives the WP and PC base files to the pinned
compiler and atomically installs its complete strict outputs. It does not patch
mode-specific verifier or materializer blocks itself. The compiler also emits
generated materials beneath `.data/generated/proof-topology/materials`, a
Worker contract, submitter projection, resolved sidecar, and rollout plan.
Legacy `proofSystem` deployments retain the marked-block renderer described by
older contracts. Production `configs/source-set.toml` must still contain real
RPC sources reachable from partner signer networks; the compiler does not
invent signer RPC quorum policy.

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

Only a deployment that will never use the AWS proof topology should skip
`proof-aws-init`. Resource preparation is valid while the selected mode is
disabled. Next select the proof posture and run `prep-charts` as described in
section 8. `prep-charts` fails if the native
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

For a compiler-backed deployment, declare the digest-pinned compiler and stage
both profiles in DeploymentSpec. This abbreviated example shows the selection
boundary; use `src/config/deployment-spec.example.yaml` for the full production
`realScroll` resource/identity shape:

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
    profile: cheap_scroll_chunk
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
    workerImage:
      repository: dogeos69/prover-worker
      digest: sha256:<production-worker-image-digest>
    realScroll:
      resourcesRoot: proof-artifacts
      # release-relative paths and reviewed identity pins follow
```

The compiler image must come from the same dogeos-core release as WP, PC,
Worker, and submitter. `resourcesRoot` is the operator-host directory mounted
read-only into the compiler. The existing PVC must contain identical release
content at `resourcesMountPath` for WP and PC. External Worker launch uses the
same runtime path contract on its host.

Legacy deployments may continue to use the old non-compiler source:

```toml
[proofSystem]
mode = "mock"
artifactReadBaseUrl = "https://proofs.example.com/<deployment>"
# release = "proof-releases/v2026.07.1"
```

Do not maintain `proofSystem` and `proofTopology` independently. The CLI rejects
both in one DeploymentSpec. Generated doge-config carries only the selected
mode/recovery compatibility projection; dormant compiler profiles remain in
DeploymentSpec and are never flattened into native daemon config.

Disabled compiler mode still requires the WP base template but deliberately
does not open dormant profile resources. Validate them before deployment with:

```bash
scrollsdk setup proof-topology-compile --preflight mock
scrollsdk setup proof-topology-compile --preflight production
```

Preflight does not edit `proofTopology.mode`; its output is marked
`preflight_only` and cannot be installed. Ordinary compilation defaults to
`.data/generated/proof-topology` and uses its previous `resolved-v1.json` to
derive the transition plan.

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
schema-v4 compiler deployment contract (schema v3 for the legacy renderer)
records the pin and
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

For a production release, the release-producing pipeline stages the paths and
identities declared in `proofTopology.production.realScroll`. A conventional
worker layout is:

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

Compiler-backed deployments do not use `worker-release.json` as a second
authority. Release-relative paths and reviewed VK/commitment identities come
from `proofTopology.production.realScroll`; the selected digest-pinned image
comes from `proofTopology.production.workerImage`. The dogeos-core compiler
validates the selected files and builds the complete Worker argv contract.
`setup proof-worker-release` remains only for legacy `proofSystem` deployments.

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
- applies the compiler's digest-scoped submitter patch and rollout annotation;
- projects the exact Worker contract into local Worker Helm values or a
  manifest-bearing external Compose bundle without reconstructing argv;
- writes schema-v4 `.data/proof-deployment.json` with proof digest, deployment
  revision, rollout plan, compiler bundle, and Worker contract paths.

The deployment contract uses a risk-based integrity boundary:

- Compiler-owned WP and PC files use required whole-file integrity. The legacy
  renderer retains its managed-block compatibility boundary.
- Proof manifests and other proof-critical `--set-file` inputs retain
  whole-file integrity and block installation when changed.
- Compiler-backed WP, PC, Worker, and submitter values use required integrity
  because they carry mode, image, argv, namespace, or replica lifecycle state.
  TSO values retain an observed checksum for diagnostics; ordinary TSO drift
  is a warning unless strict validation is selected.
- The contract generation ID, proof mode/posture, required files, and worker
  bundle verification remain mandatory.

Compiler-owned native configs, Worker contract, bundle manifest, resolved
sidecar, rollout plan, and generated materials are required-integrity inputs.
Use `scrollsdk setup proof-config-check --strict` in an immutable-artifact CI
pipeline when ordinary Helm values drift should also fail. Legacy contracts
remain readable with their historical managed-block behavior.

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

Sync both the selected `resourcesRoot` (normally `proof-artifacts/`) and
`prover-worker-production/docker-compose/` to the GPU host while preserving
their relative layout. If the layout changes, pass the new root explicitly:

```bash
scrollsdk setup proof-worker-check \
  --bundle-dir prover-worker-production/docker-compose \
  --resources-root proof-artifacts \
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
scrollsdk setup proof-config-check --deployment-dir . --strict # immutable CI
```

Legacy `proofSystem` mock/production Compose bundles remain supported by the
same `setup proof-worker` and `setup proof-worker-check` commands.

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
compiler projection. A legacy `proofSystem` deployment also updates its legacy
artifact URL as documented by that schema.

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

## 15. Troubleshooting

| Symptom | Action |
|---|---|
| descriptor import fails | validate schema/network/key/endpoint; run the partner `scrollsdk signer preflight`, replace the collected descriptor, and rerun `setup attestation-signer` |
| no external attestation signers | import descriptors before bridge genesis; doge-config must use `attestationSigner.mode = "external"` |
| missing `protocol_context.protocol_id` | rerun bridge-init protocol-context step with a current dogeos-core image |
| no staged proof GET base URL | verify the selected `proofTopology` artifact store/public endpoint (or legacy `proofSystem.artifactReadBaseUrl`), then rerun `setup prep-charts` |
| compiler preflight fails | fix only the selected dormant profile's missing release paths, identities, image, or endpoint; do not edit generated WP/PC files |
| compiled external Worker check fails | sync the generated Compose bundle and selected resources root together; pass `--resources-root` if their relative layout changed |
| production source set missing | create `configs/source-set.toml` with real partner-reachable Dogecoin, Ethereum execution, and DogeOS L2 RPC sets |
| proof AWS config missing during preparation | run `setup proof-aws-init` first, or restore the reviewed `.data/proof-aws.json` resource-facts file |
| materializer configuration rejected | complete the hand-maintained coordinator materializer section; the CLI does not invent backend/RPC choices |
| signer health key differs from descriptor | stop; do not generate genesis with that descriptor |
| signer cannot fetch proof | inspect the full URL in the sign request from the signer host; verify DNS/TLS/object permissions |
| callback fails | test the generated TSO URL from the signer network and verify callback phase is `attestation` |

There is currently no application-layer authentication on the signer↔TSO HTTP
path. Use private connectivity such as VPN/WireGuard or an IP-allowlisted TLS
reverse proxy, and record the selected mechanism with each partner.
