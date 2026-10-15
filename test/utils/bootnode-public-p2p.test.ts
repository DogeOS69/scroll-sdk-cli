/* eslint-disable @typescript-eslint/no-explicit-any -- Tests exercise dynamic Helm values. */
import {expect} from 'chai'
import {Wallet} from 'ethers'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {BootnodePublicP2p, DeploymentSpec} from '../../src/types/deployment-spec.js'

import PrepCharts from '../../src/commands/setup/prep-charts.js'
import {applyBootnodePublicP2p, projectBootnodePublicP2p, validateBootnodePublicP2p} from '../../src/utils/bootnode-public-p2p.js'

const entry = (): BootnodePublicP2p => ({eipAllocations: ['eipalloc-0123456789abcdef0'], enabled: true, index: 1, sourceRanges: ['203.0.113.10/32'], subnets: ['subnet-0123456789abcdef0']})

describe('spec bootnode public P2P allowlist', () => {
  it('validates without provider access and rejects unsafe or incomplete activation', () => {
    expect(() => validateBootnodePublicP2p([entry()], [0, 1], 'aws')).not.to.throw()
    for (const invalid of [
      {sourceRanges: []}, {sourceRanges: ['0.0.0.0/0']}, {sourceRanges: ['::/0']},
      {sourceRanges: ['203.0.113.10']}, {sourceRanges: ['partner.example.invalid/32']},
      {sourceRanges: ['203.0.113.10/33']}, {sourceRanges: ['203.0.113.10/32/extra']},
      {subnets: []}, {subnets: ['TODO']}, {eipAllocations: []},
      {index: 2}, {index: -1}, {enabled: 'true'},
    ]) expect(() => validateBootnodePublicP2p([{...entry(), ...invalid} as any], [0, 1])).to.throw()
    expect(() => validateBootnodePublicP2p([entry(), entry()], [0, 1])).to.throw('distinct')
    expect(() => validateBootnodePublicP2p([entry(), {...entry(), index: 0}], [0, 1])).to.throw('unique')
    expect(() => validateBootnodePublicP2p([entry()], [0, 1], 'gcp')).to.throw('AWS')
    expect(() => validateBootnodePublicP2p([{enabled: false, index: 0}], [0], 'local')).not.to.throw()
  })

  it('keeps manual values when absent, closes omitted nodes with explicit intent, and preserves identities', () => {
    const values: any = {resources: {requests: {cpu: '42m'}}, reth: {nodeKey: {secretName: 'existing-key'}, p2pExternal: {allowOpenPeering: true, enabled: true, sourceRanges: ['0.0.0.0/0']}}}
    const old = structuredClone(values)
    applyBootnodePublicP2p(values, 0)
    expect(values).to.deep.equal(old)
    applyBootnodePublicP2p(values, 0, [entry()])
    expect(values.reth.p2pExternal.enabled).to.equal(false)
    applyBootnodePublicP2p(values, 1, [entry()])
    expect(values.reth.p2pExternal.sourceRanges).to.deep.equal(entry().sourceRanges)
    expect(values.reth.p2pExternal.allowOpenPeering).to.equal(false)
    expect(values.reth.nodeKey).to.deep.equal(old.reth.nodeKey)
    expect(values.resources).to.deep.equal(old.resources)
    const enabled = structuredClone(values)
    applyBootnodePublicP2p(values, 1, [entry()])
    expect(values).to.deep.equal(enabled)
    applyBootnodePublicP2p(values, 1, [])
    expect(values.reth.p2pExternal.enabled).to.equal(false)
  })

  it('projects isolated indexed values after merging templates, retaining operator resource overrides', () => {
    const template = yaml.dump({resources: {requests: {cpu: '10m'}}, reth: {p2pExternal: {enabled: false}}, role: 'bootnode'})
    const files = {'l2-reth-bootnode-production.yaml': template} as Record<string, string>
    const spec = {bootnodePublicP2p: [entry()], infrastructure: {bootnodeCount: 2, provider: 'aws'}} as DeploymentSpec
    projectBootnodePublicP2p(files, spec, () => yaml.dump({resources: {requests: {cpu: '42m'}}}))
    expect((yaml.load(files['l2-reth-bootnode-production-0.yaml']) as any).reth.p2pExternal.enabled).to.equal(false)
    const selected = yaml.load(files['l2-reth-bootnode-production-1.yaml']) as any
    expect(selected.reth.p2pExternal.sourceRanges).to.deep.equal(['203.0.113.10/32'])
    expect(selected.resources.requests.cpu).to.equal('42m')
    expect((yaml.load(files['l2-reth-bootnode-production.yaml']) as any).reth.p2pExternal.enabled).to.equal(false)
    expect(Object.keys(files)).not.to.include('l2-reth-sequencer-production.yaml')
  })

  it('reconciles saved intent through the actual prep-charts bootnode path on repeated runs', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bootnode-allowlist-prep-'))
    try {
      const file = path.join(directory, 'l2-reth-bootnode-production-1.yaml')
      fs.writeFileSync(file, yaml.dump({resources: {requests: {cpu: '42m'}}, reth: {p2pExternal: {enabled: false}}, role: 'bootnode'}))
      const key = Wallet.createRandom().privateKey.slice(2)
      const command: any = Object.create(PrepCharts.prototype)
      command.flags = {}
      command.dogeConfig = {bootnodePublicP2p: [entry()], bootnodeReth: {instances: [{index: 1, nodekey: {privateKey: key, secretMode: 'external-secret'}}]}, network: 'testnet'}
      command.getConfigValue = (name: string) => name === 'general.CHAIN_ID_L2' ? 221_122 : name === 'contracts.overrides.L2_TX_FEE_VAULT' ? '0x5300000000000000000000000000000000000005' : undefined
      command.jsonMode = true; command.nonInteractive = true
      command.log = () => {}
      command.jsonCtx = {addWarning() {}, info() {}, logSuccess() {}}
      await command.processBootnodeRethInstanceFiles(directory)
      await command.processProductionYaml(directory)
      const first = yaml.load(fs.readFileSync(file, 'utf8')) as any
      expect(first.reth.p2pExternal.sourceRanges).to.deep.equal(entry().sourceRanges)
      expect(first.resources.requests.cpu).to.equal('42m')
      await command.processProductionYaml(directory)
      expect(yaml.load(fs.readFileSync(file, 'utf8'))).to.deep.equal(first)
      command.dogeConfig.bootnodePublicP2p = []
      await command.processProductionYaml(directory)
      expect((yaml.load(fs.readFileSync(file, 'utf8')) as any).reth.p2pExternal.enabled).to.equal(false)
      expect(command.dogeConfig.bootnodeReth.instances[0].nodekey.privateKey).to.equal(key)
    } finally {fs.rmSync(directory, {force: true, recursive: true})}
  })

  it('renders a TCP-only NLB with the exact source restriction using the SDK chart', function () {
    if (!process.env.SCROLLSDK_TEST_SDK_CHART) this.skip()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bootnode-allowlist-render-'))
    try {
      const values: any = {reth: {sequencer: {enabled: false}}, role: 'bootnode'}
      applyBootnodePublicP2p(values, 1, [entry()])
      const file = path.join(directory, 'values.yaml'); fs.writeFileSync(file, yaml.dump(values))
      const rendered = execFileSync('helm', ['template', 'bootnode-1', process.env.SCROLLSDK_TEST_SDK_CHART!, '-f', file], {encoding: 'utf8'})
      const objects = yaml.loadAll(rendered) as any[]
      const service = objects.find(object => object?.kind === 'Service' && object.spec?.type === 'LoadBalancer')
      expect(service.spec.loadBalancerSourceRanges).to.deep.equal(entry().sourceRanges)
      expect(service.spec.ports).to.have.length(1)
      expect(service.spec.ports[0]).to.include({port: 30_303, protocol: 'TCP', targetPort: 30_303})
      expect(service.spec.selector['statefulset.kubernetes.io/pod-name']).to.equal('bootnode-1-l2-reth-0')
      expect(objects.filter(object => object?.kind === 'Service' && object !== service).every(object => object.spec.type === 'ClusterIP')).to.equal(true)
      applyBootnodePublicP2p(values, 1, [])
      fs.writeFileSync(file, yaml.dump(values))
      const disabled = yaml.loadAll(execFileSync('helm', ['template', 'bootnode-1', process.env.SCROLLSDK_TEST_SDK_CHART!, '-f', file], {encoding: 'utf8'})) as any[]
      expect(disabled.some(object => object?.kind === 'Service' && object.spec?.type === 'LoadBalancer')).to.equal(false)
    } finally {fs.rmSync(directory, {force: true, recursive: true})}
  })
})
