import {expect} from 'chai'

import {coreHelperNetwork} from '../../src/utils/bridge-constants.js'
import {canonicalDogecoinNetwork} from '../../src/utils/dogecoin-network.js'

describe('canonical Dogecoin network names', () => {
  for (const network of ['mainnet', 'testnet', 'regtest']) {
    it(`preserves ${network}`, () => {
      expect(canonicalDogecoinNetwork(network)).to.equal(network)
    })
  }

  it('accepts dogecoin only as an input alias for mainnet', () => {
    expect(canonicalDogecoinNetwork('dogecoin')).to.equal('mainnet')
    // Pinned bridge-genesis tools still need the old serde spelling; new Core accepts it too.
    expect(coreHelperNetwork('mainnet')).to.equal('dogecoin')
    expect(canonicalDogecoinNetwork(coreHelperNetwork('mainnet'))).to.equal('mainnet')
  })

  for (const network of ['bitcoin', 'signet', 'main', 'test', '', 'MAINNET', ' mainnet']) {
    it(`rejects unsupported name ${JSON.stringify(network)}`, () => {
      expect(() => canonicalDogecoinNetwork(network)).to.throw('Unsupported Dogecoin network')
    })
  }
})
