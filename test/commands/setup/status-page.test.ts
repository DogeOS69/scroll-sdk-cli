/* eslint-disable @typescript-eslint/no-explicit-any -- Test dynamic Helm values and mocked HTTP responses. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import sinon from 'sinon'

import PrepCharts from '../../../src/commands/setup/prep-charts.js'
import StatusPage from '../../../src/commands/setup/status-page.js'
import {InstatusClient} from '../../../src/utils/status-page-instatus.js'
import {reconcileScrollMonitorStatusPage} from '../../../src/utils/status-page-values.js'

const ENV = 'INSTATUS_GRAFANA_WEBHOOK_URL'
const FILE = 'instatus-contact-points.yaml'
const ingress = (host: string) => ({enabled: true, hosts: [{host, paths: [{path: '/'}]}]})
const target = () => ({componentIds: {}, initialStatus: 'OPERATIONAL', pageId: 'page-1', showUptime: false})
const catalog = {components: [{description: 'Public RPC access.', endpoints: ['https://rpc.example/'], key: 'public-rpc', name: 'Public RPC'}], environment: 'testnet', pageName: 'DogeOS Testnet Status'}
const remote = {description: 'old', group: null, id: 'rpc-1', name: 'Public RPC', order: 0, showUptime: false, status: 'MAJOROUTAGE'}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {headers: {'Content-Type': 'application/json'}, status})

describe('status-page generation and explicit Instatus apply', () => {
  let directory: string
  let values: any
  const write = (filename: string, content: unknown) => fs.writeFileSync(path.join(directory, filename), yaml.dump(content))
  const generate = (environment = 'testnet') => reconcileScrollMonitorStatusPage(values, {chainId: '0x123', environment, networkName: 'DogeOS', valuesDir: directory})
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'status-page-test-'))
    values = {grafana: {alerting: {'policies.yaml': {policies: [{receiver: 'internal'}]}}, envValueFrom: {OTHER: {secretKeyRef: {key: 'k', name: 'other'}}}}, statusPage: {enabled: true, environment: 'testnet'}}
    write('frontends-production.yaml', {ingress: {main: ingress('portal.custom.example')}})
    write('l2-reth-rpc-public-production.yaml', {ingress: {main: ingress('rpc.custom.example'), websocket: ingress('ws.custom.example')}})
    write('blockscout-production.yaml', {'blockscout-stack': {blockscout: {env: {}}, frontend: {env: {}, ingress: {enabled: true, hostname: 'explorer.custom.example'}}}})
  })
  afterEach(() => {
    sinon.restore()
    fs.rmSync(directory, {force: true, recursive: true})
  })

  it('derives 8 components from selected files, preserves internal routing, and is idempotent', () => {
    generate()
    const {components} = values.statusPage.catalog
    expect(components).to.have.length(8)
    expect(components.find((item: any) => item.key === 'bridge-portal').endpoints).to.deep.equal(['https://portal.custom.example/bridge'])
    expect(components.find((item: any) => item.key === 'public-rpc').endpoints).to.deep.equal(['https://rpc.custom.example/', 'wss://ws.custom.example/'])
    expect(components.find((item: any) => item.key === 'block-explorer').endpoints).to.deep.equal(['https://explorer.custom.example/'])
    expect(values.statusPage.catalog.chainId).to.equal('291')
    expect(values.statusPage.instatus.subdomain).to.equal('dogeos-testnet')
    expect(values.statusPage.instatus.initialStatus).to.equal('OPERATIONAL')
    expect(values.statusPage.grafana.contactPointName).to.equal('instatus-public')
    expect(values.statusPage.grafana.receiverUid).to.equal('instatus-public-webhook')
    expect(JSON.stringify(values)).not.to.match(/l2scan|faucet|dogeos\.com|apiKey/)
    expect(values.grafana.alerting['policies.yaml']).to.deep.equal({policies: [{receiver: 'internal'}]})
    expect(values.grafana.envValueFrom.OTHER.secretKeyRef.name).to.equal('other')
    expect(values.grafana.envValueFrom[ENV]).to.deep.equal({secretKeyRef: {key: 'url', name: 'instatus-grafana-webhook'}})
    expect(values.grafana.alerting[FILE].contactPoints[0].receivers[0].settings.url).to.equal(`$${ENV}`)
    expect(generate()).to.deep.equal([])
  })

  for (const environment of ['devnet', 'mainnet']) {
    it(`supports explicit ${environment} without replacing domain strings`, () => {
      generate(environment)
      expect(values.statusPage.catalog.environment).to.equal(environment)
      expect(values.statusPage.instatus.subdomain).to.equal(environment === 'mainnet' ? 'dogeos' : 'dogeos-devnet')
      expect(values.statusPage.catalog.components[6].endpoints[0]).to.equal('https://portal.custom.example/bridge')
      expect(() => generate('testnet')).to.throw('environment changed')
    })
  }

  it('preserves disabled opt-in and excludes disabled WebSocket', () => {
    expect(reconcileScrollMonitorStatusPage({}, {} as any)).to.deep.equal([])
    expect(reconcileScrollMonitorStatusPage({statusPage: {enabled: false}}, {} as any)).to.deep.equal([])
    write('l2-reth-rpc-public-production.yaml', {ingress: {main: ingress('rpc.example'), websocket: {enabled: false}}})
    generate()
    expect(values.statusPage.catalog.components[0].endpoints).to.deep.equal(['https://rpc.example/'])
    values.statusPage.enabled = false
    expect(() => generate()).to.throw('before disabling')
  })

  it('rejects disabled public ingress, traversal and unconfigured hosts without partial mutation', () => {
    for (const configuration of [
      {ingress: {main: {enabled: false}}},
      {ingress: {main: ingress('rpc.scrollsdk')}},
      {ingress: {main: ingress('user:password@rpc.example')}},
    ]) {
      write('l2-reth-rpc-public-production.yaml', configuration)
      const before = structuredClone(values)
      expect(() => generate()).to.throw()
      expect(values).to.deep.equal(before)
    }

    values.statusPage.sources = {frontends: '../outside.yaml'}
    expect(() => generate()).to.throw('inside the values directory')
  })

  it('updates owned Secret references but rejects independent changes and inline API keys', () => {
    generate()
    values.statusPage.grafana.webhookSecretRef = {key: 'target', name: 'new-secret'}
    generate()
    expect(values.grafana.envValueFrom[ENV].secretKeyRef.name).to.equal('new-secret')
    values.grafana.alerting[FILE].contactPoints[0].name = 'edited-outside-generator'
    expect(() => generate()).to.throw('configured independently')
    values = {statusPage: {enabled: true, instatus: {apiKey: 'do-not-print'}}}
    expect(() => generate()).to.throw('INSTATUS_API_KEY')
  })

  it('keeps the applied page binding when regenerating', () => {
    generate()
    values.statusPage.generated.appliedPageId = 'page-1'
    values.statusPage.instatus.pageId = 'page-1'
    expect(generate()).to.deep.equal([])
    expect(values.statusPage.generated.appliedPageId).to.equal('page-1')
    values.statusPage.instatus.pageId = 'another-page'
    expect(() => generate()).to.throw('different Instatus page')
  })

  it('rejects a subdomain for a different environment before changing values', () => {
    values.statusPage.instatus = {subdomain: 'dogeos'}
    const before = structuredClone(values)
    expect(() => generate()).to.throw('subdomain does not match this environment')
    expect(values).to.deep.equal(before)
  })

  it('requires an explicit Grafana identity migration instead of leaving old receivers behind', () => {
    generate()
    values.statusPage.grafana.receiverUid = 'renamed'
    expect(() => generate()).to.throw('explicit removal of the old contact point')
  })

  for (const filename of ['scroll-monitor-production.yaml', 'scroll-monitor-production-0.yaml']) {
    it(`prep-charts generates ${filename} after the deployment source pass`, async () => {
      values.balanceMonitoring = {enabled: false}
      write(filename, values)
      const command: any = Object.create(PrepCharts.prototype)
      Object.assign(command, {
        configData: {
          contracts: {overrides: {L2_TX_FEE_VAULT: `0x${'11'.repeat(20)}`}},
          frontend: {EXTERNAL_EXPLORER_URI_L2: 'https://explorer.custom.example', GRAFANA_URI: 'https://grafana.example'},
          general: {CHAIN_ID_L2: 291, CHAIN_NAME_L2: 'DogeOS', L2_RPC_ENDPOINT: 'http://rpc:8545'},
          ingress: {BLOCKSCOUT_HOST: 'explorer.custom.example', FRONTEND_HOST: 'new-portal.example', GRAFANA_HOST: 'grafana.example', RPC_GATEWAY_HOST: 'rpc.custom.example', RPC_GATEWAY_WS_HOST: 'ws.custom.example'},
        },
        configMapping: {},
        contractsConfig: {},
        dogeConfig: {network: 'testnet'},
        jsonCtx: {addWarning() {}, info() {}, logSuccess() {}},
        jsonMode: false,
        log() {},
        nonInteractive: true,
      })
      await command.processProductionYaml(directory)
      const monitor: any = yaml.load(fs.readFileSync(path.join(directory, filename), 'utf8'))
      expect(monitor.statusPage.catalog.components[6].endpoints).to.deep.equal(['https://new-portal.example/bridge'])
      const first = fs.readFileSync(path.join(directory, filename), 'utf8')
      await command.processProductionYaml(directory)
      expect(fs.readFileSync(path.join(directory, filename), 'utf8')).to.equal(first)
    })
  }

  it('plans only GETs, preserves live outage status on update, and has no writes on the second apply', async () => {
    const fetcher = sinon.stub()
    fetcher.onCall(0).resolves(response([{id: 'page-1', name: catalog.pageName, subdomain: 'dogeos-testnet'}]))
    fetcher.onCall(1).resolves(response([remote]))
    fetcher.onCall(2).resolves(response({...remote, description: 'updated'}))
    const client = new InstatusClient('fixture-key', fetcher as any)
    const plan = await client.plan(catalog, target())
    expect(fetcher.getCalls().every(call => call.args[1]?.method === 'GET')).to.equal(true)
    const saveId = sinon.spy()
    await client.apply(plan, saveId, () => {})
    const request = fetcher.getCall(2).args
    expect(request[0]).to.equal('https://api.instatus.com/v2/page-1/components/rpc-1')
    expect(JSON.parse(request[1].body)).not.to.have.property('status')
    expect(JSON.parse(request[1].body)).not.to.have.property('archived')
    expect(request[1].redirect).to.equal('error')
    expect(saveId.calledWith('public-rpc', 'rpc-1')).to.equal(true)
    fetcher.onCall(3).resolves(response([{id: 'page-1', name: catalog.pageName, subdomain: 'dogeos-testnet'}]))
    fetcher.onCall(4).resolves(response([{...remote, ...plan.components[0].metadata}]))
    const second = await client.plan(catalog, target())
    expect(second.components[0].action).to.equal('unchanged')
    await client.apply(second, () => {}, () => {})
    expect(fetcher.callCount).to.equal(5)
  })

  it('rejects explicitly empty initialStatus before mutations and honors the creation-state override', async () => {
    const fetcher = sinon.stub()
    fetcher.onCall(0).resolves(response([]))
    fetcher.onCall(1).resolves(response({id: 'new-page'}))
    fetcher.onCall(2).resolves(response({id: 'new-rpc'}))
    const client = new InstatusClient('fixture-key', fetcher as any)
    const plan = await client.plan(catalog, {...target(), email: 'operator@example.com', initialStatus: '', pageId: '', subdomain: 'example-testnet'})
    let error = ''
    try { await client.apply(plan, () => {}, () => {}) } catch (error_) { error = String(error_) }
    expect(error).to.contain('initialStatus')
    expect(fetcher.callCount).to.equal(1)
    plan.initialStatus = 'UNDERMAINTENANCE'
    const order: string[] = []
    await client.apply(plan, (key, id) => order.push(`${key}:${id}`), id => order.push(id))
    expect(order).to.deep.equal(['new-page', 'public-rpc:new-rpc'])
    expect(JSON.parse(fetcher.getCall(1).args[1].body).components).to.deep.equal([])
    expect(fetcher.getCall(2).args[0]).to.equal('https://api.instatus.com/v1/new-page/components')
    expect(JSON.parse(fetcher.getCall(2).args[1].body).status).to.equal('UNDERMAINTENANCE')
  })

  it('handles pagination and never creates a duplicate after discovering an existing subdomain', async () => {
    const fetcher = sinon.stub()
    fetcher.onCall(0).resolves(response(Array.from({length: 100}, (_, i) => ({id: `other-${i}`, name: 'Other', subdomain: `other-${i}`}))))
    fetcher.onCall(1).resolves(response([{id: 'page-1', name: catalog.pageName, subdomain: 'example-testnet'}]))
    fetcher.onCall(2).resolves(response([remote]))
    const plan = await new InstatusClient('fixture-key', fetcher as any).plan(catalog, {...target(), pageId: '', subdomain: 'example-testnet'})
    expect(plan.page.id).to.equal('page-1')
    expect(plan.page.action).to.equal('unchanged')
    expect(plan.components[0].action).to.equal('update')
    expect(fetcher.getCall(1).args[0]).to.contain('page=2&per_page=100')
  })

  for (const status of [200, 403]) {
    it(`never creates a replacement for a known project when lookup is empty or forbidden (HTTP ${status})`, async () => {
      const fetcher = sinon.stub().resolves(response([], status))
      let error = ''
      try {
        await new InstatusClient('fixture-key', fetcher as any).plan(catalog, {...target(), subdomain: 'dogeos-testnet'})
      } catch (error_) { error = String(error_) }

      expect(error).not.to.equal('')
      expect(fetcher.callCount).to.equal(1)
      expect(fetcher.getCall(0).args[1].method).to.equal('GET')
    })
  }

  for (const kind of ['duplicate', 'missing-id', 'grouped', 'archived']) {
    it(`fails closed for ${kind} remote components`, async () => {
      const fetcher = sinon.stub()
      fetcher.onCall(0).resolves(response([{id: 'page-1', name: catalog.pageName, subdomain: 'dogeos-testnet'}]))
      fetcher.onCall(1).resolves(response(kind === 'duplicate' ? [remote, {...remote, id: 'rpc-2'}] : [{...remote, archived: kind === 'archived', group: kind === 'grouped' ? {id: 'g'} : null}]))
      let error = ''
      try {
        await new InstatusClient('fixture-key', fetcher as any).plan(catalog, {...target(), componentIds: kind === 'missing-id' ? {'public-rpc': 'gone'} : {}})
      } catch (error_) { error = String(error_) }

      expect(error).not.to.equal('')
      expect(fetcher.getCalls().every(call => call.args[1]?.method === 'GET')).to.equal(true)
    })
  }

  it('redacts provider failures and does not retry a possibly successful POST', async () => {
    const fetcher = sinon.stub().rejects(new Error('fixture-key echoed by transport'))
    const client = new InstatusClient('fixture-key', fetcher as any)
    let error = ''
    try {
      await client.apply({components: [{action: 'create', key: 'public-rpc', metadata: {description: '', name: 'RPC', order: 0, showUptime: false}}], initialStatus: 'OPERATIONAL', page: {action: 'unchanged', id: 'page-1', name: 'Page'}}, () => {}, () => {})
    } catch (error_) { error = String(error_) }

    expect(error).to.contain('rerun --plan').and.not.to.contain('fixture-key')
    expect(fetcher.callCount).to.equal(1)
  })

  const runCommand = async (flags: any) => {
    const command: any = Object.create(StatusPage.prototype)
    command.parse = async () => ({flags: {apply: false, config: 'config.toml', 'deployment-dir': directory, json: false, plan: false, values: 'scroll-monitor-production.yaml', ...flags}})
    return command.run()
  }

  const prepareCommand = () => {
    values.statusPage.instatus = target()
    write('scroll-monitor-production.yaml', values)
    fs.writeFileSync(path.join(directory, 'config.toml'), '[general]\nCHAIN_ID_L2=291\nCHAIN_NAME_L2="DogeOS"\n')
    sinon.stub(console, 'log')
    sinon.stub(console, 'error')
  }

  it('default command is entirely offline and a second generation leaves the file identical', async () => {
    prepareCommand()
    const fetcher = sinon.stub(globalThis, 'fetch').rejects(new Error('Network forbidden'))
    await runCommand({})
    const first = fs.readFileSync(path.join(directory, 'scroll-monitor-production.yaml'), 'utf8')
    await runCommand({})
    expect(fs.readFileSync(path.join(directory, 'scroll-monitor-production.yaml'), 'utf8')).to.equal(first)
    expect(fetcher.callCount).to.equal(0)
    expect((yaml.load(first) as any).statusPage.catalog.components).to.have.length(8)
  })

  it('--plan makes only GETs and leaves the local input unchanged', async () => {
    prepareCommand()
    const before = fs.readFileSync(path.join(directory, 'scroll-monitor-production.yaml'), 'utf8')
    const fetcher = sinon.stub(globalThis, 'fetch')
    fetcher.onCall(0).resolves(response([{id: 'page-1', name: catalog.pageName, subdomain: 'dogeos-testnet'}]))
    fetcher.onCall(1).resolves(response([]))
    const previousKey = process.env.INSTATUS_API_KEY
    process.env.INSTATUS_API_KEY = 'fixture-key'
    try { await runCommand({plan: true}) } finally {
      if (previousKey === undefined) delete process.env.INSTATUS_API_KEY
      else process.env.INSTATUS_API_KEY = previousKey
    }

    expect(fs.readFileSync(path.join(directory, 'scroll-monitor-production.yaml'), 'utf8')).to.equal(before)
    expect(fetcher.getCalls().every(call => call.args[1]?.method === 'GET')).to.equal(true)
  })

  it('--apply persists component IDs and page binding without persisting the API key', async () => {
    prepareCommand()
    const fetcher = sinon.stub(globalThis, 'fetch')
    fetcher.onCall(0).resolves(response([{id: 'page-1', name: 'DogeOS Testnet Status', subdomain: 'dogeos-testnet'}]))
    fetcher.onCall(1).resolves(response([]))
    for (let index = 0; index < 8; index++) fetcher.onCall(index + 2).resolves(response({id: `new-${index}`}))
    const previousKey = process.env.INSTATUS_API_KEY
    process.env.INSTATUS_API_KEY = 'fixture-key'
    try { await runCommand({apply: true}) } finally {
      if (previousKey === undefined) delete process.env.INSTATUS_API_KEY
      else process.env.INSTATUS_API_KEY = previousKey
    }

    const content = fs.readFileSync(path.join(directory, 'scroll-monitor-production.yaml'), 'utf8')
    const applied: any = yaml.load(content)
    expect(Object.keys(applied.statusPage.instatus.componentIds)).to.have.length(8)
    expect(applied.statusPage.generated.appliedPageId).to.equal('page-1')
    expect(content).not.to.contain('fixture-key')
    expect(fetcher.getCalls().filter(call => call.args[1]?.method === 'POST')).to.have.length(8)
    await runCommand({})
    expect(fs.readFileSync(path.join(directory, 'scroll-monitor-production.yaml'), 'utf8')).to.equal(content)
  })

  for (const lostResponse of [false, true]) {
    it(`bootstraps one webhook and never retries an ambiguous create (lost response: ${lostResponse})`, async () => {
      prepareCommand()
      const components: any[] = []
      const webhookUrl = 'https://api.instatus.com/v3/integrations/grafana/private-webhook-fixture'
      let webhookPosts = 0
      const fetcher = sinon.stub(globalThis, 'fetch').callsFake(async (url, init) => {
        const route = new URL(String(url)).pathname
        if (init?.method === 'GET' && route === '/v2/pages') return response([{id: 'page-1', name: 'DogeOS Testnet Status', subdomain: 'dogeos-testnet'}])
        if (init?.method === 'GET' && route === '/v2/page-1/components') return response(components)
        if (init?.method === 'POST' && route === '/v1/page-1/components') {
          const component = {...JSON.parse(String(init.body)), id: `component-${components.length}`}
          components.push(component)
          return response(component)
        }

        if (init?.method === 'POST' && route === '/v3/integrations') {
          webhookPosts++
          expect(JSON.parse(String(init.body)).components).to.deep.equal([])
          if (lostResponse) throw new Error(webhookUrl)
          return response({integration: {id: 'private-webhook-fixture', monitoringTool: 'GRAFANA', siteId: 'page-1', uniqueUrl: webhookUrl}})
        }

        throw new Error(`Unexpected ${init?.method} ${route}`)
      })
      const previousKey = process.env.INSTATUS_API_KEY
      process.env.INSTATUS_API_KEY = 'fixture-key'
      try {
        const before = fs.readFileSync(path.join(directory, 'scroll-monitor-production.yaml'), 'utf8')
        await runCommand({'create-webhook': true, json: true, plan: true})
        expect(fs.readFileSync(path.join(directory, 'scroll-monitor-production.yaml'), 'utf8')).to.equal(before)
        expect(fs.existsSync(path.join(directory, 'secrets'))).to.equal(false)
        expect(fetcher.getCalls().every(call => call.args[1]?.method === 'GET')).to.equal(true)
        let error = ''
        try { await runCommand({apply: true, 'create-webhook': true, json: true}) } catch (error_) { error = String(error_) }
        expect(Boolean(error)).to.equal(lostResponse)
        if (lostResponse) {
          let retryError = ''
          try { await runCommand({apply: true, 'create-webhook': true}) } catch (error_) { retryError = String(error_) }
          expect(retryError).not.to.equal('')
        } else {
          await runCommand({apply: true, 'create-webhook': true, json: true})
          write('scroll-monitor-production.yaml', values) // Regenerate from original inputs.
          await runCommand({apply: true, json: true})
          expect(JSON.parse(fs.readFileSync(path.join(directory, 'secrets/status-page/grafana.secret.yaml'), 'utf8')).data.url).to.equal(Buffer.from(webhookUrl).toString('base64'))
          fs.rmSync(path.join(directory, 'secrets'), {recursive: true})
          let missingError = ''
          try { await runCommand({apply: true, 'create-webhook': true}) } catch (error_) { missingError = String(error_) }
          expect(missingError).not.to.equal('')
        }

        expect(webhookPosts).to.equal(1)
        expect(fs.existsSync(path.join(directory, '.data/status-page-apply.lock'))).to.equal(false)
        const yamlText = fs.readFileSync(path.join(directory, 'scroll-monitor-production.yaml'), 'utf8')
        expect(yamlText).not.to.contain('private-webhook-fixture')
        expect(yamlText).not.to.contain('fixture-key')
        const output = [...(console.log as sinon.SinonStub).args, ...(console.error as sinon.SinonStub).args].flat().join('\n')
        expect(output).not.to.contain('private-webhook-fixture')
        expect(output).not.to.contain('fixture-key')
      } finally {
        if (previousKey === undefined) delete process.env.INSTATUS_API_KEY
        else process.env.INSTATUS_API_KEY = previousKey
      }
    })
  }

  for (const loseCreationResponse of [false, true]) {
    it(`reuses one project after resetting values and redeploying (lost creation response: ${loseCreationResponse})`, async () => {
      prepareCommand()
      values.statusPage.instatus = {...target(), email: 'operator@example.com', pageId: ''}
      write('scroll-monitor-production.yaml', values)
      let page: any
      const components: any[] = []
      let pagePosts = 0
      sinon.stub(globalThis, 'fetch').callsFake(async (url, init) => {
        const route = new URL(String(url)).pathname
        if (init?.method === 'GET' && route === '/v2/pages') return response(page ? [page] : [])
        if (init?.method === 'GET' && route === '/v2/created-page/components') return response(components)
        const body = JSON.parse(String(init?.body))
        if (init?.method === 'POST' && route === '/v1/pages') {
          pagePosts++
          page = {...body, id: 'created-page'}
          if (loseCreationResponse && pagePosts === 1) throw new Error('Connection lost after the provider created the page')
          return response(page)
        }

        if (init?.method === 'POST' && route === '/v1/created-page/components') {
          const component = {...body, id: `component-${components.length}`}
          components.push(component)
          return response(component)
        }

        throw new Error(`Unexpected request ${init?.method} ${route}`)
      })
      const previousKey = process.env.INSTATUS_API_KEY
      process.env.INSTATUS_API_KEY = 'fixture-key'
      try {
        let error = ''
        try { await runCommand({apply: true}) } catch (error_) { error = String(error_) }
        expect(Boolean(error)).to.equal(loseCreationResponse)
        expect(fs.existsSync(path.join(directory, '.data/status-page-apply.lock'))).to.equal(false)
        // Simulate chart values being regenerated from the original template.
        write('scroll-monitor-production.yaml', values)
        await runCommand({})
        await runCommand({apply: true})
        write('scroll-monitor-production.yaml', values)
        await runCommand({apply: true})
        // A fresh checkout can also recover by the fixed environment subdomain.
        fs.unlinkSync(path.join(directory, '.data/status-page-state.json'))
        write('scroll-monitor-production.yaml', values)
        await runCommand({apply: true})
      } finally {
        if (previousKey === undefined) delete process.env.INSTATUS_API_KEY
        else process.env.INSTATUS_API_KEY = previousKey
      }

      expect(pagePosts).to.equal(1)
      expect(page.subdomain).to.equal('dogeos-testnet')
      expect(components).to.have.length(8)
      const state = fs.readFileSync(path.join(directory, '.data/status-page-state.json'), 'utf8')
      expect(JSON.parse(state).bindings.testnet).to.deep.equal({pageId: 'created-page', subdomain: 'dogeos-testnet'})
      expect(state).not.to.contain('fixture-key')
    })
  }
})
