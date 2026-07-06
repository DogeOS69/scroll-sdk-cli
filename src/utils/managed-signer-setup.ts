/* eslint-disable @typescript-eslint/no-explicit-any -- Signer setup reads and writes dynamic TOML config */
import * as toml from '@iarna/toml'
import { confirm, select, input as textInput } from '@inquirer/prompts'
import chalk from 'chalk'
import { Wallet } from 'ethers'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { DogeConfig } from '../types/doge-config.js'
import type { JsonOutputContext } from './json-output.js'

import { writeConfigs } from './config-writer.js'
import { dogeConfigToToml } from './doge-config.js'
import {
  type BlobArchivePlan,
  type KmsProvisionIdentity,
  KmsSignerProvisioner,
  normalizeEksClusterName,
  sanitizeName,
  truncateIamRoleName,
} from './kms-signer-provisioner.js'
import { resolveEnvValue } from './non-interactive.js'
import {
  MANAGED_SIGNER_ROLES,
  type ManagedSignerBackend,
  type ManagedSignerConfig,
  type ManagedSignerKey,
  type ManagedSignerRole,
  accountAddressKey,
  accountPrivateKeyKey,
  buildLocalSignerConfig,
} from './signer-roles.js'

export interface ManagedSignerCommandOptions {
  dogeConfig: DogeConfig
  dogeConfigPath: string
  flags: any
  hasFlag: (name: string) => boolean
  jsonCtx: JsonOutputContext
  jsonMode: boolean
  nonInteractive: boolean
  signerKey: ManagedSignerKey
}

export interface ManagedSignerSetupResult {
  address: string
  dogeConfig: DogeConfig
  signerConfig: ManagedSignerConfig
  updatedConfigToml: boolean
}

interface KmsIdentityPromptDefaults {
  awsRegion?: string
  eksCluster?: string
  namespace?: string
  networkAlias?: string
}

interface ResolvedKmsSignerInput {
  kmsKeyId?: string
  roleArn?: string
  serviceAccount: string
}

interface LocalAccount {
  address: string
  privateKey: string
}

export async function setupManagedSigner(options: ManagedSignerCommandOptions): Promise<ManagedSignerSetupResult> {
  const { dogeConfig, dogeConfigPath, flags, jsonCtx, nonInteractive, signerKey } = options
  const role = MANAGED_SIGNER_ROLES[signerKey]
  const existingSigner = dogeConfig.signers?.[signerKey]
  const backend = await resolveSignerBackend(options, existingSigner)

  let address: string
  let signerConfig: ManagedSignerConfig
  let updatedConfigToml = false

  if (backend === 'local') {
    const account = await resolveLocalSignerAccount(options)
    address = account.address
    signerConfig = buildLocalSignerConfig(role)
    dogeConfig.accounts ||= {}
    dogeConfig.accounts[accountAddressKey(role) as keyof NonNullable<DogeConfig['accounts']>] = account.address
    dogeConfig.accounts[accountPrivateKeyKey(role) as keyof NonNullable<DogeConfig['accounts']>] = account.privateKey
  } else {
    const completeExisting = getCompleteExistingKmsSigner(dogeConfig, signerKey)
    const shouldProvision = shouldConfigureKmsSigner(options, completeExisting)
    if (!shouldProvision && completeExisting) {
      address = completeExisting.expectedAddress as string
      signerConfig = completeExisting
      jsonCtx.info(`${role.service}: keeping existing ${role.role} AWS KMS signer from ${relativePath(dogeConfigPath)} (${address})`)
    } else {
      const identityDefaults = getKmsIdentityPromptDefaults(role, completeExisting)
      const identity = await resolveKmsIdentity(options, identityDefaults)
      const provisionInput = resolveKmsSignerInput(options, role, completeExisting)
      logKmsProvisionPlan(role, identity, provisionInput, jsonCtx)
      const archive = role.service === 'eth-da-submitter'
        ? await resolveBlobArchive(options, identity.awsRegion)
        : { created: false, enabled: false }
      const provisioner = new KmsSignerProvisioner(jsonCtx, flags['aws-profile'])
      const provisioned = await provisioner.provision(role, identity, {
        archive,
        createArchiveBucket: flags['create-archive-bucket'],
        kmsKeyId: provisionInput.kmsKeyId,
        roleArn: provisionInput.roleArn,
        serviceAccount: provisionInput.serviceAccount,
      })
      address = provisioned.address
      signerConfig = provisioned.signerConfig
    }

    dogeConfig.accounts ||= {}
    dogeConfig.accounts[accountAddressKey(role) as keyof NonNullable<DogeConfig['accounts']>] = address
    delete dogeConfig.accounts[accountPrivateKeyKey(role) as keyof NonNullable<DogeConfig['accounts']>]
  }

  dogeConfig.signers ||= {}
  dogeConfig.signers[signerKey] = signerConfig as any

  if (!options.jsonMode) {
    console.log(chalk.cyan(`\n${role.role}_ADDR: ${address}`))
  }

  let shouldUpdate = true
  if (!nonInteractive) {
    shouldUpdate = await confirm({
      default: true,
      message: `Do you want to update ${relativePath(dogeConfigPath)} with ${role.role} signer settings?`,
    })
  }

  if (shouldUpdate) {
    fs.mkdirSync(path.dirname(dogeConfigPath), { recursive: true })
    fs.writeFileSync(dogeConfigPath, dogeConfigToToml(dogeConfig), 'utf8')
    jsonCtx.logSuccess(`Updated ${relativePath(dogeConfigPath)}`)
  }

  if (signerKey === 'l2GasOracleSender') {
    updatedConfigToml = updateConfigTomlAccountAddress(role, address, options.jsonMode, jsonCtx)
  }

  return {
    address,
    dogeConfig,
    signerConfig,
    updatedConfigToml,
  }
}

function relativePath(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath)
  return relative && !relative.startsWith('..') ? relative : filePath
}

function generateLocalAccount(): LocalAccount {
  const wallet = Wallet.createRandom()
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  }
}

async function resolveLocalSignerAccount(options: ManagedSignerCommandOptions): Promise<LocalAccount> {
  const { dogeConfig, nonInteractive, signerKey } = options
  const role = MANAGED_SIGNER_ROLES[signerKey]
  const privateKeyKey = accountPrivateKeyKey(role) as keyof NonNullable<DogeConfig['accounts']>
  const addressKey = accountAddressKey(role) as keyof NonNullable<DogeConfig['accounts']>
  const existingPrivateKey = dogeConfig.accounts?.[privateKeyKey]
  const existingAddress = dogeConfig.accounts?.[addressKey]

  if (existingPrivateKey && existingAddress) {
    if (nonInteractive) {
      return {
        address: String(existingAddress),
        privateKey: String(existingPrivateKey),
      }
    }

    const keepExisting = await confirm({
      default: true,
      message: `Reuse existing ${role.role} local private key from doge-config.toml?`,
    })
    if (keepExisting) {
      return {
        address: String(existingAddress),
        privateKey: String(existingPrivateKey),
      }
    }
  }

  return generateLocalAccount()
}

async function resolveSignerBackend(
  options: ManagedSignerCommandOptions,
  existingSigner: ManagedSignerConfig | undefined
): Promise<ManagedSignerBackend> {
  const { flags, nonInteractive, signerKey } = options
  const rawBackend = flags['signer-backend'] || existingSigner?.backend || 'local'
  const normalized = normalizeSignerBackend(rawBackend)
  if (nonInteractive) return normalized

  const role = MANAGED_SIGNER_ROLES[signerKey]
  return select({
    choices: [
      { name: 'Local private key (development)', value: 'local' },
      { name: 'AWS KMS (recommended production)', value: 'aws_kms' },
    ],
    default: normalized,
    message: `${role.role} / ${role.service} signer backend (${getSignerPurpose(role)}):`,
  })
}

export function normalizeSignerBackend(value: string): ManagedSignerBackend {
  if (value === 'aws-kms' || value === 'aws_kms') return 'aws_kms'
  if (value === 'local') return 'local'

  throw new Error(`Unsupported signer backend: ${value}`)
}

function getSignerPurpose(role: ManagedSignerRole): string {
  return role.configKey === 'l1CommitSender'
    ? 'submits Ethereum DA transactions to L1'
    : 'updates the L2 fee oracle contract'
}

function getCompleteExistingKmsSigner(
  dogeConfig: DogeConfig,
  signerKey: ManagedSignerKey
): ManagedSignerConfig | undefined {
  const signer = dogeConfig.signers?.[signerKey] as ManagedSignerConfig | undefined
  if (
    signer?.backend === 'aws_kms' &&
    signer.expectedAddress &&
    signer.kmsKeyId &&
    signer.kmsRegion
  ) {
    return signer
  }

  return undefined
}

function hasKmsProvisioningInput(options: ManagedSignerCommandOptions): boolean {
  const { flags, hasFlag, signerKey } = options
  return Boolean(
    flags['aws-region'] ||
    flags['eks-cluster'] ||
    flags['network-alias'] ||
    hasFlag('namespace') ||
    flags['kms-key-id'] ||
    flags['role-arn'] ||
    hasFlag('service-account') ||
    (
      signerKey === 'l1CommitSender' &&
      (
        flags['archive-bucket'] ||
        flags['archive-region'] ||
        flags['archive-key-prefix'] ||
        flags['disable-archive'] ||
        hasFlag('create-archive-bucket') ||
        hasFlag('no-create-archive-bucket')
      )
    )
  )
}

function shouldConfigureKmsSigner(
  options: ManagedSignerCommandOptions,
  existingSigner: ManagedSignerConfig | undefined
): boolean {
  if (hasKmsProvisioningInput(options) || !existingSigner) return true
  return !options.nonInteractive
}

function getKmsIdentityPromptDefaults(
  role: ManagedSignerRole,
  existingSigner: ManagedSignerConfig | undefined
): KmsIdentityPromptDefaults {
  const defaults: KmsIdentityPromptDefaults = {}
  if (!existingSigner) return defaults

  defaults.awsRegion ||= existingSigner.kmsRegion
  defaults.namespace ||= existingSigner.namespace
  defaults.eksCluster ||= existingSigner.eksCluster
  defaults.networkAlias ||= existingSigner.networkAlias

  const parsedAlias = parseDogeosKmsAlias(existingSigner.kmsKeyId, role)
  defaults.eksCluster ||= parsedAlias?.eksCluster
  defaults.networkAlias ||= parsedAlias?.networkAlias
  return defaults
}

function parseDogeosKmsAlias(kmsKeyId: string | undefined, role: ManagedSignerRole): KmsIdentityPromptDefaults | undefined {
  if (!kmsKeyId) return undefined

  const match = kmsKeyId.match(/^alias\/dogeos\/([^/]+)\/([^/]+)\/([^/]+)$/)
  if (!match || match[3] !== role.aliasSuffix) return undefined

  return {
    eksCluster: match[2],
    networkAlias: match[1],
  }
}

async function resolveKmsIdentity(
  options: ManagedSignerCommandOptions,
  defaults: KmsIdentityPromptDefaults = {}
): Promise<KmsProvisionIdentity> {
  const { flags, jsonCtx, nonInteractive } = options
  const awsRegion = await resolveRequiredTextFlag(flags['aws-region'], defaults.awsRegion, 'AWS region for the EKS cluster and KMS keys:', '--aws-region', nonInteractive, jsonCtx)
  const eksCluster = await resolveRequiredTextFlag(flags['eks-cluster'], defaults.eksCluster, 'EKS cluster name or ARN for IRSA trust:', '--eks-cluster', nonInteractive, jsonCtx)
  const networkAlias = await resolveRequiredTextFlag(flags['network-alias'], defaults.networkAlias, 'Resource alias used in KMS aliases and IAM role names (for example devnet, testnet, staging):', '--network-alias', nonInteractive, jsonCtx)
  const namespace = await resolveNamespace(options.hasFlag('namespace') ? flags.namespace : undefined, defaults.namespace, nonInteractive)

  return {
    awsRegion,
    eksCluster: normalizeEksClusterName(eksCluster),
    namespace,
    networkAlias,
  }
}

async function resolveNamespace(value: string | undefined, defaultValue: string | undefined, nonInteractive: boolean): Promise<string> {
  const resolved = resolveEnvValue(value) || defaultValue || 'default'
  if (nonInteractive) return resolved.trim()

  return (await textInput({
    default: resolved.trim(),
    message: 'Kubernetes namespace for signer service accounts:',
    required: true,
  })).trim()
}

async function resolveRequiredTextFlag(
  value: string | undefined,
  defaultValue: string | undefined,
  message: string,
  flagName: string,
  nonInteractive: boolean,
  jsonCtx: JsonOutputContext
): Promise<string> {
  const resolved = resolveEnvValue(value)
  if (resolved) return resolved.trim()
  if (nonInteractive && defaultValue) return defaultValue.trim()

  if (nonInteractive) {
    jsonCtx.error(
      'E601_MISSING_FIELD',
      `${flagName} is required for AWS KMS signer provisioning.`,
      'CONFIGURATION',
      true,
      { flag: flagName }
    )
  }

  return (await textInput({ default: defaultValue, message, required: true })).trim()
}

function resolveKmsSignerInput(
  options: ManagedSignerCommandOptions,
  role: ManagedSignerRole,
  existingSigner: ManagedSignerConfig | undefined
): ResolvedKmsSignerInput {
  return {
    kmsKeyId: resolveEnvValue(options.flags['kms-key-id']) || existingSigner?.kmsKeyId,
    roleArn: resolveEnvValue(options.flags['role-arn']) || existingSigner?.serviceAccountRoleArn,
    serviceAccount: options.hasFlag('service-account')
      ? resolveEnvValue(options.flags['service-account']) || role.defaultServiceAccount
      : existingSigner?.serviceAccountName || role.defaultServiceAccount,
  }
}

function getDefaultKmsAlias(role: ManagedSignerRole, identity: KmsProvisionIdentity): string {
  return `alias/dogeos/${sanitizeName(identity.networkAlias)}/${sanitizeName(identity.eksCluster)}/${role.aliasSuffix}`
}

function getDefaultKmsRoleName(role: ManagedSignerRole, identity: KmsProvisionIdentity): string {
  return truncateIamRoleName(`dogeos-${sanitizeName(identity.networkAlias)}-${sanitizeName(identity.eksCluster)}-${role.roleSuffix}`)
}

function logKmsProvisionPlan(
  role: ManagedSignerRole,
  identity: KmsProvisionIdentity,
  input: ResolvedKmsSignerInput,
  jsonCtx: JsonOutputContext
): void {
  const kmsKeyId = input.kmsKeyId || getDefaultKmsAlias(role, identity)
  jsonCtx.info('AWS KMS signer context:')
  jsonCtx.info(`  AWS region: ${identity.awsRegion}`)
  jsonCtx.info(`  EKS cluster: ${identity.eksCluster}`)
  jsonCtx.info(`  Kubernetes namespace: ${identity.namespace}`)
  jsonCtx.info(`  Resource alias: ${identity.networkAlias}`)
  jsonCtx.info('KMS signer setup plan:')
  jsonCtx.info(`  ${role.service} (${role.role}):`)
  jsonCtx.info(`    purpose: ${getSignerPurpose(role)}`)
  jsonCtx.info(`    KMS key: ${kmsKeyId}`)
  jsonCtx.info(`    service account: ${identity.namespace}/${input.serviceAccount}`)
  jsonCtx.info(input.roleArn
    ? `    IAM role ARN: ${input.roleArn}`
    : `    IAM role name: ${getDefaultKmsRoleName(role, identity)}`)
}

async function resolveBlobArchive(
  options: ManagedSignerCommandOptions,
  awsRegion: string
): Promise<BlobArchivePlan> {
  const { dogeConfig, flags, jsonCtx, nonInteractive } = options
  if (flags['disable-archive']) {
    options.dogeConfig.ethereumDa ||= {}
    options.dogeConfig.ethereumDa.blobArchive ||= {}
    options.dogeConfig.ethereumDa.blobArchive.s3 ||= {}
    options.dogeConfig.ethereumDa.blobArchive.s3.enabled = false
    return { created: false, enabled: false }
  }

  const flagBucket = resolveEnvValue(flags['archive-bucket'])
  const flagRegion = resolveEnvValue(flags['archive-region'])
  const flagKeyPrefix = resolveEnvValue(flags['archive-key-prefix'])
  const configuredArchive = getConfiguredBlobArchive(dogeConfig)

  const defaultBucket = flagBucket || configuredArchive?.bucket
  const defaultRegion = flagRegion || configuredArchive?.region || awsRegion
  const defaultKeyPrefix = flagKeyPrefix || configuredArchive?.keyPrefix || ''

  if (nonInteractive) {
    if (!defaultBucket) {
      if (flagRegion || flagKeyPrefix) {
        jsonCtx.addWarning('--archive-region and --archive-key-prefix were ignored because --archive-bucket was not provided and doge-config has no enabled S3 archive bucket.')
      }

      return { created: false, enabled: false }
    }

    writeBlobArchiveConfig(options.dogeConfig, {
      bucket: defaultBucket,
      created: false,
      enabled: true,
      keyPrefix: defaultKeyPrefix || undefined,
      region: defaultRegion,
    })
    return {
      bucket: defaultBucket,
      created: false,
      enabled: true,
      keyPrefix: defaultKeyPrefix || undefined,
      region: defaultRegion,
    }
  }

  const enabled = await confirm({
    default: Boolean(defaultBucket),
    message: 'Grant eth-da-submitter IAM role access to an S3 blob archive bucket?',
  })
  if (!enabled) {
    options.dogeConfig.ethereumDa ||= {}
    options.dogeConfig.ethereumDa.blobArchive ||= {}
    options.dogeConfig.ethereumDa.blobArchive.s3 ||= {}
    options.dogeConfig.ethereumDa.blobArchive.s3.enabled = false
    return { created: false, enabled: false }
  }

  const bucket = (await textInput({
    default: defaultBucket || '',
    message: 'S3 archive bucket name:',
    required: true,
  })).trim()
  const region = (await textInput({
    default: defaultRegion,
    message: 'S3 archive bucket region:',
    required: true,
  })).trim()
  const keyPrefix = (await textInput({
    default: defaultKeyPrefix,
    message: 'S3 object key prefix (optional):',
  })).trim()

  const archive = {
    bucket,
    created: false,
    enabled: true,
    keyPrefix: keyPrefix || undefined,
    region,
  }
  writeBlobArchiveConfig(options.dogeConfig, archive)
  return archive
}

function writeBlobArchiveConfig(dogeConfig: DogeConfig, archive: BlobArchivePlan): void {
  dogeConfig.ethereumDa ||= {}
  dogeConfig.ethereumDa.blobArchive ||= {}
  dogeConfig.ethereumDa.blobArchive.s3 ||= {}
  dogeConfig.ethereumDa.blobArchive.s3.enabled = archive.enabled
  if (archive.bucket) dogeConfig.ethereumDa.blobArchive.s3.bucket = archive.bucket
  if (archive.region) dogeConfig.ethereumDa.blobArchive.s3.region = archive.region
  if (archive.keyPrefix) {
    dogeConfig.ethereumDa.blobArchive.s3.keyPrefix = archive.keyPrefix
  } else {
    delete dogeConfig.ethereumDa.blobArchive.s3.keyPrefix
  }
}

function getConfiguredBlobArchive(dogeConfig: DogeConfig): BlobArchivePlan | undefined {
  const s3 = dogeConfig.ethereumDa?.blobArchive?.s3
  if (!s3 || !isConfigTruthy(s3.enabled) || !s3.bucket) return undefined

  return {
    bucket: String(s3.bucket),
    created: false,
    enabled: true,
    keyPrefix: optionalConfigString(s3.keyPrefix),
    region: optionalConfigString(s3.region),
  }
}

function isConfigTruthy(value: boolean | string | undefined): boolean {
  return value === true || (typeof value === 'string' && value.toLowerCase() === 'true')
}

function optionalConfigString(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return String(value)
}

function updateConfigTomlAccountAddress(
  role: ManagedSignerRole,
  address: string,
  jsonMode: boolean,
  jsonCtx: JsonOutputContext
): boolean {
  const configPath = path.join(process.cwd(), 'config.toml')
  if (!fs.existsSync(configPath)) {
    jsonCtx.addWarning(`config.toml not found. Skipping accounts.${accountAddressKey(role)} sync.`)
    return false
  }

  const config = toml.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, any>
  config.accounts ||= {}
  const addressKey = accountAddressKey(role)
  if (config.accounts[addressKey] === address) return false

  config.accounts[addressKey] = address
  const success = writeConfigs(config, undefined, undefined, jsonMode)
  if (!success) {
    jsonCtx.error(
      'E612_CONFIG_UPDATE_FAILED',
      `Failed to update config.toml accounts.${addressKey}`,
      'CONFIGURATION',
      true,
      { addressKey }
    )
  }

  jsonCtx.logSuccess(`Updated config.toml accounts.${addressKey}`)
  return true
}
