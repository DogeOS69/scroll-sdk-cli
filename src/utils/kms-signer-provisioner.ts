/* eslint-disable @typescript-eslint/no-explicit-any -- AWS CLI responses are dynamic */
import { getAddress, keccak256 } from 'ethers'
import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { JsonOutputContext } from './json-output.js'
import type { ManagedSignerConfig, ManagedSignerRole } from './signer-roles.js'

import {assertAwsReadOnly} from './aws-cli.js'
import {checkExistingRetention} from './bucket-retention.js'
import {type KmsKeyOwner, kmsKeyOwned} from './kms-key-ownership.js'
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

    if (input.archive?.enabled && input.archive.bucket) this.requireS3Bucket(input.archive.region || identity.awsRegion, input.archive.bucket, role.service)

    const keyInfo = this.resolveKmsKey(identity.awsRegion, aliasName, input.kmsKeyId, role, owner)
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

  /** Verify the existing archive bucket and its retention; infrastructure tooling owns both. */
  async provisionArchive(archive: BlobArchivePlan): Promise<void> {
    if (!archive.enabled || !archive.bucket) return
    archive.keyPrefix = normalizeS3ArchiveKeyPrefix(archive.keyPrefix)
    const region = archive.region || 'us-east-1'
    this.requireS3Bucket(region, archive.bucket, 'eth-da-submitter')
    // DA blobs are kept forever: refuse any lifecycle rule that could expire them.
    checkExistingRetention({json: (args, options) => this.awsJson(args, options)}, 'da', {bucket: archive.bucket, keyPrefix: archive.keyPrefix, region})
  }

  private aws(args: string[], options: AwsCommandOptions = {}): any {
    assertAwsReadOnly(args)
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

  private requireS3Bucket(region: string, bucket: string, service: string): void {
    try {
      this.aws(['s3api', 'head-bucket', '--bucket', bucket], { region })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const notFound = message.includes('404') || /not found/i.test(message)
      this.jsonCtx.error(
        'E705_S3_BUCKET_INACCESSIBLE',
        notFound
          ? `S3 bucket ${bucket} does not exist; create it with the infrastructure templates before configuring ${service}`
          : `S3 bucket ${bucket} exists but is not accessible (it may be owned by another AWS account): ${message}`,
        'CONFIGURATION',
        true,
        { bucket, region }
      )
    }

    this.jsonCtx.info(`${service}: using existing S3 archive bucket: ${bucket}`)
  }

  private resolveKmsKey(awsRegion: string, aliasName: string, providedKeyId: string | undefined, role: KmsSignerProvisionRole, owner: KmsKeyOwner): {
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

    // Keys created by earlier CLI versions stay usable through their saved
    // record or alias. New keys come from infrastructure tooling.
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

    if (!metadata) throw new Error(`No ${role.service} KMS signing key found for ${aliasName}; create it with the infrastructure signing-key template, then pass its ID with --kms-key-id`)
    if (!kmsKeyOwned(ownership, metadata.Arn, owner, awsRegion)) throw new Error(`${aliasName} points to a KMS key this deployment did not create; select it explicitly to use it read-only`)
    if (existingAlias?.TargetKeyId && existingAlias.TargetKeyId !== metadata.KeyId) throw new Error('KMS alias points to another signing key; refusing to use it')
    if (!saved) writeJson(recordFile, {aliasName, keyArn: metadata.Arn, origin: 'created', region: awsRegion, schema: 'dogeos/kms-signer-key/v1'})
    return {keyArn: metadata.Arn, keyId: metadata.KeyId, kmsKeyIdForConfig: metadata.Arn, owned: true}
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
