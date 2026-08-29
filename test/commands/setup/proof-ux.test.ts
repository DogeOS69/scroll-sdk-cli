import {expect} from 'chai'

import {
  PROOF_RELEASE_LOCK_REQUIRED_MESSAGE,
} from '../../../src/commands/setup/doge-config.js'
import {PROOF_AWS_INIT_NEXT_STEPS} from '../../../src/commands/setup/proof-aws-init.js'
import {PROOF_RELEASE_INIT_NEXT_STEP} from '../../../src/commands/setup/proof-release-init.js'

describe('proof setup command guidance', () => {
  it('points proof-aws-init users through doge-config before prep-charts', () => {
    expect(PROOF_AWS_INIT_NEXT_STEPS)
      .to.include('scrollsdk setup proof-release-init')
    expect(PROOF_AWS_INIT_NEXT_STEPS)
      .to.include('scrollsdk setup doge-config --proof-topology')
    expect(PROOF_AWS_INIT_NEXT_STEPS).to.include('before prep-charts')
    expect(PROOF_AWS_INIT_NEXT_STEPS).not.to.include('run scrollsdk setup prep-charts once')
  })

  it('routes a missing deployment lock through the release preparation command', () => {
    expect(PROOF_RELEASE_LOCK_REQUIRED_MESSAGE).to.include('setup proof-release-init')
    expect(PROOF_RELEASE_LOCK_REQUIRED_MESSAGE).to.include('--proof-release-lock')
    expect(PROOF_RELEASE_INIT_NEXT_STEP).to.include('setup doge-config --proof-topology')
    expect(PROOF_RELEASE_INIT_NEXT_STEP).to.include('setup prep-charts')
  })
})
