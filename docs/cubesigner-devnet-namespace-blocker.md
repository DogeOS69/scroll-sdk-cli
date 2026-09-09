# Devnet acceptance blocked by CubeSigner role policy namespace

**Historical failure / superseded repair plan:** the operator forbids changing
existing role/key policies and has selected a new independent role/key plus a
fresh Bridge and L2. Follow [the current plan](devnet-fresh-redeployment.md),
not the owner-policy replacement procedure below. Core explicitly supports a
plain/no-WASM-policy `transport_only` testnet lane; a new matching WASM policy
is not the only development deployment option. A denial of policy-log access
alone also does not establish whether the caller can update a role attachment.

Checkpoint: 2026-09-09, failure at 06:29:46 UTC. This is a real signing attempt
on `dogeos-devnet-cluster`, not a hypothetical production-evidence prerequisite.

## What worked

- Existing Bridge and genesis preserved; active/mock/observe, no Worker.
- Eager became Ready and produced 50 chunks; PC served Chunk claims through
  `eager_locate_hit` without running its Chunk subprocess.
- WP proof execution rows: 48 Scroll Chunk, 48 Scroll Batch and 1 Bridge each
  succeeded in materialize, prove and verify (06:33 UTC checkpoint). Segmentation
  materialize also succeeded for 48 items. These are **mock proofs**, with real
  witness materialization, not real cryptographic-proof acceptance.
- The running Batch child was observed with `--block-witness-dir`, without
  `--l2-rpc-url`, reading staged persisted witnesses. Source
  `proof_coordinator/src/backends/scroll_batch_subprocess.rs` enforces that route.
  Successful-child stdout/stderr are drained without retained timing telemetry;
  this is argv/source evidence, not an independent network packet count.
- Enabling the old WP base's `advance_l1_builder_v2` selected all 10 existing
  5-DOGE deposits. Its Bridge proof completed, and all three EC2 attestation
  signers supplied signatures (10 inputs each). No extra deposit funding occurred.

## Exact failure

WP job: `d541279c-a200-43dd-b2c3-e529cee537ad` (`advance_l1_build`).
Unsigned transaction:
`042e360de50731582a17e88458ffb0c8cc22f38dd6d8d91753df75a2dbfd8f14`.
This is **not a broadcast transaction ID**.

The CubeSigner service accepted the request, projected inputs 1–10 and called
remote `signPsbt`. It then logged:

```text
policy_failure_code=wrong_namespace
classification=permanent reason=policy_denied status=412 code=WasmPolicyDenied
errorId=CUBESIGNER_POLICY_DENIED
```

It delivered rejection to TSO; TSO reported that its Tee role threshold was
unreachable, and WP marked this job `failed_terminal`. Restarting pods, refreshing
sessions or repeatedly submitting the same request cannot repair a namespace
mismatch. Do not manually change SQLite states to force a retry.

## Read-only ownership and attachment checks

```bash
cs key get --key-id 'Key#DogeTest_ni357fyaLZVa2gViVwvVYGemjScg8DBkxz' \
  --role-id 'Role#62fb165a-849d-4c3a-8724-ffa747d07055'
cs role get --role-id 'Role#62fb165a-849d-4c3a-8724-ffa747d07055'
cs policy get --name dogeos_verifier_policy --version v1
```

Observed: key enabled and direct `policy=[]`; role **Devnet** enabled and attached
to `NamedPolicy#7273313d-e19b-449a-ac40-a6d61efc198f/v1`, named
`dogeos_verifier_policy`. Its v1 rule hash is
`0xc42d328455e2dade45ff81f76b8fe5c593bc31319b893bdcb32f6835a1c7655c`.
The unscoped key read returned `403 UserNotKeyOwner`; the role-scoped read above
succeeded. `cs policy logs` for this version/window returned
`403 UserNotPolicyOwner`. No remote policy write was attempted.

Current Bridge namespace, decoded from the canonical redeem script's first
20-byte push:

```text
bb765b27ea07a9b77accf3b46fa13dace683e644
```

The inspected core source's `cubesigner_verifier_policy/src/pins.rs` instead
bakes `024e43165e010d63cd8c833767cee78a042a8da3`. That explains a plausible old
policy origin, but the deployed v1 WASM was **not downloaded/decoded** here;
its exact baked namespace is not independently established. The remote
`wrong_namespace` result itself establishes incompatibility with this request.

## Required owner/core handoff

Preserve the existing correctness key, Bridge, protocol context and role. Ask the
policy owner to prepare/attach an explicit immutable devnet policy version for
the current namespace, with the intended Dogecoin-testnet proof-fallback behavior.
Do not replace a shared organization's default policy or attach `latest`. Review
other users of the role before changing its attachment.

Core already documents testnet proof fallback in
`docs/engineering/cubesigner-testnet-fallback-monitoring.md`: proof-side failures
can fall back after structural authorization, but namespace/P2SH/redeem/sighash
failures remain hard Deny. `transport_only` is local service posture, **not** a
remote-policy bypass. Removing the policy or suppressing namespace validation is
not the prescribed repair.

Core follow-up (recorded only; source was not modified): support a reproducible
per-instance namespace pin/build/receipt for the CubeSigner verifier policy, or
provide an owner-built policy artifact matching this existing devnet. Policy
publication/role attachment requires explicit owner coordination. Changing Bridge
identity to fit a policy would violate this upgrade's preservation requirement.

After owner-approved repair:

1. Record immutable policy version/hash, role attachment and rollback reference.
2. Validate matching-namespace allow behavior and mismatching-namespace rejection.
3. Reconcile the terminal WP/TSO attempt through a supported operator procedure;
   first verify no signed/broadcast transaction exists. No generic safe retry
   command has been established in this run; do not invent a DB reset.
4. Complete AdvanceL1, mine confirmations only on the approved Shadowfork as
   needed, verify the existing deposits credit L2, then submit one minimum-sized
   withdrawal and track its post-Tsuki proof/sign/broadcast/confirmation path.
5. Finish remaining checklist telemetry/fallback checks and runtime handoff.

At the final read-only check: WF replay validated/discovered are both zero,
consumed outpoints zero, genesis sequencer output still unspent including mempool,
and no signed txid exists. No withdrawal has been submitted (the deployer has
about 0.5996 L2 DOGE; Moat requires 1 DOGE plus 0.1 DOGE fee). Current pods are
Ready, but the devnet is **not yet end-to-end accepted**.
