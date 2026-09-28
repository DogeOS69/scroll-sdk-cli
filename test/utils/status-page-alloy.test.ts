/* eslint-disable @typescript-eslint/no-explicit-any -- Helm and Prometheus fixtures. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {alloyHealth, alloyHeartbeat} from '../../src/utils/status-page-alloy.js'
import {normalizeHealth} from '../../src/utils/status-page-health.js'
import {reconcileScrollMonitorStatusPage} from '../../src/utils/status-page-values.js'

describe('existing Alloy public-entrypoint probes', () => {
  let directory: string
  let values: any
  const generate = () => reconcileScrollMonitorStatusPage(values, {chainId: 291, environment: 'testnet', networkName: 'DogeOS', valuesDir: directory})
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'status-alloy-'))
    const ingress = {main: {hosts: [{host: 'service.example', paths: [{path: '/'}]}]}}
    for (const name of ['frontends-production.yaml', 'l2-reth-rpc-public-production.yaml']) fs.writeFileSync(path.join(directory, name), yaml.dump({ingress}))
    fs.writeFileSync(path.join(directory, 'frontends-config.yaml'), yaml.dump({scrollConfig: 'REACT_APP_CHAIN_ID_L2 = "291"\nREACT_APP_BRIDGE_API_URI = "https://history.example/api"\n'}))
    fs.writeFileSync(path.join(directory, 'blockscout-production.yaml'), yaml.dump({'blockscout-stack': {frontend: {ingress: {hostname: 'explorer.example'}}}}))
    values = {statusPage: {enabled: true, publication: {components: Object.fromEntries(['public-rpc', 'bridge-portal', 'block-explorer', 'sequencing'].map(k => [k, {mode: 'observe', rule: {builtin: true}}])), probes: {explorerApiUrls: ['https://explorer-api.example/api/v2/stats'], mode: 'alloy'}}, sources: {frontendsConfig: 'frontends-config.yaml'}}}
  })
  afterEach(() => fs.rmSync(directory, {force: true, recursive: true}))

  it('checks Blockscout JSON stats when discovery provides an API base URL', () => {
    values.statusPage.publication.probes.explorerApiUrls = ['https://explorer-api.example/']
    generate()
    const target = values.statusPage.generated.alloyProbes.targets.find((t: any) => t.check_id.startsWith('block-explorer-api'))
    expect(target.address).to.equal('https://explorer-api.example/api/v2/stats')
  })

  it('generates public targets without another workload, distinguishes coverage and survives YAML round trips', () => {
    generate()
    const {catalog, generated} = values.statusPage
    expect(generated.alloyProbes.targets).to.have.length(6)
    expect(generated.componentPublication.readiness['public-rpc'].coverage).to.equal('public-entrypoint')
    expect(generated.componentPublication.readiness.sequencing.ready).to.equal(false)
    expect(catalog.components.find((c: any) => c.key === 'block-explorer').description).not.to.contain('indexing freshness')
    expect(generated.componentPublication.probeScrape).to.equal(undefined)
    expect(generate()).to.deep.equal([])
    values = yaml.load(yaml.dump(values))
    expect(generate()).to.deep.equal([])
    const before = generated.alloyProbes.revision
    values.statusPage.publication.probes.alloyChecks = [{bodyRegex: ['healthy'], component: 'bridge-portal', url: 'https://history.example/health'}]
    generate()
    expect(values.statusPage.generated.alloyProbes.revision).not.to.equal(before)
    expect(values.statusPage.generated.alloyProbes.targets).to.have.length(7)
  })

  it('requires an external heartbeat before automatic publication and fails closed on uncovered WebSockets', () => {
    values.statusPage.publication.components['public-rpc'].mode = 'automatic'
    expect(generate).to.throw('heartbeat')
    values.statusPage.publication.heartbeat = {alertIds: ['ops'], enabled: true}
    generate()
    const heartbeat = values.statusPage.generated.componentPublication.provisioning.groups[0].rules.find((r: any) => r.uid === 'status-monitoring-heartbeat')
    expect(heartbeat.data[0].model.expr).to.contain('probe_success')
    const rpc = path.join(directory, 'l2-reth-rpc-public-production.yaml')
    const source: any = yaml.load(fs.readFileSync(rpc, 'utf8'))
    source.ingress.websocket = {enabled: true, hosts: [{host: 'ws.example', paths: [{path: '/'}]}]}
    fs.writeFileSync(rpc, yaml.dump(source))
    expect(generate).to.throw('health expression')
  })

  it('rejects private URLs, credentials, external scrape targets and unsupported semantic overrides', () => {
    for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://svc.namespace.svc/', 'https://u:p@example.com/', 'https://example.com/?token=secret']) {
      values.statusPage.publication.probes.explorerApiUrls = [url]
      expect(generate).to.throw()
    }

    values.statusPage.publication.probes.explorerApiUrls = ['https://api.example/']
    values.statusPage.publication.probes.metricsTargets = ['private.example:9111']
    expect(generate).to.throw('remote-write')
    values.statusPage.publication.probes.metricsTargets = []
    values.statusPage.publication.probes.bridgeChecks = [{equals: true, path: ['ok'], url: 'https://api.example/'}]
    expect(generate).to.throw('JSON-path')
  })

  ;(process.env.SCROLL_STATUS_CHART ? it : it.skip)('renders into the existing Alloy with OTLP disabled and rejects drift/duplicate observers', () => {
    generate()
    values.alloy = {logs: {enabled: false}, metrics: {otlp: {enabled: false}}}
    const filename = path.join(directory, 'values.yaml')
    const render = () => {
      fs.writeFileSync(filename, yaml.dump(values))
      return execFileSync('helm', ['template', 'scroll-monitor', process.env.SCROLL_STATUS_CHART!, '-f', filename], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: 'pipe'})
    }

    const documents = yaml.loadAll(render()) as any[]
    const alloy = documents.find(d => d?.kind === 'ConfigMap' && d.metadata.name === 'grafana-alloy-config').data['config.alloy']
    expect(alloy).to.contain('prometheus.exporter.blackbox "status_page"')
    expect(alloy).to.contain('prometheus.remote_write "scroll"')
    expect(alloy).not.to.contain('otelcol.receiver.otlp')
    expect(documents.filter(d => ['DaemonSet', 'Deployment', 'StatefulSet'].includes(d?.kind)).some(d => /probe/.test(d.metadata.name))).to.equal(false)
    if (process.env.SCROLL_STATUS_RUNTIME_TEST === '1') {
      fs.writeFileSync(path.join(directory, 'config.alloy'), alloy)
      fs.writeFileSync(path.join(directory, 'probes.json'), JSON.stringify(values.statusPage.generated.alloyProbes))
      execFileSync('python3', [path.join(process.env.SCROLL_STATUS_CHART!, 'tests/check_status_page_alloy_runtime.py'), directory], {stdio: 'pipe', timeout: 120_000})
    }

    values.alloy.controller = {replicas: 2}
    expect(render).to.throw('Alloy')
    values.alloy.controller.replicas = 1
    values.statusPage.generated.alloyProbes.targets[0].address = 'https://changed.example'
    expect(render).to.throw('regenerated CLI')
  }).timeout(180_000)

  ;(process.env.SCROLL_STATUS_RUNTIME_TEST === '1' ? it : it.skip)('evaluates complete, failed, missing, duplicate and stale evidence in Prometheus', () => {
    generate()
    const {alloyProbes: config} = values.statusPage.generated
    const health = normalizeHealth()
    const expr = alloyHealth('public-rpc', config, health)
    const tests: any[] = []
    const series = (): Record<string, string> => Object.fromEntries(config.targets.flatMap((t: any) => {
      const labels = `{job="status-page-alloy",environment="testnet",chain_id="291",component_key="${t.component_key}",check_id="${t.check_id}",status_probe_config="${config.revision}"}`
      return [[`probe_success${labels}`, '1x10'], [`probe_duration_seconds${labels}`, '0.1x10'], [`up${labels}`, '1x10']]
    }))
    const scenario = (s: any, expected: null | number, heartbeat: null | number = 1) => tests.push({input_series: Object.entries(s).map(([series, values]) => ({series, values})), interval: '30s',
      promql_expr_test: [{eval_time: '5m', exp_samples: expected === null ? [] : [{labels: '{}', value: expected}], expr},
        {eval_time: '5m', exp_samples: heartbeat === null ? [] : [{labels: '{}', value: heartbeat}], expr: alloyHeartbeat(config, health)}]})
    scenario(series(), 0)
    const mutate = (metric: string, value?: string, match = 'public-rpc') => {
      const s = series()
      const key = Object.keys(s).find(k => k.startsWith(metric) && k.includes(match))!
      if (value === undefined) delete s[key]
      else s[key] = value
      return s
    }

    scenario(mutate('probe_success', '0x10'), 1) // HTTP failures do not stop the heartbeat.
    scenario(mutate('probe_duration_seconds', '3x10'), 1)
    scenario(mutate('probe_success'), null, null)
    scenario(mutate('probe_success', Array.from({length: 11}).fill('NaN').join(' ')), null, null)
    scenario(mutate('probe_success', '2x10'), null, null)
    scenario(mutate('up', '0x10'), null, null)
    scenario(mutate('probe_success', '1x4 _x6'), null, null)
    scenario(mutate('probe_success', 'stale'), null, null)
    const duplicate = series()
    const key = Object.keys(duplicate).find(k => k.startsWith('probe_success') && k.includes('public-rpc'))!
    duplicate[key.replace('}', ',instance="duplicate"}')] = '1x10'
    scenario(duplicate, null, null)
    scenario({}, null, null)
    const oldRevision = Object.fromEntries(Object.entries(series()).map(([k, v]) => [k.replace(config.revision, 'old'), v]))
    scenario(oldRevision, null, null)
    fs.writeFileSync(path.join(directory, 'rules.yaml'), yaml.dump({evaluation_interval: '30s', tests}))
    execFileSync('docker', ['run', '--rm', '--user', String(process.getuid?.() ?? 1000), '--entrypoint', 'promtool', '-v', `${directory}:/fixtures:ro`, 'prom/prometheus:v2.52.0', 'test', 'rules', '/fixtures/rules.yaml'], {stdio: 'pipe', timeout: 120_000})
  }).timeout(180_000)
})
