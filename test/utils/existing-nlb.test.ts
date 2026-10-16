/* eslint-disable @typescript-eslint/no-explicit-any -- Simulated AWS and Kubernetes documents. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sinon from 'sinon'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import Nlb from '../../src/commands/setup/nlb.js'
import {AwsCliRunner} from '../../src/utils/aws-cli.js'
import {applyBootnodePublicP2p, validateBootnodePublicP2p} from '../../src/utils/bootnode-public-p2p.js'
import {existingNlbEntries, publicBootnodeEnodes, verifyExistingNlb, verifyExistingNlbTargets} from '../../src/utils/existing-nlb.js'

const prefix = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:'
const lb = `${prefix}loadbalancer/net/bootnode-a/0123456789abcdef`
const listener = `${prefix}listener/net/bootnode-a/0123456789abcdef/fedcba9876543210`
const group = `${prefix}targetgroup/bootnode-a/1111111111111111`
const sg = 'sg-0123456789abcdef0'
const subnet = 'subnet-0123456789abcdef0'
const eip = 'eipalloc-0123456789abcdef0'
function fixture(): any {
  const entry = {eipAllocations: [eip], enabled: true, existingNlb: {listenerArn: listener, loadBalancerArn: lb, securityGroupIds: [sg], targetGroupArn: group}, index: 0, mode: 'existing', sourceRanges: ['203.0.113.10/32'], subnets: [subnet]}
  const spec = {bootnodePublicP2p: [entry], infrastructure: {aws: {accountId: '123456789012', eksClusterName: 'example', region: 'us-east-1'}, bootnodeCount: 2, kubeContext: 'example', namespace: 'default', provider: 'aws'}} as DeploymentSpec
  const values = {reth: {nodeKey: {mode: 'secret'}}, role: 'bootnode'}
  applyBootnodePublicP2p(values, 0, spec.bootnodePublicP2p)
  const files = {'l2-reth-bootnode-production-0.yaml': yaml.dump(values)}
  const responses: Record<string, any> = {
    'ec2 describe-security-groups': {SecurityGroups: [{GroupId: sg, IpPermissions: [{FromPort: 30_303, IpProtocol: 'tcp', IpRanges: [{CidrIp: '203.0.113.10/32'}], ToPort: 30_303}], OwnerId: '123456789012', VpcId: 'vpc-example'}]},
    'ec2 describe-subnets': {Subnets: [{AvailabilityZone: 'us-east-1a', OwnerId: '123456789012', SubnetId: subnet, VpcId: 'vpc-example'}]},
    'eks describe-cluster': {cluster: {endpoint: 'https://eks.example.invalid', resourcesVpcConfig: {vpcId: 'vpc-example'}}},
    'elbv2 describe-listeners': {Listeners: [{DefaultActions: [{TargetGroupArn: group, Type: 'forward'}], ListenerArn: listener, LoadBalancerArn: lb, Port: 30_303, Protocol: 'TCP'}]},
    'elbv2 describe-load-balancer-attributes': {Attributes: [{Key: 'load_balancing.cross_zone.enabled', Value: 'false'}]},
    'elbv2 describe-load-balancers': {LoadBalancers: [{AvailabilityZones: [{LoadBalancerAddresses: [{AllocationId: eip, IpAddress: '198.51.100.10'}], SubnetId: subnet, ZoneName: 'us-east-1a'}], IpAddressType: 'ipv4', LoadBalancerArn: lb, Scheme: 'internet-facing', SecurityGroups: [sg], State: {Code: 'active'}, Type: 'network', VpcId: 'vpc-example'}]},
    'elbv2 describe-tags': {TagDescriptions: [{Tags: []}]},
    'elbv2 describe-target-group-attributes': {Attributes: [{Key: 'proxy_protocol_v2.enabled', Value: 'false'}]},
    'elbv2 describe-target-groups': {TargetGroups: [{HealthCheckEnabled: true, HealthCheckPort: 'traffic-port', HealthCheckProtocol: 'TCP', LoadBalancerArns: [lb], Port: 30_303, Protocol: 'TCP', TargetGroupArn: group, TargetType: 'ip', VpcId: 'vpc-example'}]},
    'elbv2 describe-target-health': {TargetHealthDescriptions: [{Target: {Id: '10.0.0.5', Port: 30_303}, TargetHealth: {State: 'healthy'}}]},
    'sts get-caller-identity': {Account: '123456789012'},
  }
  const calls: string[][] = []
  const aws = {json(args: string[]): any {calls.push(args); const key = args.slice(0, 2).join(' '); if (!responses[key]) throw new Error(`Unexpected call ${key}`); return responses[key]}}
  const kubeObjects: Record<string, any> = {
    'config': {clusters: [{cluster: {server: 'https://eks.example.invalid'}}]},
    'endpointslices.discovery.k8s.io': {items: [{endpoints: [{addresses: ['10.0.0.5'], conditions: {ready: true}}], metadata: {ownerReferences: [{kind: 'Service', uid: 'service-uid'}]}, ports: [{port: 30_303, protocol: 'TCP'}]}]},
    'node': {metadata: {labels: {'topology.kubernetes.io/zone': 'us-east-1a'}}},
    'pod': {spec: {nodeName: 'node-a'}, status: {conditions: [{status: 'True', type: 'Ready'}], podIP: '10.0.0.5'}},
    'service': {metadata: {uid: 'service-uid'}, spec: {ports: [{port: 30_303, protocol: 'TCP', targetPort: 30_303}], selector: {'statefulset.kubernetes.io/pod-name': 'l2-reth-bootnode-0-0'}, type: 'ClusterIP'}},
    'targetgroupbindings.elbv2.k8s.aws': {items: [{metadata: {namespace: 'default'}, spec: {networking: {ingress: [{from: [{securityGroup: {groupID: sg}}], ports: [{port: 30_303, protocol: 'TCP'}]}]}, serviceRef: {name: 'l2-reth-bootnode-0-p2p', port: 30_303}, targetGroupARN: group, targetType: 'ip'}}]},
  }
  const kube = (args: string[]): any => kubeObjects[args.includes('config') ? 'config' : args[args.indexOf('get') + 1]]
  return {aws, calls, entry, files, kube, kubeObjects, responses, spec, values}
}

describe('independent bootnode NLB', () => {
  it('exports EIP enodes without changing the saved node public key', () => {
    const publicKey = 'ab'.repeat(64)
    expect(publicBootnodeEnodes(`enode://${publicKey}@l2-reth-bootnode-0:30303`, ['198.51.100.10:30303'])).to.deep.equal([`enode://${publicKey}@198.51.100.10:30303`])
    expect(() => publicBootnodeEnodes('bad', ['198.51.100.10:30303'])).to.throw('identity')
  })
  it('projects only binding intent, preserves identity, rejects creation fallback and shared NLBs', () => {
    const f = fixture()
    expect(f.values.reth.nodeKey.mode).to.equal('secret')
    expect(f.values.reth.p2pExternal).to.include({allowOpenPeering: false, mode: 'existing'})
    expect(f.values.reth.p2pExternal.existingNlb.targetGroupARN).to.equal(group)
    expect(() => applyBootnodePublicP2p(f.values, 0, [{...f.entry, existingNlb: undefined, mode: 'service'}])).to.throw('implicitly')
    expect(() => validateBootnodePublicP2p([{...f.entry, mode: 'service'}], [0])).to.throw('fallback')
    expect(() => validateBootnodePublicP2p([f.entry, {...f.entry, index: 1}], [0, 1])).to.throw('independent NLB')
    expect(() => validateBootnodePublicP2p([{...f.entry, existingNlb: {...f.entry.existingNlb, targetGroupArn: group.replace('123456789012', '999999999999')}}], [0])).to.throw('account and region')
    expect(() => validateBootnodePublicP2p([{...f.entry, sourceRanges: ['0.0.0.0/0']}], [0])).to.throw('/0')
    expect(() => validateBootnodePublicP2p([{...f.entry, existingNlb: {...f.entry.existingNlb, listenerArn: listener.replace('bootnode-a', 'bootnode-b')}}], [0])).to.throw('belong')
    f.spec.infrastructure.aws.region = 'us-west-2'
    expect(() => existingNlbEntries(f.spec)).to.throw('account and region')
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
    ['broader CIDR', f => {f.responses['ec2 describe-security-groups'].SecurityGroups[0].IpPermissions[0].IpRanges[0].CidrIp = '203.0.113.0/24'}, 'exactly match'],
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
