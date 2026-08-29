import {expect} from 'chai'

import {
  PROOF_PRODUCTION_INPUTS_REQUIRED_MESSAGE,
} from '../../../src/commands/setup/doge-config.js'
import {PROOF_AWS_INIT_NEXT_STEPS} from '../../../src/commands/setup/proof-aws-init.js'
import {PROOF_RELEASE_INIT_NEXT_STEP} from '../../../src/commands/setup/proof-release-init.js'

describe('proof setup command guidance', () => {
  it('points proof-aws-init users through doge-config before prep-charts', () => {
    expect(PROOF_AWS_INIT_NEXT_STEPS)
      .to.include('scrollsdk setup doge-config --proof-topology')
    expect(PROOF_AWS_INIT_NEXT_STEPS).to.include('disabled/mock need no release manifest')
    expect(PROOF_AWS_INIT_NEXT_STEPS).to.include('scrollsdk setup prep-charts')
  })

  it('routes only missing production inputs through the release preparation command', () => {
    expect(PROOF_PRODUCTION_INPUTS_REQUIRED_MESSAGE).to.include('Production mode')
    expect(PROOF_PRODUCTION_INPUTS_REQUIRED_MESSAGE).to.include('setup proof-release-init')
    expect(PROOF_PRODUCTION_INPUTS_REQUIRED_MESSAGE).to.include('--proof-production-inputs')
    expect(PROOF_RELEASE_INIT_NEXT_STEP).to.include('setup doge-config --proof-topology')
    expect(PROOF_RELEASE_INIT_NEXT_STEP).to.include('setup prep-charts')
  })
})
