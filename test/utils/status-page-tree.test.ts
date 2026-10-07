import {expect} from 'chai'

import {InstatusClient} from '../../src/utils/status-page-instatus.js'

const catalog = {
  components: [{description: 'RPC', endpoints: [], key: 'rpc', name: 'Public RPC'}, {description: 'Bridge', endpoints: [], key: 'bridge', name: 'Bridge Portal'}],
  environment: 'devnet', groupName: 'Devnet', pageName: 'DogeOS',
}
const target = {componentIds: {}, initialStatus: 'OPERATIONAL', pageId: 'page', showUptime: false, subdomain: 'dogeos'}
const leaf = {archivedAt: null, children: [], description: 'RPC', id: 'devnet-rpc', isParent: false, name: 'Public RPC', order: 0, showUptime: false, status: 'MAJOROUTAGE'}
const group = {children: [leaf], id: 'devnet-group', isParent: true, name: 'Devnet'}

function clientFor(tree: unknown[]) {
  const calls: Array<{body?: unknown; method?: string; url: string}> = []
  const transport: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({body: init?.body ? JSON.parse(String(init.body)) : undefined, method: init?.method, url})
    if (init?.method !== 'GET') throw new Error('Unexpected write')
    return new Response(JSON.stringify(url.includes('/v2/pages?') ? [{id: 'page', name: 'DogeOS', subdomain: 'dogeos'}] : tree), {status: 200})
  }

  return {calls, client: new InstatusClient('fixture', transport)}
}

describe('Instatus live parent/children response', () => {
  it('adopts an existing child in Devnet without matching another network or the parent', async () => {
    const {calls, client} = clientFor([group, {children: [{...leaf, id: 'mainnet-rpc'}], id: 'mainnet-group', isParent: true, name: 'Mainnet'}])
    const plan = await client.plan(catalog, target)
    expect(plan.group).to.deep.equal({action: 'reuse', id: 'devnet-group', name: 'Devnet'})
    expect(plan.components[0]).to.include({action: 'unchanged', id: 'devnet-rpc'})
    expect(plan.components[1].action).to.equal('create')
    expect(calls.every(call => call.method === 'GET')).to.equal(true)
  })

  it('discovers an empty parent group returned by the live API', async () => {
    const {client} = clientFor([{...group, children: []}])
    const plan = await client.plan(catalog, target)
    expect(plan.group?.action).to.equal('reuse')
    expect(plan.components.every(component => component.action === 'create')).to.equal(true)
  })

  for (const kind of ['foreign-id', 'archived-child', 'archived-parent', 'duplicate-group', 'conflicting-parent', 'duplicate-child'] as const) {
    it(`rejects ${kind} before writing`, async () => {
      const tree = [structuredClone(group), {children: [{...leaf, id: 'mainnet-rpc'}], id: 'mainnet-group', isParent: true, name: 'Mainnet'}]
      if (kind === 'archived-child') Object.assign(tree[0].children[0], {archivedAt: '2026-09-26T00:00:00Z'})
      if (kind === 'archived-parent') Object.assign(tree[0], {archivedAt: '2026-09-26T00:00:00Z'})
      if (kind === 'duplicate-group') tree.push({...group, children: [], id: 'duplicate-group'})
      if (kind === 'conflicting-parent') Object.assign(tree[0].children[0], {groupId: 'mainnet-group'})
      if (kind === 'duplicate-child') tree[0].children.push({...leaf})
      const {calls, client} = clientFor(tree)
      let message = ''
      try {
        await client.plan(catalog, {...target, componentIds: kind === 'foreign-id' ? {rpc: 'mainnet-rpc'} : {}})
      } catch (error) { message = String(error) }

      expect(message).not.to.equal('')
      expect(calls.every(call => call.method === 'GET')).to.equal(true)
    })
  }
})
