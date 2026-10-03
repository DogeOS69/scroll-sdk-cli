import {expect} from 'chai'
import {Wallet, ZeroAddress} from 'ethers'

import {inspectContractOwner} from '../../src/utils/contract-owner.js'

describe('contract owner signing access', () => {
  const key = '0x' + '11'.repeat(32)
  const otherKey = '0x' + '22'.repeat(32)
  const owner = new Wallet(key).address
  const other = new Wallet(otherKey).address
  it('recognizes the deployer key without requiring a duplicate owner private key', () => {
    expect(inspectContractOwner({DEPLOYER_ADDR: owner, DEPLOYER_PRIVATE_KEY: key, OWNER_ADDR: owner}))
      .to.deep.equal({address: owner, signingSource: 'deployer', warnings: []})
  })
  it('recognizes a separate owner key and rejects a mismatched key', () => {
    expect(inspectContractOwner({OWNER_ADDR: owner, OWNER_PRIVATE_KEY: key}).signingSource).to.equal('owner-private-key')
    expect(() => inspectContractOwner({OWNER_ADDR: owner, OWNER_PRIVATE_KEY: otherKey})).to.throw('does not match OWNER_ADDR')
    expect(() => inspectContractOwner({DEPLOYER_ADDR: other, DEPLOYER_PRIVATE_KEY: key, OWNER_ADDR: owner})).to.throw('does not match DEPLOYER_ADDR')
  })
  it('supports an external owner without claiming to control it or replacing it', () => {
    const accounts = {DEPLOYER_ADDR: other, DEPLOYER_PRIVATE_KEY: otherKey, OWNER_ADDR: owner}
    const result = inspectContractOwner(accounts)
    expect(result.signingSource).to.equal('external')
    expect(result.warnings.join(' ')).to.include('without the recipient signing').and.not.to.include(otherKey)
    expect(accounts.OWNER_ADDR).to.equal(owner)
  })
  it('rejects blank/zero owners and redacts invalid private keys', () => {
    for (const value of ['', ZeroAddress, 'not-an-address']) expect(() => inspectContractOwner({OWNER_ADDR: value})).to.throw('nonzero EVM address')
    try {inspectContractOwner({OWNER_ADDR: owner, OWNER_PRIVATE_KEY: 'private-content'})} catch (error) {
      expect((error as Error).message).not.to.include('private-content')
    }
  })
  it('resolves environment references without exposing their values', () => {
    const saved = process.env.TEST_OWNER_KEY
    try {
      process.env.TEST_OWNER_KEY = key
      expect(inspectContractOwner({OWNER_ADDR: owner, OWNER_PRIVATE_KEY: '$ENV:TEST_OWNER_KEY'}).signingSource).to.equal('owner-private-key')
      delete process.env.TEST_OWNER_KEY
      expect(() => inspectContractOwner({OWNER_ADDR: owner, OWNER_PRIVATE_KEY: '$ENV:TEST_OWNER_KEY'})).to.throw('unset environment variable')
    } finally {
      if (saved === undefined) delete process.env.TEST_OWNER_KEY
      else process.env.TEST_OWNER_KEY = saved
    }
  })
})
