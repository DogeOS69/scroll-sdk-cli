# CubeSigner transport-only devnet rollout (2026-09-09)

The operator explicitly selected transport_only, then authorized continuing
deployment. The old production-policy evidence requirement is therefore not a
blocker for **this transport-only runtime**, but production proof acceptance is
still not established. Remote CubeSigner key policy was not changed.

## Commands and configuration

From the deployment directory:

```bash
scrollsdk setup cubesigner-refresh --doge-config .data/doge-config.toml -N --json
scrollsdk setup push-secrets --cubesigner-only --provider aws \
  --aws-region us-east-1 --aws-prefix dogeos/devnet-20260909 \
  --values-file values/cubesigner-signer-production.yaml -N --json
```

Refresh created the singleton local session/key-id files for existing role
Devnet and key `Key#DogeTest_ni357fyaLZVa2gViVwvVYGemjScg8DBkxz`. Lifetimes are
365-day session, 2-hour auth, 7-day refresh and 30-second grace. Private files
stay local; only the two scoped Secrets are uploaded. Never print their values.

The first push succeeded remotely but did not update YAML: an early return in
`--cubesigner-only` ignored the normal reconciliation path and `--values-file`.
CLI fix `7ba1da8` removes that early return, preserving the upload allowlist and
`--skip-yaml-update` behavior. Five alias tests, build and targeted lint passed
(two existing complexity warnings). Re-running the command updated exactly the
target values to the two `dogeos/devnet-20260909/cubesigner-signer-*` Secrets in
us-east-1; JSON reported `yamlUpdated=true`. This also serves as the actual
command-level reconciliation check. The existing remote CubeSigner key policy
and old us-west-2 Secrets were not modified.

Manual local values changes:

- Keep `DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_MODE=transport_only`.
- Keep `DOGEOS_CUBESIGNER_SIGNER_SIGNATURE_MODE=ecdsa` and beta.3e image.
- Change the volumeClaimTemplates name to `session-cache-devnet-20260909`,
  retaining the 1Gi size and `/app/.sessions` mount. This first install must not
  seed itself from the historical cached session. No old PVC deletion is needed.

```bash
helm --kube-context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster \
  template cubesigner-signer oci://ghcr.io/dogeos69/scroll-sdk/helm/cubesigner-signer \
  --version 0.1.8 -n default -f values/cubesigner-signer-production.yaml |
  kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster \
    -n default apply --dry-run=server -f -
make install-cubesigner-signer
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster \
  -n default exec l2-reth-rpc-0 -- \
  curl -fsS --max-time 10 http://cubesigner-signer:3000/ready
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster \
  -n default exec l2-reth-rpc-0 -- \
  curl -fsS --max-time 30 -X POST http://withdrawal-processor:3000/register-tso
```

Helm revision 1 installed; both ExternalSecrets are SecretSynced=True. New
`session-cache-devnet-20260909-cubesigner-signer-0` is Bound (1Gi gp3). Startup
copied the fresh seed into the new cache, initialized the client, retrieved the
expected public key `036e006ed3ff92fad4a66056c0cb6a9d1fb24d3aeab3b8097e8081283400b987d8`
and passed session keep-alive. `/ready` returned 200 with session and processing
health ok, ECDSA, transport_only and `production_ready=false`. WP re-registration
returned status ok. This does not yet establish a successful remote signPsbt
call, callback or withdrawal settlement.

## Retention is temporary, not a dependency

The old `session-cache-cubesigner-signer-0` and old Secrets were retained only
as rollback candidates during startup. The operator questioned their continued
value; no deletion has been authorized or performed at this checkpoint. After
confirming no rollback is needed, enumerate exact resources and check references
before cleanup. In particular, unversioned `dogeos/cubesigner-signer-*` Secrets
may have consumers outside this cluster; this cluster's reference check alone
cannot prove they are globally unused. Prefer recoverable scheduled deletion
for confirmed-unused AWS Secrets; distinguish that from EBS PVC deletion.
