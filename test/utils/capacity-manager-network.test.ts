/* eslint-disable @typescript-eslint/no-explicit-any -- Offline AWS/Kubernetes fixtures. */
import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {capacityConnectionUrl, capacityNetworkTemplate, prepareCapacityNetwork, validateCapacityConnection} from '../../src/utils/capacity-manager-network.js'

const input = {certificateArn: 'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000', hostname: 'controller.example.invalid', inboundCidrs: ['10.0.0.0/16'], region: 'us-east-1', stackName: 'example-cm-network', subnets: ['subnet-00000001', 'subnet-00000002'], vpcId: 'vpc-00000000'}
const connection = () => ({internalAlb: structuredClone(input), mode: 'internal-alb' as const})

describe('capacity-manager private network', () => {
  let root: string
  beforeEach(() => {root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-network-'))})
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('previews without AWS calls, no public DNS/certificate changes, and no GPU resources', () => {
    const result = prepareCapacityNetwork(root, connection(), 'test-deployment', 'chain', 'controller', false, {json() {throw new Error('No provider calls allowed')}})
    expect(result.applied).to.equal(false)
    const template = capacityNetworkTemplate(input)
    expect(template.Resources.LoadBalancer.Properties.Scheme).to.equal('internal')
    expect(template.Resources.PrivateZone.Properties).to.deep.include({Name: input.hostname, VPCs: [{VPCId: input.vpcId, VPCRegion: input.region}]})
    expect(Object.values(template.Resources).map((r: any) => r.Type)).not.to.include('AWS::EC2::Instance')
    expect(template.Resources.Listener.Properties.Port).to.equal(443)
    expect(template.Resources.TargetGroup.Properties.HealthCheckPath).to.equal('/')
    expect(() => capacityConnectionUrl(root, connection())).to.throw('until ready')
  })

  it('rejects ambiguous, insecure and mismatched network declarations', () => {
    for (const value of [
      {mode: 'existing-https', serverUrl: 'http://controller:3000'},
      {mode: 'existing-https', serverUrl: 'https://user:FAKE_SECRET@controller.invalid'},
      {internalAlb: input, mode: 'existing-https', serverUrl: 'https://controller.invalid'},
      {mode: 'internal-alb'},
      {internalAlb: {...input, inboundCidrs: ['0.0.0.0/0']}, mode: 'internal-alb'},
      {internalAlb: {...input, inboundCidrs: ['10.0.0.0/7']}, mode: 'internal-alb'},
      {internalAlb: {...input, region: 'us-west-2'}, mode: 'internal-alb'},
    ]) {
      expect(() => validateCapacityConnection(value as any)).to.throw().and.not.to.have.property('message', 'FAKE_SECRET')
    }

    expect(capacityConnectionUrl(root, {mode: 'existing-https', serverUrl: 'https://controller.example.invalid'})).to.equal('https://controller.example.invalid')
  })

  function provider() {
    const calls: string[][] = []
    let stack: any
    let template: any
    let foreignZone = false
    const aws = {json(args: string[]) {
      calls.push(args)
      switch (args.slice(0, 2).join(' ')) {
        case 'acm describe-certificate': { return {Certificate: {DomainValidationOptions: [{ValidationMethod: 'DNS', ValidationStatus: 'SUCCESS'}], NotAfter: Date.now() / 1000 + 86_400, Status: 'ISSUED', SubjectAlternativeNames: ['*.example.invalid'], Type: 'AMAZON_ISSUED'}}
        }

        case 'sts get-caller-identity': { return {Account: '000000000000'}
        }

        case 'ec2 describe-subnets': { return {Subnets: input.subnets.map((SubnetId, i) => ({AvailabilityZone: `us-east-1${i ? 'b' : 'a'}`, AvailableIpAddressCount: 100, MapPublicIpOnLaunch: false, State: 'available', SubnetId, VpcId: input.vpcId}))}
        }

        case 'ec2 describe-vpc-attribute': { return {EnableDnsHostnames: {Value: true}, EnableDnsSupport: {Value: true}}
        }

        case 'cloudformation list-stacks': { return {StackSummaries: stack ? [stack] : []}
        }

        case 'route53 list-hosted-zones-by-vpc': { return {HostedZoneSummaries: foreignZone ? [{Name: input.hostname + '.'}] : []}
        }

        case 'cloudformation create-stack': {
          const index = args.indexOf('--tags')
          const Tags = args.slice(index + 1, args.indexOf('--client-request-token')).map(v => {const [key, value] = v.split(','); return {Key: key.slice(4), Value: value.slice(6)}})
          template = JSON.parse(args[args.indexOf('--template-body') + 1])
          stack = {Outputs: [{OutputKey: 'Url', OutputValue: `https://${input.hostname}`}, {OutputKey: 'TargetGroupArn', OutputValue: 'arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/example/0000'}, {OutputKey: 'SecurityGroupId', OutputValue: 'sg-00000000'}], StackId: 'nonfunctional-stack-id', StackName: input.stackName, StackStatus: 'CREATE_IN_PROGRESS', Tags}
          return {StackId: stack.StackId}
        }

        case 'cloudformation describe-stacks': { return {Stacks: [stack]}
        }

        case 'cloudformation get-template': { return {TemplateBody: template}
        }

        default: { throw new Error('Unexpected provider mutation or read')
        }
      }
    }}
    return {aws, calls, corruptTemplate() {template.Resources.Listener.Properties.Port = 80}, foreignZone() {foreignZone = true}, get stack() {return stack}}
  }

  it('resumes an owned asynchronous stack and produces a private backend binding', () => {
    const mock = provider()
    const run = () => prepareCapacityNetwork(root, connection(), 'test-deployment', 'chain', 'controller', true, mock.aws)
    expect(run().status).to.equal('creating')
    expect(run().status).to.equal('CREATE_IN_PROGRESS')
    expect(() => capacityConnectionUrl(root, connection())).to.throw('not ready')
    mock.stack.StackStatus = 'CREATE_COMPLETE'
    expect(run().status).to.equal('ready')
    expect(capacityConnectionUrl(root, connection())).to.equal(`https://${input.hostname}`)
    expect(run().status).to.equal('ready')
    expect(mock.calls.filter(c => c[1] === 'create-stack')).to.have.length(1)
    const binding = JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/capacity-manager/dstack-targetgroupbinding.json'), 'utf8'))
    expect(binding.metadata.namespace).to.equal('chain')
    expect(binding.spec.serviceRef).to.deep.equal({name: 'controller', port: 3000})
    expect(binding.spec.networking.ingress[0].from[0].securityGroup.groupID).to.equal('sg-00000000')
    expect(() => capacityConnectionUrl(root, {...connection(), internalAlb: {...input, subnets: ['subnet-00000003', 'subnet-00000004']}})).to.throw('not ready')
    mock.corruptTemplate()
    expect(run).to.throw('template differs')
  })

  it('does not adopt stacks, shadow existing exact-host private zones or replay failed stacks', () => {
    const mock = provider()
    const run = () => prepareCapacityNetwork(root, connection(), 'test-deployment', 'chain', 'controller', true, mock.aws)
    run()
    mock.stack.StackStatus = 'ROLLBACK_COMPLETE'
    expect(run().status).to.equal('ROLLBACK_COMPLETE')
    mock.stack.Tags = []
    expect(run).to.throw('ownership or intent differs')
    expect(mock.calls.filter(c => c[1] === 'create-stack')).to.have.length(1)
    const second = provider()
    second.foreignZone()
    expect(() => prepareCapacityNetwork(root, connection(), 'test-deployment', 'chain', 'controller', true, second.aws)).to.throw('private zone already exists')
    expect(second.calls.some(c => c[1] === 'create-stack')).to.equal(false)
  })

  it('omits provider error contents', () => {
    expect(() => prepareCapacityNetwork(root, connection(), 'test-deployment', 'chain', 'controller', true, {json() {throw new Error('FAKE_PRIVATE_PROVIDER_RESPONSE')}})).to.throw('details omitted')
  })
})
