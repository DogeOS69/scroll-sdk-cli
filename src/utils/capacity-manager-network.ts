/* eslint-disable @typescript-eslint/no-explicit-any -- Read-only AWS network metadata. */
import fs from 'node:fs'
import {isDeepStrictEqual} from 'node:util'

import type {CapacityManagerConfig} from '../types/capacity-manager.js'
import type {DeploymentSpec} from '../types/deployment-spec.js'

import {AwsCliRunner} from './aws-cli.js'
import {readAwsResource} from './aws-resource-reader.js'
import {localPath, writeJson} from './preparation-io.js'

type Connection = NonNullable<CapacityManagerConfig['connection']>
export const CAPACITY_NETWORK = '.scrollsdk/capacity-manager/network.json'
const SCHEMA = 'scrollsdk-capacity-network-v3'

export function validateCapacityConnection(connection?: Connection): void {
  if (!connection) return
  if (connection.mode === 'internal-alb' || connection.internalAlb) throw new Error('Prepare the dstack ALB externally; replace internal-alb with existing-alb and its resource ARNs')
  let url: URL
  try {url = new URL(connection.serverUrl!)} catch {throw new Error('connection.serverUrl must be credential-free HTTPS')}
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[\s#?\\]/.test(connection.serverUrl!)) throw new Error('connection.serverUrl must be credential-free HTTPS')
  if (connection.mode === 'existing-https' && !connection.existingAlb) return
  if (connection.mode !== 'existing-alb' || !connection.existingAlb || url.pathname !== '/' || url.port && url.port !== '443') throw new Error('Select existing-https or existing-alb with an HTTPS origin and matching resource references')
  for (const [field, kind] of [['loadBalancerArn', 'loadbalancer/app'], ['listenerArn', 'listener/app'], ['targetGroupArn', 'targetgroup']] as const) {
    if (!new RegExp(`^arn:aws:elasticloadbalancing:[a-z0-9-]+:\\d{12}:${kind}/[\\w/-]+$`).test(connection.existingAlb[field])) throw new Error(`existingAlb.${field} must be an explicit AWS ARN`)
  }
}

export function capacityConnectionUrl(root: string, connection?: Connection): string | undefined {
  validateCapacityConnection(connection)
  if (!connection) return undefined
  if (connection.mode === 'existing-https') return connection.serverUrl
  let state: any
  try {state = JSON.parse(fs.readFileSync(localPath(root, CAPACITY_NETWORK), 'utf8'))} catch {throw new Error('Run setup aws to read the existing dstack endpoint before rendering')}
  if (state.schema !== SCHEMA || state.status !== 'ready' || !isDeepStrictEqual(state.connection, connection)) throw new Error('Existing dstack endpoint has not been read for this spec')
  return state.serverUrl
}

/** Read the selected ALB and target metadata for the Helm binding. Infrastructure owns TLS, routes and security. */
export function prepareDstackNetworkForSpec(root: string, spec: DeploymentSpec, runner?: Pick<AwsCliRunner, 'json'>): void {
  const connection = spec.capacityManager?.connection
  validateCapacityConnection(connection)
  if (connection?.mode !== 'existing-alb') return
  fs.rmSync(localPath(root, CAPACITY_NETWORK), {force: true})
  const infrastructure = spec.infrastructure.aws!
  const refs = connection.existingAlb!
  const provider = runner ?? new AwsCliRunner(spec.preparation?.awsIam?.awsProfile)
  const call = (args: string[]) => readAwsResource(provider, args, infrastructure.region)
  const lb = call(['elbv2', 'describe-load-balancers', '--load-balancer-arns', refs.loadBalancerArn]).LoadBalancers?.[0]
  const tg = call(['elbv2', 'describe-target-groups', '--target-group-arns', refs.targetGroupArn]).TargetGroups?.[0]
  if (!lb?.LoadBalancerArn || !tg?.TargetGroupArn || !tg.Port) throw new Error('Load balancer metadata is missing ARN or target port')
  const bindingFile = '.scrollsdk/capacity-manager/dstack-targetgroupbinding.json'
  writeJson(localPath(root, bindingFile), {spec: {...(lb.SecurityGroups?.length ? {networking: {ingress: [{from: lb.SecurityGroups.map((groupID: string) => ({securityGroup: {groupID}})), ports: [{port: tg.Port, protocol: 'TCP'}]}]}} : {}), targetGroupARN: tg.TargetGroupArn, targetType: tg.TargetType}})
  writeJson(localPath(root, CAPACITY_NETWORK), {bindingFile, connection, dnsName: lb.DNSName, schema: SCHEMA, serverUrl: connection.serverUrl, source: 'resource-metadata', status: 'ready'})
}
