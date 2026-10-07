import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'

import type {AwsCliRunner} from './aws-cli.js'
import type {SharedArtifactStore} from './proof-shared-artifact-store.js'

import {buildProofArtifactStorePolicy, normalizeProofBucketName, normalizeProofKeyPrefix, publicArtifactObjectResources} from './proof-aws-provisioner.js'

type Document = Record<string, unknown>
type Aws = Pick<AwsCliRunner, 'json' | 'run' | 'text'>
export interface ArtifactAccessPlan {
  bucket: string
  bucketPolicy?: {after: Document; before: Document; changed: boolean}
  keyPrefix: string
  region: string
  writerPolicy?: {after: Document; before?: Document; changed: boolean; name: string; roleArn: string; roleName: string}
}

function document(value: unknown): Document {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an AWS policy object')
  return value as Document
}

function bucketPolicy(aws: Aws, store: Pick<SharedArtifactStore, 'bucket' | 'region'>): Document {
  try {
    return document(JSON.parse(aws.text(['s3api', 'get-bucket-policy', '--bucket', store.bucket], {query: 'Policy', region: store.region})))
  } catch (error) {
    if (String(error).includes('NoSuchBucketPolicy')) return {Statement: [], Version: '2012-10-17'}
    throw error
  }
}

function rolePolicy(aws: Aws, roleName: string, name: string): Document | undefined {
  try {
    const result = aws.json(['iam', 'get-role-policy', '--role-name', roleName, '--policy-name', name])
    return document(typeof result.PolicyDocument === 'string' ? JSON.parse(decodeURIComponent(result.PolicyDocument)) : result.PolicyDocument)
  } catch (error) {
    if (String(error).includes('NoSuchEntity')) return undefined
    throw error
  }
}

/** Add only this prefix's public object namespaces; never replace another
 * instance's grants, remove Deny statements, or alter Public Access Block. */
export function appendArtifactPublicRead(existing: Document, bucket: string, keyPrefix: string): Document {
  const resources = publicArtifactObjectResources(normalizeProofBucketName(bucket), normalizeProofKeyPrefix(keyPrefix))
  const sid = `ScrollSdkArtifactRead${createHash('sha256').update(`${bucket}/${keyPrefix}`).digest('hex').slice(0, 24)}`
  const statements = existing.Statement === undefined ? [] : Array.isArray(existing.Statement) ? existing.Statement : [existing.Statement]
  const statement = {Action: 's3:GetObject', Effect: 'Allow', Principal: '*', Resource: resources, Sid: sid}
  const previous = statements.filter(item => document(item).Sid === sid)
  if (previous.length > 1 || (previous.length === 1 && !isDeepStrictEqual(previous[0], statement))) {
    throw new Error(`Existing bucket policy statement ${sid} differs; review it before changing permissions`)
  }

  return {...existing, Statement: previous.length > 0 ? statements : [...statements, statement], Version: existing.Version ?? '2012-10-17'}
}

function assertPublicAccessBlock(aws: Aws, bucket: string, region: string): void {
  const account = aws.text(['sts', 'get-caller-identity'], {query: 'Account'})
  // Account-level protection must be checked for the bucket owner, not an
  // unrelated caller account with cross-account read access.
  aws.run(['s3api', 'head-bucket', '--bucket', bucket, '--expected-bucket-owner', account], {region})
  for (const [scope, args] of [
    ['bucket', ['s3api', 'get-public-access-block', '--bucket', bucket]],
    ['account', ['s3control', 'get-public-access-block', '--account-id', account]],
  ] as const) {
    try {
      const config = aws.json([...args], {region}).PublicAccessBlockConfiguration
      if (!config || typeof config !== 'object') throw new Error(`Missing ${scope} Public Access Block response`)
      if (config.BlockPublicPolicy || config.RestrictPublicBuckets) {
        throw new Error(`${scope} Public Access Block prevents public artifact policy/read access; use an existing gateway or have the owner configure public access`)
      }
    } catch (error) {
      if (!String(error).includes('NoSuchPublicAccessBlockConfiguration')) throw error
    }
  }
}

export function planArtifactAccess(aws: Aws, store: SharedArtifactStore, options: {publicRead?: boolean; writerRoleArn?: string}): ArtifactAccessPlan {
  const bucket = normalizeProofBucketName(store.bucket)
  const keyPrefix = normalizeProofKeyPrefix(store.keyPrefix)
  if (!options.publicRead && !options.writerRoleArn) throw new Error('Select --public-read and/or --writer-role-arn')
  const plan: ArtifactAccessPlan = {bucket, keyPrefix, region: store.region}
  if (options.publicRead) {
    if (store.endpointUrl && ![`https://s3.${store.region}.amazonaws.com`, 'https://s3.amazonaws.com'].includes(store.endpointUrl)) throw new Error('Public S3 policy repair requires the AWS S3 endpoint; configure a custom gateway with its owner')
    assertPublicAccessBlock(aws, bucket, store.region)
    const before = bucketPolicy(aws, store)
    const after = appendArtifactPublicRead(before, bucket, keyPrefix)
    plan.bucketPolicy = {after, before, changed: !isDeepStrictEqual(before, after)}
  }

  if (options.writerRoleArn) {
    if (!/^arn:aws:iam::\d{12}:role\/[\w+,./=@-]+$/.test(options.writerRoleArn)) throw new Error('Expected an AWS IAM writer role ARN')
    const roleName = options.writerRoleArn.split('/').at(-1)!
    const role = aws.json(['iam', 'get-role', '--role-name', roleName]).Role
    if (role?.Arn !== options.writerRoleArn) throw new Error('Writer role ARN does not match AWS readback')
    const name = `ScrollSdkArtifactWrite-${createHash('sha256').update(`${bucket}/${keyPrefix}`).digest('hex').slice(0, 24)}`
    const before = rolePolicy(aws, roleName, name)
    const after = buildProofArtifactStorePolicy(bucket, keyPrefix)
    if (before && !isDeepStrictEqual(before, after)) throw new Error(`Existing inline policy ${name} differs; review it before changing permissions`)
    plan.writerPolicy = {after, before, changed: !isDeepStrictEqual(before, after), name, roleArn: options.writerRoleArn, roleName}
  }

  return plan
}

export function applyArtifactAccess(aws: Aws, plan: ArtifactAccessPlan): void {
  // Re-read every mutation target before the first write. AWS bucket policy
  // replacement has no compare-and-swap; serialize policy updates operationally.
  if (plan.bucketPolicy && !isDeepStrictEqual(bucketPolicy(aws, plan), plan.bucketPolicy.before)) throw new Error('Bucket policy changed after planning; rerun artifact-access')
  if (plan.writerPolicy && !isDeepStrictEqual(rolePolicy(aws, plan.writerPolicy.roleName, plan.writerPolicy.name), plan.writerPolicy.before)) throw new Error('Writer policy changed after planning; rerun artifact-access')
  if (plan.bucketPolicy?.changed) {
    aws.run(['s3api', 'put-bucket-policy', '--bucket', plan.bucket, '--policy', JSON.stringify(plan.bucketPolicy.after)], {region: plan.region})
    if (!isDeepStrictEqual(bucketPolicy(aws, plan), plan.bucketPolicy.after)) throw new Error('Bucket policy readback mismatch')
  }

  const writer = plan.writerPolicy
  if (writer?.changed) {
    aws.run(['iam', 'put-role-policy', '--role-name', writer.roleName, '--policy-name', writer.name, '--policy-document', JSON.stringify(writer.after)])
    if (!isDeepStrictEqual(rolePolicy(aws, writer.roleName, writer.name), writer.after)) throw new Error('Writer policy readback mismatch')
  }
}

/** IAM simulation is diagnostic, not proof of live S3 access (SCP, bucket,
 * endpoint policies and KMS can still deny an actual workload request). */
export function checkArtifactWriter(aws: Aws, plan: ArtifactAccessPlan): void {
  if (!plan.writerPolicy) return
  const resources = [
    {actions: ['s3:GetObject', 's3:PutObject'], context: [], resource: `arn:aws:s3:::${plan.bucket}/${plan.keyPrefix}/0xpreflight`},
    {actions: ['s3:ListBucket'], context: ['--context-entries', JSON.stringify([{ContextKeyName: 's3:prefix', ContextKeyType: 'string', ContextKeyValues: [plan.keyPrefix]}])], resource: `arn:aws:s3:::${plan.bucket}`},
  ]
  for (const {actions, context, resource} of resources) {
    const result = aws.json(['iam', 'simulate-principal-policy', '--policy-source-arn', plan.writerPolicy.roleArn, '--action-names', ...actions, '--resource-arns', resource, ...context])
    const rows = result.EvaluationResults
    for (const action of actions) {
      const matches = Array.isArray(rows) ? rows.filter(row => row.EvalActionName === action && row.EvalResourceName === resource) : []
      if (matches.length !== 1 || matches[0].EvalDecision !== 'allowed' || matches[0].MissingContextValues?.length) throw new Error(`Writer IAM simulation did not allow ${action} on the current artifact prefix; run artifact-access --writer-role-arn ... --apply and check external denies`)
    }
  }
}
