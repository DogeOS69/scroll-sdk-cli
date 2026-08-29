import {expect} from 'chai'

import {
  PROOF_RELEASE_MANIFEST_NOT_DISCOVERED_MESSAGE,
  PROOF_RELEASE_MANIFEST_REQUIRED_MESSAGE,
  proofReleaseManifestPrompt,
} from '../../../src/commands/setup/doge-config.js'
import {PROOF_AWS_INIT_NEXT_STEPS} from '../../../src/commands/setup/proof-aws-init.js'

describe('proof setup command guidance', () => {
  it('points proof-aws-init users through doge-config before prep-charts', () => {
    expect(PROOF_AWS_INIT_NEXT_STEPS)
      .to.include('scrollsdk setup doge-config --proof-topology')
    expect(PROOF_AWS_INIT_NEXT_STEPS).to.include('before prep-charts')
    expect(PROOF_AWS_INIT_NEXT_STEPS).not.to.include('run scrollsdk setup prep-charts once')
  })

  it('does not offer a nonexistent proof release manifest as the interactive default', () => {
    expect(proofReleaseManifestPrompt()).to.deep.equal({
      message: 'Enter the dogeos/proof-release/v1 manifest path:',
    })
  })

  it('keeps the discovered proof release manifest as the interactive default', () => {
    expect(proofReleaseManifestPrompt('.data/proof-release-v1.json')).to.deep.equal({
      default: '.data/proof-release-v1.json',
      message: 'Enter the dogeos/proof-release/v1 manifest path:',
    })
  })

  it('explains that the proof release manifest comes from dogeos-core', () => {
    expect(PROOF_RELEASE_MANIFEST_NOT_DISCOVERED_MESSAGE).to.include('dogeos-core proof release bundle')
    expect(PROOF_RELEASE_MANIFEST_REQUIRED_MESSAGE).to.include('dogeos/proof-release/v1')
    expect(PROOF_RELEASE_MANIFEST_REQUIRED_MESSAGE).to.include('--proof-release')
  })
})
