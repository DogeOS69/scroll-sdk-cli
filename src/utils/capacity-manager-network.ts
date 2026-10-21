/* eslint-disable @typescript-eslint/no-explicit-any -- AWS CloudFormation documents. */
import fs from 'node:fs'
import {isDeepStrictEqual} from 'node:util'

import type {CapacityManagerConfig} from '../types/capacity-manager.js'

import {AwsCliRunner} from './aws-cli.js'
import {validateDstackInternalTls, verifyDstackAcmCertificate} from './dstack-internal-tls.js'
import {canonicalJson} from './json-content.js'
import {digest, localPath, writeJson} from './preparation-io.js'

type Connection = NonNullable<CapacityManagerConfig['connection']>
type InternalAlb = NonNullable<Connection['internalAlb']>
export const CAPACITY_NETWORK = '.scrollsdk/capacity-manager/network.json'
const OWNER = 'scrollsdk-capacity-network-v1'

export function validateCapacityConnection(connection?: Connection): void {
  if (!connection) return
  if (connection.mode === 'existing-https') {
    let url: URL
    try {url = new URL(connection.serverUrl!)} catch {throw new Error('connection.serverUrl must be credential-free HTTPS')}
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[\s#?\\]/.test(connection.serverUrl!) || connection.internalAlb) throw new Error('existing-https requires only a credential-free HTTPS serverUrl')
  } else if (connection.mode === 'internal-alb' && connection.internalAlb && !connection.serverUrl) {
    const input = connection.internalAlb
    validateDstackInternalTls({awsProfile: input.awsProfile, certificateArn: input.certificateArn, hostname: input.hostname, inboundCidrs: input.inboundCidrs, subnets: input.subnets})
    if (!/^[a-z][\da-z-]{0,63}$/.test(input.stackName) || !/^vpc-[\da-f]+$/.test(input.vpcId) || !/^[a-z]{2}-[a-z]+-\d$/.test(input.region) || input.certificateArn.split(':')[3] !== input.region) throw new Error('internal-alb requires a stack name, VPC and matching certificate region')
    // This private edge is deliberately restricted to RFC1918 caller networks.
    if (input.inboundCidrs.some(cidr => {
      const [ip, prefix] = cidr.split('/')
      const [a, b] = ip.split('.').map(Number)
      return !(a === 10 && Number(prefix) >= 8 || a === 172 && b >= 16 && b <= 31 && Number(prefix) >= 12 || a === 192 && b === 168 && Number(prefix) >= 16)
    })) throw new Error('internal-alb inboundCidrs must be contained in RFC1918 networks')
  } else throw new Error('Select connection.mode existing-https or internal-alb with its matching fields')
}

export function capacityNetworkTemplate(input: InternalAlb): Record<string, any> {
  validateCapacityConnection({internalAlb: input, mode: 'internal-alb'})
  const ref = (name: string) => ({Ref: name})
  const attr = (name: string, key: string) => ({'Fn::GetAtt': [name, key]})
  const resource = (Type: string, Properties: any) => ({Properties, Type})
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'Private dstack HTTPS edge. No GPU, public DNS, or ACM certificate creation.',
    Outputs: {SecurityGroupId: {Value: ref('SecurityGroup')}, TargetGroupArn: {Value: ref('TargetGroup')}, Url: {Value: `https://${input.hostname}`}},
    Resources: {
      Alias: resource('AWS::Route53::RecordSet', {AliasTarget: {DNSName: attr('LoadBalancer', 'DNSName'), EvaluateTargetHealth: false, HostedZoneId: attr('LoadBalancer', 'CanonicalHostedZoneID')}, HostedZoneId: ref('PrivateZone'), Name: input.hostname, Type: 'A'}),
      Listener: resource('AWS::ElasticLoadBalancingV2::Listener', {Certificates: [{CertificateArn: input.certificateArn}], DefaultActions: [{TargetGroupArn: ref('TargetGroup'), Type: 'forward'}], LoadBalancerArn: ref('LoadBalancer'), Port: 443, Protocol: 'HTTPS', SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06'}),
      LoadBalancer: resource('AWS::ElasticLoadBalancingV2::LoadBalancer', {IpAddressType: 'ipv4', Scheme: 'internal', SecurityGroups: [ref('SecurityGroup')], Subnets: input.subnets, Type: 'application'}),
      // An exact-host private zone avoids shadowing other public *.infra records.
      PrivateZone: resource('AWS::Route53::HostedZone', {Name: input.hostname, VPCs: [{VPCId: input.vpcId, VPCRegion: input.region}]}),
      SecurityGroup: resource('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Private dstack HTTPS callers',
        // Egress permits Pod traffic only on the dstack backend port.
        SecurityGroupEgress: [{CidrIp: '0.0.0.0/0', FromPort: 3000, IpProtocol: 'tcp', ToPort: 3000}],
        SecurityGroupIngress: input.inboundCidrs.map(CidrIp => ({CidrIp, FromPort: 443, IpProtocol: 'tcp', ToPort: 443})),
        // TargetGroupBinding authorizes this SG on the backend.
        VpcId: input.vpcId,
      }),
      TargetGroup: resource('AWS::ElasticLoadBalancingV2::TargetGroup', {HealthCheckPath: '/', HealthCheckProtocol: 'HTTP', Matcher: {HttpCode: '200'}, Port: 3000, Protocol: 'HTTP', TargetType: 'ip', VpcId: input.vpcId}),
    },
  }
}

/** Preview is local-only. Apply creates an owned stack, or reads back that exact stack.
 * Configuration changes require an explicit operator-reviewed replacement; never
 * adopt, update, or delete resources by name alone. CloudFormation owns rollback.
 */
export function prepareCapacityNetwork(root: string, connection: Connection, deployment: string, namespace: string, service: string, apply = false, runner?: Pick<AwsCliRunner, 'json'>): Record<string, unknown> {
  validateCapacityConnection(connection)
  if (connection.mode !== 'internal-alb') return {applied: false, mode: connection.mode, serverUrl: connection.serverUrl}
  const input = connection.internalAlb!
  const template = capacityNetworkTemplate(input)
  const fingerprint = digest(canonicalJson({deployment, input, namespace, service, template}))
  const templatePath = '.scrollsdk/capacity-manager/network-template.json'
  writeJson(localPath(root, templatePath), template)
  if (!apply) return {applied: false, fingerprint, mode: connection.mode, serverUrl: `https://${input.hostname}`, stackName: input.stackName, templatePath}
  const aws = runner ?? new AwsCliRunner(input.awsProfile)
  const call = (args: string[]) => {
    try {return aws.json(args, {region: input.region})} catch {throw new Error('Capacity network AWS operation failed; inspect the selected stack/account privately (provider details omitted)')}
  }

  verifyDstackAcmCertificate({internalTls: {awsProfile: input.awsProfile, certificateArn: input.certificateArn, hostname: input.hostname, inboundCidrs: input.inboundCidrs, subnets: input.subnets}}, aws)
  const account = call(['sts', 'get-caller-identity']).Account
  if (account !== input.certificateArn.split(':')[4]) throw new Error('Certificate and selected AWS account differ')
  const subnets = call(['ec2', 'describe-subnets', '--subnet-ids', ...input.subnets]).Subnets
  if (subnets?.length !== input.subnets.length || subnets.some((s: any) => s.VpcId !== input.vpcId || s.State !== 'available' || s.MapPublicIpOnLaunch || s.AvailableIpAddressCount < 8) || new Set(subnets.map((s: any) => s.AvailabilityZone)).size < 2) throw new Error('Select available private subnets with capacity in at least two AZs of the selected VPC')
  for (const attribute of ['enableDnsSupport', 'enableDnsHostnames']) {
    const key = attribute[0].toUpperCase() + attribute.slice(1)
    if (!call(['ec2', 'describe-vpc-attribute', '--vpc-id', input.vpcId, '--attribute', attribute])[key]?.Value) throw new Error('Private DNS requires VPC DNS support and hostnames')
  }

  const stacks = call(['cloudformation', 'list-stacks']).StackSummaries
  if (!Array.isArray(stacks)) throw new Error('Cannot inspect existing network stacks')
  const existing = stacks.find((s: any) => s.StackName === input.stackName && s.StackStatus !== 'DELETE_COMPLETE')
  if (!existing) {
    const zones = call(['route53', 'list-hosted-zones-by-vpc', '--vpc-id', input.vpcId, '--vpc-region', input.region]).HostedZoneSummaries
    if (!Array.isArray(zones) || zones.some((z: any) => z.Name.replace(/\.$/, '') === input.hostname)) throw new Error('An exact-host private zone already exists; use existing-https or choose a distinct hostname')
    const created = call(['cloudformation', 'create-stack', '--stack-name', input.stackName, '--template-body', JSON.stringify(template), '--tags', `Key=ManagedBy,Value=${OWNER}`, `Key=IntentSha256,Value=${fingerprint}`, '--client-request-token', fingerprint])
    writeJson(localPath(root, CAPACITY_NETWORK), {fingerprint, schema: OWNER, stackId: created.StackId, status: 'creating'})
    return {applied: true, next: 'Rerun capacity-manager network --apply to read back completion; no GPU allocation', stackId: created.StackId, status: 'creating'}
  }

  const stack = call(['cloudformation', 'describe-stacks', '--stack-name', existing.StackId]).Stacks?.[0]
  if (!stack?.Tags?.some((t: any) => t.Key === 'ManagedBy' && t.Value === OWNER)) throw new Error('Existing stack ownership or intent differs; no resources were changed')
  if (stack.StackStatus !== 'CREATE_COMPLETE') return {applied: false, next: 'Inspect CloudFormation events; rerun after completion. Do not install capacity-manager yet.', stackId: stack.StackId, status: stack.StackStatus}
  // The live template is authoritative. Legacy IntentSha256 tags depended on
  // property order and must not reject an otherwise identical owned stack.
  const deployed = call(['cloudformation', 'get-template', '--stack-name', stack.StackId]).TemplateBody
  if (!isDeepStrictEqual(typeof deployed === 'string' ? JSON.parse(deployed) : deployed, template)) throw new Error('Deployed network template differs; inspect stack drift before continuing')
  const outputs = Object.fromEntries((stack.Outputs ?? []).map((o: any) => [o.OutputKey, o.OutputValue]))
  if (!outputs.TargetGroupArn || !outputs.SecurityGroupId || outputs.Url !== `https://${input.hostname}`) throw new Error('Network stack outputs are incomplete')
  const bindingFile = '.scrollsdk/capacity-manager/dstack-targetgroupbinding.json'
  writeJson(localPath(root, bindingFile), {apiVersion: 'elbv2.k8s.aws/v1beta1', kind: 'TargetGroupBinding', metadata: {name: 'capacity-manager-dstack', namespace}, spec: {networking: {ingress: [{from: [{securityGroup: {groupID: outputs.SecurityGroupId}}], ports: [{port: 3000, protocol: 'TCP'}]}]}, serviceRef: {name: service, port: 3000}, targetGroupARN: outputs.TargetGroupArn, targetType: 'ip'}})
  writeJson(localPath(root, CAPACITY_NETWORK), {bindingFile, connection, fingerprint, schema: OWNER, serverUrl: outputs.Url, stackId: stack.StackId, status: 'ready'})
  return {applied: false, bindingFile, next: 'Review and apply TargetGroupBinding in the saved cluster, then run capacity-manager prepare and preflight', serverUrl: outputs.Url, status: 'ready'}
}

export function capacityConnectionUrl(root: string, connection?: Connection): string | undefined {
  validateCapacityConnection(connection)
  if (!connection) return undefined
  if (connection.mode === 'existing-https') return connection.serverUrl
  const file = localPath(root, CAPACITY_NETWORK)
  let state: any
  try {state = JSON.parse(fs.readFileSync(file, 'utf8'))} catch {throw new Error('Run capacity-manager network --apply until ready before prepare')}
  if (state.status !== 'ready' || state.schema !== OWNER || state.serverUrl !== `https://${connection.internalAlb!.hostname}`) throw new Error('Internal HTTPS network is not ready for the selected endpoint')
  if (!state.connection) throw new Error('Refresh legacy network state with capacity-manager network --apply; the existing stack is read back, not recreated')
  if (!isDeepStrictEqual(state.connection, connection)) throw new Error('Internal HTTPS network is not ready for the selected endpoint')
  return state.serverUrl
}
