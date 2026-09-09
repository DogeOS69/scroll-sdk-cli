# CLI Automation Reference

This document defines how scripts, CI jobs, and agents invoke `scrollsdk`.
It intentionally does not define deployment order. For the official proof and
partner-handoff workflow, use [proof-operator-runbook.md](proof-operator-runbook.md).
For command-specific flags, use:

```bash
scrollsdk <command> --help
```

The root README command section is generated from the same command metadata.

## Non-interactive execution

Commands that support automation expose:

```bash
--non-interactive
-N
--json
```

`--non-interactive` disables prompts. Required values must already exist in
the standard deployment files, environment variables, or explicit flags.
`--json` emits a machine-readable final response. Not every legacy helper
supports both flags; check the command's `--help` output rather than assuming.

Typical invocation:

```bash
scrollsdk setup prep-charts --non-interactive --json
```

## Standard working directory

Automation should run from one deployment root containing `config.toml`,
`.data/`, `values/`, and native service configuration directories. Commands
derive conventional paths from that root.

Do not pass path overrides for every generated file. Path flags are migration
escape hatches for non-standard layouts. Run proof topology generation from
the deployment root:

```bash
cd /srv/dogeos/deployment
scrollsdk setup prep-charts --non-interactive --json
```

## Environment-variable references

Configuration and supported flags may use exact `$ENV:NAME` references:

```toml
[db.admin]
PASSWORD = "$ENV:POSTGRES_ADMIN_PASSWORD"
```

```bash
export POSTGRES_ADMIN_PASSWORD='...'
scrollsdk setup db-init --non-interactive --json
```

Keep the `$ENV:` reference quoted when passing it through a shell so the shell
does not expand `$ENV` itself:

```bash
scrollsdk setup gen-keystore \
  --non-interactive \
  --json \
  --sequencer-password '$ENV:SEQUENCER_KEYSTORE_PASSWORD'
```

An unset or empty referenced variable is treated as unavailable. Commands must
fail with a configuration error instead of silently writing the literal
reference into runtime secrets.

## JSON response contract

Successful commands return a single object shaped like:

```json
{
  "command": "setup prep-charts",
  "data": {},
  "duration_ms": 1234,
  "success": true,
  "timestamp": "2026-07-17T00:00:00.000Z",
  "warnings": []
}
```

Failures return:

```json
{
  "command": "setup proof-worker",
  "duration_ms": 123,
  "error": {
    "category": "CONFIGURATION",
    "code": "E713_PROOF_WORKER_CONFIG_FAILED",
    "context": {},
    "message": "actionable failure description",
    "recoverable": true
  },
  "success": false,
  "timestamp": "2026-07-17T00:00:00.000Z"
}
```

Fields under `data` and `context` are command-specific. Automation should use
`success`, `error.code`, `error.category`, and `error.recoverable` as the stable
control fields rather than matching human-readable log text.

## Stdout and stderr

With `--json`:

- stdout contains the final JSON response;
- stderr contains progress, warnings, Docker/Kubernetes output, and diagnostic
  context.

Do not discard stderr in CI logs. Parse stdout separately while retaining
stderr as an artifact:

```bash
response="$(scrollsdk setup export-signer-policy --json 2>scrollsdk.stderr.log)"
printf '%s\n' "$response" | jq .
```

## Exit status

A successful command exits `0`; a failed command exits non-zero. Check both the
process status and the JSON `success` field. A wrapper must never continue to a
state-changing downstream step merely because stdout was parseable.

```bash
if ! response="$(scrollsdk setup export-signer-policy --json 2>scrollsdk.stderr.log)"; then
  printf '%s\n' "$response" | jq . >&2
  exit 1
fi

test "$(printf '%s\n' "$response" | jq -r '.success')" = true
```

## Error categories and retries

| Category | Meaning | Automation response |
|---|---|---|
| `CONFIGURATION` | missing, inconsistent, or unsafe input | correct configuration; do not blind-retry |
| `PREREQUISITE` | required local tool or service unavailable | restore prerequisite, then retry |
| `NETWORK` | DNS, TLS, RPC, or endpoint failure | verify route and policy; bounded retry may be appropriate |
| `DOCKER` | image, daemon, or container failure | inspect Docker logs before retry |
| `KUBERNETES` | cluster, resource, or authorization failure | inspect cluster state before retry |
| `FUNDING` | required chain funds unavailable | fund the reported address, then retry with the same identity inputs |
| `VALIDATION` | generated or supplied artifact violates a contract | fix the artifact; do not retry unchanged |
| `INTERNAL` | unexpected implementation failure | preserve diagnostics and report a bug |

`recoverable: true` means the command may succeed after the reported external
condition is corrected. It does not mean immediate retries are safe. Preserve
the same bridge seed, signer cohort, proving mode, and release artifacts across
retries unless the operator explicitly starts a new deployment.

## Idempotency and write boundaries

Automation should assume each command owns only its documented managed blocks
and artifacts. Relevant examples:

- `prep-charts` rewrites marked proof/verifier blocks, rebuilds managed values,
  preserves unrelated native TOML settings, and commits the complete generation
  transaction only after every output succeeds;
- `export-signer-policy` regenerates the bundle from current deployment facts;
- `proof-aws-init` is designed to reuse matching cloud resources. It records an
  existing `[ethereumDa.blobArchive.s3]` bucket/region/keyPrefix as the one
  shared DA/proof object namespace rather than creating a second proof store.
  EKS/Secrets Manager may be in a different region from that bucket; in that
  case it deliberately skips the regional S3 Gateway endpoint. It records an
  explicit operator-managed public HTTPS endpoint for external Workers and
  partner Signers, and can auto-discover or create the EKS cluster's S3 Gateway
  VPC endpoint and route-table associations. Both routes remain explicitly
  unverified. For a shared bucket with an existing public S3 policy, select
  `existing-public-s3`: the CLI preserves bucket-wide Public Access Block and
  public-policy ownership while still reconciling the deployment-scoped
  endpoint, IRSA, and secret resources. `direct-s3` is reserved for buckets
  whose public-read posture the CLI owns. It writes stable, non-secret resource facts to
  `.data/proof-aws.json` and never reads or modifies generated values;
- `prep-charts` projects `.data/proof-aws.json` into final values. With
  unchanged configuration, templates, and release inputs, a rerun is
  byte-idempotent and reports no changed files. Active legacy doge-config
  deployments fail when that resource-facts file is absent instead of
  recovering infrastructure coordinates from old values.

Before retrying after partial failure:

1. read the command's JSON error and stderr;
2. inspect `git diff` or the deployment artifact diff;
3. correct the external condition;
4. rerun the same command with the same identity inputs;
5. verify generated outputs before continuing.

## Secret handling

- Use environment references or a secret manager; do not commit expanded
  secrets to configuration repositories.
- Treat generated `*.env` files containing WIFs, bearer tokens, AWS keys, or
  database passwords as secrets.
- Keep `prover-worker.env` and signer `attestation-signer.env` mode `0600`.
- `descriptor.json`, `signer-policy.json`, and public-key metadata are public
  deployment artifacts, but review endpoints before publication.
- Retain stderr logs carefully: external tools may print sensitive context.

## Minimal shell wrapper

```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077

run_scrollsdk() {
  local name="$1"
  shift

  local stderr_log="scrollsdk-${name}.stderr.log"
  local response
  if ! response="$(scrollsdk "$@" --non-interactive --json 2>"$stderr_log")"; then
    printf 'scrollsdk step %s failed; diagnostics: %s\n' "$name" "$stderr_log" >&2
    printf '%s\n' "$response" | jq . >&2 || true
    return 1
  fi

  if test "$(printf '%s\n' "$response" | jq -r '.success')" != true; then
    printf '%s\n' "$response" | jq . >&2
    return 1
  fi

  printf '%s\n' "$response"
}

# Example only: requires existing validated deployment config/Bridge outputs.
# This is not a from-scratch deployment order.
run_scrollsdk gen-secrets setup gen-secrets --doge-config .data/doge-config.toml
```

Known deployment finding (2026-09-08): `setup prep-charts --json` can still emit
ordinary progress text before its JSON result. The strict wrapper above will
reject that output even if generation completes. It must not be presented as a
verified prep-charts wrapper until stdout framing is fixed and tested. For that
command, retain stdout/stderr privately and inspect the final result and required
artifact checks; do not infer success from exit code alone, discard errors, or
blindly retry non-idempotent neighboring steps. This limitation does not change
the intended machine-readable JSON contract.

## DeploymentSpec generation

For declarative base configuration:

```bash
scrollsdk setup generate-from-spec \
  --spec deployment-spec.yaml \
  --json
```

This generates base deployment artifacts; it does not replace bridge genesis,
partner descriptor exchange, proof release review, cloud provisioning, or
lifecycle acceptance. Follow the operator runbook for those stateful steps.
