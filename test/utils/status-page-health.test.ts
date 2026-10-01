import {expect} from 'chai'

import {normalizeHealth, normalizeProbes} from '../../src/utils/status-page-health.js'

describe('status-page built-in health', () => {
  it('requires explicit business deadlines, continuous production and semantic dependency checks', () => {
    const health = normalizeHealth()
    expect(health).to.deep.equal({}) // Runtime owns policy defaults and PromQL.
    expect(normalizeHealth({failureFor: '2m'})).to.deep.equal({failureFor: '2m'})
    const catalog = {chainId: '123', components: ['public-rpc','bridge-portal','block-explorer'].map(key => ({endpoints: ['https://example.com'], key})), environment: 'testnet'}
    const probes = normalizeProbes({}, catalog, health)
    expect(probes.missing).to.have.all.keys('sequencing','bridge-portal','block-explorer','node-sync','deposits','withdrawals','batch-publication')
    expect(() => normalizeHealth({minimumProbeLocations: 1})).to.throw('independent')
    expect(() => normalizeProbes({bridgeChecks: [{equals: {}, path: [], url: 'https://key:secret@example.com'}]}, catalog, health)).to.throw('credentials')
  })

})
