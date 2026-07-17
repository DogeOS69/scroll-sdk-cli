# Partner-Operated Attestation Signers (Bridge-Operator Runbook)

Attestation signers are run by their operators — partners, or ourselves
following the exact same flow. The bridge operator never provisions signer
keys or deploys signer workloads; the entire exchange happens through two
artifacts:

- **descriptor** (`attestation-signer-descriptor/v1` JSON): signer id,
  network, endpoint, compressed secp256k1 public key. Produced by the signer
  operator (`scrollsdk signer init` / `scrollsdk signer preflight`), consumed
  here.
- **policy bundle**: produced here after bridge genesis
  (`scrollsdk setup export-signer-policy`), applied by every signer operator.
  It includes `PARTNER-COMMANDS.md`, rendered with the selected proving mode
  and the deployment's exact signer, TSO, and proof-object addresses.

The signer-operator side of this handshake — deployment kit and runbook —
lives in scroll-sdk under `partner-kit/attestation-signer/`.

## Timeline

```
signer operators                      bridge operator (you)
────────────────                      ─────────────────────
signer init / deploy / preflight
        │  descriptor.json per signer
        └────────────────────────────▶ setup attestation-signer \
                                         --descriptor-dir descriptors/ --threshold T [--probe]
                                       setup bridge-init --step all
                                       setup proof-config --proving-mode mock|production ...
                                       setup export-signer-policy ...
        ◀────────────────────────────┘  signer-policy bundle (one for all signers)
apply bundle, restart (same commands for mock/production)
                                       setup prep-charts   (tsoSigners → external endpoints)
                                       register signers with TSO
```

## Commands

### 0. Agree the address contract

Before a partner creates its descriptor, agree these values in writing:

| Value | Who chooses it | Where it is recorded |
|---|---|---|
| signer id | bridge + signer operator | `signer init --id`, then `descriptor.json` |
| signer base URL | signer operator; must be reachable from the TSO network | `signer init --endpoint`, then `descriptor.json` and WP `tsoSigners` |
| TSO callback URL | bridge operator; must be reachable from the signer network | `config.toml [ingress].TSO_HOST`, or `export-signer-policy --tso-url` |
| proof-object GET root | bridge operator; must be reachable from worker and signer networks | `proof-config --proof-artifact-base-url` |

Recommended production signer endpoint:

```bash
scrollsdk signer init \
  --id partner-a-signer-0 \
  --network testnet \
  --endpoint https://signer.partner-a.example:4040 \
  --backend aws-kms \
  --kms-key-id <key-id-or-arn> \
  --kms-region <region> \
  --allowed-release-version <approved-cargo-version> \
  --allowed-git-commit <approved-full-40-character-git-sha>
```

For an isolated mock/VPN exercise, a private address is valid, for example
`http://10.20.30.40:4040`. The important property is the caller's route: TSO
must reach that address. `localhost`, a Docker-only service name, or a partner's
Kubernetes-only name is not a valid cross-operator endpoint.

### 1. Import descriptors

```bash
# descriptors default to descriptors/*.json in the working directory
scrollsdk setup attestation-signer \
  --threshold 2 \
  --active-signer-ids partner-a,partner-b,ours-0 \
  --probe
```

- Validates every descriptor (schema, key on-curve + round-trip, bare
  endpoint URL, network match) and rejects duplicate ids / keys / endpoints.
- `--probe` additionally hits each signer's `/health` and requires the
  runtime public key to equal the descriptor's. Descriptors remain the
  source of truth; the probe is a cross-check.
- Writes `doge-config.toml` (`[attestationSigner]` with `mode = "external"`,
  plus `signerUrls`) and `setup_defaults.toml`
  (`attestation_pubkeys` / `attestation_key_count` / `attestation_threshold`).

### 2. Generate the bridge — unchanged

`scrollsdk setup bridge-init --step all` consumes `setup_defaults.toml`
exactly as before; nothing about external signers changes this step.

### 3. Export the policy bundle

```bash
# In the standard working-directory layout every input is derived; flags
# below are overrides for non-standard layouts or values.
scrollsdk setup export-signer-policy
```

Derived automatically (each derivation is logged with its source):

| Input | Source |
|---|---|
| `activeBridgeKeyHash` | `.data/protocol_context.json` (`genesis.genesis_bridge_key_hash`) |
| `--bridge-namespace-id` | `.data/GenerateBridgeInfo.toml` (`namespace_id`) |
| `--protocol-instance-id` | `.data/protocol_context.protocol_id` sidecar written by bridge-init step 5 |
| `--tso-url` | `https://<[ingress].TSO_HOST>` from `config.toml` |
| `--signer-proof-artifact-base-url` | the value `setup proof-config` staged into `withdrawal-processor/WithdrawalProcessor.toml` |
| `--allowed-proof-triples` | the staged `ProofCoordinator.toml` verifier block, else the `proof-artifacts/` manifests, else empty |
| `--tee-allowed-signer-ids` | `tee_pubkey` from `.data/setup_defaults.toml` (cubesigner-init) |

The bundle is chain-level — send the same directory to every signer operator.
`PARTNER-COMMANDS.md` contains each imported signer id/endpoint/pubkey, the
resolved TSO and proof GET addresses, the exact partner compose commands, and a
bridge-operator K8s reachability probe.

The TSO URL must be reachable **from the operators' networks** (signature
callbacks), not a cluster-internal service name; override with `--tso-url`
when the ingress host is not the partner-facing address.

### 4. Wire the stack

`scrollsdk setup prep-charts` now renders **no** attestation-signer values
files (and removes stale ones); the withdrawal-processor `tsoSigners` array
points at the external endpoints from the descriptors.

## Mock versus production flow

The operator steps and service calls are intentionally the same:

1. partner runs `signer init`, compose, `/health`, and `signer preflight`;
2. bridge operator imports descriptors with `--probe` before genesis;
3. bridge operator stages proof topology and exports the policy bundle;
4. partner copies the same three runtime policy files and restarts compose;
5. TSO sends `POST /sign`; signer fetches the full proof URL carried in
   `required_proof_artifacts[]`; signer submits its TSO callback;
6. the end-to-end withdrawal test checks the resulting signer audit/decision.

Only the proof implementation and signer safety posture differ:

| proving mode | signer policy | reason |
|---|---|---|
| `mock` | `staging_scaffold`, `allow_unimplemented_checks=true` | exact e2e_harness posture: implemented checks and HTTP proof fetch still run; deterministic non-cryptographic proof and unfinished production checks are explicitly audited/bypassed |
| `production` | `production_enforce`, `allow_unimplemented_checks=false` | fail closed; signer image release/git/policy pins are also required in the operator-owned `attestation-signer.env` |

Both bundles set the bounded proof-artifact cap to 4 and export both the
decomposed and envelope TEE signer allowlists. Without the positive cap, the
signer default is deliberately zero and every proof-backed envelope is denied.

The current `dogeos-core` signer reports cryptographic STARK proof-byte
verification as `NotImplemented`; therefore `production_enforce` correctly
refuses proof-backed signing until the selected signer release implements that
check. Mock is the supported full lifecycle/configuration test lane, not a way
to weaken a value-bearing production deployment.

## Network requirements

1. TSO → signer `POST /sign`, `GET /health`
2. signer → TSO signature-submission callbacks
3. signer → proof-artifact base URL (HTTPS GET)

Run the following twice: first from the bridge operator's setup host via
`setup attestation-signer --probe`, then from the K8s namespace that contains
TSO so a workstation-only VPN route cannot mask a cluster routing failure:

```bash
kubectl -n <namespace> run signer-reachability --rm -i --restart=Never \
  --image=curlimages/curl:8.20.0 -- \
  curl -fsS https://signer.partner-a.example:4040/health
```

There is no application-layer auth on the signer↔TSO path today: require
private connectivity (VPN / WireGuard / IP-allowlisted TLS proxy) and record
the chosen mechanism in the engagement notes.

## Invariants worth repeating

- A descriptor's public key enters the redeem script **permanently at
  genesis**; `--probe` before `bridge-init`, not after.
- One signer id = one key = one operator. The import command enforces
  uniqueness of all three.
- Key rotation is a RotateKey ceremony, not a descriptor re-import.
