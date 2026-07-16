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
                                       setup export-signer-policy ...
        ◀────────────────────────────┘  signer-policy bundle (one for all signers)
apply bundle, restart
                                       setup prep-charts   (tsoSigners → external endpoints)
                                       register signers with TSO
```

## Commands

### 1. Import descriptors

```bash
scrollsdk setup attestation-signer \
  --descriptor-dir descriptors/ \
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
scrollsdk setup export-signer-policy \
  --protocol-instance-id 0x<32-byte-hex> \
  --tso-url https://tso.your-bridge.example \
  --signer-proof-artifact-base-url https://proofs.your-bridge.example/proof-topology \
  --tee-allowed-signer-ids 02...,03... \
  --allowed-proof-triples "scroll_batch:scroll-production-v1:<vk-hash>"
```

Derived automatically: `activeBridgeKeyHash` from
`.data/protocol_context.json` (`genesis.genesis_bridge_key_hash`) and the
bridge namespace id from `.data/GenerateBridgeInfo.toml`. The bundle is
chain-level — send the same directory to every signer operator.

`--tso-url` must be reachable **from the operators' networks** (signature
callbacks), not a cluster-internal service name.

### 4. Wire the stack

`scrollsdk setup prep-charts` now renders **no** attestation-signer values
files (and removes stale ones); the withdrawal-processor `tsoSigners` array
points at the external endpoints from the descriptors.

## Network requirements (declare per engagement; mechanism TBD per partner)

1. TSO → signer `POST /sign`, `GET /health`
2. signer → TSO signature-submission callbacks
3. signer → proof-artifact base URL (HTTPS GET)

There is no application-layer auth on the signer↔TSO path today: require
private connectivity (VPN / WireGuard / IP-allowlisted TLS proxy) and record
the chosen mechanism in the engagement notes.

## Invariants worth repeating

- A descriptor's public key enters the redeem script **permanently at
  genesis**; `--probe` before `bridge-init`, not after.
- One signer id = one key = one operator. The import command enforces
  uniqueness of all three.
- Key rotation is a RotateKey ceremony, not a descriptor re-import.
