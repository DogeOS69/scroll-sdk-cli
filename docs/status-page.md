# Generate and apply a status page

`setup status-page` reads the selected deployment and generates the SDK's
`statusPage` values contract, eight public components, and a native Grafana
contact point backed by an existing Kubernetes Secret. The first deployment is
Testnet only; L2Scan is excluded.

Copy the `statusPage` input block from the SDK's
`examples/values/scroll-monitor-production.yaml` into the deployment monitor values.
Set `enabled: true`, `environment: testnet`, and select the real source values
filenames. Source paths are relative to the monitor values directory. Chain name
and ID come from `config.toml`, public hosts from frontend, public RPC and
Blockscout ingress configuration. No network-specific domain is hardcoded.

```bash
# From the deployment directory; local generation only, no credentials required.
scrollsdk setup status-page

# Optional custom paths / numbered release.
scrollsdk setup status-page --deployment-dir /path/to/deployment \
  --config config.toml --values values/scroll-monitor-production-0.yaml

# With INSTATUS_API_KEY supplied through the shell or CI secret environment:
scrollsdk setup status-page --plan    # Remote GETs only; local files unchanged.
scrollsdk setup status-page --apply   # Explicit remote writes; returned IDs saved locally.
```

`--plan` and `--apply` are mutually exclusive; both support `--json`.
`setup prep-charts` also performs offline generation when `statusPage.enabled`
is true, after generating the source chart values.

For an existing dedicated page set `statusPage.instatus.pageId`. To create a page,
leave that empty and set `email`. The CLI generates `subdomain` from the environment:
mainnet → `dogeos`, testnet → `dogeos-testnet`, devnet → `dogeos-devnet`.
A configured nonempty subdomain must match this mapping. Exact matching subdomains are
reused after partial success; returned page/component IDs are saved after each
successful apply operation. The initial list has eight flat components. Page
name derives from chain name and explicit environment. The page uses Instatus's
default theme; domain, branding and subscription settings remain in its console.

`instatus.initialStatus` defaults to `OPERATIONAL` for newly created components.
An explicit override is supported; an explicitly empty string still prevents
creation (remove an old empty field or set the desired initial state). Allowed values are
`OPERATIONAL`, `UNDERMAINTENANCE`, `DEGRADEDPERFORMANCE`, `PARTIALOUTAGE`, and
`MAJOROUTAGE`. This initializes the page; it is not a health-check result.
Existing component status is never included in update requests. Uptime display
defaults to false until actual public coverage/history is ready.

Reconciliation changes page name and component name, description (including
public URLs), order, and uptime visibility. It does not delete resources or
modify incidents, maintenance or existing live status. Saved IDs take precedence
over exact component names; duplicate names, missing saved IDs, grouped or
archived components require explicit resolution. Review the first plan before
adopting existing components. The deployment also persists its single network/project
binding in `.data/status-page-state.json`, independently of regenerated values.
The chosen subdomain is reserved there before page creation; the page ID is saved
as soon as it is returned. `setup status-page` restores the binding before generation, planning or application. A fresh checkout
without local state searches the fixed environment subdomain before creation.
Keep this state with deployment backups; it contains identifiers, not credentials.
A known page that becomes inaccessible causes an error, never replacement creation.

An exclusive `.data/status-page-apply.lock` prevents concurrent applies sharing a
deployment directory. Separate CI workspaces must serialize applies to the same
network. Writes are not transactional or automatically retried. After failure,
rerun `--plan`, then `--apply`; remove a stale lock only after confirming its
owning process has stopped.

The first Grafana webhook can also be initialized automatically:

```bash
scrollsdk setup status-page --plan --create-webhook
scrollsdk setup status-page --apply --create-webhook
# Later deployments reuse the saved webhook without another integration POST.
scrollsdk setup status-page --apply
```

`--create-webhook` explicitly requests first initialization; it is not needed on
redeployment. It calls `POST /v3/integrations` with `integrationType: GRAFANA`, the
selected page ID and an empty component list. The actual response contains
`integration.uniqueUrl`; the CLI saves that exact URL, never constructs one.
Component mappings and public routes still require separate configuration before
sending alerts. The Instatus integration itself is active when created.

Each deployment directory belongs to one network. Its
`secrets/status-page/binding.json` holds the
private creation journal and returned credentials. `grafana.secret.yaml` in that
directory is a generated Kubernetes Secret using `grafana.webhookSecretRef`
(defaults `instatus-grafana-webhook` / `url`). The directory is mode `0700`, files
are `0600`, and a local `.gitignore` ignores every file. Tracked files and symlink
destinations are rejected before remote writes. Both files are sensitive: the
integration ID is embedded in the URL, and base64 Secret data is not encryption.
The management API key is only read from `INSTATUS_API_KEY` and is never saved.

The command generates this Secret artifact but does not contact Kubernetes.
Apply it to the **existing Grafana namespace** before deploying the monitor:

```bash
kubectl --context YOUR_CONTEXT --namespace YOUR_GRAFANA_NAMESPACE \
  apply --server-side --field-manager=scrollsdk-status-page \
  -f secrets/status-page/grafana.secret.yaml
```

Alternatively publish the credential through your existing secret manager. These
files are intentionally nested and are not uploaded by `setup push-secrets`' root
`.env`/`.json` scan; do not upload the binding or wrap the Secret manifest as a
single secret property. Production YAML contains references only.

Keep the private directory in encrypted deployment backups/CI secret storage.
Reuse is based on this saved binding, not a remote integration GET: no working
public integration-list/read API was verified. The CLI does not check whether a
cached integration was deleted, disabled or rotated in the dashboard. Creation
intent is fsynced before POST; timeout, invalid response or interruption leaves a
blocking journal instead of causing another creation request. A nonsecret
`generated.webhookRequested` marker also blocks recreation if the private binding
is lost. If **both** values/marker and private storage are lost, remote discovery
is unavailable: do not repeat first initialization; restore or explicitly import
the existing URL. Serialize CI applies and share this private state between runs.

To adopt a dashboard-created integration, recover an ambiguous creation, or
explicitly rotate the URL, save the selected page's complete Grafana URL in a
private text file outside Git, then:

```bash
scrollsdk setup status-page --plan --webhook-url-file /private/instatus-grafana.url
scrollsdk setup status-page --apply --webhook-url-file /private/instatus-grafana.url
```

Import validates the Grafana URL format, but its page association must be checked
in the dashboard by the operator. It does not call the webhook or create an
integration. The flags are mutually exclusive and require `--plan` or `--apply`.
No URL or integration ID is emitted to stdout/JSON, logs, catalog or Helm values.
Rerun the Secret application and restart Grafana after rotation.

Deploy generated values with the deployment's existing Helm workflow. Neither
generation nor `--apply` deploys Kubernetes resources. The runtime uses native
Grafana webhook delivery; no publisher or management API credential runs in the
cluster, and Instatus needs no internal monitoring credentials or ingress.
Public alert selection/routing is a later step and is not enabled by this command.
Secret rotation requires a Grafana restart. Keep contact-point name/UID/org stable;
renaming is an explicit migration, since Grafana retains previously provisioned
resources. To disable, remove public routes and the contact point first, remove
the generated native Grafana fields and `statusPage.catalog` / `generated`, then
set `enabled: false`.

The complete cross-repository contract and annotated production inputs live in
the SDK's `docs/status-page-automation.md` and
`examples/values/scroll-monitor-production.yaml`.
