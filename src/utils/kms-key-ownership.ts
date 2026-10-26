/* eslint-disable @typescript-eslint/no-explicit-any -- KMS key policy JSON and AWS CLI responses. */
import {MANAGED_BY} from './aws-workload-role.js'

/** A signing key is owned only when the CLI created it for this deployment and catalog entry. */
export interface KmsKeyOwner {catalogEntry: string; cluster: string; deployment: string}
type Aws = {json(args: string[], options?: {region?: string}): any}
const array = (value: any): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value]

/** Tags written atomically by create-key; later runs recognize the key from them. */
export function kmsOwnershipTags(owner: KmsKeyOwner, extra: Record<string, string> = {}): string {
  return JSON.stringify(Object.entries({...extra, CatalogEntry: owner.catalogEntry, Cluster: owner.cluster, Deployment: owner.deployment, ManagedBy: MANAGED_BY}).map(([TagKey, TagValue]) => ({TagKey, TagValue})))
}

export function kmsKeyOwned(aws: Aws, keyArn: string, owner: KmsKeyOwner, region?: string): boolean {
  const tags = Object.fromEntries(array(aws.json(['kms', 'list-resource-tags', '--key-id', keyArn], {region}).Tags).map((tag: any) => [tag.TagKey, tag.TagValue]))
  return tags.ManagedBy === MANAGED_BY && tags.Deployment === owner.deployment && tags.Cluster === owner.cluster && tags.CatalogEntry === owner.catalogEntry
}

/**
 * A key the CLI does not own is never changed. Its key policy must either
 * delegate to the account's IAM policies or name the workload role, or the
 * role's IAM grant has no effect.
 */
export function assertKeyPolicyAllowsRole(aws: Aws, keyArn: string, account: string, roleArn: string, region?: string): void {
  const text = aws.json(['kms', 'get-key-policy', '--key-id', keyArn, '--policy-name', 'default'], {region}).Policy
  const policy = typeof text === 'string' ? JSON.parse(text) : text
  const principals = (statement: any): string[] => array(statement?.Principal?.AWS)
  const allows = (statement: any, action: string) => statement?.Effect === 'Allow' && !statement.Condition && array(statement.Action).some((item: string) => item === 'kms:*' || item === action)
  const delegated = array(policy?.Statement).some(statement => allows(statement, 'kms:Sign') && principals(statement).some(principal => principal === `arn:aws:iam::${account}:root` || principal === account))
  const named = ['kms:GetPublicKey', 'kms:Sign'].every(action => array(policy?.Statement).some(statement => allows(statement, action) && principals(statement).includes(roleArn)))
  if (!delegated && !named) throw new Error(`KMS key ${keyArn} is not owned by this deployment and its key policy neither delegates to account IAM policies nor allows ${roleArn}; ask the key owner to add {"Effect":"Allow","Principal":{"AWS":"${roleArn}"},"Action":["kms:GetPublicKey","kms:Sign"],"Resource":"*"}`)
}
