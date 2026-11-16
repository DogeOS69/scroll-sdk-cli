// dogeos_l1_rules::wf::SEQUENCER_DUST_AMOUNT_SATS. The builder and circuit
// require this exact genesis sequencing output value for the first transition.
export const GENESIS_SEQUENCER_AMOUNT_SATS = 42_069_000

export function assertGenesisSequencerAmount(value: unknown): void {
  if (value !== GENESIS_SEQUENCER_AMOUNT_SATS) {
    throw new Error(`sequencer_target_amount must be ${GENESIS_SEQUENCER_AMOUNT_SATS} sat (0.42069 DOGE); a different genesis output cannot prove its first WF transition. See dogeos-core#1323.`)
  }
}

// Core bridge_script_utils::{MIN,MAX}_RECOVERY_DELAY_BLOCKS.
export const MIN_RECOVERY_DELAY_BLOCKS = 259_200
export const MAX_RECOVERY_DELAY_BLOCKS = 525_600

/**
 * Core admits a genesis recovery timelock only from the genesis anchor height
 * plus the minimum delay to the anchor plus the maximum delay, inclusive.
 */
export function recoveryTimelockBounds(anchorHeight: number): {maximum: number; minimum: number} {
  return {maximum: anchorHeight + MAX_RECOVERY_DELAY_BLOCKS, minimum: anchorHeight + MIN_RECOVERY_DELAY_BLOCKS}
}

/**
 * The opening WF spends marked Bridge funding as its custody. Core's helper only
 * sends that funding when bridge_funding_target_amount is set; its default
 * deposit-shaped seed outputs cannot back the opening WF.
 */
export function assertOpeningBridgeFunding(setupDefaults: {bridge_funding_target_amount?: unknown}): void {
  const amount = setupDefaults.bridge_funding_target_amount
  if (!Number.isSafeInteger(amount) || Number(amount) <= 0) {
    throw new Error('setup_defaults.toml must set bridge_funding_target_amount (satoshis, with bridge_funding_tx_count = 1 and enable_deposit_seed_txs = false): the opening WF spends a marked Bridge funding output as its custody, and the Withdrawal Processor refuses to start without one. No setup transaction was sent.')
  }
}

/** Core's helper config uses rust-dogecoin's serialized Network enum. */
export function coreHelperNetwork(network: string): string {
  if (network === 'mainnet' || network === 'dogecoin') return 'dogecoin'
  if (network === 'testnet' || network === 'regtest' || network === 'signet') return network
  throw new Error('Unsupported Dogecoin helper network')
}
