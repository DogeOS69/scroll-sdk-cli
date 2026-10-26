import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {capacityConnectionUrl, prepareDstackNetworkForSpec, validateCapacityConnection} from '../../src/utils/capacity-manager-network.js'

const prefix = 'arn:aws:elasticloadbalancing:us-east-1:000000000000:'
const refs = {listenerArn: `${prefix}listener/app/dstack/0000/0000`, loadBalancerArn: `${prefix}loadbalancer/app/dstack/0000`, targetGroupArn: `${prefix}targetgroup/dstack/0000`}
const connection = () => ({existingAlb: {...refs}, mode: 'existing-alb' as const, serverUrl: 'https://dstack.example.invalid'})
function fixture(): DeploymentSpec {return {capacityManager: {connection: connection()}, dstackController: {enabled: true}, infrastructure: {aws: {accountId: '000000000000', eksClusterName: 'fixture', region: 'us-east-1'}, namespace: 'fixture', provider: 'aws'}, preparation: {}} as DeploymentSpec}
function provider() {
  const calls: string[][] = []
  const data: Record<string, any> = {
    'describe-certificate': {Certificate: {DomainValidationOptions: [{ValidationMethod: 'DNS', ValidationStatus: 'SUCCESS'}], NotAfter: Date.now() / 1000 + 86_400, Status: 'ISSUED', SubjectAlternativeNames: ['dstack.example.invalid'], Type: 'AMAZON_ISSUED'}},
    'describe-cluster': {cluster: {resourcesVpcConfig: {vpcId: 'vpc-0000'}}},
    'describe-listeners': {Listeners: [{Certificates: [{CertificateArn: 'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000'}], ListenerArn: refs.listenerArn, LoadBalancerArn: refs.loadBalancerArn, Port: 443, Protocol: 'HTTPS'}]},
    'describe-load-balancers': {LoadBalancers: [{AvailabilityZones: [{SubnetId: 'subnet-0000'}, {SubnetId: 'subnet-0001'}], LoadBalancerArn: refs.loadBalancerArn, Scheme: 'internal', SecurityGroups: ['sg-0000'], State: {Code: 'active'}, Type: 'application', VpcId: 'vpc-0000'}]},
    'describe-rules': {Rules: [{Actions: [{TargetGroupArn: refs.targetGroupArn, Type: 'forward'}], Conditions: [{Field: 'host-header', HostHeaderConfig: {Values: ['dstack.example.invalid']}}, {Field: 'path-pattern', PathPatternConfig: {Values: ['/*']}}]}]},
    'describe-security-groups': {SecurityGroups: [{GroupId: 'sg-0000', IpPermissions: [{FromPort: 443, IpProtocol: 'tcp', IpRanges: [{CidrIp: '10.0.0.0/16'}], ToPort: 443}], VpcId: 'vpc-0000'}]},
    'describe-tags': {TagDescriptions: [refs.loadBalancerArn, refs.targetGroupArn].map(ResourceArn => ({ResourceArn, Tags: [{Key: 'ManagedBy', Value: 'CloudFormation'}]}))},
    'describe-target-groups': {TargetGroups: [{LoadBalancerArns: [refs.loadBalancerArn], Port: 3000, Protocol: 'HTTP', TargetGroupArn: refs.targetGroupArn, TargetType: 'ip', VpcId: 'vpc-0000'}]},
    'get-caller-identity': {Account: '000000000000'},
  }
  return {calls, data, json(args: string[]) {calls.push(args); if (!(args[1] in data)) throw new Error('Unexpected or mutating operation'); return data[args[1]]}}
}

describe('existing dstack AWS endpoint', () => {
  let root: string
  beforeEach(() => {root = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-dstack-'))})
  afterEach(() => {fs.rmSync(root, {force: true, recursive: true})})
  it('records an externally owned target group without a stack or genesis', () => {
    const aws = provider(); const spec = fixture()
    prepareDstackNetworkForSpec(root, spec, aws)
    expect(capacityConnectionUrl(root, spec.capacityManager!.connection)).eq(connection().serverUrl)
    const binding = JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/capacity-manager/dstack-targetgroupbinding.json'), 'utf8'))
    expect(binding.spec.targetGroupARN).eq(refs.targetGroupArn)
    expect(binding.spec.networking.ingress[0].from).deep.eq([{securityGroup: {groupID: 'sg-0000'}}])
    const before = fs.readFileSync(path.join(root, '.scrollsdk/capacity-manager/network.json'), 'utf8')
    prepareDstackNetworkForSpec(root, spec, aws)
    expect(fs.readFileSync(path.join(root, '.scrollsdk/capacity-manager/network.json'), 'utf8')).eq(before)
    expect(aws.calls.every(call => /^(get|describe)-/.test(call[1]))).true
  })
  it('rejects removed creation mode and invalid URL/resource pairs', () => {
    for (const input of [{internalAlb: {}, mode: 'internal-alb'}, {...connection(), serverUrl: 'https://user:password@example.invalid'}, {...connection(), serverUrl: 'https://example.invalid/path'}, {...connection(), existingAlb: {...refs, targetGroupArn: 'not-an-arn'}}]) expect(() => validateCapacityConnection(input as any)).throw()
    expect(() => validateCapacityConnection({mode: 'existing-https', serverUrl: 'https://dstack.example.invalid'})).not.throw()
  })
  it('does not audit externally managed policies, routing or certificates', () => {
    const changes = [
      (data: any) => {data['describe-load-balancers'].LoadBalancers[0].Scheme = 'internet-facing'},
      (data: any) => {data['describe-tags'].TagDescriptions[0].Tags = [{Key: 'ingress.k8s.aws/stack', Value: 'controller'}]},
      (data: any) => {data['describe-security-groups'].SecurityGroups[0].IpPermissions[0].IpRanges[0].CidrIp = '0.0.0.0/0'},
      (data: any) => {data['describe-rules'].Rules[0].Conditions[0].HostHeaderConfig.Values = ['wrong.example.invalid']},
      (data: any) => {data['describe-certificate'].Certificate.Status = 'PENDING_VALIDATION'},
      (data: any) => {data['describe-target-groups'].TargetGroups[0].Port = 443},
    ]
    for (const change of changes) {const aws = provider(); change(aws.data); expect(() => prepareDstackNetworkForSpec(root, fixture(), aws)).not.throw()}
    expect(fs.existsSync(path.join(root, '.scrollsdk/capacity-manager/network.json'))).true
  })
  it('rejects changed intent and redacts provider errors', () => {
    prepareDstackNetworkForSpec(root, fixture(), provider())
    expect(() => capacityConnectionUrl(root, {...connection(), serverUrl: 'https://other.example.invalid'})).throw('not been read')
    expect(() => prepareDstackNetworkForSpec(root, fixture(), {json() {throw new Error('FAKE_PRIVATE_PROVIDER_RESPONSE')}})).throw('provider details omitted')
    expect(() => capacityConnectionUrl(root, connection())).throw('Run setup aws')
  })
})
