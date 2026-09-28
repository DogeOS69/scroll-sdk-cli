/* eslint-disable @typescript-eslint/no-explicit-any -- Deployment values fixtures. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {reconcileScrollMonitorStatusPage} from '../../src/utils/status-page-values.js'

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
    values = {statusPage: {enabled: true, environment: 'devnet', publication: {components: {'bridge-portal': {rule: {builtin: true}}, sequencing: {rule: {builtin: true}}}},
      sources: {frontendsConfig: 'frontends-config.yaml', sequencer: 'sequencer-0.yaml'}}}
  })
  afterEach(() => fs.rmSync(directory, {force: true, recursive: true}))

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
    expect(values.statusPage.publication.health.depositDeadlineSeconds).to.equal(0)
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
