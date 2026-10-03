import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import sinon from 'sinon'

import {InstatusClient, validateGrafanaWebhookUrl} from '../../src/utils/status-page-instatus.js'
import {StatusPageWebhook} from '../../src/utils/status-page-webhook.js'

const URL = 'https://api.instatus.com/v3/integrations/grafana/private-fixture-id'
const reference = {key: 'url', name: 'instatus-grafana-webhook'}

describe('status-page webhook bootstrap and credential persistence', () => {
  let root: string
  const make = (environment = 'testnet') => new StatusPageWebhook(root, environment)
  const receiptFile = () => path.join(root, 'secrets/status-page/binding.json')
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-page-webhook-')) })
  afterEach(() => { sinon.restore(); fs.rmSync(root, {force: true, recursive: true}) })

  it('uses the verified integration API, validates ownership, and keeps response credentials out of errors', async () => {
    const transport = sinon.stub().resolves(new Response(JSON.stringify({integration: {
      id: 'private-fixture-id', monitoringTool: 'GRAFANA', siteId: 'page-1', uniqueUrl: URL,
    }})))
    const client = new InstatusClient('fake-management-key', transport)
    expect(await client.createGrafanaWebhook('page-1')).to.deep.equal({integrationId: 'private-fixture-id', url: URL})
    expect(transport.firstCall.args[0]).to.equal('https://api.instatus.com/v3/integrations')
    expect(JSON.parse(transport.firstCall.args[1].body)).to.deep.equal({components: [], integrationType: 'GRAFANA', pageId: 'page-1'})
    for (const invalid of [{siteId: 'wrong-page'}, {monitoringTool: 'PINGDOM'}, {uniqueUrl: 'https://evil.example/secret'}, {id: ''}]) {
      transport.resolves(new Response(JSON.stringify({integration: {id: 'id', monitoringTool: 'GRAFANA', siteId: 'page-1', uniqueUrl: URL, ...invalid}})))
      let error = ''
      try { await client.createGrafanaWebhook('page-1') } catch (error_) { error = String(error_) }
      expect(error).not.to.equal('')
      expect(error).not.to.contain(URL)
      expect(error).not.to.contain('fake-management-key')
    }
  })

  it('plans without files, creates once, persists credentials privately, and reuses after restart', async () => {
    execFileSync('git', ['init', '-q', root])
    const webhook = make()
    const plan = webhook.plan('page-1', true, false)
    expect(fs.existsSync(path.join(root, 'secrets'))).to.equal(false)
    expect(plan.action).to.equal('create')
    webhook.prepare()
    const client = new InstatusClient('fake-management-key')
    const create = sinon.stub(client, 'createGrafanaWebhook').resolves({integrationId: 'private-fixture-id', url: URL})
    await webhook.apply(plan, client, 'page-1', reference)
    const secret = JSON.parse(fs.readFileSync(webhook.secretFile, 'utf8'))
    expect(secret).to.deep.equal({apiVersion: 'v1', data: {url: Buffer.from(URL).toString('base64')}, kind: 'Secret', metadata: {name: reference.name}, type: 'Opaque'})
    expect(fs.statSync(receiptFile()).mode % 0o1000).to.equal(0o600)
    expect(fs.statSync(webhook.secretFile).mode % 0o1000).to.equal(0o600)
    expect(fs.statSync(path.dirname(receiptFile())).mode % 0o1000).to.equal(0o700)
    expect(execFileSync('git', ['-C', root, 'check-ignore', webhook.secretFile], {encoding: 'utf8'})).to.contain('grafana.secret.yaml')
    expect(execFileSync('git', ['-C', root, 'check-ignore', receiptFile()], {encoding: 'utf8'})).to.contain('binding.json')
    expect(fs.readFileSync(receiptFile(), 'utf8')).not.to.contain('fake-management-key')
    fs.unlinkSync(webhook.secretFile)
    const restored = make()
    const repeat = restored.plan('page-1', true, true)
    expect(repeat.action).to.equal('reuse')
    restored.prepare()
    await restored.apply(repeat, client, 'page-1', {key: 'target', name: 'new-secret'})
    expect(create.callCount).to.equal(1)
    expect(JSON.parse(fs.readFileSync(restored.secretFile, 'utf8')).data).to.deep.equal({target: Buffer.from(URL).toString('base64')})
    expect(JSON.stringify(repeat)).not.to.contain('private-fixture-id')
  })

  it('blocks automatic re-creation after an ambiguous POST; explicit import recovers the existing URL', async () => {
    const client = new InstatusClient('fixture')
    const create = sinon.stub(client, 'createGrafanaWebhook').rejects(new Error('Lost response'))
    const webhook = make()
    const plan = webhook.plan('page-1', true, false)
    webhook.prepare()
    try { await webhook.apply(plan, client, 'page-1', reference) } catch { /* expected */ }
    expect(JSON.parse(fs.readFileSync(receiptFile(), 'utf8')).status).to.equal('creating')
    expect(() => make().plan('page-1', true, false)).to.throw('no replacement')
    expect(() => make().plan('page-1', false, true)).to.throw('no replacement')
    const input = path.join(root, 'input.url')
    fs.writeFileSync(input, `${URL}\n`, {mode: 0o600})
    const restored = make()
    const adopt = restored.plan('page-1', false, true, input)
    expect(adopt.action).to.equal('import')
    restored.prepare()
    await restored.apply(adopt, client, 'page-1', reference)
    expect(create.callCount).to.equal(1)
    expect(make().plan('page-1', false, true).action).to.equal('reuse')
  })

  it('requires explicit first initialization and fails closed on missing, corrupt or cross-page state', async () => {
    expect(make().plan('page-1', false, false).action).to.equal('unmanaged')
    expect(() => make().plan('page-1', true, true)).to.throw('no replacement')
    const webhook = make()
    webhook.prepare()
    fs.writeFileSync(webhook.secretFile, 'private-existing-file')
    expect(() => make().plan('page-1', true, false)).to.throw('no replacement')
    fs.writeFileSync(receiptFile(), '{invalid-secret-contents')
    expect(() => make()).to.throw('Cannot read the private webhook binding')
    expect(() => make()).not.to.throw('invalid-secret-contents')
    fs.writeFileSync(receiptFile(), JSON.stringify({environment: 'testnet', pageId: 'another-page', status: 'ready', url: URL, version: 1}))
    expect(() => make().plan('page-1', true, false)).to.throw('different Instatus page')
    expect(() => make('devnet')).to.throw('different network')
  })

  it('rejects tracked credential files and symlinks before creating anything remotely', () => {
    execFileSync('git', ['init', '-q', root])
    const webhook = make()
    webhook.prepare()
    fs.writeFileSync(receiptFile(), '{}')
    execFileSync('git', ['-C', root, 'add', '-f', receiptFile()])
    expect(() => webhook.prepare()).to.throw('Git-tracked')
    fs.unlinkSync(receiptFile())
    fs.symlinkSync(path.join(root, 'outside'), receiptFile())
    expect(() => make()).to.throw('symbolic links')
  })

  it('rejects unsafe or wrong-provider URLs without including the input', () => {
    for (const url of ['http://api.instatus.com/v3/integrations/grafana/id', `${URL}\nINJECT=true`, `${URL}?token=x`, 'https://api.instatus.com.evil/v3/integrations/grafana/id', 'https://api.instatus.com/v3/integrations/pingdom/id']) {
      expect(() => validateGrafanaWebhookUrl(url)).to.throw('Expected a complete HTTPS')
    }
  })
})
