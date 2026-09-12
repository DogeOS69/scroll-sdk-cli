# Instance deployment orchestration design

Status: proposed design; the commands in this document are not implemented yet.

This document turns the repeatable parts of a complete DogeOS deployment into
`scrollsdk` capabilities. It is based on the fresh Devnet deployment runners,
the Shadowfork Bridge wrapper, proof release preparation, partner-signer
cutover, recovery work, and acceptance tests exercised during the September
2026 rollout.

The main finding is that `scrollsdk` already owns most deterministic setup
operations, but the deployment repository still needs a large orchestration
layer to call them in the correct order, protect non-idempotent transactions,
install charts, and retain enough evidence to resume safely. That reusable
orchestration belongs in this repository. Environment identities, credentials,
incident history, and acceptance results do not.

## Goals

- Deploy a fresh instance from an already provisioned environment without
  copying and editing a deployment-specific orchestration script.
- Preserve an explicit boundary around Bridge creation and transaction
  broadcast. A timeout must never cause an automatic second Bridge, funding
  transaction, CubeSigner key, or fee-oracle transfer.
- Make every Kubernetes and Helm operation target an explicit context and
  namespace.
- Resume after a local, provider, network, Helm, or process failure using
  durable checkpoints and immutable input hashes.
- Delete only resources proven to belong to the selected instance.
- Generate and validate production configuration from canonical inputs rather
  than accumulating manual edits to generated files.
- Keep proof release preparation, proof topology switches, partner signer
  handoff, and paid compute as visible operator decisions.
- Produce machine-readable plans, state, ownership, and readiness receipts.

## Non-goals

- Creating EKS, DNS zones, a shared Dogecoin node, a shared monitoring stack,
  RDS, or all other infrastructure from nothing.
- Embedding one environment's cluster ARN, AWS account, domain, bucket, image
  tag, KMS key, signer host, or Shadowfork API key in the CLI.
- Implementing dogeos-core/OpenVM identity, commitment, materialization, or
  proving algorithms in TypeScript.
- Deploying or controlling a partner's Attestation Signer without an explicit
  handoff and transport adapter.
- Treating deployment readiness as withdrawal or real-proof acceptance.
- Automatically recovering an incident by editing a Withdrawal Processor
  database, deleting proof rows, or replaying a proposal.
- Updating `scroll-sdk` chart defaults or examples from this repository. The
  CLI validates their contracts; the chart repository owns their contents.

## Audited deployment actions

The following table records what happened during the deployment and where the
long-term capability should live. "Existing" means an atomic CLI command is
already available; it may still need to be called by the new orchestrator.

| Deployment action | Long-term owner | Proposed treatment |
| --- | --- | --- |
| Read the environment, resolve `$ENV:` references, and generate canonical base files | CLI, existing | Extend `DeploymentSpec`; do not introduce another unrelated configuration format. |
| Check chart versions against a known deployment and coordinate `gen-configs-*`, `deploy-*`, and `verify-*` revisions | CLI | Resolve a version lock before mutation and reject a mixed contracts revision. Do not infer a genesis tag from a core image tag. |
| Select special image versions for individual services | CLI schema plus environment lock | Store per-component immutable references in a deployment lock. Environment repositories choose the versions. |
| Pass `--kube-context` to Helm and `--context` to kubectl | CLI | Centralize process invocation and require one resolved Kubernetes target for every cluster operation. |
| Inventory existing releases, fixed-name objects, PVCs, and protected unrelated resources | CLI | Add a read-only inventory phase before any local, AWS, signer, Secret, or cluster write. |
| Clean a previous instance before a replacement deployment | CLI | Add receipt-scoped `deploy cleanup`; never discover deletion authority by resource name or prefix. |
| Archive old generated Bridge/protocol outputs while retaining reusable Reth, KMS, signer, and proof inputs | CLI | Add an explicit pre-Bridge archive allowlist and hash its result. Do not archive arbitrary files. |
| Configure domains | CLI, existing | Orchestrate `setup domains` and validate the resulting ingress host relationships. |
| Verify the CubeSigner environment, create a new role/key, and refresh its session | CLI, existing atomic commands | Orchestrate `setup cubesigner-init --new` and `setup cubesigner-refresh`; record only public identifiers and hashes. Never remove or replace existing policies. |
| Configure KMS-backed fee-oracle and DA submitter identities | CLI, existing | Validate address/key/region/IRSA agreement. A service may require an address without a local private key. |
| Generate native Reth genesis and contracts outputs | CLI, existing | Orchestrate `setup gen-l2-artifacts`, freeze output hashes, validate chain ID, native DOGE predeploy, gas limit, and matching contracts revision. |
| Create/fund the Bridge, mine Shadowfork maturity blocks, and generate protocol context | CLI core plus funding adapter | Keep `setup bridge-init` authoritative. Add a checkpointed `deploy bridge` driver with manual and optional Shadowfork funding adapters. |
| Configure the shared DA/proof S3 prefix and IAM | CLI, existing | Orchestrate `setup eth-da-submitter` and `setup proof-aws-init`; bind all components to one canonical store and instance prefix. |
| Prepare and publish real-proof materials | CLI, existing on the proof release workflow | Reuse `proof-release-prepare`, `proof-worker-image-check`, `proof-materials`, and `proof-bundle-publish`. Do not duplicate native build logic in deployment orchestration. |
| Select disabled/mock/real and observe/enforce proof posture | CLI, existing generation | Treat each switch as a reviewed deployment transition; compile, validate, and record the resolved contract before rollout. |
| Prepare charts and native service configuration | CLI, existing | Orchestrate `prep-charts` and `proof-config-check`; reject hand-edited compiler-owned proof blocks. |
| Add missing production command, ports, probes, SQLite PVC, monitoring, ServiceAccount/IRSA, ingress, 10M gas, empty-block, and native-token configuration | Chart repository plus CLI validation | Generic defaults/examples belong to `scroll-sdk`. DeploymentSpec supplies supported overrides; CLI checks the rendered contract and reports missing chart capabilities. |
| Push service and CubeSigner Secrets | CLI, existing | Reconcile selected secrets with an explicit provider, region, and prefix. Never print payloads or infer that an existing shared Secret is safe to overwrite. |
| Create fresh per-instance storage | CLI | Render PVCs from spec, annotate them with instance and protocol identity, and refuse old or unowned claims. |
| Render and install local or OCI charts in dependency order | CLI | Add a chart catalog/lock, Helm template validation, server-side dry run, install checkpoints, and readiness gates. |
| Fund the fee-oracle account | CLI deployment action | Make this optional and checkpoint the signed transaction before broadcast. An unfunded fee oracle is a readiness warning when the operator chooses not to fund it. |
| Produce self-contained per-signer Compose bundles, including each `SIGNER_PORT` | CLI | Generate a public handoff bundle and private environment files. Applying them remains adapter/operator controlled. |
| Switch the three EC2 test Attestation Signers | Environment transport adapter | The CLI may provide an SSH/Compose adapter, but a normal deployment must require an explicit signer-cutover flag and exact remote ownership evidence. |
| Verify signer reachability from the TSO network path | CLI | Probe from the caller's network, validate descriptor public key/network, and distinguish transport failure from signer rejection. |
| Keep genesis hold enabled during bootstrap, then release and verify durable state | CLI | Add a lifecycle phase that observes persisted state before issuing the control request. Never infer release from generic health alone. |
| Check L2 genesis agreement, chain ID, 10M gas limit, empty blocks, DA archive status, service readiness, and ingress | CLI | Implement `deploy status`/final readiness receipt using service APIs and existing test commands. |
| Use fast confirmation values on Devnet and restore defaults | Environment profile consumed by CLI | Add named confirmation profiles to the spec/overlay mechanism. Fixed Devnet numbers remain in the environment repository; SDK examples retain production defaults. |
| Generate a 3,000-input deposit, withdrawal smoke test, and offline Batch materialization trace | CLI test commands where reusable | Port deterministic transaction building and generic checks. Shadowfork mining credentials and test receipts stay in the deployment repository. |
| Rent/start/stop a dstack GPU Worker | CLI proof-capacity provider | Implement the complete paid-capacity lifecycle as explicit `plan/start/status/stop` commands. Require an immutable worker receipt, explicit apply, maximum runtime/cost controls, and terminal provider verification. |
| Observe real proofs and enforce them | CLI transition plus environment acceptance | CLI validates and applies the posture; the deployment repository records the observation window and evidence. |
| Comment on GitHub issues or monitor incident replies | Environment/operator tooling | Keep outside the deployment CLI. |
| Apply one-off proof regeneration/reset declarations or TSO/WP incident recovery | dogeos-core runbook plus explicit operator action | CLI may validate a maintainer-provided declaration later, but must not invent or silently apply one. Never add generic database mutation. |

## Ownership boundaries

### Belongs in `scroll-sdk-cli`

Reusable deterministic logic belongs here:

- deployment plan and version-lock resolution;
- explicit cluster targeting and process execution;
- phase state, input/output hashes, locks, and resume rules;
- Bridge step fencing and funding-provider interfaces;
- resource inventory, rendered-manifest collision checks, ownership receipts,
  and receipt-scoped cleanup;
- orchestration of existing setup, proof, secret, and validation commands;
- chart rendering, server-side validation, installation, and readiness checks;
- generic signer bundles and caller-path connectivity checks;
- lifecycle controls such as genesis-hold release;
- generic acceptance commands and machine-readable receipts.

### Remains in a deployment repository

An environment repository supplies policy and deployment facts:

- cluster ARN, namespace, cloud account/region, domain, S3 bucket/prefix root,
  KMS descriptors, network endpoints, signer host routing, and secret refs;
- approved chart and image versions, local chart overrides, storage sizes,
  confirmation profile values, ingress enablement, and optional components;
- Shadowfork API credentials and environment-specific mining adapter settings;
- operator decisions to replace an instance, switch partner signers, broadcast
  transactions, rent paid compute, or activate proof enforcement;
- execution logs, acceptance evidence, incident notes, and issue comments.

`.data/` remains the location for canonical generated runtime inputs and
private configuration. Deployment state and evidence go under
`artifacts/deployment/`; command transcripts go under `logs/deployment/`.

### Remains in `scroll-sdk` and dogeos-core

- `scroll-sdk` owns chart templates and the `example/values/*-production.yaml`
  defaults. When a service gains a generally required command, port, probe,
  volume, monitoring, ingress, ServiceAccount, or runtime setting, the chart
  and example must change together.
- dogeos-core owns service behavior, configuration semantics, proof algorithms,
  reset/recovery behavior, and executable health contracts.
- `scrollsdk` should fail with a precise compatibility error when the selected
  chart or binary lacks a required capability; it must not emulate that service
  behavior with ad-hoc Pods or SQL as the normal design.

## Proposed command surface

Add a `deploy` topic and an operational `proof worker` group while retaining
the existing `setup` commands as atomic, independently useful operations.

```text
scrollsdk deploy plan
scrollsdk deploy pre-bridge
scrollsdk deploy bridge
scrollsdk deploy post-bridge
scrollsdk deploy status
scrollsdk deploy cleanup
scrollsdk proof worker plan
scrollsdk proof worker start
scrollsdk proof worker status
scrollsdk proof worker stop
```

All `deploy` commands accept the same identity inputs:

```text
--spec deployment-spec.yaml
--instance <instance-id>
--state-root artifacts/deployment
--non-interactive
--json
```

Cluster-mutating commands resolve `infrastructure.kubeContext` and
`infrastructure.namespace` from the spec, with explicit flags allowed only as
reviewed overrides. The resolved target is written into the plan and state.

State-changing commands support exactly one of:

- `--plan`: local/read-only plan; the default;
- `--check`: read-only checks against providers and the cluster;
- `--apply`: perform the reviewed action.

The first implementation should not include `--force`, `--adopt`, automatic
cleanup, or automatic acceptance traffic.

### `deploy plan`

Resolve the complete deployment without changing local or remote state:

- validate DeploymentSpec and required environment references;
- resolve chart versions and immutable image digests into a lock;
- verify the contracts tag family has one source revision;
- compute the instance artifact prefix and expected resource names;
- show phases, writes, destructive actions, external services, paid actions,
  manual handoffs, and optional components;
- identify chart capabilities required by the selected service configuration;
- emit a plan digest used by subsequent commands.

The human view must make skipped services such as Blockscout explicit. JSON
output must be a single document and must never contain secret values.

### `deploy pre-bridge`

This command replaces the reusable portion of the environment's
`pre-bridge.mjs` runner. Its phases are:

```text
inventory -> archive -> domains -> cubesigner -> session -> l2-genesis -> handoff
```

It validates any previous cleanup receipt, archives only known generated
outputs, runs existing CLI setup commands, freezes genesis/contracts hashes,
and produces a Bridge handoff. It does not contact a funding service, broadcast
a Bridge transaction, push Kubernetes Secrets, or install a chart.

Creating a CubeSigner role/key is non-idempotent. The state record changes to
`running` before the request; an interrupted response requires reconciliation
against CubeSigner before the step can continue. Choosing another instance ID
must not bypass that reconciliation.

### `deploy bridge`

This command drives the existing `setup bridge-init` stages without replacing
their implementation:

```text
prepare -> setup -> bridge-info -> fund -> protocol-context
```

Each stage records input hashes and transaction/output identifiers. The driver
must use a persistent attempt fence and must not automatically retry an
ambiguous stage.

Funding is an adapter contract:

- `manual`: stop with the required address, amount, maturity, and continuation
  command; verify supplied outpoints before resuming;
- `shadowfork`: request bounded mining, split/fund as necessary, stop its miner
  on every exit path, and verify confirmations through the configured RPC;
- future adapters may be added without changing Bridge generation.

Provider credentials are environment references. They are neither stored in
the public receipt nor included in logs. The generic CLI has no dependency on a
dogeos-core source checkout; it calls the existing Bridge setup command/image.

### `deploy post-bridge`

This command consumes the frozen Bridge/protocol handoff. Proposed phases:

```text
configure -> secrets -> storage -> core -> contracts -> services
          -> partner-signers -> release-genesis-hold -> verify
```

`--through <phase>` provides a deliberate stopping point. Applying through
`partner-signers` requires an explicit signer-cutover option. A proof posture
change or paid Worker action is not an implicit post-Bridge phase.

The command should:

1. Re-run protected-resource inventory before any write and again after taking
   the deployment lock.
2. Call existing DA/proof/configuration commands and validate their receipts.
3. Generate selected production values and Secrets without overwriting
   operator-owned fields.
4. Render instance PVCs and chart manifests with instance/protocol annotations.
5. Run `helm template` and Kubernetes server-side dry run before `helm install`.
6. Install only when every rendered object name is unoccupied. An existing
   object is not adopted because its name looks correct.
7. Wait on service-specific success/readiness contracts. A failed one-shot
   contracts Pod is an ambiguous deployment, not permission to recreate it.
8. Save a fee-oracle transaction before broadcast and reconcile its receipt on
   resume.
9. Generate partner-signer bundles and validate them before any explicit remote
   switch.
10. Release genesis hold only after core services and signers are ready, first
    observing its durable state and finally proving the released state.
11. Write a readiness receipt that clearly says acceptance has not run.

Chart sources support both immutable OCI coordinates and reviewed local paths.
The path and content digest are written to the deployment lock so a resumed
installation cannot silently consume a changed local chart.

### `deploy status`

`deploy status` is read-only and always re-evaluates live state. It reports at
least:

- instance/protocol/config hashes and ownership drift;
- Helm release and Pod state;
- L2 chain ID, genesis agreement, gas limit, and empty-block progress;
- detailed L1 state including durable genesis-hold status;
- TSO-to-signer reachability and signer identity;
- DA submitter lifecycle and archive upload errors;
- proof topology posture, Worker registration, eager/fallback materializer
  selection, and accepted proof counters when exposed by service APIs;
- ingress TLS/health endpoints;
- warnings for optional unfunded or intentionally skipped services.

It does not make a workflow advance, release a hold, restart a service, replay a
proposal, or post an issue comment.

### `deploy cleanup`

Cleanup consumes the exact `ownership.json` written during installation. Plan
and check output must identify every Helm release, manifest object, release
Secret, and PVC by recorded UID and content/revision evidence.

Before the first deletion it validates every target. It then uninstalls owned
releases in reverse dependency order, waits for owned Pods to disappear, and
deletes only recorded, unmounted PVCs. It never deletes:

- an unrecorded or replaced Kubernetes object;
- a manually deployed instance without a receipt;
- shared Dogecoin, ingress-controller, monitoring, AWS, S3, KMS, Secret Manager,
  CubeSigner, partner-host, or local configuration resources.

There is no automatic cleanup at the beginning of `pre-bridge` or
`post-bridge`. Replacement remains a separate destructive command.

## Configuration and state model

The design separates desired configuration, resolved software, generated
runtime data, and mutable execution state.

```text
deployment-spec.yaml                         desired, reviewable configuration
artifacts/deployment/<instance>/lock.json    resolved charts/images/revisions
.data/                                       generated runtime inputs/secrets
artifacts/deployment/<instance>/state.json   phase checkpoints and hashes
artifacts/deployment/<instance>/ownership.json exact cleanup authority
artifacts/deployment/<instance>/ready.json   readiness, not acceptance
artifacts/acceptance/...                     environment-owned test receipts
logs/deployment/<instance>/                  private command transcripts
```

### DeploymentSpec additions

Extend the existing schema rather than introducing the Devnet JSON profile as
a second source of truth. Required additions are:

- `infrastructure.kubeContext` and explicit namespace;
- artifact prefix root and storage class/size policy;
- chart source/version catalog with local-path overrides;
- component image overrides, including independently versioned Reth,
  frontends, contracts, and core services;
- a contracts release revision whose three image roles are resolved together;
- external signer descriptors and an optional deployment transport reference;
- lifecycle configuration for genesis hold and signer cutover;
- supported service overrides such as ingress, 10M block gas, empty-block
  production, native DOGE predeploy, DA batching, and optional Blockscout;
- named confirmation overlay selection, with actual policy values supplied by
  the environment;
- Bridge funding-adapter settings containing only `$ENV:` secret references;
- acceptance profiles as opt-in references, not part of normal apply.

Mutable facts such as generated key IDs, protocol ID, transaction hashes,
resource UIDs, timestamps, or completed phases must never be written back into
DeploymentSpec.

### Version lock

`lock.json` is created from a reviewed plan and includes:

- exact chart name, source, version, and local content digest;
- exact image repository and immutable digest for every component;
- full contracts revision and the resolved genesis/deploy/verify references;
- CLI version/commit and relevant proof-material/publication receipt digests;
- Kubernetes target, namespace, plan digest, and DeploymentSpec digest.

A resume fails closed if the lock cannot reproduce the selected inputs. The
initial migration may import chart versions from a simple Makefile, but normal
apply must consume the lock rather than re-parsing arbitrary shell recipes.

### Step state and resume policy

Every step implements this contract:

```ts
interface DeploymentStep {
  id: string
  risk: 'read-only' | 'reconcilable-write' | 'non-idempotent' | 'destructive' | 'paid'
  inputDigest: string
  plan(context: DeploymentContext): Promise<StepPlan>
  check(context: DeploymentContext): Promise<StepCheck>
  apply(context: DeploymentContext): Promise<StepResult>
  reconcile(context: DeploymentContext, prior: StepState): Promise<ReconcileResult>
}
```

State is atomically written as `running` before a mutation and as `done` only
after outputs have been independently observed. Completed steps are skipped
only when their input and output hashes still match. Reconciliation rules are
step-specific:

- deterministic local generation may rerun transactionally;
- Kubernetes reconciliation may resume only when exact ownership matches;
- transaction broadcast first checks the saved signed transaction/hash;
- key creation and remote signer cutover require provider inventory;
- ambiguous contracts execution, Bridge creation, destructive cleanup, and
  paid capacity stop for operator review.

Changing an instance ID does not clear an in-progress global lock or authorize
another attempt against shared release names.

## Execution and security requirements

- Invoke processes with an executable plus an argument array; never compose a
  shell command from configuration values.
- Helm always receives `--kube-context <resolved-context>` and kubectl always
  receives `--context <resolved-context> --namespace <resolved-namespace>`.
- Run the first read-only inventory before writes outside Kubernetes too. A
  conflicting deployment must stop before creating a CubeSigner key, modifying
  IAM, pushing a shared Secret, or preparing a fee transaction.
- Use a repository/deployment-root lock whose metadata includes process, host,
  instance, phase, and plan digest. A stale lock is inspected, never silently
  replaced.
- Redact secrets from JSON, errors, plans, receipts, and default logs. Preserve
  private logs with mode `0600` and directories with mode `0700`.
- Verify file type, containment, size, and digest before accepting proof or
  Bridge inputs. Refuse symlinks at security boundaries.
- Resolve mutable image tags once. Deployment state uses digests.
- Separate `CONFIGURATION`, `PREREQUISITE`, `NETWORK`, `FUNDING`, `KUBERNETES`,
  `VALIDATION`, `AMBIGUOUS`, and `PAID_CAPACITY` errors. A recoverable error does
  not imply that an immediate retry is safe.
- With `--json`, stdout is exactly one response object; progress and child
  output go to stderr. The known `prep-charts` mixed-stdout behavior must be
  fixed before it is used inside the general engine.

## Production values and chart compatibility

The deployment exposed a recurring failure mode: a binary gains a required
argument, port, probe, volume, ServiceAccount, ingress, or configuration field,
but the deployment and chart example diverge.

The long-term contract is:

1. `scroll-sdk` production examples contain portable defaults and the complete
   service wiring expected by the matching image.
2. DeploymentSpec expresses environment choices and documented overrides.
3. `prep-charts` projects compiler-owned/generated fields.
4. `deploy plan` renders every selected chart and validates capability rules.
5. Environment repositories contain only true environment deltas.

The CLI should maintain a versioned capability matrix, for example:

```text
l1-interface: genesis-hold control, confirmation setting, SQLite persistence
l2-reth: 10M gas target, empty blocks, role-specific identity and PVC
withdrawal-processor: proof-work token, SQLite persistence, proof topology
proof-coordinator: active/idle probes, eager/fallback materializer contract
eager-materializer: artifact-store identity and ServiceAccount/IRSA
tso/cubesigner-signer: request-size limits, signer ports and caller routing
eth-da-submitter: KMS signer, archive store, lifecycle DB and batch policy
fee-oracle: address-only/KMS signer and L2 confirmations
```

Capability validation reports a chart/release mismatch; it does not inject
unreviewed emergency settings. Devnet tuning such as shortened confirmations
or a shorter DA batch interval is an overlay, not a new SDK default.

## Proof and paid-compute boundary

The current proof release commands already establish the correct ownership
split:

- dogeos-core produces native identities, commitments, verifier inputs, and the
  authoritative 11-file mapping;
- `scrollsdk` captures and validates the preparation receipt, validates the
  immutable Worker image, imports materials, compiles topology, and publishes a
  content-addressed program bundle;
- the deployment selects `disabled/mock/observe`, `active/mock/observe`,
  `active/real/observe`, and finally `active/real/enforce` as separate changes.

Deployment orchestration should call those commands and bind their receipts to
the version lock. It must not rebuild proof materials automatically when an
identity changes. Such a change requires a new material release, a new compiled
topology, a new publication receipt, and an explicit regeneration decision.

The CLI must also own the complete paid Worker lifecycle. This is an operational
`proof worker` command group, separate from instance installation and proof
posture changes:

```text
scrollsdk proof worker plan   # read-only controller/provider/offer plan
scrollsdk proof worker start  # explicit paid apply
scrollsdk proof worker status # read-only Worker, fleet, run and provider state
scrollsdk proof worker stop   # drain, scale down, terminate and verify
```

The first provider implementation targets the supported dstack/Vast path and
uses the matching dogeos-core capacity-manager and command-rendering contracts.
The CLI owns orchestration and receipts; it does not reimplement the native
Worker command or scheduler policy. Other providers implement the same capacity
interface.

`proof worker start --apply` must require:

- an immutable Worker image validation receipt;
- a matching published program bundle and protocol context;
- an explicit provider/account and maximum runtime;
- a maximum hourly price and total-cost ceiling;
- compatible CUDA architectures and an explicit maximum Worker count;
- a durable lease/fleet receipt and a reliable `status`/`stop` path.

The start flow performs read-only provider inventory before creating a dedicated
project/fleet/run, uses explicit names, configures capacity-manager shutdown to
scale Workers down, and records the dstack project, fleet, run, Worker IDs, and
provider instance IDs as different identities. It must not adopt or stop an
unrecorded historical fleet.

Maximum runtime cannot be only an in-process JavaScript timer: the operator may
close the terminal or the machine may fail. The provider task or a durable
controller-side lease reaper must enforce expiry independently. If the selected
provider cannot supply such a bound, `start` fails rather than claiming an
automatic limit. `stop` is idempotent and succeeds only after it has drained the
capacity manager, stopped the exact run, removed the exact dedicated fleet, and
verified through the provider API that every recorded billable instance is
terminal. Stopping the local dstack controller alone is never reported as
stopping billing.

Starting paid capacity is never a side effect of `deploy post-bridge`, switching
to real generation, or proof enforcement. Observation evidence remains in the
deployment repository.

## Acceptance command design

Readiness and acceptance remain distinct. After `ready.json`, reusable checks
may become these commands:

```text
scrollsdk test withdrawal --state <receipt> [--submit]
scrollsdk test deposit-load --inputs 3000 --state <receipt> [--broadcast]
scrollsdk test materialization --work-id <id> --offline
scrollsdk test proof-lane --expected-generation real --expected-enforcement observe
```

Every state-changing test separates construction from broadcast and stores a
transaction before sending it. Shadowfork mining is an optional adapter. The
materialization test verifies that the Batch child completes without node RPC
calls. The proof-lane test collects family/tag/AdvanceL2 chain evidence but does
not change proof posture.

Test output belongs under `artifacts/acceptance/` in the deployment repository.
Environment checklists, dates, transaction IDs, service logs, and issue replies
must not be copied into general CLI manuals.

## Implementation structure

Proposed source layout:

```text
src/commands/deploy/{plan,pre-bridge,bridge,post-bridge,status,cleanup}.ts
src/deploy/context.ts
src/deploy/engine.ts
src/deploy/lock.ts
src/deploy/state.ts
src/deploy/steps/*.ts
src/deploy/providers/{helm,kubernetes,aws,cubesigner,signer-transport}.ts
src/deploy/bridge/{driver,manual-funding,shadowfork-funding}.ts
src/deploy/ownership.ts
src/deploy/readiness.ts
src/types/deployment-state.ts
src/commands/proof/worker/{plan,start,status,stop}.ts
src/proof/capacity/{provider,lease,dstack-vast}.ts
```

Commands should call shared TypeScript APIs behind current `setup` commands,
not launch `scrollsdk` recursively. As those APIs are extracted, legacy setup
commands remain thin Oclif adapters. Provider interfaces receive resolved,
redacted configuration and the central argv-based process runner.

The environment's current scripts are migration fixtures, not code to copy as
one monolith. Their safety rules and tests should be ported before removing any
wrapper.

## Delivery plan

### Phase 0: automation foundation

- Fix strict JSON stdout for every setup command used by deployment.
- Replace shell-string execution on the deployment path with argv-based
  execution and bounded process-group cancellation.
- Add explicit kube-context/namespace fields to DeploymentSpec.
- Add version-lock resolution and the chart capability schema.
- Add golden tests that import the current Devnet profile without embedding its
  values as CLI defaults.

### Phase 1: read-only plan, inventory, and state engine

- Implement `deploy plan`, the plan/lock digest, common phase engine, atomic
  state writes, and global lock inspection.
- Implement read-only Kubernetes/AWS/CubeSigner prerequisites and rendered
  collision checks.
- Port ownership-receipt validation and `deploy cleanup --plan/--check` before
  enabling destructive apply.

### Phase 2: pre-Bridge and Bridge boundary

- Implement archive provenance, domains, CubeSigner create/reconcile, session,
  L2 genesis, and handoff phases.
- Wrap `setup bridge-init` with the persistent stage fence and manual funding.
- Add the Shadowfork adapter and port its bounded mining tests.
- Run a fresh Bridge integration test without any chart installation.

### Phase 3: post-Bridge installation

- Integrate existing DA/proof/config/secret commands as library calls.
- Implement PVC rendering, chart locking, post-render ownership annotations,
  server-side dry run, dependency ordering, and readiness checks.
- Implement durable fee funding and genesis-hold lifecycle controls.
- Enable ownership capture and receipt-scoped cleanup apply only after failure
  injection and replacement-resource tests pass.

### Phase 4: signer handoff and status

- Generate self-contained signer bundles and transport-neutral cutover plans.
- Add an optional SSH/Compose adapter with exact remote ownership checks.
- Implement caller-path health checks and the complete read-only status receipt.
- Validate a full fresh instance, process interruption at every phase, and safe
  resume using the same identity.

### Phase 5: acceptance and proof operations

- Port withdrawal, load-deposit, and offline materialization tools as generic
  test commands.
- Bind existing proof release receipts into deployment locks and status.
- Add explicit proof posture transitions.
- Implement the dstack/Vast `proof worker plan/start/status/stop` provider,
  durable runtime bound, cost ceilings, and terminal billing verification.

## Test strategy

- Unit-test parsing, redaction, plan hashing, state transitions, lock handling,
  tag-family consistency, confirmation overlays, and every reconcile rule.
- Use fake process/provider adapters to inject failure before request, after
  request, after remote success, and before local receipt write.
- Golden-test generated plans, locks, PVCs, Helm arguments, Kubernetes
  arguments, annotations, signer bundles, and readiness receipts.
- Render all selected charts offline and assert no duplicate objects, missing
  values files, unresolved variables, or absent required capabilities.
- Test cleanup against changed UIDs, changed Helm revisions/manifests, foreign
  PVC consumers, missing resources, and partially completed reverse-order
  teardown.
- Test that every Helm invocation contains the resolved `--kube-context` and
  every kubectl invocation contains the resolved `--context` and namespace.
- Test that a killed Bridge/key/funding/contracts/signer/paid step cannot be
  blindly rerun.
- Keep live Shadowfork, AWS, CubeSigner, EC2, and GPU tests opt-in and bounded;
  record their evidence in the deployment repository.

## Completion criteria

The orchestration is ready to replace the environment runners only when:

1. A new instance can be planned, prepared, Bridge-initialized, installed, and
   verified using the proposed command boundaries and one reviewed spec/lock.
2. Killing the command at every phase produces either a proven safe resume or
   an explicit ambiguous state with a reconciliation instruction.
3. A second instance ID cannot overwrite an occupied namespace or bypass a
   non-idempotent attempt fence.
4. Cleanup deletes only exact receipt-owned releases and PVCs and refuses a
   manual/unannotated deployment.
5. All Helm/kubectl calls carry the selected context, generated Secrets remain
   redacted, and no logs are written to `.data/`.
6. The selected charts pass the service capability matrix, including native
   Reth gas/empty-block settings, genesis hold, persistence, probes, ingress,
   monitoring, and ServiceAccount wiring.
7. Readiness, acceptance, proof observation, proof enforcement, partner cutover,
   and paid compute are reported as distinct states and actions.
8. The deployment repository can retire its generic pre/post orchestration
   code, retaining only environment configuration, provider adapters that are
   genuinely local, and acceptance evidence.
9. A paid Worker run cannot exceed its configured durable runtime/cost bounds,
   and `proof worker stop` proves that all receipt-owned provider instances are
   terminal rather than merely stopping the local controller.
