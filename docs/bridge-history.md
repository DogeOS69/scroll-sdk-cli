# DogeOS bridge history deployment

The history service is opt-in. Use an SDK revision containing
[SDK PR #189](https://github.com/DogeOS69/scroll-sdk/pull/189), for example
`700dd377819d01a83464f8e8dbd0072b145ffc1d`, and published service and Portal images
that implement the Activity API. The CLI does not infer compatible releases.
The image tags below are placeholders and must be replaced before validation.

```yaml
bridgeHistory:
  enabled: true

templates:
  sdkRevision: 700dd377819d01a83464f8e8dbd0072b145ffc1d

images:
  services:
    dogeosBridgeHistory:
      repository: dogeos69/dogeos-bridge-history
      tag: TODO_PUBLISHED_HISTORY_TAG
    frontends:
      repository: dogeos69/scroll-sdk-frontends
      tag: TODO_PUBLISHED_ACTIVITY_TAG
```

On AWS, include both `dogeos-bridge-history` and `frontends` in the existing
`infrastructure.aws.sharedAlb.services` list. Retain other selected public
services, and supply the real group name and ACM certificate through the existing
shared-ALB configuration. History uses the Portal host with `/api/history/v1` and
group order 10; Portal uses order 100. The history chart does not yet support
external `alb.bindings` / TargetGroupBindings.

`setup generate-from-spec --with-values` and the staged preparation workflow
generate `values/dogeos-bridge-history-production.yaml`. Older SDK revisions
without the template fail with an explicit compatibility error. Without
`bridgeHistory.enabled: true`, bootstrap does not copy this service's values,
and no history Secret is generated. Disabling it does not uninstall a running
release or delete existing volumes or Secret files.

The service reuses `dogecoin.network` and `dogecoin.indexerStartHeight`. Keep the
indexer boundary consistent with L1 Interface. `setup prep-charts` refreshes those
deployment inputs without replacing values-owned polling intervals, PVC size,
replica count or resource settings. The SDK owns the StatefulSet, shared genesis
and protocol-context mounts, probe defaults and shutdown grace period.

`setup gen-secrets` writes `secrets/dogeos-bridge-history-secret.env` using the
existing in-cluster Dogecoin RPC endpoint and `dogecoin.clusterRpc` credentials.
The fields are `DOGEOS_BRIDGE_HISTORY_DOGECOIN_RPC__URL`, `__USER`, and `__PASS`.
The generated values reference `dogeos-bridge-history-secret-env`; AWS/GCP remote
references use the configured secret prefix and region/project. Kubernetes
Secret mode omits ExternalSecrets. Use the existing upload workflow for the
selected provider. Never place credentials in Helm values or committed files.

Portal receives `REACT_APP_HISTORY_API_URI = "/api/history/v1"`. There is no legacy
API fallback. The old `0.3.0-test.20261011.4` Portal image is rejected when history
is enabled. Set presentation-only values in `values/frontends-config.yaml`:
`REACT_APP_HISTORY_EXPECT_INCLUDED`, `REACT_APP_HISTORY_EXPECT_POSTED`,
`REACT_APP_DEPOSIT_PITFALLS_URI`, and `REACT_APP_EXTERNAL_EXPLORER_URI_ETH`.
SDK defaults and operator edits to these keys survive regeneration.

Status-page `bridgeChecks: auto` resolves a root-relative history URL against
the Portal origin and probes `/api/history/v1/health`. External probes require
`ready: true`; Alloy checks HTTP 200 and JSON content type. Initial indexing
returns 503 until ready. Existing explicit probe overrides remain authoritative.

After preparation, upload the Secret, select actual published images, and use
the generated `install-dogeos-bridge-history` and `install-frontends` Make targets.
Configuration generation and successful Helm rendering do not install the
services or prove live Activity API readiness.
