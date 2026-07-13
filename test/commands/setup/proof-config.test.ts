import { expect } from 'chai'

import {
  DEFAULT_PROOF_ARTIFACT_MANIFEST,
  DEFAULT_PROOF_COORDINATOR_CONFIG,
  DEFAULT_PROOF_PROGRAM_MANIFESTS,
} from '../../../src/commands/setup/proof-config.js'

describe('setup proof-config path convention', () => {
  it('uses the deployment Makefile proof-artifacts layout', () => {
    expect(DEFAULT_PROOF_ARTIFACT_MANIFEST).to.equal('proof-artifacts/release.json')
    expect(DEFAULT_PROOF_COORDINATOR_CONFIG).to.equal('proof-coordinator/ProofCoordinator.toml')
    expect(DEFAULT_PROOF_PROGRAM_MANIFESTS).to.deep.equal([
      'proof-artifacts/manifests/scroll-chunk.json',
      'proof-artifacts/manifests/scroll-batch.json',
      'proof-artifacts/manifests/bridge-transition.json',
    ])
  })
})
