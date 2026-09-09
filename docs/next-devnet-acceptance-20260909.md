# next_check_list acceptance: fresh devnet (2026-09-09)

This is the current `dogeos-devnet-cluster` run, not evidence copied from an
older Bridge. Continue [the fresh deployment runbook](devnet-fresh-redeployment.md).
Status: **in progress**, not yet end-to-end accepted.

## Frozen instance and posture

- Bridge: `2NG2hXDaLonSY7pVGojdXFv4v77bjQ6KUQG`.
- Protocol: `fe5d2bf4bdd76afd384aa665c1fde2323cfd3e1b96db936f3c385e71b1c51182`.
- L2 chain ID: 221122; genesis
  `0x7c0c97b0f50e788567d1d7bf7b4cc660445588c9d74f9eadf04c1d53fa6e2f64`.
- Proof posture: active / mock / observe; deadline 1800000ms. This run does not
  claim real-proof generation, enforce-mode or production CubeSigner acceptance.
- PC, WP, DA and external attestation signers use beta.4e (eef62d3e).
  Compiler bundle revision:
  `2316b18d5f90f0fd5d6d367a135e4e9e3df2d79b8e4c392793d36d55f4475475`.
- Fresh WP/PC/eager volumes; no mock Worker deployment. Shared artifact prefix
  `devnet-20260908/instance-20260909/fresh-0731` in
  `dogeos-dev0829-proof-artifacts`. Service Secret prefix is now `dogeos`.

## Verified deposit path

AdvanceL1 job `b28da6dd-8b55-4a75-a816-38a316c320ae` completed internal mock
Bridge materialize/prove/verify, all attestation signatures and the new
CubeSigner key's signatures. Actual Dogecoin transaction:
`45028b9d402671acd2bbc9e50c3b5fbadfa823e902e86dfa133019960e1bca31`.
After confirmations, L1 replay canonicalized all ten deposit messages.

All ten were included in L2 block **271**, queue indexes 0–9, skipped=false;
all ten receipts status=1. Moat events each report 5 DOGE deposited and a
1 DOGE deposit fee, giving a total **40 DOGE net credit** to the deployer
`0xdED06046416d6bA20c1e2baD51B3A3e2f267d33F`. This is not two failed deposits.

Two deployment repairs were necessary: finalized:0 inclusion for the synthetic
WF-backed L1, and restoration of the correct Reth Secret paths after the old
prep helper retargeted them. See the fresh runbook; do not reset L2 databases.

## Verified proof pipeline progress

- Coordinator starts with current native compiler config and 30-minute deadline.
- WP proof rows include successful Bridge, Scroll Chunk, Scroll Batch and chunk
  segmentation work, with no prover-worker Pod.
- Coordinator logs `eager_locate_hit` at 08:01:35 and 08:05:28 UTC, explicitly
  saying a valid locator served the chunk claim and no subprocess ran.
- Those two chunk materialize work rows completed in 0.781s and 0.907s measured
  from row creation to last update. Batch materialize rows succeeded in 39.89s
  and 37.52s. These are persisted-work timings, not CPU-only measurements.
- Eager readiness=1 and chunks_produced_total=4 at the 08:08 UTC check, proving
  actual S3 publication rather than only a configured IAM role.
- Batch source uses --block-witness-dir and never --l2-rpc-url; current-instance
  runtime child argv observation is pending. Do not claim packet-level tracing.

## One withdrawal submitted: do not submit a duplicate

No existing CLI command implements this Dogecoin Moat withdrawal (legacy test
e2e targets the old ETH gateway). Used the CLI's installed ethers library,
reading the deployer key from config.toml without displaying it, against the
explicit private Reth port-forward. Checked chain ID, current contract address,
withdrawalFee/minWithdrawalAmount and staticCall before sending exactly once.

- Moat: `0xd94756149F112BCE0d420Ef02159a9B69Ed5a1E4`.
- Call: `withdrawToDogeAddress("nVWt5A5m3kWCri6TZoy4eXnupZcunaUZUV")`.
- Recipient is this instance's generated fee/test wallet, not an invented key.
- Value: 1.1 DOGE, consisting of minimum 1 DOGE withdrawal + 0.1 DOGE fee;
  transaction gas is additional. Sender nonce 80.
- L2 transaction:
  `0x357da190b61fc4d3cf3130f9cb0e4ae0d9d05c9fef0a4db7d243ff6ba044db83`.
- Receipt: status=1, block 447, gasUsed=669229. Moat/messenger withdrawal events
  were emitted. This receipt alone does not prove Dogecoin fulfillment.

Wait for ordinary DA batching (local MAX_OPEN_L2_TIME remains 300 seconds),
then track the corresponding proof/WF transition and exact Dogecoin output.
Mine bounded confirmation blocks on the approved Shadowfork only when needed;
do not change batching to accelerate acceptance or replay Bridge initialization.

## Remaining checks

1. Observe current Batch child using stored witnesses without an RPC endpoint.
2. Verify this withdrawal reaches successful proof, signature and broadcast.
3. Verify its exact 1-DOGE recipient output in the confirmed Dogecoin transaction
   and the canonical replay/withdrawal frontier. Check the matching L2 batch too.
4. Record final readiness/errors, finality and acceptance evidence here. Only
   then consolidate the post-wrapper workflow into the requested deployment script.
