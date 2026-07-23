# DogeOS Proof System Operator Runbook

This is the single official end-to-end runbook for the DogeOS bridge operator.
It covers proof configuration, partner attestation-signer handoff, Kubernetes
services, the external prover worker, and lifecycle acceptance in both `mock`
and `production` proving modes.

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

## 2. Proving modes

One switch controls the generated proof topology:

```bash
--proving-mode mock|production
```

The selected mode is persisted in `.data/doge-config.toml` under
`[proofSystem].provingMode`. `setup export-signer-policy` reads that value, so
partners never pass a separate proving-mode flag.

| Property | `mock` | `production` |
|---|---|---|
| Services and network calls | real | real |
| WP → coordinator claim flow | real | real |
| Worker claim / heartbeat / result | real | real |
| TSO `POST /sign` and callback | real | real |
| Signer HTTP proof fetch and audit DB | real | real |
| Proof bytes | deterministic, non-cryptographic | release prover output |
| Worker host | ordinary Linux allowed | GPU/release-specific host |
| Signer policy | audited `staging_scaffold` | fail-closed `production_enforce` |
| TEE allowlists | empty by default, matching e2e harness | required and canonicalized to compressed secp256k1 IDs |
| Proof release files | synthesized mock manifests | required signed/reviewed release artifacts |

Mock is a lifecycle and configuration test lane. Never enable it on a bridge
that carries assets of value.

## 3. Standard deployment layout

Run commands from one deployment root. Normal operation should not pass a list
of file paths. Use `--deployment-dir /path/to/deployment` only when invoking
`proof-config` from elsewhere.

```text
deployment/
├── config.toml
├── .data/
│   ├── doge-config.toml
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
│   ├── manifests/
│   │   ├── scroll-chunk.json            # production only
│   │   ├── scroll-batch.json            # production only
│   │   ├── bridge-transition.json       # production only
│   │   └── statement-namespace.json     # generated; passed with --set-file
│   └── mock-manifests/                 # generated in mock mode
│       ├── scroll-chunk-topology-program.json
│       ├── scroll-batch-topology-program.json
│       └── bridge-topology-program.json
├── configs/
│   └── source-set.toml                  # production signer policy only
├── prover-worker-mock/                  # generated in mock mode
│   └── docker-compose/
└── signer-policy-bundle/                # generated after genesis
    ├── PARTNER-COMMANDS.md
    ├── signer-policy.env
    ├── signer-policy.json
    ├── verifier-registry.toml
    └── source-set.toml
```

`proof-config` may scaffold a missing `ProofCoordinator.toml`; after creation,
the hand-maintained materializer sections remain operator-owned and are never
silently replaced. Production `configs/source-set.toml` must contain real RPC
sources reachable from partner signer networks. The CLI cannot safely invent
production RPC quorum policy.

`withdrawal-processor/WithdrawalProcessor.toml` is different: it is a required
native application-config template supplied by
`scroll-sdk/examples/withdrawal-processor/WithdrawalProcessor.toml`. Copy the
scroll-sdk examples layout into a new deployment before running the CLI. Neither
`prep-charts` nor `proof-config` creates this file or embeds its TOML in a values
YAML document; both commands only update their marked blocks in the existing
native file. Helm receives the file through `--set-file`.

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
  --active-signer-ids <signer-a,signer-b,signer-c> \
  --probe
```

The command validates descriptor schema, network, endpoint, public-key curve
membership, and global uniqueness of signer IDs, keys, and endpoints. `--probe`
also requires each running signer's `/health` public key to match its descriptor.

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

Render the base values and native service configuration first:

```bash
scrollsdk setup gen-secrets -N --json
scrollsdk setup prep-charts -N --json
```

`prep-charts` fails if the native WithdrawalProcessor template is absent. If a
legacy values file still contains
`configMaps.config.data.WithdrawalProcessor.toml`, the command removes that
inline copy only after confirming the native template exists; it never uses the
inline content to create the native file.

For the S3/IRSA proof topology, provision the proof bucket roles, service
accounts, and the two distinct bearer tokens after the proof values exist:

```bash
scrollsdk setup proof-aws-init \
  --aws-region <region> \
  --eks-cluster <cluster> \
  --network-alias <network-alias> \
  --namespace <namespace>
```

This step is idempotent. The coordinator/WP control-plane token and the
external prover-worker token are separate credentials. The default
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

## 8. Stage proof topology

The proof-object base URL must be a stable credential-free HTTP(S) GET root.
The worker uses it to read inputs and partner signers use concrete object URLs
carried in signing requests to fetch accepted proof artifacts.

For an AWS-native virtual-hosted or path-style S3 URL, `proof-config` requires
the URL path to include the configured artifact-store `key_prefix`; passing
only the bucket root fails before any generated file is written. A custom HTTPS
gateway may intentionally map its own root to the prefix, so it remains
supported but emits a warning requiring an exact-key preflight from every
worker/signer network.

### Mock

```bash
scrollsdk setup proof-config \
  --proving-mode mock \
  --proof-artifact-base-url https://proofs.example.com/<deployment>
```

Mock mode:

- synthesizes the canonical e2e-harness-compatible program manifests;
- stages `dev_dummy` verifier identities in the native WP TOML and coordinator;
- scaffolds a compatible coordinator configuration when missing;
- writes `prover-worker-mock/docker-compose/` with a non-secret
  `bundle-manifest.json` and stable `bundleId`;
- records `withdrawalProof.provingMode: mock` in WP values;
- keeps `withdrawalProof.enabled` unchanged unless explicitly activated.

### Production

Place reviewed release files under the standard `proof-artifacts/` layout,
then run:

```bash
scrollsdk setup proof-config \
  --proving-mode production \
  --proof-artifact-base-url https://proofs.example.com/<deployment>
```

Production validates release/manifests, verifier IDs, program commitments,
verification-key hashes, and aggregate verifying-key checksums. Production
identities must come from release artifacts; do not transcribe them into Helm
values by hand.

The CLI derives the complete runtime activation environment atomically from
`withdrawalProof.enabled` and `withdrawalProof.provingMode` and writes the
explicit env entries into WP values. The generic chart only renders those
entries; it has no proof-mode logic. Disabled mode always carries
`mode=disabled` with both required-family gates and the proof-work API off.
Active production carries the production posture. Active mock carries
`mode=dev_dummy` and adds `dev_dummy.scroll_input=exact_mock`; that entry is
absent from the native TOML and every CLI-generated disabled posture, avoiding
an invalid cross-mode configuration. Do not edit `withdrawalProof.enabled`
without rerunning `prep-charts` or `proof-config`, because the CLI must update
the complete env projection at the same time.

On a rerun, the command reuses the staged proof-object base URL. Use
`--enable-withdrawal-proof` only after the coordinator, worker, storage,
partner policy, and network preflights below have passed.

## 9. Start the external prover worker

### Mock worker

On the selected Linux host, transfer the generated bundle and run from its
deployment root:

```bash
scrollsdk setup proof-worker-check \
  --bundle-dir prover-worker-mock/docker-compose \
  --expected-bundle-id <bundleId-printed-by-proof-config>
docker compose --project-directory prover-worker-mock/docker-compose config --quiet
docker compose --project-directory prover-worker-mock/docker-compose up -d
```

The generated `prover-worker.env` contains a bearer token and must remain mode
`0600`. `proof-worker-check` does not read or print that token; it validates the
compose and endpoint-env checksums, stable bundle ID, chunk/batch/bridge
capabilities, and secret-file mode. Run it before transfer and again on the
worker host. A missing manifest identifies a pre-fix bundle; a bundle-ID
mismatch identifies a stale remote copy. Then confirm the running container
advertises all required capabilities and performs claim, heartbeat, and result
calls against the coordinator.

### Production worker

Use the approved prover release and GPU operating procedure. Its proof program
identities and backend profiles must match the same `proof-artifacts/` release
used by `proof-config`. Do not reuse the deterministic mock worker on a
production topology.

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
manifest JSON files with `--set-file`. `setup proof-config` also writes the
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

## 12. Activate and run lifecycle acceptance

After the worker is registered and all partners have applied the generated
policy bundle:

```bash
scrollsdk setup proof-config --enable-withdrawal-proof
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
| descriptor import fails | validate schema/network/key/endpoint; run the partner preflight and retry with `--probe` |
| no external attestation signers | import descriptors before bridge genesis; doge-config must use `attestationSigner.mode = "external"` |
| missing `protocol_context.protocol_id` | rerun bridge-init protocol-context step with a current dogeos-core image |
| no staged proof GET base URL | run `setup proof-config` first |
| no staged proof triples | verify the managed coordinator verifier block or production manifests |
| production source set missing | create `configs/source-set.toml` with real partner-reachable Dogecoin, Ethereum execution, and DogeOS L2 RPC sets |
| proof AWS init cannot find values | run `setup prep-charts` first |
| materializer configuration rejected | complete the hand-maintained coordinator materializer section; the CLI does not invent backend/RPC choices |
| signer health key differs from descriptor | stop; do not generate genesis with that descriptor |
| signer cannot fetch proof | inspect the full URL in the sign request from the signer host; verify DNS/TLS/object permissions |
| callback fails | test the generated TSO URL from the signer network and verify callback phase is `attestation` |

There is currently no application-layer authentication on the signer↔TSO HTTP
path. Use private connectivity such as VPN/WireGuard or an IP-allowlisted TLS
reverse proxy, and record the selected mechanism with each partner.
