# Prepare and activate continuous GPU capacity

Capacity Manager is an independently installed Core service. Select it in the
normal deployment spec and use the staged preparation workflow. `setup aws` validates
optional external AWS network references; `setup render` owns generated policy, Worker
command, fleet definitions and Secret references. The SDK Helm chart initializes
fleets before installing/upgrading the manager. Core owns continuous planning,
reconciliation and per-Worker credentials.

Preparation and fleet initialization request no GPU instances. Installing the
manager starts reconciliation and can rent GPUs when there is backlog or a
nonzero minimum. There is no separate Capacity Manager setup command or overlay.

## Select capacity and transport

Declare `capacityManager` in `deployment-spec.yaml` before `setup plan`, without
`proofWorkers`. Use the approved immutable manager image and a Worker image
qualified for the selected GPU. The saved deployment intent is the only input;
legacy plans and `.scrollsdk/capacity-manager/config.json` overlays are unsupported.
Existing bounded Worker sessions must be retired using their original tooling
before rendering Capacity Manager configuration; this CLI cannot execute their plans. Changing modes on a funded
existing deployment is an operator-reviewed migration, not a reason to replay
genesis or Bridge funding or manually rewrite frozen intent.

```yaml
capacityManager:
  image:
    repository: example.invalid/capacity-manager
    digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
  project: main
  provider: vastai
  gpu: RTX3090
  regions: [us-east]
  fleets: [continuous-rtx3090]
  fleet:
    action: create
    cpus: 16
    memoryGiB: 64
    diskSizeGiB: 200
    idleDurationSeconds: 600
  minWorkers: 0
  maxWorkers: 2
  maxPricePerHourUsd: 0.80
  maxHourlyCostUsd: 4
  scaleDownTtlSeconds: 300
  targetDrainSeconds: 600
  runtimeEstimates:
    scrollChunkSeconds: 900
    scrollBatchSeconds: 300
    l2RangeAggregationSeconds: 1800
    bridgeStateSeconds: 1800
  connection:
    mode: existing-https
    serverUrl: https://controller.example.invalid
```

Replace the nonfunctional image and endpoint before use. Provider regions must be
supported by your configured dstack backend. The `900` second chunk estimate is
an example measured workload setting, not a new universal default. Estimates
inform planning; they are not job timeouts. Omitted estimates retain compatibility
with the existing defaults (60/300/1800/1800 seconds). A zero minimum permits an
idle fleet; Core's backlog floor can still request capacity when work appears.
The hourly budget is a planner admission limit, not an AWS/Vast account billing
cap. Storage, traffic, taxes and delayed provider cleanup are additional costs.
Automatic AWS-to-Vast fallback is opt-in as described below; incompatible GPUs
are rejected during preparation.

`existing-https` uses an operator-owned endpoint. It must have a publicly trusted,
hostname-matching certificate that the released Core image accepts. A self-signed
certificate does not become trusted because the connection is private. Existing
manually created ALBs can use this mode without transferring ownership to the CLI.

Alternatively replace `connection` with the following explicit AWS mode:

```yaml
connection:
  mode: existing-alb
  serverUrl: https://dstack.example.invalid
  existingAlb:
    loadBalancerArn: arn:aws:elasticloadbalancing:us-east-1:000000000000:loadbalancer/app/dstack/0000000000000000
    listenerArn: arn:aws:elasticloadbalancing:us-east-1:000000000000:listener/app/dstack/0000000000000000/0000000000000000
    targetGroupArn: arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/dstack/0000000000000000
```

Use real private subnets in at least two AZs, your VPC caller ranges, and an
existing issued ACM certificate covering the hostname in the same account and
region. The supplied VPC must have DNS support and hostnames enabled. Disable the
controller Ingress; do not also select the older `dstackController.internalTls`
Ingress-based owner. The endpoint need not use any particular domain suffix.

Prepare the private ALB, HTTPS listener, HTTP3000/IP target group, security groups
and DNS through the infrastructure owner, for example using the CLI repository's
CloudFormation templates. Supply the resulting ARNs and HTTPS URL above.
`setup aws` reads and validates them without creating or adopting a stack.
Retain ACM DNS validation records for renewal. Network costs remain outside the
GPU budget.

## Optional AWS-to-Vast fallback

Requires a published immutable manager image containing Core #1612 (commit
`73b06275a0ef19b4a761319215522f6671d2a408`) and capacity-manager chart **0.1.6+**.
The beta.8 manager used by older examples does not support the flag. Update the
pinned SDK revision and Makefile version before preparing. The Helm initialization Job runs the
selected manager image with `--dstack-fallback-fleet ... --help`, without
credentials or reconciliation, to reject binaries lacking the new option.

Merge this under an AWS `capacityManager` selection:

```yaml
capacityManager:
  # Keep primary provider, GPU, project, fleets, image and other required fields.
  fallback:
    provider: vastai
    fleet: vast-fallback
    gpu: RTX3090
    regions: [us-east]
    maxPricePerHourUsd: 0.80
    minReliability: 0.95
```

For imported backends, configure `preparation.dstack.providers: [aws, vastai]`
and `preparation.dstack.vastaiApiKeyEnv: VASTAI_API_KEY`; retain AWS VPC/IRSA
settings. Store the API key in the private environment file. The controller must provide both backends before manager installation; the
Helm initialization Job checks both backends. Fleet names must differ from primary fleet names.

Preparation generates a separate Vast fleet in the same project. It inherits
primary fleet CPU/RAM/disk/idle settings, node maximum and create/reuse action;
its initial minimum/target remain zero. Its GPU, regions, price and reliability
come from `fallback`. Both GPU architectures must be in the checked Worker image,
and the launch command accepts only those qualified architectures. Fallback VRAM
must satisfy the primary policy's requirement. The explicit fallback price must
not exceed primary `maxPricePerHourUsd`, which is the planner's per-worker cost
estimate. The same global worker/budget limits apply across both providers.

Core switches new workers to the fallback fleet for 30 minutes after primary
no-capacity failures or provisioning timeouts, then tries AWS again. It does not
balance workers across providers by percentage. A fallback run uses only its
fleet's selectors, keeping AWS regions/types out of Vast runs. The window is in
memory; restart tries AWS first while adopting existing workers. Other failures
and scale-down do not trigger a switch. Core does not require draining solely
for this option. Render uses the saved deployment intent; installation checks existing fleets
without overwriting different configurations.
Removing `fallback` clears the rendered fallback argument; it does not delete
an old fleet or terminate its instances.

## Prepare the private edge (existing-alb only)

The normal `setup aws` stage reads the declared private network before genesis:

```bash
scrollsdk setup aws --deployment-dir deployment
```

The infrastructure stack must already be ready. The stage checks account/region,
EKS VPC, internal ALB, security groups, certificate, listener forwarding and target
group references, then records a local binding. A failure invalidates the saved
network readiness; repair infrastructure externally and rerun. There is no stack
creation, update, takeover or teardown in this command.

`setup render` projects the recorded TargetGroupBinding into dstack-controller
values. Installing/upgrading dstack creates the binding through its chart; there
is no separate `kubectl apply` step. AWS Load Balancer Controller and its
TargetGroupBinding CRD must already be installed. CloudFormation owns the ALB,
listener and target group; Helm owns the binding that registers Service endpoints.
Stack completion alone does not prove the endpoint is reachable.

## Render and install

Use capacity-manager chart **0.1.6+**, and dstack-controller chart **0.1.6+** when
using `existing-alb`. Select a committed `templates.sdkRevision` containing these
Makefile pins. Updating an SDK working tree alone does not change frozen
templates. Custom Helm flows must select compatible charts too.

After the normal identity, Bridge, proof-material and publication stages:

```bash
scrollsdk setup render --deployment-dir deployment
scrollsdk setup upload-secrets --deployment-dir deployment
```

Render validates the checked Worker/CUDA contract and published artifacts, then
writes the manager policy, public artifact environment, command, empty fleet
intent and WP NetworkPolicy peer. All local generated changes are transactional.
The saved intent is used on every run; there is no `--spec` or `--dstack-url`
capacity-only override. Rendering refuses an unretired SDK Worker session.

Install the supporting services, including dstack, WP and Proof Coordinator with
the generated values, in the saved deployment namespace. Wait for ExternalSecrets
to synchronize. Review the generated manager values, fleet definitions and budget,
then explicitly install the manager:

```bash
cd deployment
make install-capacity-manager KUBE_CONTEXT=YOUR_CONTEXT NAMESPACE=YOUR_NAMESPACE
```

The Make target invokes Helm only. The chart's `pre-install,pre-upgrade` Job:

1. Mounts existing dstack auth, WP auth and Worker master Secret references.
2. Checks DNS/private DNS, dstack TLS/project/backends and WP capacity API access
   using the manager's NetworkPolicy labels. With fallback enabled it first checks
   the selected manager binary supports the fallback option.
3. Creates missing declared fleets with `min: 0`, `target: 0` and a finite maximum,
   or reuses equivalent active/submitted fleets. `fleet.action: reuse` requires
   all fleets to exist. Different configuration or concurrent creation stops the
   operation without forcing an update. Retrying checks the current fleet state.

The Job never starts Worker runs or stores credentials in dstack. It has no
Kubernetes API token or RBAC permissions. A failure blocks the new release's
installation/upgrade; fix the dependency and retry Helm. On an upgrade, the old
manager can remain running while this check executes. Initialization is not a
pause/drain operation. With initialization enabled, direct Helm installation uses
this same gate. Starting the manager afterward can allocate paid workers.

## Diagnose and verify

Runtime diagnostics are outside setup. Always select the Kubernetes context;
the namespace defaults to the prepared target and must match it:

```bash
scrollsdk capacity-manager probe --deployment-dir deployment \
  --kube-context YOUR_CONTEXT --namespace YOUR_NAMESPACE --json
scrollsdk capacity-manager status --deployment-dir deployment \
  --kube-context YOUR_CONTEXT --namespace YOUR_NAMESPACE --json
```

The opt-in probe creates a temporary Pod using the deployed dstack image and
manager labels, checks Secret availability, DNS, TLS/project/backends and WP's
capacity API, then deletes that Pod. It neither changes fleets nor starts Workers.
The CLI does not read Secret values or display raw provider/probe responses. The
probe has a bounded lifetime and no service-account token. After an interrupted
CLI process, remove only its `cm-preflight-*` Pod if one remains. The Python TLS
probe does not establish that the Core binary has the same trust store.

Status is read-only. It reports Deployment replicas and bounded recent reconcile
log observations, omitting raw logs. Unknown log formats or insufficient samples
remain `not-established`; GPU allocation and proof acceptance remain
`not-verified`. Verify actual provider allocation, real proof completion, restart
adoption and confirmed retirement independently. Pausing/uninstalling the manager
does not itself stop remote billing; follow the SDK retirement procedure.

The saved plan, proof receipts and private environment belong to this deployment.
Do not copy another deployment's state or regenerate funded Bridge inputs to
bypass a failed check. Core changes are not part of this command migration.

Runtime estimates, target drain, scale-down TTL and fleet CPU/memory/disk may be
edited in generated values before installation. Render preserves these by fleet
name when omitted from the spec. Explicit spec overrides take precedence; worker
limits, GPU, provider, price/budget and resource bindings remain spec-owned.
