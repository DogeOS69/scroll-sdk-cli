import {expect} from 'chai'

import {readCubesignerOrganization} from '../../src/utils/cubesigner-organization.js'

describe('CubeSigner organization readback', () => {
  for (const orgId of ['fixture_org', 'Org#fixture']) it(`resolves ${orgId} without changing the session`, async () => {
    const client = {org: () => ({fetch: async () => ({name: 'fixture_org', org_id: 'Org#fixture'})}), orgId}
    expect(await readCubesignerOrganization(client)).deep.equal({organization: 'Org#fixture', organizationName: 'fixture_org'})
    expect(client.orgId).equal(orgId)
  })

  it('accepts a canonical session when the provider has no organization alias', async () => {
    const client = {org: () => ({fetch: async () => ({name: null, org_id: 'Org#fixture'})}), orgId: 'Org#fixture'}
    expect(await readCubesignerOrganization(client)).deep.equal({organization: 'Org#fixture', organizationName: undefined})
  })

  for (const result of [
    {name: 'another_org', org_id: 'Org#other'},
    {name: 'fixture_org', org_id: 'fixture_org'},
    {name: null, org_id: 'Org#fixture'},
  ]) it(`rejects inconsistent provider identity ${result.org_id}`, async () => {
    try {
      await readCubesignerOrganization({org: () => ({fetch: async () => result}), orgId: 'fixture_org'})
      expect.fail('Expected identity mismatch')
    } catch (error) {
      expect((error as Error).message).equal('Management session organization readback mismatch')
    }
  })
})
