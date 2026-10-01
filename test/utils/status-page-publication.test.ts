/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic values and mocked provider contracts. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import sinon from 'sinon'

import {InstatusClient} from '../../src/utils/status-page-instatus.js'
import {COMPONENT_KEYS, PUBLICATION_FILE, componentIdentity} from '../../src/utils/status-page-publication.js'
import {reconcileScrollMonitorStatusPage} from '../../src/utils/status-page-values.js'
import {StatusPageWebhook} from '../../src/utils/status-page-webhook.js'

const webhookUrl = (key: string) => `https://api.instatus.com/v3/integrations/grafana/private-${key}`

const observeComponents = () => Object.fromEntries(COMPONENT_KEYS.map(key => [key, {mode: 'observe', ...(['deposits', 'withdrawals'].includes(key) ? {affectedStatus: 'MAJOROUTAGE'} : {})}]))

describe('independent component publication', () => {
  let directory: string
  let values: any
  const generate = () => reconcileScrollMonitorStatusPage(values, {chainId: 291, environment: 'testnet', networkName: 'DogeOS', valuesDir: directory})
  const file = () => values.grafana.alerting[PUBLICATION_FILE]
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'status-publication-'))
    const ingress = {main: {enabled: true, hosts: [{host: 'service.example', paths: [{path: '/'}]}]}}
    for (const name of ['frontends-production.yaml', 'l2-reth-rpc-public-production.yaml']) fs.writeFileSync(path.join(directory, name), yaml.dump({ingress}))
    fs.writeFileSync(path.join(directory, 'frontends-config.yaml'), yaml.dump({scrollConfig: 'REACT_APP_CHAIN_ID_L2 = "291"\nREACT_APP_BRIDGE_API_URI = "https://history.example/api"\n'}))
    fs.writeFileSync(path.join(directory, 'l2-reth-sequencer-production.yaml'), yaml.dump({reth: {networkId: '291', sequencer: {allowEmptyBlocks: true, blockTimeMs: '3000', enabled: true}}, role: 'sequencer'}))
    fs.writeFileSync(path.join(directory, 'blockscout-production.yaml'), yaml.dump({'blockscout-stack': {frontend: {ingress: {enabled: true, hostname: 'explorer.example'}}}}))
    values = {grafana: {alerting: {'policies.yaml': {policies: [{receiver: 'internal'}]}}}, statusPage: {enabled: true, environment: 'testnet', instatus: {pageId: 'page-1'}, publication: {components: {...observeComponents(), }}}}
  })
  afterEach(() => { sinon.restore(); fs.rmSync(directory, {force: true, recursive: true}) })

  it('supports explicitly observing all components without secrets or invented healthy rules', () => {
    generate()
    expect(Object.keys(values.statusPage.publication.components)).to.deep.equal([...COMPONENT_KEYS])
    expect(file()).not.to.have.property('contactPoints')
    expect(file()).not.to.have.property('groups')
    expect(values.statusPage.generated.version).to.equal(3)
    expect(values.statusPage.generated.delivery.health).to.deep.equal({})
    expect(values.grafana.envValueFrom).to.deep.equal({})
    expect(Object.values(values.statusPage.generated.componentPublication.readiness).every((item: any) => item.mode === 'observe' && item.reason === 'missing-health-expression' && !item.ready)).to.equal(true)
    expect(generate()).to.deep.equal([])
  })

  it('defaults every omitted mode to automatic and rejects incomplete activation', () => {
    values.statusPage.publication.components = Object.fromEntries(COMPONENT_KEYS.map(key => [key, {rule: {expr: 'fixture_health'}}]))
    generate()
    expect(Object.values(values.statusPage.publication.components).every((item: any) => item.mode === 'automatic')).to.equal(true)
    expect(Object.keys(values.statusPage.generated.componentPublication.envs)).to.have.length(8)
    expect(Object.values(values.statusPage.generated.componentPublication.readiness).every((item: any) => item.reason === 'apply-component-webhook')).to.equal(true)
    expect(generate()).to.deep.equal([])
    values.statusPage.publication.components = {}
    expect(generate).to.throw('automatic publication requires a component health expression')
  })

  it('routes only the selected component publicly, keeps unknown observations internal and preserves policy ownership', () => {
    values.statusPage.publication.components = {...observeComponents(), 'batch-publication': {mode: 'automatic', rule: {expr: 'fixture_component_health{network="testnet"}', for: '5m'}}, 'public-rpc': {mode: 'observe', rule: {expr: 'fixture_rpc_health'}}}
    generate()
    expect(Object.keys(values.statusPage.generated.componentPublication.envs)).to.deep.equal(['INSTATUS_BATCH_PUBLICATION_WEBHOOK_URL'])
    expect(values.statusPage.generated.delivery.components['batch-publication'].rule).to.deep.equal({builtin: false, expr: 'fixture_component_health{network="testnet"}', for: '5m'})
    expect(values.statusPage.generated.delivery.components['public-rpc'].mode).to.equal('observe')
    expect(file().deleteRules.map((r: any) => r.uid)).to.include('status-batch-publication')
    expect(values.grafana.alerting['policies.yaml']).to.deep.equal({policies: [{receiver: 'internal'}]})
    expect(generate()).to.deep.equal([])
  })

  it('generates guarded delivery, explicit incident policy and a failure-sensitive heartbeat', () => {
    values.statusPage.publication = {components: {...observeComponents(), 'public-rpc': {affectedStatus: 'PARTIALOUTAGE', mode: 'automatic', rule: {builtin: true}}}, delivery: {enabled: true},
      health: {recoveryFor: '12m'}, heartbeat: {alertIds: ['internal-ops'], enabled: true},
      incidents: {manageTemplates: true}}
    generate()
    expect(values.grafana.envValueFrom.INSTATUS_PUBLIC_RPC_WEBHOOK_URL).to.equal(undefined)
    expect(values.grafana.envValueFrom.INSTATUS_MONITORING_HEARTBEAT_URL).to.equal(undefined)
    expect(values.statusPage.generated.componentPublication.envs.INSTATUS_MONITORING_HEARTBEAT_URL.secretKeyRef.name).to.equal('instatus-monitoring-heartbeat')
    expect(values.statusPage.generated.delivery.health).to.deep.equal({recoveryFor: '12m'})
    expect(values.statusPage.generated.delivery.heartbeatEnabled).to.equal(true)
    expect(generate()).to.deep.equal([])
    values.statusPage.publication.components['public-rpc'].mode = 'manual'
    values.statusPage.publication.heartbeat.enabled = false
    generate()
    expect(values.statusPage.generated.delivery.components['public-rpc'].mode).to.equal('manual')
    expect(values.statusPage.generated.delivery.heartbeatEnabled).to.equal(false)
  })

  it('requires reviewed per-component severity instead of implicitly treating failures as degraded performance', () => {
    values.statusPage.publication = {components: {...observeComponents(),
      'block-explorer': {affectedStatus: 'MAJOROUTAGE', mode: 'automatic', rule: {expr: 'fixture_explorer'}},
      'bridge-portal': {affectedStatus: 'PARTIALOUTAGE', mode: 'automatic', rule: {expr: 'fixture_bridge'}},
    }, incidents: {manageTemplates: true}}
    generate()
    expect(values.statusPage.publication.incidents).not.to.have.property('affectedStatus')
    expect(values.statusPage.publication.components['bridge-portal'].affectedStatus).to.equal('PARTIALOUTAGE')
    expect(values.statusPage.publication.components['block-explorer'].affectedStatus).to.equal('MAJOROUTAGE')
    expect(generate()).to.deep.equal([])
    delete values.statusPage.publication.components['bridge-portal'].affectedStatus
    const before = structuredClone(values)
    expect(generate).to.throw('explicit affectedStatus')
    expect(values).to.deep.equal(before)
    values.statusPage.publication.components['bridge-portal'].affectedStatus = 'OPERATIONAL'
    expect(generate).to.throw('invalid affectedStatus')
    values.statusPage.publication.incidents.affectedStatus = 'DEGRADEDPERFORMANCE'
    expect(generate).to.throw('global severity')
  })

  it('owns only the external probe scrape job and removes it when targets are disabled', () => {
    const unrelated = {job_name: 'existing', static_configs: [{targets: ['existing:9090']}]}
    values['kube-prometheus-stack'] = {prometheus: {prometheusSpec: {additionalScrapeConfigs: [unrelated]}}}
    values.statusPage.publication.probes = {metricsTargets: ['probe-b:9111', 'probe-a:9111', 'probe-a:9111']}
    generate()
    const jobs = () => values['kube-prometheus-stack'].prometheus.prometheusSpec.additionalScrapeConfigs
    expect(jobs()[0]).to.deep.equal(unrelated)
    expect(jobs()[1].static_configs[0].targets).to.deep.equal(['probe-a:9111','probe-b:9111'])
    expect(generate()).to.deep.equal([])
    jobs()[1].scrape_timeout = '1s'
    expect(() => generate()).to.throw('configured independently')
    jobs()[1].scrape_timeout = '10s'
    values.statusPage.publication.probes.metricsTargets = []
    generate()
    expect(jobs()).to.deep.equal([unrelated])
  })

  ;(process.env.SCROLL_STATUS_CHART ? it : it.skip)('renders generated production values with isolated delivery Secrets and rejects stale delivery', () => {
    const chart = path.resolve(process.env.SCROLL_STATUS_CHART!)
    values = yaml.load(fs.readFileSync(path.join(chart, '../../examples/values/scroll-monitor-production.yaml'), 'utf8'))
    values.statusPage.enabled = true
    values.statusPage.environment = 'testnet'
    values.statusPage.instatus.pageId = 'page-1'
    values.statusPage.instatus.componentIds = {'public-rpc': 'rpc-1'}
    for (const item of Object.values(values.statusPage.publication.components) as any[]) item.mode = 'observe'
    values.statusPage.publication.components['public-rpc'].mode = 'automatic'
    values.statusPage.publication.components['public-rpc'].affectedStatus = 'PARTIALOUTAGE'
    values.statusPage.publication.probes.mode = 'external'
    values.statusPage.publication.probes.metricsTargets = ['probe-a:9111', 'probe-b:9111']
    values.statusPage.generated = {componentBindings: {'public-rpc': {componentId: 'rpc-1', pageId: 'page-1'}}, environment: 'testnet'}
    generate()
    const filename = path.join(directory, 'monitor.yaml')
    const render = () => {
      fs.writeFileSync(filename, yaml.dump(values))
      return execFileSync('helm', ['template', 'scroll-monitor', chart, '--namespace', 'monitoring', '-f', filename], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: 'pipe'})
    }

    const documents: any[] = yaml.loadAll(render())
    const deployment = (name: string) => documents.find(d => d?.kind === 'Deployment' && d.metadata.name === name)
    const verifier = deployment('scroll-monitor-status-delivery')
    expect(verifier.spec.strategy.type).to.equal('Recreate')
    expect(verifier.spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.name).to.equal('instatus-public-rpc-webhook')
    expect(deployment('grafana').spec.template.spec.containers.find((c: any) => c.name === 'grafana').env.some((e: any) => e.name.startsWith('INSTATUS_'))).to.equal(false)
    const provision = documents.find(d => d?.kind === 'ConfigMap' && d.data?.[PUBLICATION_FILE])
    expect(provision.data[PUBLICATION_FILE]).to.contain('deleteRules:')
    expect(provision.data[PUBLICATION_FILE]).not.to.contain('/notify/')
    const runtime = JSON.parse(documents.find(d => d?.data?.['delivery.json']).data['delivery.json'])
    expect(runtime.sourceNamespace).to.equal('monitoring')
    expect(runtime.components['public-rpc'].rule).to.deep.equal({builtin: true})
    // Include container startup and cleanup in the budget, and retain diagnostics
    // when an opt-in runtime test fails (pipe output hid the original failure).

    values.statusPage.generated.delivery.components['public-rpc'].expr = 'vector(0)'
    expect(render).to.throw('regenerated CLI configuration')
  }).timeout(300_000)

  it('changes automatic to observe or manual without a Grafana publisher', () => {
    values.statusPage.publication.components = {...observeComponents(), deposits: {mode: 'automatic', rule: {expr: 'fixture_deposit_health'}}}
    generate()
    values.statusPage.publication.components.deposits.mode = 'observe'
    generate()
    expect(values.statusPage.generated.delivery.components.deposits.mode).to.equal('observe')
    expect(values.statusPage.generated.componentPublication.envs).to.deep.equal({})
    values.statusPage.publication.components.deposits = {mode: 'manual'}
    generate()
    expect(values.statusPage.generated.delivery.components.deposits.mode).to.equal('manual')
    expect(generate()).to.deep.equal([])
  })

  it('migrates exact old provisioning and secrets idempotently with Grafana disabled', () => {
    generate()
    const old = {apiVersion: 1, contactPoints: [{receivers: [{uid: 'instatus-deposits'}]}], groups: [{rules: [{uid: 'status-deposits'}]}]}
    values.statusPage.generated.version = 2
    values.statusPage.generated.componentPublication.provisioning = structuredClone(old)
    values.grafana.alerting[PUBLICATION_FILE] = structuredClone(old)
    const secret = {secretKeyRef: {key: 'url', name: 'instatus-deposits-webhook'}}
    values.statusPage.generated.componentPublication.envs = {INSTATUS_DEPOSITS_WEBHOOK_URL: secret}
    values.grafana.envValueFrom.INSTATUS_DEPOSITS_WEBHOOK_URL = secret
    values.grafana.enabled = false
    values.statusPage.publication.sourceNamespace = 'core-testnet'
    generate()
    expect(file().deleteRules.map((r: any) => r.uid)).to.include('status-deposits')
    expect(file().deleteContactPoints.map((r: any) => r.uid)).to.include('instatus-deposits')
    expect(values.grafana.envValueFrom).to.deep.equal({})
    expect(values.statusPage.generated.delivery.sourceNamespace).to.equal('core-testnet')
    expect(generate()).to.deep.equal([])
  })

  it('rejects invalid activation, unknown components, conflicts and binding changes without partial mutation', () => {
    for (const publication of [
      {components: {...observeComponents(), deposits: {mode: 'automatic'}}},
      {components: {...observeComponents(), typo: {mode: 'observe'}}},
      {components: {...observeComponents(), deposits: {mode: 'typo'}}},
      {components: {...observeComponents(), }, observationContactPointName: 'instatus-public'},
    ]) {
      values.statusPage.publication = publication
      const before = structuredClone(values)
      expect(() => generate()).to.throw()
      expect(values).to.deep.equal(before)
    }

    values.statusPage.publication = {components: {...observeComponents(), deposits: {mode: 'observe', rule: {expr: 'fixture'}}}}
    generate()
    values.statusPage.generated.componentBindings = {deposits: {componentId: 'wrong', pageId: 'another'}}
    expect(() => generate()).to.throw('different page or component')
    delete values.statusPage.generated.componentBindings
    file().deleteRules[0].uid = 'edited'
    expect(() => generate()).to.throw('configured independently')
  })

  it('imports an explicit integration ID without guessing from the URL and rejects shared credentials', async () => {
    const input = path.join(directory, 'private-import.json')
    fs.writeFileSync(input, JSON.stringify({createTemplateId: 'create-rpc', integrationId: 'management-id-distinct-from-url', resolveTemplateId: 'resolve-rpc', url: webhookUrl('url-token')}), {mode: 0o600})
    const webhook = new StatusPageWebhook(directory, 'testnet', 'public-rpc')
    const plan = webhook.plan('page-1', false, false, input, 'rpc-id')
    const transport = sinon.stub().callsFake(async (url: string) => new Response(JSON.stringify({components: [{componentId: 'rpc-id'}], id: url.split('/').at(-1), siteId: 'page-1', type: 'INCIDENT'})))
    const client = new InstatusClient('fake-key', transport)
    webhook.prepare()
    await webhook.apply(plan, client, 'page-1', componentIdentity('public-rpc').secret, 'rpc-id')
    expect(transport.firstCall.args[0]).to.equal('https://api.instatus.com/v1/page-1/templates/create-rpc')
    expect(transport.getCalls().every(call => call.args[1].method === 'GET')).to.equal(true)
    const other = new StatusPageWebhook(directory, 'testnet', 'deposits')
    expect(() => other.plan('page-1', false, false, input, 'deposit-id')).to.throw('already bound')
    fs.writeFileSync(input, webhookUrl('url-token'))
    expect(() => other.plan('page-1', false, false, input, 'deposit-id')).to.throw('private JSON')
  })

  it('blocks missing template IDs, cross-component templates and ignored notification policy', async () => {
    let wrongTarget = false
    const transport = sinon.stub().callsFake(async (url: string, init: any) => new Response(JSON.stringify(init.method === 'GET'
      ? {components: [{componentId: wrongTarget ? 'another-component' : 'rpc-id'}], id: url.split('/').at(-1), siteId: 'page-1', type: 'INCIDENT'}
      : {integration: {createTemplateId: 'create-id', id: 'integration', monitoringTool: 'GRAFANA', onFailNotifySubscribers: true, onRecoverNotifySubscribers: true, resolveTemplateId: 'resolve-id', siteId: 'page-1'}})))
    const client = new InstatusClient('fake-key', transport)
    const ids = {createTemplateId: 'create-id', resolveTemplateId: 'resolve-id'}
    const policy = {createTemplate: {components: [{id: 'rpc-id', status: 'DEGRADEDPERFORMANCE'}], name: 'Disrupted', notify: false, status: 'INVESTIGATING'}, resolveTemplate: {components: [{id: 'rpc-id', status: 'OPERATIONAL'}], name: 'Recovered', notify: false, status: 'RESOLVED'}}
    const rejects = async (run: () => Promise<void>, text: string) => {
      let error = ''
      try { await run() } catch (error_) { error = String(error_) }
      expect(error).to.contain(text)
    }

    await rejects(() => client.bindGrafanaWebhook('integration', 'page-1', 'rpc-id', policy), 'Restore createTemplateId')
    expect(transport.callCount).to.equal(0)
    wrongTarget = true
    await rejects(() => client.bindGrafanaWebhook('integration', 'page-1', 'rpc-id', policy, ids), 'targets differ')
    expect(transport.getCalls().every(call => call.args[1].method === 'GET')).to.equal(true)
    wrongTarget = false
    await rejects(() => client.bindGrafanaWebhook('integration', 'page-1', 'rpc-id', policy, ids), 'subscriber notification policy')
  })

  it('rejects a provider retaining English titles that hide the network', async () => {
    const templates = {
      createTemplate: {components: [{id: 'rpc-id', status: 'DEGRADEDPERFORMANCE'}], message: 'Testnet RPC is affected.', name: 'Testnet / Public RPC: service disruption', notify: false, status: 'INVESTIGATING'},
      resolveTemplate: {components: [{id: 'rpc-id', status: 'OPERATIONAL'}], message: 'Testnet RPC recovered.', name: 'Testnet / Public RPC: recovered', notify: false, status: 'RESOLVED'},
    }
    const transport = sinon.stub().callsFake(async (url: string, init: any) => {
      if (init.method === 'PUT') {
        const request = JSON.parse(init.body)
        return new Response(JSON.stringify({integration: {...request, createTemplateId: 'create-id', id: 'integration', monitoringTool: 'GRAFANA', resolveTemplateId: 'resolve-id', siteId: 'page-1'}}))
      }

      const id = url.split('/').at(-1)
      const desired = id === 'create-id' ? templates.createTemplate : templates.resolveTemplate
      return new Response(JSON.stringify({...desired, components: [{componentId: 'rpc-id', status: desired.components[0].status}], id, siteId: 'page-1', translations: {message: {en: desired.message}, name: {en: 'Public RPC outage'}}, type: 'INCIDENT'}))
    })
    let error = ''
    try {
      await new InstatusClient('fake-key', transport).bindGrafanaWebhook('integration', 'page-1', 'rpc-id', templates, {createTemplateId: 'create-id', resolveTemplateId: 'resolve-id'})
    } catch (error_) { error = String(error_) }

    expect(error).to.contain('including English translations')
  })

  it('uses one private journal and one remote component per integration and reuses both after restart', async () => {
    const stored: Record<string, any> = {}
    const transport = sinon.stub().callsFake(async (url: string, init: any) => {
      if (init.method === 'GET') return new Response(JSON.stringify(stored[url.split('/').at(-1)!]))
      const request = JSON.parse(init.body)
      const key = request.components[0]
      if (init.method === 'PUT') {
        for (const template of [request.createTemplate, request.resolveTemplate]) stored[template.id] = {...template, components: template.components.map((c: any) => ({...c, componentId: c.id})), message: template.message.default.value, name: template.name.default.value, siteId: 'page-1', translations: {message: {en: template.message.en.value}, name: {en: template.name.en.value}}}
        return new Response(JSON.stringify({integration: {automaticResolve: true, createTemplateId: `create-${key}`, id: `private-${key}`, isActive: true, monitoringTool: 'GRAFANA', onFailCreateIncident: true, onFailNotifySubscribers: request.onFailNotifySubscribers, onFailPublishIncident: true, onRecoverNotifySubscribers: request.onRecoverNotifySubscribers, onRecoverPublishIncident: true, onRecoverResolveIncident: true, resolveTemplateId: `resolve-${key}`, siteId: 'page-1'}}))
      }

      for (const prefix of ['create', 'resolve']) stored[`${prefix}-${key}`] = {components: [{componentId: key}], id: `${prefix}-${key}`, siteId: 'page-1', type: 'INCIDENT'}
      return new Response(JSON.stringify({integration: {createTemplateId: `create-${key}`, id: `private-${key}`, monitoringTool: 'GRAFANA', resolveTemplateId: `resolve-${key}`, siteId: 'page-1', uniqueUrl: webhookUrl(key)}}))
    })
    const client = new InstatusClient('fake-key', transport)
    for (const key of ['public-rpc', 'batch-publication'] as const) {
      const webhook = new StatusPageWebhook(directory, 'testnet', key)
      const plan = webhook.plan('page-1', true, false, undefined, key)
      webhook.prepare()
      await webhook.apply(plan, client, 'page-1', componentIdentity(key).secret, key, {
        createTemplate: {components: [{id: key, status: 'DEGRADEDPERFORMANCE'}], name: `Testnet / ${key}: service disruption`, notify: false, status: 'INVESTIGATING'},
        resolveTemplate: {components: [{id: key, status: 'OPERATIONAL'}], name: `Testnet / ${key}: recovered`, notify: false, status: 'RESOLVED'},
      })
      const binding = JSON.parse(transport.getCalls().filter(call => call.args[1].method === 'PUT').at(-1)!.args[1].body)
      expect(binding.createTemplate.components).to.deep.equal([{id: key, status: 'DEGRADEDPERFORMANCE'}])
      expect(binding.resolveTemplate.notify).to.equal(false)
      expect(binding.onFailNotifySubscribers).to.equal(false)
      expect(binding.onRecoverNotifySubscribers).to.equal(false)
      expect(binding.createTemplate.name.default.value).to.equal(`Testnet / ${key}: service disruption`)
      expect(binding.createTemplate.name.en.value).to.equal(`Testnet / ${key}: service disruption`)
      expect(binding.resolveTemplate.name.en.value).to.equal(`Testnet / ${key}: recovered`)
      expect(binding.createTemplate.id).to.equal(`create-${key}`)
      expect(binding.label).to.equal(`Testnet / ${key}: service disruption`)
      const restored = new StatusPageWebhook(directory, 'testnet', key)
      const reuse = restored.plan('page-1', true, true, undefined, key)
      expect(reuse.action).to.equal('reuse')
      await restored.apply(reuse, client, 'page-1', componentIdentity(key).secret, key)
      expect(() => restored.plan('page-1', true, true, undefined, 'different')).to.throw('different component')
      expect(path.basename(webhook.secretFile)).to.equal(`${key}.secret.yaml`)
      expect(fs.statSync(webhook.secretFile).mode % 0o1000).to.equal(0o600)
    }

    const posts = transport.getCalls().filter(call => call.args[1].method === 'POST')
    expect(posts).to.have.length(2)
    expect(posts.map(call => JSON.parse(call.args[1].body).components)).to.deep.equal([['public-rpc'], ['batch-publication']])
  })
})
