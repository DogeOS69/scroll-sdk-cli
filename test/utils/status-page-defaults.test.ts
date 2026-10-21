/* eslint-disable @typescript-eslint/no-explicit-any -- Deployment values fixtures. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {COMPONENT_KEYS} from '../../src/utils/status-page-publication.js'
import {reconcileScrollMonitorStatusPage} from '../../src/utils/status-page-values.js'

const observeComponents = () => Object.fromEntries(COMPONENT_KEYS.map(key => [key, {mode: 'observe', ...(['deposits', 'withdrawals'].includes(key) ? {affectedStatus: 'MAJOROUTAGE'} : {})}]))

describe('status-page defaults from deployment sources', () => {
  let directory: string
  let values: any
  const write = (name: string, value: any) => fs.writeFileSync(path.join(directory, name), yaml.dump(value))
  const sequencer = (empty: boolean, chain = '221122') => write('sequencer-0.yaml', {reth: {networkId: chain, sequencer: {allowEmptyBlocks: empty, blockTimeMs: '3000', enabled: true}}, role: 'sequencer'})
  const frontend = (base = 'https://history.example/api', chain = '221122') => write('frontends-config.yaml', {scrollConfig: `REACT_APP_CHAIN_ID_L2 = "${chain}"\nREACT_APP_BRIDGE_API_URI = "${base}"\nUNRELATED_SECRET = "never-export-me"\n`})
  const generate = () => reconcileScrollMonitorStatusPage(values, {chainId: 221_122, environment: 'devnet', networkName: 'DogeOS Devnet', valuesDir: directory})
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'status-defaults-'))
    const ingress = (host: string) => ({main: {hosts: [{host, paths: [{path: '/'}]}]}})
    write('frontends-production.yaml', {ingress: ingress('portal.example')})
    write('l2-reth-rpc-public-production.yaml', {ingress: ingress('rpc.example')})
    write('blockscout-production.yaml', {'blockscout-stack': {frontend: {ingress: {hostname: 'explorer.example'}}}})
    frontend()
    sequencer(true)
    values = {statusPage: {enabled: true, environment: 'devnet', publication: {components: {...observeComponents(), 'bridge-portal': {mode: 'observe', rule: {builtin: true}}, sequencing: {mode: 'observe', rule: {builtin: true}}}},
      sources: {frontendsConfig: 'frontends-config.yaml', sequencer: 'sequencer-0.yaml'}}}
  })
  afterEach(() => fs.rmSync(directory, {force: true, recursive: true}))

  it('resolves the Activity API against the Portal origin and checks readiness instead of /txs', () => {
    write('frontends-config.yaml', {scrollConfig: 'REACT_APP_CHAIN_ID_L2 = "221122"\nREACT_APP_HISTORY_API_URI = "/api/history/v1"\n'})
    generate()
    expect(values.statusPage.generated.probeConfig.bridgeChecks).to.deep.equal([
      {equals: true, path: ['ready'], url: 'https://portal.example/api/history/v1/health'},
    ])
    expect(generate()).to.deep.equal([])
    write('frontends-config.yaml', {scrollConfig: 'REACT_APP_CHAIN_ID_L2 = "221122"\nREACT_APP_HISTORY_API_URI = "https://history.example/api/history/v1/"\n'})
    generate()
    expect(values.statusPage.generated.probeConfig.bridgeChecks[0].url).to.equal('https://history.example/api/history/v1/health')
  })

  it('rejects ambiguous or credential-bearing history API endpoints', () => {
    for (const url of ['//history.example/api', 'api/history/v1', 'https://user:fake@history.example/api', '/api/history/v1?token=fake', '/api/history/v1#fragment']) {
      write('frontends-config.yaml', {scrollConfig: `REACT_APP_CHAIN_ID_L2 = "221122"\nREACT_APP_HISTORY_API_URI = "${url}"\n`})
      expect(() => generate()).to.throw('history API')
    }
  })

  it('derives continuous production and the actual frontend history API without copying secrets', () => {
    generate()
    const {catalog, generated, publication} = values.statusPage
    expect(catalog.probeSources.blockTimeMs).to.equal(3000)
    expect(generated.probeConfig.sequencingMode).to.equal('continuous')
    expect(generated.probeConfig.bridgeChecks).to.deep.equal([
      {path: ['results'], type: 'array', url: 'https://history.example/api/txs?address=0x0000000000000000000000000000000000000000&page=1&page_size=1'},
      {path: ['total'], type: 'number', url: 'https://history.example/api/txs?address=0x0000000000000000000000000000000000000000&page=1&page_size=1'},
    ])
    expect(generated.componentPublication.readiness.sequencing.reason).to.equal('configured')
    expect(generated.componentPublication.readiness['bridge-portal'].reason).to.equal('configured')
    expect(publication.probes.sequencingMode).to.equal('auto')
    expect(publication.probes.bridgeChecks).to.equal('auto')
    expect(JSON.stringify(values)).not.to.contain('never-export-me')
    expect(generate()).to.deep.equal([])
    // A YAML round trip must also be stable, not just an in-memory second call.
    values = yaml.load(yaml.dump(values))
    expect(generate()).to.deep.equal([])
  })

  it('regenerates source changes instead of preserving stale derived inputs', () => {
    generate()
    sequencer(false)
    frontend('https://new-history.example/prefix/api/')
    generate()
    expect(values.statusPage.generated.probeConfig.sequencingMode).to.equal('on-demand')
    expect(values.statusPage.generated.componentPublication.readiness.sequencing.reason).to.contain('custom-rule')
    expect(values.statusPage.generated.probeConfig.bridgeChecks[0].url).to.contain('https://new-history.example/prefix/api/txs?')
    expect(values.statusPage.publication.health.depositDeadlineSeconds).to.equal(undefined)
  })

  it('monitors configured endpoints even when their ingresses and controllers are disabled', () => {
    const ingress = (host: string) => ({enabled: false, hosts: [{host, paths: [{path: '/'}]}]})
    write('frontends-production.yaml', {controller: {enabled: false}, ingress: {main: ingress('portal.example')}})
    write('l2-reth-rpc-public-production.yaml', {controller: {enabled: false, replicas: 0}, ingress: {
      main: ingress('rpc.example'), websocket: ingress('ws.example'),
    }})
    write('blockscout-production.yaml', {'blockscout-stack': {
      blockscout: {ingress: {enabled: false, hostname: 'explorer-api.example'}},
      frontend: {ingress: {enabled: false, hostname: 'explorer.example'}},
    }})
    const sourceFiles = ['frontends-production.yaml', 'l2-reth-rpc-public-production.yaml', 'blockscout-production.yaml']
    const before = sourceFiles.map(name => fs.readFileSync(path.join(directory, name), 'utf8'))
    generate()
    const {catalog, generated} = values.statusPage
    const endpoints = (key: string) => catalog.components.find((component: any) => component.key === key).endpoints
    expect(endpoints('public-rpc')).to.deep.equal(['https://rpc.example/', 'wss://ws.example/'])
    expect(endpoints('bridge-portal')).to.deep.equal(['https://portal.example/bridge'])
    expect(endpoints('block-explorer')).to.deep.equal(['https://explorer.example/'])
    expect(generated.probeConfig.explorerApiUrls).to.deep.equal(['https://explorer-api.example/'])
    expect(sourceFiles.map(name => fs.readFileSync(path.join(directory, name), 'utf8'))).to.deep.equal(before)
    values = yaml.load(yaml.dump(values))
    expect(generate()).to.deep.equal([])
  })

  it('still requires safe hostnames and explicit routes for disabled ingress targets', () => {
    const rpc = (host: string, paths = [{path: '/'}]) => write('l2-reth-rpc-public-production.yaml', {
      ingress: {main: {enabled: false, hosts: [{host, paths}]}},
    })
    rpc('rpc.example?token=placeholder')
    expect(generate).to.throw('hostname without credentials')
    rpc('rpc.example', [])
    expect(generate).to.throw('explicit external path')
    write('l2-reth-rpc-public-production.yaml', {ingress: {main: {enabled: false}}})
    expect(generate).to.throw('requires ingress hosts')
    rpc('rpc.example')
    write('blockscout-production.yaml', {'blockscout-stack': {frontend: {ingress: {enabled: false}}}})
    expect(generate).to.throw('hostname must be a nonempty configured string')
  })

  it('honors manual overrides and explicit opt-out', () => {
    values.statusPage.publication.probes = {bridgeChecks: [], sequencingMode: 'unconfigured'}
    generate()
    expect(values.statusPage.generated.probeConfig.bridgeChecks).to.deep.equal([])
    expect(values.statusPage.generated.probeConfig.sequencingMode).to.equal('unconfigured')
    expect(values.statusPage.generated.componentPublication.readiness['bridge-portal'].ready).to.equal(false)
  })

  it('keeps missing evidence unconfigured and rejects foreign or unsafe sources', () => {
    values.statusPage.sources = {}
    generate()
    expect(values.statusPage.generated.probeConfig.sequencingMode).to.equal('unconfigured')
    expect(values.statusPage.generated.probeConfig.bridgeChecks).to.deep.equal([])
    values.statusPage.sources.sequencer = 'sequencer-0.yaml'
    sequencer(true, '123')
    expect(generate).to.throw('networkId')
    sequencer(true)
    values.statusPage.sources.frontendsConfig = 'frontends-config.yaml'
    frontend('https://history.example/api', '123')
    expect(generate).to.throw('chain ID')
    frontend('https://history.example/api?key=do-not-export')
    expect(generate).to.throw('credentials')
    values.statusPage.sources.frontendsConfig = '../outside.yaml'
    expect(generate).to.throw('inside the values directory')
  })

  it('accepts typed API checks, but rejects invalid or ambiguous contracts', () => {
    values.statusPage.publication.probes = {bridgeChecks: [{path: ['results'], type: 'array', url: 'https://example.com'}]}
    generate()
    values.statusPage.publication.probes.bridgeChecks[0].equals = []
    expect(generate).to.throw('requires')
    delete values.statusPage.publication.probes.bridgeChecks[0].equals
    values.statusPage.publication.probes.bridgeChecks[0].type = 'anything'
    expect(generate).to.throw('requires')
  })
})
