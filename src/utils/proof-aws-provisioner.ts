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
  bucket: string
  coordinatorRole: ProofAwsRolePlan
  rotateTokens?: boolean
  secretName: string
  withdrawalRole: ProofAwsRolePlan
}

export interface ProofAwsProvisionResult {
  bucket: string
  bucketCreated: boolean
  coordinatorRoleArn: string
  secretAction: 'created' | 'reused' | 'rotated'
  secretName: string
  withdrawalRoleArn: string
}

export const PROOF_SECRET_PROPERTIES = ['proof-work-token', 'prover-worker-token'] as const

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
  upsertEnv(coordinatorValues, 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__BUCKET', projection.bucket, 'proof-coordinator values')
  upsertEnv(coordinatorValues, 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__REGION', projection.region, 'proof-coordinator values')
  upsertEnv(coordinatorValues, 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__KEY_PREFIX', projection.keyPrefix, 'proof-coordinator values')
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
  private readonly aws: AwsCliRunner

  constructor(
    private readonly jsonCtx: JsonOutputContext,
    profile?: string
  ) {
    this.aws = new AwsCliRunner(profile)
  }

  provision(identity: ProofAwsIdentity, input: ProofAwsProvisionInput): ProofAwsProvisionResult {
    const bucketCreated = this.ensureBucket(identity.awsRegion, input.bucket)
    const trust = this.discoverIrsaTrust(identity)
    const withdrawalRoleArn = this.ensureIrsaRole(identity, trust, input.withdrawalRole, input.bucket)
    const coordinatorRoleArn = this.ensureIrsaRole(identity, trust, input.coordinatorRole, input.bucket)
    const secretAction = this.ensureTokenSecret(identity.awsRegion, input.secretName, input.rotateTokens === true)

    return {
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
    bucket: string
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
    // covers store scans. Tighten to a key prefix once the deployment's object
    // layout is settled.
    this.aws.json([
      'iam',
      'put-role-policy',
      '--role-name',
      plan.roleName,
      '--policy-name',
      'proof-artifact-store',
      '--policy-document',
      JSON.stringify({
        Statement: [
          {
            Action: ['s3:GetObject', 's3:PutObject'],
            Effect: 'Allow',
            Resource: `arn:aws:s3:::${bucket}/*`,
          },
          {
            Action: ['s3:ListBucket'],
            Effect: 'Allow',
            Resource: `arn:aws:s3:::${bucket}`,
          },
        ],
        Version: '2012-10-17',
      }),
    ])
    this.jsonCtx.info(`proof-aws: updated IAM proof artifact policy: ${plan.roleName} -> ${bucket}`)
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
}
