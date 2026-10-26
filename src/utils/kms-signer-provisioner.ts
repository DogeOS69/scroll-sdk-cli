/* eslint-disable @typescript-eslint/no-explicit-any -- AWS CLI responses are dynamic */
import { getAddress, keccak256 } from 'ethers'
import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { JsonOutputContext } from './json-output.js'
import type { ManagedSignerConfig, ManagedSignerRole } from './signer-roles.js'

import {assertPreparationAwsReadOnly} from './aws-cli.js'
import {ensureRetentionLifecycle} from './bucket-retention.js'
import {type KmsKeyOwner, kmsKeyOwned, kmsOwnershipTags} from './kms-key-ownership.js'
import {writeJson} from './preparation-io.js'
import {normalizeS3ArchiveKeyPrefix} from './s3-archive.js'

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
  serviceAccount?: string
}

export interface KmsProvisionResult {
  address: string
  aliasName: string
  keyArn: string
  keyId: string
  /** Whether this deployment created the key; aws-roles checks the key policy of any other key. */
  owned: boolean
  publicKeyBase64: string
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
    private readonly profile?: string,
    private readonly keyRecords = path.resolve('.data/kms-signers')
  ) {}

  inspectAddress(region: string, keyId: string): string {
    const metadata = this.describeKey(region, keyId)
    return deriveEthereumAddressFromSpkiDer(this.fetchKmsPublicKey(region, metadata.Arn))
  }

  async provision(
    role: KmsSignerProvisionRole,
    identity: KmsProvisionIdentity,
    input: KmsProvisionInput = {}
  ): Promise<KmsProvisionResult> {
    this.validateIdentity(identity)
    if (input.archive?.enabled) input.archive.keyPrefix = normalizeS3ArchiveKeyPrefix(input.archive.keyPrefix)

    const safeNetworkAlias = sanitizeName(identity.networkAlias)
    const safeEksCluster = sanitizeName(identity.eksCluster)
    const aliasName = input.kmsKeyId || `alias/dogeos/${safeNetworkAlias}/${safeEksCluster}/${role.aliasSuffix}`
    const serviceAccount = input.serviceAccount || role.defaultServiceAccount
    const owner: KmsKeyOwner = {catalogEntry: role.aliasSuffix, cluster: identity.eksCluster, deployment: identity.networkAlias}

    if (input.archive?.enabled && input.archive.bucket && input.createArchiveBucket !== false) {
      input.archive.created = this.ensureS3Bucket(input.archive.region || identity.awsRegion, input.archive.bucket, role.service)
    }

    const keyInfo = this.ensureKmsKey(identity.awsRegion, aliasName, input.kmsKeyId, role, owner)
    const publicKeyBase64 = this.fetchKmsPublicKey(identity.awsRegion, keyInfo.kmsKeyIdForConfig)
    const expectedAddress = deriveEthereumAddressFromSpkiDer(publicKeyBase64)
    return {
      address: expectedAddress,
      aliasName,
      keyArn: keyInfo.keyArn,
      keyId: keyInfo.keyId,
      owned: keyInfo.owned,
      publicKeyBase64,
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
      },
    }
  }

  /** Bucket and retention only; the writer grant is part of the submitter role written by aws-roles. */
  async provisionArchive(archive: BlobArchivePlan, options: {createBucket: boolean}): Promise<void> {
    if (!archive.enabled || !archive.bucket) return
    archive.keyPrefix = normalizeS3ArchiveKeyPrefix(archive.keyPrefix)
    if (options.createBucket) archive.created = this.ensureS3Bucket(archive.region || 'us-east-1', archive.bucket, 'eth-da-submitter')
    // DA blobs are kept forever: own this prefix's lifecycle rule and refuse expiring ones.
    const lifecycle = ensureRetentionLifecycle({json: (args, options) => this.awsJson(args, options)}, 'da', {bucket: archive.bucket, keyPrefix: archive.keyPrefix, region: archive.region || 'us-east-1'})
    if (lifecycle.changed) this.jsonCtx.info(`Set the DA archive retention lifecycle rule for s3://${archive.bucket}/${archive.keyPrefix}; no blob expires.`)
  }

  private aws(args: string[], options: AwsCommandOptions = {}): any {
    assertPreparationAwsReadOnly(args)
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

  private ensureKmsKey(awsRegion: string, aliasName: string, providedKeyId: string | undefined, role: KmsSignerProvisionRole, owner: KmsKeyOwner): {
    keyArn: string
    keyId: string
    kmsKeyIdForConfig: string
    owned: boolean
  } {
    const ownership = {json: (args: string[], options?: AwsCommandOptions) => this.awsJson(args, options)}
    if (providedKeyId) {
      const metadata = this.describeKey(awsRegion, providedKeyId)
      if (!metadata?.Arn || !metadata.KeyId) throw new Error('KMS metadata is missing its ARN or KeyId')
      this.jsonCtx.info(`${role.service}: using KMS key: ${providedKeyId}`)
      return {
        keyArn: metadata.Arn,
        keyId: metadata.KeyId,
        kmsKeyIdForConfig: metadata.Arn,
        owned: false,
      }
    }

    const recordFile = path.join(this.keyRecords, `${createHash('sha256').update(JSON.stringify({aliasName, awsRegion, owner})).digest('hex')}.json`)
    const saved = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, 'utf8')) : undefined
    const existingAlias = this.findKmsAlias(awsRegion, aliasName)
    let metadata: any
    if (saved) {
      if (saved.schema !== 'dogeos/kms-signer-key/v1' || saved.aliasName !== aliasName || saved.region !== awsRegion || typeof saved.keyArn !== 'string') throw new Error('Invalid saved KMS key identity; restore its preparation record')
      metadata = this.describeKey(awsRegion, saved.keyArn)
      this.validateKmsKey(metadata, saved.keyArn)
      if (metadata.Arn !== saved.keyArn) throw new Error('Saved KMS signing identity changed; refusing to replace it')
    } else if (existingAlias?.TargetKeyId) {
      metadata = this.describeKey(awsRegion, existingAlias.TargetKeyId)
      this.validateKmsKey(metadata, aliasName)
    }

    if (metadata && !kmsKeyOwned(ownership, metadata.Arn, owner, awsRegion)) throw new Error(`${aliasName} points to a KMS key this deployment did not create; select it explicitly to use it read-only`)
    if (!metadata) {
      metadata = this.awsJson(['kms', 'create-key', '--key-spec', 'ECC_SECG_P256K1', '--key-usage', 'SIGN_VERIFY', '--description', role.description,
        '--tags', kmsOwnershipTags(owner, {'dogeos:purpose': role.purposeTag, 'dogeos:service': role.service})], {region: awsRegion}).KeyMetadata
    }

    // Persist before alias creation: an interrupted alias operation must never
    // create a second signing key. Normal configuration also pins this ARN.
    writeJson(recordFile, {aliasName, keyArn: metadata.Arn, origin: 'created', region: awsRegion, schema: 'dogeos/kms-signer-key/v1'})
    if (existingAlias?.TargetKeyId && existingAlias.TargetKeyId !== metadata.KeyId) throw new Error('KMS alias points to another signing key; refusing to retarget it')
    if (!existingAlias?.TargetKeyId) this.awsJson(['kms', 'create-alias', '--alias-name', aliasName, '--target-key-id', metadata.KeyId], {region: awsRegion})
    return {keyArn: metadata.Arn, keyId: metadata.KeyId, kmsKeyIdForConfig: metadata.Arn, owned: true}
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
    this.aws(['s3api', 'put-bucket-versioning', '--bucket', bucket, '--versioning-configuration', 'Status=Enabled'], { region })
    this.jsonCtx.info(`${service}: created S3 archive bucket: ${bucket} (region=${region}, public access blocked, SSE-S3, versioned)`)
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
    if (metadata?.KeyState !== 'Enabled') throw new Error('KMS signing key must be enabled; restore the existing key instead of replacing the identity')
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
