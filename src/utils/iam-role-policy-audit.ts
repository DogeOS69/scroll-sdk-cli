/* eslint-disable @typescript-eslint/no-explicit-any -- IAM policy JSON and AWS CLI responses. */
import {isDeepStrictEqual} from 'node:util'

type Json = Record<string, any>
type Aws = {json(args: string[]): any}
const array = (value: any): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
function document(value: any): Json {
  const result = typeof value === 'string' ? JSON.parse(decodeURIComponent(value)) : value
  if (!result || !('Statement' in result)) throw new Error('IAM policy document is missing Statement')
  return result
}

function contained(resource: string, allowed: string): boolean {
  if (resource === allowed) return true
  return allowed.endsWith('*') && !allowed.slice(0, -1).includes('*') && !resource.includes('?')
    && !resource.slice(0, -1).includes('*') && resource.startsWith(allowed.slice(0, -1))
}

/** Conservative upper-bound check, not an IAM simulator. Denies never justify extra Allows. */
export function assertPolicyWithinScope(policy: Json, allowed: Json, label: string, services = ['s3']): void {
  const permits = array(allowed.Statement).filter(statement => statement.Effect === 'Allow')
  for (const statement of array(policy.Statement)) {
    if (statement.Effect !== 'Allow') continue
    const fail = (): never => {throw new Error(`${label}: extra or unprovable ${services.join('/')} grant; review this policy explicitly before reusing the workload role`)}
    if (statement.NotAction || statement.NotResource) fail()
    for (const action of array(statement.Action)) {
      if (typeof action !== 'string') fail()
      if (!action.includes(':') || /[*?]/.test(action.split(':')[0])) fail()
      if (!services.includes(action.split(':')[0].toLowerCase())) continue
      if (/[*?]/.test(action) || array(statement.Resource).length === 0) fail()
      for (const resource of array(statement.Resource)) {
        if (typeof resource !== 'string' || !permits.some(permit => array(permit.Action).some(item => item.toLowerCase() === action.toLowerCase())
          && array(permit.Resource).some(item => contained(resource, item))
          && (!permit.Condition || isDeepStrictEqual(statement.Condition, permit.Condition)))) fail()
      }
    }
  }
}

/** AWS CLI auto-paginates these list operations. Never remove operator-owned policies. */
export function auditRolePolicies(aws: Aws, roleName: string, allowed: Json, replacing: string[] = [], services = ['s3']): void {
  const inline = aws.json(['iam', 'list-role-policies', '--role-name', roleName]).PolicyNames
  const attached = aws.json(['iam', 'list-attached-role-policies', '--role-name', roleName]).AttachedPolicies
  if (!Array.isArray(inline) || !Array.isArray(attached)) throw new Error(`Unable to inventory IAM policies for ${roleName}`)
  for (const name of inline) {
    if (replacing.includes(name)) continue
    const policy = aws.json(['iam', 'get-role-policy', '--role-name', roleName, '--policy-name', name]).PolicyDocument
    assertPolicyWithinScope(document(policy), allowed, `${roleName}/${name}`, services)
  }

  for (const entry of attached) {
    const version = aws.json(['iam', 'get-policy', '--policy-arn', entry.PolicyArn]).Policy?.DefaultVersionId
    if (!version) throw new Error(`Unable to read IAM policy version for ${roleName}/${entry.PolicyArn}`)
    const policy = aws.json(['iam', 'get-policy-version', '--policy-arn', entry.PolicyArn, '--version-id', version]).PolicyVersion?.Document
    assertPolicyWithinScope(document(policy), allowed, `${roleName}/${entry.PolicyArn}`, services)
  }
}
