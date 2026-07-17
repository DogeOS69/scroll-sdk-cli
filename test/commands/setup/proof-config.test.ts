import { expect } from 'chai'

import {
  DEFAULT_PROOF_ARTIFACT_MANIFEST,
  DEFAULT_PROOF_COORDINATOR_CONFIG,
  DEFAULT_PROOF_PROGRAM_MANIFESTS,
  resolveProofDeploymentPaths,
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

  it('derives every proof path from one deployment root', () => {
    const layout = resolveProofDeploymentPaths({ deploymentDir: '/srv/dogeos/testnet' })
    expect(layout.valuesDir).to.equal('/srv/dogeos/testnet/values')
    expect(layout.coordinatorConfig).to.equal('/srv/dogeos/testnet/proof-coordinator/ProofCoordinator.toml')
    expect(layout.withdrawalConfig).to.equal('/srv/dogeos/testnet/withdrawal-processor/WithdrawalProcessor.toml')
    expect(layout.dogeConfig).to.equal('/srv/dogeos/testnet/.data/doge-config.toml')
    expect(layout.programManifests).to.deep.equal([
      '/srv/dogeos/testnet/proof-artifacts/manifests/scroll-chunk.json',
      '/srv/dogeos/testnet/proof-artifacts/manifests/scroll-batch.json',
      '/srv/dogeos/testnet/proof-artifacts/manifests/bridge-transition.json',
    ])
    expect(layout.workerBundleDir).to.equal('/srv/dogeos/testnet/prover-worker-mock/docker-compose')
  })
})
