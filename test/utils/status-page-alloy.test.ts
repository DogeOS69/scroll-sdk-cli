/* eslint-disable @typescript-eslint/no-explicit-any -- Helm and Prometheus fixtures. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {COMPONENT_KEYS} from '../../src/utils/status-page-publication.js'
import {reconcileScrollMonitorStatusPage} from '../../src/utils/status-page-values.js'

const observeComponents = () => Object.fromEntries(COMPONENT_KEYS.map(key => [key, {mode: 'observe', ...(['deposits', 'withdrawals'].includes(key) ? {affectedStatus: 'MAJOROUTAGE'} : {})}]))

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
    values = {statusPage: {enabled: true, publication: {components: {...observeComponents(), ...Object.fromEntries(['public-rpc', 'bridge-portal', 'block-explorer', 'sequencing'].map(k => [k, {mode: 'observe', rule: {builtin: true}}]))}, probes: {explorerApiUrls: ['https://explorer-api.example/api/v2/stats'], mode: 'alloy'}}, sources: {frontendsConfig: 'frontends-config.yaml'}}}
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

  it('requires an external heartbeat before automatic publication and generates supplemental WebSocket checks', () => {
    values.statusPage.publication.components['public-rpc'].mode = 'automatic'
    expect(generate).to.throw('heartbeat')
    values.statusPage.publication.heartbeat = {alertIds: ['ops'], enabled: true}
    generate()
    expect(values.statusPage.generated.delivery.heartbeatEnabled).to.equal(true)
    const rpc = path.join(directory, 'l2-reth-rpc-public-production.yaml')
    const source: any = yaml.load(fs.readFileSync(rpc, 'utf8'))
    source.ingress.websocket = {enabled: true, hosts: [{host: 'ws.example', paths: [{path: '/'}]}]}
    fs.writeFileSync(rpc, yaml.dump(source))
    generate()
    expect(values.statusPage.generated.alloyProbes.websocketTargets).to.have.length(1)
    expect(values.alloy.controller.extraContainers[0].name).to.equal('status-websocket')
    expect(values.statusPage.generated.componentPublication.readiness['public-rpc'].ready).to.equal(false)
    expect(values.statusPage.generated.componentPublication.readiness['public-rpc'].reason).to.equal('apply-component-webhook')
    expect(generate()).to.deep.equal([])
    if (process.env.SCROLL_STATUS_CHART) {
      values.statusPage.publication.components['public-rpc'].mode = 'observe'
      generate()
      const filename = path.join(directory, 'ws-values.yaml')
      fs.writeFileSync(filename, yaml.dump(values))
      const rendered = execFileSync('helm', ['template', 'scroll-monitor', process.env.SCROLL_STATUS_CHART, '-f', filename], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024})
      expect(rendered).to.contain('name: status-websocket')
      expect(rendered).to.contain('prometheus.scrape "status_websocket"')
    }
  })

  it('excludes a retired bridge API only when explicitly disabled and narrows public coverage', () => {
    values.statusPage.publication.probes.bridgeChecks = 'disabled'
    generate()
    const targets = values.statusPage.generated.alloyProbes.targets.filter((t: any) => t.component_key === 'bridge-portal')
    expect(targets).to.have.length(1)
    expect(targets[0].check_id).to.contain('-page-')
    expect(values.statusPage.generated.componentPublication.readiness['bridge-portal'].ready).to.equal(true)
    expect(values.statusPage.catalog.components.find((c: any) => c.key === 'bridge-portal').description).to.equal('Availability of the bridge website over HTTPS.')
    expect(values.statusPage.generated.delivery.alloyProbes.targets.filter((t: any) => t.component_key === 'bridge-portal')).to.have.length(1)
    expect(generate()).to.deep.equal([])
    values.statusPage.publication.probes.mode = 'external'
    expect(generate).to.throw('requires Alloy page-only')
  })

  it('still requires API evidence in auto mode when discovery is absent', () => {
    delete values.statusPage.sources.frontendsConfig
    generate()
    expect(values.statusPage.generated.componentPublication.readiness['bridge-portal'].ready).to.equal(false)
    expect(values.statusPage.generated.componentPublication.readiness['bridge-portal'].reason).to.equal('requires-public-api-endpoint')
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

})
