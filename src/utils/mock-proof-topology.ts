import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ProofFamily } from './proof-configurator.js'

/**
 * Canonical mock proof-topology identity constants.
 *
 * These mirror the dogeos-core e2e harness mock topology
 * (`crates/e2e_harness/src/topology/proof.rs`), which is the reference
 * implementation the `prover-worker-mock` image and the dev_dummy verifiers
 * are exercised against in CI. Keeping the same constants means a mock
 * deployment staged by scrollsdk is bit-for-bit the identity set dogeos-core
 * already proves out end to end.
 */
export interface MockProofIdentity {
  circuitId: string
  manifestBasename: string
  programCommitmentHash: string
  verifierId: string
  vkHash: string
}

export const MOCK_PROOF_SYSTEM_ID = 'openvm'
export const MOCK_PROOF_CIRCUIT_VERSION = '1.0.0'
export const MOCK_SCROLL_BATCH_BACKEND_PROFILE = 'scroll-batch-topology-prover-v1'
export const MOCK_BRIDGE_BACKEND_PROFILE = 'bridge-topology-prover-v1'
/** Deployment-artifact home for the synthesized mock program manifests. */
export const MOCK_PROGRAM_MANIFESTS_DIR = 'proof-artifacts/mock-manifests'

export const MOCK_PROOF_IDENTITIES: Record<ProofFamily, MockProofIdentity> = {
  advance_l2_aggregation: {
    circuitId: 'advance-l2-aggregation-v1',
    manifestBasename: 'advance-l2-aggregation-topology-program.json',
    programCommitmentHash: `0x${'99'.repeat(32)}`,
    verifierId: 'openvm-advance-l2-aggregation-verifier-v1',
    vkHash: `0x${'aa'.repeat(32)}`,
  },
  bridge_transition: {
    circuitId: 'bridge-transition-v1',
    manifestBasename: 'bridge-topology-program.json',
    programCommitmentHash: `0x${'77'.repeat(32)}`,
    verifierId: 'openvm-bridge-topology-verifier-v1',
    vkHash: `0x${'88'.repeat(32)}`,
  },
  scroll_batch: {
    circuitId: 'scroll-batch-v1',
    manifestBasename: 'scroll-batch-topology-program.json',
    programCommitmentHash: `0x${'66'.repeat(32)}`,
    verifierId: 'openvm-scroll-batch-topology-verifier-v1',
    vkHash: `0x${'55'.repeat(32)}`,
  },
  scroll_chunk: {
    circuitId: 'scroll-chunk-v1',
    manifestBasename: 'scroll-chunk-topology-program.json',
    programCommitmentHash: `0x${'ee'.repeat(32)}`,
    verifierId: 'openvm-scroll-chunk-topology-verifier-v1',
    vkHash: `0x${'44'.repeat(32)}`,
  },
}

export function mockVerifierIds(): Record<ProofFamily, string> {
  return {
    advance_l2_aggregation: MOCK_PROOF_IDENTITIES.advance_l2_aggregation.verifierId,
    bridge_transition: MOCK_PROOF_IDENTITIES.bridge_transition.verifierId,
    scroll_batch: MOCK_PROOF_IDENTITIES.scroll_batch.verifierId,
    scroll_chunk: MOCK_PROOF_IDENTITIES.scroll_chunk.verifierId,
  }
}

function mockProgramManifest(family: ProofFamily): Record<string, unknown> {
  const identity = MOCK_PROOF_IDENTITIES[family]
  return {
    // Placeholder toolchain/artifact records in the e2e harness shape: the
    // dev_dummy lane never fetches program artifacts, but the manifest must
    // be a structurally complete ProofProgramManifestV1.
    artifacts: [
      { kind: 'app_vmexe', sha256: `0x${'11'.repeat(32)}`, size_bytes: 1024 },
      { kind: 'openvm_config', sha256: `0x${'22'.repeat(32)}`, size_bytes: 512 },
    ],
    circuit_id: identity.circuitId,
    circuit_version: MOCK_PROOF_CIRCUIT_VERSION,
    hard_fork_name: null,
    program_commitment_hash: identity.programCommitmentHash,
    proof_family: family,
    proof_system_id: MOCK_PROOF_SYSTEM_ID,
    schema_version: 1,
    toolchain: { openvm_version: 'v1.4.0', rust_toolchain: 'nightly-2025-08-18' },
    verification_key_hash: identity.vkHash,
  }
}

/**
 * Write the four synthesized mock ProofProgramManifestV1 files and return
 * their paths in the same order as the production release manifests.
 */
export function ensureMockProgramManifests(dir = MOCK_PROGRAM_MANIFESTS_DIR): string[] {
  const resolved = path.resolve(dir)
  fs.mkdirSync(resolved, { recursive: true })
  const families: ProofFamily[] = [
    'scroll_chunk',
    'scroll_batch',
    'advance_l2_aggregation',
    'bridge_transition',
  ]
  return families.map(family => {
    const manifestPath = path.join(resolved, MOCK_PROOF_IDENTITIES[family].manifestBasename)
    fs.writeFileSync(manifestPath, `${JSON.stringify(mockProgramManifest(family), null, 2)}\n`)
    return manifestPath
  })
}
