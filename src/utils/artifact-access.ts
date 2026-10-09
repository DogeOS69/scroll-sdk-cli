import {isDeepStrictEqual} from 'node:util'

import type {ArtifactStore} from './artifact-stores.js'
import type {AwsCliRunner} from './aws-cli.js'

import {DENY_INSECURE_TRANSPORT_SID, denyInsecureTransportStatement, findUnmanagedAnonymousGrant, normalizeProofBucketName, normalizeProofKeyPrefix} from './proof-aws-provisioner.js'

type Document = Record<string, unknown>
type Aws = Pick<AwsCliRunner, 'json' | 'run' | 'text'>

/** Buckets this command owns. The proof artifact bucket is owned by proof-aws-init. */
export type ArchiveStoreKind = 'da' | 'snapshot'

/** Key namespace eth-da-submitter writes in the proof artifact store. */
export const SEGMENTATION_SIDECAR_NAMESPACE = 'scroll-chunk-segmentation-sidecars'

/**
 * Stable statement ids. Each bucket is dedicated to one store, so ids are not
 * prefix-scoped: the kill switch is "remove the PublicRead statement", and
 * our services keep reading through the VPC endpoint statement.
 */
export const ARCHIVE_POLICY_SIDS = {
  da: {publicRead: 'ScrollSdkDaArchivePublicRead', vpceRead: 'ScrollSdkDaArchiveReadViaVpcEndpoint'},
  snapshot: {publicRead: 'ScrollSdkSnapshotPublicRead', vpceRead: 'ScrollSdkSnapshotReadViaVpcEndpoint'},
} as const
// The DA name is the one setup eth-da-submitter has always used, so both
// commands manage, and narrow in place, the same inline policy.
export const ARCHIVE_WRITER_POLICY_NAMES = {da: 'eth-da-submitter-s3-archive', snapshot: 'ScrollSdkSnapshotWrite'} as const

export interface ArtifactAccessOptions {
  /** true adds the anonymous read statement, false removes it (kill switch), undefined leaves it. */
  publicRead?: boolean
  /** da only: the proof artifact store, when configured; the DA writer also puts its sidecar namespace there. */
  sidecarStore?: ArtifactStore
  /** S3 Gateway endpoint our services read through; undefined leaves the statement as is. */
  vpcEndpointId?: string
  /** da: the eth-da-submitter IRSA role; snapshot: the deploy role. */
  writerRoleArn?: string
}

export interface ArtifactAccessPlan {
  bucket: string
  bucketPolicy: {after: Document; before: Document; changed: boolean}
  keyPrefix: string
  kind: ArchiveStoreKind
  region: string
  versioning: {before: string; changed: boolean}
  writerPolicy?: {after: Document; before?: Document; changed: boolean; name: string; roleArn: string; roleName: string}
}

function document(value: unknown): Document {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an AWS policy object')
  return value as Document
}

function statementsOf(policy: Document): Document[] {
  return (policy.Statement === undefined ? [] : Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement]).map(item => document(item))
}

function bucketPolicy(aws: Aws, store: Pick<ArtifactAccessPlan, 'bucket' | 'region'>): Document {
  try {
    return document(JSON.parse(aws.text(['s3api', 'get-bucket-policy', '--bucket', store.bucket], {query: 'Policy', region: store.region})))
  } catch (error) {
    if (String(error).includes('NoSuchBucketPolicy')) return {Statement: [], Version: '2012-10-17'}
    throw error
  }
}

function versioningStatus(aws: Aws, store: Pick<ArtifactAccessPlan, 'bucket' | 'region'>): string {
  return String(aws.json(['s3api', 'get-bucket-versioning', '--bucket', store.bucket], {region: store.region})?.Status ?? 'Disabled')
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

function objectArn(bucket: string, keyPrefix: string | undefined): string {
  return keyPrefix ? `arn:aws:s3:::${bucket}/${keyPrefix}/*` : `arn:aws:s3:::${bucket}/*`
}

/**
 * Reconcile the CLI-owned statements of a DA archive or snapshot bucket
 * policy. Statements with other Sids are preserved verbatim.
 */
export function buildArchiveBucketPolicy(
  existing: Document,
  kind: ArchiveStoreKind,
  bucket: string,
  keyPrefix: string,
  options: Pick<ArtifactAccessOptions, 'publicRead' | 'vpcEndpointId'>,
): Document {
  const sids = ARCHIVE_POLICY_SIDS[kind]
  const resource = objectArn(normalizeProofBucketName(bucket), normalizeProofKeyPrefix(keyPrefix))
  const publicRead = {Action: 's3:GetObject', Effect: 'Allow', Principal: '*', Resource: resource, Sid: sids.publicRead}
  const vpceRead = (endpointId: unknown): Document => ({
    Action: 's3:GetObject',
    Condition: {StringEquals: {'aws:SourceVpce': endpointId}},
    Effect: 'Allow',
    Principal: '*',
    Resource: resource,
    Sid: sids.vpceRead,
  })
  const current = new Map(statementsOf(existing).filter(item => typeof item.Sid === 'string').map(item => [item.Sid as string, item]))
  // A preserved owned statement is trusted only in its exact canonical shape;
  // anything else under an owned Sid (e.g. an added PutObject) must be
  // reconciled explicitly, never carried forward under the CLI's name.
  const preserved = (sid: string, canonical: (item: Document) => Document, flag: string): Document | undefined => {
    const item = current.get(sid)
    if (item && !isDeepStrictEqual(item, canonical(item))) {
      throw new Error(`Bucket policy statement ${sid} is not the canonical CLI statement for s3://${bucket}/${keyPrefix}; reconcile it explicitly with ${flag}`)
    }

    return item
  }

  const desired: Record<string, Document | undefined> = {
    [DENY_INSECURE_TRANSPORT_SID]: denyInsecureTransportStatement(bucket),
    [sids.publicRead]: options.publicRead === undefined
      ? preserved(sids.publicRead, () => publicRead, '--public-read or --no-public-read')
      : options.publicRead ? publicRead : undefined,
    [sids.vpceRead]: options.vpcEndpointId === undefined
      ? preserved(sids.vpceRead, item => vpceRead((item.Condition as any)?.StringEquals?.['aws:SourceVpce']), '--vpc-endpoint-id')
      : vpceRead(options.vpcEndpointId),
  }
  const owned = new Set(Object.keys(desired))
  const statements = [
    ...statementsOf(existing).filter(item => !owned.has(item.Sid as string)),
    ...Object.values(desired).filter((item): item is Document => item !== undefined),
  ]
  return {...existing, Statement: statements, Version: existing.Version ?? '2012-10-17'}
}

/**
 * Writer identity policy. The DA writer (eth-da-submitter) puts DA blobs and
 * its segmentation sidecars, and reads back an existing occupant after a
 * conditional put; it never lists or deletes. The snapshot writer (deploy
 * role) only puts.
 */
export function buildArchiveWriterPolicy(kind: ArchiveStoreKind, store: {bucket: string; keyPrefix?: string}, sidecarStore?: Pick<ArtifactStore, 'bucket' | 'keyPrefix'>): Document {
  if (kind === 'snapshot') {
    return {Statement: [{Action: 's3:PutObject', Effect: 'Allow', Resource: objectArn(store.bucket, store.keyPrefix), Sid: 'SnapshotPut'}], Version: '2012-10-17'}
  }

  return {
    Statement: [
      {Action: ['s3:GetObject', 's3:PutObject'], Effect: 'Allow', Resource: objectArn(store.bucket, store.keyPrefix), Sid: 'DaArchivePut'},
      ...(sidecarStore ? [{Action: ['s3:GetObject', 's3:PutObject'], Effect: 'Allow', Resource: objectArn(sidecarStore.bucket, `${sidecarStore.keyPrefix}/${SEGMENTATION_SIDECAR_NAMESPACE}`), Sid: 'SegmentationSidecarPut'}] : []),
    ],
    Version: '2012-10-17',
  }
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
        throw new Error(`${scope} Public Access Block prevents public read; have the bucket owner allow public bucket policies (ACLs stay blocked)`)
      }
    } catch (error) {
      if (!String(error).includes('NoSuchPublicAccessBlockConfiguration')) throw error
    }
  }
}

/**
 * The requested posture only holds if no statement the CLI does not own also
 * grants anonymous access to the prefix (e.g. a legacy setup artifact-access
 * ScrollSdkArtifactRead* grant, or a public write). Such statements are never
 * deleted silently; the operator removes them.
 */
function assertNoUnmanagedAnonymousGrant(policy: Document, kind: ArchiveStoreKind, bucket: string, keyPrefix: string): void {
  const sids = ARCHIVE_POLICY_SIDS[kind]
  const unmanaged = findUnmanagedAnonymousGrant(policy, bucket, keyPrefix, [sids.publicRead, sids.vpceRead])
  if (!unmanaged) return
  const sid = typeof unmanaged.Sid === 'string' ? unmanaged.Sid : '<without Sid>'
  const legacy = sid.startsWith('ScrollSdkArtifactRead') ? ' (a legacy setup artifact-access grant)' : ''
  throw new Error(
    `Bucket policy statement ${sid}${legacy} grants anonymous ${JSON.stringify(unmanaged.Action)} on s3://${bucket}/${keyPrefix} `
    + `outside the CLI-managed statements, so the requested access posture would not hold. Remove that statement from the bucket policy, then rerun.`,
  )
}

/**
 * Without the public statement, credential-free reads by our services depend
 * on the VPC endpoint statement: it must exist for this prefix and name an
 * available S3 Gateway endpoint in the bucket's region.
 */
function assertClusterReadPath(aws: Aws, policy: Document, kind: ArchiveStoreKind, bucket: string, keyPrefix: string, region: string): void {
  const sids = ARCHIVE_POLICY_SIDS[kind]
  const statements = statementsOf(policy)
  if (statements.some(item => item.Sid === sids.publicRead)) return
  const vpce = statements.find(item => item.Sid === sids.vpceRead)
  const endpointId = (vpce?.Condition as any)?.StringEquals?.['aws:SourceVpce']
  if (!vpce || vpce.Resource !== objectArn(bucket, keyPrefix) || typeof endpointId !== 'string') {
    throw new Error(`Refusing a ${kind} bucket policy without public read and without a VPC endpoint read statement for s3://${bucket}/${keyPrefix}: our services would lose read access. Pass --vpc-endpoint-id for the cluster's ${region} S3 Gateway endpoint`)
  }

  const endpoint = aws.json(['ec2', 'describe-vpc-endpoints', '--vpc-endpoint-ids', endpointId], {region})?.VpcEndpoints?.[0]
  if (endpoint?.VpcEndpointType !== 'Gateway' || endpoint?.ServiceName !== `com.amazonaws.${region}.s3` || endpoint?.State !== 'available') {
    throw new Error(`VPC endpoint ${endpointId} is not an available ${region} S3 Gateway endpoint (type=${String(endpoint?.VpcEndpointType)} service=${String(endpoint?.ServiceName)} state=${String(endpoint?.State)}); our services could not read s3://${bucket}/${keyPrefix} without public read`)
  }
}

export function planArtifactAccess(aws: Aws, kind: ArchiveStoreKind, store: ArtifactStore, options: ArtifactAccessOptions): ArtifactAccessPlan {
  const bucket = normalizeProofBucketName(store.bucket)
  const keyPrefix = normalizeProofKeyPrefix(store.keyPrefix)
  if (options.vpcEndpointId !== undefined && !/^vpce-[\da-f]+$/i.test(options.vpcEndpointId)) throw new Error('Expected an S3 Gateway VPC endpoint id (vpce-...)')
  const plan = {bucket, keyPrefix, kind, region: store.region} as ArtifactAccessPlan
  if (options.publicRead) {
    if (store.endpointUrl && ![`https://s3.${store.region}.amazonaws.com`, 'https://s3.amazonaws.com'].includes(store.endpointUrl)) throw new Error('Public S3 policy requires the AWS S3 endpoint; configure a custom gateway with its owner')
    assertPublicAccessBlock(aws, bucket, store.region)
  }

  const before = bucketPolicy(aws, plan)
  const after = buildArchiveBucketPolicy(before, kind, bucket, keyPrefix, options)
  assertNoUnmanagedAnonymousGrant(after, kind, bucket, keyPrefix)
  assertClusterReadPath(aws, after, kind, bucket, keyPrefix, store.region)
  plan.bucketPolicy = {after, before, changed: !isDeepStrictEqual(before, after)}
  const status = versioningStatus(aws, plan)
  plan.versioning = {before: status, changed: status !== 'Enabled'}

  if (options.writerRoleArn) {
    if (!/^arn:aws:iam::\d{12}:role\/[\w+,./=@-]+$/.test(options.writerRoleArn)) throw new Error('Expected an AWS IAM writer role ARN')
    const roleName = options.writerRoleArn.split('/').at(-1)!
    const role = aws.json(['iam', 'get-role', '--role-name', roleName]).Role
    if (role?.Arn !== options.writerRoleArn) throw new Error('Writer role ARN does not match AWS readback')
    const name = ARCHIVE_WRITER_POLICY_NAMES[kind]
    const writerBefore = rolePolicy(aws, roleName, name)
    const writerAfter = buildArchiveWriterPolicy(kind, {bucket, keyPrefix}, options.sidecarStore)
    plan.writerPolicy = {after: writerAfter, before: writerBefore, changed: !isDeepStrictEqual(writerBefore, writerAfter), name, roleArn: options.writerRoleArn, roleName}
  }

  return plan
}

export function applyArtifactAccess(aws: Aws, plan: ArtifactAccessPlan): void {
  // Re-read every mutation target before the first write. AWS bucket policy
  // replacement has no compare-and-swap; serialize policy updates operationally.
  if (!isDeepStrictEqual(bucketPolicy(aws, plan), plan.bucketPolicy.before)) throw new Error('Bucket policy changed after planning; rerun artifact-access')
  if (plan.writerPolicy && !isDeepStrictEqual(rolePolicy(aws, plan.writerPolicy.roleName, plan.writerPolicy.name), plan.writerPolicy.before)) throw new Error('Writer policy changed after planning; rerun artifact-access')
  if (plan.versioning.changed) {
    aws.run(['s3api', 'put-bucket-versioning', '--bucket', plan.bucket, '--versioning-configuration', 'Status=Enabled'], {region: plan.region})
    if (versioningStatus(aws, plan) !== 'Enabled') throw new Error('Bucket versioning readback mismatch')
  }

  if (plan.bucketPolicy.changed) {
    aws.run(['s3api', 'put-bucket-policy', '--bucket', plan.bucket, '--policy', JSON.stringify(plan.bucketPolicy.after)], {region: plan.region})
    if (!isDeepStrictEqual(bucketPolicy(aws, plan), plan.bucketPolicy.after)) throw new Error('Bucket policy readback mismatch')
  }

  const writer = plan.writerPolicy
  if (writer?.changed) {
    aws.run(['iam', 'put-role-policy', '--role-name', writer.roleName, '--policy-name', writer.name, '--policy-document', JSON.stringify(writer.after)])
    if (!isDeepStrictEqual(rolePolicy(aws, writer.roleName, writer.name), writer.after)) throw new Error('Writer policy readback mismatch')
  }
}

/**
 * Read-only check: bucket policy, versioning and the managed writer policy
 * must already equal the plan, then IAM simulation confirms the writer's
 * actions. Simulation is diagnostic, not proof of live S3 access (SCP, bucket,
 * endpoint policies and KMS can still deny an actual workload request), and
 * other policies attached to the role are not audited.
 */
export function checkArtifactAccess(aws: Aws, plan: ArtifactAccessPlan): void {
  if (plan.bucketPolicy.changed || plan.versioning.changed) throw new Error('Bucket policy or versioning differs from the requested state; review the plan, then --apply')
  if (plan.writerPolicy?.changed) throw new Error(`Writer inline policy ${plan.writerPolicy.name} on ${plan.writerPolicy.roleName} differs from the managed policy; review the plan, then --apply`)
  if (!plan.writerPolicy) return
  for (const statement of statementsOf(plan.writerPolicy.after)) {
    const actions = (Array.isArray(statement.Action) ? statement.Action : [statement.Action]) as string[]
    const resource = String(statement.Resource).replace(/\*$/, '0xpreflight')
    const result = aws.json(['iam', 'simulate-principal-policy', '--policy-source-arn', plan.writerPolicy.roleArn, '--action-names', ...actions, '--resource-arns', resource])
    const rows = result.EvaluationResults
    for (const action of actions) {
      const matches = Array.isArray(rows) ? rows.filter(row => row.EvalActionName === action && row.EvalResourceName === resource) : []
      if (matches.length !== 1 || matches[0].EvalDecision !== 'allowed' || matches[0].MissingContextValues?.length) throw new Error(`Writer IAM simulation did not allow ${action} on ${resource}; run artifact-access --writer-role-arn ... --apply and check external denies`)
    }
  }
}
