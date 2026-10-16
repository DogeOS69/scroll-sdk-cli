// dogeos_l1_rules::wf::SEQUENCER_DUST_AMOUNT_SATS. The builder and circuit
// require this exact genesis sequencing output value for the first transition.
export const GENESIS_SEQUENCER_AMOUNT_SATS = 42_069_000

export function assertGenesisSequencerAmount(value: unknown): void {
  if (value !== GENESIS_SEQUENCER_AMOUNT_SATS) {
    throw new Error(`sequencer_target_amount must be ${GENESIS_SEQUENCER_AMOUNT_SATS} sat (0.42069 DOGE); a different genesis output cannot prove its first WF transition. See dogeos-core#1323.`)
  }
}

/** Core's helper config uses rust-dogecoin's serialized Network enum. */
export function coreHelperNetwork(network: string): string {
  if (network === 'mainnet' || network === 'dogecoin') return 'dogecoin'
  if (network === 'testnet' || network === 'regtest' || network === 'signet') return network
  throw new Error('Unsupported Dogecoin helper network')
}
