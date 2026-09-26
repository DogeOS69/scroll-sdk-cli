import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import sinon from 'sinon'

import {StatusPageHeartbeat} from '../../src/utils/status-page-heartbeat.js'
import {InstatusClient} from '../../src/utils/status-page-instatus.js'

describe('independent monitoring heartbeat', () => {
  let directory: string
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'status-heartbeat-')) })
  afterEach(() => { fs.rmSync(directory, {force: true, recursive: true}) })
  it('plans without private writes, creates no public component and reuses the same monitor', async () => {
    const name = 'DogeOS Testnet 123 monitoring heartbeat'
    let exists = false
    const transport = sinon.stub().callsFake(async (_url: string, init: RequestInit) => {
      if (init.method === 'POST') { exists = true; return new Response(JSON.stringify({cronMonitor: {componentId: null, id: 'cron-1', siteId: 'page-1', slug: 'private-slug'}})) }
      if (init.method === 'PUT') return new Response('{}')
      return new Response(JSON.stringify({cronMonitors: exists ? [{componentId: null, id: 'cron-1', name, siteId: 'page-1'}] : [], totalPages: 1}))
    })
    const client = new InstatusClient('fake-management-key', transport)
    const heartbeat = new StatusPageHeartbeat(directory, 'testnet', '123')
    const plan = await heartbeat.plan(client, 'page-1', 'Testnet', false)
    expect(plan.action).to.equal('create')
    expect(fs.existsSync(path.join(directory, 'secrets'))).to.equal(false)
    heartbeat.prepare()
    await heartbeat.apply(plan, client, 'page-1', ['ops-alert'])
    const request = JSON.parse(String(transport.getCalls().find(call => call.args[1].method === 'POST')!.args[1].body))
    expect(request.createComponent).to.equal(false)
    expect(request.onFail.createIncident).to.equal(false)
    expect(request.alerts).to.deep.equal(['ops-alert'])
    const restarted = new StatusPageHeartbeat(directory, 'testnet', '123')
    const reuse = await restarted.plan(client, 'page-1', 'Testnet', true, false)
    expect(reuse.action).to.equal('reuse')
    expect(reuse.state).to.equal('PAUSED')
    await restarted.apply(reuse, client, 'page-1', ['ops-alert'], false)
    expect(JSON.parse(transport.lastCall.args[1].body).state).to.equal('PAUSED')
    expect(transport.getCalls().filter(call => call.args[1].method === 'POST')).to.have.length(1)
    expect(JSON.stringify(plan)).not.to.contain('private-slug')
    expect(fs.statSync(restarted.secretFile).mode % 0o1000).to.equal(0o600)
    expect(fs.statSync(path.join(directory, 'secrets/status-page')).mode % 0o1000).to.equal(0o700)
  })
  it('blocks a second create after an ambiguous response or lost binding', async () => {
    const client = new InstatusClient('fake', sinon.stub().callsFake(async (_url: string, init: RequestInit) => {
      if (init.method === 'POST') throw new Error('unknown outcome')
      return new Response(JSON.stringify({cronMonitors: [], totalPages: 1}))
    }))
    const heartbeat = new StatusPageHeartbeat(directory, 'testnet', '123')
    const plan = await heartbeat.plan(client, 'page-1', 'Testnet', false)
    heartbeat.prepare()
    try { await heartbeat.apply(plan, client, 'page-1', ['ops']); expect.fail('should fail') } catch (error) { expect(String(error)).to.contain('may already have succeeded') }
    const restored = new StatusPageHeartbeat(directory, 'testnet', '123')
    try { await restored.plan(client, 'page-1', 'Testnet', true); expect.fail('should block') } catch (error) { expect(String(error)).to.contain('restore') }
  })
  it('does not recreate an existing remote monitor and rejects dangling credential symlinks', async () => {
    const client = new InstatusClient('fake', sinon.stub().resolves(new Response(JSON.stringify({cronMonitors: [{id: 'cron', name: 'DogeOS Testnet 123 monitoring heartbeat', siteId: 'page-1'}], totalPages: 1}))))
    const heartbeat = new StatusPageHeartbeat(directory, 'testnet', '123')
    try { await heartbeat.plan(client, 'page-1', 'Testnet', false); expect.fail('should block') } catch (error) { expect(String(error)).to.contain('already exists') }
    fs.symlinkSync(path.join(directory, 'missing'), path.join(directory, 'secrets'))
    expect(() => new StatusPageHeartbeat(directory, 'testnet', '123')).to.throw('symbolic')
  })
})
