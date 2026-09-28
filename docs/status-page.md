# Status-page configuration automation

Status-page runtime acceptance is enforced by `.github/workflows/test-status-page.yml`.
It runs the CLI tests with real Prometheus expressions, Helm rendering and Grafana
delivery/recovery enabled, against an immutable SDK commit. The test receivers are
local fixtures; no Instatus key or deployment credentials are required. Update the
SDK commit pin deliberately when changing the shared configuration contract.

Core images must contain the merged fixes in [core #1312](https://github.com/DogeOS69/dogeos-core/pull/1312)
(merge `c579df82ce2c8377ccde8001c91ad10d67f040c6`) and
[core #1314](https://github.com/DogeOS69/dogeos-core/pull/1314)
(merge `421806bbdb83b45b230d1f2359d62d1fc39e0387`), or equivalent later changes.
Both merges were verified on 2026-09-28. These supply indexer-confirmation-aligned
coverage, replay ages that survive unchanged canonical rewrites, and DA waiting
ages that survive retries. **Merging #1304 is not a deployment prerequisite.**
Verify the built image's source revision and live metric contract; a PR merge or
CLI configuration-ready result does not prove that the running image has it.
Performance follow-up is handled separately and is not evidence of live acceptance.

The SDK template and `scroll-sdk-cli` share the `statusPage` contract in
[SDK production example](https://github.com/DogeOS69/scroll-sdk/blob/feat/dstack-controller-chart/examples/values/scroll-monitor-production.yaml).
The chart defaults and chart production profile expose the same inputs.
DogeOS uses **one shared page with Mainnet, Testnet and Devnet groups**, each with
eight components and no L2Scan. The selected workspace is `6wxpx` (DogeOS),
and the existing public page is `dogeos.instatus.com`.
Each deployment directory belongs to exactly one network. Other environments
use their own deployment directories.

## Generate, inspect, apply

Run these commands from the deployment directory, using a CLI build containing
`setup status-page`:

```bash
# Offline: read this deployment's files and update local monitor values.
scrollsdk setup status-page

# Optional: read Instatus and print create/update/unchanged actions.
# Does not modify local files or Instatus; requires INSTATUS_API_KEY in the environment.
scrollsdk setup status-page --plan

# Explicit remote mutation; creates or reconciles the selected page and components.
scrollsdk setup status-page --apply
```

All modes regenerate the desired catalog in memory from current inputs before
using it. Default generation writes only the selected monitor values file.
`--plan` is read-only. `--apply` saves generated values, reconciles Instatus, and
persists returned page/component IDs after each successful operation.
`--plan` and `--apply` are mutually exclusive. `--json` emits structured results.

Paths can be selected explicitly:

```bash
scrollsdk setup status-page --deployment-dir /path/to/deployment \
  --config config.toml --values values/scroll-monitor-production-0.yaml
```

`--config` and `--values` resolve relative to `--deployment-dir`. Source filenames
in `statusPage.sources` resolve relative to the selected monitor file's directory.
This also supports layouts with `frontends-production.yaml` directly in the
working directory. Source files must remain inside that values directory.

`scrollsdk setup prep-charts` also generates this configuration when
`statusPage.enabled=true`, including numbered monitor values. It processes the
source charts before monitor values so the catalog uses their newly generated
ingress hosts. It never contacts Instatus. Older deployments without a
`statusPage` block retain their existing behavior.

Neither command deploys Helm or Kubernetes Secrets. Apply the generated monitor
values through the deployment's existing Helm workflow. The chart validates the
generation contract, renders the public catalog in a ConfigMap, and delegates
contact-point provisioning to the existing Grafana chart. Production examples enable
a component delivery verifier for durable, evidence-checked recovery. Runtime
credentials are scoped webhook URLs, never the management API key.

## Inputs and ownership

| Field | Owner / source | Behavior |
| --- | --- | --- |
| `statusPage.enabled` | Operator, default `false` | Explicitly opt into generation and chart validation. |
| `statusPage.environment` | Operator | `testnet`, `mainnet`, or `devnet`. Never inferred from a hostname or Dogecoin's network. Select the network owned by this deployment directory. |
| Network name / chain ID | `config.toml`: `general.CHAIN_NAME_L2`, `general.CHAIN_ID_L2` | Recorded in the local catalog; does not change the shared page title. |
| `sources.frontends` | Selected deployment frontend values | Read `ingress.main.hosts[].host`; append `sources.bridgePath` (default `/bridge`). |
| `sources.publicRpc` | Selected **enabled** public RPC values | Read all HTTP hosts and enabled WebSocket hosts. Default filename is `l2-reth-rpc-public-production.yaml`; select the actual release, including old/numbered layouts if applicable. |
| `sources.blockscout` | Selected deployment Blockscout values | Read `blockscout-stack.frontend.ingress.hostname`; L2Scan is excluded. |
| `sources.scheme` | Operator, default `https` | Actual external protocol; WebSocket uses `wss` for HTTPS. It is explicit because TLS may terminate upstream of ingress. |
| `grafana.orgId` | Organization in **scroll-monitor's Grafana** | Default `1`; use the organization that owns the rules. |
| `grafana.contactPointName` / `receiverUid` | Local naming conventions | Defaults `instatus-public` / `instatus-public-webhook`; reserve unused, stable identities. |
| `grafana.webhookSecretRef.name` / `.key` | Target Kubernetes Secret | Defaults `instatus-grafana-webhook` / `url`; also used by the CLI's private Secret artifact. Only references are written to values. |
| `instatus.pageId` | Instatus / CLI | Shared page ID, same across deployments. Leave empty to discover `dogeos`; saved after apply. |
| `instatus.subdomain` | Shared convention | Default `dogeos` for all networks. Exact ID/subdomain agreement is required. Old separate-page slugs require migration. |
| `instatus.workspaceSlug` | Operator | Default `6wxpx`; resolve via workspace API and verify page ownership. Never create a replacement workspace. |
| `instatus.pageName` | Shared configuration | Default `DogeOS`; keep identical in every deployment. |
| `instatus.groupId` | Instatus / CLI | Discover from components in the exact Mainnet/Testnet/Devnet group; saved by apply. A supplied ID must match that group. |
| `instatus.branding` | Shared configuration | Official DogeOS favicon and website URLs by default. Upload the logo in Instatus Look & feel; omitted logo fields preserve the uploaded URL. Raw GitHub logo URLs fail in the public image optimizer. Keep branding identical across deployments; `{}` preserves all existing branding. Dark-mode logo remains a console setting. |
| `instatus.email` | Operator | Page owner email required only for page creation. |
| `instatus.initialStatus` | Operator override, default `OPERATIONAL` | Initial state for newly created components only. Override for a different known initial condition. It is never sent when updating an existing component. |
| `instatus.showUptime` | Operator, default `false` | Enable once real public status coverage/history is ready. No synthetic history is generated. |
| `instatus.componentIds` | Instatus / CLI | Maps stable component keys to returned IDs. May also explicitly identify existing components before first apply. |
| `catalog` / `generated` | CLI | Derived output and ownership metadata; do not edit by hand. |

Valid creation states: `OPERATIONAL`, `UNDERMAINTENANCE`,
`DEGRADEDPERFORMANCE`, `PARTIALOUTAGE`, `MAJOROUTAGE`. Instatus has no generic
unknown component state in this API. Omitting `initialStatus` uses `OPERATIONAL`;
the production examples expose this default. This initializes new components and
is not a health-check result. An explicitly empty string still prevents creation;
for older values containing `initialStatus: ""`, remove that field or set it to the
desired initial state. Existing component states are always preserved.

The generated catalog contains Public RPC, Transaction Sequencing, Deposits,
Withdrawals, Batch Publication, Node Sync, Bridge Portal, and Block Explorer.
Endpoints are included in the relevant public component descriptions. Explicit
`environment` selects `Mainnet`, `Testnet`, or `Devnet`; name matching is restricted
to that group. Three deployments produce 24 components on the shared page.
Only deployed, verified networks should be initialized; missing deployment data
never results in fabricated endpoints or health.

## Reuse existing groups; initialize only a new page

The operator confirmed that Mainnet, Testnet and Devnet groups are already created.
Normal deployment reuses them; group creation automation is not a remaining task.
The following bootstrap instructions apply only to a new page or a missing group.

Read-only API verification resolved workspace `6wxpx` to
`cmuh3p8v200r21mlbhhjg03nr` and its `dogeos` page to
`cmuh3p8vs00r41mlbcz56ix6a`. These are identifiers, not credentials. Defaults use
the stable workspace/page slugs; IDs are discovered and verified on each plan.

In that page's Components screen, create groups **Mainnet**, **Testnet**, **Devnet**,
in that display order. Reuse any existing empty group instead of duplicating it.
Add a **Public RPC** component to each group that is ready
to be managed, setting its actual initial status. The CLI adopts these components
and creates the remaining seven in the corresponding group. Group names and order
are owned in the console; the CLI never moves another network's components.

The documented component REST API attaches to an existing group (`group` on
create, `groupId` on update). A public group-creation/list endpoint was not verified;
the dashboard's private session API is deliberately not used. Live component-list
responses include `isParent` group records with nested `children`; the CLI resolves
these parents and adopts their children within the selected network. An empty
parent group is also discoverable when returned by the API. The documented flat
component representation with explicit group references is accepted too.
A missing group produces `group.action: bootstrap` in `--plan`; apply refuses
component changes until the group exists. Duplicate group names, conflicting
parent ownership and archived groups or components fail explicitly.

Automatic page creation remains available outside the selected existing-workspace
flow: set `workspaceSlug: ""`, a unique explicit subdomain and an owner email.
After creating a page, apply saves its binding and stops for dashboard group setup;
rerunning discovers the same page. It does not guess how to assign a newly created
page to a workspace. The DogeOS defaults always require the existing page inside
`6wxpx`, so redeployment cannot create another project.

## Two distinct credentials

- **Runtime webhook URL:** Instatus creates it in the page's Grafana integration.
  Store the complete URL in the referenced Secret in Grafana's namespace using
  the existing secret-management workflow. Grafana reads it through
  `INSTATUS_GRAFANA_WEBHOOK_URL`; the generated receiver retains that literal
  environment reference. This URL is not an existing scroll-monitor URL.
- **Management API key:** The CLI reads `INSTATUS_API_KEY` only for `--plan` and
  `--apply`. Supply it through the shell/CI secret environment. It is not a CLI
  argument, not saved in YAML, and not injected into the running chart.

Grafana holds the credential for the Instatus endpoint it pushes to. Instatus
receives no internal Grafana or Prometheus API key, and no internal monitoring
endpoint needs public ingress. Normal operation is still
`scroll-monitor → Prometheus → Grafana → Instatus native webhook`.

Provisioning uses fixed Grafana format version `1`, webhook type `webhook`, HTTP
`POST`, `disableResolveMessage: false`, and the literal environment reference.
Rotating the URL requires updating its Secret and restarting Grafana to refresh
the process environment. File-provisioned contact points are read-only in the UI.

## Automatically obtain the Grafana webhook

First initialization is explicit; ordinary redeployment reuses the saved URL:

```bash
scrollsdk setup status-page --plan --create-webhook
scrollsdk setup status-page --apply --create-webhook
# Later deployments:
scrollsdk setup status-page --apply
```

The CLI calls the official `POST /v3/integrations` endpoint with `pageId`,
`integrationType: GRAFANA` and `components: []`. Live validation confirmed that
the response contains `integration.uniqueUrl`, even though the documentation's
short example omits it. The CLI saves the returned URL without reconstructing it.
The integration starts active but has no component associations; alert selection,
component templates and Grafana routes remain a later step. No notification is sent.

Credentials are generated into the deployment directory, outside Helm values:

```text
secrets/status-page/
  .gitignore              # Ignores all files in this directory.
  binding.json            # Private creation journal, page binding, integration ID and URL.
  grafana.secret.yaml     # Kubernetes Secret using webhookSecretRef.name/key.
```

Every network uses the same relative path, `secrets/status-page/`, in its own
deployment directory. The saved network and page must match the current
configuration; a mismatch fails before remote writes. The directory is `0700`,
files `0600`; symlinks and Git-tracked
credential paths are rejected before remote writes. Treat both generated files
as credentials: **the integration ID is embedded in the webhook URL** and base64
Secret data is not encryption. Neither is printed in normal/JSON output or saved
in the public catalog, Helm values, or `.data/status-page-state.json`.

Apply the generated Secret separately, explicitly selecting the context and
namespace of the existing Grafana deployment:

```bash
kubectl --context YOUR_CONTEXT --namespace YOUR_GRAFANA_NAMESPACE \
  apply --server-side --field-manager=scrollsdk-status-page \
  -f secrets/status-page/grafana.secret.yaml
```

The CLI does not deploy Kubernetes resources or contact the cluster. Existing
secret-management systems may provision the same name/key instead. These nested
files are deliberately excluded from `setup push-secrets`' root `.env`/`.json`
scan; do not upload the entire binding or Secret manifest as a secret property.

Back up this private directory using encrypted deployment/CI secret storage.
No working public list/get API for monitoring integrations has been verified:
reuse relies on the saved credential and does not verify remote deletion,
deactivation or rotation. A durable creation journal is written before POST.
Timeout or interruption leaves the operation blocked instead of automatically
creating another integration. `generated.webhookRequested` is a nonsecret guard
that also blocks re-creation if the private binding is lost. If both regenerated
values and private state are lost, remote discovery cannot recover this binding;
restore it or import the existing URL rather than repeating first initialization.
CI workspaces must share each deployment’s private state and serialize applies to the shared page.

To adopt an existing integration, recover an uncertain creation or rotate the
URL, copy the selected page's URL into a private text file outside Git, then:

```bash
scrollsdk setup status-page --plan --webhook-url-file /private/instatus-grafana.url
scrollsdk setup status-page --apply --webhook-url-file /private/instatus-grafana.url
```

Import checks URL format, but the operator must verify its page and network/component associations in
Instatus. It does not create an integration or send a notification. These flags
require `--plan` or `--apply` and are mutually exclusive. `--plan` still writes
nothing. Apply the regenerated Secret and restart Grafana after rotation.

## Reconciliation and operational boundaries

Apply verifies the workspace and page, then resolves the exact network group.
Components match saved IDs first, otherwise exact names **inside that group**.
Missing explicit IDs, foreign-group IDs, archived components and ambiguous groups
or component names fail before writes. Unmatched components and other groups are
left in place; no delete requests are sent.

Shared page name and configured logo/favicon/website URLs are reconciled. Component
name, description, order and uptime display are updated only within this network's
group; the same group ID is retained explicitly. Existing live status, incidents,
maintenance, subscribers, custom domain and other theme fields are preserved.
All deployments must use identical shared branding configuration.

Each network has its own webhook and private receipt in its own working directory,
even though the page ID is shared. New integrations retain empty component mappings
until public alert policy is agreed. When mapping later, select only components
from that network's group; sharing a page is not automatic webhook scope enforcement.
Do not reuse one network's URL for another. Integration IDs and URLs stay private.

The API is not transactional: partial success is possible. IDs are saved as each
operation succeeds; a failed or ambiguous write is not blindly retried. Rerun
`--plan`, then `--apply` to reconcile.

The CLI binds each deployment directory to one network and persists its page/group binding in
`.data/status-page-state.json`, separately from Helm values. It records the fixed
subdomain before creation and the returned page ID immediately afterward. A
regenerated values file recovers this binding. Even in a fresh checkout without
state, the fixed subdomain is searched before creation. The page name, deployment
timestamp and release version never determine a new subdomain. A known page that
is missing/inaccessible fails instead of creating a replacement. Corrupted state
or conflicting page/subdomain settings also fail for explicit resolution.

Keep the state file with deployment backups; it contains identifiers only. A
`.data/status-page-apply.lock` serializes applies sharing a deployment root; a
stale lock must be removed only after its process has stopped. Separate CI
workspaces must serialize operations for the shared page because the API
offers no idempotency token or compare-and-swap guarantee here. Use separate
deployment directories and Secrets for separate environments; the page is shared.

## Migrate an existing separate-page deployment

Changing a slug alone is intentionally rejected: its page ID, component IDs and
webhook still refer to the old page. This is a one-time migration, not redeployment.

1. Stop public forwarding through the old Grafana contact point during cutover.
   Back up the old monitor values, `.data/status-page-state.json` and private
   `secrets/status-page/` directory in encrypted storage outside the deployment root.
2. Initialize the destination network group on `dogeos` in `6wxpx`. Review the old
   page's current health and outstanding incidents; history/subscribers are not
   automatically transferred. Keep the old page intact for reference.
3. After the backup, move the old state file and private credential directory out
   of their active paths. In monitor values set shared `workspaceSlug`, `subdomain`
   and `pageName`; clear `pageId`, `groupId`, `componentIds`; remove only
   `generated.appliedPageId` and `generated.webhookRequested`. Preserve Grafana
   generation ownership fields and the explicit deployment environment.
4. Generate and review `--plan --create-webhook`, then apply. Confirm every planned
   component is in this network's destination group. Existing destination statuses
   are preserved; choose `initialStatus` deliberately for new components.
5. Apply the new Secret to this deployment's Grafana namespace and restart Grafana.
   Reconfigure reviewed mappings/routes only for this group, verify delivery, and
   keep the old page and credentials until the cutover is accepted.

The CLI never deletes old projects/pages or silently retargets an existing webhook.

Generation preserves unrelated Grafana provisioning and notification policies.
Conflicting use of the reserved environment variable, provisioning file, contact
point name or receiver UID fails for explicit resolution. Changing the configured
Secret reference regenerates the owned fields. Renaming a provisioned contact
point or changing its organization is a migration: remove the former resource
and its routes deliberately rather than leaving two active destinations.

To disable an already provisioned integration, first remove its public routes
and Grafana contact point, then remove its generated `grafana.envValueFrom` entry,
`grafana.alerting.instatus-contact-points.yaml`, `statusPage.catalog`, and
`statusPage.generated`; set `statusPage.enabled=false`. Merely removing a Grafana
provisioning file does not delete the resource from Grafana's database.

Webhook creation and credential retrieval are supported through the explicit
initialization flow above. Kubernetes application and selective alert/component
activation remains an operational step. Component health rules, public incident policy
and independent probes are described below. No alert or incident is sent by configuration
generation or reconciliation.

API reference: [status pages](https://instatus.com/help/api/status-pages),
[components](https://instatus.com/help/api/components),
[monitoring integrations](https://instatus.com/help/api/monitoring-integrations),
[Grafana integration](https://instatus.com/help/integrations/grafana).


## Component publication v2

SDK production examples provide all eight keys with `mode: automatic` and
`rule.builtin: true`. Modes are `manual`, `observe`, `automatic`. Built-in rules
cover public RPC, continuous sequencing, bridge browser/API, Blockscout freshness,
official follower or optional external canary node sync, and new dogeos-core deposit/withdrawal/DA queue observations.
The SDK [publication guide](https://github.com/DogeOS69/scroll-sdk/blob/feat/dstack-controller-chart/docs/status-page-publication.md)
defines their semantics, operational limits and runtime tests.

| Publication input | Ownership / default |
| --- | --- |
| `components.<key>.mode` | Operator; automatic by default, explicit manual/observe remain available |
| `components.<key>.rule` | Built-in by default; custom rules require `builtin: false`, `expr`, optional `for` |
| `health.failureFor` / `recoveryFor` | Default 5m / 10m; per-component `rule.for` overrides failure |
| `health.*DeadlineSeconds` | Deposit, withdrawal and batch publication: 0 means unconfigured; supply confirmed budgets |
| `health.*JobRegex` | Select complete actual application roles, excluding proof-only WP workers |
| `probes.sequencingMode` | auto; derive from selected sequencer allowEmptyBlocks, or explicitly override; on-demand needs a custom rule |
| `probes.bridgeChecks` / `nodeDependencyChecks` | Bridge defaults to auto from frontend runtime config; node checks are explicit. Checks accept `{url,path,equals}` or `{url,path,type}`; no secret-bearing URLs |
| `probes.explorerApiUrls` / `explorerSelector` | Backend ingress derived when available; operator supplies rendered data selector |
| `nodeSync` | `official` selects active sequencer and deployed bootnode/internal RPC/public RPC values/release pairs; CLI derives private Service names, ports and replica counts. Existing configurations default to `external`. |
| `probes.nodeRpcUrl` | Optional external mode's independent canary node; per-site override supported by probe chart |
| `probes.metricsTargets` | Private `host:port` targets; CLI owns only the `status-page-external-probes` scrape job |
| `delivery` | Production enabled; Python image, PVC size/storage class exposed; existing component values default direct mode |
| `incidents` | Manage create/resolve templates in examples; default Degraded Performance, subscriber notification false |
| `heartbeat` | Optional; needs Instatus internal monitor alert IDs, distinct from Grafana receivers/subscribers |
| `observationContactPointName` | Internal Grafana receiver; default name does not configure SMTP/recipients |

Expressions must return exactly one 0 (healthy), 1 (affected), or no series
(unknown). Missing prerequisites are reported in configuration readiness; no
healthy value is invented. Unknown samples and query failures remain internal.
Configuration readiness does not claim live service health.

`delivery.enabled: true` routes Grafana firing to a small verifier in scroll-monitor.
It rechecks the same expression and requires continuous health for recovery;
raw resolved/rule lifecycle events never establish recovery. A single-replica
SQLite PVC preserves active/pending events. Only component webhook URLs reach this
workload. Direct mode sends firing only and requires manual recovery. Manual/observe
modes stop the component's verifier activity when deployed, preserving bindings and
incidents. Use manual mode before taking over a public incident.

```sh
# Offline, also export separate probe-chart values; set image/location before deploying.
scrollsdk setup status-page --probe-values values/status-page-probe-production.yaml
# Read-only review, including incident policy and heartbeat target state.
scrollsdk setup status-page --plan --create-webhook
# Create/reuse selected component integrations and optional Cron Monitor.
scrollsdk setup status-page --apply --create-webhook
```

Export preserves top-level image/location options and regenerates `config`. Run
probes at two or more independent sites, not two replicas in the chain cluster.
The CLI does not deploy probes, nodes, Helm releases or Secrets.

Each automatic integration is bound to exactly one component. Names are
`instatus-<key>`, Secret `instatus-<key>-webhook`, data key `url`. Private files are
`secrets/status-page/<key>.binding.json` and `<key>.secret.yaml`. Subsequent apply
uses PUT and reuses the integration. Recover/adopt using `--webhook-component <key>`
and `--webhook-url-file /private/component.json` containing `{integrationId,url,createTemplateId,resolveTemplateId}`.
The template IDs are saved from the creation response. Restore them from the
existing integration when importing an older binding; never recreate the
integration to repair missing private state. Managed templates use the integration
API editor schema, and apply verifies both template and integration subscriber
notification flags. Template `notify: false` alone is insufficient.
A URL alone is not the management ID. Creation intent is persisted before POST;
ambiguous results block duplication until receipts are restored/adopted.

Optional Cron Monitor uses `heartbeat.json` and `heartbeat.secret.yaml` in the same
private directory. It creates no public component/incident, alerts only internal
destinations, and detects lost Grafana/Prometheus or failed delivery through a
missing heartbeat. Grafana requests one-minute repeats; actual notifications can
arrive every two minutes because of Alertmanager group scheduling. The monitor
allows a three-minute period plus three-minute grace, avoiding false degradation
from normal scheduling jitter. First successful ping activates monitoring. Disable and apply
to pause the provider monitor; deploy to pause the retained Grafana heartbeat rule.
Restore its receipt after an ambiguous response, rather than creating another monitor.

Generated rules preserve global notification policies and existing unrelated
provisioning. Retire competing legacy public routes before automatic activation.
Apply scoped Secrets and generated Helm values through the existing deployment
workflow. Instatus template behavior and real-account incident delivery require
acceptance on a test target before enabling public subscriber notifications.

## Defaults from selected deployment files

Select `statusPage.sources.frontendsConfig` (normally `frontends-config.yaml`)
and `statusPage.sources.sequencer` (the effective Reth sequencer values, including
a numbered filename when applicable). Empty source strings disable inference;
new SDK examples provide conventional filenames. The frontend chain ID and any
sequencer networkId must match this deployment. These inputs only produce
non-secret catalog/probe evidence; generation never deploys a release.

`sequencingMode: auto` derives continuous/on-demand from an enabled sequencer's
`allowEmptyBlocks`. `bridgeChecks: auto` reads the frontend's actual
`REACT_APP_BRIDGE_API_URI`, calls the read-only `/txs` history route for a zero
address, and requires an array `results` and numeric `total`. Empty history is
valid. The browser also validates the same API contract from the Portal origin.
`auto` remains in saved inputs so source changes are picked up on regeneration.
Explicit lists/modes are preserved; `bridgeChecks: []` disables inference.

Application polling, confirmation depths and retry timers do not establish a
public processing deadline. The three business deadlines remain unconfigured
until the operator supplies them. Independently operated node/probe addresses
and the deployed explorer's rendered data selector also remain explicit inputs.
Use status-page-probe chart 0.1.1 or newer for typed API checks.

### Official Node Sync sources

The existing follower fleet can supply Node Sync evidence without an independent
canary. Set `statusPage.publication.nodeSync.mode: official`, select a `reference`
with `{values, release, role: sequencer}`, and a `followers` list with the same
fields and roles `bootnode`, `internal-rpc`, `public-rpc`. Select effective files
and actual Helm release names, including separate entries for numbered releases.
`namespace: ""` uses the monitoring release namespace; set it when nodes differ.
An optional source `service` overrides a custom or templated Service name.

The CLI reads each source through the existing bounded values-directory reader,
validates roles and chain IDs, and generates Service names, ports and replica
counts. The reference must have one active continuously producing sequencer;
standby references are not automatically selected. Zero-replica followers are
excluded. At least one follower must remain, with at most 32 follower Pods.
Regenerate when source values, replica counts or release names change.

The SDK collector discovers each Pod through EndpointSlices, checks height/lag
and same-height hash against the sequencer, and rejects incomplete or changing
membership and stale/reorganized reference evidence. Namespace-scoped list access
to EndpointSlices is its only Kubernetes permission. It holds no Instatus key.
Internal node details stay out of the public catalog and exported probe values.
See the SDK [Node Sync guide](https://github.com/DogeOS69/scroll-sdk/blob/main/docs/status-page-node-sync.md)
and the complete source-selection examples in scroll-monitor production values.

These checks cover the selected official followers, not independent new-node
bootstrap. Public web/RPC probes still need independent locations. To use the
external canary mode instead, clear `reference: {}` and `followers: []`, then
configure the probe's canary URL/dependency checks. `official` suppresses those
external Node Sync fields on export; combining both health sources needs a custom
expression. Component modes, internal observation alerts and verified recovery
continue to use the existing publication flow.

## Delivery status and order

Existing network groups are reused. Scheduled suppression is available through
`publication.maintenanceWindows` (UTC start/end and selected component keys).
Delivery resumes only after a fresh full confirmation interval. Publish the
matching Instatus maintenance notice separately; changing remote maintenance
status alone does not pause local automation. Management API synchronization of
maintenance notices remains a separate, lower-priority item.

The Alloy and official Node Sync changes use a coordinated SDK/CLI release. The
acceptance workflow pins the corresponding SDK commit; push that SDK commit before
this CLI commit so CI can fetch its templates. Local runtime acceptance does not
establish a remote CI result before both commits are pushed. Probe image
publication and the proposed VM deployment package remain to be implemented;
the existing probe Helm chart and configuration export are already available.


## Existing Alloy public-entrypoint mode

New SDK examples use `statusPage.publication.probes.mode: alloy`; older inputs
without a mode retain external deep probes. Alloy configuration is generated in
scroll-monitor and uses its existing private remote-write path. No additional
public probe Pod is needed. Do not pass `--probe-values` in Alloy mode.

The mode checks HTTP/TLS availability, RPC chain-ID/block-number response patterns,
and Bridge/Blockscout API availability. Readiness exposes `coverage: public-entrypoint`
and the catalog descriptions describe that narrower scope. Browser rendering,
indexing freshness, sequencing and WebSocket behavior are not inferred from HTTP
success. Configured WS endpoints leave RPC unready; sequencing requires a custom
rule. Official Node Sync and business metrics retain their existing rules.

`probes.alloyChecks` optionally adds `{component, url, bodyRegex: [RE2]}` GET checks.
`bridgeChecks: auto` derives API URLs. Explicit JSON-path overrides require external
mode, because the pinned Alloy Blackbox component does not execute them. All checks
must produce fresh complete results; a missing or duplicate reporter cannot recover
an incident. `minimumProbeLocations` applies only to external mode.

Automatic publication with Alloy requires `heartbeat.enabled: true` and internal
Instatus `alertIds`. Generation/observe works without these credentials. Apply
reuses the existing Cron monitor and writes its Secret to `secrets/status-page/`.
The heartbeat checks Alloy telemetry as well as the existing monitoring/delivery
chain: HTTP target failures still send pings, telemetry loss stops them. Instatus
notifies internal destinations; it does not mark every business component down.

Review `scroll-sdk/docs/status-page-alloy.md` and the complete production examples
for source ownership, fixed defaults, DNS/ingress acceptance and the remaining
live-provider checks. This implementation does not deploy a chain or modify Instatus
without the separate `--apply` entry point.


### Supplemental checks without business-image changes

With `probes.mode: alloy`, configured WebSocket endpoints use the reserved
`status-websocket` container in the existing Alloy Pod. `probes.websocketImage`
defaults to `node:22.23.3-alpine3.23`. The CLI owns only that container/volume and
its rollout annotation; other Alloy extras are retained. Actual chain-ID and
block-number JSON-RPC requests must pass TLS, response-ID and quantity checks.
Missing or stale samples cannot satisfy Public RPC readiness. This does not test
WebSocket subscriptions or transaction submission.

When official Node Sync selects one active continuously producing reference,
Sequencing reads its latest block time directly. A stale, valid reference is
affected; unavailable discovery/RPC is unknown. Follower failures do not by
themselves classify the sequencer. No new dogeos-core metric is needed.

Use an existing internal Slack contact point for notification acceptance. The
SDK production example shows its Kubernetes Secret reference. Keep email/SMTP
disabled by default. Skip dashboard, alert and public business-rule acceptance
when the deployed application image predates its metrics; do not upgrade that
image as part of monitor acceptance. Proof Coordinator stays No data until its
new image is published and explicitly deployed.


## Incident severity has no implicit default

With `publication.incidents.manageTemplates: true`, each automatic component must
set `publication.components.<key>.affectedStatus` explicitly to
`DEGRADEDPERFORMANCE`, `PARTIALOUTAGE` or `MAJOROUTAGE`, after reviewing its rule.
The old global `publication.incidents.affectedStatus` is rejected with migration
instructions. Observe/manual components may leave severity empty. `--plan` shows
component policy in the generated inputs and `--apply` updates existing templates.
Existing open incidents must be reclassified separately on the same incident.

This is a fixed per-rule template policy, not dynamic severity classification.
Binary health alone cannot distinguish latency, partial loss and complete outage.
Mixed built-in checks still need richer evidence and a verified incident-update
protocol before dynamic escalation/de-escalation can be claimed.


In Alloy mode, `publication.probes.bridgeChecks: disabled` explicitly retires the
legacy bridge API dependency and monitors the bridge website over HTTPS only.
The generated public description is narrowed accordingly. `auto` still requires
API discovery; the opt-out is not inferred from an absent API or permitted for
external browser mode. Deposits/withdrawals retain their separate health rules.

### WF stalled: deposits and withdrawals

Both built-in rules include `health.wfStallSeconds` (default 3600). A fresh WP target
must show no WF sequence change over the window AND queued/in-flight work older
than that window. Idle queues do not cause an outage. A confirmed WF stall affects
both components even when their business snapshot is invalid or missing. A known
business deadline violation is independently actionable. Recovery requires both
WF and business evidence to be healthy, followed by the recovery window.
Automatic publication is the default when mode is omitted; missing prerequisites
are errors, never an implicit fallback to observe. Explicit existing observe modes
remain opt-outs until migrated. SDK deposit/withdrawal examples use MAJOROUTAGE.
