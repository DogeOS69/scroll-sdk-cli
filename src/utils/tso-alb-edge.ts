/* eslint-disable @typescript-eslint/no-explicit-any -- Kubernetes and AWS discovery documents. */
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import {isIPv4} from 'node:net'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {AwsCliRunner} from './aws-cli.js'
import {localPath, privateWrite, writeJson} from './preparation-io.js'
import {validateServiceNetworkPolicy} from './service-network-policy.js'
import {specKubernetesTarget} from './spec-kubernetes-target.js'

const SUBNETS = 'alb.ingress.kubernetes.io/subnets'
const RECEIPT = '.scrollsdk/tso-alb-edge.json'
export interface TsoEdgeDependencies {
  aws?: Pick<AwsCliRunner, 'json'>
  kubectl?: (args: string[]) => string
}

/** Only remote reads. The caller decides whether to commit this local projection. */
export function planTsoAlbEdge(root: string, spec: DeploymentSpec, dependencies: TsoEdgeDependencies = {}, valuesDirectory = 'values'): {receipt: Record<string, unknown>; values: Record<string, any>} {
  const input = spec.preparation?.tsoAlbEdge
  const awsConfig = spec.infrastructure.aws
  const {kubeContext, namespace} = specKubernetesTarget(spec)
  if (!input?.enabled || !awsConfig?.region || !awsConfig.eksClusterName || !kubeContext) throw new Error('TSO ALB discovery requires enabled preparation.tsoAlbEdge and explicit AWS cluster, region and Kubernetes context')
  const valuesFile = path.join(valuesDirectory, 'tso-service-production.yaml')
  const values = yaml.load(fs.readFileSync(localPath(root, valuesFile), 'utf8')) as any
  const ingress = values?.ingress?.main
  if (ingress?.enabled !== true || (ingress.ingressClassName ?? 'alb') !== 'alb') throw new Error('TSO ALB discovery requires an enabled ALB ingress')
  const scheme = ingress.annotations?.['alb.ingress.kubernetes.io/scheme'] ?? 'internet-facing'
  if (!['internal', 'internet-facing'].includes(scheme)) throw new Error('Unsupported TSO ALB scheme')
  const aws = dependencies.aws ?? new AwsCliRunner(input.awsProfile)
  const readAws = (args: string[]): any => {
    try {return aws.json(args, {region: awsConfig.region})} catch {throw new Error(`TSO ALB discovery: ${args[0]} ${args[1]} failed (provider details omitted)`)}
  }

  const kubectl = dependencies.kubectl ?? ((args: string[]) => execFileSync('kubectl', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000}))
  const readKube = (args: string[]): string => {
    try {return kubectl(['--context', kubeContext, ...args]).trim()} catch {throw new Error('TSO ALB discovery: Kubernetes read failed (details omitted)')}
  }

  const {cluster} = readAws(['eks', 'describe-cluster', '--name', awsConfig.eksClusterName])
  const vpc = cluster?.resourcesVpcConfig?.vpcId
  if (!/^vpc-[\da-f]+$/.test(vpc ?? '') || !cluster.endpoint) throw new Error('EKS discovery did not return a VPC and endpoint')
  if (readKube(['config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}']) !== cluster.endpoint) throw new Error('Selected Kubernetes context does not address the selected EKS cluster')
  const file = localPath(root, RECEIPT)
  let previous: any
  if (fs.existsSync(file)) {
    try {previous = JSON.parse(fs.readFileSync(file, 'utf8'))} catch {throw new Error('Invalid TSO ALB discovery receipt')}
    if (previous.schema !== 'scrollsdk/tso-alb-edge/v1' || previous.cluster !== awsConfig.eksClusterName || previous.region !== awsConfig.region || previous.namespace !== namespace || previous.vpc !== vpc || !Array.isArray(previous.managedCidrs) || !Array.isArray(previous.subnets) || !Array.isArray(previous.actualSubnets)) throw new Error('TSO ALB discovery receipt belongs to another target or is malformed')
    if ((previous.valuesFile ?? 'values/tso-service-production.yaml') !== valuesFile) throw new Error('TSO ALB discovery receipt belongs to another values directory')
  }

  const name = input.ingressName ?? values.global?.fullnameOverride ?? values.fullnameOverride ?? 'tso-service'
  if (typeof name !== 'string' || !/^[\da-z](?:[\d.a-z-]*[\da-z])?$/.test(name)) throw new Error('Invalid TSO ingress resource name')
  const rawIngress = readKube(['get', 'ingress', name, '--namespace', namespace, '--ignore-not-found=true', '-o', 'json'])
  let live: any
  try {live = rawIngress ? JSON.parse(rawIngress) : undefined} catch {throw new Error('Invalid Kubernetes ingress response')}
  const hosts = live?.status?.loadBalancer?.ingress ?? []
  let actual: string[] = []
  if (hosts.length > 0) {
    if (hosts.length !== 1 || !/^[\d.a-z-]+\.elb\.amazonaws\.com$/.test(hosts[0].hostname ?? '')) throw new Error('TSO ingress does not identify one AWS ALB')
    const balances = readAws(['elbv2', 'describe-load-balancers']).LoadBalancers?.filter((lb: any) => lb.DNSName === hosts[0].hostname)
    if (balances?.length !== 1 || balances[0].Type !== 'application' || balances[0].VpcId !== vpc || balances[0].Scheme !== scheme) throw new Error('TSO ALB does not match the selected VPC and ingress scheme')
    actual = balances[0].AvailabilityZones.map((zone: any) => zone.SubnetId)
  }

  const annotation = ingress.annotations?.[SUBNETS]
  let selected: string[] = annotation === undefined ? actual : typeof annotation === 'string' ? annotation.split(',').map((value: string) => value.trim()) : []
  if (annotation !== undefined && (selected.length === 0 || selected.some(value => !/^subnet-[\da-f]+$/.test(value)))) throw new Error('TSO subnet annotation must list explicit subnet IDs')
  // Follow a changed live ALB only when the annotation is still our last projection.
  // An operator-edited annotation expresses a desired subnet migration instead.
  if (actual.length > 0 && previous && [...selected].sort().join(',') === [...previous.subnets].sort().join(',') && [...actual].sort().join(',') !== [...previous.actualSubnets].sort().join(',')) selected = actual
  let subnets: any[]
  if (selected.length > 0) {
    if (new Set(selected).size !== selected.length || selected.some(value => !/^subnet-[\da-f]+$/.test(value))) throw new Error('Invalid or duplicate selected ALB subnet IDs')
    subnets = readAws(['ec2', 'describe-subnets', '--subnet-ids', ...selected]).Subnets
    if (!Array.isArray(subnets) || subnets.length !== selected.length || subnets.some(subnet => !selected.includes(subnet.SubnetId))) throw new Error('AWS did not return every selected ALB subnet')
  } else {
    const role = `kubernetes.io/role/${scheme === 'internal' ? 'internal-elb' : 'elb'}`
    const candidates = readAws(['ec2', 'describe-subnets', '--filters', `Name=vpc-id,Values=${vpc}`, `Name=tag-key,Values=${role}`]).Subnets
    if (!Array.isArray(candidates)) throw new Error('AWS did not return ALB subnet candidates')
    const byZone = new Map<string, any>()
    for (const subnet of [...candidates].sort((a, b) => String(a.SubnetId).localeCompare(String(b.SubnetId)))) {
      const tags = Object.fromEntries((subnet.Tags ?? []).map((tag: any) => [tag.Key, tag.Value]))
      const clusterTags = Object.keys(tags).filter(key => key.startsWith('kubernetes.io/cluster/'))
      if (subnet.VpcId !== vpc || subnet.State !== 'available' || subnet.AvailableIpAddressCount < 8 || !['', '1'].includes(tags[role])
        || (clusterTags.length > 0 && !clusterTags.includes(`kubernetes.io/cluster/${awsConfig.eksClusterName}`))) continue
      if (!byZone.has(subnet.AvailabilityZone)) byZone.set(subnet.AvailabilityZone, subnet)
    }

    subnets = [...byZone.values()]
    selected = subnets.map(subnet => subnet.SubnetId)
  }

  if (subnets.length < 2 || new Set(subnets.map(subnet => subnet.AvailabilityZone)).size !== subnets.length) throw new Error('Select at least two ALB subnets, with exactly one per availability zone')
  // During an intentional migration both the current and desired ALB need access.
  // The next reconciliation drops the old managed CIDRs once AWS reports the move.
  const pending = actual.filter(id => !selected.includes(id))
  if (pending.length > 0) {
    const old = readAws(['ec2', 'describe-subnets', '--subnet-ids', ...pending]).Subnets
    if (!Array.isArray(old) || old.length !== pending.length || old.some(subnet => !pending.includes(subnet.SubnetId))) throw new Error('AWS did not return every current ALB subnet')
    subnets = [...subnets, ...old]
  }

  const cidrs = subnets.map(subnet => {
    const [address, bits, extra] = String(subnet.CidrBlock).split('/')
    if (subnet.VpcId !== vpc || subnet.State !== 'available' || !isIPv4(address) || extra !== undefined || !/^\d+$/.test(bits ?? '') || Number(bits) < 1 || Number(bits) > 27) throw new Error('Selected ALB subnet has invalid VPC, state or IPv4 CIDR')
    return subnet.CidrBlock as string
  }).sort()
  const peers = values.networkPolicy?.allowFrom?.edge ?? []
  if (!Array.isArray(peers)) throw new Error('TSO edge peers must be a list')
  const preserved = peers.filter((peer: any) => {
    const cidr = peer?.ipBlock?.cidr
    return !(Object.keys(peer ?? {}).length === 1 && Object.keys(peer.ipBlock ?? {}).length === 1
      && (previous?.managedCidrs.includes(cidr) || cidr === '<TODO>'))
  })
  values.networkPolicy ??= {}; values.networkPolicy.allowFrom ??= {}
  const managedCidrs = cidrs.filter(cidr => !preserved.some((peer: any) => peer.ipBlock?.cidr === cidr && !peer.ipBlock.except))
  values.networkPolicy.allowFrom.edge = [...preserved, ...managedCidrs.map(cidr => ({ipBlock: {cidr}}))]
  ingress.annotations ??= {}; ingress.annotations[SUBNETS] = [...selected].sort().join(',')
  validateServiceNetworkPolicy(values, 'tso-service')
  return {receipt: {actualSubnets: actual.sort(), cluster: awsConfig.eksClusterName, managedCidrs, namespace, region: awsConfig.region, schema: 'scrollsdk/tso-alb-edge/v1', subnets: [...selected].sort(), valuesFile, vpc}, values}
}

/** Run inside prep-charts' filesystem transaction, never in proof preparation. */
export function reconcileTsoAlbEdge(root: string, dependencies?: TsoEdgeDependencies, valuesDirectory = 'values'): void {
  const intent = localPath(root, '.scrollsdk/intent.json')
  if (!fs.existsSync(intent)) return
  const spec = JSON.parse(fs.readFileSync(intent, 'utf8')) as DeploymentSpec
  if (!spec.preparation?.tsoAlbEdge?.enabled) return
  const result = planTsoAlbEdge(root, spec, dependencies, valuesDirectory)
  privateWrite(localPath(root, path.join(valuesDirectory, 'tso-service-production.yaml')), yaml.dump(result.values, {lineWidth: -1, noRefs: true}))
  writeJson(localPath(root, RECEIPT), result.receipt)
}
