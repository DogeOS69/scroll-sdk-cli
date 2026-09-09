# Sepolia DA submitter rollout and RPC recovery (2026-09-09)

This records a verified devnet recovery, not a general instruction to reset a
submitter database. The instance remains the new Bridge described in
[the instance runbook](devnet-new-bridge-20260909.md). Genesis and protocol identity
were not changed.

## Observed failure

The beta.3e submitter started with the configured AWS KMS address
`0x809cb1378Cb2775816dD14d1a3754a536b066889`. The Tenderly public Sepolia endpoint
returned HTTP 429 during recovery diagnostics. Initial broadcasts had ambiguous
outcomes, subsequent nonces accumulated, and a later submission failed with
`nonce_too_high`. Runtime reported `fresh submit fail-closed: kind=nonce_too_high`
and became unready. This was not an observed KMS authentication failure.

The evidence establishes RPC rate limiting and a nonce backlog; it does not
establish that every earlier ambiguous broadcast had the same HTTP error or that
the core retry implementation is permanently fixed by changing providers.

## Configuration and installation

Working directory: the deployment project, not the CLI source directory.
After contracts and Reth validation, the initial DA rollout used
`make install-eth-da-submitter` (chart 0.1.3). It created the 10Gi
`eth-da-submitter-data` claim. Do not substitute a historical instance's DB.

The following manual recovery changes are now recorded in production values:

- Set private `.data/doge-config.toml` field `ethereumDa.submitterRpcUrl` to
  `https://ethereum-sepolia-rpc.publicnode.com`. Do not commit private config.
- Set `configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_PUBLISH__MAX_PENDING_BLOB_TXS`
  to string `"1"` in `values/eth-da-submitter-production.yaml`. This serializes
  pending blob transactions for this devnet; it is not a universal throughput
  recommendation or a guarantee against rate limiting.
- Run the existing `setup prep-charts` workflow and verify the generated
  `DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__RPC_URL`. Follow the instance runbook's
  selective, prefix-aware Secret reconciliation after generation, including
  the four indexed Reth node identities. Re-export the signer policy bundle and
  run `setup proof-config-check`. Do not edit files concurrently with prep-charts.
- Render and validate the intended Helm update, then run
  `make install-eth-da-submitter`. Makefile Helm calls explicitly select the
  devnet context below. Recovery completed with Helm revision 2.

Changing the canonical RPC also regenerates other consumers' values. A generated
file is not proof that those other running releases have been updated.

## Incident-only signed transaction recovery

The operator retained the SQLite PVC and mounted it read-only in temporary
same-node diagnostic Pods. Persisted signed bytes were read from
`submitter_tx_attempts`; only already-signed transactions for nonces 4318–4321
were rebroadcast, checking that each returned hash matched the persisted hash.
All four eventually received successful receipts. No DB fields were edited,
no private key was exported, and the diagnostic code did not sign replacements.
The daemon itself subsequently resumed at nonce 4322.

Do not replay these incident nonces on another instance, delete the PVC to clear
the error, manually advance the nonce, or assume a timed-out send was rejected.
First compare confirmed/pending chain nonces, stored signed attempts and receipts.
Manual rebroadcast is an incident action requiring validated transaction identity,
not a normal deployment prerequisite. Private diagnostic logs were archived and
the temporary Pods removed; their removal did not delete the DA claim.

The old unready StatefulSet Pod did not roll to the desired revision automatically.
After verifying the desired revision and retained claim, the operator deleted only
`eth-da-submitter-0`; its controller recreated it with the new configuration.
No force deletion or volume deletion was used. Do not repeat this routinely.

## Acceptance evidence and repeatable read-only checks

At 03:52 UTC, the new Pod was 1/1 Ready, with zero restarts. Four automatically
submitted transactions after restart independently returned receipt status `0x1`:

| Nonce | Transaction hash |
| --- | --- |
| 4322 | `0x0fa58dcf45c2da3ea4e5ba528b2b21002e846a866718ea4c5c7adf5b6a8b3d31` |
| 4323 | `0x5f3508d7c320f7368597da984c95c1d5b24fdbf45895efa13035cca434867cb0` |
| 4324 | `0xb160e516e1f7b14c50010cdccad04c3513f583004cdea4d810805f48283e0375` |
| 4325 | `0xe617b69737623e5d3ec02abce0e25fc1ab1f629ddc19ea372915711c781683b6` |

All receipts have the expected KMS sender. `/status` reported `ready=true`, null
`fatal_lifecycle_error` and `last_submit_error`, eight settled transactions,
14 lifecycle-finalized batches and 13 uploaded blobs, with no failed/conflicting
uploads. These counts are a point-in-time sample. The service's configured
confirmation/finalization depths are both one; its `finalized` label must not be
confused with Ethereum consensus finality.

```bash
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster \
  -n default get pod eth-da-submitter-0
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster \
  -n default exec l2-reth-rpc-0 -- \
  curl -fsS --max-time 10 http://eth-da-submitter:3004/status
```

Verify that new hashes receive successful Sepolia receipts and upload counters
advance, not merely that the Pod is Running. `pending_tx_cap` while a transaction
is pending, or `waiting_for_target_blobs` before the configured batching timeout,
is a normal policy decision, not by itself a failure.

This verifies DA recovery only. It does not complete WP, proof/signers, external
access or end-to-end bridge acceptance.

## Subsequent operator tuning: batch open time

After observing approximately one small blob every 63 seconds, the operator
requested `DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_OPEN_L2_TIME = "3000s"` in the SDK
example and `"300s"` in this devnet's production values. SDK commit `9f6c49e`
contains the example-only change. Apply the local value with
`make install-eth-da-submitter`; revision 3 completed successfully and the live
ConfigMap contains `300s`. The daemon remains Ready without submit/upload errors.

The previous 60-second open time, one chunk per batch and 60-second publish wait
predated RPC recovery. Recovery changed pending concurrency from four to one,
not these timeouts. With empty blocks enabled, logs showed batches of 21 blocks,
about 115 compressed bytes per 131072-byte raw blob, sealed by
`max_chunks_per_batch` and submitted by `soft_batching_timeout`.

Only MAX_OPEN_L2_TIME was changed in this tuning step. The optional
CHUNK_MAX_OPEN_L2_TIME stays absent and inherits it; MAX_CHUNKS_PER_BATCH=1,
MAX_BLOCKS_PER_CHUNK=128 and MAX_BATCH_WAIT=60s remain unchanged. Time is an upper
bound, not a fixed publication interval: block count, gas and byte limits may
seal earlier (particularly with the example's 3000-second value). Extending
only publish wait would combine blobs into fewer transactions, not combine
already sealed batches into fewer blobs. Current prep-charts has no mapping
that overrides this existing production timeout; verify it after generation
or when replacing local values from examples.
