/* eslint-disable @typescript-eslint/no-explicit-any -- Kubernetes and AWS JSON responses. */
import {execFileSync} from 'node:child_process'
import {isIP} from 'node:net'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {AwsCliRunner} from './aws-cli.js'
import {validateExistingAlb} from './existing-alb.js'
import {specKubernetesTarget} from './spec-kubernetes-target.js'

const fail = (message: string): never => {throw new Error(`Existing ALB: ${message}`)}
const kubectlJson = (args: string[]): any => JSON.parse(execFileSync('kubectl', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000}))

function targetKey(address: string, port: number): string {
  const family = isIP(address)
  if (!family || !Number.isInteger(port) || port < 1 || port > 65_535) fail('invalid target IP or endpoint port')
  return `${family === 6 ? new URL(`http://[${address}]`).hostname : address}:${port}`
}

function serviceTargets(service: any, slices: any[], family: number): Set<string> {
  const targets = new Set<string>()
  for (const slice of slices) {
    if (slice.metadata?.deletionTimestamp || !slice.metadata?.ownerReferences?.some((owner: any) => owner.kind === 'Service' && owner.uid === service.metadata.uid)) continue
    const port = slice.ports?.find((port: any) => (port.name ?? '') === (service.selectedPort.name ?? '') && (port.protocol ?? 'TCP') === 'TCP')?.port
    if (port === undefined || port === null) continue
    for (const endpoint of slice.endpoints ?? []) {
      if (endpoint.conditions?.ready === false || endpoint.conditions?.terminating === true) continue
      for (const address of endpoint.addresses ?? []) if (isIP(address) === family) targets.add(targetKey(address, port))
    }
  }

  return targets
}

/** Installation checks require live bindings and exactly the current ready Service endpoints. */
export function verifyExistingAlbTargetHealth(
  spec: DeploymentSpec,
  aws: Pick<AwsCliRunner, 'json'> = new AwsCliRunner(),
  kube: (args: string[]) => any = kubectlJson,
): string[] {
  validateExistingAlb(spec)
  if (!spec.infrastructure.aws?.alb) fail('infrastructure.aws.alb is required')
  const {kubeContext, namespace} = specKubernetesTarget(spec)
  if (!kubeContext) fail('infrastructure.kubeContext is required for runtime verification')
  const read = (args: string[]): any => {
    try {return kube(['--context', kubeContext!, ...args, '-n', namespace, '-o', 'json'])} catch {return fail('cannot read installed bindings or Service endpoints (provider output omitted)')}
  }

  const bindings = read(['get', 'targetgroupbindings.elbv2.k8s.aws']).items
  if (!Array.isArray(bindings)) fail('installed TargetGroupBindings unavailable')
  const healthy: string[] = []
  for (const [name, binding] of Object.entries(spec.infrastructure.aws!.alb!.bindings)) {
    const matching = bindings.filter((item: any) => item.spec?.targetGroupARN === binding.targetGroupArn)
    if (matching.length !== 1 || matching[0].metadata?.deletionTimestamp || matching[0].spec.targetType !== 'ip'
      || matching[0].spec.serviceRef?.name !== binding.serviceRef.name || matching[0].spec.serviceRef?.port !== binding.serviceRef.port) {
      fail(`${name}: expected one installed IP TargetGroupBinding matching the selected target group and Service reference`)
    }

    const service = read(['get', 'service', binding.serviceRef.name])
    const selectedPort = service.spec?.ports?.find((port: any) => port.port === binding.serviceRef.port && (port.protocol ?? 'TCP') === 'TCP')
    if (!service.metadata?.uid || service.spec?.type !== 'ClusterIP' || Object.keys(service.spec?.selector ?? {}).length === 0 || !selectedPort) fail(`${name}: selected ClusterIP Service or TCP port is unavailable`)
    const slices = read(['get', 'endpointslices.discovery.k8s.io', '-l', `kubernetes.io/service-name=${binding.serviceRef.name}`]).items
    if (!Array.isArray(slices)) fail(`${name}: Service EndpointSlices unavailable`)
    let group: any
    try {group = aws.json(['elbv2', 'describe-target-groups', '--target-group-arns', binding.targetGroupArn], {region: spec.infrastructure.aws!.region}).TargetGroups?.[0]} catch {return fail(`${name}: cannot read target group address type (provider output omitted)`)}
    if (group?.TargetGroupArn !== binding.targetGroupArn || !['ipv4', 'ipv6'].includes(group.IpAddressType ?? 'ipv4')) fail(`${name}: target group address type unavailable`)
    const expected = serviceTargets({...service, selectedPort}, slices, group.IpAddressType === 'ipv6' ? 6 : 4)
    if (expected.size === 0) fail(`${name}: Service has no ready endpoints for the selected port`)
    let targets: any[]
    try {targets = aws.json(['elbv2', 'describe-target-health', '--target-group-arn', binding.targetGroupArn], {region: spec.infrastructure.aws!.region}).TargetHealthDescriptions} catch {return fail(`${name}: cannot read target health (provider output omitted)`)}
    if (!Array.isArray(targets) || targets.length === 0 || targets.some(target => target.TargetHealth?.State !== 'healthy')) fail(`${name}: target group must contain healthy targets only; check rollout, security groups and NetworkPolicy`)
    const actual = new Set(targets.map(target => targetKey(target.Target?.Id ?? '', target.Target?.Port)))
    if (actual.size !== expected.size || [...actual].some(target => !expected.has(target))) fail(`${name}: registered target IPs and ports do not match the current ready Service endpoints; wait for reconciliation or correct the binding`)
    healthy.push(name)
  }

  return healthy
}
