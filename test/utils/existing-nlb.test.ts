/* eslint-disable @typescript-eslint/no-explicit-any -- Simulated AWS and Kubernetes documents. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {applyBootnodePublicP2p, validateBootnodePublicP2p} from '../../src/utils/bootnode-public-p2p.js'
import {existingNlbEntries, publicBootnodeEnodes, validateExistingNlbSdk} from '../../src/utils/existing-nlb.js'
import {fixture} from '../fixtures/existing-nlb.js'

const prefix = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:'
const listener = `${prefix}listener/net/bootnode-a/0123456789abcdef/fedcba9876543210`
const group = `${prefix}targetgroup/bootnode-a/1111111111111111`

describe('independent bootnode NLB', () => {
  it('requires the committed SDK chart interface that omits partner lists', () => {
    const f = fixture()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-nlb-sdk-'))
    const git = (args: string[]): void => {execFileSync('git', ['-C', root, ...args], {stdio: 'pipe'})}
    try {
      fs.mkdirSync(path.join(root, 'charts/l2-reth/templates'), {recursive: true})
      fs.writeFileSync(path.join(root, 'charts/l2-reth/templates/p2p-targetgroupbinding.yaml'), '# test fixture\n')
      git(['init', '--quiet'])
      for (const version of ['0.1.10', '0.1.11']) {
        fs.writeFileSync(path.join(root, 'charts/l2-reth/Chart.yaml'), `version: ${version}\n`)
        git(['add', 'charts/l2-reth/Chart.yaml', 'charts/l2-reth/templates/p2p-targetgroupbinding.yaml'])
        git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', version])
        if (version === '0.1.10') expect(() => validateExistingNlbSdk(root, f.spec)).to.throw('0.1.11')
        else expect(() => validateExistingNlbSdk(root, f.spec)).not.to.throw()
      }
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  it('exports EIP enodes without changing the saved node public key', () => {
    const publicKey = 'ab'.repeat(64)
    expect(publicBootnodeEnodes(`enode://${publicKey}@l2-reth-bootnode-0:30303`, ['198.51.100.10:30303'])).to.deep.equal([`enode://${publicKey}@198.51.100.10:30303`])
    expect(() => publicBootnodeEnodes('bad', ['198.51.100.10:30303'])).to.throw('identity')
  })
  it('projects only binding intent, preserves identity, rejects creation fallback and shared NLBs', () => {
    const f = fixture()
    expect(() => validateBootnodePublicP2p([f.entry], [0])).not.to.throw()
    expect(f.values.reth.p2pExternal).not.to.have.property('sourceRanges')
    expect(f.values.reth.nodeKey.mode).to.equal('secret')
    expect(f.values.reth.p2pExternal).to.include({mode: 'existing'})
    expect(f.values.reth.p2pExternal.existingNlb.targetGroupARN).to.equal(group)
    expect(() => applyBootnodePublicP2p(f.values, 0, [{...f.entry, existingNlb: undefined, mode: 'service'}])).to.throw('implicitly')
    expect(() => validateBootnodePublicP2p([{...f.entry, mode: 'service'}], [0])).to.throw('fallback')
    expect(() => validateBootnodePublicP2p([f.entry, {...f.entry, index: 1}], [0, 1])).to.throw('independent NLB')
    expect(() => validateBootnodePublicP2p([{...f.entry, existingNlb: {...f.entry.existingNlb, targetGroupArn: group.replace('123456789012', '999999999999')}}], [0])).to.throw('account and region')
    expect(() => validateBootnodePublicP2p([{...f.entry, sourceRanges: ['0.0.0.0/0']}], [0])).to.throw('must be omitted')
    expect(() => validateBootnodePublicP2p([{...f.entry, existingNlb: {...f.entry.existingNlb, listenerArn: listener.replace('bootnode-a', 'bootnode-b')}}], [0])).to.throw('belong')
    f.spec.infrastructure.aws.region = 'us-west-2'
    expect(() => existingNlbEntries(f.spec)).to.throw('account and region')
  })

  it('removes inherited template allowlists when generating an independent binding', () => {
    const f = fixture()
    f.values.reth.p2pExternal.sourceRanges = ['203.0.113.10/32']
    applyBootnodePublicP2p(f.values, 0, [f.entry])
    expect(f.values.reth.p2pExternal).not.to.have.property('sourceRanges')
  })

  it('renders generated values as an application-owned binding without an AWS resource owner', function () {
    if (!process.env.SCROLLSDK_TEST_SDK_CHART) this.skip()
    const f = fixture()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-nlb-render-'))
    try {
      const file = path.join(root, 'values.yaml')
      fs.writeFileSync(file, f.files['l2-reth-bootnode-production-0.yaml'])
      const objects = yaml.loadAll(execFileSync('helm', ['template', 'l2-reth-bootnode-0', process.env.SCROLLSDK_TEST_SDK_CHART!, '-f', file], {encoding: 'utf8'})) as any[]
      expect(objects.some(object => object?.kind === 'Ingress' || object?.spec?.type === 'LoadBalancer')).to.equal(false)
      const binding = objects.find(object => object?.kind === 'TargetGroupBinding')
      expect(binding.spec.targetGroupARN).to.equal(group)
      expect(binding.spec.serviceRef).to.deep.equal({name: 'l2-reth-bootnode-0-p2p', port: 30_303})
      expect(binding.metadata.annotations?.['helm.sh/resource-policy']).not.to.equal('keep')
      const service = objects.find(object => object?.kind === 'Service' && object.metadata.name === binding.spec.serviceRef.name)
      expect(service.spec.type).to.equal('ClusterIP')
      expect(service.spec.selector['statefulset.kubernetes.io/pod-name']).to.equal('l2-reth-bootnode-0-0')
      expect(service.spec.ports).to.have.length(1)
      expect(Object.keys(service.metadata.annotations ?? {}).some(key => key.includes('aws-load-balancer'))).to.equal(false)
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

})
