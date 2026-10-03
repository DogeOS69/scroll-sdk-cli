/* eslint-disable @typescript-eslint/no-explicit-any -- Mock provider state. */
import {expect} from 'chai'
import sinon from 'sinon'

import {InstatusClient} from '../../src/utils/status-page-instatus.js'

const response = (data: unknown) => new Response(JSON.stringify(data), {status: 200})
const names = {devnet: 'Devnet', mainnet: 'Mainnet', testnet: 'Testnet'}
const catalog = (environment: keyof typeof names) => ({
  components: [{description: `${environment} RPC`, endpoints: [`https://rpc.${environment}.example/`], key: 'rpc', name: 'Public RPC'}, {description: `${environment} bridge`, endpoints: [], key: 'bridge', name: 'Bridge Portal'}],
  environment, groupName: names[environment], pageName: 'DogeOS',
})
const target = () => ({componentIds: {}, initialStatus: 'OPERATIONAL', pageId: '', showUptime: false, subdomain: 'dogeos', workspaceSlug: '6wxpx'})

describe('shared Instatus page ownership', () => {
  it('reconciles three groups independently, preserves outages, and repeats without mutations', async () => {
    const components: any[] = Object.entries(names).map(([environment, name]) => ({group: {id: `${environment}-group`, name}, id: `${environment}-rpc`, name: 'Public RPC', status: 'MAJOROUTAGE'}))
    const transport = sinon.stub().callsFake(async (url: string, init: RequestInit) => {
      const route = new URL(url).pathname
      if (route === '/v1/workspaces') return response([{id: 'workspace', slug: '6wxpx'}])
      if (route === '/v2/pages') return response([{id: 'shared-page', name: 'DogeOS', subdomain: 'dogeos', workspaceId: 'workspace'}])
      if (init.method === 'GET') return response(components)
      const body = JSON.parse(String(init.body))
      if (init.method === 'PUT') {
        const existing = components.find(item => item.id === route.split('/').at(-1))
        expect(body).not.to.have.property('status')
        expect(body.groupId).to.equal(existing.group.id)
        Object.assign(existing, body)
        return response(existing)
      }

      expect(route).to.equal('/v1/shared-page/components')
      expect(body.grouped).to.equal(true)
      const {group} = components.find(item => item.group.id === body.group)
      const created = {...body, group, id: `${group.id}-bridge`}
      components.push(created)
      return response(created)
    })
    const client = new InstatusClient('fixture', transport as any)
    for (const environment of ['mainnet', 'testnet', 'devnet'] as const) {
      const before = structuredClone(components.filter(item => item.group.name !== names[environment]))
      const plan = await client.plan(catalog(environment), target())
      expect(plan.page.id).to.equal('shared-page')
      expect(plan.group?.id).to.equal(`${environment}-group`)
      await client.apply(plan, () => {}, () => {})
      expect(components.filter(item => item.group.name !== names[environment])).to.deep.equal(before)
    }

    expect(components).to.have.length(6)
    expect(components.filter(item => item.status === 'MAJOROUTAGE')).to.have.length(3)
    const writes = transport.getCalls().filter(call => call.args[1].method !== 'GET').length
    for (const environment of ['mainnet', 'testnet', 'devnet'] as const) {
      const plan = await client.plan(catalog(environment), target())
      expect(plan.components.every(item => item.action === 'unchanged')).to.equal(true)
      await client.apply(plan, () => {}, () => {})
    }

    expect(transport.getCalls().filter(call => call.args[1].method !== 'GET')).to.have.length(writes)
  })

  for (const kind of ['workspace', 'foreign-id', 'duplicate-group', 'wrong-group-id']) {
    it(`rejects ${kind} before writes`, async () => {
      const remote = [{group: {id: 'mainnet-group', name: 'Mainnet'}, id: 'mainnet-rpc', name: 'Public RPC'}, {group: {id: 'testnet-group', name: 'Testnet'}, id: 'testnet-rpc', name: 'Public RPC'}]
      if (kind === 'duplicate-group') remote.push({group: {id: 'other-testnet-group', name: 'Testnet'}, id: 'duplicate', name: 'Public RPC'})
      const transport = sinon.stub()
      transport.onCall(0).resolves(response([{id: 'workspace', slug: '6wxpx'}]))
      transport.onCall(1).resolves(response([{id: 'shared-page', name: 'DogeOS', subdomain: 'dogeos', workspaceId: kind === 'workspace' ? 'other' : 'workspace'}]))
      transport.onCall(2).resolves(response(remote))
      let error = ''
      try {
        await new InstatusClient('fixture', transport as any).plan(catalog('testnet'), {...target(), componentIds: kind === 'foreign-id' ? {rpc: 'mainnet-rpc'} : {}, groupId: kind === 'wrong-group-id' ? 'mainnet-group' : ''})
      } catch (error_) { error = String(error_) }

      expect(error).not.to.equal('')
      expect(transport.getCalls().every(call => call.args[1].method === 'GET')).to.equal(true)
    })
  }

  it('reports dashboard bootstrap instead of claiming it can create a group', async () => {
    const transport = sinon.stub()
    transport.onCall(0).resolves(response([{id: 'workspace', slug: '6wxpx'}]))
    transport.onCall(1).resolves(response([{id: 'shared-page', name: 'DogeOS', subdomain: 'dogeos', workspaceId: 'workspace'}]))
    transport.onCall(2).resolves(response([]))
    const client = new InstatusClient('fixture', transport as any)
    const plan = await client.plan(catalog('testnet'), target())
    expect(plan.group).to.deep.equal({action: 'bootstrap', id: '', name: 'Testnet'})
    let error = ''
    try { await client.apply(plan, () => {}, () => {}) } catch (error_) { error = String(error_) }
    expect(error).to.contain('Initialize the Testnet group')
    expect(transport.callCount).to.equal(3)
  })

  it('plans and applies only specified page branding without changing global health', async () => {
    const transport = sinon.stub()
    transport.onCall(0).resolves(response([{id: 'page', logoUrl: null, name: 'DogeOS', subdomain: 'dogeos'}]))
    transport.onCall(1).resolves(response([]))
    transport.onCall(2).resolves(response({id: 'page'}))
    const client = new InstatusClient('fixture', transport as any)
    const branding = {logoUrl: 'https://example.com/logo.png'}
    const plan = await client.plan({components: [], environment: 'testnet', pageName: 'DogeOS'}, {...target(), branding, workspaceSlug: ''})
    expect(plan.page.action).to.equal('update')
    await client.apply(plan, () => {}, () => {})
    expect(JSON.parse(transport.getCall(2).args[1].body)).to.deep.equal({name: 'DogeOS', ...branding})
  })
})
