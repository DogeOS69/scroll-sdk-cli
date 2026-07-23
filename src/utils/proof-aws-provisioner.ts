/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and aws CLI JSON are dynamic documents. */

import { randomBytes } from 'node:crypto'

import type { JsonOutputContext } from './json-output.js'

import { AwsCliRunner } from './aws-cli.js'

export interface ProofAwsIdentity {
  awsRegion: string
  eksCluster: string
  namespace: string
  networkAlias: string
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

export type ProofArtifactReadMode = 'external' | 'vpc-endpoint'

export interface ProofArtifactReadPlan {
  mode: ProofArtifactReadMode
  routeTableIds?: string[]
  vpcEndpointId?: string
}

export interface ProofArtifactReadTransportResult {
  mode: ProofArtifactReadMode
  routeTableIds?: string[]
  status: 'configured-unverified' | 'operator-managed-unverified'
  vpcEndpointId?: string
}

export const PROOF_SECRET_PROPERTIES = ['proof-work-token', 'prover-worker-token'] as const
export const PROOF_ARTIFACT_VPCE_POLICY_SID = 'ScrollSdkProofArtifactReadViaVpcEndpoint'

export interface ProofAwsValuesProjection {
  bucket: string
  coordinatorRoleArn: string
  coordinatorServiceAccount: string
  keyPrefix: string
  region: string
  secretName: string
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

  const forbiddenCharacters = ['\\', '*', '?', '[', ']', '{', '}']
  const hasControlCharacter = [...prefix].some(character => {
    const codePoint = character.codePointAt(0) as number
    return codePoint < 32 || codePoint === 127
  })
  if (forbiddenCharacters.some(character => prefix.includes(character)) || hasControlCharacter) {
    throw new Error('proof artifact key prefix must not contain wildcards, backslashes, braces, or control characters')
  }

  return prefix
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
  const existingIndex = statements.findIndex((statement: any) => statement?.Sid === PROOF_ARTIFACT_VPCE_POLICY_SID)
  if (existingIndex >= 0) statements[existingIndex] = readStatement
  else statements.push(readStatement)

  return {
    ...existingPolicy,
    Statement: statements,
    Version: existingPolicy.Version || '2012-10-17',
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

function projectManagedAwsSecretRegion(
  values: Record<string, any>,
  secretName: string,
  region: string
): void {
  for (const secret of Object.values(values.externalSecrets || {}) as any[]) {
    if (secret?.provider !== 'aws' || !Array.isArray(secret.data)) continue

    const readsProvisionedProofSecret = secret.data.some((item: any) =>
      PROOF_SECRET_PROPERTIES.includes(item?.secretKey) &&
      item?.remoteRef?.key === secretName
    )
    if (readsProvisionedProofSecret) secret.secretRegion = region
  }
}

/**
 * Project the provisioned AWS resources into the two proof values documents so
 * a subsequent `setup proof-config` passes its IRSA/secret topology validation
 * without manual edits. Mutates both values objects in place.
 */
export function applyProofAwsValues(
  coordinatorValues: Record<string, any>,
  withdrawalValues: Record<string, any>,
  projection: ProofAwsValuesProjection
): void {
  const keyPrefix = normalizeProofKeyPrefix(projection.keyPrefix)
  upsertEnv(coordinatorValues, 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__BUCKET', projection.bucket, 'proof-coordinator values')
  upsertEnv(coordinatorValues, 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__REGION', projection.region, 'proof-coordinator values')
  upsertEnv(coordinatorValues, 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__KEY_PREFIX', keyPrefix, 'proof-coordinator values')
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
      secretRegion: projection.region,
      serviceAccount: 'external-secrets',
    }
  }

  // Do not rely on the shared chart's historical us-west-2 fallback. Keep an
  // existing managed mapping in sync as well as newly created mappings, while
  // leaving operator-owned Vault or alternate-secret mappings untouched.
  projectManagedAwsSecretRegion(coordinatorValues, projection.secretName, projection.region)

  withdrawalValues.withdrawalProof ||= {}
  withdrawalValues.withdrawalProof.s3AuthMode = 'irsa'
  bindIrsaServiceAccount(withdrawalValues, projection.withdrawalServiceAccount, projection.withdrawalRoleArn)
  // proof-config copies the coordinator's proof-work token mapping into WP.
  // If proof-aws-init is rerun afterwards, keep that managed copy in the same
  // explicitly selected region without requiring another proof-config pass.
  projectManagedAwsSecretRegion(withdrawalValues, projection.secretName, projection.region)
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
    const bucketCreated = this.ensureBucket(identity.awsRegion, input.bucket)
    const artifactReadTransport = input.artifactRead?.mode === 'vpc-endpoint'
      ? this.ensureVpcEndpointArtifactRead(identity.awsRegion, input.bucket, keyPrefix, input.artifactRead)
      : { mode: 'external' as const, status: 'operator-managed-unverified' as const }
    const trust = this.discoverIrsaTrust(identity)
    const withdrawalRoleArn = this.ensureIrsaRole(identity, trust, input.withdrawalRole, input.bucket, keyPrefix)
    const coordinatorRoleArn = this.ensureIrsaRole(identity, trust, input.coordinatorRole, input.bucket, keyPrefix)
    const secretAction = this.ensureTokenSecret(identity.awsRegion, input.secretName, input.rotateTokens === true)

    return {
      artifactReadTransport,
      bucket: input.bucket,
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

  private ensureBucket(region: string, bucket: string): boolean {
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
    region: string,
    bucket: string,
    keyPrefix: string,
    plan: ProofArtifactReadPlan
  ): ProofArtifactReadTransportResult {
    const endpointId = plan.vpcEndpointId?.trim()
    const routeTableIds = [...new Set((plan.routeTableIds || []).map(value => value.trim()).filter(Boolean))]
    if (!endpointId || !/^vpce-[\da-f]+$/i.test(endpointId)) {
      throw new Error('vpc-endpoint artifact read mode requires a valid --artifact-read-vpc-endpoint-id')
    }

    if (routeTableIds.length === 0 || routeTableIds.some(value => !/^rtb-[\da-f]+$/i.test(value))) {
      throw new Error('vpc-endpoint artifact read mode requires at least one valid --artifact-read-route-table-id from the worker/signer network')
    }

    const described = this.aws.json(
      ['ec2', 'describe-vpc-endpoints', '--vpc-endpoint-ids', endpointId],
      { region }
    )
    const endpoint = described?.VpcEndpoints?.[0]
    if (!endpoint) throw new Error(`VPC endpoint ${endpointId} was not returned by AWS`)
    if (endpoint.State !== 'available') {
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
        endpointId,
        '--add-route-table-ids',
        ...missingRouteTables,
      ], { region })
      this.jsonCtx.info(`proof-aws: associated S3 gateway endpoint ${endpointId} with route table(s): ${missingRouteTables.join(', ')}`)
    }

    const updatedPolicy = upsertProofArtifactVpcEndpointReadPolicy(
      this.readBucketPolicy(region, bucket),
      bucket,
      keyPrefix,
      endpointId
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
      mode: 'vpc-endpoint',
      routeTableIds,
      status: 'configured-unverified',
      vpcEndpointId: endpointId,
    }
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
