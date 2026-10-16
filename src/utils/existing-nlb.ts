/* eslint-disable @typescript-eslint/no-explicit-any -- AWS, Kubernetes and Helm JSON. */
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import {isIP} from 'node:net'

import type {BootnodePublicP2p, DeploymentSpec} from '../types/deployment-spec.js'

import {AwsCliRunner} from './aws-cli.js'
import {validateBootnodePublicP2p} from './bootnode-public-p2p.js'
import {resolveSdkRevision} from './spec-bootstrap.js'
import {specKubernetesTarget} from './spec-kubernetes-target.js'

const fail = (message: string): never => {throw new Error(`Existing NLB: ${message}`)}
const same = (a: string[], b: string[]): boolean => a.length === b.length && new Set(a).size === new Set(b).size && a.every(value => b.includes(value))
const get = (attributes: any[], key: string): string | undefined => attributes.find(item => item.Key === key)?.Value

export function existingNlbEntries(spec: DeploymentSpec): BootnodePublicP2p[] {
  validateBootnodePublicP2p(spec.bootnodePublicP2p, Array.from({length: spec.infrastructure.bootnodeCount}, (_, index) => index), spec.infrastructure.provider)
  const entries = spec.bootnodePublicP2p?.filter(entry => entry.enabled && entry.mode === 'existing') ?? []
  for (const entry of entries) {
    const {aws} = spec.infrastructure
    if (!aws || !entry.existingNlb!.loadBalancerArn.startsWith(`arn:aws:elasticloadbalancing:${aws.region}:${aws.accountId}:`)) fail(`bootnode ${entry.index}: NLB must belong to the spec AWS account and region`)
  }

  return entries
}

export function validateExistingNlbSdk(sdkDirectory: string, spec: DeploymentSpec): void {
  if (existingNlbEntries(spec).length === 0) return
  const revision = resolveSdkRevision(sdkDirectory, spec.templates?.sdkRevision)
  try {execFileSync('git', ['-C', sdkDirectory, 'cat-file', '-e', `${revision}:charts/l2-reth/templates/p2p-targetgroupbinding.yaml`], {stdio: 'pipe'})} catch {fail('selected SDK revision lacks existing bootnode NLB bindings; select the paired SDK release')}
}

function cidrNetwork(cidr: string): string {
  const [ip, bits] = cidr.split('/')
  if (isIP(ip) !== 4 || !/^(?:[1-9]|[12]\d|3[0-2])$/.test(bits ?? '')) return fail('source restrictions must be IPv4 CIDRs, without /0')
  const address = ip.split('.').reduce((number, octet) => number * 256 + Number(octet), 0)
  const block = 2 ** (32 - Number(bits))
  const network = Math.floor(address / block) * block
  return `${[24, 16, 8, 0].map(shift => Math.floor(network / 2 ** shift) % 256).join('.')}/${bits}`
}

/** Keep node identity unchanged; only replace the internal endpoint with verified EIPs. */
export function publicBootnodeEnodes(internalEnode: string, endpoints: string[]): string[] {
  const key = /^enode:\/\/([\dA-Fa-f]{128})@[^/]+$/.exec(internalEnode)?.[1]
  if (!key || endpoints.some(endpoint => !/^([\d.]+):30303$/.test(endpoint) || isIP(endpoint.split(':')[0]) !== 4)) fail('cannot export enodes without a saved public node identity and verified IPv4 endpoints')
  return endpoints.map(endpoint => `enode://${key}@${endpoint}`)
}

export interface VerifiedNlb {
  availabilityZones: string[]
  crossZone: boolean
  entry: BootnodePublicP2p
  podName: string
  publicEndpoints: string[]
  serviceName: string
}

/** No create, modify, register or delete provider calls. Empty target groups are valid before install. */
export function verifyExistingNlb(spec: DeploymentSpec, files: Record<string, string>, aws: Pick<AwsCliRunner, 'json'> = new AwsCliRunner()): VerifiedNlb[] {
  const entries = existingNlbEntries(spec)
  if (entries.length === 0) fail('select at least one enabled bootnodePublicP2p entry with mode existing')
  const read = (args: string[]): any => {
    try {return aws.json(args, {region: spec.infrastructure.aws!.region})} catch {return fail('AWS read failed; check identity, region and read permissions (provider output omitted)')}
  }

  if (read(['sts', 'get-caller-identity']).Account !== spec.infrastructure.aws!.accountId) fail('AWS caller account differs from the spec')
  const {cluster} = read(['eks', 'describe-cluster', '--name', spec.infrastructure.aws!.eksClusterName])
  const vpc = cluster?.resourcesVpcConfig?.vpcId
  if (!vpc) fail('selected EKS cluster VPC unavailable')
  const results: VerifiedNlb[] = []
  for (const entry of entries) {
    const config = entry.existingNlb!
    const file = `l2-reth-bootnode-production-${entry.index}.yaml`
    const values: any = yaml.load(files[file] ?? '')
    const p2p = values?.reth?.p2pExternal
    if (!p2p?.enabled || p2p.mode !== 'existing' || p2p.allowOpenPeering !== false || p2p.ordinal !== 0
      || p2p.existingNlb?.loadBalancerARN !== config.loadBalancerArn || p2p.existingNlb?.listenerARN !== config.listenerArn || p2p.existingNlb?.targetGroupARN !== config.targetGroupArn
      || !same(p2p.existingNlb?.securityGroupIds ?? [], config.securityGroupIds)
      || !same(p2p.sourceRanges ?? [], entry.sourceRanges!) || !same(p2p.subnets ?? [], entry.subnets!) || !same(p2p.eipAllocations ?? [], entry.eipAllocations!)) fail(`${file}: generated NLB values differ from spec; regenerate before checking`)
    if (Object.keys(p2p.annotations ?? {}).length > 0 || Object.keys(values.global?.annotations ?? {}).some(key => key.startsWith('service.beta.kubernetes.io/aws-load-balancer-'))) fail(`${file}: clear Service-owned NLB annotations before binding independent infrastructure`)
    if (values.role !== 'bootnode' || values.reth?.sequencer?.enabled === true || (values.reth?.ports?.p2p ?? 30_303) !== 30_303 || (values.service?.main?.type ?? 'ClusterIP') !== 'ClusterIP') fail(`${file}: existing NLB supports bootnode TCP30303 with an internal main Service only`)
    const name = values.global?.nameOverride || values.nameOverride || 'l2-reth'
    const release = `l2-reth-bootnode-${entry.index}`
    const fullname = String(values.global?.fullnameOverride || values.fullnameOverride || (release.includes(name) ? release : `${release}-${name}`)).slice(0, 63).replace(/-$/, '')
    const lb = read(['elbv2', 'describe-load-balancers', '--load-balancer-arns', config.loadBalancerArn]).LoadBalancers?.[0]
    if (lb?.LoadBalancerArn !== config.loadBalancerArn || lb.Type !== 'network' || lb.State?.Code !== 'active' || lb.Scheme !== 'internet-facing' || lb.IpAddressType !== 'ipv4' || lb.VpcId !== vpc) fail(`bootnode ${entry.index}: select an active internet-facing IPv4 NLB in the EKS VPC`)
    for (const arn of [config.loadBalancerArn, config.targetGroupArn]) {
      const tags = read(['elbv2', 'describe-tags', '--resource-arns', arn]).TagDescriptions?.[0]?.Tags
      if (!Array.isArray(tags) || tags.some((tag: any) => ['elbv2.k8s.aws/cluster', 'gateway.k8s.aws/stack', 'ingress.k8s.aws/stack', 'service.k8s.aws/stack'].includes(tag.Key))) fail('NLB and target group must be externally managed, without Kubernetes controller ownership tags; do not adopt an existing Service-owned NLB')
    }

    if (!same(lb.SecurityGroups ?? [], config.securityGroupIds)) fail('NLB attached security groups must exactly match existingNlb.securityGroupIds')
    const groups = read(['ec2', 'describe-security-groups', '--group-ids', ...config.securityGroupIds]).SecurityGroups
    if (!Array.isArray(groups) || !same(groups.map((group: any) => group.GroupId), config.securityGroupIds)) fail('NLB security groups unavailable')
    const allowed = new Set(entry.sourceRanges!.map(value => cidrNetwork(value)))
    const actual = new Set<string>()
    for (const group of groups) {
      if (group.VpcId !== vpc || group.OwnerId !== spec.infrastructure.aws!.accountId || !Array.isArray(group.IpPermissions)) fail('NLB security groups must belong to the configured account and VPC')
      for (const permission of group.IpPermissions) {
        if (!['6', 'tcp'].includes(permission.IpProtocol) || permission.FromPort !== 30_303 || permission.ToPort !== 30_303
          || permission.Ipv6Ranges?.length || permission.UserIdGroupPairs?.length || permission.PrefixListIds?.length) fail('NLB frontend ingress must allow only TCP30303 from explicit partner IPv4 CIDRs; no other ports, IPv6, SG or prefix-list sources')
        for (const range of permission.IpRanges ?? []) actual.add(cidrNetwork(range.CidrIp ?? ''))
      }
    }

    if (!same([...actual], [...allowed])) fail('effective NLB security-group ingress must exactly match the partner sourceRanges; update external infrastructure explicitly')
    const zones: any[] = lb.AvailabilityZones ?? []
    if (!same(zones.map(zone => zone.SubnetId), entry.subnets!)) fail('NLB subnets differ from declared subnets')
    const publicEndpoints: string[] = []
    for (const [index, subnet] of entry.subnets!.entries()) {
      const addresses = zones.find(zone => zone.SubnetId === subnet)?.LoadBalancerAddresses ?? []
      if (addresses.length !== 1 || addresses[0].AllocationId !== entry.eipAllocations![index] || isIP(addresses[0].IpAddress ?? '') !== 4) fail('each NLB subnet must use the declared EIP in matching order')
      publicEndpoints.push(`${addresses[0].IpAddress}:30303`)
    }

    const subnets = read(['ec2', 'describe-subnets', '--subnet-ids', ...entry.subnets!]).Subnets
    if (!Array.isArray(subnets) || !same(subnets.map((subnet: any) => subnet.SubnetId), entry.subnets!) || subnets.some((subnet: any) => subnet.VpcId !== vpc || subnet.OwnerId !== spec.infrastructure.aws!.accountId || !zones.some(zone => zone.SubnetId === subnet.SubnetId && zone.ZoneName === subnet.AvailabilityZone))) fail('NLB subnets/AZs must belong to the selected VPC and account')
    const listeners = read(['elbv2', 'describe-listeners', '--load-balancer-arn', config.loadBalancerArn]).Listeners
    const listener = listeners?.[0]
    if (listeners?.length !== 1 || listener.ListenerArn !== config.listenerArn || listener.LoadBalancerArn !== config.loadBalancerArn || listener.Protocol !== 'TCP' || listener.Port !== 30_303 || listener.Certificates?.length || listener.AlpnPolicy?.length) fail('each bootnode NLB must expose exactly its selected plain TCP30303 listener; TLS, UDP and additional listeners are not allowed')
    const action = listener.DefaultActions?.[0]
    const targets = action?.TargetGroupArn ? [action.TargetGroupArn] : (action?.ForwardConfig?.TargetGroups ?? []).map((target: any) => target.TargetGroupArn)
    if (listener.DefaultActions?.length !== 1 || action.Type !== 'forward' || !same(targets, [config.targetGroupArn])) fail('NLB listener must forward only to this bootnode target group')
    const tg = read(['elbv2', 'describe-target-groups', '--target-group-arns', config.targetGroupArn]).TargetGroups?.[0]
    if (tg?.TargetGroupArn !== config.targetGroupArn || tg.TargetType !== 'ip' || tg.Protocol !== 'TCP' || tg.Port !== 30_303 || (tg.IpAddressType ?? 'ipv4') !== 'ipv4' || tg.VpcId !== vpc || !same(tg.LoadBalancerArns ?? [], [config.loadBalancerArn]) || tg.HealthCheckProtocol !== 'TCP' || tg.HealthCheckPort !== 'traffic-port' || tg.HealthCheckEnabled !== true) fail('target group must be TCP30303/IP, TCP traffic-port health checked, attached only to this NLB in the EKS VPC')
    const attributes = read(['elbv2', 'describe-target-group-attributes', '--target-group-arn', config.targetGroupArn]).Attributes ?? []
    if (get(attributes, 'proxy_protocol_v2.enabled') !== 'false') fail('Proxy Protocol must be explicitly disabled on the target group')
    const lbAttributes = read(['elbv2', 'describe-load-balancer-attributes', '--load-balancer-arn', config.loadBalancerArn]).Attributes ?? []
    const crossZoneValue = get(attributes, 'load_balancing.cross_zone.enabled')
    const crossZone = crossZoneValue === 'true' || ((crossZoneValue === undefined || crossZoneValue === 'use_load_balancer_configuration') && get(lbAttributes, 'load_balancing.cross_zone.enabled') === 'true')
    if (zones.length > 1 && !crossZone) fail('a single designated bootnode with multiple NLB AZs requires cross-zone balancing; it does not replace enabling the pod AZ')
    results.push({availabilityZones: zones.map(zone => zone.ZoneName), crossZone, entry, podName: `${fullname}-0`, publicEndpoints, serviceName: `${fullname}-p2p`})
  }

  return results
}

/** Post-install read-only verification, not a substitute for partner RLPx/deny-source tests. */
export function verifyExistingNlbTargets(spec: DeploymentSpec, verified: VerifiedNlb[], aws: Pick<AwsCliRunner, 'json'> = new AwsCliRunner(), kube: (args: string[]) => any = args => JSON.parse(execFileSync('kubectl', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000}))): string[] {
  const {kubeContext, namespace} = specKubernetesTarget(spec)
  if (!kubeContext) fail('infrastructure.kubeContext is required')
  const read = (args: string[], namespaced = true): any => {
    try {return kube(['--context', kubeContext!, ...args, ...(namespaced ? ['-n', namespace] : []), '-o', 'json'])} catch {return fail('Kubernetes read failed; check context, CRD, binding and workload (provider output omitted)')}
  }

  let cluster: any
  try {cluster = aws.json(['eks', 'describe-cluster', '--name', spec.infrastructure.aws!.eksClusterName], {region: spec.infrastructure.aws!.region}).cluster} catch {return fail('cannot verify selected EKS cluster (provider output omitted)')}
  if (read(['config', 'view', '--minify'], false).clusters?.[0]?.cluster?.server !== cluster?.endpoint) fail('Kubernetes context does not address the spec EKS cluster')
  const bindings = read(['get', 'targetgroupbindings.elbv2.k8s.aws', '--all-namespaces'], false).items
  if (!Array.isArray(bindings)) fail('TargetGroupBindings unavailable')
  for (const {availabilityZones, entry, podName, serviceName} of verified) {
    const nlb = entry.existingNlb!
    const matching = bindings.filter((binding: any) => binding.spec?.targetGroupARN === nlb.targetGroupArn)
    const binding = matching[0]
    if (matching.length !== 1 || binding.metadata?.namespace !== namespace || binding.metadata?.deletionTimestamp || binding.spec?.targetType !== 'ip' || binding.spec.serviceRef?.name !== serviceName || binding.spec.serviceRef?.port !== 30_303) fail('expected exactly one live IP TargetGroupBinding for the dedicated bootnode Service')
    const networking = binding.spec.networking?.ingress
    if (networking?.length !== 1 || networking[0].ports?.length !== 1 || networking[0].ports[0].protocol !== 'TCP' || networking[0].ports[0].port !== 30_303 || !same((networking[0].from ?? []).map((source: any) => source.securityGroup?.groupID ?? ''), nlb.securityGroupIds)) fail('binding networking must authorize only the declared NLB security groups to backend TCP30303')
    const service = read(['get', 'service', serviceName])
    if (!service.metadata?.uid || service.spec?.type !== 'ClusterIP' || service.spec?.selector?.['statefulset.kubernetes.io/pod-name'] !== podName || service.spec?.ports?.length !== 1 || service.spec.ports[0].port !== 30_303 || service.spec.ports[0].targetPort !== 30_303 || (service.spec.ports[0].protocol ?? 'TCP') !== 'TCP') fail('P2P Service must select only the designated pod on TCP30303')
    const pod = read(['get', 'pod', podName])
    if (!pod.status?.conditions?.some((condition: any) => condition.type === 'Ready' && condition.status === 'True') || !pod.spec?.nodeName || isIP(pod.status?.podIP ?? '') !== 4) fail('designated bootnode pod must be ready with an IPv4 address')
    const node = read(['get', 'node', pod.spec.nodeName], false)
    if (!availabilityZones.includes(node.metadata?.labels?.['topology.kubernetes.io/zone'])) fail('bootnode pod AZ must be enabled on its NLB; cross-zone cannot fix a disabled target AZ')
    const slices = read(['get', 'endpointslices.discovery.k8s.io', '-l', `kubernetes.io/service-name=${serviceName}`]).items
    const ready = (slices ?? []).filter((slice: any) => !slice.metadata?.deletionTimestamp && slice.metadata?.ownerReferences?.some((owner: any) => owner.kind === 'Service' && owner.uid === service.metadata.uid)).flatMap((slice: any) => {
      if (!slice.ports?.some((port: any) => port.port === 30_303 && (port.protocol ?? 'TCP') === 'TCP')) return []
      return (slice.endpoints ?? []).filter((endpoint: any) => endpoint.conditions?.ready !== false && endpoint.conditions?.terminating !== true).flatMap((endpoint: any) => endpoint.addresses ?? [])
    })
    if (!same([...new Set<string>(ready)], [pod.status.podIP])) fail('Service endpoints must contain exactly the designated ready bootnode IP')
    let targets: any[]
    try {targets = aws.json(['elbv2', 'describe-target-health', '--target-group-arn', nlb.targetGroupArn], {region: spec.infrastructure.aws!.region}).TargetHealthDescriptions} catch {return fail('cannot read NLB target health (provider output omitted)')}
    if (targets?.length !== 1 || targets[0].Target?.Id !== pod.status.podIP || targets[0].Target?.Port !== 30_303 || targets[0].TargetHealth?.State !== 'healthy') fail('NLB must register exactly the designated bootnode IP/TCP30303 as healthy; wait for controller reconciliation')
  }

  return verified.map(item => item.serviceName)
}
