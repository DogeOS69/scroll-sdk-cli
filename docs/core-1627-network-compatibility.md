# Core #1627 Dogecoin network compatibility

## Problem

Adapt scroll-sdk-cli to the canonical Dogecoin network names introduced by https://github.com/DogeOS69/dogeos-core/pull/1627 before releasing/deploying that Core version for mainnet.

Core PR head reviewed: `fa6fab44be24f3d5255fcc83ffe2eb6b4ebea34f`.
CLI `v0.3.0` head checked: `2614f943440efd546e6b32b06ad11324a7605996`.
Review finding: https://github.com/DogeOS69/dogeos-core/pull/1627#discussion_r4314412814

Core now emits `mainnet` for Dogecoin mainnet, alongside `testnet` and `regtest`. It accepts `dogecoin` as an input alias, and rejects `bitcoin`. In particular:

- `GET /protocol-actions/rotate-key/status` changes its mainnet `network` field from `dogecoin` to `mainnet`.
- WP `tso_signers[].network` accepts `mainnet` directly; CLI no longer needs to translate mainnet to the fork's serde spelling.
- Signer health/policy output and related operator-facing Core output use canonical `mainnet`.

## Reproduced impact

`assertDeploymentIdentity()` in `src/utils/rotation-export.ts` compares `status.network` to `tsoSignerNetwork(rotation.network)`. The helper still translates `mainnet` to `dogecoin`.

Using the checked-in `test/fixtures/rotation-export/mainnet-example.json` and identical protocol instance IDs:

```js
const rotation = readRotationExport('test/fixtures/rotation-export/mainnet-example.json');
assertDeploymentIdentity(rotation, {
  protocol_instance_id: rotation.protocol_instance_id,
  network: 'mainnet',
});
```

Actual result:

```text
The WP network mainnet differs from the export network mainnet
```

Changing only the status network back to `dogecoin` passes. This prevents `registerRotation`, `rotation online`, and `sendRotation` (including preview) from proceeding against the new mainnet WP, even when both sides refer to the same deployment.

## Required adaptation

1. Update `assertDeploymentIdentity()` to recognize the new canonical WP status network. Preserve rejection of actual network mismatches and protocol-instance mismatches.
2. Remove the obsolete mainnet-to-dogecoin conversion from generated TSO signer entries. Audit callers of `tsoSignerNetwork()` in:
   - `src/utils/rotation-operations.ts` (`mergeRotationSigners`);
   - `src/commands/setup/prep-charts.ts` (generated and retained signer entries);
   - `src/utils/values-generator.ts` (production signer entries);
   - `src/utils/rotation-export.ts` (deployment identity validation).
   Delete the helper if no longer needed, or replace it with clearly scoped normalization. New output should use `mainnet`, `testnet`, or `regtest`.
3. Update tests, fixtures, and comments that encode the old contract. In particular, `test/utils/bridge-rotation-commands.test.ts` currently expects a mainnet WP status to fail, and `test/commands/setup/prep-charts.test.ts` asserts that mainnet becomes dogecoin.
4. Check other CLI comparisons against signer health/policy and Core-generated network fields for legacy `bitcoin`/`dogecoin` output assumptions. Do not introduce an unknown-network fallback or change Dogecoin Core RPC chain identifiers (`main`, `test`, `regtest`).

`dogecoin` remains a valid input alias in new Core; therefore existing signer entries using it are not themselves the rotation blocker. The blocking incompatibility is the status-response comparison. Canonicalizing generated entries removes the obsolete workaround.

## Acceptance criteria

- [ ] A valid mainnet rotation export passes identity validation against a new WP status containing `network: "mainnet"`.
- [ ] Testnet/regtest mismatches and a different protocol instance are still rejected; `bitcoin` is not treated as an accepted Dogecoin network name.
- [ ] Register, online, and send/preview are covered with mocked new-format WP responses, without broadcasting transactions or modifying a live deployment.
- [ ] Generated and retained TSO signer entries use canonical network names; existing `dogecoin` inputs are normalized deliberately where supported.
- [ ] Relevant rotation and chart-generation tests pass, including negative cases.
- [ ] Link the implementation PR here and coordinate its release with Core PR #1627. If supporting older Core releases is required, document and test that compatibility explicitly; do not require a Core compatibility shim merely to preserve the old CLI conversion.
