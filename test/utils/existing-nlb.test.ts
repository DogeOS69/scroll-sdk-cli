/* eslint-disable @typescript-eslint/no-explicit-any -- Simulated AWS and Kubernetes documents. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sinon from 'sinon'

import Nlb from '../../src/commands/setup/nlb.js'
import {AwsCliRunner} from '../../src/utils/aws-cli.js'
import {applyBootnodePublicP2p, validateBootnodePublicP2p} from '../../src/utils/bootnode-public-p2p.js'
import {existingNlbEntries, publicBootnodeEnodes, validateExistingNlbSdk, verifyExistingNlb, verifyExistingNlbTargets} from '../../src/utils/existing-nlb.js'
import {fixture} from '../fixtures/existing-nlb.js'

const prefix = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:'
const listener = `${prefix}listener/net/bootnode-a/0123456789abcdef/fedcba9876543210`
const group = `${prefix}targetgroup/bootnode-a/1111111111111111`
const sg = 'sg-0123456789abcdef0'

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

  it('discovers infrastructure from minimal TG and SG references with inferred mode', () => {
    const f = fixture()
    delete f.entry.mode; delete f.entry.subnets; delete f.entry.eipAllocations
    delete f.entry.existingNlb.loadBalancerArn; delete f.entry.existingNlb.listenerArn
    expect(verifyExistingNlb(f.spec, f.files, f.aws)[0].publicEndpoints).to.deep.equal(['198.51.100.10:30303'])
    const calls = f.calls as string[][]
    expect(calls.findIndex(args => args[1] === 'describe-target-groups')).to.be.lessThan(calls.findIndex(args => args[1] === 'describe-load-balancers'))
    f.responses['elbv2 describe-target-groups'].TargetGroups[0].LoadBalancerArns = []
    expect(() => verifyExistingNlb(f.spec, f.files, f.aws)).to.throw('exactly one network')
  })

  it('rejects separate target groups that resolve to the same NLB', () => {
    const f = fixture()
    delete f.entry.existingNlb.loadBalancerArn; delete f.entry.existingNlb.listenerArn
    const second = {...structuredClone(f.entry), index: 1}
    second.existingNlb.targetGroupArn = group.replace('1111111111111111', '2222222222222222')
    delete second.subnets; delete second.eipAllocations
    f.spec.bootnodePublicP2p.push(second)
    const values = structuredClone(f.values)
    applyBootnodePublicP2p(values, 1, f.spec.bootnodePublicP2p)
    f.files['l2-reth-bootnode-production-1.yaml'] = yaml.dump(values)
    const aws = {json(args: string[]): any {
      const response = structuredClone(f.aws.json(args))
      if (args[1] === 'describe-target-groups') response.TargetGroups[0].TargetGroupArn = args[3]
      return response
    }}
    expect(() => verifyExistingNlb(f.spec, f.files, aws)).to.throw('own independent NLB')
  })

  it('rejects NLB addresses without an EIP even when no allocation is declared', () => {
    const f = fixture()
    delete f.entry.subnets; delete f.entry.eipAllocations
    delete f.responses['elbv2 describe-load-balancers'].LoadBalancers[0].AvailabilityZones[0].LoadBalancerAddresses[0].AllocationId
    expect(() => verifyExistingNlb(f.spec, f.files, f.aws)).to.throw('fixed EIP')
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

  it('keeps spec and generated values unchanged across AWS-only partner additions and removals', () => {
    const f = fixture()
    const originalSpec = JSON.stringify(f.spec)
    const originalFiles = JSON.stringify(f.files)
    const permissions = f.responses['ec2 describe-security-groups'].SecurityGroups[0].IpPermissions
    permissions[0].IpRanges.push({CidrIp: '198.51.100.0/24'})
    expect(() => verifyExistingNlb(f.spec, f.files, f.aws)).not.to.throw()
    permissions[0].IpRanges.shift()
    expect(() => verifyExistingNlb(f.spec, f.files, f.aws)).not.to.throw()
    permissions.splice(0)
    expect(() => verifyExistingNlb(f.spec, f.files, f.aws)).not.to.throw()
    expect(JSON.stringify(f.spec)).to.equal(originalSpec)
    expect(JSON.stringify(f.files)).to.equal(originalFiles)
    expect(f.calls.every((args: string[]) => /^(describe-|get-caller-identity)/.test(args[1]))).to.equal(true)
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

  it('runs preflight from the saved deployment with public enodes and no Kubernetes dependency', async () => {
    const f = fixture()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-nlb-command-'))
    const stub = sinon.stub(AwsCliRunner.prototype, 'json').callsFake(args => f.aws.json(args))
    try {
      fs.mkdirSync(path.join(root, '.scrollsdk')); fs.mkdirSync(path.join(root, '.data')); fs.mkdirSync(path.join(root, 'values'))
      fs.writeFileSync(path.join(root, '.scrollsdk/intent.json'), JSON.stringify(f.spec))
      fs.writeFileSync(path.join(root, 'values/l2-reth-bootnode-production-0.yaml'), f.files['l2-reth-bootnode-production-0.yaml'])
      fs.writeFileSync(path.join(root, '.data/doge-config.toml'), `[[bootnodeReth.instances]]\nindex = 0\nenodeUrl = "enode://${'ab'.repeat(64)}@l2-reth-bootnode-0:30303"\n`)
      const command: any = Object.create(Nlb.prototype)
      command.parse = async () => ({flags: {dir: root, json: true, 'require-targets': false, 'values-dir': 'values'}})
      let output = ''
      command.log = (message: string) => {output = message}
      await command.run()
      expect(JSON.parse(output).endpoints[0].enodes).to.deep.equal([`enode://${'ab'.repeat(64)}@198.51.100.10:30303`])
      expect(JSON.parse(output).verified).to.equal(true)
      expect(JSON.parse(output).note).to.include('RLPx')
    } finally {stub.restore(); fs.rmSync(root, {force: true, recursive: true})}
  })

  it('checks multi-AZ cross-zone inheritance and explicit target-group overrides', () => {
    const f = fixture()
    const subnetB = 'subnet-11111111111111111'
    const allocationB = 'eipalloc-11111111111111111'
    f.entry.subnets.push(subnetB); f.entry.eipAllocations.push(allocationB)
    applyBootnodePublicP2p(f.values, 0, f.spec.bootnodePublicP2p)
    f.files['l2-reth-bootnode-production-0.yaml'] = yaml.dump(f.values)
    f.responses['elbv2 describe-load-balancers'].LoadBalancers[0].AvailabilityZones.push({LoadBalancerAddresses: [{AllocationId: allocationB, IpAddress: '198.51.100.11'}], SubnetId: subnetB, ZoneName: 'us-east-1b'})
    f.responses['ec2 describe-subnets'].Subnets.push({AvailabilityZone: 'us-east-1b', OwnerId: '123456789012', SubnetId: subnetB, VpcId: 'vpc-example'})
    expect(() => verifyExistingNlb(f.spec, f.files, f.aws)).to.throw('cross-zone')
    f.responses['elbv2 describe-load-balancer-attributes'].Attributes[0].Value = 'true'
    expect(verifyExistingNlb(f.spec, f.files, f.aws)[0].crossZone).to.equal(true)
    f.responses['elbv2 describe-target-group-attributes'].Attributes.push({Key: 'load_balancing.cross_zone.enabled', Value: 'false'})
    expect(() => verifyExistingNlb(f.spec, f.files, f.aws)).to.throw('cross-zone')
    f.responses['elbv2 describe-target-group-attributes'].Attributes[1].Value = 'true'
    f.responses['elbv2 describe-load-balancer-attributes'].Attributes[0].Value = 'false'
    expect(verifyExistingNlb(f.spec, f.files, f.aws)[0].crossZone).to.equal(true)
  })

  it('verifies pre-install infrastructure using reads only and reports fixed EIP endpoints', () => {
    const f = fixture()
    expect(verifyExistingNlb(f.spec, f.files, f.aws)[0]).to.include({podName: 'l2-reth-bootnode-0-0', serviceName: 'l2-reth-bootnode-0-p2p'})
    expect(verifyExistingNlb(f.spec, f.files, f.aws)[0].publicEndpoints).to.deep.equal(['198.51.100.10:30303'])
    expect(f.calls.every((args: string[]) => /^(describe-|get-caller-identity)/.test(args[1]))).to.equal(true)
    expect(f.calls.some((args: string[]) => args[1] === 'describe-target-health')).to.equal(false)
  })

  const failures: Array<[string, (f: any) => void, string]> = [
    ['wrong caller', f => {f.responses['sts get-caller-identity'].Account = '999999999999'}, 'caller'],
    ['ALB instead of NLB', f => {f.responses['elbv2 describe-load-balancers'].LoadBalancers[0].Type = 'application'}, 'IPv4 NLB'],
    ['private NLB', f => {f.responses['elbv2 describe-load-balancers'].LoadBalancers[0].Scheme = 'internal'}, 'internet-facing'],
    ['Service-owned resource', f => {f.responses['elbv2 describe-tags'].TagDescriptions[0].Tags.push({Key: 'service.k8s.aws/stack', Value: 'old-service'})}, 'externally managed'],
    ['extra SG', f => {f.responses['elbv2 describe-load-balancers'].LoadBalancers[0].SecurityGroups.push('sg-11111111')}, 'exactly match'],
    ['public ingress', f => {f.responses['ec2 describe-security-groups'].SecurityGroups[0].IpPermissions[0].IpRanges[0].CidrIp = '0.0.0.0/0'}, '/0'],
    ['combined public ingress', f => {f.responses['ec2 describe-security-groups'].SecurityGroups[0].IpPermissions[0].IpRanges = [{CidrIp: '0.0.0.0/1'}, {CidrIp: '128.0.0.0/1'}]}, 'all IPv4'],
    ['IPv6 ingress', f => {f.responses['ec2 describe-security-groups'].SecurityGroups[0].IpPermissions[0].Ipv6Ranges = [{CidrIpv6: '::/0'}]}, 'only TCP30303'],
    ['prefix-list bypass', f => {f.responses['ec2 describe-security-groups'].SecurityGroups[0].IpPermissions[0].PrefixListIds = [{PrefixListId: 'pl-example'}]}, 'only TCP30303'],
    ['stale values allowlist', f => {f.values.reth.p2pExternal.sourceRanges = ['203.0.113.10/32']; f.files['l2-reth-bootnode-production-0.yaml'] = yaml.dump(f.values)}, 'remove sourceRanges'],
    ['SG-reference bypass', f => {f.responses['ec2 describe-security-groups'].SecurityGroups[0].IpPermissions[0].UserIdGroupPairs = [{GroupId: sg}]}, 'only TCP30303'],
    ['RPC ingress', f => {f.responses['ec2 describe-security-groups'].SecurityGroups[0].IpPermissions[0].FromPort = 8545}, 'only TCP30303'],
    ['changed EIP', f => {f.responses['elbv2 describe-load-balancers'].LoadBalancers[0].AvailabilityZones[0].LoadBalancerAddresses[0].AllocationId = 'eipalloc-11111111'}, 'declared EIP'],
    ['TLS listener', f => {f.responses['elbv2 describe-listeners'].Listeners[0].Protocol = 'TLS'}, 'plain TCP30303'],
    ['additional listener', f => {f.responses['elbv2 describe-listeners'].Listeners.push({...f.responses['elbv2 describe-listeners'].Listeners[0], Port: 8545})}, 'exactly'],
    ['wrong backend', f => {f.responses['elbv2 describe-listeners'].Listeners[0].DefaultActions[0].TargetGroupArn = 'other'}, 'only to this'],
    ['instance targets', f => {f.responses['elbv2 describe-target-groups'].TargetGroups[0].TargetType = 'instance'}, 'TCP30303/IP'],
    ['Proxy Protocol', f => {f.responses['elbv2 describe-target-group-attributes'].Attributes[0].Value = 'true'}, 'Proxy Protocol'],
    ['unknown Proxy Protocol', f => {f.responses['elbv2 describe-target-group-attributes'].Attributes = []}, 'Proxy Protocol'],
    ['legacy annotations', f => {f.values.reth.p2pExternal.annotations = {'service.beta.kubernetes.io/aws-load-balancer-name': 'old'}; f.files['l2-reth-bootnode-production-0.yaml'] = yaml.dump(f.values)}, 'clear Service-owned'],
    ['stale generation', f => {f.files['l2-reth-bootnode-production-0.yaml'] = yaml.dump({})}, 'differ from spec'],
  ]
  for (const [name, change, error] of failures) it(`rejects ${name}`, () => {
    const f = fixture(); change(f)
    expect(() => verifyExistingNlb(f.spec, f.files, f.aws)).to.throw(error)
  })

  it('requires exact installed identity target, ready pod AZ and registered target', () => {
    const f = fixture()
    const verified = verifyExistingNlb(f.spec, f.files, f.aws)
    expect(verifyExistingNlbTargets(f.spec, verified, f.aws, f.kube)).to.deep.equal(['l2-reth-bootnode-0-p2p'])
    for (const [key, mutate, error] of [
      ['targetgroupbindings.elbv2.k8s.aws', (value: any) => {value.items.push({...structuredClone(value.items[0]), metadata: {namespace: 'other'}})}, 'exactly one'],
      ['targetgroupbindings.elbv2.k8s.aws', (value: any) => {value.items[0].metadata.namespace = 'other'}, 'exactly one'],
      ['config', (value: any) => {value.clusters[0].cluster.server = 'https://other.invalid'}, 'EKS cluster'],
      ['service', (value: any) => {value.spec.selector['statefulset.kubernetes.io/pod-name'] = 'other-pod'}, 'designated pod'],
      ['service', (value: any) => {value.spec.ports.push({port: 8545})}, 'TCP30303'],
      ['node', (value: any) => {value.metadata.labels['topology.kubernetes.io/zone'] = 'us-east-1b'}, 'AZ'],
      ['endpointslices.discovery.k8s.io', (value: any) => {value.items[0].endpoints[0].addresses = ['10.0.0.6']}, 'designated ready'],
      ['targetgroupbindings.elbv2.k8s.aws', (value: any) => {value.items[0].spec.networking.ingress[0].from = []}, 'networking'],
    ] as Array<[string, (value: any) => void, string]>) {
      const saved = structuredClone(f.kubeObjects[key]); mutate(f.kubeObjects[key])
      expect(() => verifyExistingNlbTargets(f.spec, verified, f.aws, f.kube)).to.throw(error)
      f.kubeObjects[key] = saved
    }

    f.responses['elbv2 describe-target-health'].TargetHealthDescriptions.push({Target: {Id: '10.0.0.6', Port: 30_303}, TargetHealth: {State: 'healthy'}})
    expect(() => verifyExistingNlbTargets(f.spec, verified, f.aws, f.kube)).to.throw('exactly the designated')
  })

  it('does not hide provider errors that might otherwise allow fallback or leak output', () => {
    const f = fixture()
    const bad = {json(): any {throw new Error('SENSITIVE PROVIDER OUTPUT')}}
    expect(() => verifyExistingNlb(f.spec, f.files, bad)).to.throw('provider output omitted')
    expect(() => verifyExistingNlb(f.spec, f.files, bad)).not.to.throw('SENSITIVE')
  })
})
