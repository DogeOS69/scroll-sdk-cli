import type {ProofTopologySpec} from '../types/proof-topology.js'

export interface ProofPosture {
  enforcement: ProofTopologySpec['enforcement']
  generation: ProofTopologySpec['generation']
  mode: ProofTopologySpec['mode']
}

/** The only proof posture a Dogecoin mainnet deployment can run. */
export const MAINNET_PROOF_POSTURE: Readonly<ProofPosture> = Object.freeze({enforcement: 'enforce', generation: 'real', mode: 'active'})

export function isDogecoinMainnet(network: unknown): boolean {
  return network === 'mainnet' || network === 'dogecoin'
}

/**
 * dogeos-core refuses observe enforcement (it accepts mock proofs) and mock
 * generation on mainnet, in any mode: the Withdrawal Processor at startup and
 * the topology compiler when it renders. The CLI accepts enforcement only with
 * active real proving, so mainnet has exactly one valid posture.
 */
export function mainnetProofPostureProblem(network: unknown, posture: ProofPosture): string | undefined {
  if (!isDogecoinMainnet(network)) return undefined
  const {enforcement, generation, mode} = posture
  if (mode === MAINNET_PROOF_POSTURE.mode && generation === MAINNET_PROOF_POSTURE.generation && enforcement === MAINNET_PROOF_POSTURE.enforcement) return undefined
  return `Dogecoin mainnet requires proof mode=active, generation=real and enforcement=enforce (configured ${mode}/${generation}/${enforcement}). `
    + 'dogeos-core refuses observe enforcement and mock generation on mainnet, and enforcement requires active real proving.'
}

export function assertMainnetProofPosture(network: unknown, posture: ProofPosture, source?: string): void {
  const problem = mainnetProofPostureProblem(network, posture)
  if (problem) throw new Error(source ? `${source}: ${problem}` : problem)
}
