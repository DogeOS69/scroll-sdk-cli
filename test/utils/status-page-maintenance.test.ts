import {expect} from 'chai'

import {normalizeMaintenance} from '../../src/utils/status-page-maintenance.js'

describe('component maintenance windows', () => {
  const valid = {components: ['sequencing'], end: '2026-12-01T02:00:00Z', id: 'upgrade', start: '2026-12-01T01:00:00Z'}
  it('retains explicit UTC windows and their component scope', () => {
    expect(normalizeMaintenance([valid], ['sequencing'])).to.deep.equal([valid])
  })
  it('rejects ambiguous timestamps, invalid dates, reversed windows and unknown components', () => {
    for (const patch of [{start: '2026-12-01T01:00:00'}, {start: '2026-02-30T01:00:00Z'}, {end: valid.start}, {components: ['mainnet-rpc']}, {components: []}]) expect(() => normalizeMaintenance([{...valid, ...patch}], ['sequencing'])).to.throw()
    expect(() => normalizeMaintenance([valid, valid], ['sequencing'])).to.throw()
  })
})
