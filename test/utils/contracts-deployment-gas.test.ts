import {expect} from 'chai'

import {contractsDeploymentGasPrice} from '../../src/utils/contracts-deployment-gas.js'

describe('contracts deployment gas price', () => {
  it('covers the default fee floor activated during deployment', () => {
    expect(contractsDeploymentGasPrice()).to.equal('840000000000')
  })

  it('uses the selected floor without losing integer precision', () => {
    expect(contractsDeploymentGasPrice('9007199254740993')).to.equal('18014398509481986')
    expect(contractsDeploymentGasPrice('10000000000')).to.equal('20000000000')
  })

  it('leaves estimation to Foundry when no fee floor is configured', () => {
    expect(contractsDeploymentGasPrice('0')).to.equal(undefined)
  })

  it('rejects invalid fee floors before generating a deployment environment', () => {
    for (const value of ['-1', '1.5', '1gwei', null, '']) {
      expect(() => contractsDeploymentGasPrice(value)).to.throw('Invalid L2 base fee overhead')
    }
  })
})
