# dstack controller operator guide

The CLI generates `values/dstack-controller-production.yaml` for the independent
`scroll-sdk/charts/dstack-controller` chart (initial contract: chart `0.1.0`,
dstack `0.21.5`). This manages the controller's deployment configuration;
Worker fleet/task generation and GPU provisioning are separate operations.

## Workflow and effects

Run commands from one deployment directory so that the private state, public
configuration, Secrets and values belong to the same deployment.

| Operation | Result | External effects |
| --- | --- | --- |
| `setup dstack-config` | Imports Vast.ai/GCP material and records public Secret references | Local files only; does not authenticate with a provider |
| `setup generate-from-spec --with-values` | Generates deployment configuration and initial service values | Local files only |
| `setup db-init --databases dstack` | Creates/updates the dstack database and login, saves its connection and Secret | Connects to and modifies an existing PostgreSQL server; does not create a cloud database service |
| `setup gen-secrets --dstack-only` | Generates native controller config, auth and selected provider/database Secrets | Local files only |
| `setup prep-charts --dstack-only` | Generates `values/dstack-controller-production.yaml` | Local files only; no bridge initialization or registry checks |
| `setup push-secrets --dry-run` | Validates local inputs and describes the selected upload scope | No Kubernetes, AWS or Vault requests |
| `setup push-secrets` without `--dry-run` | Uploads the selected Secret material | Writes to Kubernetes and/or the configured secret store |
| `helm lint` / `helm template` | Checks and renders the controller chart | Local validation only |
| Install/upgrade the controller chart | Starts/updates the controller in the cluster | Creates/updates Kubernetes resources; separate from GPU fleet/task submission |

For a real PostgreSQL deployment, prepare `config.toml`, import provider
credentials, initialize the selected existing database, generate Secrets and
values, inspect the local plan, upload Secrets, then install the controller
chart. PostgreSQL stores the controller's persistent application state. Its
database credentials, dstack admin token and upstream provider credentials are
different materials. The CLI's credential importer currently supports Vast.ai
and GCP; other native dstack backends require separately managed server config
and credential Secrets.

For configuration review only, use the walkthrough below. It does not require a
database, a Kubernetes context that exists, or valid cloud credentials.

## Configuration-only walkthrough

Prerequisites: build the CLI with `yarn build`, have Helm available, and check out
the `scroll-sdk` version containing `charts/dstack-controller` alongside this
repository. Start from the **scroll-sdk-cli repository root**. The commands below
create a temporary deployment with SQLite and a deliberately invalid Vast.ai key;
they never initialize a database, upload Secrets or install the chart.

```bash
DSTACK_CLI="$PWD/bin/run.js"
DSTACK_CHART="$(cd ../scroll-sdk/charts/dstack-controller && pwd)"
DSTACK_TEST_DIR="$(mktemp -d /tmp/dstack-config-review-XXXXXX)"
cd "$DSTACK_TEST_DIR"
umask 077
mkdir -p .data

cat > .data/doge-config.toml <<'TOML'
[dstackController]
enabled = true
[dstackController.database]
type = "sqlite"
TOML
printf '%s\n' 'offline-review-key-not-valid' > vastai-api-key

node "$DSTACK_CLI" setup dstack-config \
  --vastai-api-key-file vastai-api-key --non-interactive --json
node "$DSTACK_CLI" setup gen-secrets --dstack-only -N --json
node "$DSTACK_CLI" setup prep-charts --dstack-only -N --json
node "$DSTACK_CLI" setup push-secrets --dstack-only --dry-run \
  --kube-context offline-review --namespace dstack-review -N --json

helm lint --strict "$DSTACK_CHART" \
  -f values/dstack-controller-production.yaml
helm template dstack-controller "$DSTACK_CHART" \
  --namespace dstack-review \
  -f values/dstack-controller-production.yaml > controller-rendered.yaml
printf 'Review files in %s\n' "$DSTACK_TEST_DIR"
```

This Vast.ai-only SQLite example produces **two Secret YAML files** under
`secrets/`: `dstack-controller-config.yaml` and `dstack-controller-auth.yaml`.
It also saves private state in `.data/dstack/credentials.json`. Production
values contain Secret references, not credentials. Adding GCP produces a third
Secret YAML file, and PostgreSQL adds the database Secret. The rendered controller
manifest contains a Deployment, Service, ServiceAccount and retained PVC; no GPU
workload is submitted.

Keep this directory for review or remove it after inspection. Do not reuse its
fake credentials or generated controller identity for a real deployment. The
example commands are local-only by behavior; the additional no-network namespace
used in the acceptance check below is a separate isolation measure.

To review PostgreSQL configuration without initializing a database, use a fresh
test directory, select `database.type = "postgresql"`, and supply a deliberately
invalid connection in its private `config.toml` before `gen-secrets`:

```toml
[db]
DSTACK_DB_CONNECTION_STRING = "postgresql+asyncpg://dstack:test-only@postgres.invalid:5432/dstack?ssl=require"
```

Secret generation does not connect to this URL. Do not run `db-init` for this
configuration-only exercise. For an actual deployment, use the real database
initialization workflow below or an existing managed connection.

## Import Vast.ai and GCP credentials

Run the following from the **deployment directory**. Importing credentials and
generating files is local only; it does not contact providers, install the chart,
or rent GPUs. The import command manages one dstack project per deployment.

```bash
# Interactive: select providers, enter a masked Vast.ai key and/or a GCP JSON path.
scrollsdk setup dstack-config

# Non-interactive: the Vast.ai file contains only the API key.
scrollsdk setup dstack-config --non-interactive \
  --vastai-api-key-file /private/vastai-api-key \
  --gcp-service-account /private/service-account.json
```

The default public configuration is `.data/doge-config.toml`. The command creates
this file when missing and updates only its `dstackController` block when it
exists (TOML formatting/comments may be rewritten). It enables the controller,
preserves custom Secret names/keys and other settings, and adds the GCP credential
mount. It preserves unrelated configuration fields. For a DeploymentSpec-driven
environment, use `--spec deployment-spec.yaml` instead, and pass the same `--spec`
to the generation/upload commands below. Do not alternate source files.

The GCP project defaults to the JSON's `project_id`; `--gcp-project-id` can select
another project the service account is permitted to provision in. `--project`
sets the dstack project name (initial default `main`). The importer validates
the service-account structure and RSA private key locally, not cloud IAM rights,
GPU quotas or account credit.

The private state is `.data/dstack/credentials.json`, mode `0600`. It contains
the imported material plus a randomly generated admin token and AES encryption
key. Back up this file securely with the controller database. Re-importing files
updates provider credentials while preserving the admin token and AES key.
Rerunning without files reuses the saved materials. `--provider vastai --provider
gcp` selects the exact provider set; without this option non-interactive imports
retain previous providers and add supplied ones. Interactive mode asks for the
provider set. Deselecting a provider does not terminate fleets or GPU instances.

The importer adds `/.data/dstack/` and `/secrets/` to the deployment `.gitignore`.
Do not commit source credential files either. It refuses corrupt state and will
not generate new identity keys when local controller Secret outputs exist but
state has been lost. For an existing controller, restore its matching private
state; this command is not an importer for arbitrary existing dstack databases
or configurations containing multiple projects/encryption keys.

## Generate and upload dstack Secrets

The default generated values use PostgreSQL. Initialize it on your selected
database host with `setup db-init --databases dstack` as described below. For an
isolated SQLite controller, explicitly set `dstackController.database.type` to
`sqlite` in the public configuration; no database initialization is then needed.

```bash
# Does not require bridge-init or other chain-service secrets.
scrollsdk setup gen-secrets --dstack-only --non-interactive

# Generate only controller values, without chain initialization or registry checks:
scrollsdk setup prep-charts --dstack-only --non-interactive
```

For a DeploymentSpec-driven environment:

```bash
# Run from the deployment root containing the spec and imported private state.
scrollsdk setup gen-secrets --dstack-only --spec deployment-spec.yaml -N
scrollsdk setup prep-charts --dstack-only --spec deployment-spec.yaml -N
```

If starting a complete deployment from a spec, generate `config.toml` first with
`generate-from-spec --with-values --output .`, then initialize PostgreSQL when
required, and run the commands above. `generate-from-spec` does not support `-N`;
use its own `--json`/`--dry-run` options as needed. An alternate `--output` directory
receives generated configuration, not a copy of `.data/dstack/credentials.json`.
For a new deployment root, import credentials from that root before generating
Secrets; changing `--output` alone does not move the private state.

The generated files use the configured Secret names; defaults are:

| File | Data |
| --- | --- |
| `secrets/dstack-controller-config.yaml` | Native server config with selected backends, Vast.ai key and AES key |
| `secrets/dstack-controller-auth.yaml` | Initial admin token |
| `secrets/dstack-gcp-credentials.yaml` | GCP JSON, when selected |
| `secrets/dstack-controller-database.yaml` | PostgreSQL connection, when selected |

All these files are mode `0600`. Full `setup gen-secrets` also regenerates
controller credentials when imported state exists; manually provisioned
controller credentials remain supported when no imported state exists.

Upload to an **explicit** context and existing namespace. This is the step that
writes to Kubernetes. The namespace is not created automatically. The example
uses values generated by `prep-charts`; with `generate-from-spec`, pass its output
path instead. Include `--spec deployment-spec.yaml` if that is your source.

```bash
# Local validation only: no Kubernetes or provider requests.
scrollsdk setup push-secrets --dstack-only \
  --kube-context YOUR_ISOLATED_CONTEXT --namespace dstack-system \
  --values-file values/dstack-controller-production.yaml \
  --dry-run --non-interactive

# Upload the validated Secret bundle to that destination.
scrollsdk setup push-secrets --dstack-only \
  --kube-context YOUR_ISOLATED_CONTEXT --namespace dstack-system \
  --values-file values/dstack-controller-production.yaml \
  --non-interactive
```

Uploading checks exact Secret references against the production values,
rejects stale generated credentials, and sends only the selected managed files.
Old/unrelated files under `secrets/` are not uploaded. It reads existing controller
config/auth Secrets and refuses to replace differing encryption keys or admin
tokens. It then performs server-side dry-run and server-side apply, without
forcing field ownership conflicts. Kubernetes must allow reading those Secrets
and applying the selected bundle. API failures are redacted because error bodies
can contain credential values. The local `--dry-run` does not test RBAC or live
identity compatibility. Applying several Secrets is not atomic; retry after
fixing a partial failure using the same private state.

`--dstack-only` is a scope filter: **omitting it includes enabled dstack in the
normal full upload**, alongside the other generated services. Ordinary `.env`
and `.json` files go to the selected AWS Secrets Manager or Vault destination;
dstack's existing-Secret manifests go directly to the explicit Kubernetes
context/namespace. Dstack requires the same private state, generated files and
values in either mode. Disabled/absent dstack is skipped, even if stale YAML
files remain. `--cubesigner-only` and `--secret-file` retain their narrow scope
and do not upload dstack.

For example, upload all generated service secrets including enabled dstack:

```bash
scrollsdk setup push-secrets --provider aws --aws-region us-east-1 \
  --kube-context YOUR_ISOLATED_CONTEXT --namespace dstack-system \
  --values-dir values --non-interactive
```

Add `--dry-run` for a local plan with no remote requests to either destination.
For a real full upload, local dstack validation plus live identity/admission
checks run before AWS/Vault writes. Uploading across destinations is not atomic;
if a later step fails, fix it and retry using the same credential state.
`--values-dir` locates dstack's production values in full mode; `--values-file`
continues to select legacy-service values for reconciliation, or dstack values
when using `--dstack-only`.

`--provider kubernetes --dstack-only` remains compatible. Kubernetes is also
accepted without a scope filter when only dstack files are selected. If the
full scope contains `.env`/`.json` files, select AWS or Vault: the command fails
before uploading rather than silently omitting those services. The Kubernetes
context/namespace flags select the destination of dstack Secrets; they do not
change the existing Vault connection settings.

Install the controller chart using the generated values after uploading Secrets.
For a running controller, credential changes require an explicit Deployment
restart because the config is loaded at startup. Uploading Secrets does not restart
or install it, submit tasks, delete retired Secrets, or release GPU resources.

### Offline credential handoff verification

For file generation and Helm rendering only, use the
[configuration-only walkthrough](#configuration-only-walkthrough). The scripts
below have broader local runtime coverage and are not required for that exercise.

After `yarn build`, run `node scripts/dstack-credentials-e2e.mjs`. It requires
Helm, Docker, the sibling controller chart (override with `DSTACK_E2E_CHART`), and
the pinned dstack image already cached locally. It imports disposable fake
credentials through the built CLI, generates Secrets and production values,
validates both backends with the image's real config parser under `--network
none`, renders the chart, and exercises publication/re-publication through a
simulated kubectl process. It deletes temporary credential files afterwards.
This checks the local handoff, not live cloud permissions or a real Kubernetes
API server. The separate database E2E below exercises PostgreSQL/controller startup.

### Configuration acceptance scope (2026-09-25)

Configuration E2E passed against CLI commit `3fb1106` and `scroll-sdk` commit
`2607aa6`. The check used committed snapshots, fake credentials, an empty
credential home and a Linux network namespace without routes. It exercised
both Vast.ai/GCP together, PostgreSQL and SQLite, custom Secret names/keys,
Ingress TLS, an existing PVC, repeated generation, credential updates, stale
Secret rejection, disabled/invalid inputs and both upload scopes in local
dry-run. The controller chart's six offline template tests also passed.

This establishes the local CLI-to-chart configuration handoff. It does not
establish live provider authentication, database connectivity, Kubernetes
admission, controller startup, GPU allocation or real-proof acceptance.

## DeploymentSpec input

Add this optional block to your existing `deployment-spec.yaml`:

```yaml
dstackController:
  enabled: true
  serverConfig:
    existingSecret: dstack-controller-config
    key: config.yml
  auth:
    existingSecret: dstack-controller-auth
    key: admin-token
  database:
    type: postgresql
    existingSecret: dstack-controller-database
    key: database-url
  persistence:
    size: 20Gi
    # storageClass: gp3  # Choose a StorageClass available in your cluster.
  ingress:
    enabled: false
```

All fields above except `enabled` have defaults; `dstackController: {enabled:
true}` is sufficient to generate values using those Secret names. A present
block is enabled unless `enabled: false` is specified. Omitting the block leaves
existing deployments' generated file set unchanged.

```bash
# Generate Helm values only into a review directory.
scrollsdk setup generate-from-spec --spec deployment-spec.yaml \
  --values-only --output ./generated-deployment

# Or generate config.toml, doge-config.toml and Helm values together.
scrollsdk setup generate-from-spec --spec deployment-spec.yaml \
  --with-values --output ./generated-deployment
```

The existing overwrite protection applies: review existing outputs before using
`--force`. `--dry-run --values-only` lists the file without writing it.

Generated dstack production values select external PostgreSQL, a retained 20Gi
PVC, one controller, a digest-pinned official image, CPU/memory resources,
ClusterIP access and no service-account token automount. They can be supplied
directly to the chart without an additional production values overlay. The CLI
does not provision a PostgreSQL server; supply the database URL through the named
Secret. For an isolated SQLite controller, set `database.type: sqlite` explicitly.

### Whole-deployment values are an intermediate stage

`generate-from-spec --with-values` creates initial configuration for all selected
services. Unlike dstack's complete controller overrides, some chain-service
outputs still require the normal post-initialization `prep-charts` flow:

- `l2-sequencer-production.yaml` and `l2-bootnode-production.yaml` contain
  `__INSTANCE_INDEX__`. `prep-charts` expands these into per-instance files such
  as `l2-sequencer-production-0.yaml`. Applying the templates directly would use
  invalid resource names.
- `frontends-config.yaml` is a frontend configuration intermediate consumed by
  `prep-charts`, not an independent chart.
- Full `prep-charts` requires bridge/genesis outputs, including protocol context
  and withdrawal-processor configuration. `--dstack-only` bypasses these unrelated
  prerequisites only for controller configuration.

In the minimal-spec acceptance check, 24 YAML files were generated: 23 service
values plus the frontend configuration intermediate. All 23 service charts
rendered; 21 passed strict lint directly. The two instance templates failed strict
lint because their index placeholders remained. This was not a full
post-bridge/genesis preparation or whole-deployment runtime acceptance. Finish
the chain initialization and instance preparation before treating those service
values as deployment-ready.

## Existing deployment / prep-charts

`generate-from-spec --with-values` also carries the same public configuration
into `.data/doge-config.toml`. For an existing deployment, it can be added there:

```toml
[dstackController]
enabled = true

[dstackController.database]
type = "postgresql"
existingSecret = "dstack-controller-database"
key = "database-url"

[dstackController.serverConfig]
existingSecret = "dstack-controller-config"
key = "config.yml"

[dstackController.auth]
existingSecret = "dstack-controller-auth"
key = "admin-token"
```

Run the existing preparation flow from the deployment directory:

```bash
scrollsdk setup prep-charts --non-interactive
```

It creates/updates `values/dstack-controller-production.yaml` inside the same
generation transaction as the other chart outputs. Repeating the command with
unchanged input leaves the file unchanged. The file is fully managed by this
source block: edit `dstackController`, rather than hand-editing generated values.

When `prep-charts --spec ...` is used, an explicit `dstackController` block in
that spec takes precedence over `doge-config.toml`; otherwise the doge-config
block is used. Existing proof-topology source conflict rules still apply.

Omitting the block or setting `enabled: false` skips generation and preserves
any existing file. This switch does not scale down a controller, uninstall a
release or release GPU instances. Use the separate deployment/resource
lifecycle when retiring a controller. For a generated zero-replica Deployment,
set `replicaCount: 0` while keeping generation enabled.

## Ingress, multiple providers and images

Optional input examples:

```yaml
dstackController:
  enabled: true
  ingress:
    enabled: true
    className: nginx
    hosts: [dstack.example.com]
    tls:
      - secretName: dstack-tls
        hosts: [dstack.example.com]
  credentialSecrets:
    - name: gcp
      secretName: dstack-gcp-credentials
    - name: aws
      secretName: dstack-aws-credentials
  nodeSelector:
    workload: management
```

Credential Secret files are mounted by the chart under
`/etc/dstack/credentials/<name>/`. The actual `config.yml` Secret contains native
dstack project/backends configuration, including AES encryption keys. It can
reference these credential files and configure multiple providers. For
providers such as Vast.ai with inline API keys, store the complete native
configuration inside the Secret. `setup dstack-config` and `gen-secrets
--dstack-only` generate these files for Vast.ai/GCP. The Kubernetes upload
path reads existing controller identity Secrets before applying; it does not
generate ExternalSecret objects. Externally managed Secrets remain supported.
Database credentials can be initialized and exported locally as described below.

The Kubernetes hosting provider (`infrastructure.provider`) does not select
GPU providers. An AWS-hosted controller can use GCP/Vast.ai backends. Backend
credentials, admin authentication and Prover Worker authentication stay separate.

Supported deployment overrides also include `fullnameOverride`, `resources`,
`serviceAccount`, `podAnnotations`, `tolerations`, and PVC settings. A custom
`image` must provide both `repository` and an immutable `sha256` `digest`;
optional `tag` and `pullPolicy` are accepted. Tag-only overrides are rejected
so a new tag cannot silently retain the previous default digest.

Review the generated file against your local chart before deployment:

```bash
helm lint --strict ../scroll-sdk/charts/dstack-controller \
  -f ./generated-deployment/values/dstack-controller-production.yaml
helm template dstack-controller ../scroll-sdk/charts/dstack-controller \
  --namespace dstack-system \
  -f ./generated-deployment/values/dstack-controller-production.yaml
```

These CLI generation commands do not install the chart, submit dstack tasks,
rent GPU instances, or update the deployment Makefile to install this release.

## Initialize the PostgreSQL database

`setup db-init` now initializes only the active SQL consumers: Blockscout and
dstack. It no longer automatically creates the retired rollup, chain-monitor,
bridge-history or L1 Explorer databases. Existing databases and old config
entries are not removed. An enabled PostgreSQL `dstackController` in
`.data/doge-config.toml` opts dstack into the normal interactive/non-interactive
selection; SQLite or disabled controllers are skipped.

To initialize only dstack on an existing PostgreSQL server:

```bash
scrollsdk setup db-init --databases dstack --non-interactive --json
```

Provide administrator and application connection coordinates in `config.toml`:

```toml
[db.admin]
PUBLIC_HOST = "postgres-admin.internal"
PUBLIC_PORT = "5432"
VPC_HOST = "postgres-app.internal"
VPC_PORT = "5432"
USERNAME = "database-admin"
PASSWORD = "$ENV:DB_ADMIN_PASSWORD"
DATABASE = "postgres"
```

`PUBLIC_HOST` is the endpoint reachable by the CLI, not a requirement to expose
the server publicly. `VPC_HOST` is reachable by the controller. The administrator
must be able to create databases/users and grant schema permissions. This
command does not provision an RDS instance or install PostgreSQL in Kubernetes.

The command creates database `dstack` and login `dstack`, grants migration
permissions, writes `[db].DSTACK_DB_CONNECTION_STRING` into private `config.toml`,
and generates `secrets/dstack-controller-database.yaml` with mode `0600`.
The URL uses `postgresql+asyncpg://.../dstack?ssl=require`. Special characters in
passwords are URL-encoded and decoded when reusing the password on later runs.
The public config excludes the entire `[db]` section, and command logs omit DSNs.

Optional `[db]` settings:

- `CREATE_DSTACK_DB = true` opts in without a controller config; an explicit
  `false` disables automatic selection. `--databases dstack` selects it directly.
- `DSTACK_PASSWORD = "$ENV:DSTACK_DB_PASSWORD"` provides a password; otherwise
  an existing URL's password is reused or a random password is generated.
- `DSTACK_SSL_MODE = "disable"` is available for isolated, non-TLS local tests.
  The default is `require`; other supported modes include `verify-full`.

`--doge-config` selects an alternative controller config file. The Secret's name
and key follow `dstackController.database.existingSecret` and `.key`, exactly as
in generated production values. `setup gen-secrets` regenerates the same local
YAML from the saved URL. Its full mode has the usual bridge-init prerequisites;
`--dstack-only` does not.

The local YAML is **not applied automatically**. It contains credentials and
must stay out of version control. Upload it with the rest of the dstack bundle
using `setup push-secrets` and an explicit Kubernetes context/namespace, as
described above. Alternatively, put the URL in your secret manager and map it
to the same Secret name/key with External Secrets.

Permissions and port maintenance also support service selection:

```bash
scrollsdk setup db-init --databases dstack --update-permissions --non-interactive
scrollsdk setup db-init --databases dstack --update-port 5432 --non-interactive
```

Port updates refresh the saved URL and local Secret; they do not change the
server's listening port. `--clean` retains its destructive meaning and should
only be used when deliberately recreating the selected database.

An opt-in isolated PostgreSQL/dstack runtime check is available after building:

```bash
node scripts/dstack-db-init-e2e.mjs
```

It requires locally available `postgres:17.9` and the pinned dstack image, and
uses temporary credentials and an internal Docker network. It checks actual
database initialization, repeat runs, grants, Secret export and the dstack
server's PostgreSQL migrations/authenticated API, then removes its resources.
