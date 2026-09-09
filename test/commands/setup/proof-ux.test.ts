import {expect} from 'chai'

import {PROOF_AWS_INIT_NEXT_STEPS} from '../../../src/commands/setup/proof-aws-init.js'

describe('proof setup command guidance', () => {
  it('routes AWS users through proof materials before topology configuration', () => {
    expect(PROOF_AWS_INIT_NEXT_STEPS).to.include('scrollsdk setup proof-materials')
    expect(PROOF_AWS_INIT_NEXT_STEPS).to.include('scrollsdk setup doge-config --proof-topology')
    expect(PROOF_AWS_INIT_NEXT_STEPS).to.include('scrollsdk setup prep-charts')
    expect(PROOF_AWS_INIT_NEXT_STEPS).not.to.include('proof-release-init')
  })
})
