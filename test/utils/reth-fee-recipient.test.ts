import {expect} from 'chai'

import {applyRethFeeRecipient} from '../../src/commands/setup/prep-charts.js'

describe('Reth fee recipient projection', () => {
  const address = '0x5300000000000000000000000000000000000005'

  it('replaces an unresolved template with the actual L2 fee vault and is idempotent', () => {
    const values = {reth: {sequencer: {enabled: true, feeRecipient: '<TODO>'}}}
    expect(applyRethFeeRecipient(values, address)).to.have.length(1)
    expect(values.reth.sequencer).to.deep.equal({enabled: true, feeRecipient: address})
    expect(applyRethFeeRecipient(values, address)).to.deep.equal([])
  })

  it('rejects missing, invalid, zero and Dogecoin addresses', () => {
    for (const value of [undefined, '<TODO>', '0x' + '0'.repeat(40), 'nqsFQaPawarYiFrtaAcjKoxwwEmYWaFNoQ']) {
      expect(() => applyRethFeeRecipient({}, value)).to.throw('valid nonzero address')
    }
  })
})
