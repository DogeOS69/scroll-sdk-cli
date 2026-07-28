export type ProvingMode = 'mock' | 'production'

/**
 * Deployment-wide proof posture.
 *
 * `disabled` keeps the attestation phase but sends no proof artifacts and
 * configures partner signers for the existing dev-permissive/direct-sign
 * posture. `mock` enables the complete proof lifecycle with deterministic
 * non-cryptographic proofs. `production` is the real release-artifact lane.
 */
export type ProofSystemMode = 'disabled' | ProvingMode

export const PROOF_SYSTEM_MODES: readonly ProofSystemMode[] = [
  'disabled',
  'mock',
  'production',
]

export function normalizeProofSystemMode(value: unknown): ProofSystemMode | undefined {
  return typeof value === 'string' && PROOF_SYSTEM_MODES.includes(value as ProofSystemMode)
    ? value as ProofSystemMode
    : undefined
}

export function provingModeFor(mode: Exclude<ProofSystemMode, 'disabled'>): ProvingMode {
  return mode
}
