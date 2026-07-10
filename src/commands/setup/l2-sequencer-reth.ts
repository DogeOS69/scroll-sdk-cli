/* eslint-disable @typescript-eslint/no-explicit-any -- Values YAML is dynamic */
import { select, input as textInput } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import { Wallet } from 'ethers'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { DogeConfig } from '../../types/doge-config.js'
import type { ManagedSignerRole } from '../../utils/signer-roles.js'

import { dogeConfigToToml, loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {
  type KmsProvisionIdentity,
  KmsSignerProvisioner,
  normalizeEksClusterName,
  sanitizeName,
  truncateIamRoleName,
} from '../../utils/kms-signer-provisioner.js'
import { createNonInteractiveContext, resolveEnvValue } from '../../utils/non-interactive.js'

type RethSecretMode = 'external-secret' | 'plain'
type RethSignerBackend = 'aws_kms' | 'local'
export type RethSignerMode = 'aws_kms' | 'external_secret' | 'plain'

export interface ResolvedRethSignerMode {
  mode: RethSignerMode
  secretMode: RethSecretMode
  signerBackend: RethSignerBackend
}

export interface KmsIdentityPromptDefaults {
  awsRegion?: string
  eksCluster?: string
  namespace?: string
  networkAlias?: string
}

export interface RethInstanceConfig {
  enodeUrl?: string
  index: number
  nodekey?: {
    privateKey?: string
    secretMode?: RethSecretMode
  }
  signer?: {
    address?: string
    eksCluster?: string
    kmsKeyArn?: string
    kmsKeyId?: string
    kmsRegion?: string
    mode?: RethSignerMode
    namespace?: string
    networkAlias?: string
    privateKey?: string
    serviceAccountName?: string
    serviceAccountRoleArn?: string
  }
}

export interface ResolvedSequencerRethConfig {
  index: number
  nodekey: string
  secretMode: RethSecretMode
  secretName: string
  signer: {
    address?: string
    backend: RethSignerBackend
    eksCluster?: string
    kmsKeyArn?: string
    kmsKeyId?: string
    kmsRegion?: string
    namespace?: string
    networkAlias?: string
    privateKey?: string
    serviceAccountName?: string
    serviceAccountRoleArn?: string
  }
  signerMode: RethSignerMode
}

export const RETH_NODEKEY_ENV = 'RETH_NODEKEY'
export const RETH_SIGNER_PRIVATE_KEY_ENV = 'RETH_SEQUENCER_SIGNER_PRIVATE_KEY'
export const RETH_SIGNER_BACKEND_ENV = 'RETH_SEQUENCER_SIGNER_BACKEND'
export const RETH_KMS_KEY_ID_ENV = 'RETH_SEQUENCER_AWS_KMS_KEY_ID'
export const RETH_SIGNER_ADDRESS_ENV = 'RETH_SEQUENCER_SIGNER_ADDRESS'

const RETH_LEGACY_SECRET_ENV_KEYS = [
  RETH_NODEKEY_ENV,
  RETH_SIGNER_PRIVATE_KEY_ENV,
]

const RETH_LEGACY_SIGNER_ENV_KEYS = [
  RETH_SIGNER_BACKEND_ENV,
  RETH_KMS_KEY_ID_ENV,
  RETH_SIGNER_ADDRESS_ENV,
]

const SEQUENCER_RETH_ROLE = {
  accountPrefix: 'SEQUENCER_RETH_SIGNER',
  aliasSuffix: 'sequencer-reth',
  configKey: 'l1CommitSender',
  defaultServiceAccount: 'l2-sequencer',
  description: 'DogeOS rollup-node reth sequencer block signer',
  expectedAddressEnvKey: RETH_SIGNER_ADDRESS_ENV,
  kmsKeyIdEnvKey: RETH_KMS_KEY_ID_ENV,
  kmsRegionEnvKey: 'AWS_REGION',
  purposeTag: 'sequencer-reth',
  role: 'SEQUENCER_RETH_SIGNER',
  roleSuffix: 'sequencer-reth-kms',
  service: 'sequencer-reth',
  signerBackendEnvKey: RETH_SIGNER_BACKEND_ENV,
} as const satisfies ManagedSignerRole

export function normalizeRethNodekey(value: string): string {
  const normalized = value.trim().replace(/^0x/i, '')
  if (!/^[\dA-Fa-f]{64}$/.test(normalized)) {
    throw new Error('reth nodekey must be a 64 hex character secp256k1 private key, with or without 0x prefix')
  }

  return normalized.toLowerCase()
}

export function normalizeRethSignerPrivateKey(value: string): string {
  const normalized = value.trim().replace(/^0x/i, '')
  if (!/^[\dA-Fa-f]{64}$/.test(normalized)) {
    throw new Error('reth sequencer signer private key must be a 64 hex character secp256k1 private key, with or without 0x prefix')
  }

  return `0x${normalized}`
}

export function getSequencerRethResourceName(index: number): string {
  return `l2-reth-sequencer-${index}`
}

export function getSequencerRethValuesFileName(index: number): string {
  return `l2-reth-sequencer-production-${index}.yaml`
}

export function deriveSequencerRethEnodeUrl(nodekey: string, index: number): string {
  const wallet = new Wallet(`0x${normalizeRethNodekey(nodekey)}`)
  const publicKeyNoPrefix = wallet.signingKey.publicKey.slice(4)
  return `enode://${publicKeyNoPrefix}@${getSequencerRethResourceName(index)}:30303`
}

export function parseSequencerRethKmsAlias(kmsKeyId: string | undefined, index: number): KmsIdentityPromptDefaults | undefined {
  if (!kmsKeyId) return undefined

  const match = kmsKeyId.match(/^alias\/dogeos\/([^/]+)\/([^/]+)\/([^/]+)$/)
  if (!match || match[3] !== `sequencer-reth-${index}`) return undefined

  return {
    eksCluster: match[2],
    networkAlias: match[1],
  }
}

export function getSequencerRethKmsIdentityPromptDefaults(
  existing: RethInstanceConfig | undefined,
  index: number
): KmsIdentityPromptDefaults {
  const defaults: KmsIdentityPromptDefaults = {}
  const signer = existing?.signer
  if (!signer) return defaults

  defaults.awsRegion ||= signer.kmsRegion
  defaults.namespace ||= signer.namespace
  defaults.eksCluster ||= signer.eksCluster
  defaults.networkAlias ||= signer.networkAlias

  const parsedAlias = parseSequencerRethKmsAlias(signer.kmsKeyId, index)
  defaults.eksCluster ||= parsedAlias?.eksCluster
  defaults.networkAlias ||= parsedAlias?.networkAlias
  return defaults
}

export function getSequencerRethDefaultKmsAlias(index: number, identity: KmsProvisionIdentity): string {
  return `alias/dogeos/${sanitizeName(identity.networkAlias)}/${sanitizeName(identity.eksCluster)}/sequencer-reth-${index}`
}

export function getSequencerRethDefaultKmsRoleName(index: number, identity: KmsProvisionIdentity): string {
  return truncateIamRoleName(`dogeos-${sanitizeName(identity.networkAlias)}-${sanitizeName(identity.eksCluster)}-sequencer-reth-${index}-kms`)
}

export function shouldReuseExistingSequencerRethKmsKey(
  existingKmsKeyId: string | undefined,
  index: number,
  identity: KmsProvisionIdentity
): boolean {
  return existingKmsKeyId === getSequencerRethDefaultKmsAlias(index, identity)
}

export function shouldReuseExistingSequencerRethRoleArn(
  existingRoleArn: string | undefined,
  index: number,
  identity: KmsProvisionIdentity
): boolean {
  if (!existingRoleArn) return false

  const expectedRoleName = getSequencerRethDefaultKmsRoleName(index, identity)
  return existingRoleArn.endsWith(`:role/${expectedRoleName}`) || existingRoleArn.endsWith(`/role/${expectedRoleName}`)
}

export function applySequencerRethValues(yamlData: any, config: ResolvedSequencerRethConfig): void {
  yamlData.reth ||= {}
  yamlData.reth.nodeKey ||= {}
  yamlData.reth.nodeKey.mode = 'secret'
  yamlData.reth.nodeKey.secretName = config.secretName
  yamlData.reth.nodeKey.secretKey = RETH_NODEKEY_ENV
  yamlData.reth.signer ||= {}

  if (config.signer.backend === 'aws_kms') {
    yamlData.reth.signer.type = 'awsKms'
    yamlData.reth.signer.awsKmsKeyId = config.signer.kmsKeyId
    delete yamlData.reth.signer.localFile
  } else {
    yamlData.reth.signer.type = 'localFile'
    yamlData.reth.signer.localFile ||= {}
    yamlData.reth.signer.localFile.secretName = config.secretName
    yamlData.reth.signer.localFile.secretKey = RETH_SIGNER_PRIVATE_KEY_ENV
    delete yamlData.reth.signer.awsKmsKeyId
    delete yamlData.serviceAccount
  }

  yamlData.envFrom = removeSecretRef(yamlData.envFrom, config.secretName)
  removeLegacyRethEnv(yamlData)

  if (config.secretMode === 'external-secret') {
    removePlainSecret(yamlData, config)
    ensureRethExternalSecret(yamlData, config)
  } else {
    removeExternalSecret(yamlData, config.secretName)
    ensurePlainSecret(yamlData, config)
  }

  delete yamlData.command
  delete yamlData.args
  if (yamlData.persistence?.keys) delete yamlData.persistence.keys

  if (config.signer.backend === 'aws_kms') {
    yamlData.serviceAccount ||= {}
    yamlData.serviceAccount.create = true
    yamlData.serviceAccount.name = config.signer.serviceAccountName || getSequencerRethResourceName(config.index)
    if (config.signer.serviceAccountRoleArn) {
      yamlData.serviceAccount.annotations ||= {}
      yamlData.serviceAccount.annotations['eks.amazonaws.com/role-arn'] = config.signer.serviceAccountRoleArn
    }
  }
}

function removeEnvValue(env: any[] | undefined, name: string): void {
  if (!Array.isArray(env)) return
  const index = env.findIndex(entry => entry?.name === name)
  if (index >= 0) env.splice(index, 1)
}

function removeConfigMapEnvValue(yamlData: any, name: string): void {
  const envData = yamlData.configMaps?.env?.data
  if (!envData || typeof envData !== 'object') return

  delete envData[name]
}

function removeLegacyRethEnv(yamlData: any): void {
  for (const envKey of [...RETH_LEGACY_SECRET_ENV_KEYS, ...RETH_LEGACY_SIGNER_ENV_KEYS]) {
    removeEnvValue(yamlData.env, envKey)
    removeConfigMapEnvValue(yamlData, envKey)
  }
}

function getSecretNameOverride(secretName: string, resourceName: string): string {
  return secretName.startsWith(`${resourceName}-`) ? secretName.slice(resourceName.length + 1) : secretName
}

function ensurePlainSecret(yamlData: any, config: ResolvedSequencerRethConfig): void {
  yamlData.secrets ||= {}
  const resourceName = getSequencerRethResourceName(config.index)
  const secretNameOverride = getSecretNameOverride(config.secretName, resourceName)
  const stringData: Record<string, string> = {
    [RETH_NODEKEY_ENV]: config.nodekey,
  }
  if (config.signer.backend === 'local' && config.signer.privateKey) {
    stringData[RETH_SIGNER_PRIVATE_KEY_ENV] = config.signer.privateKey
  }

  yamlData.secrets[secretNameOverride] = {
    enabled: true,
    nameOverride: secretNameOverride,
    stringData,
  }
}

function removePlainSecret(yamlData: any, config: ResolvedSequencerRethConfig): void {
  if (!yamlData.secrets) return

  const configuredResourceName = yamlData.global?.fullnameOverride || yamlData.global?.nameOverride
  const resourceNames = new Set<string>([
    getSequencerRethResourceName(config.index),
    ...(configuredResourceName ? [configuredResourceName] : []),
  ])
  const secretKeys = new Set<string>([config.secretName])
  for (const resourceName of resourceNames) {
    secretKeys.add(getSecretNameOverride(config.secretName, resourceName))
  }

  for (const secretKey of secretKeys) {
    delete yamlData.secrets[secretKey]
  }

  if (Object.keys(yamlData.secrets).length === 0) delete yamlData.secrets
}

function removeSecretRef(envFrom: any[] | undefined, secretName: string): any[] {
  if (!Array.isArray(envFrom)) return []
  return envFrom.filter(item => item?.secretRef?.name !== secretName)
}

function ensureRethExternalSecret(yamlData: any, config: ResolvedSequencerRethConfig): void {
  yamlData.externalSecrets ||= {}
  const existing = yamlData.externalSecrets[config.secretName] || {}
  const remoteKey = `dogeos/${config.secretName}`
  const data = [
    {
      remoteRef: { key: remoteKey, property: RETH_NODEKEY_ENV },
      secretKey: RETH_NODEKEY_ENV,
    },
  ]
  if (config.signer.backend === 'local') {
    data.push({
      remoteRef: { key: remoteKey, property: RETH_SIGNER_PRIVATE_KEY_ENV },
      secretKey: RETH_SIGNER_PRIVATE_KEY_ENV,
    })
  }

  yamlData.externalSecrets[config.secretName] = {
    data,
    provider: existing.provider || 'aws',
    refreshInterval: existing.refreshInterval || '2m',
    secretRegion: existing.secretRegion || config.signer.kmsRegion || 'us-east-1',
    serviceAccount: existing.serviceAccount || 'external-secrets',
  }
}

function removeExternalSecret(yamlData: any, secretName: string): void {
  if (!yamlData.externalSecrets?.[secretName]) return
  delete yamlData.externalSecrets[secretName]
  if (Object.keys(yamlData.externalSecrets).length === 0) delete yamlData.externalSecrets
}

export default class SetupL2SequencerReth extends Command {
  static override description = 'Configure a rollup-node reth sequencer signer key and P2P nodekey'

  static override examples = [
    '<%= config.bin %> <%= command.id %> --index 2',
    '<%= config.bin %> <%= command.id %> --index 2 --signer-mode external-secret --non-interactive',
    '<%= config.bin %> <%= command.id %> --index 2 --signer-mode aws-kms --aws-region us-west-2 --eks-cluster dogeos-testnet --network-alias testnet',
  ]

  static override flags = {
    'aws-profile': Flags.string({ description: 'AWS CLI profile to use for KMS signer provisioning.' }),
    'aws-region': Flags.string({ description: 'AWS region for the EKS cluster and KMS key.' }),
    'doge-config': Flags.string({ description: 'Path to Dogecoin config file (defaults to .data/doge-config.toml)' }),
    'eks-cluster': Flags.string({ description: 'EKS cluster name or ARN used for IRSA trust binding.' }),
    index: Flags.integer({ char: 'i', default: 0, description: 'Sequencer instance index to configure.' }),
    json: Flags.boolean({ default: false, description: 'Output in JSON format (stdout for data, stderr for logs)' }),
    'kms-key-id': Flags.string({ description: 'Existing KMS key id, ARN, or alias for the reth sequencer signer.' }),
    namespace: Flags.string({ default: 'default', description: 'Kubernetes namespace for the KMS signer service account.' }),
    'network-alias': Flags.string({ description: 'Resource alias used to derive deterministic KMS aliases and IAM role names.' }),
    nodekey: Flags.string({ description: 'Existing reth P2P nodekey private key as 64 hex chars, with or without 0x.' }),
    'nodekey-secret-mode': Flags.string({
      description: 'How P2P nodekey material is referenced from values YAML. AWS KMS signer mode only; local signer mode uses --signer-mode.',
      options: ['external-secret', 'plain'],
    }),
    'non-interactive': Flags.boolean({ char: 'N', default: false, description: 'Run without prompts. Generates missing local keys.' }),
    'role-arn': Flags.string({ description: 'Existing IAM role ARN to annotate on the sequencer service account.' }),
    'service-account': Flags.string({ description: 'Kubernetes service account used by this sequencer.' }),
    'signer-mode': Flags.string({
      description: 'How the reth sequencer block signer is configured.',
      options: ['aws-kms', 'external-secret', 'plain'],
    }),
    'signer-private-key': Flags.string({ description: 'Existing local sequencer signer private key, with or without 0x.' }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupL2SequencerReth) as any
    const nonInteractive = flags['non-interactive']
    const jsonMode = flags.json
    createNonInteractiveContext('setup l2-sequencer-reth', nonInteractive, jsonMode)
    const jsonCtx = new JsonOutputContext('setup l2-sequencer-reth', jsonMode)

    const { config: dogeConfig, configPath } = await loadDogeConfigWithSelection(
      flags['doge-config'],
      'scrollsdk setup doge-config'
    )
    const {index} = flags
    if (!Number.isInteger(index) || index < 0) {
      jsonCtx.error('E602_INVALID_INDEX', '--index must be a non-negative integer.', 'CONFIGURATION', true, { index })
    }

    const existing = this.getExistingInstance(dogeConfig, index)
    const signerMode = await this.resolveSignerMode(flags, existing, nonInteractive)
    const {mode, signerBackend} = signerMode
    const nodekey = await this.resolveNodekey(flags, existing, nonInteractive)
    const nodekeySecretMode = await this.resolveNodekeySecretMode(flags, existing, signerMode, index, nonInteractive, jsonCtx)
    const signer = await this.resolveSigner(flags, existing, signerBackend, index, nonInteractive, jsonCtx)
    const secretName = `${getSequencerRethResourceName(index)}-secret-env`

    const resolved: ResolvedSequencerRethConfig = {
      index,
      nodekey,
      secretMode: nodekeySecretMode,
      secretName,
      signer,
      signerMode: mode,
    }

    this.updateDogeConfig(dogeConfig, index, resolved)
    fs.writeFileSync(configPath, dogeConfigToToml(dogeConfig), 'utf8')
    jsonCtx.logSuccess(`Updated ${path.relative(process.cwd(), configPath) || configPath}`)
    jsonCtx.info(`Run scrollsdk setup prep-charts to write ${getSequencerRethValuesFileName(index)} from doge-config.toml.`)

    if (jsonMode) {
      jsonCtx.success({
        dogeConfigPath: configPath,
        index,
        nodekeySecretMode,
        signer: {
          address: signer.address,
          backend: signer.backend,
          kmsKeyId: signer.kmsKeyId,
        },
        signerMode: mode,
      })
    }
  }

  private getExistingInstance(dogeConfig: DogeConfig, index: number): RethInstanceConfig | undefined {
    return dogeConfig.sequencerReth?.instances?.find(instance => instance.index === index)
  }

  private hasFlag(name: string): boolean {
    return this.argv.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`))
  }

  private async promptLocalSignerPrivateKey(existingPrivateKey?: string): Promise<string> {
    if (existingPrivateKey) {
      return normalizeRethSignerPrivateKey(await textInput({
        default: normalizeRethSignerPrivateKey(existingPrivateKey),
        message: 'Reth sequencer signer private key:',
        required: true,
      }))
    }

    const action = await select({
      choices: [
        { name: 'Generate a random signer private key', value: 'generate' },
        { name: 'Enter an existing signer private key', value: 'existing' },
      ],
      default: 'generate',
      message: 'Reth sequencer signer key:',
    })
    if (action === 'generate') return Wallet.createRandom().privateKey

    return normalizeRethSignerPrivateKey(await textInput({
      message: 'Enter reth sequencer signer private key (64 hex chars, 0x optional):',
      required: true,
    }))
  }

  private async resolveKmsIdentity(
    flags: any,
    existing: RethInstanceConfig | undefined,
    index: number,
    nonInteractive: boolean,
    jsonCtx: JsonOutputContext
  ): Promise<KmsProvisionIdentity> {
    const defaults = getSequencerRethKmsIdentityPromptDefaults(existing, index)
    const awsRegion = await this.resolveRequiredText(flags['aws-region'], defaults.awsRegion, '--aws-region', 'AWS region for the EKS cluster and KMS key:', nonInteractive, jsonCtx)
    const eksCluster = await this.resolveRequiredText(flags['eks-cluster'], defaults.eksCluster, '--eks-cluster', 'EKS cluster name or ARN for IRSA trust:', nonInteractive, jsonCtx)
    const networkAlias = await this.resolveRequiredText(flags['network-alias'], defaults.networkAlias, '--network-alias', 'Resource alias used in KMS aliases and IAM role names:', nonInteractive, jsonCtx)
    const namespace = (this.hasFlag('namespace')
      ? resolveEnvValue(flags.namespace)
      : undefined) || defaults.namespace || 'default'
    return {
      awsRegion,
      eksCluster: normalizeEksClusterName(eksCluster),
      namespace,
      networkAlias,
    }
  }

  private async resolveNodekey(flags: any, existing: RethInstanceConfig | undefined, nonInteractive: boolean): Promise<string> {
    const flagValue = resolveEnvValue(flags.nodekey)
    if (flagValue) return normalizeRethNodekey(flagValue)
    const existingNodekey = existing?.nodekey?.privateKey
    if (existingNodekey && nonInteractive) return normalizeRethNodekey(existingNodekey)
    if (nonInteractive) return normalizeRethNodekey(Wallet.createRandom().privateKey)

    if (existingNodekey) {
      return normalizeRethNodekey(await textInput({
        default: normalizeRethNodekey(existingNodekey),
        message: 'Reth P2P nodekey:',
        required: true,
      }))
    }

    const action = await select({
      choices: [
        { name: 'Generate a random nodekey', value: 'generate' },
        { name: 'Enter an existing nodekey', value: 'existing' },
      ],
      default: 'generate',
      message: 'Reth P2P nodekey:',
    })
    if (action === 'generate') return normalizeRethNodekey(Wallet.createRandom().privateKey)

    return normalizeRethNodekey(await textInput({
      message: 'Enter reth nodekey private key (64 hex chars, 0x optional):',
      required: true,
    }))
  }

  private async resolveNodekeySecretMode(
    flags: any,
    existing: RethInstanceConfig | undefined,
    signerMode: ResolvedRethSignerMode,
    index: number,
    nonInteractive: boolean,
    jsonCtx: JsonOutputContext
  ): Promise<RethSecretMode> {
    const flagValue = flags['nodekey-secret-mode'] as RethSecretMode | undefined
    if (signerMode.signerBackend === 'local') {
      if (this.hasFlag('nodekey-secret-mode') && flagValue !== signerMode.secretMode) {
        jsonCtx.error(
          'E602_INVALID_SECRET_MODE',
          '--nodekey-secret-mode must match --signer-mode for local signer mode because nodekey and signer private key share one chart Secret.',
          'CONFIGURATION',
          true,
          {
            nodekeySecretMode: flagValue,
            signerMode: signerMode.mode,
          }
        )
      }

      return signerMode.secretMode
    }

    if (this.hasFlag('nodekey-secret-mode')) return flagValue as RethSecretMode

    const existingSecretMode = existing?.nodekey?.secretMode
    if (nonInteractive) return existingSecretMode || 'external-secret'

    return select({
      choices: [
        { name: 'ExternalSecret reference', value: 'external-secret' },
        { name: 'Plain private key in values YAML', value: 'plain' },
      ],
      default: existingSecretMode || 'external-secret',
      message: `Reth sequencer ${index} P2P nodekey secret mode:`,
    })
  }

  private async resolveRequiredText(
    value: string | undefined,
    defaultValue: string | undefined,
    flagName: string,
    message: string,
    nonInteractive: boolean,
    jsonCtx: JsonOutputContext
  ): Promise<string> {
    const resolved = resolveEnvValue(value)
    if (resolved) return resolved.trim()
    if (nonInteractive && defaultValue) return defaultValue.trim()
    if (nonInteractive) {
      jsonCtx.error('E601_MISSING_FIELD', `${flagName} is required for AWS KMS signer provisioning.`, 'CONFIGURATION', true, { flag: flagName })
    }

    return (await textInput({ default: defaultValue, message, required: true })).trim()
  }

  private async resolveSigner(
    flags: any,
    existing: RethInstanceConfig | undefined,
    backend: RethSignerBackend,
    index: number,
    nonInteractive: boolean,
    jsonCtx: JsonOutputContext
  ): Promise<ResolvedSequencerRethConfig['signer']> {
    if (backend === 'local') {
      const flagValue = resolveEnvValue(flags['signer-private-key'])
      const existingPrivateKey = existingSignerMode(existing) === 'aws_kms' ? undefined : existing?.signer?.privateKey
      const privateKey = flagValue
        ? normalizeRethSignerPrivateKey(flagValue)
        : existingPrivateKey && nonInteractive
          ? normalizeRethSignerPrivateKey(existingPrivateKey)
          : nonInteractive
            ? Wallet.createRandom().privateKey
            : await this.promptLocalSignerPrivateKey(existingPrivateKey)
      const wallet = new Wallet(privateKey)
      return {
        address: wallet.address,
        backend: 'local',
        privateKey,
      }
    }

    const identity = await this.resolveKmsIdentity(flags, existing, index, nonInteractive, jsonCtx)
    const role = {
      ...SEQUENCER_RETH_ROLE,
      aliasSuffix: `sequencer-reth-${index}`,
      defaultServiceAccount: getSequencerRethResourceName(index),
      roleSuffix: `sequencer-reth-${index}-kms`,
    }
    const provisioner = new KmsSignerProvisioner(jsonCtx, flags['aws-profile'])
    const explicitKmsKeyId = resolveEnvValue(flags['kms-key-id'])
    const existingKmsKeyId = existing?.signer?.kmsKeyId
    const kmsKeyId = explicitKmsKeyId || (
      shouldReuseExistingSequencerRethKmsKey(existingKmsKeyId, index, identity)
        ? existingKmsKeyId
        : undefined
    )
    const explicitRoleArn = resolveEnvValue(flags['role-arn'])
    const existingRoleArn = existing?.signer?.serviceAccountRoleArn
    const roleArn = explicitRoleArn || (
      shouldReuseExistingSequencerRethRoleArn(existingRoleArn, index, identity)
        ? existingRoleArn
        : undefined
    )
    const provisioned = await provisioner.provision(role, identity, {
      kmsKeyId,
      roleArn,
      serviceAccount: resolveEnvValue(flags['service-account']) || existing?.signer?.serviceAccountName || getSequencerRethResourceName(index),
    })
    return {
      address: provisioned.address,
      backend: 'aws_kms',
      eksCluster: provisioned.signerConfig.eksCluster,
      kmsKeyArn: provisioned.keyArn,
      kmsKeyId: provisioned.signerConfig.kmsKeyId,
      kmsRegion: provisioned.signerConfig.kmsRegion,
      namespace: provisioned.signerConfig.namespace,
      networkAlias: provisioned.signerConfig.networkAlias,
      serviceAccountName: provisioned.serviceAccount,
      serviceAccountRoleArn: provisioned.roleArn,
    }
  }

  private async resolveSignerMode(
    flags: any,
    existing: RethInstanceConfig | undefined,
    nonInteractive: boolean
  ): Promise<ResolvedRethSignerMode> {
    if (this.hasFlag('signer-mode')) {
      return signerModeToConfig(normalizeSignerMode(flags['signer-mode']))
    }

    const existingMode = existingSignerMode(existing)
    if (nonInteractive) return signerModeToConfig(existingMode)

    const selectedMode = await select({
      choices: [
        { name: 'AWS KMS signer', value: 'aws_kms' },
        { name: 'Local private key via ExternalSecret', value: 'external_secret' },
        { name: 'Local private key in values YAML', value: 'plain' },
      ],
      default: existingMode,
      message: 'Reth sequencer signer mode:',
    })
    return signerModeToConfig(normalizeSignerMode(selectedMode))
  }

  private updateDogeConfig(
    dogeConfig: DogeConfig,
    index: number,
    resolved: ResolvedSequencerRethConfig
  ): void {
    dogeConfig.sequencerReth ||= {}
    dogeConfig.sequencerReth.instances ||= []
    const nextInstance: RethInstanceConfig = {
      enodeUrl: deriveSequencerRethEnodeUrl(resolved.nodekey, index),
      index,
      nodekey: {
        privateKey: resolved.nodekey,
        secretMode: resolved.secretMode,
      },
      signer: {
        address: resolved.signer.address,
        eksCluster: resolved.signer.eksCluster,
        kmsKeyArn: resolved.signer.kmsKeyArn,
        kmsKeyId: resolved.signer.kmsKeyId,
        kmsRegion: resolved.signer.kmsRegion,
        mode: resolved.signerMode,
        namespace: resolved.signer.namespace,
        networkAlias: resolved.signer.networkAlias,
        privateKey: resolved.signer.privateKey,
        serviceAccountName: resolved.signer.serviceAccountName,
        serviceAccountRoleArn: resolved.signer.serviceAccountRoleArn,
      },
    }

    const instanceIndex = dogeConfig.sequencerReth.instances.findIndex(instance => instance.index === index)
    if (instanceIndex >= 0) {
      dogeConfig.sequencerReth.instances[instanceIndex] = nextInstance
    } else {
      dogeConfig.sequencerReth.instances.push(nextInstance)
      dogeConfig.sequencerReth.instances.sort((a, b) => a.index - b.index)
    }
  }

}

function existingSignerMode(existing: RethInstanceConfig | undefined): RethSignerMode {
  return normalizeSignerMode(existing?.signer?.mode || 'external-secret')
}

export function normalizeSignerMode(value: string): RethSignerMode {
  if (value === 'aws-kms' || value === 'aws_kms' || value === 'kms') return 'aws_kms'
  if (value === 'external-secret' || value === 'external_secret') return 'external_secret'
  if (value === 'plain') return 'plain'
  throw new Error(`Unsupported signer mode: ${value}`)
}

export function signerModeToConfig(signerMode: RethSignerMode): ResolvedRethSignerMode {
  if (signerMode === 'aws_kms') {
    return {
      mode: signerMode,
      secretMode: 'external-secret',
      signerBackend: 'aws_kms',
    }
  }

  return {
    mode: signerMode,
    secretMode: signerMode === 'plain' ? 'plain' : 'external-secret',
    signerBackend: 'local',
  }
}
