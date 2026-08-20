import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ProofFamily } from './proof-configurator.js'

/**
 * Canonical mock proof-topology identity constants.
 *
 * Most identities mirror the dogeos-core e2e harness mock topology
 * (`crates/e2e_harness/src/topology/proof.rs`). L2 range aggregation is more
 * constrained: its raw app commitment must also match the bridge circuit's
 * canonical inner-program authority, even when the proof bytes are mocked.
 * Keeping both contracts here lets scrollsdk stage a mock deployment that can
 * complete the full aggregation-to-bridge lifecycle.
 */
export interface MockProofIdentity {
  circuitId: string
  circuitVersion: string
  manifestBasename: string
  programCommitmentHash: string
  verifierId: string
  vkHash: string
}

export const MOCK_PROOF_SYSTEM_ID = 'openvm'
export const MOCK_PROOF_CIRCUIT_VERSION = '1.0.0'
export const MOCK_SCROLL_BATCH_BACKEND_PROFILE = 'scroll-batch-topology-prover-v1'
export const MOCK_BRIDGE_BACKEND_PROFILE = 'bridge-topology-prover-v1'
/**
 * Canonical verifier IDs stamped into chunk/batch public-output sidecars by
 * dogeos-core's external prover-worker when it runs in dev mock mode.
 *
 * These must stay in lockstep with
 * `dogeos_control_plane_types::{DEV_MOCK_CHUNK_VERIFIER_ID,
 * DEV_MOCK_BATCH_VERIFIER_ID}`. Using the e2e-harness topology IDs here makes
 * WP issue receipts under a different verifier authority from the sidecars
 * and causes tag-5 range materialization to fail closed.
 */
export const DEV_MOCK_CHUNK_VERIFIER_ID = 'dogeos-prover-worker-dev-mock-chunk-v1'
export const DEV_MOCK_BATCH_VERIFIER_ID = 'dogeos-prover-worker-dev-mock-batch-v1'
/** Deployment-artifact home for the synthesized mock program manifests. */
export const MOCK_PROGRAM_MANIFESTS_DIR = 'proof-artifacts/mock-manifests'
/**
 * Canonical AdvanceL2 aggregation app commitment consumed by prover-worker.
 *
 * The bridge circuit pins this exact exe/vm commitment pair when validating
 * the aggregation output sidecar. Mock proving skips cryptographic execution,
 * but it does not skip that protocol-authority check, so an arbitrary mock
 * value (for example `0xbb..bb`) would pass the standalone verifier policy and
 * then fail bridge materialization. WP, proof-coordinator, the worker bundle,
 * and the synthesized manifest all receive identity derived from this value.
 *
 * Source of truth in dogeos-core:
 * crates/circuits/bridge_state/types/config/batch_aggregation_guest_app_commit.json
 */
export const MOCK_ADVANCE_L2_AGGREGATION_APP_COMMIT_RAW =
  '0x005edcdbcd600e6c73c83d8a42e2b253072bef1da096c7affcfcb589a5afeca1'
  + '0050c7d02bc389a6d63e8d4ecb86f5e76094e6900b98a7a37b38818e1817f230'

function programCommitmentHash(rawCommit: string): string {
  return `0x${createHash('sha256').update(Buffer.from(rawCommit.slice(2), 'hex')).digest('hex')}`
}

export const MOCK_PROOF_IDENTITIES: Record<ProofFamily, MockProofIdentity> = {
  advance_l2_aggregation: {
    circuitId: 'l2-range-aggregation-v1',
    // prover-worker-mock 0.3.0-beta.0's head-free tag-5 mock policy pins
    // this wire release to "1" (the other mock families remain "1.0.0").
    circuitVersion: '1',
    manifestBasename: 'l2-range-aggregation-topology-program.json',
    programCommitmentHash: programCommitmentHash(MOCK_ADVANCE_L2_AGGREGATION_APP_COMMIT_RAW),
    verifierId: 'openvm-l2-range-aggregation-verifier-v1',
    vkHash: `0x${'aa'.repeat(32)}`,
  },
  bridge_transition: {
    circuitId: 'bridge-transition-v1',
    circuitVersion: MOCK_PROOF_CIRCUIT_VERSION,
    manifestBasename: 'bridge-topology-program.json',
    programCommitmentHash: `0x${'77'.repeat(32)}`,
    verifierId: 'openvm-bridge-topology-verifier-v1',
    vkHash: `0x${'88'.repeat(32)}`,
  },
  scroll_batch: {
    circuitId: 'scroll-batch-v1',
    circuitVersion: MOCK_PROOF_CIRCUIT_VERSION,
    manifestBasename: 'scroll-batch-topology-program.json',
    programCommitmentHash: `0x${'66'.repeat(32)}`,
    verifierId: DEV_MOCK_BATCH_VERIFIER_ID,
    vkHash: `0x${'55'.repeat(32)}`,
  },
  scroll_chunk: {
    circuitId: 'scroll-chunk-v1',
    circuitVersion: MOCK_PROOF_CIRCUIT_VERSION,
    manifestBasename: 'scroll-chunk-topology-program.json',
    programCommitmentHash: `0x${'ee'.repeat(32)}`,
    verifierId: DEV_MOCK_CHUNK_VERIFIER_ID,
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
    circuit_version: identity.circuitVersion,
    hard_fork_name: null,
    program_commitment_hash: identity.programCommitmentHash,
    // dogeos-core renamed the head-free tag-5 wire family while this CLI
    // keeps the historical internal map key for release-artifact lookup.
    proof_family: family === 'advance_l2_aggregation' ? 'l2_range_aggregation' : family,
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
