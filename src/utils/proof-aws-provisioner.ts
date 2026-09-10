/* eslint-disable @typescript-eslint/no-explicit-any, perfectionist/sort-classes -- Helm values and aws CLI JSON are dynamic documents; discovery helpers stay beside the VPC reconciliation flow. */

import { parse as parseToml } from '@iarna/toml'
import { createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type { JsonOutputContext } from './json-output.js'

import { AwsCliRunner } from './aws-cli.js'

export interface ProofAwsIdentity {
  /** Region containing the shared DA/proof artifact bucket. */
  artifactRegion?: string
  /** Region containing EKS and the deployment-scoped Secrets Manager secret. */
  awsRegion: string
  deploymentAlias: string
  eksCluster: string
  namespace: string
}

export interface ProofAwsRolePlan {
  description: string
  roleName: string
  serviceAccount: string
}

export interface ProofAwsProvisionInput {
  artifactRead?: ProofArtifactReadPlan
  bucket: string
  coordinatorRole: ProofAwsRolePlan
  keyPrefix: string
  rotateTokens?: boolean
  secretName: string
  withdrawalRole: ProofAwsRolePlan
}

export interface ProofAwsProvisionResult {
  artifactReadTransport: ProofArtifactReadTransportResult
  bucket: string
  bucketCreated: boolean
  coordinatorRoleArn: string
  secretAction: 'created' | 'reused' | 'rotated'
  secretName: string
  withdrawalRoleArn: string
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

export type ProofArtifactPublicReadMode = 'direct-s3' | 'existing-gateway' | 'existing-public-s3' | 'shared-s3'

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

export const PROOF_SECRET_PROPERTIES = ['proof-work-token', 'prover-worker-token'] as const
export const PROOF_ARTIFACT_PUBLIC_READ_POLICY_SID = 'ScrollSdkProofArtifactPublicRead'
export const PROOF_ARTIFACT_VPCE_POLICY_SID = 'ScrollSdkProofArtifactReadViaVpcEndpoint'

/**
 * Logical object namespaces read without AWS credentials by DA clients,
 * external proof Workers, or partner Attestation Signers. The segmentation
 * sidecar namespace is deliberately absent because it is a PC-internal input.
 */
export const PUBLIC_ARTIFACT_OBJECT_PATTERNS = [
  '0x*',
  'input-specs/*',
  'prepared-bundles/*',
  'witnesses/*',
  'public-outputs/*',
  'proofs/*',
  // AdvanceL1 attestors fetch completeness evidence after the bridge witness.
  'signer-policy-evidence/*',
] as const

export function publicArtifactObjectResources(bucket: string, keyPrefix: string): string[] {
  const prefix = normalizeProofKeyPrefix(keyPrefix)
  return PUBLIC_ARTIFACT_OBJECT_PATTERNS.map(pattern =>
    `arn:aws:s3:::${bucket}/${prefix}/${pattern}`
  )
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

export function buildProofArtifactStorePolicy(bucket: string, keyPrefix: string): Record<string, any> {
  const prefix = normalizeProofKeyPrefix(keyPrefix)
  return {
    Statement: [
      {
        Action: ['s3:GetObject', 's3:PutObject'],
        Effect: 'Allow',
        Resource: `arn:aws:s3:::${bucket}/${prefix}/*`,
      },
      {
        Action: ['s3:ListBucket'],
        Condition: {
          StringLike: {
            's3:prefix': [prefix, `${prefix}/*`],
          },
        },
        Effect: 'Allow',
        Resource: `arn:aws:s3:::${bucket}`,
      },
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
  const statements = Array.isArray(existingPolicy.Statement)
    ? [...existingPolicy.Statement]
    : existingPolicy.Statement ? [existingPolicy.Statement] : []
  const readStatement = {
    Action: 's3:GetObject',
    Condition: { StringEquals: { 'aws:SourceVpce': vpcEndpointId } },
    Effect: 'Allow',
    Principal: '*',
    Resource: `arn:aws:s3:::${bucket}/${prefix}/*`,
    Sid: PROOF_ARTIFACT_VPCE_POLICY_SID,
  }
  const bucketResourcePrefix = `arn:aws:s3:::${bucket}/`
  const replaceableReadStatement = (statement: any): boolean => {
    if (statement?.Sid === PROOF_ARTIFACT_VPCE_POLICY_SID) return true
    const actions = Array.isArray(statement?.Action) ? statement.Action : [statement?.Action]
    const resources = Array.isArray(statement?.Resource) ? statement.Resource : [statement?.Resource]
    const condition = statement?.Condition
    const stringEquals = condition?.StringEquals
    return statement?.Effect === 'Allow'
      && statement?.Principal === '*'
      && actions.length === 1
      && actions[0] === 's3:GetObject'
      && resources.length === 1
      && typeof resources[0] === 'string'
      && resources[0].startsWith(bucketResourcePrefix)
      && condition && Object.keys(condition).length === 1
      && stringEquals && Object.keys(stringEquals).length === 1
      && stringEquals['aws:SourceVpce'] === vpcEndpointId
  }

  const preservedStatements = statements.filter(statement => !replaceableReadStatement(statement))
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
  const statements = Array.isArray(existingPolicy.Statement)
    ? [...existingPolicy.Statement]
    : existingPolicy.Statement ? [existingPolicy.Statement] : []
  const preservedStatements = statements.filter(
    statement => statement?.Sid !== PROOF_ARTIFACT_PUBLIC_READ_POLICY_SID,
  )
  if (enabled) {
    preservedStatements.push({
      Action: 's3:GetObject',
      Effect: 'Allow',
      Principal: '*',
      Resource: publicArtifactObjectResources(bucket, prefix),
      Sid: PROOF_ARTIFACT_PUBLIC_READ_POLICY_SID,
    })
  }

  return {
    ...existingPolicy,
    Statement: preservedStatements,
    Version: existingPolicy.Version || '2012-10-17',
  }
}

/** Add one prefix-scoped grant without adopting or replacing any existing statement. */
export function upsertSharedProofArtifactPublicReadPolicy(
  existingPolicy: Record<string, any>,
  bucket: string,
  keyPrefix: string,
): Record<string, any> {
  const prefix = normalizeProofKeyPrefix(keyPrefix)
  const resources = publicArtifactObjectResources(bucket, prefix)
  // Include the allowed path set: newer CLI versions can add required paths
  // without rewriting a previous release's statement or weakening conditions.
  const sid = `${PROOF_ARTIFACT_PUBLIC_READ_POLICY_SID}${createHash('sha256').update(JSON.stringify(resources)).digest('hex').slice(0, 24)}`
  const statement = {
    Action: 's3:GetObject',
    Effect: 'Allow',
    Principal: '*',
    Resource: resources,
    Sid: sid,
  }
  const statements = Array.isArray(existingPolicy.Statement)
    ? [...existingPolicy.Statement]
    : existingPolicy.Statement ? [existingPolicy.Statement] : []
  const matching = statements.filter(item => item?.Sid === sid)
  if (matching.length > 0) {
    if (matching.length !== 1 || !isDeepStrictEqual(matching[0], statement)) {
      throw new Error(`shared-s3 policy Sid ${sid} already exists with different contents; refusing to replace it`)
    }

    return existingPolicy
  }

  return {...existingPolicy, Statement: [...statements, statement], Version: existingPolicy.Version || '2012-10-17'}
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

function resourceMayOverlapPrefix(resource: unknown, bucket: string, keyPrefix: string): boolean {
  if (resource === '*') return true
  if (typeof resource !== 'string') return false

  const match = /^arn:(?:aws|aws-cn|aws-us-gov):s3:::(?<bucket>[^/]+)(?:\/(?<object>.*))?$/u.exec(resource)
  if (!match?.groups || !wildcardMatches(match.groups.bucket, bucket)) return false

  const objectPattern = match.groups.object
  if (objectPattern === undefined) return false

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

export function assertNoUnmanagedPublicProofBucketGrant(
  policy: Record<string, any>,
  bucket: string,
  keyPrefix: string,
): void {
  const statements = Array.isArray(policy.Statement)
    ? policy.Statement
    : policy.Statement ? [policy.Statement] : []
  const unsafe = statements.find((statement: any) =>
    statement?.Effect === 'Allow'
    && principalIncludesWildcard(statement.Principal)
    && actionCanGetObject(statement.Action)
    && statement?.Sid !== PROOF_ARTIFACT_PUBLIC_READ_POLICY_SID
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

function bindIrsaServiceAccount(values: Record<string, any>, name: string, roleArn: string): void {
  values.serviceAccount ||= {}
  values.serviceAccount.create = true
  // Pin the name: the IRSA trust policy binds a stable namespace/ServiceAccount
  // OIDC subject, so the chart must not derive it from the release name.
  values.serviceAccount.name = name
  values.serviceAccount.annotations ||= {}
  values.serviceAccount.annotations['eks.amazonaws.com/role-arn'] = roleArn
}

function hasProofTokenMappings(values: Record<string, any>): boolean {
  const mappedKeys = new Set(
    Object.values(values.externalSecrets || {})
      .flatMap((secret: any) => Array.isArray(secret?.data) ? secret.data : [])
      .map((item: any) => item?.secretKey)
      .filter((key: unknown): key is string => typeof key === 'string')
  )
  return PROOF_SECRET_PROPERTIES.every(property => mappedKeys.has(property))
}

function projectManagedAwsProofSecret(
  values: Record<string, any>,
  secretName: string,
  region: string
): void {
  for (const secret of Object.values(values.externalSecrets || {}) as any[]) {
    if (secret?.provider !== 'aws' || !Array.isArray(secret.data)) continue

    const proofTokenMappings = secret.data.filter((item: any) =>
      PROOF_SECRET_PROPERTIES.includes(item?.secretKey)
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

  bindIrsaServiceAccount(coordinatorValues, projection.coordinatorServiceAccount, projection.coordinatorRoleArn)

  if (!hasProofTokenMappings(coordinatorValues)) {
    coordinatorValues.externalSecrets ||= {}
    coordinatorValues.externalSecrets.secrets = {
      data: PROOF_SECRET_PROPERTIES.map(property => ({
        remoteRef: { key: projection.secretName, property },
        secretKey: property,
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
  withdrawalValues.withdrawalProof.s3AuthMode = 'irsa'
  bindIrsaServiceAccount(withdrawalValues, projection.withdrawalServiceAccount, projection.withdrawalRoleArn)
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

/**
 * Provision the AWS side of the proof system: the artifact S3 bucket, one
 * IRSA-bound IAM role per proof workload, and the shared bearer-token secret.
 * Every step is idempotent — existing resources are reused, and tokens are
 * never rotated unless explicitly requested.
 */
export class ProofAwsProvisioner {
  private readonly aws: Pick<AwsCliRunner, 'json' | 'run' | 'text'>

  constructor(
    private readonly jsonCtx: JsonOutputContext,
    profile?: string,
    aws?: Pick<AwsCliRunner, 'json' | 'run' | 'text'>
  ) {
    this.aws = aws || new AwsCliRunner(profile)
  }

  provision(identity: ProofAwsIdentity, input: ProofAwsProvisionInput): ProofAwsProvisionResult {
    const keyPrefix = normalizeProofKeyPrefix(input.keyPrefix)
    const bucket = normalizeProofBucketName(input.bucket)
    if (!input.artifactRead) {
      throw new Error('proof artifact public read configuration is required')
    }

    const {publicReadMode} = input.artifactRead
    if (!['direct-s3', 'existing-gateway', 'existing-public-s3', 'shared-s3'].includes(publicReadMode)) {
      throw new Error(`unsupported proof artifact public read mode: ${String(publicReadMode)}`)
    }

    const artifactRegion = identity.artifactRegion || identity.awsRegion
    const directS3Endpoint = proofArtifactS3Endpoint(artifactRegion)
    const usesRegionalS3Endpoint = publicReadMode !== 'existing-gateway'
    if (usesRegionalS3Endpoint && input.artifactRead.publicEndpointUrl) {
      const supplied = normalizeProofArtifactPublicEndpoint(input.artifactRead.publicEndpointUrl)
      if (supplied !== directS3Endpoint) {
        throw new Error(
          `${publicReadMode} proof artifact endpoint is derived as ${directS3Endpoint}; `
          + 'do not supply a different public endpoint',
        )
      }
    }

    if (publicReadMode === 'existing-gateway' && !input.artifactRead.publicEndpointUrl) {
      throw new Error('existing-gateway proof artifact reads require publicEndpointUrl')
    }

    const publicEndpointUrl = usesRegionalS3Endpoint
      ? directS3Endpoint
      : normalizeProofArtifactPublicEndpoint(input.artifactRead.publicEndpointUrl as string)
    if (input.artifactRead.vpcEndpoint?.enabled && artifactRegion !== identity.awsRegion) {
      throw new Error(
        `cannot configure an ${identity.awsRegion} S3 Gateway endpoint for artifact bucket region ${artifactRegion}; `
        + 'cross-region S3 access must use the normal AWS endpoint or an operator-managed gateway',
      )
    }

    if (publicReadMode === 'shared-s3' && input.artifactRead.vpcEndpoint?.enabled) {
      throw new Error('shared-s3 preserves shared VPC endpoint policies and routes; use --skip-vpc-endpoint')
    }

    const bucketCreated = this.ensureBucket(
      artifactRegion,
      bucket,
      publicReadMode !== 'existing-public-s3' && publicReadMode !== 'shared-s3',
    )
    // Validate any existing public policy before creating/associating a VPC
    // endpoint or changing IAM/secrets. This keeps a rejected direct-S3
    // adoption from leaving unrelated AWS resources half-provisioned.
    if (publicReadMode === 'direct-s3') {
      assertNoUnmanagedPublicProofBucketGrant(
        this.readBucketPolicy(artifactRegion, bucket),
        bucket,
        keyPrefix,
      )
    }

    const vpcEndpoint = input.artifactRead.vpcEndpoint?.enabled
      ? this.ensureVpcEndpointArtifactRead(identity, bucket, keyPrefix, input.artifactRead.vpcEndpoint)
      : undefined
    // `existing-gateway` is explicitly operator-managed.  In that mode the
    // CLI must not rewrite either the bucket policy or Public Access Block:
    // an existing archive bucket can already expose raw DA objects through a
    // policy or gateway whose scope the proof adapter does not own.  Toggling
    // Public Access Block here can silently break that established download
    // path. shared-s3 only appends a prefix-scoped statement, without taking
    // ownership of the bucket-wide settings or any existing grants.
    if (publicReadMode === 'direct-s3') {
      this.reconcileDirectS3ArtifactRead(
        artifactRegion,
        bucket,
        keyPrefix,
      )
    } else if (publicReadMode === 'shared-s3') {
      this.reconcileSharedS3ArtifactRead(artifactRegion, bucket, keyPrefix)
    } else {
      this.jsonCtx.info(
        `proof-aws: preserved operator-managed bucket policy and Public Access Block settings for ${bucket} (${publicReadMode})`,
      )
    }

    const artifactReadTransport: ProofArtifactReadTransportResult = {
      publicEndpointUrl,
      publicReadMode,
      publicStatus: publicReadMode === 'direct-s3' || publicReadMode === 'shared-s3'
        ? 'configured-unverified'
        : 'operator-managed-unverified',
      ...(vpcEndpoint ? {vpcEndpoint} : {}),
    }
    const trust = this.discoverIrsaTrust(identity)
    const withdrawalRoleArn = this.ensureIrsaRole(identity, trust, input.withdrawalRole, bucket, keyPrefix)
    const coordinatorRoleArn = this.ensureIrsaRole(identity, trust, input.coordinatorRole, bucket, keyPrefix)
    const secretAction = this.ensureTokenSecret(identity.awsRegion, input.secretName, input.rotateTokens === true)

    return {
      artifactReadTransport,
      bucket,
      bucketCreated,
      coordinatorRoleArn,
      secretAction,
      secretName: input.secretName,
      withdrawalRoleArn,
    }
  }

  private discoverIrsaTrust(identity: ProofAwsIdentity): { accountId: string; issuerHostPath: string } {
    const accountId = this.aws.text(['sts', 'get-caller-identity'], { query: 'Account' })
    const issuer = this.aws.text(
      ['eks', 'describe-cluster', '--name', identity.eksCluster],
      { query: 'cluster.identity.oidc.issuer', region: identity.awsRegion }
    )
    if (!issuer || issuer === 'None') {
      throw new Error(`EKS cluster ${identity.eksCluster} does not expose an OIDC issuer; IRSA cannot be configured`)
    }

    return { accountId, issuerHostPath: issuer.replace(/^https:\/\//, '') }
  }

  private ensureBucket(region: string, bucket: string, createIfMissing: boolean): boolean {
    try {
      this.aws.run(['s3api', 'head-bucket', '--bucket', bucket], { region })
      this.jsonCtx.info(`proof-aws: reusing existing S3 bucket: ${bucket}`)
      return false
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const notFound = message.includes('404') || /not found/i.test(message)
      if (!notFound) {
        throw new Error(`S3 bucket ${bucket} exists but is not accessible (it may be owned by another AWS account): ${message}`)
      }

      if (!createIfMissing) {
        throw new Error(
          `selected public read mode requires an existing accessible S3 bucket, but ${bucket} was not found`,
        )
      }
    }

    const createArgs = ['s3api', 'create-bucket', '--bucket', bucket]
    if (region !== 'us-east-1') {
      createArgs.push('--create-bucket-configuration', `LocationConstraint=${region}`)
    }

    this.aws.run(createArgs, { region })
    this.aws.run([
      's3api',
      'put-public-access-block',
      '--bucket',
      bucket,
      '--public-access-block-configuration',
      'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true',
    ], { region })
    this.aws.run([
      's3api',
      'put-bucket-encryption',
      '--bucket',
      bucket,
      '--server-side-encryption-configuration',
      JSON.stringify({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] }),
    ], { region })
    this.jsonCtx.info(`proof-aws: created S3 bucket: ${bucket} (region=${region}, public access blocked, SSE-S3)`)
    return true
  }

  private reconcileSharedS3ArtifactRead(region: string, bucket: string, keyPrefix: string): void {
    const accountId = this.aws.text(['sts', 'get-caller-identity'], {query: 'Account'})
    this.aws.run(['s3api', 'head-bucket', '--bucket', bucket, '--expected-bucket-owner', accountId], {region})
    // Public Access Block is effective at both levels. Never weaken either
    // setting on behalf of one deployment sharing a bucket/account.
    for (const args of [
      ['s3api', 'get-public-access-block', '--bucket', bucket],
      ['s3control', 'get-public-access-block', '--account-id', accountId],
    ]) {
      let config: Record<string, any>
      try {
        config = this.aws.json(args, {region}).PublicAccessBlockConfiguration
      } catch (error) {
        if (/NoSuchPublicAccessBlockConfiguration/.test(String(error))) continue
        throw error
      }

      if (!config || typeof config.BlockPublicPolicy !== 'boolean' || typeof config.RestrictPublicBuckets !== 'boolean') {
        throw new Error(`shared-s3 could not validate ${args[0]} Public Access Block settings`)
      }

      if (config.BlockPublicPolicy || config.RestrictPublicBuckets) {
        throw new Error(`shared-s3 is blocked by ${args[0]} Public Access Block; settings were not changed. Use an operator-managed gateway or obtain explicit approval to change bucket/account security settings`)
      }
    }

    const existing = this.readBucketPolicy(region, bucket)
    const updated = upsertSharedProofArtifactPublicReadPolicy(existing, bucket, keyPrefix)
    if (!isDeepStrictEqual(existing, updated)) {
      // S3 has no conditional PutBucketPolicy. Detect intervening changes when
      // possible; operators must serialize concurrent bucket-policy writers.
      if (!isDeepStrictEqual(existing, this.readBucketPolicy(region, bucket))) {
        throw new Error('shared-s3 bucket policy changed during provisioning; retry with serialized policy writers')
      }

      this.aws.run(['s3api', 'put-bucket-policy', '--bucket', bucket, '--expected-bucket-owner', accountId, '--policy', JSON.stringify(updated)], {region})
    }

    this.jsonCtx.info(`proof-aws: configured prefix-scoped anonymous GetObject under ${bucket}/${keyPrefix}; preserved existing statements, encryption, Public Access Block and VPC routing`)
  }

  private reconcileDirectS3ArtifactRead(
    region: string,
    bucket: string,
    keyPrefix: string,
  ): void {
    const existingPolicy = this.readBucketPolicy(region, bucket)

    this.aws.run([
      's3api',
      'put-public-access-block',
      '--bucket',
      bucket,
      '--public-access-block-configuration',
      'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false',
    ], {region})

    const updatedPolicy = upsertProofArtifactPublicReadPolicy(
      existingPolicy,
      bucket,
      keyPrefix,
      true,
    )
    if (JSON.stringify(existingPolicy) !== JSON.stringify(updatedPolicy)) {
      if (updatedPolicy.Statement.length === 0) {
        this.aws.run(['s3api', 'delete-bucket-policy', '--bucket', bucket], {region})
      } else {
        this.aws.run([
          's3api',
          'put-bucket-policy',
          '--bucket',
          bucket,
          '--policy',
          JSON.stringify(updatedPolicy),
        ], {region})
      }
    }

    this.jsonCtx.info(
      `proof-aws: configured anonymous GetObject for required external-consumer paths under ${bucket}/${keyPrefix}; list/write/delete remain private`,
    )
  }

  private ensureIrsaRole(
    identity: ProofAwsIdentity,
    trust: { accountId: string; issuerHostPath: string },
    plan: ProofAwsRolePlan,
    bucket: string,
    keyPrefix: string
  ): string {
    const roleArn = `arn:aws:iam::${trust.accountId}:role/${plan.roleName}`
    const trustPolicyDocument = JSON.stringify({
      Statement: [{
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            [`${trust.issuerHostPath}:aud`]: 'sts.amazonaws.com',
            [`${trust.issuerHostPath}:sub`]: `system:serviceaccount:${identity.namespace}:${plan.serviceAccount}`,
          },
        },
        Effect: 'Allow',
        Principal: {
          Federated: `arn:aws:iam::${trust.accountId}:oidc-provider/${trust.issuerHostPath}`,
        },
      }],
      Version: '2012-10-17',
    })

    try {
      this.aws.json(['iam', 'get-role', '--role-name', plan.roleName])
      this.aws.json(['iam', 'update-assume-role-policy', '--role-name', plan.roleName, '--policy-document', trustPolicyDocument])
      this.jsonCtx.info(`proof-aws: updated IAM role trust policy: ${plan.roleName}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('NoSuchEntity')) throw error

      this.aws.json([
        'iam',
        'create-role',
        '--role-name',
        plan.roleName,
        '--assume-role-policy-document',
        trustPolicyDocument,
        '--description',
        plan.description,
      ])
      this.jsonCtx.info(`proof-aws: created IAM role: ${plan.roleName}`)
    }

    // GetObject + PutObject cover artifact transport and staging->accepted
    // promotion (CopyObject authorizes as a read plus a write); ListBucket
    // covers scans, restricted to the deployment's normalized object prefix.
    this.aws.json([
      'iam',
      'put-role-policy',
      '--role-name',
      plan.roleName,
      '--policy-name',
      'proof-artifact-store',
      '--policy-document',
      JSON.stringify(buildProofArtifactStorePolicy(bucket, keyPrefix)),
    ])
    this.jsonCtx.info(`proof-aws: updated IAM proof artifact policy: ${plan.roleName} -> ${bucket}/${keyPrefix}/*`)
    return roleArn
  }

  private ensureTokenSecret(region: string, secretName: string, rotate: boolean): 'created' | 'reused' | 'rotated' {
    const secretString = JSON.stringify(Object.fromEntries(
      PROOF_SECRET_PROPERTIES.map(property => [property, randomBytes(32).toString('hex')])
    ))

    let exists = true
    try {
      this.aws.json(['secretsmanager', 'describe-secret', '--secret-id', secretName], { region })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('ResourceNotFoundException')) throw error
      exists = false
    }

    if (!exists) {
      this.aws.json(['secretsmanager', 'create-secret', '--name', secretName, '--secret-string', secretString], { region })
      this.jsonCtx.info(`proof-aws: created token secret: ${secretName}`)
      return 'created'
    }

    if (rotate) {
      this.aws.json(['secretsmanager', 'put-secret-value', '--secret-id', secretName, '--secret-string', secretString], { region })
      this.jsonCtx.info(`proof-aws: rotated token secret: ${secretName} (restart both proof workloads to pick up the new tokens)`)
      return 'rotated'
    }

    this.jsonCtx.info(`proof-aws: reusing existing token secret: ${secretName} (pass --rotate-tokens to replace)`)
    return 'reused'
  }

  private ensureVpcEndpointArtifactRead(
    identity: ProofAwsIdentity,
    bucket: string,
    keyPrefix: string,
    plan: ProofArtifactVpcEndpointPlan
  ): ProofArtifactVpcEndpointResult {
    const {awsRegion: region} = identity
    let endpointId = plan.vpcEndpointId?.trim()
    let routeTableIds = [...new Set((plan.routeTableIds || []).map(value => value.trim()).filter(Boolean))]
    if (endpointId && !/^vpce-[\da-f]+$/i.test(endpointId)) {
      throw new Error('proof artifact VPC endpoint ID is invalid')
    }

    if (routeTableIds.some(value => !/^rtb-[\da-f]+$/i.test(value))) {
      throw new Error('proof artifact VPC route table ID is invalid')
    }

    let clusterVpcId: string | undefined
    if (!endpointId || routeTableIds.length === 0) {
      const network = this.discoverEksNetwork(identity)
      clusterVpcId = network.vpcId
      if (routeTableIds.length === 0) {
        routeTableIds = this.discoverClusterRouteTableIds(region, network.vpcId, network.subnetIds)
        this.jsonCtx.info(
          `proof-aws: discovered EKS route table(s): ${routeTableIds.join(', ')}`,
        )
      }
    }

    let created = false
    if (!endpointId) {
      const existing = this.aws.json([
        'ec2',
        'describe-vpc-endpoints',
        '--filters',
        `Name=vpc-id,Values=${clusterVpcId}`,
        `Name=service-name,Values=com.amazonaws.${region}.s3`,
        'Name=vpc-endpoint-type,Values=Gateway',
      ], {region})
      const reusable = (Array.isArray(existing?.VpcEndpoints) ? existing.VpcEndpoints : [])
        .find((candidate: any) => candidate?.State === 'available')
      if (reusable?.VpcEndpointId) {
        endpointId = reusable.VpcEndpointId
        this.jsonCtx.info(`proof-aws: reusing S3 gateway endpoint: ${endpointId}`)
      } else {
        const response = this.aws.json([
          'ec2',
          'create-vpc-endpoint',
          '--vpc-id',
          clusterVpcId as string,
          '--service-name',
          `com.amazonaws.${region}.s3`,
          '--vpc-endpoint-type',
          'Gateway',
          '--route-table-ids',
          ...routeTableIds,
        ], {region})
        endpointId = response?.VpcEndpoint?.VpcEndpointId
        if (!endpointId || !/^vpce-[\da-f]+$/i.test(endpointId)) {
          throw new Error('AWS did not return an ID for the newly created S3 gateway endpoint')
        }

        created = true
        this.jsonCtx.info(`proof-aws: created S3 gateway endpoint: ${endpointId}`)
      }
    }

    const resolvedEndpointId = endpointId as string

    const described = this.aws.json(
      ['ec2', 'describe-vpc-endpoints', '--vpc-endpoint-ids', resolvedEndpointId],
      { region }
    )
    const endpoint = described?.VpcEndpoints?.[0]
    if (!endpoint) throw new Error(`VPC endpoint ${endpointId} was not returned by AWS`)
    if (!['available', ...(created ? ['pending'] : [])].includes(endpoint.State)) {
      throw new Error(`VPC endpoint ${endpointId} is not available (state=${String(endpoint.State)})`)
    }

    if (endpoint.VpcEndpointType !== 'Gateway' || endpoint.ServiceName !== `com.amazonaws.${region}.s3`) {
      throw new Error(
        `VPC endpoint ${endpointId} must be the ${region} S3 Gateway endpoint; `
        + `got type=${String(endpoint.VpcEndpointType)} service=${String(endpoint.ServiceName)}`
      )
    }

    const describedRouteTables = this.aws.json(
      ['ec2', 'describe-route-tables', '--route-table-ids', ...routeTableIds],
      { region }
    )
    const routeTables = Array.isArray(describedRouteTables?.RouteTables) ? describedRouteTables.RouteTables : []
    const returnedRouteTableIds = new Set<string>(routeTables.map((routeTable: any) => routeTable.RouteTableId))
    const unavailableRouteTableIds = routeTableIds.filter(value => !returnedRouteTableIds.has(value))
    if (unavailableRouteTableIds.length > 0) {
      throw new Error(`worker/signer route table(s) were not returned by AWS: ${unavailableRouteTableIds.join(', ')}`)
    }

    const wrongVpcRouteTableIds = routeTables
      .filter((routeTable: any) => routeTable.VpcId !== endpoint.VpcId)
      .map((routeTable: any) => routeTable.RouteTableId)
    if (wrongVpcRouteTableIds.length > 0) {
      throw new Error(
        `route table(s) ${wrongVpcRouteTableIds.join(', ')} are not in VPC ${String(endpoint.VpcId)} of endpoint ${endpointId}`
      )
    }

    const existingRouteTables = new Set<string>(Array.isArray(endpoint.RouteTableIds) ? endpoint.RouteTableIds : [])
    const missingRouteTables = routeTableIds.filter(value => !existingRouteTables.has(value))
    if (missingRouteTables.length > 0) {
      this.aws.run([
        'ec2',
        'modify-vpc-endpoint',
        '--vpc-endpoint-id',
        resolvedEndpointId,
        '--add-route-table-ids',
        ...missingRouteTables,
      ], { region })
      this.jsonCtx.info(`proof-aws: associated S3 gateway endpoint ${endpointId} with route table(s): ${missingRouteTables.join(', ')}`)
    }

    const updatedPolicy = upsertProofArtifactVpcEndpointReadPolicy(
      this.readBucketPolicy(region, bucket),
      bucket,
      keyPrefix,
      resolvedEndpointId
    )
    this.aws.run([
      's3api',
      'put-bucket-policy',
      '--bucket',
      bucket,
      '--policy',
      JSON.stringify(updatedPolicy),
    ], { region })
    this.jsonCtx.info(`proof-aws: configured credential-free GET for ${bucket}/${keyPrefix}/* via ${endpointId}`)

    return {
      created,
      routeTableIds,
      status: 'configured-unverified',
      vpcEndpointId: resolvedEndpointId,
    }
  }

  private discoverEksNetwork(identity: ProofAwsIdentity): {subnetIds: string[]; vpcId: string} {
    const described = this.aws.json(
      ['eks', 'describe-cluster', '--name', identity.eksCluster],
      {region: identity.awsRegion},
    )
    const resources = described?.cluster?.resourcesVpcConfig
    const vpcId = typeof resources?.vpcId === 'string' ? resources.vpcId : ''
    const subnetIds = Array.isArray(resources?.subnetIds)
      ? resources.subnetIds.filter((value: unknown): value is string => typeof value === 'string')
      : []
    if (!/^vpc-[\da-f]+$/i.test(vpcId) || subnetIds.length === 0) {
      throw new Error(
        `EKS cluster ${identity.eksCluster} did not return a VPC and subnet list for proof artifact routing`,
      )
    }

    return {subnetIds, vpcId}
  }

  private discoverClusterRouteTableIds(region: string, vpcId: string, subnetIds: string[]): string[] {
    const described = this.aws.json([
      'ec2',
      'describe-route-tables',
      '--filters',
      `Name=vpc-id,Values=${vpcId}`,
    ], {region})
    const routeTables = Array.isArray(described?.RouteTables) ? described.RouteTables : []
    const main = routeTables.find((routeTable: any) =>
      Array.isArray(routeTable?.Associations)
      && routeTable.Associations.some((association: any) => association?.Main === true)
    )?.RouteTableId
    const selected = subnetIds.map(subnetId => {
      const explicit = routeTables.find((routeTable: any) =>
        Array.isArray(routeTable?.Associations)
        && routeTable.Associations.some((association: any) => association?.SubnetId === subnetId)
      )?.RouteTableId
      return explicit || main
    })
    const routeTableIds = [...new Set(selected.filter((value: unknown): value is string =>
      typeof value === 'string' && /^rtb-[\da-f]+$/i.test(value)
    ))].sort()
    if (routeTableIds.length === 0) {
      throw new Error(
        `could not resolve route tables for EKS subnets ${subnetIds.join(', ')} in ${vpcId}`,
      )
    }

    return routeTableIds
  }

  private readBucketPolicy(region: string, bucket: string): Record<string, any> {
    try {
      const raw = this.aws.text(
        ['s3api', 'get-bucket-policy', '--bucket', bucket],
        { query: 'Policy', region }
      )
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('bucket policy is not a JSON object')
      }

      return parsed
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('NoSuchBucketPolicy')) return { Statement: [], Version: '2012-10-17' }
      throw new Error(`cannot read existing bucket policy for ${bucket}: ${message}`)
    }
  }
}
