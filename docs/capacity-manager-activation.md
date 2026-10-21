# Prepare and activate continuous GPU capacity

Capacity Manager is an independently installed Core service. Preparing its files
must not rent GPUs. Its installation can rent GPUs as soon as the control loop
observes demand or a nonzero minimum. This workflow reuses the deployment's
frozen intent, checked Worker image, published proof artifacts and governance
receipts. It does not repeat genesis, Bridge funding or proof baking.

The CLI owns configuration, optional AWS network preparation and installation
preflight. The SDK owns Helm charts and the Makefile install target. Core owns
planning, reconciliation, Worker credentials and proof execution. No Core changes
are required by this workflow.

## Select capacity and transport

For an existing deployment, put only the desired `capacityManager` block in an
overlay such as `capacity-selection.yaml`. Do not also select `proofWorkers`.
Other overlay fields do not replace the frozen deployment identity or namespace.
Use the approved immutable manager image and the GPU architecture already checked
for this deployment; changing an image name is not GPU qualification.

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
  mode: internal-alb
  internalAlb:
    awsProfile: default
    region: us-east-1
    stackName: example-dstack-private-https
    vpcId: vpc-00000000000000000
    subnets: [subnet-00000000000000001, subnet-00000000000000002]
    inboundCidrs: [10.0.0.0/16]
    hostname: dstack.example.invalid
    certificateArn: arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000
```

Use real private subnets in at least two AZs, your VPC caller ranges, and an
existing issued ACM certificate covering the hostname in the same account and
region. The supplied VPC must have DNS support and hostnames enabled. Disable the
controller Ingress; do not also select the older `dstackController.internalTls`
Ingress-based owner. The endpoint need not use any particular domain suffix.

The CLI creates a dedicated CloudFormation stack containing an internal ALB,
HTTPS listener, HTTP port 3000 target group, security group, exact-host Route53
private hosted zone associated with the VPC, and alias record. It reuses the ACM
certificate. The narrow private zone avoids shadowing unrelated public records.
Cloudflare requires no change when the existing certificate is already validated;
retain its existing public ACM validation record for renewal. Internal ALB and
private hosted zone charges are separate from the GPU budget.

## Optional AWS-to-Vast fallback

Requires a published immutable manager image containing Core #1612 (commit
`73b06275a0ef19b4a761319215522f6671d2a408`) and capacity-manager chart **0.1.5+**.
The beta.8 manager used by older examples does not support the flag. Update the
pinned SDK revision and Makefile version before preparing. Preflight runs the
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
settings. Store the API key in the private environment file. Existing deployments
must provision both backends in their existing project first: a capacity-only
`prepare --spec` overlay does not replace frozen backend credentials. Preflight
checks both backends. Fleet names must differ from primary fleet names.

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
for this option. Rerun preparation to update the selected fleets and values;
the CLI does not require draining or archiving the plan for configuration changes.
Removing `fallback` clears the rendered fallback argument; it does not delete
an old fleet or terminate its instances.

## Prepare the private edge (internal-alb only)

From the repository root, with the generated deployment in `deployment/`:

```bash
scrollsdk setup capacity-manager network --dir deployment --spec capacity-selection.yaml --json
```

This local preview writes `.scrollsdk/capacity-manager/network-template.json` and
makes no AWS calls. Inspect the template, then explicitly request resources:

```bash
scrollsdk setup capacity-manager network --dir deployment --spec capacity-selection.yaml --apply --json
```

Creation is asynchronous. Repeat the same `--apply` command to read back the
stack until the result is `ready`. It does not rent workers. A repeated invocation
checks ownership tags, intent and template, rather than updating an existing stack
by name. Failed/rollback stacks require operator inspection of CloudFormation
events; the CLI does not delete/recreate them or overwrite another owner's DNS.
Changed network intent requires an explicitly reviewed replacement, or switching
to an already provisioned `existing-https` endpoint. There is no automatic teardown.

Once ready, review the generated TargetGroupBinding and apply it to the intended
cluster. AWS Load Balancer Controller and its TargetGroupBinding CRD must already
be installed, and `dstack-controller` must expose HTTP port 3000:

```bash
kubectl --context YOUR_CONTEXT apply -f deployment/.scrollsdk/capacity-manager/dstack-targetgroupbinding.json
```

CloudFormation owns the listener and target group. The binding lets the Kubernetes
controller register Service endpoints and authorize backend traffic from the ALB
security group. The CLI does not silently apply Kubernetes resources during network
preparation. `ready` means stack creation completed; the later probe establishes
reachability after the binding has reconciled. CloudFormation template readback
is not a substitute for a full AWS drift audit.

## Prepare and check before takeover

Generated values use `manager.workerEnv` for public artifact URLs and SHA-256
digests, with quoted references in `manager.workerCommand`. Use capacity-manager
chart **0.1.4 or newer** and a committed SDK `templates.sdkRevision` containing
that interface and the matching Makefile pin. Templates are read from the pinned
Git commit, so an updated SDK working tree alone is insufficient. Preparation
rejects an older `CAPACITY_MANAGER_CHART_VERSION` in the deployment Makefile;
custom install flows without that variable must select a compatible chart too.
Older charts ignore the map and leave the worker without its artifact variables.
The map is not a place for credentials: Core injects each worker token separately.
Rerunning preparation updates the local plan and generated values. The CLI does
not hash these configuration files or require a drain when they change. Core
continues to manage running workers using its own runtime configuration identity.

```bash
scrollsdk setup capacity-manager prepare --dir deployment --spec capacity-selection.yaml
```

The capacity selection is saved under `.scrollsdk/capacity-manager/config.json`;
subsequent rendering uses it. A legacy `--dstack-url https://...` selection is also
persisted. Preparation validates the published Worker/CUDA contract and writes
fleet definitions with zero initial instances. It also adds the manager's selector
to the WP NetworkPolicy values. Install/upgrade WP's generated NetworkPolicy before
the probe; changing a YAML file alone does not change the live policy.

Preparation is allowed while the old bounded Worker is running. It does not stop
that Worker. However, the new plan prevents another bounded `apply` from competing
for ownership. Before installing Capacity Manager, gracefully retire the old
session using its own saved plan:

```bash
scrollsdk setup proof-workers drain --deployment-dir deployment --json
scrollsdk setup proof-workers status --deployment-dir deployment --json
```

Repeat `drain` until state is `destroyed`: the run has finished and its fleet is
absent/terminated. `drain` sends dstack `abort=false` and waits for the run to
finish before deleting its fleet. It is not proof that the Worker completed its
current proof. The original watchdog's absolute deadline still applies and can
force cleanup. `destroy` remains the explicit forced-stop alternative. Do not
manually mark the old state destroyed to bypass takeover checks.

Run the independent preflight (it may also run before draining):

```bash
scrollsdk setup capacity-manager preflight --dir deployment --kube-context YOUR_CONTEXT --json
```

This creates a temporary Pod using the deployed dstack image and the manager's
source selectors, mounts the existing Secret references, and checks:

- DNS, plus private address resolution for the internal ALB mode;
- trusted TLS and authenticated access to the selected dstack project/backend;
- the authenticated WP `/v1/proof-work/capacity/summary` endpoint, through the live
  NetworkPolicy;
- availability and nonempty values for dstack auth, WP auth and the Worker master.

The CLI does not read Secret contents back or display raw probe/provider responses.
The Pod has no service-account token, has a bounded lifetime, and is deleted after
the check. Probe creation needs operator Kubernetes permissions. After an interrupted
CLI process, remove only its `cm-preflight-*` Pod if one remains. This connectivity
probe uses dstack's Python TLS trust; Core's own successful reconcile remains a
separate runtime check. No proof is executed by this probe.

## Install and verify

Review the generated values and budget, then run the SDK's explicit target:

```bash
cd deployment
make install-capacity-manager KUBE_CONTEXT=YOUR_CONTEXT
scrollsdk setup capacity-manager status --dir . --live --json
```

Preparation preserves the existing Makefile and ensures its install target calls `scrollsdk setup capacity-manager credentials --dir .`
with its selected context/namespace **before** Helm. A pinned SDK Makefile missing the independent install target is rejected. That command verifies that
bounded workers are retired, validates prepared value/fleet hashes, reruns the
connectivity probe, and creates/checks empty fleets.
It never starts a Worker. The subsequent Helm install starts the manager and may
allocate paid GPUs. A direct Helm invocation bypasses this CLI gate.

`status` reports Kubernetes replicas separately from `--live`'s bounded recent log
observations. At least two recent reconcile decisions without observed errors are
reported as observations, not end-to-end acceptance. Unknown log formats or too
few samples remain `not-established`. GPU allocation and real proof acceptance
remain `not-verified`; confirm these separately with actual workload evidence.
A ready Pod or an idle control loop is not evidence that a provider can supply a
GPU or that a real proof has completed.

For an older plan without the new integrity/preflight fields, regenerate with the
new CLI before activation. Keep local state private. Do not copy a plan from a
different deployment, erase proof evidence, or regenerate funded Bridge inputs.

## SDK integration contract

No SDK or Core patch is included in this CLI change. Existing compatible SDK charts
provide the three Secret mounts, independent Deployment, retained state PVC and
WP NetworkPolicy peer. When updating SDK examples, keep the credentials preflight
before Helm in `install-capacity-manager`, and point operators at this sequence.
Do not hide network provisioning, stopping bounded workers, or GPU activation
inside `install-all`. Keep the private binding's lifecycle distinct from the Helm
release, because its AWS resources are owned by the dedicated stack.
