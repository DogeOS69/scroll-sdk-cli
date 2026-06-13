/* eslint-disable @typescript-eslint/no-explicit-any -- AWS CLI responses are dynamic */
import * as toml from '@iarna/toml'
import { confirm, input } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import { getAddress, keccak256 } from 'ethers'
import { execFileSync } from 'node:child_process'
import { createPublicKey } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { DogeConfig } from '../../types/doge-config.js'

import { dogeConfigToToml } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {
  createNonInteractiveContext,
  resolveOrPrompt,
  validateAndExit,
} from '../../utils/non-interactive.js'

interface AwsCommandOptions {
  json?: boolean
  profile?: string
  query?: string
  region?: string
}

interface BlobArchivePlan {
  /** Resolved bucket name (undefined when archive is disabled). */
  bucket?: string
  /** True when this run created the bucket (vs. reusing an existing one). */
  created: boolean
  /** Whether the S3 blob archive is enabled at all. */
  enabled: boolean
  /** Object key prefix, if any. */
  keyPrefix?: string
  /** Region that owns the archive bucket (may differ from the KMS/EKS region). */
  region?: string
}

interface KmsSetupResult {
  aliasName: string
  archive: BlobArchivePlan
  awsRegion: string
  eksCluster: string
  expectedAddress: string
  keyArn: string
  keyId: string
  kmsKeyIdForConfig: string
  namespace: string
  networkAlias: string
  roleArn?: string
  roleName?: string
  serviceAccount: string
  wroteDogeConfig: boolean
}

function sanitizeName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^\da-z-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .replaceAll(/-{2,}/g, '-')

  return sanitized || 'default'
}

function truncateIamRoleName(value: string): string {
  if (value.length <= 64) return value

  const hash = Buffer.from(keccak256(Buffer.from(value)).slice(2), 'hex').toString('hex').slice(0, 8)
  return `${value.slice(0, 55)}-${hash}`
}

/**
 * Accept either a bare EKS cluster name or a full cluster ARN
 * (`arn:aws:eks:<region>:<account>:cluster/<name>`) and return the bare name.
 * Users frequently paste the ARN from the console; without this the name would
 * leak into the KMS alias and break `eks describe-cluster --name`.
 */
function normalizeEksClusterName(value: string): string {
  const trimmed = value.trim()
  const arnMatch = trimmed.match(/^arn:aws[\w-]*:eks:[^:]*:\d+:cluster\/(.+)$/)
  return (arnMatch ? arnMatch[1] : trimmed).trim()
}

function base64UrlToBuffer(value: string): Buffer {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padding = '='.repeat((4 - normalized.length % 4) % 4)
  return Buffer.from(`${normalized}${padding}`, 'base64')
}

function deriveEthereumAddressFromSpkiDer(publicKeyBase64: string): string {
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

export default class SetupEthDaKms extends Command {
  static override description = 'Set up AWS KMS signing for eth-da-submitter'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --aws-region us-west-2 --eks-cluster dogeos-testnet --network-alias testnet',
    '<%= config.bin %> <%= command.id %> -N --aws-region us-west-2 --eks-cluster dogeos-testnet --network-alias testnet',
    '<%= config.bin %> <%= command.id %> --kms-key-id alias/dogeos/testnet/dogeos-testnet/eth-da-submitter --role-arn arn:aws:iam::123456789012:role/custom-role',
  ]

  static override flags = {
    'archive-bucket': Flags.string({
      description: 'S3 bucket for the EIP-4844 blob archive (defaults to ethereumDa.blobArchive.s3.bucket in doge-config)',
    }),
    'archive-key-prefix': Flags.string({
      description: 'Object key prefix under the archive bucket (e.g. rehearsal/batches)',
    }),
    'archive-region': Flags.string({
      description: 'Region that owns the archive bucket (defaults to --aws-region)',
    }),
    'aws-profile': Flags.string({
      description: 'AWS CLI profile to use',
    }),
    'aws-region': Flags.string({
      description: 'AWS region that owns the KMS key and EKS cluster',
    }),
    'create-archive-bucket': Flags.boolean({
      allowNo: true,
      default: true,
      description: 'Create the archive bucket (Block Public Access + SSE-S3) if it does not exist',
    }),
    'disable-archive': Flags.boolean({
      default: false,
      description: 'Skip S3 blob archive setup entirely',
    }),
    'doge-config': Flags.string({
      default: '.data/doge-config.toml',
      description: 'Path to doge-config.toml to update',
    }),
    'dry-run': Flags.boolean({
      default: false,
      description: 'Print planned resource names without creating or updating AWS resources/files',
    }),
    'eks-cluster': Flags.string({
      description: 'EKS cluster name used for IRSA trust binding',
    }),
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    'kms-key-id': Flags.string({
      description: 'Existing KMS key id, ARN, or alias to use instead of the default deterministic alias',
    }),
    namespace: Flags.string({
      default: 'default',
      description: 'Kubernetes namespace for the eth-da-submitter service account',
    }),
    'network-alias': Flags.string({
      description: 'Network alias used to derive the deterministic KMS alias and IAM role name',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts. Requires --aws-region, --eks-cluster, and --network-alias.',
    }),
    'role-arn': Flags.string({
      description: 'Existing IAM role ARN to annotate on the eth-da-submitter service account',
    }),
    'service-account': Flags.string({
      default: 'eth-da-submitter',
      description: 'Kubernetes service account used by eth-da-submitter',
    }),
  }

  private flags: any
  private jsonCtx!: JsonOutputContext

  public override async run(): Promise<void> {
    const { flags } = await this.parse(SetupEthDaKms) as any
    this.flags = flags
    this.jsonCtx = new JsonOutputContext('setup eth-da-kms', flags.json)

    const niCtx = createNonInteractiveContext('setup eth-da-kms', flags['non-interactive'], flags.json)
    const awsRegion = await resolveOrPrompt(
      niCtx,
      () => input({ message: 'AWS region of the EKS cluster & KMS key (the S3 bucket region is asked separately):', required: true }),
      flags['aws-region'],
      {
        configPath: '--aws-region',
        description: 'AWS region that owns the KMS key and EKS cluster',
        field: 'aws-region',
      }
    )
    const eksCluster = await resolveOrPrompt(
      niCtx,
      () => input({ message: 'EKS cluster name or ARN:', required: true }),
      flags['eks-cluster'],
      {
        configPath: '--eks-cluster',
        description: 'EKS cluster name used for IRSA trust binding',
        field: 'eks-cluster',
      }
    )
    const networkAlias = await resolveOrPrompt(
      niCtx,
      () => input({ message: 'Network alias:', required: true }),
      flags['network-alias'],
      {
        configPath: '--network-alias',
        description: 'Network alias used to derive the deterministic signer identity',
        field: 'network-alias',
      }
    )

    const existingConfig = this.readExistingDogeConfig(flags['doge-config'])
    const archiveInput = await this.resolveBlobArchive(niCtx, existingConfig, awsRegion as string | undefined)
    validateAndExit(niCtx)

    const identity = {
      awsRegion: String(awsRegion).trim(),
      eksCluster: normalizeEksClusterName(String(eksCluster)),
      networkAlias: String(networkAlias).trim(),
    }
    this.validateIdentity(identity)

    const safeNetworkAlias = sanitizeName(identity.networkAlias)
    const safeEksCluster = sanitizeName(identity.eksCluster)
    const aliasName = flags['kms-key-id'] || `alias/dogeos/${safeNetworkAlias}/${safeEksCluster}/eth-da-submitter`
    const roleName = flags['role-arn']
      ? undefined
      : truncateIamRoleName(`dogeos-${safeNetworkAlias}-${safeEksCluster}-eth-da-submitter-kms`)

    const archive: BlobArchivePlan = {
      bucket: archiveInput.bucket,
      created: false,
      enabled: archiveInput.enabled,
      keyPrefix: archiveInput.keyPrefix,
      region: archiveInput.region,
    }

    let keyInfo = {
      keyArn: flags['kms-key-id'] || aliasName,
      keyId: flags['kms-key-id'] || aliasName,
      kmsKeyIdForConfig: flags['kms-key-id'] || aliasName,
    }
    let expectedAddress = '<dry-run>'
    let roleArn: string | undefined = flags['role-arn']

    if (flags['dry-run']) {
      this.jsonCtx.info('Dry run: no AWS resources or files will be changed.')
      if (archive.enabled && archive.bucket) {
        this.jsonCtx.info(
          `Dry run: would ensure S3 archive bucket ${archive.bucket} (region=${archive.region}) and grant the role s3:PutObject/s3:GetObject on arn:aws:s3:::${archive.bucket}/*`
        )
      }
    } else {
      keyInfo = await this.ensureKmsKey(identity.awsRegion, aliasName, flags['kms-key-id'])
      expectedAddress = this.deriveKmsExpectedAddress(identity.awsRegion, keyInfo.kmsKeyIdForConfig)
      if (archive.enabled && archive.bucket && flags['create-archive-bucket']) {
        archive.created = this.ensureS3Bucket(archive.region as string, archive.bucket)
      }

      roleArn ||= await this.ensureIamRole({
        archiveBucket: archive.enabled ? archive.bucket : undefined,
        awsRegion: identity.awsRegion,
        eksCluster: identity.eksCluster,
        keyArn: keyInfo.keyArn,
        namespace: flags.namespace,
        roleName: roleName as string,
        serviceAccount: flags['service-account'],
      })
    }

    const wroteDogeConfig = !flags['dry-run']

    if (wroteDogeConfig) {
      this.writeDogeConfig(flags['doge-config'], {
        expectedAddress,
        kmsKeyArn: keyInfo.keyArn,
        kmsKeyId: keyInfo.kmsKeyIdForConfig,
        kmsRegion: identity.awsRegion,
        namespace: flags.namespace,
        serviceAccountName: flags['service-account'],
        serviceAccountRoleArn: roleArn,
      }, archive)
    }

    const result: KmsSetupResult = {
      aliasName,
      archive,
      awsRegion: identity.awsRegion,
      eksCluster: identity.eksCluster,
      expectedAddress,
      keyArn: keyInfo.keyArn,
      keyId: keyInfo.keyId,
      kmsKeyIdForConfig: keyInfo.kmsKeyIdForConfig,
      namespace: flags.namespace,
      networkAlias: identity.networkAlias,
      roleArn,
      roleName,
      serviceAccount: flags['service-account'],
      wroteDogeConfig,
    }

    this.logSummary(result)
    this.jsonCtx.success(result)
  }

  private aws(args: string[], options: AwsCommandOptions = {}): any {
    const fullArgs = [...args]
    if (options.region) fullArgs.push('--region', options.region)
    if (options.profile) fullArgs.push('--profile', options.profile)
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
    return this.aws(args, { ...options, json: true, profile: this.flags['aws-profile'] })
  }

  private awsText(args: string[], options: AwsCommandOptions = {}): string {
    return String(this.aws(args, { ...options, profile: this.flags['aws-profile'] }))
  }

  private deriveKmsExpectedAddress(awsRegion: string, keyId: string): string {
    const publicKey = this.awsText(
      ['kms', 'get-public-key', '--key-id', keyId],
      { query: 'PublicKey', region: awsRegion }
    )
    return deriveEthereumAddressFromSpkiDer(publicKey)
  }

  private describeKey(awsRegion: string, keyId: string): any {
    const result = this.awsJson(['kms', 'describe-key', '--key-id', keyId], { region: awsRegion })
    return result.KeyMetadata
  }

  private async ensureIamRole(options: {
    archiveBucket?: string
    awsRegion: string
    eksCluster: string
    keyArn: string
    namespace: string
    roleName: string
    serviceAccount: string
  }): Promise<string> {
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
      this.jsonCtx.info(`Updated IAM role trust policy: ${options.roleName}`)
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
        'DogeOS eth-da-submitter AWS KMS signing role',
      ])
      this.jsonCtx.info(`Created IAM role: ${options.roleName}`)
    }

    const kmsPolicy = {
      Statement: [{
        Action: [
          'kms:GetPublicKey',
          'kms:Sign',
        ],
        Effect: 'Allow',
        Resource: options.keyArn,
      }],
      Version: '2012-10-17',
    }
    this.awsJson([
      'iam',
      'put-role-policy',
      '--role-name',
      options.roleName,
      '--policy-name',
      'eth-da-submitter-kms-sign',
      '--policy-document',
      JSON.stringify(kmsPolicy),
    ])
    this.jsonCtx.info(`Updated IAM KMS signing policy: ${options.roleName}`)

    if (options.archiveBucket) {
      const s3Policy = {
        Statement: [{
          Action: [
            's3:GetObject',
            's3:PutObject',
          ],
          Effect: 'Allow',
          Resource: `arn:aws:s3:::${options.archiveBucket}/*`,
        }],
        Version: '2012-10-17',
      }
      this.awsJson([
        'iam',
        'put-role-policy',
        '--role-name',
        options.roleName,
        '--policy-name',
        'eth-da-submitter-s3-archive',
        '--policy-document',
        JSON.stringify(s3Policy),
      ])
      this.jsonCtx.info(`Updated IAM S3 archive policy: ${options.roleName} -> ${options.archiveBucket}`)
    }

    return roleArn
  }

  private async ensureKmsKey(awsRegion: string, aliasName: string, providedKeyId?: string): Promise<{
    keyArn: string
    keyId: string
    kmsKeyIdForConfig: string
  }> {
    if (providedKeyId) {
      const metadata = this.describeKey(awsRegion, providedKeyId)
      this.validateKmsKey(metadata, providedKeyId)
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
      this.jsonCtx.info(`Reusing KMS key alias: ${aliasName}`)
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
      'DogeOS eth-da-submitter EIP-4844 blob transaction signer',
      '--tags',
      'TagKey=dogeos:service,TagValue=eth-da-submitter',
      'TagKey=dogeos:purpose,TagValue=ethereum-da',
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
    this.jsonCtx.info(`Created KMS key and alias: ${aliasName}`)

    return {
      keyArn: metadata.Arn,
      keyId: metadata.KeyId,
      kmsKeyIdForConfig: aliasName,
    }
  }

  private ensureS3Bucket(region: string, bucket: string): boolean {
    try {
      this.aws(['s3api', 'head-bucket', '--bucket', bucket], { region })
      this.jsonCtx.info(`Reusing existing S3 archive bucket: ${bucket}`)
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
    // us-east-1 must NOT send a LocationConstraint; every other region must.
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
    this.jsonCtx.info(`Created S3 archive bucket: ${bucket} (region=${region}, public access blocked, SSE-S3)`)
    return true
  }

  private findKmsAlias(awsRegion: string, aliasName: string): any | undefined {
    const aliases = this.awsJson(['kms', 'list-aliases'], { region: awsRegion }).Aliases || []
    return aliases.find((alias: any) => alias.AliasName === aliasName)
  }

  private logSummary(result: KmsSetupResult): void {
    this.jsonCtx.logSection('Ethereum DA KMS signer')
    this.jsonCtx.logKeyValue('awsRegion', result.awsRegion)
    this.jsonCtx.logKeyValue('eksCluster', result.eksCluster)
    this.jsonCtx.logKeyValue('networkAlias', result.networkAlias)
    this.jsonCtx.logKeyValue('kmsKeyId', result.kmsKeyIdForConfig)
    this.jsonCtx.logKeyValue('expectedAddress', result.expectedAddress)
    if (result.archive.enabled && result.archive.bucket) {
      this.jsonCtx.logKeyValue('archiveBucket', result.archive.bucket)
      if (result.archive.region) this.jsonCtx.logKeyValue('archiveRegion', result.archive.region)
      if (result.archive.keyPrefix) this.jsonCtx.logKeyValue('archiveKeyPrefix', result.archive.keyPrefix)
      this.jsonCtx.logKeyValue('archiveBucketCreated', String(result.archive.created))
    } else {
      this.jsonCtx.logKeyValue('archive', 'disabled')
    }

    if (result.roleArn) this.jsonCtx.logKeyValue('roleArn', result.roleArn)
    if (result.wroteDogeConfig) {
      this.jsonCtx.info('Run `scrollsdk setup prep-charts` to sync this signer into values/*.yaml.')
    }
  }

  private readExistingDogeConfig(filePath: string): DogeConfig {
    const resolvedPath = path.resolve(filePath)
    if (!fs.existsSync(resolvedPath)) {
      return {} as DogeConfig
    }

    return toml.parse(fs.readFileSync(resolvedPath, 'utf8')) as unknown as DogeConfig
  }

  private async resolveBlobArchive(
    niCtx: ReturnType<typeof createNonInteractiveContext>,
    existingConfig: DogeConfig,
    awsRegion: string | undefined
  ): Promise<{ bucket?: string; enabled: boolean; keyPrefix?: string; region?: string }> {
    if (this.flags['disable-archive']) {
      return { enabled: false }
    }

    const existingS3 = existingConfig.ethereumDa?.blobArchive?.s3
    const flagBucket = this.flags['archive-bucket'] as string | undefined
    const configBucket = typeof existingS3?.bucket === 'string' ? existingS3.bucket : undefined
    const defaultRegion =
      (this.flags['archive-region'] as string | undefined)
      || (typeof existingS3?.region === 'string' ? existingS3.region : undefined)
      || awsRegion
    const defaultPrefix =
      (this.flags['archive-key-prefix'] as string | undefined)
      || (typeof existingS3?.keyPrefix === 'string' ? existingS3.keyPrefix : undefined)

    // Non-interactive: archive is optional; enable it only when a bucket is known.
    if (niCtx.enabled) {
      const bucket = flagBucket || configBucket
      if (!bucket) {
        this.jsonCtx.info(
          'S3 blob archive not configured (no --archive-bucket and no ethereumDa.blobArchive.s3.bucket in doge-config); skipping S3 setup.'
        )
        return { enabled: false }
      }

      return { bucket, enabled: true, keyPrefix: defaultPrefix, region: defaultRegion }
    }

    // Interactive: prompt for anything missing from doge-config.
    const existingEnabled = existingS3?.enabled
    const defaultEnabled =
      existingEnabled === undefined ? true : !(existingEnabled === false || existingEnabled === 'false')
    const enabled = await confirm({
      default: defaultEnabled,
      message: 'Enable S3 blob archive for eth-da-submitter (recommended)?',
    })
    if (!enabled) {
      return { enabled: false }
    }

    const bucket = (
      await input({ default: flagBucket || configBucket, message: 'S3 archive bucket name:', required: true })
    ).trim()
    const region = (
      await input({ default: defaultRegion, message: 'S3 archive bucket region:', required: true })
    ).trim()
    const keyPrefix = (
      await input({ default: defaultPrefix ?? '', message: 'S3 object key prefix (optional, e.g. rehearsal/batches):' })
    ).trim()

    return { bucket, enabled: true, keyPrefix: keyPrefix || undefined, region }
  }

  private validateIdentity(identity: { awsRegion: string; eksCluster: string; networkAlias: string }): void {
    for (const [key, value] of Object.entries(identity)) {
      if (!value) {
        this.jsonCtx.error('E701_ETH_DA_KMS_IDENTITY_MISSING', `${key} is required`, 'CONFIGURATION', true)
      }
    }

    // Guard before any AWS resource is created: a malformed cluster name would
    // poison the KMS alias and fail `eks describe-cluster`.
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

  private writeDogeConfig(
    filePath: string,
    signer: NonNullable<NonNullable<DogeConfig['ethereumDa']>['signer']>,
    archive?: BlobArchivePlan
  ): void {
    const resolvedPath = path.resolve(filePath)
    let dogeConfig: DogeConfig = {} as DogeConfig
    if (fs.existsSync(resolvedPath)) {
      dogeConfig = toml.parse(fs.readFileSync(resolvedPath, 'utf8')) as unknown as DogeConfig
    }

    dogeConfig.ethereumDa ||= {}
    dogeConfig.ethereumDa.signer = {
      backend: 'aws_kms',
      expectedAddress: signer.expectedAddress,
      kmsKeyArn: signer.kmsKeyArn,
      kmsKeyId: signer.kmsKeyId,
      kmsRegion: signer.kmsRegion,
      namespace: signer.namespace,
      serviceAccountName: signer.serviceAccountName,
      serviceAccountRoleArn: signer.serviceAccountRoleArn,
    }

    if (archive?.enabled && archive.bucket) {
      dogeConfig.ethereumDa.blobArchive ||= {}
      dogeConfig.ethereumDa.blobArchive.s3 = {
        ...dogeConfig.ethereumDa.blobArchive.s3,
        bucket: archive.bucket,
        enabled: true,
        ...(archive.keyPrefix ? { keyPrefix: archive.keyPrefix } : {}),
        ...(archive.region ? { region: archive.region } : {}),
      }
    }

    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
    fs.writeFileSync(resolvedPath, dogeConfigToToml(dogeConfig))
    this.jsonCtx.info(`Updated ${resolvedPath}`)
  }
}
