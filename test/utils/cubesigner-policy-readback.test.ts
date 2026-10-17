import {expect} from 'chai'
import sinon from 'sinon'

import {readRoleScopedPolicyKey} from '../../src/utils/cubesigner-policy-readback.js'

describe('role-scoped key readback transport', () => {
  it('sends a GET with details=true and uses the nested key policy, not the role policy', async () => {
    const key = {key_id: 'Key#fixture', policy: ['approved-key-policy']}
    const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (request, init) => {
      const url = new URL(String(request))
      expect(init?.method).to.equal('GET')
      expect(decodeURIComponent(url.pathname)).to.equal('/v0/org/Org#fixture/roles/Role#fixture/keys/Key#fixture')
      expect(url.searchParams.get('details')).to.equal('true')
      return new Response(JSON.stringify({key_id: key.key_id, key_info: key, policy: ['different-role-policy'], role_id: 'Role#fixture'}), {headers: {'content-type': 'application/json'}, status: 200})
    })
    const api: Parameters<typeof readRoleScopedPolicyKey>[0] = {
      async exec(operation, options) {
        const response = await operation({...options, baseUrl: 'https://provider.example',
          params: {...options.params, path: {...options.params?.path, org_id: 'Org#fixture'}},
        } as Parameters<typeof operation>[0])
        return response.data!
      },
    }
    try {
      expect(await readRoleScopedPolicyKey(api, 'Role#fixture', 'Key#fixture')).to.deep.equal(key)
      expect(fetch.calledOnce).to.equal(true)
    } finally {fetch.restore()}
  })
  for (const response of [
    {key_id: 'Key#fixture', role_id: 'Role#fixture'},
    {key_id: 'Key#fixture', key_info: {key_id: 'Key#other'}, role_id: 'Role#fixture'},
    {key_id: 'Key#fixture', key_info: {key_id: 'Key#fixture'}, role_id: 'Role#other'},
  ]) {
    it('refuses absent or mismatched detailed key evidence', async () => {
      const api = {exec: async () => response} as unknown as Parameters<typeof readRoleScopedPolicyKey>[0]
      try {await readRoleScopedPolicyKey(api, 'Role#fixture', 'Key#fixture'); expect.fail('must reject')} catch (error) {
        expect((error as Error).message).to.include('matching detailed key_info')
      }
    })
  }
})
