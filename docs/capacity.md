# Changing GPU capacity on a prepared deployment

GPU capacity is configured in one file, `capacity.yaml`, in the deployment
directory: the dstack providers (backends), the fleets the Capacity Manager
uses, prices, worker limits and runtime estimates. Changing it does not need a
new `setup plan`:

1. Prepare the provider resources and credentials.
2. Edit `capacity.yaml` (and, for a new key, the environment file).
3. Run `scrollsdk capacity deploy`, read the summary, confirm.

Run the commands from the directory that holds the deployment directory
(`--dir` defaults to `deployment`), as with the other `scrollsdk` commands:

```bash
$EDITOR deployment/capacity.yaml
scrollsdk capacity deploy            # renders, summarizes, asks, deploys
```

`capacity.yaml` is written when the capacity-manager preparation step
succeeds. A deployment prepared before that gets it on its first
`capacity deploy` (or `capacity render`), which writes the file from the
current deployment and stops without deploying; review it, then run the
command again. That first deploy can still show changes that come from the
newer generation rather than from an edit, for example fleet `regions` that
older values left out, or `initialization.enabled` turning on fleet
preparation. Values edited by hand in `values/capacity-manager-production.yaml`
that `capacity.yaml` covers (such as `steady_state_floor`) are read into the
file.

After that, `capacity deploy` generates the fleets, the policy and the worker
launch settings in `values/capacity-manager-production.yaml`. Everything else in
that file keeps the operator's edits, including the manager `image`, which is
upgraded like any component image. The spec and the frozen intent keep
recording how the deployment was created; they do not change capacity
afterwards.

`capacity deploy` requires capacity-manager chart 0.1.9 or later
(`CAPACITY_MANAGER_CHART_VERSION` in the `Makefile`).

## What `capacity deploy` does

1. **Render.** Validates `capacity.yaml` and writes the deployment files (below).
   When the Vast.ai API key is new or changed, it first sends the request dstack
   uses to validate a Vast backend to Vast.ai, and stops without writing
   anything if Vast.ai rejects the key; dstack itself would only log a warning
   and keep the previous key. Offline, pass `--skip-provider-check`.
2. **Summarize** the changes against the running deployment, not against the
   previous render: backends added or removed (from the controller's live
   `config.yml` Secret), a rotated key, controller values that differ from the
   installed release and whether the controller restarts, fleets created,
   updated in place (with the fields) or no longer declared, and the other
   capacity-manager values that change (from the installed release). Each
   change is shown as `field old -> new`; long values such as certificates
   and digests only as `(changed)`. Secret data is never shown: a new
   Vast.ai key appears as "API key rotated (...ab12 -> ...cd34)", the last
   four characters of the running and the new key.
   Errors about `capacity.yaml` name its fields.
3. **Confirm.** Interactive runs ask; non-interactive runs need `--yes`; with
   `--json`, the refusal carries the summary in its error `context`. When
   nothing changed, it stops here. A fleet change dstack cannot make in place
   (see [Fleet changes](#fleet-changes)) stops here too, before asking.
   Whenever deploy stops before the upload (refused, declined, or without
   `--yes`), it puts back the files render wrote: nothing changes in the
   cluster or in the deployment files, and `capacity.yaml` keeps your edits.
4. **Upload** the dstack Secrets, as `setup push-secrets --dstack-only`.
5. **Upgrade dstack-controller** (`make install-dstack-controller`) and wait for
   the rollout. dstack reads `config.yml` only at startup; the changed
   `checksum/server-config` annotation restarts it when the providers or keys
   changed. On startup dstack creates or updates the listed backends and
   deletes the backend types the file no longer lists. Running instances keep
   running; the dstack API is unavailable during the restart. After a restart,
   deploy reads the controller log: dstack only logs a backend it cannot create
   or update (keeping an existing backend's previous credentials), so a
   `Failed to create backend` or `Failed to update backend` line stops the
   deployment here, before any fleet changes.
6. **Upgrade capacity-manager** (`make install-capacity-manager`). The chart's
   pre-upgrade initialization Job checks that every selected provider's backend
   exists, then creates missing fleets with no instances and updates changed
   fleets in place (see [Fleet changes](#fleet-changes)). If a backend is
   missing, the Job names it and nothing is changed.

Every step can be repeated: after a failure, fix the cause and run
`capacity deploy` again. The kube context and namespace are the prepared
deployment's; the Makefile targets get them explicitly.

| Failed at | State | Next |
|---|---|---|
| Render | Nothing changed | Fix the reported input |
| Upload | Secrets may be new; the controller has not restarted | Run deploy again |
| Controller rollout | The previous manager keeps running | Read the controller log, fix, run deploy again |
| dstack backends (logged failure) | The controller runs the new config; an existing backend keeps its previous credentials; the previous manager keeps running; no fleet changed | Fix the named backend's credentials; run `capacity deploy` (with `--restart-controller` if the fix was outside the deployment files). After a key rotation, keep the previous key |
| Capacity Manager (missing backend) | As above | The initialization Job names the missing backend; same fix |

`--restart-controller` restarts the controller even when `config.yml` did not
change. dstack creates backends only at startup, so after fixing credentials
outside the deployment files (for example an IAM role), this is how it retries.

`scrollsdk capacity render` runs step 1 only, for reviewing the files with
`git diff` or checking them offline; its summary compares with the previous
render. It changes nothing in the cluster.

## Files written by render

| File | Content |
|---|---|
| `.data/dstack/credentials.json` | The providers and their credentials, read from the environment file. Private |
| `secrets/dstack-controller-config.yaml` (and the other dstack Secret files) | The controller's `config.yml`, listing every backend. Private |
| `values/dstack-controller-production.yaml` | Only the pod annotation `checksum/server-config`, the digest of `config.yml`; the rest of this file is the operator's |
| `values/capacity-manager-production.yaml` | Fleets, prices, policy, worker launch and the `initialization` fleets |
| `.scrollsdk/capacity-manager/` | The prepared plan and fleet files used by `capacity-manager probe` |

Provider credentials come from the deployment environment file: the file saved
by `setup plan`, `./deployment.env`, or `--env-file`. `setup render` and
`setup prep-charts` read `capacity.yaml` too, so they do not revert a change.
`setup dstack-config` refuses once `capacity.yaml` exists, and `secrets sync`
does not deploy dstack provider keys: it points to `capacity deploy` when the
environment holds a different Vast.ai key.

## `capacity.yaml`

```yaml
apiVersion: scrollsdk.dogeos/capacity/v1
project: main                      # the controller's dstack project; cannot change
providers:
  aws:
    vpcIds: {us-east-1: vpc-REPLACE_WITH_EXISTING_VPC_ID}
    publicIps: false
  vastai:
    apiKeyEnv: VASTAI_API_KEY      # the value stays in the environment file
primary:
  fleet: aws-l4
  provider: aws
  gpu: L4
  regions: [us-east-1]
  instanceTypes: [g6.4xlarge]      # optional
  maxPricePerHourUsd: 1.50         # fleet max_price and the manager's per-run ceiling
fallback:                          # optional; used for 30 minutes after primary no-capacity failures
  fleet: vast-rtx3090
  provider: vastai
  gpu: RTX3090
  regions: [us-texas, us-colorado]
  maxPricePerHourUsd: 0.80
  minReliability: 0.95             # Vast only
resources: {cpus: 16, memoryGiB: 64, diskGiB: 200, idleSeconds: 600}   # every fleet
scaling:
  minWorkers: 0
  maxWorkers: 1
  maxHourlyCostUsd: 3
  # workerBudgetUsdPerHour: 1.5    # default: the larger pool price
  scaleDownTtlSeconds: 300
  steadyStateFloor: 1              # workers kept while work is queued; 0 keeps no idle GPU
  targetDrainSeconds: 600
runtimeEstimates: {scrollChunkSeconds: 60, scrollBatchSeconds: 300, l2RangeAggregationSeconds: 1800, bridgeStateSeconds: 1800}
```

The rules are the same as for `capacityManager` in the deployment spec: both
GPU architectures must be in the checked Worker image, `workerBudgetUsdPerHour`
must cover both pool prices, `maxHourlyCostUsd` must fund `minWorkers`, and
every AWS region needs a VPC ID. Any provider pair is accepted for the primary
and the fallback, for example a Vast primary with an on-demand AWS fallback. See
[activation](capacity-manager-activation.md#optional-fallback-fleet) for the
fallback semantics. A GCP backend imported earlier is not managed by
`capacity.yaml` and stays in `config.yml`.

The file holds environment variable names only. Keep it in the private
deployment repository with the rest of the deployment directory.

## Common changes

| Change | Prepare | Edit | Notes |
|---|---|---|---|
| Add Vast.ai | API key in the environment file | `providers.vastai` and a pool | The controller restarts with the new backend; the new fleet is created |
| Add AWS | Controller IAM role, VPCs, GPU quota (see [AWS providers](#aws-providers)) | Controller values identity; `providers.aws` and a pool | As above |
| Rotate the Vast.ai key | New key in the environment file | — | Only the controller restarts. After deploy reports success it names the key dstack now uses and the one no longer configured, by their last four characters; revoke the latter then. If deploy fails, revoke nothing |
| Remove a provider | — | Remove it from `providers` and the pools | The summary marks the backend deletion and the fleets left in dstack |
| Workers, budget, steady-state floor, runtime estimates | — | `scaling`, `runtimeEstimates` | Only the manager changes |
| A fleet's price, regions, GPU, instance types, resources or worker maximum | — | The pool or `resources` | Updated in place; see below |

## Fleet changes

`capacity deploy` and `capacity render` set the initialization Job's
`fleetAction: update` (chart 0.1.9). Preparation keeps the intent's `create` or
`reuse`, so the first activation behaves as before. An existing fleet that differs from the rendered definition is
updated in place, through dstack's own plan and apply, against the fleet just
read and without force: a concurrent change fails the install. Only the fields
dstack updates in place may change: `nodes` (the worker maximum), `resources`
(CPU, memory, disk, GPU), `backends`, `regions`, `instance_types`,
`spot_policy` and `max_price`. Any other change, such as `resources.idleSeconds`
(`idle_duration`), a Vast `minReliability` (`backend_options`) or moving a fleet
to another provider, is refused at the summary, before anything changes. Give
the fleet a new name in `capacity.yaml` instead: the new fleet is created, and
the old one is listed as no longer declared; [delete it](#deleting-a-fleet) once
it has no instances.

After an update, dstack terminates the fleet's idle or provisioning instances
that no longer match it, and idle instances above a lowered maximum. Busy
instances keep running until they finish and go idle. A `helm rollback` of the
manager does not run the Job and leaves the fleets as they are; to revert, put
the previous values back in `capacity.yaml` and run `capacity deploy` again.

## Limits

- **Restarts.** Provider and key changes restart the dstack controller.
- **Fleets no longer declared stay.** The summary lists them; delete them once
  they have no instances (below).

## Deleting a fleet

dstack keeps a fleet that `capacity.yaml` no longer declares. An empty fleet
costs nothing, but delete it to keep the project clear. Use the dstack CLI
(the version of the controller, 0.21.5) through a port-forward, with the
controller's admin token:

```bash
CTX=KUBE_CONTEXT NS=NAMESPACE PROJECT=PROJECT_FROM_CAPACITY_YAML
# Choose a local port nothing else listens on (check with: ss -ltn).
kubectl --context $CTX -n $NS port-forward deployment/dstack-controller 13000:3000 &
TOKEN=$(kubectl --context $CTX -n $NS get secret dstack-controller-auth -o jsonpath='{.data.admin-token}' | base64 -d)
dstack project add --name $PROJECT --url http://127.0.0.1:13000 --token "$TOKEN" -y
dstack fleet --project $PROJECT list
dstack fleet --project $PROJECT delete OLD_FLEET   # asks for confirmation
dstack project delete --name $PROJECT -y            # removes the local client entry and token only
kill %1
```

The Secret and key names are the controller's `auth.existingSecret` and
`auth.key` in `values/dstack-controller-production.yaml`.

## AWS providers

An AWS backend uses the controller's workload role (`creds: default`); the role
and its permissions are managed outside the CLI (see
[dstack AWS preparation](dstack-aws-preparation.md)). On a prepared deployment
the controller values belong to the operator, so give the controller its
identity there, in `values/dstack-controller-production.yaml`, before adding
AWS to `capacity.yaml`:

```yaml
defaultCredentialsEnabled: true
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT_ID:role/EXISTING_DSTACK_CONTROLLER_ROLE
extraEnv:
  - name: AWS_EC2_METADATA_DISABLED   # never fall back to the node's instance role
    value: "true"
```

For a deployment prepared for EKS Pod Identity (`awsWorkloadIdentity:
pod-identity`), name the ServiceAccount (`serviceAccount.name`) bound by
the Pod Identity association instead of the annotation. `capacity deploy`
refuses an AWS provider until these values are present.
