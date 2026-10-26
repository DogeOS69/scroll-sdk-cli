/* eslint-disable @typescript-eslint/no-explicit-any -- AWS, Kubernetes and Helm JSON. */
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import {isIP} from 'node:net'

import type {BootnodePublicP2p, DeploymentSpec} from '../types/deployment-spec.js'

import {AwsCliRunner} from './aws-cli.js'
import {readAwsResource} from './aws-resource-reader.js'
import {bootnodeP2pMode, validateBootnodePublicP2p} from './bootnode-public-p2p.js'
import {resolveSdkRevision} from './spec-bootstrap.js'

const fail = (message: string): never => {throw new Error(`Existing NLB: ${message}`)}

export function existingNlbEntries(spec: DeploymentSpec): BootnodePublicP2p[] {
  validateBootnodePublicP2p(spec.bootnodePublicP2p, Array.from({length: spec.infrastructure.bootnodeCount}, (_, index) => index), spec.infrastructure.provider)
  const entries = spec.bootnodePublicP2p?.filter(entry => entry.enabled && bootnodeP2pMode(entry) === 'existing') ?? []
  for (const entry of entries) {
    const {aws} = spec.infrastructure
    if (!aws || !entry.existingNlb!.targetGroupArn.startsWith(`arn:aws:elasticloadbalancing:${aws.region}:${aws.accountId}:`)) fail(`bootnode ${entry.index}: NLB must belong to the spec AWS account and region`)
  }

  return entries
}

export function validateExistingNlbSdk(sdkDirectory: string, spec: DeploymentSpec): void {
  if (existingNlbEntries(spec).length === 0) return
  const revision = resolveSdkRevision(sdkDirectory, spec.templates?.sdkRevision)
  try {execFileSync('git', ['-C', sdkDirectory, 'cat-file', '-e', `${revision}:charts/l2-reth/templates/p2p-targetgroupbinding.yaml`], {stdio: 'pipe'})} catch {fail('selected SDK revision lacks existing bootnode NLB bindings; select the paired SDK release')}
  let version: string | undefined
  try {
    const chart = yaml.load(execFileSync('git', ['-C', sdkDirectory, 'show', `${revision}:charts/l2-reth/Chart.yaml`], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})) as {version?: string}
    version = chart?.version
  } catch {fail('cannot read l2-reth chart version from selected SDK revision')}

  const parts = typeof version === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(version) : null
  if (!parts || (Number(parts[1]) === 0 && (Number(parts[2]) < 1 || (Number(parts[2]) === 1 && Number(parts[3]) < 11)))) fail('Minimal existing NLB references require l2-reth 0.1.11 or later; select the paired SDK revision')
}

export function publicBootnodeEnodes(internalEnode: string, endpoints: string[]): string[] {
  const key = /^enode:\/\/([\dA-Fa-f]{128})@[^/]+$/.exec(internalEnode)?.[1]
  if (!key || endpoints.some(endpoint => !/^([\d.]+):30303$/.test(endpoint) || isIP(endpoint.split(':')[0]) !== 4)) fail('cannot export enodes without a saved public node identity and verified IPv4 endpoints')
  return endpoints.map(endpoint => `enode://${key}@${endpoint}`)
}

export interface DiscoveredNlb {
  entry: BootnodePublicP2p
  publicEndpoints: string[]
}

/** Read endpoint facts for exported peer addresses. Infrastructure templates own network policy. */
export function discoverExistingNlb(spec: DeploymentSpec, aws: Pick<AwsCliRunner, 'json'> = new AwsCliRunner()): DiscoveredNlb[] {
  return existingNlbEntries(spec).map(entry => {
    const read = (args: string[]) => readAwsResource(aws, args, spec.infrastructure.aws!.region)
    const tg = read(['elbv2', 'describe-target-groups', '--target-group-arns', entry.existingNlb!.targetGroupArn]).TargetGroups?.[0]
    const arn = entry.existingNlb!.loadBalancerArn ?? (tg?.LoadBalancerArns?.length === 1 ? tg.LoadBalancerArns[0] : undefined)
    if (!arn) fail('supply loadBalancerArn when the target group does not identify a single load balancer')
    const lb = read(['elbv2', 'describe-load-balancers', '--load-balancer-arns', arn]).LoadBalancers?.[0]
    if (!lb?.LoadBalancerArn) fail('load balancer metadata is missing its ARN')
    const zones = lb.AvailabilityZones ?? []
    const publicEndpoints = zones.flatMap((zone: any) => (zone.LoadBalancerAddresses ?? []).filter((address: any) => isIP(address.IpAddress ?? '') === 4).map((address: any) => `${address.IpAddress}:30303`))
    if (publicEndpoints.length === 0) fail('load balancer metadata contains no public IPv4 endpoint')
    return {entry, publicEndpoints}
  })
}
