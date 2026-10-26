/* eslint-disable @typescript-eslint/no-explicit-any -- Offline AWS and Helm fixtures. */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {discoverAwsResources, projectDiscoveredAwsValues} from '../../src/utils/aws-resource-discovery.js'
import {readAwsResource} from '../../src/utils/aws-resource-reader.js'

describe('AWS metadata to production values', () => {
  let root: string
  beforeEach(() => {root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-projection-')); fs.mkdirSync(path.join(root, '.data')); fs.mkdirSync(path.join(root, 'values'))})
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  it('projects actual bucket regions, ALB peers and NLB groups without policy or network audits', () => {
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), '[ethereumDa.blobArchive.s3]\nbucket="fixture-archive"\nregion="us-east-2"\n')
    fs.writeFileSync(path.join(root, 'values/tso-service-production.yaml'), 'resources: {requests: {cpu: "2"}}\nnetworkPolicy: {allowFrom: {other: [{podSelector: {}}]}}\n')
    fs.writeFileSync(path.join(root, 'values/l2-reth-bootnode-production-0.yaml'), 'reth: {nodekeySecret: keep}\n')
    const spec = {bootnodePublicP2p: [{enabled: true, existingNlb: {targetGroupArn: 'tg'}, index: 0}], infrastructure: {aws: {alb: {bindings: {'tso-service': {endpoint: 'tso'}}, endpoints: {tso: {loadBalancerArn: 'alb'}}}, region: 'us-east-2'}, provider: 'aws'}} as unknown as DeploymentSpec
    const calls: string[][] = []
    const aws = {json(args: string[]) {
      calls.push(args)
      switch (args[1]) {
        case 'get-bucket-location': { return {LocationConstraint: null}
        }

        case 'describe-load-balancers': { return {LoadBalancers: [{AvailabilityZones: [{SubnetId: 'subnet-fixture'}], DNSName: 'fixture.elb.invalid', LoadBalancerArn: args[3], SecurityGroups: ['sg-discovered'], VpcId: 'vpc-fixture'}]}
        }

        case 'describe-subnets': { return {Subnets: [{CidrBlock: '10.2.0.0/24'}]}
        }

        case 'describe-target-groups': { return {TargetGroups: [{LoadBalancerArns: ['nlb'], TargetGroupArn: 'tg'}]}
        }

        default: { throw new Error('Unexpected audit or mutation')
        }
      }
    }}
    discoverAwsResources(root, spec, aws as any)
    const config = toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')) as any
    expect(config.ethereumDa.blobArchive.s3.region).eq('us-east-1')
    projectDiscoveredAwsValues(root, path.join(root, 'values'), spec)
    const tso: any = yaml.load(fs.readFileSync(path.join(root, 'values/tso-service-production.yaml'), 'utf8'))
    const bootnode: any = yaml.load(fs.readFileSync(path.join(root, 'values/l2-reth-bootnode-production-0.yaml'), 'utf8'))
    expect(tso.networkPolicy.allowFrom.edge).deep.eq([{ipBlock: {cidr: '10.2.0.0/24'}}])
    expect(tso.resources.requests.cpu).eq('2')
    expect(tso.networkPolicy.allowFrom.other).deep.eq([{podSelector: {}}])
    expect(bootnode.reth.p2pExternal.existingNlb).deep.eq({securityGroupIds: ['sg-discovered'], targetGroupARN: 'tg'})
    expect(bootnode.reth.nodekeySecret).eq('keep')
    const before = fs.readFileSync(path.join(root, 'values/tso-service-production.yaml'), 'utf8')
    projectDiscoveredAwsValues(root, path.join(root, 'values'), spec)
    expect(fs.readFileSync(path.join(root, 'values/tso-service-production.yaml'), 'utf8')).eq(before)
    expect(calls.every(args => ['describe-load-balancers', 'describe-subnets', 'describe-target-groups', 'get-bucket-location'].includes(args[1]))).true
  })
  it('updates derived proof consumers and archive URLs while preserving custom gateways', () => {
    const initial = {
      ethereumDa: {blobArchive: {s3: {bucket: 'fixture-archive', publicBaseUrl: 'https://fixture-archive.s3.us-east-2.amazonaws.com', region: 'us-east-2'}}},
      proof_topology: {active: {artifactStore: {bucket: 'fixture-proof', endpointUrl: 'https://gateway.example.invalid', region: 'us-east-2'}}, deployment: {publicS3EndpointUrl: 'https://s3.us-east-2.amazonaws.com'}},
      proofArtifacts: {s3: {bucket: 'fixture-proof', region: 'us-east-2'}},
      proofDeployment: {coordinator: {artifactStore: {bucket: 'fixture-proof', endpointUrl: 'https://s3.us-east-2.amazonaws.com', region: 'us-east-2'}}},
    }
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), toml.stringify(initial))
    const spec = {infrastructure: {aws: {region: 'us-east-2'}}} as DeploymentSpec
    discoverAwsResources(root, spec, {json() {return {LocationConstraint: null}}} as any)
    const config: any = toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8'))
    expect(config.ethereumDa.blobArchive.s3.publicBaseUrl).eq('https://fixture-archive.s3.us-east-1.amazonaws.com')
    expect(config.proofDeployment.coordinator.artifactStore).include({endpointUrl: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1'})
    expect(config.proof_topology.active.artifactStore).include({endpointUrl: 'https://gateway.example.invalid', region: 'us-east-1'})
    expect(config.proof_topology.deployment.publicS3EndpointUrl).eq('https://s3.us-east-1.amazonaws.com')
  })
  it('blocks mutation calls and redacts failed provider responses', () => {
    const aws = {json() {throw new Error('FAKE_PRIVATE_PROVIDER_DETAIL')}}
    expect(() => readAwsResource(aws, ['kms', 'create-key'], 'us-east-2')).throw('only supports')
    expect(() => readAwsResource(aws, ['iam', 'get-role'], 'us-east-2')).throw('Cannot read AWS resource')
  })
})
