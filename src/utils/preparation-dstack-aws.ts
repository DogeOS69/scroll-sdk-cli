/* eslint-disable @typescript-eslint/no-explicit-any -- AWS CLI metadata and deployment TOML. */
import * as toml from '@iarna/toml'
import fs from 'node:fs'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {AwsCliRunner} from './aws-cli.js'
import {validateDstackAwsBackend} from './dstack-credentials.js'
import {sanitizeName, truncateIamRoleName} from './kms-signer-provisioner.js'
import {localPath, privateWrite, writeJson} from './preparation-io.js'
import {specKubernetesTarget} from './spec-kubernetes-target.js'

export const DSTACK_AWS_RECORD = '.data/dstack-aws.json'
const ROLE_ANNOTATION = 'eks.amazonaws.com/role-arn'
const POLICY_NAME = 'scrollsdk-dstack-workers'
const asArray = (value: any): any[] => Array.isArray(value) ? value : value === undefined ? [] : [value]
const document = (value: any): any => typeof value === 'string' ? JSON.parse(decodeURIComponent(value)) : value

/** Resolve public intent only: planning must never contact AWS. */
export function dstackAwsIntent(spec: DeploymentSpec): {namespace: string; roleName: string; serviceAccount: string} | undefined {
  const input = spec.preparation?.dstack?.aws
  if (input?.action === undefined) {
    if (input?.controllerRoleName || input?.awsProfile) throw new Error('Dstack controllerRoleName/awsProfile requires aws.action: create or reuse')
    return
  }

  const controller = spec.dstackController
  if (!['create', 'reuse'].includes(input.action) || spec.preparation?.dstack?.mode !== 'import' || !spec.preparation.dstack.providers?.includes('aws') || !controller || controller.enabled === false || spec.infrastructure.provider !== 'aws' || !spec.infrastructure.aws?.eksClusterName) throw new Error('Dstack AWS preparation requires create/reuse, imported AWS backend, enabled controller and an EKS cluster')
  validateDstackAwsBackend(input)
  if (controller.defaultCredentialsEnabled === false) throw new Error('Dstack AWS preparation requires default credentials; remove defaultCredentialsEnabled: false')
  // Helm cannot annotate an externally managed ServiceAccount. Keep this handoff explicit.
  if (controller.serviceAccount?.create === false) throw new Error('Dstack AWS preparation requires a chart-managed ServiceAccount; omit aws.action for an externally managed account')
  const serviceAccount = controller.serviceAccount?.name ?? controller.fullnameOverride ?? 'dstack-controller'
  if (!/^[\da-z](?:[\d.a-z-]{0,251}[\da-z])?$/.test(serviceAccount)) throw new Error('Dstack ServiceAccount requires a Kubernetes resource name')
  const annotation = controller.serviceAccount?.annotations?.[ROLE_ANNOTATION]
  if (annotation && !/^arn:aws(?:-[a-z]+)?:iam::\d{12}:role\/[\w+,./=@-]+$/.test(annotation)) throw new Error('Invalid dstack controller role annotation')
  const roleName = input.controllerRoleName ?? annotation?.split('/').at(-1) ?? truncateIamRoleName(`dogeos-${sanitizeName(spec.metadata.name)}-${sanitizeName(spec.infrastructure.aws.eksClusterName)}-dstack`)
  if (!/^[\w+,.=@-]{1,64}$/.test(roleName)) throw new Error('Invalid dstack controllerRoleName')
  if (annotation && annotation.split('/').at(-1) !== roleName) throw new Error('Dstack controllerRoleName conflicts with the role annotation')
  return {namespace: specKubernetesTarget(spec).namespace, roleName, serviceAccount}
}

/** Named operations used by dstack 0.21.5 EC2 fleets, not its optional gateways/LBs. */
export function dstackWorkerPolicy(regions: string[], instanceProfile?: {arn: string; roles: string[]}, scope?: {account: string; network: Array<{eligibleSubnets: string[]; region: string; vpcId: string}>; project: string; publicIps: boolean}): any {
  const regionCondition = {'aws:RequestedRegion': [...regions].sort()}
  const resources = (kind: string) => regions.map(region => `arn:aws:ec2:${region}:${scope?.account ?? '*'}:${kind}/*`)
  const owned = {StringEquals: {...regionCondition, 'ec2:ResourceTag/owner': 'dstack', ...(scope ? {'ec2:ResourceTag/dstack_project': scope.project} : {})}}
  const requested = {StringEquals: {...regionCondition, 'aws:RequestTag/owner': 'dstack', ...(scope ? {'aws:RequestTag/dstack_project': scope.project} : {})}}
  const statements: any[] = [
    {Action: [
      'ec2:DescribeAvailabilityZones', 'ec2:DescribeImages', 'ec2:DescribeInstances', 'ec2:DescribeInstanceAttribute',
      'ec2:DescribeInstanceTypes', 'ec2:DescribeInstanceTypeOfferings', 'ec2:DescribeSecurityGroups', 'ec2:DescribeSubnets', 'ec2:DescribeVpcs',
      'ec2:DescribeRouteTables', 'ec2:DescribeVolumes', 'ec2:DescribeSpotInstanceRequests', 'ec2:DescribeCapacityReservations',
      'ec2:DescribeAddresses', 'ec2:DescribePlacementGroups', 'servicequotas:GetServiceQuota',
    ], Condition: {StringEquals: regionCondition}, Effect: 'Allow', Resource: '*', Sid: 'ReadWorkerCompute'},
    {Action: 'ec2:RunInstances', Condition: requested, Effect: 'Allow', Resource: resources('instance'), Sid: 'LaunchTaggedWorkers'},
    // dstack tags instances, not the root volume or network interface created by RunInstances.
    {Action: 'ec2:RunInstances', Condition: {StringEquals: regionCondition}, Effect: 'Allow', Resource: [
      ...regions.map(region => `arn:aws:ec2:${region}::image/*`),
      ...['network-interface', 'volume', 'security-group', 'key-pair', 'placement-group', 'capacity-reservation'].flatMap(kind => resources(kind)),
      ...(scope ? scope.network.flatMap(item => item.eligibleSubnets.map(id => `arn:aws:ec2:${item.region}:${scope.account}:subnet/${id}`)) : resources('subnet')),
    ], Sid: 'LaunchDependencies'},
    {Action: 'ec2:CreateTags', Condition: {StringEquals: {...regionCondition, 'ec2:CreateAction': ['RunInstances', 'CreateSecurityGroup', 'CreateVolume', 'AllocateAddress']}}, Effect: 'Allow', Resource: ['instance', 'security-group', 'volume', 'elastic-ip'].flatMap(kind => resources(kind)), Sid: 'TagOnCreation'},
    {Action: ['ec2:TerminateInstances', 'ec2:DeleteSecurityGroup', 'ec2:AuthorizeSecurityGroupIngress', 'ec2:AuthorizeSecurityGroupEgress', 'ec2:DeleteVolume', 'ec2:AttachVolume', 'ec2:DetachVolume'], Condition: owned, Effect: 'Allow', Resource: ['instance', 'security-group', 'volume'].flatMap(kind => resources(kind)), Sid: 'ManageOwnedWorkers'},
    {Action: ['ec2:CreateSecurityGroup', 'ec2:CreateVolume'], Condition: requested, Effect: 'Allow', Resource: ['security-group', 'volume'].flatMap(kind => resources(kind)), Sid: 'CreateTaggedResources'},
    {Action: 'ec2:CreateSecurityGroup', Condition: {StringEquals: regionCondition}, Effect: 'Allow', Resource: scope ? scope.network.map(item => `arn:aws:ec2:${item.region}:${scope.account}:vpc/${item.vpcId}`) : resources('vpc'), Sid: 'WorkerVpcs'},
    // dstack 0.21.5 does not tag placement groups. Restrict their account and region.
    {Action: ['ec2:CreatePlacementGroup', 'ec2:DeletePlacementGroup'], Condition: {StringEquals: regionCondition}, Effect: 'Allow', Resource: resources('placement-group'), Sid: 'PlacementGroups'},
  ]
  if (scope?.publicIps) statements.push(
    {Action: 'ec2:AllocateAddress', Condition: requested, Effect: 'Allow', Resource: resources('elastic-ip'), Sid: 'AllocateWorkerAddress'},
    {Action: ['ec2:AssociateAddress', 'ec2:DisassociateAddress', 'ec2:ReleaseAddress'], Condition: owned, Effect: 'Allow', Resource: resources('elastic-ip'), Sid: 'ManageWorkerAddress'},
    {Action: ['ec2:AssociateAddress', 'ec2:DisassociateAddress'], Condition: {StringEquals: regionCondition}, Effect: 'Allow', Resource: resources('network-interface'), Sid: 'WorkerAddressInterface'},
  )
  if (instanceProfile) statements.push(
    {Action: 'iam:GetInstanceProfile', Effect: 'Allow', Resource: instanceProfile.arn, Sid: 'ReadWorkerProfile'},
    {Action: 'iam:PassRole', Condition: {StringEquals: {'iam:PassedToService': 'ec2.amazonaws.com'}}, Effect: 'Allow', Resource: instanceProfile.roles, Sid: 'PassWorkerRole'},
  )
  return {Statement: statements, Version: '2012-10-17'}
}

/** Mirrors dstack subnet selection, including the main route table fallback. No connectivity claim. */
export function dstackEligibleSubnets(subnets: any[], tables: any[], publicIps: boolean): string[] {
  return subnets.filter(subnet => {
    if (subnet.State !== 'available') return false
    const explicit = tables.filter(table => table.Associations?.some((association: any) => association.SubnetId === subnet.SubnetId))
    const selected = explicit.length > 0 ? explicit : tables.filter(table => table.Associations?.some((association: any) => association.Main))
    return selected.some(table => table.Routes?.some((route: any) => route.State !== 'blackhole' && (publicIps
      ? route.GatewayId?.startsWith('igw-')
      : route.DestinationCidrBlock === '0.0.0.0/0' && (route.NatGatewayId || route.TransitGatewayId || route.VpcPeeringConnectionId))))
  }).map(subnet => subnet.SubnetId).sort()
}

/** Only this explicitly selected step mutates IAM. Reuse performs metadata reads only. */
export function prepareDstackAws(root: string, spec: DeploymentSpec, aws: Pick<AwsCliRunner, 'json'> = new AwsCliRunner(spec.preparation?.dstack?.aws?.awsProfile)): void {
  const intent = dstackAwsIntent(spec)
  if (!intent) return
  const input = spec.preparation!.dstack!.aws!
  const infrastructure = spec.infrastructure.aws!
  // Redact AWS stderr; it can include request/credential details. Preserve only the one expected absence code.
  const query = (args: string[], region = infrastructure.region, missing = false): any => {
    try {return aws.json(args, {region})} catch (error) {
      if (missing && /\bNoSuchEntity\b/.test(String(error))) return undefined
      throw new Error(`Dstack AWS ${args.slice(0, 2).join(' ')} failed; check the selected AWS profile and operator permissions`)
    }
  }

  const identity = query(['sts', 'get-caller-identity'])
  const account = identity.Account
  const partition = identity.Arn?.split(':')[1]
  if (!/^\d{12}$/.test(account ?? '') || !/^aws(?:-[a-z]+)?$/.test(partition ?? '') || infrastructure.accountId && infrastructure.accountId !== account) throw new Error('Dstack AWS account does not match infrastructure.aws.accountId')
  const {cluster} = query(['eks', 'describe-cluster', '--name', infrastructure.eksClusterName!])
  const issuer = cluster?.identity?.oidc?.issuer
  if (typeof issuer !== 'string' || !issuer.startsWith('https://')) throw new Error('Dstack EKS cluster has no OIDC issuer')
  const issuerPath = issuer.slice('https://'.length)
  const provider = `arn:${partition}:iam::${account}:oidc-provider/${issuerPath}`
  const oidc = query(['iam', 'get-open-id-connect-provider', '--open-id-connect-provider-arn', provider])
  if (!oidc.ClientIDList?.includes('sts.amazonaws.com')) throw new Error('EKS IAM OIDC provider must allow sts.amazonaws.com; see docs/dstack-aws-preparation.md')
  const network = Object.entries(input.vpcIds).map(([region, vpcId]) => {
    const vpc = query(['ec2', 'describe-vpcs', '--vpc-ids', vpcId], region).Vpcs?.[0]
    if (vpc?.VpcId !== vpcId || vpc.State !== 'available') throw new Error(`Dstack VPC is not available in ${region}`)
    const filters = `Name=vpc-id,Values=${vpcId}`
    const subnets = query(['ec2', 'describe-subnets', '--filters', filters], region).Subnets ?? []
    const tables = query(['ec2', 'describe-route-tables', '--filters', filters], region).RouteTables ?? []
    const eligibleSubnets = dstackEligibleSubnets(subnets, tables, input.publicIps ?? false)
    if (eligibleSubnets.length === 0) throw new Error(`No dstack-compatible ${input.publicIps ? 'public' : 'private egress'} subnet in ${region}; see docs/dstack-aws-preparation.md`)
    return {eligibleSubnets, region, vpcId}
  })
  let profile: {arn: string; roles: string[]} | undefined
  if (input.iamInstanceProfile) {
    const found = query(['iam', 'get-instance-profile', '--instance-profile-name', input.iamInstanceProfile]).InstanceProfile
    if (!found?.Arn?.startsWith(`arn:${partition}:iam::${account}:instance-profile/`) || !found.Roles?.length || found.Roles.some((role: any) => !role.Arn?.startsWith(`arn:${partition}:iam::${account}:role/`))) throw new Error('Worker instance profile must contain roles in the selected AWS account')
    if (found.Roles.some((role: any) => !asArray(document(role.AssumeRolePolicyDocument)?.Statement).some(statement => statement?.Effect === 'Allow' && asArray(statement.Action).includes('sts:AssumeRole') && asArray(statement.Principal?.Service).includes('ec2.amazonaws.com')))) throw new Error('Worker instance profile role must trust ec2.amazonaws.com')
    profile = {arn: found.Arn, roles: found.Roles.map((role: any) => role.Arn)}
  }

  const trust = {Statement: [{Action: 'sts:AssumeRoleWithWebIdentity', Condition: {StringEquals: {
    [`${issuerPath}:aud`]: 'sts.amazonaws.com', [`${issuerPath}:sub`]: `system:serviceaccount:${intent.namespace}:${intent.serviceAccount}`,
  }}, Effect: 'Allow', Principal: {Federated: provider}}], Version: '2012-10-17'}
  const policy = dstackWorkerPolicy(Object.keys(input.vpcIds), profile, {account, network, project: spec.capacityManager?.project ?? spec.preparation!.dstack!.project ?? 'main', publicIps: input.publicIps ?? false})
  const tags = {Cluster: infrastructure.eksClusterName!, Deployment: spec.metadata.name, ManagedBy: 'scrollsdk-dstack-aws', Namespace: intent.namespace, ServiceAccount: intent.serviceAccount}
  let role = query(['iam', 'get-role', '--role-name', intent.roleName], infrastructure.region, input.action === 'create')?.Role
  const annotation = spec.dstackController!.serviceAccount?.annotations?.[ROLE_ANNOTATION]
  const expectedArn = role?.Arn ?? `arn:${partition}:iam::${account}:role/${intent.roleName}`
  if (!expectedArn.startsWith(`arn:${partition}:iam::${account}:role/`) || annotation && annotation !== expectedArn) throw new Error('Dstack role belongs to a different account or conflicts with the explicit annotation')
  if (input.action === 'create') {
    if (role) {
      const actual = Object.fromEntries((role.Tags ?? []).map((tag: any) => [tag.Key, tag.Value]))
      if (Object.entries(tags).some(([key, value]) => actual[key] !== value)) throw new Error('Dstack role already exists without matching CLI ownership tags; use reuse for an operator-managed role')
      query(['iam', 'update-assume-role-policy', '--role-name', intent.roleName, '--policy-document', JSON.stringify(trust)])
    } else {
      role = query(['iam', 'create-role', '--role-name', intent.roleName, '--assume-role-policy-document', JSON.stringify(trust), '--tags', JSON.stringify(Object.entries(tags).map(([Key, Value]) => ({Key, Value})))]).Role
    }

    query(['iam', 'put-role-policy', '--role-name', intent.roleName, '--policy-name', POLICY_NAME, '--policy-document', JSON.stringify(policy)])
  } else {
    const statements = asArray(document(role?.AssumeRolePolicyDocument)?.Statement)
    if (!statements.some(statement => statement?.Effect === 'Allow' && asArray(statement.Action).includes('sts:AssumeRoleWithWebIdentity')
      && asArray(statement.Principal?.Federated).includes(provider)
      && Object.entries(trust.Statement[0].Condition.StringEquals).every(([key, value]) => asArray(statement.Condition?.StringEquals?.[key]).includes(value)))) throw new Error('Existing dstack role does not trust the selected EKS namespace and ServiceAccount')
  }

  if (!role?.Arn || role.Arn !== expectedArn) throw new Error('AWS did not return the expected dstack role ARN')
  writeJson(localPath(root, DSTACK_AWS_RECORD), {account, cluster: infrastructure.eksClusterName, controllerRoleArn: role.Arn, namespace: intent.namespace, network, policy, region: infrastructure.region, serviceAccount: intent.serviceAccount})
  bindPreparedDstackAws(root, spec)
}

/** Read public outputs as JSON fields. No hashes or byte-level equality gates. */
export function withPreparedDstackAws(root: string, spec: DeploymentSpec): DeploymentSpec {
  const intent = dstackAwsIntent(spec)
  if (!intent) return spec
  let record: any
  try {record = JSON.parse(fs.readFileSync(localPath(root, DSTACK_AWS_RECORD), 'utf8'))} catch {throw new Error('Prepare dstack AWS resources with setup aws before rendering or preparing capacity-manager')}
  const infrastructure = spec.infrastructure.aws!
  if (record.cluster !== infrastructure.eksClusterName || record.region !== infrastructure.region || record.namespace !== intent.namespace || record.serviceAccount !== intent.serviceAccount || infrastructure.accountId && record.account !== infrastructure.accountId || !/^arn:aws(?:-[a-z]+)?:iam::\d{12}:role\/[\w+,./=@-]+$/.test(record.controllerRoleArn ?? '') || record.controllerRoleArn.split('/').at(-1) !== intent.roleName) throw new Error('Prepared dstack role targets a different EKS workload; run the AWS preparation for this deployment')
  const controller = spec.dstackController!
  const annotation = controller.serviceAccount?.annotations?.[ROLE_ANNOTATION]
  if (annotation && annotation !== record.controllerRoleArn) throw new Error('Prepared dstack role conflicts with the explicit annotation')
  return {...spec, dstackController: {...controller, defaultCredentialsEnabled: true, serviceAccount: {...controller.serviceAccount, annotations: {...controller.serviceAccount?.annotations, [ROLE_ANNOTATION]: record.controllerRoleArn}, name: intent.serviceAccount}}}
}

export function bindPreparedDstackAws(root: string, spec: DeploymentSpec): void {
  if (!dstackAwsIntent(spec)) return
  const controller = withPreparedDstackAws(root, spec).dstackController!
  const file = localPath(root, '.data/doge-config.toml')
  const config = toml.parse(fs.readFileSync(file, 'utf8')) as any
  // Preserve credential references already added by dstack-config on a resumed step.
  config.dstackController = {...config.dstackController, defaultCredentialsEnabled: true, serviceAccount: controller.serviceAccount}
  privateWrite(file, toml.stringify(config))
}
