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
├── proof-artifacts/                     # production only
│   ├── release.json
│   └── manifests/
│       ├── scroll-chunk.json
│       ├── scroll-batch.json
│       └── bridge-transition.json
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
external prover-worker token are separate credentials.

## 8. Stage proof topology

The proof-object base URL must be a stable credential-free HTTP(S) GET root.
The worker uses it to read inputs and partner signers use concrete object URLs
carried in signing requests to fetch accepted proof artifacts.

### Mock

```bash
scrollsdk setup proof-config \
  --proving-mode mock \
  --proof-artifact-base-url https://proofs.example.com/<deployment>
```

Mock mode:

- synthesizes the canonical e2e-harness-compatible program manifests;
- stages `dev_dummy` verifier identities in WP and coordinator;
- scaffolds a compatible coordinator configuration when missing;
- writes `prover-worker-mock/docker-compose/`;
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

On a rerun, the command reuses the staged proof-object base URL. Use
`--enable-withdrawal-proof` only after the coordinator, worker, storage,
partner policy, and network preflights below have passed.

## 9. Start the external prover worker

### Mock worker

On the selected Linux host, transfer the generated bundle and run from its
deployment root:

```bash
docker compose --project-directory prover-worker-mock/docker-compose config --quiet
docker compose --project-directory prover-worker-mock/docker-compose up -d
```

The generated `prover-worker.env` contains a bearer token and must remain mode
`0600`. Confirm the worker advertises all required capabilities and performs
claim, heartbeat, and result calls against the coordinator.

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

The WP and coordinator install targets pass their native TOML with
`--set-file`. Values remain responsible for Kubernetes shape, secret wiring,
and the proof activation switch.

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
