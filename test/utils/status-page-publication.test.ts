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

describe('independent component publication', () => {
  let directory: string
  let values: any
  const generate = () => reconcileScrollMonitorStatusPage(values, {chainId: 291, environment: 'testnet', networkName: 'DogeOS', valuesDir: directory})
  const file = () => values.grafana.alerting[PUBLICATION_FILE]
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'status-publication-'))
    const ingress = {main: {enabled: true, hosts: [{host: 'service.example', paths: [{path: '/'}]}]}}
    for (const name of ['frontends-production.yaml', 'l2-reth-rpc-public-production.yaml']) fs.writeFileSync(path.join(directory, name), yaml.dump({ingress}))
    fs.writeFileSync(path.join(directory, 'blockscout-production.yaml'), yaml.dump({'blockscout-stack': {frontend: {ingress: {enabled: true, hostname: 'explorer.example'}}}}))
    values = {grafana: {alerting: {'policies.yaml': {policies: [{receiver: 'internal'}]}}}, statusPage: {enabled: true, environment: 'testnet', instatus: {pageId: 'page-1'}, publication: {components: {}}}}
  })
  afterEach(() => { sinon.restore(); fs.rmSync(directory, {force: true, recursive: true}) })

  it('defaults all eight components to observe without requiring secrets or inventing healthy rules', () => {
    generate()
    expect(Object.keys(values.statusPage.publication.components)).to.deep.equal([...COMPONENT_KEYS])
    expect(file().contactPoints).to.deep.equal([])
    expect(file().groups[0].rules).to.deep.equal([])
    expect(values.grafana.envValueFrom).to.deep.equal({})
    expect(Object.values(values.statusPage.generated.componentPublication.readiness).every((item: any) => item.mode === 'observe' && item.reason === 'missing-health-expression' && !item.ready)).to.equal(true)
    expect(generate()).to.deep.equal([])
  })

  it('routes only the selected component publicly, keeps unknown observations internal and preserves policy ownership', () => {
    values.statusPage.publication.components = {'batch-publication': {mode: 'automatic', rule: {expr: 'fixture_component_health{network="testnet"}', for: '5m'}}, 'public-rpc': {mode: 'observe', rule: {expr: 'fixture_rpc_health'}}}
    generate()
    expect(file().contactPoints.map((point: any) => point.name)).to.deep.equal(['instatus-batch-publication'])
    const {rules} = file().groups[0]
    expect(rules.find((r: any) => r.uid === 'status-batch-publication').notification_settings.receiver).to.equal('instatus-batch-publication')
    expect(rules.filter((r: any) => r.notification_settings.receiver === 'instatus-batch-publication')).to.have.length(1)
    expect(rules.find((r: any) => r.uid === 'status-public-rpc').notification_settings.receiver).to.equal('grafana-default-email')
    expect(rules.find((r: any) => r.uid === 'status-batch-publication').noDataState).to.equal('KeepLast')
    expect(rules.find((r: any) => r.uid === 'status-batch-publication').data[0].model.expr).to.contain('count(')
    expect(file().contactPoints[0].receivers[0].disableResolveMessage).to.equal(true)
    expect(values.grafana.alerting['policies.yaml']).to.deep.equal({policies: [{receiver: 'internal'}]})
    expect(generate()).to.deep.equal([])
  })

  it('generates guarded delivery, explicit incident policy and a failure-sensitive heartbeat', () => {
    values.statusPage.publication = {components: {'public-rpc': {mode: 'automatic', rule: {builtin: true}}}, delivery: {enabled: true},
      health: {recoveryFor: '12m'}, heartbeat: {alertIds: ['internal-ops'], enabled: true},
      incidents: {manageTemplates: true}}
    generate()
    expect(values.grafana.envValueFrom.INSTATUS_PUBLIC_RPC_WEBHOOK_URL).to.equal(undefined)
    expect(values.grafana.envValueFrom.INSTATUS_MONITORING_HEARTBEAT_URL.secretKeyRef.name).to.equal('instatus-monitoring-heartbeat')
    expect(values.statusPage.generated.delivery.components['public-rpc'].recoverySeconds).to.equal(720)
    expect(file().contactPoints[0].receivers[0].settings.url).to.contain('-status-delivery')
    const heartbeat = file().groups[0].rules.find((rule: any) => rule.uid === 'status-monitoring-heartbeat')
    expect(heartbeat.noDataState).to.equal('OK')
    expect(heartbeat.execErrState).to.equal('OK')
    expect(generate()).to.deep.equal([])
    values.statusPage.publication.components['public-rpc'].mode = 'manual'
    values.statusPage.publication.heartbeat.enabled = false
    generate()
    expect(file().groups[0].rules.filter((rule: any) => ['status-delivery-health','status-monitoring-heartbeat'].includes(rule.uid)).every((rule: any) => rule.isPaused)).to.equal(true)
    expect(values.statusPage.generated.delivery.components).to.deep.equal({})
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
    values.statusPage.publication.components['public-rpc'].mode = 'automatic'
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
    expect(provision.data[PUBLICATION_FILE]).to.contain('http://scroll-monitor-status-delivery:9110/notify/public-rpc')
    if (process.env.SCROLL_STATUS_GRAFANA_TEST === '1') execFileSync('python3', [path.join(chart, 'tests/status_page_grafana_runtime.py'), filename], {stdio: 'pipe', timeout: 120_000})
    values.statusPage.generated.delivery.components['public-rpc'].expr = 'vector(0)'
    expect(render).to.throw('regenerated CLI configuration')
  }).timeout(180_000)

  it('changes automatic to observe or manual without deleting receivers, and pauses missing rules', () => {
    values.statusPage.publication.components = {deposits: {mode: 'automatic', rule: {expr: 'fixture_deposit_health'}}}
    generate()
    const identity = componentIdentity('deposits')
    values.statusPage.publication.components.deposits.mode = 'observe'
    generate()
    expect(file().contactPoints[0].name).to.equal(identity.contactPointName)
    expect(file().groups[0].rules[0].notification_settings.receiver).to.equal('grafana-default-email')
    values.statusPage.publication.components.deposits = {mode: 'manual'}
    generate()
    expect(file().groups[0].rules.every((r: any) => r.isPaused)).to.equal(true)
    expect(generate()).to.deep.equal([])
  })

  it('rejects invalid activation, unknown components, conflicts and binding changes without partial mutation', () => {
    for (const publication of [
      {components: {deposits: {mode: 'automatic'}}},
      {components: {typo: {mode: 'observe'}}},
      {components: {deposits: {mode: 'typo'}}},
      {components: {}, observationContactPointName: 'instatus-public'},
    ]) {
      values.statusPage.publication = publication
      const before = structuredClone(values)
      expect(() => generate()).to.throw()
      expect(values).to.deep.equal(before)
    }

    values.statusPage.publication = {components: {deposits: {mode: 'observe', rule: {expr: 'fixture'}}}}
    generate()
    values.statusPage.generated.componentBindings = {deposits: {componentId: 'wrong', pageId: 'another'}}
    expect(() => generate()).to.throw('different page or component')
    delete values.statusPage.generated.componentBindings
    file().groups[0].rules[0].notification_settings.receiver = 'edited'
    expect(() => generate()).to.throw('configured independently')
  })

  ;(process.env.SCROLL_STATUS_RUNTIME_TEST === '1' ? it : it.skip)('evaluates healthy, affected, absent, non-binary and duplicate observations with Prometheus', () => {
    values.statusPage.publication.components = {deposits: {mode: 'observe', rule: {expr: 'fixture_health'}}}
    generate()
    const expression = file().groups[0].rules[0].data[0].model.expr
    const tests = [
      {expected: [{labels: '{}', value: 0}], input_series: [{series: 'fixture_health{instance="a"}', values: '0'}]},
      {expected: [{labels: '{}', value: 1}], input_series: [{series: 'fixture_health{instance="a"}', values: '1'}]},
      {expected: [], input_series: []},
      {expected: [], input_series: [{series: 'fixture_health', values: '2'}]},
      {expected: [], input_series: [{series: 'fixture_health', values: 'NaN'}]},
      {expected: [], input_series: [{series: 'fixture_health{instance="a"}', values: '0'}, {series: 'fixture_health{instance="b"}', values: '1'}]},
    ].map(({expected, input_series}) => ({input_series, interval: '1m', promql_expr_test: [{eval_time: '0m', exp_samples: expected, expr: expression}]}))
    fs.writeFileSync(path.join(directory, 'queries.yaml'), yaml.dump({evaluation_interval: '1m', tests}))
    execFileSync('docker', ['run', '--rm', '--user', String(process.getuid?.() ?? 1000), '--entrypoint', 'promtool', '-v', `${directory}:/fixtures:ro`, 'prom/prometheus:v2.52.0', 'test', 'rules', '/fixtures/queries.yaml'], {stdio: 'pipe'})
  })

  it('imports an explicit integration ID without guessing from the URL and rejects shared credentials', async () => {
    const input = path.join(directory, 'private-import.json')
    fs.writeFileSync(input, JSON.stringify({integrationId: 'management-id-distinct-from-url', url: webhookUrl('url-token')}), {mode: 0o600})
    const webhook = new StatusPageWebhook(directory, 'testnet', 'public-rpc')
    const plan = webhook.plan('page-1', false, false, input, 'rpc-id')
    const transport = sinon.stub().resolves(new Response('{}'))
    const client = new InstatusClient('fake-key', transport)
    webhook.prepare()
    await webhook.apply(plan, client, 'page-1', componentIdentity('public-rpc').secret, 'rpc-id')
    expect(transport.firstCall.args[0]).to.equal('https://api.instatus.com/v3/integrations/management-id-distinct-from-url')
    expect(JSON.parse(transport.firstCall.args[1].body).components).to.deep.equal(['rpc-id'])
    const other = new StatusPageWebhook(directory, 'testnet', 'deposits')
    expect(() => other.plan('page-1', false, false, input, 'deposit-id')).to.throw('already bound')
    fs.writeFileSync(input, webhookUrl('url-token'))
    expect(() => other.plan('page-1', false, false, input, 'deposit-id')).to.throw('private JSON')
  })

  it('uses one private journal and one remote component per integration and reuses both after restart', async () => {
    const transport = sinon.stub().callsFake(async (_url: string, init: any) => {
      const request = JSON.parse(init.body)
      if (init.method === 'PUT') return new Response('{}')
      const id = request.components[0]
      return new Response(JSON.stringify({integration: {id: `private-${id}`, monitoringTool: 'GRAFANA', siteId: 'page-1', uniqueUrl: webhookUrl(id)}}))
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
      const binding = JSON.parse(transport.lastCall.args[1].body)
      expect(binding.createTemplate.components).to.deep.equal([{id: key, status: 'DEGRADEDPERFORMANCE'}])
      expect(binding.resolveTemplate.notify).to.equal(false)
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
