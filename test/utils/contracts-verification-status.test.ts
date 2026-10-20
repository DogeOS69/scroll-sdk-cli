import {expect} from 'chai'

import {readVerificationStatus} from '../../src/utils/contracts-verification-status.js'

describe('final source verification status', () => {
  const targets = ['full', 'partial', 'pending', 'missing', 'error'].map((name, index) => ({address: `0x${String(index).padStart(40, '0')}`, name}))
  it('does not equate a partial match, submission, missing address or provider failure with full verification', async () => {
    const payloads = [{is_fully_verified: true, is_partially_verified: false, is_verified: true}, {is_partially_verified: true, is_verified: true}, {is_verified: true}, undefined, undefined]
    let index = 0
    const request = (async () => {
      const current = index++
      if (current === 4) throw new Error('private provider error')
      return new Response(JSON.stringify(payloads[current] ?? {}), {status: current === 3 ? 404 : 200})
    }) as typeof fetch
    const result = await readVerificationStatus('https://explorer.example.invalid/api', targets, request)
    expect(result.map(entry => entry.status)).deep.eq(['verified', 'partial', 'pending', 'pending', 'unavailable'])
    expect(JSON.stringify(result)).not.include('private provider')
  })
})
