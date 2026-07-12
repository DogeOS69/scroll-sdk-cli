/* eslint-disable @typescript-eslint/no-explicit-any -- AWS CLI responses are dynamic */
import { getAddress, keccak256 } from 'ethers'
import { execFileSync } from 'node:child_process'
import { createPublicKey } from 'node:crypto'

import type { JsonOutputContext } from './json-output.js'
import type { ManagedSignerConfig, ManagedSignerRole } from './signer-roles.js'

export type KmsSignerProvisionRole = Pick<
  ManagedSignerRole,
  'aliasSuffix' | 'defaultServiceAccount' | 'description' | 'purposeTag' | 'role' | 'roleSuffix' | 'service'
>

export interface AwsCommandOptions {
  json?: boolean
  profile?: string
  query?: string
  region?: string
}

export interface BlobArchivePlan {
  bucket?: string
  created: boolean
  enabled: boolean
  keyPrefix?: string
  publicBaseUrl?: string
  region?: string
}

export interface KmsProvisionIdentity {
  awsRegion: string
  eksCluster: string
  namespace: string
  networkAlias: string
}

export interface KmsProvisionInput {
  archive?: BlobArchivePlan
  createArchiveBucket?: boolean
  kmsKeyId?: string
  roleArn?: string
  serviceAccount?: string
}

export interface KmsProvisionResult {
  address: string
  aliasName: string
  keyArn: string
  keyId: string
  publicKeyBase64: string
  roleArn?: string
  roleName?: string
  serviceAccount: string
  signerConfig: ManagedSignerConfig
}

export function sanitizeName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^\da-z-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .replaceAll(/-{2,}/g, '-')

  return sanitized || 'default'
}

export function truncateIamRoleName(value: string): string {
  if (value.length <= 64) return value

  const hash = Buffer.from(keccak256(Buffer.from(value)).slice(2), 'hex').toString('hex').slice(0, 8)
  return `${value.slice(0, 55)}-${hash}`
}

export function normalizeEksClusterName(value: string): string {
  const trimmed = value.trim()
  const arnMatch = trimmed.match(/^arn:aws[\w-]*:eks:[^:]*:\d+:cluster\/(.+)$/)
  return (arnMatch ? arnMatch[1] : trimmed).trim()
}

function base64UrlToBuffer(value: string): Buffer {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padding = '='.repeat((4 - normalized.length % 4) % 4)
  return Buffer.from(`${normalized}${padding}`, 'base64')
}

export function deriveEthereumAddressFromSpkiDer(publicKeyBase64: string): string {
  const publicKey = createPublicKey({
    format: 'der',
    key: Buffer.from(publicKeyBase64, 'base64'),
    type: 'spki',
  })
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey
  if (!jwk.x || !jwk.y) {
    throw new Error('KMS public key did not contain secp256k1 x/y coordinates')
  }

  const x = base64UrlToBuffer(jwk.x)
  const y = base64UrlToBuffer(jwk.y)
  if (x.length !== 32 || y.length !== 32) {
    throw new Error(`Unexpected KMS public key coordinate length: x=${x.length}, y=${y.length}`)
  }

  const uncompressedWithoutPrefix = Buffer.concat([x, y])
  const hash = keccak256(uncompressedWithoutPrefix)
  return getAddress(`0x${hash.slice(-40)}`)
}

export class KmsSignerProvisioner {
  constructor(
    private readonly jsonCtx: JsonOutputContext,
    private readonly profile?: string
  ) {}

  async provision(
    role: KmsSignerProvisionRole,
    identity: KmsProvisionIdentity,
    input: KmsProvisionInput = {}
  ): Promise<KmsProvisionResult> {
    this.validateIdentity(identity)

    const safeNetworkAlias = sanitizeName(identity.networkAlias)
    const safeEksCluster = sanitizeName(identity.eksCluster)
    const aliasName = input.kmsKeyId || `alias/dogeos/${safeNetworkAlias}/${safeEksCluster}/${role.aliasSuffix}`
    const serviceAccount = input.serviceAccount || role.defaultServiceAccount
    const roleName = input.roleArn
      ? undefined
      : truncateIamRoleName(`dogeos-${safeNetworkAlias}-${safeEksCluster}-${role.roleSuffix}`)

    if (input.archive?.enabled && input.archive.bucket && input.createArchiveBucket !== false) {
      input.archive.created = this.ensureS3Bucket(input.archive.region || identity.awsRegion, input.archive.bucket, role.service)
    }

    const keyInfo = this.ensureKmsKey(identity.awsRegion, aliasName, input.kmsKeyId, role)
    const publicKeyBase64 = this.fetchKmsPublicKey(identity.awsRegion, keyInfo.kmsKeyIdForConfig)
    const expectedAddress = deriveEthereumAddressFromSpkiDer(publicKeyBase64)
    const roleArn = input.roleArn || this.ensureIamRole({
      archiveBucket: input.archive?.enabled ? input.archive.bucket : undefined,
      awsRegion: identity.awsRegion,
      eksCluster: identity.eksCluster,
      keyArn: keyInfo.keyArn,
      namespace: identity.namespace,
      roleDescription: `${role.description} role`,
      roleName: roleName as string,
      service: role.service,
      serviceAccount,
    })

    return {
      address: expectedAddress,
      aliasName,
      keyArn: keyInfo.keyArn,
      keyId: keyInfo.keyId,
      publicKeyBase64,
      roleArn,
      roleName,
      serviceAccount,
      signerConfig: {
        backend: 'aws_kms',
        eksCluster: identity.eksCluster,
        expectedAddress,
        kmsKeyArn: keyInfo.keyArn,
        kmsKeyId: keyInfo.kmsKeyIdForConfig,
        kmsRegion: identity.awsRegion,
        namespace: identity.namespace,
        networkAlias: identity.networkAlias,
        role: role.role,
        service: role.service,
        serviceAccountName: serviceAccount,
        serviceAccountRoleArn: roleArn,
      },
    }
  }

  private aws(args: string[], options: AwsCommandOptions = {}): any {
    const fullArgs = [...args]
    if (options.region) fullArgs.push('--region', options.region)
    if (options.profile || this.profile) fullArgs.push('--profile', options.profile || this.profile as string)
    if (options.query) fullArgs.push('--query', options.query)
    if (options.json) fullArgs.push('--output', 'json')
    else if (options.query) fullArgs.push('--output', 'text')

    try {
      const output = execFileSync('aws', fullArgs, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      if (options.json) return output ? JSON.parse(output) : {}
      return output
    } catch (error: any) {
      const stderr = error?.stderr ? String(error.stderr).trim() : ''
      throw new Error(stderr || error?.message || `aws ${fullArgs.join(' ')} failed`)
    }
  }

  private awsJson(args: string[], options: AwsCommandOptions = {}): any {
    return this.aws(args, { ...options, json: true })
  }

  private awsText(args: string[], options: AwsCommandOptions = {}): string {
    return String(this.aws(args, options))
  }

  private describeKey(awsRegion: string, keyId: string): any {
    const result = this.awsJson(['kms', 'describe-key', '--key-id', keyId], { region: awsRegion })
    return result.KeyMetadata
  }

  private ensureIamRole(options: {
    archiveBucket?: string
    awsRegion: string
    eksCluster: string
    keyArn: string
    namespace: string
    roleDescription: string
    roleName: string
    service: string
    serviceAccount: string
  }): string {
    const accountId = this.awsText(['sts', 'get-caller-identity'], { query: 'Account' })
    const issuer = this.awsText(
      ['eks', 'describe-cluster', '--name', options.eksCluster],
      { query: 'cluster.identity.oidc.issuer', region: options.awsRegion }
    )
    if (!issuer || issuer === 'None') {
      this.jsonCtx.error(
        'E702_EKS_OIDC_MISSING',
        `EKS cluster ${options.eksCluster} does not expose an OIDC issuer`,
        'CONFIGURATION',
        true,
        { cluster: options.eksCluster }
      )
    }

    const issuerHostPath = issuer.replace(/^https:\/\//, '')
    const oidcProviderArn = `arn:aws:iam::${accountId}:oidc-provider/${issuerHostPath}`
    const roleArn = `arn:aws:iam::${accountId}:role/${options.roleName}`
    const trustPolicy = {
      Statement: [{
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            [`${issuerHostPath}:aud`]: 'sts.amazonaws.com',
            [`${issuerHostPath}:sub`]: `system:serviceaccount:${options.namespace}:${options.serviceAccount}`,
          },
        },
        Effect: 'Allow',
        Principal: {
          Federated: oidcProviderArn,
        },
      }],
      Version: '2012-10-17',
    }

    const trustPolicyDocument = JSON.stringify(trustPolicy)
    try {
      this.awsJson(['iam', 'get-role', '--role-name', options.roleName])
      this.awsJson([
        'iam',
        'update-assume-role-policy',
        '--role-name',
        options.roleName,
        '--policy-document',
        trustPolicyDocument,
      ])
      this.jsonCtx.info(`${options.service}: updated IAM role trust policy: ${options.roleName}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('NoSuchEntity')) throw error

      this.awsJson([
        'iam',
        'create-role',
        '--role-name',
        options.roleName,
        '--assume-role-policy-document',
        trustPolicyDocument,
        '--description',
        options.roleDescription,
      ])
      this.jsonCtx.info(`${options.service}: created IAM role: ${options.roleName}`)
    }

    this.awsJson([
      'iam',
      'put-role-policy',
      '--role-name',
      options.roleName,
      '--policy-name',
      `${options.service}-kms-sign`,
      '--policy-document',
      JSON.stringify({
        Statement: [{
          Action: ['kms:GetPublicKey', 'kms:Sign'],
          Effect: 'Allow',
          Resource: options.keyArn,
        }],
        Version: '2012-10-17',
      }),
    ])
    this.jsonCtx.info(`${options.service}: updated IAM KMS signing policy: ${options.roleName}`)

    if (options.archiveBucket) {
      this.awsJson([
        'iam',
        'put-role-policy',
        '--role-name',
        options.roleName,
        '--policy-name',
        'eth-da-submitter-s3-archive',
        '--policy-document',
        JSON.stringify({
          Statement: [{
            Action: ['s3:GetObject', 's3:PutObject'],
            Effect: 'Allow',
            Resource: `arn:aws:s3:::${options.archiveBucket}/*`,
          }],
          Version: '2012-10-17',
        }),
      ])
      this.jsonCtx.info(`${options.service}: updated IAM S3 archive policy: ${options.roleName} -> ${options.archiveBucket}`)
    }

    return roleArn
  }

  private ensureKmsKey(awsRegion: string, aliasName: string, providedKeyId: string | undefined, role: KmsSignerProvisionRole): {
    keyArn: string
    keyId: string
    kmsKeyIdForConfig: string
  } {
    if (providedKeyId) {
      const metadata = this.describeKey(awsRegion, providedKeyId)
      this.validateKmsKey(metadata, providedKeyId)
      this.jsonCtx.info(`${role.service}: using KMS key: ${providedKeyId}`)
      return {
        keyArn: metadata.Arn,
        keyId: metadata.KeyId,
        kmsKeyIdForConfig: providedKeyId,
      }
    }

    const existingAlias = this.findKmsAlias(awsRegion, aliasName)
    if (existingAlias?.TargetKeyId) {
      const metadata = this.describeKey(awsRegion, existingAlias.TargetKeyId)
      this.validateKmsKey(metadata, aliasName)
      this.jsonCtx.info(`${role.service}: reusing KMS key alias: ${aliasName}`)
      return {
        keyArn: metadata.Arn,
        keyId: metadata.KeyId,
        kmsKeyIdForConfig: aliasName,
      }
    }

    const created = this.awsJson([
      'kms',
      'create-key',
      '--key-spec',
      'ECC_SECG_P256K1',
      '--key-usage',
      'SIGN_VERIFY',
      '--description',
      role.description,
      '--tags',
      `TagKey=dogeos:service,TagValue=${role.service}`,
      `TagKey=dogeos:purpose,TagValue=${role.purposeTag}`,
    ], { region: awsRegion })
    const metadata = created.KeyMetadata
    this.awsJson([
      'kms',
      'create-alias',
      '--alias-name',
      aliasName,
      '--target-key-id',
      metadata.KeyId,
    ], { region: awsRegion })
    this.jsonCtx.info(`${role.service}: created KMS key and alias: ${aliasName}`)

    return {
      keyArn: metadata.Arn,
      keyId: metadata.KeyId,
      kmsKeyIdForConfig: aliasName,
    }
  }

  private ensureS3Bucket(region: string, bucket: string, service: string): boolean {
    try {
      this.aws(['s3api', 'head-bucket', '--bucket', bucket], { region })
      this.jsonCtx.info(`${service}: reusing existing S3 archive bucket: ${bucket}`)
      return false
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const notFound = message.includes('404') || /not found/i.test(message)
      if (!notFound) {
        this.jsonCtx.error(
          'E705_S3_BUCKET_INACCESSIBLE',
          `S3 bucket ${bucket} exists but is not accessible (it may be owned by another AWS account): ${message}`,
          'CONFIGURATION',
          true,
          { bucket, region }
        )
      }
    }

    const createArgs = ['s3api', 'create-bucket', '--bucket', bucket]
    if (region !== 'us-east-1') {
      createArgs.push('--create-bucket-configuration', `LocationConstraint=${region}`)
    }

    this.aws(createArgs, { region })
    this.aws([
      's3api',
      'put-public-access-block',
      '--bucket',
      bucket,
      '--public-access-block-configuration',
      'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true',
    ], { region })
    this.aws([
      's3api',
      'put-bucket-encryption',
      '--bucket',
      bucket,
      '--server-side-encryption-configuration',
      JSON.stringify({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] }),
    ], { region })
    this.jsonCtx.info(`${service}: created S3 archive bucket: ${bucket} (region=${region}, public access blocked, SSE-S3)`)
    return true
  }

  private fetchKmsPublicKey(awsRegion: string, keyId: string): string {
    return this.awsText(
      ['kms', 'get-public-key', '--key-id', keyId],
      { query: 'PublicKey', region: awsRegion }
    )
  }

  private findKmsAlias(awsRegion: string, aliasName: string): any | undefined {
    const aliases = this.awsJson(['kms', 'list-aliases'], { region: awsRegion }).Aliases || []
    return aliases.find((alias: any) => alias.AliasName === aliasName)
  }

  private validateIdentity(identity: KmsProvisionIdentity): void {
    for (const [key, value] of Object.entries(identity)) {
      if (!value) {
        this.jsonCtx.error('E701_KMS_IDENTITY_MISSING', `${key} is required`, 'CONFIGURATION', true)
      }
    }

    if (!/^[\dA-Za-z][\w-]*$/.test(identity.eksCluster)) {
      this.jsonCtx.error(
        'E706_INVALID_EKS_CLUSTER_NAME',
        `eks-cluster must be a bare cluster name like "dogeos-devnet-cluster" (got "${identity.eksCluster}"). Pass the name, not an ARN.`,
        'CONFIGURATION',
        true,
        { eksCluster: identity.eksCluster }
      )
    }
  }

  private validateKmsKey(metadata: any, keyId: string): void {
    if (metadata.KeySpec !== 'ECC_SECG_P256K1') {
      this.jsonCtx.error(
        'E703_INVALID_KMS_KEY_SPEC',
        `${keyId} must use KMS KeySpec ECC_SECG_P256K1; got ${metadata.KeySpec}`,
        'CONFIGURATION',
        true,
        { keyId }
      )
    }

    if (metadata.KeyUsage !== 'SIGN_VERIFY') {
      this.jsonCtx.error(
        'E704_INVALID_KMS_KEY_USAGE',
        `${keyId} must use KMS KeyUsage SIGN_VERIFY; got ${metadata.KeyUsage}`,
        'CONFIGURATION',
        true,
        { keyId }
      )
    }
  }
}
