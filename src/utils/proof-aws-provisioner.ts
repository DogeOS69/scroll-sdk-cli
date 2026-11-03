/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and aws CLI JSON are dynamic documents. */

import { parse as parseToml } from '@iarna/toml'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { AwsCliRunner } from './aws-cli.js'
import {bindAwsServiceAccount} from './aws-workload-identity.js'

export interface ProofAwsIdentity {
  /** Region containing the proof artifact bucket. */
  artifactRegion?: string
  /** Region containing EKS and the deployment-scoped Secrets Manager secret. */
  awsRegion: string
  deploymentAlias: string
  eksCluster: string
  namespace: string
}

export interface ProofAwsProvisionResult {
  artifactReadTransport: ProofArtifactReadTransportResult
  bucket: string
  bucketCreated: boolean
  /** Bound by the aws-roles preparation step, never by resource provisioning. */
  coordinatorRoleArn?: string
  secretAction: 'created' | 'migrated' | 'reused' | 'rotated'
  secretName: string
  withdrawalRoleArn?: string
}

export interface ProofArtifactReadPlan {
  publicEndpointUrl?: string
  publicReadMode: ProofArtifactPublicReadMode
  vpcEndpoint?: ProofArtifactVpcEndpointPlan
}

export interface ProofArtifactReadTransportResult {
  publicEndpointUrl: string
  publicReadMode: ProofArtifactPublicReadMode
  publicStatus: 'configured-unverified' | 'operator-managed-unverified'
  vpcEndpoint?: ProofArtifactVpcEndpointResult
}

export type ProofArtifactPublicReadMode = 'direct-s3' | 'existing-gateway' | 'existing-public-s3'

export interface ProofArtifactVpcEndpointPlan {
  enabled: boolean
  routeTableIds?: string[]
  vpcEndpointId?: string
}

export interface ProofArtifactVpcEndpointResult {
  created: boolean
  routeTableIds: string[]
  status: 'configured-unverified'
  vpcEndpointId: string
}

/**
 * Coordinator-only worker-credential master (dogeos-core #1591). Workers get
 * per-worker credentials minted from it, never the master itself. The property
 * is new rather than a reuse of the retired shared `prover-worker-token`: every
 * worker that ever held the shared token could mint any worker name with it.
 */
export const PROVER_WORKER_MASTER_PROPERTY = 'prover-worker-master'
/**
 * Secrets Manager property -> coordinator Kubernetes Secret key. The master
 * keeps the `prover-worker-token` key, so the coordinator's
 * `worker_auth_token_file` path (`/app/secrets/prover-worker-token`) is unchanged.
 */
export const PROOF_SECRET_MAPPINGS = [
  {property: 'proof-work-token', secretKey: 'proof-work-token'},
  {property: PROVER_WORKER_MASTER_PROPERTY, secretKey: 'prover-worker-token'},
] as const
export const PROOF_SECRET_PROPERTIES = PROOF_SECRET_MAPPINGS.map(mapping => mapping.property)
const PROOF_SECRET_KEYS: readonly string[] = PROOF_SECRET_MAPPINGS.map(mapping => mapping.secretKey)
export const PROOF_ARTIFACT_PUBLIC_READ_POLICY_SID = 'ScrollSdkProofArtifactPublicRead'
export const PROOF_ARTIFACT_VPCE_POLICY_SID = 'ScrollSdkProofArtifactReadViaVpcEndpoint'
export const DENY_INSECURE_TRANSPORT_SID = 'ScrollSdkDenyInsecureTransport'

/** TLS-only: deny every request to the bucket that is not over HTTPS. */
export function denyInsecureTransportStatement(bucket: string): Record<string, any> {
  return {
    Action: 's3:*',
    Condition: {Bool: {'aws:SecureTransport': 'false'}},
    Effect: 'Deny',
    Principal: '*',
    Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
    Sid: DENY_INSECURE_TRANSPORT_SID,
  }
}

/**
 * Logical object namespaces read without AWS credentials by external proof
 * Workers or partner Attestation Signers, including published signer
 * deployment kits. DA blobs live in the separate DA archive bucket. The
 * segmentation sidecar namespace is deliberately absent because it is a
 * PC-internal input.
 */
export const PUBLIC_ARTIFACT_OBJECT_PATTERNS = [
  'input-specs/*',
  'prepared-bundles/*',
  'witnesses/*',
  'public-outputs/*',
  'proofs/*',
  'proof-programs/*',
  'signer-policy-evidence/*',
  'deployment-kits/*',
] as const

export function publicArtifactObjectResources(bucket: string, keyPrefix: string): string[] {
  const prefix = normalizeProofKeyPrefix(keyPrefix)
  return PUBLIC_ARTIFACT_OBJECT_PATTERNS.map(pattern =>
    `arn:aws:s3:::${bucket}/${prefix}/${pattern}`
  )
}

/** A bucket policy is shared by every deployment; statement ownership is per prefix. */
export function proofArtifactPolicySid(kind: 'public' | 'vpce', bucket: string, keyPrefix: string): string {
  const prefix = normalizeProofKeyPrefix(keyPrefix)
  const base = kind === 'public' ? PROOF_ARTIFACT_PUBLIC_READ_POLICY_SID : PROOF_ARTIFACT_VPCE_POLICY_SID
  return `${base}${createHash('sha256').update(`${bucket}/${prefix}`).digest('hex').slice(0, 24)}`
}

function ownedReadStatement(statement: any, bucket: string, prefix: string, kind: 'public' | 'vpce'): boolean {
  const legacySid = kind === 'public' ? PROOF_ARTIFACT_PUBLIC_READ_POLICY_SID : PROOF_ARTIFACT_VPCE_POLICY_SID
  if (statement?.Sid !== legacySid && statement?.Sid !== proofArtifactPolicySid(kind, bucket, prefix)) return false
  const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action]
  const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource]
  const scopedResource = `arn:aws:s3:::${bucket}/${prefix}/*`
  const expectedResources = kind === 'public' ? publicArtifactObjectResources(bucket, prefix) : [scopedResource]
  // Before core #1482 the proof store also held raw DA blobs. Recognize that
  // exact old grant when narrowing this deployment to proof-only reads.
  if (kind === 'public') expectedResources.push(`arn:aws:s3:::${bucket}/${prefix}/0x*`)
  // Old direct-read policies may have exposed this exact prefix wholesale.
  // Never infer ownership of a child deployment from a startsWith comparison.
  if (kind === 'public' && statement.Sid === legacySid) expectedResources.push(scopedResource)
  if (statement.Effect !== 'Allow' || statement.Principal !== '*' || actions.length !== 1 || actions[0] !== 's3:GetObject'
    || statement.NotAction !== undefined || statement.NotResource !== undefined || statement.NotPrincipal !== undefined
    || resources.length === 0 || resources.some((resource: unknown) => typeof resource !== 'string' || !expectedResources.includes(resource))) return false
  if (kind === 'public') return statement.Condition === undefined
  const condition = statement.Condition
  return condition && Object.keys(condition).length === 1 && condition.StringEquals
    && Object.keys(condition.StringEquals).length === 1
    && typeof condition.StringEquals['aws:SourceVpce'] === 'string'
}

function preserveOtherReadStatements(existingPolicy: Record<string, any>, bucket: string, prefix: string, kind: 'public' | 'vpce'): any[] {
  const statements = Array.isArray(existingPolicy.Statement) ? existingPolicy.Statement : existingPolicy.Statement ? [existingPolicy.Statement] : []
  const sid = proofArtifactPolicySid(kind, bucket, prefix)
  const matching = statements.filter((statement: any) => statement?.Sid === sid)
  if (matching.length > 1 || matching.some((statement: any) => !ownedReadStatement(statement, bucket, prefix, kind))) {
    throw new Error(`Bucket policy statement ${sid} differs from its managed read grant; review it before changing permissions`)
  }

  // Migrate a legacy fixed Sid only when ALL its resources belong to this
  // deployment. A sibling's legacy grant or an operator's broad grant survives.
  return statements.filter((statement: any) => !ownedReadStatement(statement, bucket, prefix, kind))
}

export interface ProofAwsValuesProjection {
  artifactRegion: string
  bucket: string
  coordinatorRoleArn: string
  coordinatorServiceAccount: string
  keyPrefix: string
  secretName: string
  secretRegion: string
  withdrawalRoleArn: string
  withdrawalServiceAccount: string
  workloadIdentity?: 'irsa' | 'pod-identity'
}

function upsertEnv(values: Record<string, any>, name: string, value: string, label: string): void {
  values.env ||= []
  if (!Array.isArray(values.env)) throw new TypeError(`${label}: env must be an array`)
  const existing = values.env.find((item: any) => item?.name === name)
  if (existing) {
    existing.value = value
    delete existing.valueFrom
  } else {
    values.env.push({ name, value })
  }
}

export function normalizeProofKeyPrefix(value: string): string {
  const prefix = value.trim()
  if (!prefix || Buffer.byteLength(prefix) > 256) {
    throw new Error('proof artifact key prefix must be a non-empty string of at most 256 bytes')
  }

  if (prefix.startsWith('/') || prefix.endsWith('/')) {
    throw new Error('proof artifact key prefix must not start or end with /')
  }

  const segments = prefix.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('proof artifact key prefix must contain only non-empty path segments and must not contain . or ..')
  }

  const forbiddenCharacters = ['\\', '*', '?', '#', '[', ']', '{', '}']
  const hasControlCharacter = [...prefix].some(character => {
    const codePoint = character.codePointAt(0) as number
    return codePoint < 32 || codePoint === 127
  })
  const hasWhitespace = [...prefix].some(character => /\s/u.test(character))
  if (
    forbiddenCharacters.some(character => prefix.includes(character))
    || hasControlCharacter
    || hasWhitespace
  ) {
    throw new Error('proof artifact key prefix must not contain whitespace, wildcards, backslashes, #, braces, or control characters')
  }

  if (segments.some(segment => !/^[\w.-]+$/.test(segment))) {
    throw new Error("proof artifact key prefix segments may contain only ASCII letters, numbers, '.', '_', or '-'")
  }

  return prefix
}

export function normalizeProofBucketName(value: string): string {
  const bucket = value.trim()
  if (bucket.length < 3 || bucket.length > 63) {
    throw new Error('proof artifact S3 bucket must be 3-63 characters')
  }

  if (!/^[\da-z][\d.a-z-]*[\da-z]$/.test(bucket)) {
    throw new Error(
      'proof artifact S3 bucket must contain only lowercase letters, digits, dots, and hyphens, '
      + 'and must start and end with a letter or digit',
    )
  }

  if (bucket.includes('..')) {
    throw new Error('proof artifact S3 bucket must not contain consecutive dots')
  }

  return bucket
}

/**
 * Public proof artifacts are consumed without AWS credentials by external
 * Workers and partner-operated Attestation Signers. dogeos-core applies the
 * bucket name as a virtual host, so this value is an HTTPS S3-compatible
 * endpoint root rather than a bucket or object URL.
 */
export function normalizeProofArtifactPublicEndpoint(value: string): string {
  const raw = value.trim()
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('proof artifact public endpoint must be an absolute HTTPS URL')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('proof artifact public endpoint must use HTTPS')
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('proof artifact public endpoint must not contain credentials, query parameters, or a fragment')
  }

  const pathname = parsed.pathname.replaceAll(/\/+$/g, '')
  return `${parsed.origin}${pathname}`
}

export function proofArtifactS3Endpoint(region: string): string {
  const normalized = region.trim()
  if (!normalized) throw new Error('proof artifact AWS region must not be empty')
  return `https://s3.${normalized}.amazonaws.com`
}

export function buildProofArtifactStorePolicy(
  bucket: string,
  keyPrefix: string,
  options: {deleteObjects?: boolean; listObjects?: boolean} = {},
): Record<string, any> {
  const prefix = normalizeProofKeyPrefix(keyPrefix)
  const objectActions = ['s3:GetObject', 's3:PutObject']
  if (options.deleteObjects) objectActions.push('s3:DeleteObject')
  return {
    Statement: [
      {
        Action: objectActions,
        Effect: 'Allow',
        Resource: `arn:aws:s3:::${bucket}/${prefix}/*`,
      },
      ...(options.listObjects ? [{
        Action: ['s3:ListBucket'],
        Condition: {
          StringLike: {
            's3:prefix': [prefix, `${prefix}/*`],
          },
        },
        Effect: 'Allow',
        Resource: `arn:aws:s3:::${bucket}`,
      }] : []),
    ],
    Version: '2012-10-17',
  }
}

export function upsertProofArtifactVpcEndpointReadPolicy(
  existingPolicy: Record<string, any>,
  bucket: string,
  keyPrefix: string,
  vpcEndpointId: string
): Record<string, any> {
  const prefix = normalizeProofKeyPrefix(keyPrefix)
  const preservedStatements = preserveOtherReadStatements(existingPolicy, bucket, prefix, 'vpce')
  const readStatement = {
    Action: 's3:GetObject',
    Condition: { StringEquals: { 'aws:SourceVpce': vpcEndpointId } },
    Effect: 'Allow',
    Principal: '*',
    Resource: `arn:aws:s3:::${bucket}/${prefix}/*`,
    Sid: proofArtifactPolicySid('vpce', bucket, prefix),
  }
  preservedStatements.push(readStatement)

  return {
    ...existingPolicy,
    Statement: preservedStatements,
    Version: existingPolicy.Version || '2012-10-17',
  }
}

export function upsertProofArtifactPublicReadPolicy(
  existingPolicy: Record<string, any>,
  bucket: string,
  keyPrefix: string,
  enabled: boolean,
): Record<string, any> {
  const prefix = normalizeProofKeyPrefix(keyPrefix)
  const preservedStatements = preserveOtherReadStatements(existingPolicy, bucket, prefix, 'public')
  // TLS-only applies to the bucket; read grants remain deployment-scoped.
  const tlsIndex = preservedStatements.findIndex(statement => statement?.Sid === DENY_INSECURE_TRANSPORT_SID)
  if (tlsIndex >= 0) {
    preservedStatements[tlsIndex] = denyInsecureTransportStatement(bucket)
  } else if (enabled) {
    preservedStatements.push(denyInsecureTransportStatement(bucket))
  }

  if (enabled) {
    preservedStatements.push({
      Action: 's3:GetObject',
      Effect: 'Allow',
      Principal: '*',
      Resource: publicArtifactObjectResources(bucket, prefix),
      Sid: proofArtifactPolicySid('public', bucket, prefix),
    })
  }

  return {
    ...existingPolicy,
    Statement: preservedStatements,
    Version: existingPolicy.Version || '2012-10-17',
  }
}

const HTTPS_ONLY = [{Bool: {'aws:SecureTransport': 'true'}}, {Bool: {'aws:SecureTransport': true}}]
const HTTP_ONLY = [{Bool: {'aws:SecureTransport': 'false'}}, {Bool: {'aws:SecureTransport': false}}]

function statementMatchesObject(statement: Record<string, any>, objectArn: string): boolean {
  const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource]
  return resources.some((resource: unknown) => typeof resource === 'string' && wildcardMatches(resource, objectArn))
}

/**
 * External-consumer namespaces of one deployment prefix that the bucket policy
 * does not make readable by anonymous HTTPS GetObject. Negated or conditional
 * grants never count; any Deny that could apply to such a request does.
 */
export function missingPublicArtifactReads(policy: Record<string, any>, bucket: string, keyPrefix: string, patterns: readonly string[] = PUBLIC_ARTIFACT_OBJECT_PATTERNS): string[] {
  const prefix = normalizeProofKeyPrefix(keyPrefix)
  const statements: Record<string, any>[] = (Array.isArray(policy.Statement) ? policy.Statement : policy.Statement ? [policy.Statement] : [])
    .filter((statement: unknown) => statement && typeof statement === 'object')
  return patterns.filter(pattern => {
    const object = `arn:aws:s3:::${bucket}/${prefix}/${pattern.slice(0, -1)}scrollsdk-read-check`
    const granted = statements.some(statement => statement.Effect === 'Allow'
      && principalIncludesWildcard(statement.Principal) && actionCanGetObject(statement.Action) && statementMatchesObject(statement, object)
      && statement.NotPrincipal === undefined && statement.NotAction === undefined && statement.NotResource === undefined
      && (statement.Condition === undefined || HTTPS_ONLY.some(condition => isDeepStrictEqual(statement.Condition, condition))))
    const denied = statements.some(statement => statement.Effect === 'Deny'
      && (statement.NotPrincipal !== undefined || principalIncludesWildcard(statement.Principal))
      && (statement.NotAction !== undefined || actionCanGetObject(statement.Action))
      && (statement.NotResource !== undefined || statementMatchesObject(statement, object))
      && !HTTP_ONLY.some(condition => isDeepStrictEqual(statement.Condition, condition)))
    return !granted || denied
  })
}

/**
 * Public Access Block settings that would make a public bucket policy fail or
 * be ignored. Only the bucket-level block may be relaxed, and only when the
 * caller owns that decision; account-level protection is never changed.
 */
export function assertPublicBucketPolicyAllowed(
  aws: Pick<AwsCliRunner, 'json' | 'run' | 'text'>,
  bucket: string,
  region: string,
  allowBucketPublicPolicy = false,
): {after: Record<string, any>; before: Record<string, any>} | undefined {
  let change: {after: Record<string, any>; before: Record<string, any>} | undefined
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
        if (scope === 'bucket' && allowBucketPublicPolicy) {
          change = {after: {BlockPublicAcls: true, BlockPublicPolicy: false, IgnorePublicAcls: true, RestrictPublicBuckets: false}, before: config}
          continue
        }

        throw new Error(`${scope} Public Access Block prevents public read; have the bucket owner allow public bucket policies (ACLs stay blocked)`)
      }
    } catch (error) {
      if (!String(error).includes('NoSuchPublicAccessBlockConfiguration')) throw error
    }
  }

  return change
}

function principalIncludesWildcard(principal: unknown): boolean {
  if (principal === '*') return true
  if (!principal || typeof principal !== 'object' || Array.isArray(principal)) return false
  const awsPrincipal = (principal as Record<string, unknown>).AWS
  return awsPrincipal === '*'
    || (Array.isArray(awsPrincipal) && awsPrincipal.includes('*'))
}

function isVpcEndpointRestricted(statement: Record<string, any>): boolean {
  const condition = statement.Condition
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return false
  const stringEquals = condition.StringEquals
  if (!stringEquals || typeof stringEquals !== 'object' || Array.isArray(stringEquals)) return false
  const sourceVpcEndpoint = stringEquals['aws:SourceVpce']
  return typeof sourceVpcEndpoint === 'string' && /^vpce-[\da-f]+$/i.test(sourceVpcEndpoint)
}

function wildcardMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replaceAll(/[$()+.[\\\]^{|}]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.')
  return new RegExp(`^${escaped}$`, 'u').test(value)
}

function actionCanGetObject(action: unknown): boolean {
  const actions = Array.isArray(action) ? action : [action]
  return actions.some(candidate =>
    typeof candidate === 'string'
    && wildcardMatches(candidate.toLowerCase(), 's3:getobject')
  )
}

function resourceMayOverlapPrefix(resource: unknown, bucket: string, keyPrefix: null | string): boolean {
  if (resource === '*') return true
  if (typeof resource !== 'string') return false

  const match = /^arn:(?:aws|aws-cn|aws-us-gov):s3:::(?<bucket>[^/]+)(?:\/(?<object>.*))?$/u.exec(resource)
  if (!match?.groups || !wildcardMatches(match.groups.bucket, bucket)) return false

  const objectPattern = match.groups.object
  if (objectPattern === undefined) return false
  if (keyPrefix === null) return true

  const managedPrefix = `${normalizeProofKeyPrefix(keyPrefix)}/`
  if (!objectPattern.includes('*') && !objectPattern.includes('?')) {
    return objectPattern === keyPrefix || objectPattern.startsWith(managedPrefix)
  }

  // S3 policy resources normally end in `/*`. Comparing the literal part on
  // both sides also handles broader forms such as `*` and `batches*` without
  // pretending a disjoint sibling such as `rehearsal/*` affects `batches/`.
  const firstWildcard = objectPattern.search(/[?*]/u)
  const literalPrefix = objectPattern.slice(0, firstWildcard)
  return managedPrefix.startsWith(literalPrefix)
    || literalPrefix.startsWith(managedPrefix)
    || wildcardMatches(objectPattern, `${managedPrefix}proofs/example`)
    || wildcardMatches(objectPattern, `${managedPrefix}0xexample`)
}

/**
 * First Allow statement, other than `ownedSids`, that grants any action to
 * an anonymous principal on objects overlapping `bucket/keyPrefix` without
 * a VPC endpoint restriction: a public read or write the caller does not own.
 * A null keyPrefix checks every object prefix in the bucket.
 */
export function findUnmanagedAnonymousGrant(
  policy: Record<string, any>,
  bucket: string,
  keyPrefix: null | string,
  ownedSids: readonly string[],
): Record<string, any> | undefined {
  const statements = Array.isArray(policy.Statement)
    ? policy.Statement
    : policy.Statement ? [policy.Statement] : []
  return statements.find((statement: any) =>
    statement?.Effect === 'Allow'
    && !ownedSids.includes(statement?.Sid)
    && principalIncludesWildcard(statement.Principal)
    && !isVpcEndpointRestricted(statement)
    && (Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource])
      .some((resource: unknown) => resourceMayOverlapPrefix(resource, bucket, keyPrefix))
  )
}

export function assertNoUnmanagedPublicProofBucketGrant(
  policy: Record<string, any>,
  bucket: string,
  keyPrefix: string,
): void {
  // Validate managed-statement conflicts before provisioning can change AWS.
  preserveOtherReadStatements(policy, bucket, normalizeProofKeyPrefix(keyPrefix), 'public')
  const statements = Array.isArray(policy.Statement)
    ? policy.Statement
    : policy.Statement ? [policy.Statement] : []
  const unsafe = statements.find((statement: any) =>
    statement?.Effect === 'Allow'
    && principalIncludesWildcard(statement.Principal)
    && actionCanGetObject(statement.Action)
    && !ownedReadStatement(statement, bucket, normalizeProofKeyPrefix(keyPrefix), 'public')
    && !isVpcEndpointRestricted(statement)
    && (Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource])
      .some((resource: unknown) => resourceMayOverlapPrefix(resource, bucket, keyPrefix))
  )
  if (unsafe) {
    throw new Error(
      `cannot enable direct-s3 proof reads while bucket policy statement `
      + `${String(unsafe.Sid || '<without Sid>')} grants unmanaged public GetObject access overlapping `
      + `s3://${bucket}/${normalizeProofKeyPrefix(keyPrefix)}; use a dedicated proof bucket, remove the statement, `
      + 'or select existing-public-s3 to preserve the operator-managed bucket policy',
    )
  }
}

function hasProofTokenMappings(values: Record<string, any>): boolean {
  const mappedKeys = new Set(
    Object.values(values.externalSecrets || {})
      .flatMap((secret: any) => Array.isArray(secret?.data) ? secret.data : [])
      .map((item: any) => item?.secretKey)
      .filter((key: unknown): key is string => typeof key === 'string')
  )
  return PROOF_SECRET_KEYS.every(key => mappedKeys.has(key))
}

function projectManagedAwsProofSecret(
  values: Record<string, any>,
  secretName: string,
  region: string
): void {
  for (const secret of Object.values(values.externalSecrets || {}) as any[]) {
    if (secret?.provider !== 'aws' || !Array.isArray(secret.data)) continue

    const proofTokenMappings = secret.data.filter((item: any) =>
      PROOF_SECRET_KEYS.includes(item?.secretKey)
      || item?.secretKey === 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__AUTH__BEARER_TOKEN'
    )
    if (proofTokenMappings.length === 0) continue

    // When proof-aws.json is present, its deployment-scoped Secrets Manager
    // path is authoritative for AWS-backed proof tokens. In particular, do
    // not preserve the historical scroll/proof-coordinator-secrets fallback:
    // doing so gives the Coordinator and an external Worker different bearer
    // tokens while both generated configurations still look valid.
    for (const item of proofTokenMappings) {
      item.remoteRef ||= {}
      item.remoteRef.key = secretName
      // Never resolve the coordinator master from the retired shared token.
      if (item.secretKey === 'prover-worker-token') item.remoteRef.property = PROVER_WORKER_MASTER_PROPERTY
    }

    secret.secretRegion = region
  }
}

/**
 * Project validated proof AWS resource facts into the two generated proof
 * values documents. `setup prep-charts` is the sole caller in the operator
 * workflow; proof-aws-init never reads or mutates these output documents.
 */
export function applyProofAwsValues(
  coordinatorValues: Record<string, any>,
  withdrawalValues: Record<string, any>,
  projection: ProofAwsValuesProjection
): void {
  const keyPrefix = normalizeProofKeyPrefix(projection.keyPrefix)
  const content = coordinatorValues.proofCoordinator?.config?.content
  const nativeConfig = typeof content === 'string' && content.trim() ? parseToml(content) as any : undefined
  const artifactEnv = {
    DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__BUCKET: projection.bucket,
    DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__KEY_PREFIX: keyPrefix,
    DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__REGION: projection.artifactRegion,
  }
  if (nativeConfig?.artifact_store?.kind === 'local_fs') {
    // Disabled topology emits an idle local_fs coordinator. Provisioned AWS
    // resources still own IRSA/tokens, but must not override its storage kind.
    if (coordinatorValues.env !== undefined && !Array.isArray(coordinatorValues.env)) {
      throw new TypeError('proof-coordinator values: env must be an array')
    }

    coordinatorValues.env = (coordinatorValues.env || []).filter((item: any) => !Object.hasOwn(artifactEnv, item?.name))
  } else {
    for (const [name, value] of Object.entries(artifactEnv)) {
      upsertEnv(coordinatorValues, name, value, 'proof-coordinator values')
    }
  }

  bindAwsServiceAccount(coordinatorValues, projection.coordinatorServiceAccount, projection.coordinatorRoleArn, projection.workloadIdentity)

  if (!hasProofTokenMappings(coordinatorValues)) {
    coordinatorValues.externalSecrets ||= {}
    coordinatorValues.externalSecrets.secrets = {
      data: PROOF_SECRET_MAPPINGS.map(({property, secretKey}) => ({
        remoteRef: { key: projection.secretName, property },
        secretKey,
      })),
      provider: 'aws',
      refreshInterval: '2m',
      secretRegion: projection.secretRegion,
      serviceAccount: 'external-secrets',
    }
  }

  // Do not rely on historical secret-path or us-west-2 fallbacks. Keep every
  // AWS-backed proof-token mapping aligned with the provisioned resource
  // facts, while leaving operator-owned non-AWS mappings untouched.
  projectManagedAwsProofSecret(coordinatorValues, projection.secretName, projection.secretRegion)

  withdrawalValues.withdrawalProof ||= {}
  withdrawalValues.withdrawalProof.s3AuthMode = projection.workloadIdentity === 'pod-identity' ? 'ambient' : 'irsa'
  bindAwsServiceAccount(withdrawalValues, projection.withdrawalServiceAccount, projection.withdrawalRoleArn, projection.workloadIdentity)
  // Legacy WP templates mix the remote proof token into the service-key Secret.
  // Split that mapping so ordinary push-secrets cannot overwrite its independent
  // authority, and so token/service secrets may use different AWS regions.
  const bearerEnv = 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__AUTH__BEARER_TOKEN'
  const bearerMappings = []
  for (const [name, secret] of Object.entries(withdrawalValues.externalSecrets || {}) as [string, any][]) {
    if (name === 'withdrawal-proof-token' || secret?.provider !== 'aws' || !Array.isArray(secret.data)) continue
    const owned = secret.data.filter((item: any) => item?.secretKey === bearerEnv)
    if (owned.length === 0) continue
    bearerMappings.push(...owned)
    secret.data = secret.data.filter((item: any) => item?.secretKey !== bearerEnv)
    if (secret.data.length === 0) delete withdrawalValues.externalSecrets[name]
  }

  if (bearerMappings.length > 0 || withdrawalValues.externalSecrets?.['withdrawal-proof-token']?.provider === 'aws') {
    withdrawalValues.externalSecrets['withdrawal-proof-token'] = {
      data: [{remoteRef: {key: projection.secretName, property: 'proof-work-token'}, secretKey: 'proof-work-token'}],
      provider: 'aws', refreshInterval: '2m', secretRegion: projection.secretRegion, serviceAccount: 'external-secrets',
    }
    // The compiler selects bearer_token_file. Injecting the old bearer-token
    // environment value simultaneously makes active WP fail closed at startup.
    withdrawalValues.envFrom = (withdrawalValues.envFrom || []).filter((item: any) => item?.secretRef?.name !== 'withdrawal-proof-token')
    if (Array.isArray(withdrawalValues.env)) withdrawalValues.env = withdrawalValues.env.filter((item: any) => item?.name !== bearerEnv)
    else if (withdrawalValues.env) delete withdrawalValues.env[bearerEnv]
    withdrawalValues.persistence ||= {}
    withdrawalValues.persistence['proof-work-token'] = {
      enabled: true, mountPath: '/app/secrets/proof-work-token', name: 'withdrawal-proof-token',
      readOnly: true, subPath: 'proof-work-token', type: 'secret',
    }
  }

  // Keep any prep-charts-managed WP copy in the explicitly selected region.
  projectManagedAwsProofSecret(withdrawalValues, projection.secretName, projection.secretRegion)
}
