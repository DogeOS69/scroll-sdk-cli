/* eslint-disable @typescript-eslint/no-explicit-any -- IAM policy JSON and AWS CLI responses. */
import {isDeepStrictEqual} from 'node:util'

/** Platform constraints applied to every workload role the CLI creates or converges. */
export interface RoleGuardrails {
  path?: string
  permissionsBoundaryArn?: string
  roleNamePrefix?: string
  tags?: Record<string, string>
}

export interface WorkloadRoleContext {
  account: string
  /** EKS OIDC issuer without the https:// scheme. */
  issuerHostPath: string
  partition?: string
}

export interface WorkloadRoleRequest {
  catalogEntry: string
  cluster: string
  deployment: string
  description?: string
  namespace: string
  /** The complete inline policy set of the role; every other policy is removed. */
  policies: Record<string, any>
  roleName: string
  serviceAccount: string
}

export interface WorkloadRoleResult {arn: string; claimed: boolean; created: boolean}
type Aws = {json(args: string[]): any}

export const MANAGED_BY = 'scrollsdk'
const RESERVED_TAGS = new Set(['CatalogEntry', 'Cluster', 'Deployment', 'ManagedBy', 'Namespace', 'ServiceAccount'])
const array = (value: any): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
const document = (value: any): any => typeof value === 'string' ? JSON.parse(decodeURIComponent(value)) : value

export function validateRoleGuardrails(guardrails: RoleGuardrails = {}): void {
  if (guardrails.permissionsBoundaryArn !== undefined && !/^arn:aws(?:-[a-z]+)?:iam::(?:\d{12}|aws):policy\/[\w+,./=@-]+$/.test(guardrails.permissionsBoundaryArn)) throw new Error('awsIam.permissionsBoundaryArn must be an IAM managed policy ARN')
  if (guardrails.path !== undefined && !/^\/(?:[!-~]{0,510}\/)?$/.test(guardrails.path)) throw new Error('awsIam.path must start and end with /')
  if (guardrails.roleNamePrefix !== undefined && !/^[\w+,.=@-]{1,32}$/.test(guardrails.roleNamePrefix)) throw new Error('awsIam.roleNamePrefix must be a valid IAM role name prefix')
  for (const [key, value] of Object.entries(guardrails.tags ?? {})) {
    if (RESERVED_TAGS.has(key)) throw new Error(`awsIam.tags cannot set the CLI ownership tag ${key}`)
    if (!/^[\s\w+./:=@-]{1,128}$/.test(key) || key.startsWith('aws:') || typeof value !== 'string' || value.length > 256) throw new Error(`awsIam.tags.${key} is not a valid IAM tag`)
  }
}

/** Plan-time check, so a platform naming rule fails before any AWS mutation. */
export function assertRoleNameAllowed(roleName: string, guardrails: RoleGuardrails = {}): void {
  if (!/^[\w+,.=@-]{1,64}$/.test(roleName)) throw new Error(`Invalid IAM role name ${roleName}`)
  if (guardrails.roleNamePrefix && !roleName.startsWith(guardrails.roleNamePrefix)) throw new Error(`IAM role ${roleName} does not start with awsIam.roleNamePrefix ${guardrails.roleNamePrefix}`)
}

export function irsaTrustPolicy(context: WorkloadRoleContext, namespace: string, serviceAccount: string): any {
  return {Statement: [{
    Action: 'sts:AssumeRoleWithWebIdentity',
    Condition: {StringEquals: {
      [`${context.issuerHostPath}:aud`]: 'sts.amazonaws.com',
      [`${context.issuerHostPath}:sub`]: `system:serviceaccount:${namespace}:${serviceAccount}`,
    }},
    Effect: 'Allow',
    Principal: {Federated: `arn:${context.partition ?? 'aws'}:iam::${context.account}:oidc-provider/${context.issuerHostPath}`},
  }], Version: '2012-10-17'}
}

/** True only when the trust policy admits exactly this one EKS ServiceAccount and nothing else. */
export function trustAdmitsOnly(trustPolicy: any, expected: any): boolean {
  const statements = array(document(trustPolicy)?.Statement)
  const [want] = expected.Statement
  if (statements.length !== 1) return false
  const [statement] = statements
  const conditions = statement?.Condition ?? {}
  return statement?.Effect === 'Allow' && isDeepStrictEqual(array(statement.Action), [want.Action])
    && isDeepStrictEqual(Object.keys(statement.Principal ?? {}), ['Federated']) && isDeepStrictEqual(array(statement.Principal.Federated), [want.Principal.Federated])
    && isDeepStrictEqual(Object.keys(conditions), ['StringEquals'])
    && isDeepStrictEqual(Object.keys(conditions.StringEquals).sort(), Object.keys(want.Condition.StringEquals).sort())
    && Object.entries(want.Condition.StringEquals).every(([key, value]) => isDeepStrictEqual(array(conditions.StringEquals[key]), [value]))
}

export function workloadRoleTags(request: WorkloadRoleRequest, guardrails: RoleGuardrails = {}): Record<string, string> {
  return {...guardrails.tags, CatalogEntry: request.catalogEntry, Cluster: request.cluster, Deployment: request.deployment, ManagedBy: MANAGED_BY, Namespace: request.namespace, ServiceAccount: request.serviceAccount}
}

export interface RoleTakeoverPreview {
  currentOwner: Record<string, string>
  currentTrust: unknown
  desiredOwner: Record<string, string>
  desiredPolicies: Record<string, unknown>
  desiredTrust: unknown
  inlinePoliciesToDelete: string[]
  inlinePoliciesToReplace: string[]
  managedPoliciesToDetach: string[]
  permissionsBoundary: {current?: string; desired?: string}
  roleArn: string
  roleId?: string
}

export type ApproveRoleTakeover = (preview: RoleTakeoverPreview) => boolean
export class RoleTakeoverRequired extends Error {
  constructor(public readonly preview: RoleTakeoverPreview) {super(`IAM role ${preview.roleArn} requires operator confirmation before CLI takeover`)}
}

/** Check again immediately before writes; a matching trust alone is not ownership. */
export function checkWorkloadRoleOwnership(aws: Aws, role: any, context: WorkloadRoleContext, request: WorkloadRoleRequest, guardrails: RoleGuardrails, approve?: ApproveRoleTakeover): boolean {
  const rolePath = role.Path ?? '/'
  if (guardrails.path && rolePath !== guardrails.path) throw new Error(`IAM role ${request.roleName} uses path ${rolePath}; IAM cannot move a role to awsIam.path ${guardrails.path}`)
  const arn = `arn:${context.partition ?? 'aws'}:iam::${context.account}:role${rolePath}${request.roleName}`
  if (role.Arn !== undefined && role.Arn !== arn) throw new Error(`AWS returned an unexpected ARN for IAM role ${request.roleName}`)
  const actual = Object.fromEntries(array(role.Tags).map((tag: any) => [tag.Key, tag.Value]))
  const desired = workloadRoleTags(request)
  if (actual.ManagedBy === MANAGED_BY) {
    // CLI ownership is enough for routine reconciliation, including older roles
    // with incomplete workload tags. Explicit cross-deployment conflicts still fail.
    if (actual.Deployment !== undefined && actual.Deployment !== request.deployment
      || actual.Cluster !== undefined && actual.Cluster !== request.cluster) throw new Error(`IAM role ${request.roleName} belongs to another deployment or cluster`)
    return false
  }

  const inline = aws.json(['iam', 'list-role-policies', '--role-name', request.roleName]).PolicyNames
  const attached = aws.json(['iam', 'list-attached-role-policies', '--role-name', request.roleName]).AttachedPolicies
  if (!Array.isArray(inline) || !Array.isArray(attached)) throw new Error(`Unable to inventory IAM policies for ${request.roleName}`)
  const preview: RoleTakeoverPreview = {
    currentOwner: Object.fromEntries([...RESERVED_TAGS].filter(key => actual[key] !== undefined).sort().map(key => [key, actual[key]])),
    currentTrust: document(role.AssumeRolePolicyDocument), desiredOwner: desired, desiredPolicies: request.policies,
    desiredTrust: irsaTrustPolicy(context, request.namespace, request.serviceAccount),
    inlinePoliciesToDelete: inline.filter(name => !Object.hasOwn(request.policies, name)).sort(),
    inlinePoliciesToReplace: inline.filter(name => Object.hasOwn(request.policies, name)).sort(),
    managedPoliciesToDetach: attached.map(item => item.PolicyArn).sort(),
    permissionsBoundary: {current: role.PermissionsBoundary?.PermissionsBoundaryArn, desired: guardrails.permissionsBoundaryArn ?? role.PermissionsBoundary?.PermissionsBoundaryArn},
    roleArn: arn, roleId: role.RoleId,
  }
  if (!approve?.(preview)) throw new RoleTakeoverRequired(preview)
  return true
}

/** Converge a new/owned role, or an existing role explicitly approved for takeover. */
export function ensureWorkloadRole(aws: Aws, context: WorkloadRoleContext, request: WorkloadRoleRequest, guardrails: RoleGuardrails = {}, log: (message: string) => void = () => {}, approve?: ApproveRoleTakeover): WorkloadRoleResult {
  validateRoleGuardrails(guardrails)
  assertRoleNameAllowed(request.roleName, guardrails)
  const trust = irsaTrustPolicy(context, request.namespace, request.serviceAccount)
  const tags = workloadRoleTags(request, guardrails)
  const tagList = JSON.stringify(Object.entries(tags).map(([Key, Value]) => ({Key, Value})))
  let role: any
  try {
    role = aws.json(['iam', 'get-role', '--role-name', request.roleName]).Role
  } catch (error) {
    if (!/\bNoSuchEntity\b/.test(String(error))) throw error
  }

  let claimed = false
  const created = !role
  if (role) {
    const actual = Object.fromEntries(array(role.Tags).map((tag: any) => [tag.Key, tag.Value]))
    claimed = checkWorkloadRoleOwnership(aws, role, context, request, guardrails, approve)
    if (claimed) log(`IAM role ${request.roleName}: operator approved takeover; adding ownership tags`)

    if (!trustAdmitsOnly(role.AssumeRolePolicyDocument, trust)) aws.json(['iam', 'update-assume-role-policy', '--role-name', request.roleName, '--policy-document', JSON.stringify(trust)])
    // An unset boundary is left as is: removing one could only widen the role.
    if (guardrails.permissionsBoundaryArn && role.PermissionsBoundary?.PermissionsBoundaryArn !== guardrails.permissionsBoundaryArn) aws.json(['iam', 'put-role-permissions-boundary', '--role-name', request.roleName, '--permissions-boundary', guardrails.permissionsBoundaryArn])
    if (Object.entries(tags).some(([key, value]) => actual[key] !== value)) aws.json(['iam', 'tag-role', '--role-name', request.roleName, '--tags', tagList])
  } else {
    role = aws.json(['iam', 'create-role', '--role-name', request.roleName, '--assume-role-policy-document', JSON.stringify(trust), '--tags', tagList,
      ...(guardrails.path ? ['--path', guardrails.path] : []),
      ...(guardrails.permissionsBoundaryArn ? ['--permissions-boundary', guardrails.permissionsBoundaryArn] : []),
      ...(request.description ? ['--description', request.description] : [])]).Role
    log(`IAM role ${request.roleName}: created`)
  }

  const arn = `arn:${context.partition ?? 'aws'}:iam::${context.account}:role${guardrails.path ?? role?.Path ?? '/'}${request.roleName}`
  if (role?.Arn !== undefined && role.Arn !== arn) throw new Error(`AWS returned an unexpected ARN for IAM role ${request.roleName}`)
  for (const [name, policy] of Object.entries(request.policies)) aws.json(['iam', 'put-role-policy', '--role-name', request.roleName, '--policy-name', name, '--policy-document', JSON.stringify(policy)])
  if (!created) {
    const inline = aws.json(['iam', 'list-role-policies', '--role-name', request.roleName]).PolicyNames
    const attached = aws.json(['iam', 'list-attached-role-policies', '--role-name', request.roleName]).AttachedPolicies
    if (!Array.isArray(inline) || !Array.isArray(attached)) throw new Error(`Unable to inventory IAM policies for ${request.roleName}`)
    for (const name of inline.filter(item => !Object.hasOwn(request.policies, item))) {
      aws.json(['iam', 'delete-role-policy', '--role-name', request.roleName, '--policy-name', name])
      log(`IAM role ${request.roleName}: removed inline policy ${name} outside its role catalog entry`)
    }

    for (const entry of attached) {
      aws.json(['iam', 'detach-role-policy', '--role-name', request.roleName, '--policy-arn', entry.PolicyArn])
      log(`IAM role ${request.roleName}: detached managed policy ${entry.PolicyArn}`)
    }
  }

  return {arn, claimed, created}
}
