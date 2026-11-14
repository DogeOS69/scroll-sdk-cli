# Changing a prepared deployment

This page lists the routine changes to a deployment after `setup plan` and its
stages reported `prepared`, and how to make each one.

## Rules

- **Day-2 files belong to the operator.** After `prepared`, `values/`, the
  `Makefile` and `secrets/` in the deployment directory are the deployment's
  configuration. Preparation stages never regenerate completed steps, so they
  do not overwrite edits. Keep the directory in its private repository and
  commit changes there.
- **The spec and the frozen intent record how the deployment was created.**
  They are not kept in step with day-2 changes, and editing them changes
  nothing on a prepared deployment.
- **A new `setup plan` is for a new chain only.** It creates a new deployment
  directory, new genesis and new credentials. Use it for re-genesis, with a
  clean environment (namespace or cluster, dstack database and secret store
  paths), never for a configuration change.
- **Apply through the Makefile.** `make install-<component>` runs `helm upgrade`
  with the deployment's kube context, namespace and pinned chart version. Run
  it from the deployment directory and check `KUBE_CONTEXT` and `NAMESPACE`
  first.

## Tasks

| Change | Edit | Apply | Restarts |
|---|---|---|---|
| Service image | `image.tag` (and digest, where pinned) in `values/<component>-production.yaml` | `make install-<component>` | That component |
| Chart version | `<COMPONENT>_CHART_VERSION` in the `Makefile`, or pass `<COMPONENT>_CHART=<path or ref>` for one run | `make install-<component>` | That component, if the rendered workload changed |
| Chart values: resources, replicas, alert timing, flags | `values/<component>-production.yaml` | `make install-<component>` | That component, if the rendered workload changed |
| GPU capacity: providers, fleets, prices, worker limits, runtime estimates | `capacity.yaml` (an AWS provider also needs the controller identity in `values/dstack-controller-production.yaml`) | `scrollsdk capacity deploy`. See [capacity](capacity.md) | The dstack controller when its providers or keys change; the manager |
| A dstack provider key (Vast.ai) | The private environment file (`deployment.env`) | `scrollsdk capacity deploy` | The dstack controller |
| Another secret value: RPC URL, API key, password | The private environment file (`deployment.env`) | `scrollsdk secrets sync --apply`, then the restarts it prints. See [secrets sync](secrets-sync.md) | The workloads reading the changed Secrets, restarted by the operator |
| CubeSigner session | — | `scrollsdk cubesigner refresh-session`; see [CubeSigner preparation](cubesigner-preparation.md) | The signer, as documented there |
| Attestation signer set | — | `scrollsdk bridge rotation register`, `send`, `online` | None; an on-chain rotation |
| Status page bindings | — | `scrollsdk monitoring status-page --plan` and `--apply`; see [status page](status-page.md) | None |

### Checks before applying a values change

- Render first and review: `helm template` (or `helm diff upgrade`, when
  installed) with the same release name, chart version and values file as the
  Makefile target.
- For components with on-chain side effects (sequencers, withdrawal processor,
  DA submitter, fee oracle), choose the moment of restart: for example, do not
  restart the DA submitter while a blob transaction is pending.
- Back up a values file before editing it if the change is experimental, and
  revert by restoring the file and running the same `make` target.

## What is not a day-2 change

- Chain identity: chain IDs, genesis, contracts, the Bridge seed, recovery
  keys, sequencer and node identities. These need re-genesis.
- Signing and node keys. `secrets sync` refuses to change them.
- The dstack controller encryption key. It protects the dstack database and is
  never regenerated; restore it from backup if it is lost.
