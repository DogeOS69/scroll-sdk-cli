/* eslint-disable @typescript-eslint/no-explicit-any -- AWS and Kubernetes fixtures. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {GenerationTransaction} from '../../src/utils/generation-transaction.js'
import {planTsoAlbEdge, reconcileTsoAlbEdge} from '../../src/utils/tso-alb-edge.js'

const annotation = 'alb.ingress.kubernetes.io/subnets'
describe('TSO ALB edge discovery', () => {
  let root: string
  let spec: DeploymentSpec
  let values: any
  let subnets: any[]
  let actual: string[]
  let endpoint: string
  let calls: string[][]
  const write = () => fs.writeFileSync(path.join(root, 'values/tso-service-production.yaml'), yaml.dump(values))
  const dependencies = () => ({
    aws: {json(args: string[]) {
      calls.push(args)
      if (args[0] === 'eks') return {cluster: {endpoint: 'https://eks.example.invalid', resourcesVpcConfig: {vpcId: 'vpc-abcd'}}}
      if (args[0] === 'elbv2') return {LoadBalancers: [{AvailabilityZones: actual.map(SubnetId => ({SubnetId})), DNSName: 'test.elb.amazonaws.com', Scheme: 'internet-facing', Type: 'application', VpcId: 'vpc-abcd'}]}
      const ids = args.indexOf('--subnet-ids')
      return {Subnets: ids === -1 ? subnets : subnets.filter(subnet => args.slice(ids + 1).includes(subnet.SubnetId))}
    }},
    kubectl(args: string[]) {
      expect(args.slice(0, 2)).to.deep.equal(['--context', 'selected'])
      if (args.includes('config')) return endpoint
      expect(args).to.include('devnet')
      return actual.length > 0 ? JSON.stringify({status: {loadBalancer: {ingress: [{hostname: 'test.elb.amazonaws.com'}]}}}) : ''
    },
  })
  const persist = (result: ReturnType<typeof planTsoAlbEdge>) => {
    values = result.values; write()
    fs.writeFileSync(path.join(root, '.scrollsdk/tso-alb-edge.json'), JSON.stringify(result.receipt))
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tso-edge-'))
    fs.mkdirSync(path.join(root, 'values')); fs.mkdirSync(path.join(root, '.scrollsdk'))
    spec = {infrastructure: {aws: {eksClusterName: 'test', region: 'us-east-1'}, kubeContext: 'selected', namespace: 'devnet'}, preparation: {tsoAlbEdge: {enabled: true}}} as DeploymentSpec
    const pod = {podSelector: {matchLabels: {app: 'internal'}}}
    values = {ingress: {main: {annotations: {}, enabled: true, ingressClassName: 'alb'}}, networkPolicy: {allowFrom: {edge: [{ipBlock: {cidr: '<TODO>'}}, {ipBlock: {cidr: '192.0.2.0/24'}}], signers: [pod], withdrawalProcessor: [pod]}, enabled: true}}
    subnets = [1, 2, 3].map(index => ({AvailabilityZone: `us-east-1${index === 3 ? 'b' : 'a'}`, AvailableIpAddressCount: 20, CidrBlock: `10.0.${index}.0/24`, State: 'available', SubnetId: `subnet-a${index}`, Tags: [{Key: 'kubernetes.io/role/elb', Value: '1'}], VpcId: 'vpc-abcd'}))
    actual = []; endpoint = 'https://eks.example.invalid'; calls = []; write()
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  it('selects one eligible subnet per AZ and pins the exact ALB annotation', () => {
    const result = planTsoAlbEdge(root, spec, dependencies())
    expect(result.values.ingress.main.annotations[annotation]).to.equal('subnet-a1,subnet-a3')
    expect(result.values.networkPolicy.allowFrom.edge).to.deep.equal(['192.0.2.0/24', '10.0.1.0/24', '10.0.3.0/24'].map(cidr => ({ipBlock: {cidr}})))
    expect(result.values.networkPolicy.allowFrom.signers).to.deep.equal(values.networkPolicy.allowFrom.signers)
    expect(calls.every(args => ['describe-cluster', 'describe-load-balancers', 'describe-subnets'].includes(args[1]))).to.equal(true)
    expect(fs.existsSync(path.join(root, '.scrollsdk/tso-alb-edge.json'))).to.equal(false)
  })
  it('uses actual ALB subnets and reconciles a later subnet change without removing operator peers', () => {
    actual = ['subnet-a2', 'subnet-a3']
    // This existing operator CIDR must remain operator-owned even when it overlaps the ALB.
    values.networkPolicy.allowFrom.edge.push({ipBlock: {cidr: '10.0.2.0/24'}}); write()
    persist(planTsoAlbEdge(root, spec, dependencies()))
    expect(values.ingress.main.annotations[annotation]).to.equal('subnet-a2,subnet-a3')
    actual = ['subnet-a1', 'subnet-a3']
    const result = planTsoAlbEdge(root, spec, dependencies())
    expect(result.values.ingress.main.annotations[annotation]).to.equal('subnet-a1,subnet-a3')
    expect(result.values.networkPolicy.allowFrom.edge).to.deep.include({ipBlock: {cidr: '10.0.2.0/24'}})
    expect(result.receipt.managedCidrs).to.deep.equal(['10.0.1.0/24', '10.0.3.0/24'])
    persist(result)
    actual = ['subnet-a2', 'subnet-a3']
    expect(planTsoAlbEdge(root, spec, dependencies()).values.networkPolicy.allowFrom.edge).not.to.deep.include({ipBlock: {cidr: '10.0.1.0/24'}})
  })
  it('keeps an operator-requested subnet migration while the live ALB has not changed yet', () => {
    actual = ['subnet-a1', 'subnet-a3']; persist(planTsoAlbEdge(root, spec, dependencies()))
    values.ingress.main.annotations[annotation] = 'subnet-a2,subnet-a3'; write()
    persist(planTsoAlbEdge(root, spec, dependencies()))
    expect(planTsoAlbEdge(root, spec, dependencies()).values.ingress.main.annotations[annotation]).to.equal('subnet-a2,subnet-a3')
  })
  it('rejects wrong context, VPC, duplicate AZs, and incomplete subnet results', () => {
    endpoint = 'https://wrong.example.invalid'
    expect(() => planTsoAlbEdge(root, spec, dependencies())).to.throw('does not address')
    endpoint = 'https://eks.example.invalid'
    values.ingress.main.annotations[annotation] = 'subnet-a1,subnet-a3'; write()
    subnets[0].VpcId = 'vpc-ffff'
    expect(() => planTsoAlbEdge(root, spec, dependencies())).to.throw('invalid VPC')
    subnets[0].VpcId = 'vpc-abcd'; subnets[2].AvailabilityZone = 'us-east-1a'
    expect(() => planTsoAlbEdge(root, spec, dependencies())).to.throw('one per availability zone')
    subnets.pop()
    expect(() => planTsoAlbEdge(root, spec, dependencies())).to.throw('every selected')
  })
  it('excludes subnets belonging to another cluster or with insufficient free addresses', () => {
    subnets[0].Tags.push({Key: 'kubernetes.io/cluster/other', Value: 'owned'})
    expect(planTsoAlbEdge(root, spec, dependencies()).values.ingress.main.annotations[annotation]).to.equal('subnet-a2,subnet-a3')
    subnets[1].AvailableIpAddressCount = 7
    expect(() => planTsoAlbEdge(root, spec, dependencies())).to.throw('at least two')
  })
  it('rolls back values and receipt together when a later rendering step fails', () => {
    fs.writeFileSync(path.join(root, '.scrollsdk/intent.json'), JSON.stringify(spec))
    const before = fs.readFileSync(path.join(root, 'values/tso-service-production.yaml'))
    const transaction = GenerationTransaction.begin(root)
    reconcileTsoAlbEdge(transaction.stagingRoot, dependencies())
    transaction.rollback()
    expect(fs.readFileSync(path.join(root, 'values/tso-service-production.yaml')).equals(before)).to.equal(true)
    expect(fs.existsSync(path.join(root, '.scrollsdk/tso-alb-edge.json'))).to.equal(false)
    const success = GenerationTransaction.begin(root)
    reconcileTsoAlbEdge(success.stagingRoot, dependencies()); success.commit()
    expect(fs.existsSync(path.join(root, '.scrollsdk/tso-alb-edge.json'))).to.equal(true)
  })
  it('performs no discovery without explicit enablement', () => {
    fs.writeFileSync(path.join(root, '.scrollsdk/intent.json'), JSON.stringify({...spec, preparation: {}}))
    reconcileTsoAlbEdge(root, {aws: {json() {throw new Error('unexpected AWS read')}}, kubectl() {throw new Error('unexpected Kubernetes read')}})
    expect(calls).to.deep.equal([])
  })
  it('honors custom prep-charts values directories and binds ownership to the selected file', () => {
    fs.writeFileSync(path.join(root, '.scrollsdk/intent.json'), JSON.stringify(spec))
    const original = fs.readFileSync(path.join(root, 'values/tso-service-production.yaml'))
    fs.mkdirSync(path.join(root, 'custom-values'))
    fs.writeFileSync(path.join(root, 'custom-values/tso-service-production.yaml'), original)
    reconcileTsoAlbEdge(root, dependencies(), 'custom-values')
    expect(fs.readFileSync(path.join(root, 'values/tso-service-production.yaml')).equals(original)).to.equal(true)
    const custom = yaml.load(fs.readFileSync(path.join(root, 'custom-values/tso-service-production.yaml'), 'utf8')) as any
    expect(custom.ingress.main.annotations[annotation]).to.equal('subnet-a1,subnet-a3')
    expect(() => reconcileTsoAlbEdge(root, dependencies())).to.throw('another values directory')
  })
})
