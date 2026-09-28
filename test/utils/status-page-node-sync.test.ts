/* eslint-disable @typescript-eslint/no-explicit-any -- Values and private collector fixtures. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {HEALTH_DEFAULTS, builtinHealth} from '../../src/utils/status-page-health.js'
import {normalizeNodeSync} from '../../src/utils/status-page-node-sync.js'
import {reconcileScrollMonitorStatusPage} from '../../src/utils/status-page-values.js'

describe('official Node Sync', () => {
  const node = (role: string, replicas = 1) => ({controller: {replicas}, reth: {networkId: '291', sequencer: {allowEmptyBlocks: true, enabled: role === 'sequencer'}}, role})
  const source = (role: string) => ({release: `l2-reth-${role}`, role, values: `${role}.yaml`})
  let sources: any
  let input: any
  const normalize = () => normalizeNodeSync(input, '291', 'testnet', HEALTH_DEFAULTS, filename => structuredClone(sources[filename]))
  beforeEach(() => {
    sources = {'bootnode.yaml': node('bootnode'), 'internal-rpc.yaml': {...node('rpc', 2), service: {main: {fullname: 'l2-rpc'}}}, 'public-rpc.yaml': node('rpc'), 'sequencer.yaml': node('sequencer')}
    input = {followers: ['bootnode', 'internal-rpc', 'public-rpc'].map(role => source(role)), mode: 'official', reference: source('sequencer')}
  })

  it('derives selected services, per-role replica counts, ports and chain identity', () => {
    const {config} = normalize()
    expect(config.reference).to.deep.equal({port: 8545, replicas: 1, role: 'sequencer', service: 'l2-reth-sequencer'})
    expect(config.followers.map((entry: any) => entry.service)).to.deep.equal(['l2-reth-bootnode', 'l2-rpc', 'l2-reth-public-rpc'])
    expect(config.followers[1].replicas).to.equal(2)
    expect(config.maxNodeLagSeconds).to.equal(120)
    sources['bootnode.yaml'].controller.replicas = 0
    expect(normalize().config.followers).to.have.length(2)
  })

  it('matches chart naming overrides and requires explicit names for Helm expressions', () => {
    sources['bootnode.yaml'].global = {fullnameOverride: 'boot-service'}
    sources['bootnode.yaml'].service = {main: {nameOverride: 'rpc'}}
    expect(normalize().config.followers[0].service).to.equal('boot-service-rpc')
    sources['bootnode.yaml'].service.main.fullname = '{{ .Release.Name }}'
    expect(normalize).to.throw('explicit')
    input.followers[0].service = 'actual-boot-service'
    expect(normalize().config.followers[0].service).to.equal('actual-boot-service')
  })

  it('rejects wrong chains, roles, disabled RPC, duplicate services and ambiguous references', () => {
    for (const modify of [() => { sources['bootnode.yaml'].reth.networkId = '123' },
      () => { sources['bootnode.yaml'].role = 'sequencer' },
      () => { sources['bootnode.yaml'].reth.http = {enabled: false} },
      () => { sources['sequencer.yaml'].controller.replicas = 2 },
      () => { sources['sequencer.yaml'].reth.sequencer.allowEmptyBlocks = false },
      () => { sources['public-rpc.yaml'].service = {main: {fullname: 'l2-rpc'}} }]) {
      const saved = structuredClone(sources)
      modify()
      expect(normalize).to.throw()
      sources = saved
    }
  })

  it('retains explicit external mode and uses separate complete/fresh collector evidence', () => {
    expect(normalizeNodeSync(undefined, '291', 'testnet', HEALTH_DEFAULTS).config).to.equal(null)
    const expression = builtinHealth('node-sync', 'testnet', '291', HEALTH_DEFAULTS, 'official')
    expect(expression).to.contain('scroll_status_node_sync_affected')
    expect(expression).to.contain('scroll_status_node_sync_timestamp_seconds')
    expect(expression).to.contain('count(')
    expect(expression).not.to.contain('location')
    expect(builtinHealth('node-sync', 'testnet', '291', HEALTH_DEFAULTS)).to.contain('scroll_status_probe_affected')
    input.mode = 'external'
    expect(normalize).to.throw('must not retain')
  })

  it('generates idempotently, isolates private data and updates changed replica counts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-sync-'))
    try {
      const write = () => { for (const [name, values] of Object.entries(sources)) fs.writeFileSync(path.join(directory, name), yaml.dump(values)) }
      write()
      const ingress = {main: {hosts: [{host: 'service.example', paths: [{path: '/'}]}]}}
      for (const name of ['frontends-production.yaml', 'l2-reth-rpc-public-production.yaml']) fs.writeFileSync(path.join(directory, name), yaml.dump({ingress}))
      fs.writeFileSync(path.join(directory, 'blockscout-production.yaml'), yaml.dump({'blockscout-stack': {frontend: {ingress: {hostname: 'explorer.example'}}}}))
      let values: any = {statusPage: {enabled: true, publication: {components: {'node-sync': {mode: 'observe', rule: {builtin: true}}}, nodeSync: input}}}
      const generate = () => reconcileScrollMonitorStatusPage(values, {chainId: 291, environment: 'testnet', networkName: 'DogeOS', valuesDir: directory})
      generate()
      expect(values.statusPage.generated.componentPublication.readiness['node-sync'].ready).to.equal(true)
      expect(values.statusPage.generated.probeConfig.nodeRpcUrl).to.equal('')
      expect(JSON.stringify(values.statusPage.catalog)).not.to.contain('l2-rpc')
      expect(JSON.stringify(values.statusPage.generated.probeConfig)).not.to.contain('l2-rpc')
      expect(generate()).to.deep.equal([])
      values = yaml.load(yaml.dump(values))
      expect(generate()).to.deep.equal([])
      sources['internal-rpc.yaml'].controller.replicas = 3
      write()
      generate()
      expect(values.statusPage.generated.nodeSync.followers[1].replicas).to.equal(3)
      if (process.env.SCROLL_STATUS_CHART) {
        const filename = path.join(directory, 'monitor.yaml')
        const render = () => {
          fs.writeFileSync(filename, yaml.dump(values))
          return execFileSync('helm', ['template', 'monitor', process.env.SCROLL_STATUS_CHART!, '--namespace', 'monitoring', '-f', filename], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: 'pipe'})
        }

        const docs: any[] = yaml.loadAll(render())
        const deployment = docs.find(doc => doc?.kind === 'Deployment' && doc.metadata.name === 'monitor-status-node-sync')
        expect(deployment.spec.replicas).to.equal(1)
        const role = docs.find(doc => doc?.kind === 'Role' && doc.metadata.name === 'monitor-status-node-sync')
        expect(role.rules).to.deep.equal([{apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: ['list']}])
        values.statusPage.generated.nodeSync.followers[0].replicas = 9
        expect(render).to.throw('Node Sync')
      }
    } finally { fs.rmSync(directory, {force: true, recursive: true}) }
  })
})
