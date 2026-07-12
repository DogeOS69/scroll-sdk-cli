/* eslint-disable @typescript-eslint/no-explicit-any -- Values YAML is dynamic */
import { select, input as textInput } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import { Wallet } from 'ethers'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { DogeConfig } from '../../types/doge-config.js'

import { dogeConfigToToml, loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import { createNonInteractiveContext, resolveEnvValue } from '../../utils/non-interactive.js'
import { normalizeRethNodekey } from './l2-sequencer-reth.js'

export type RethBootnodeSecretMode = 'external-secret' | 'plain'

export interface BootnodeRethInstanceConfig {
  enodeUrl?: string
  index: number
  nodekey?: {
    privateKey?: string
    secretMode?: RethBootnodeSecretMode
  }
}

export interface ResolvedBootnodeRethConfig {
  enodeUrl: string
  index: number
  nodekey: string
  secretMode: RethBootnodeSecretMode
  secretName: string
}

export const RETH_BOOTNODE_NODEKEY_ENV = 'RETH_NODEKEY'

export function getBootnodeRethResourceName(index: number): string {
  return `l2-reth-bootnode-${index}`
}

export function getBootnodeRethValuesFileName(index: number): string {
  return `l2-reth-bootnode-production-${index}.yaml`
}

export function deriveBootnodeRethEnodeUrl(nodekey: string, index: number): string {
  const wallet = new Wallet(`0x${normalizeRethNodekey(nodekey)}`)
  const publicKeyNoPrefix = wallet.signingKey.publicKey.slice(4)
  return `enode://${publicKeyNoPrefix}@${getBootnodeRethResourceName(index)}:30303`
}

export function applyBootnodeRethValues(yamlData: any, config: ResolvedBootnodeRethConfig): void {
  const chartResourceNames = getChartResourceNames(yamlData, getBootnodeRethResourceName(config.index))
  removeChartResourceNameOverrides(yamlData)
  yamlData.envFrom = removeGeneratedResourceRefs(removeSecretRef(yamlData.envFrom, config.secretName), chartResourceNames)
  if (yamlData.reth?.nodeKey) delete yamlData.reth.nodeKey.secretName
  removeEnvValue(yamlData.env, RETH_BOOTNODE_NODEKEY_ENV)

  if (config.secretMode === 'external-secret') {
    removePlainSecret(yamlData, config, chartResourceNames)
    ensureBootnodeRethExternalSecret(yamlData, config)
  } else {
    removeExternalSecret(yamlData, config.secretName)
    ensurePlainSecret(yamlData, config)
  }

  delete yamlData.command
  delete yamlData.args
  if (yamlData.persistence?.keys) delete yamlData.persistence.keys
}

function getChartResourceNames(values: any, defaultName: string): Set<string> {
  const names = new Set<string>([defaultName])
  for (const override of [values.global?.fullnameOverride, values.global?.nameOverride]) {
    if (typeof override === 'string' && override) names.add(override)
  }

  return names
}

function removeChartResourceNameOverrides(values: any): void {
  if (!values.global) return
  delete values.global.fullnameOverride
  delete values.global.nameOverride
  if (Object.keys(values.global).length === 0) delete values.global
}

function removeEnvValue(env: any[] | undefined, name: string): void {
  if (!Array.isArray(env)) return
  const index = env.findIndex(entry => entry?.name === name)
  if (index >= 0) env.splice(index, 1)
}

function removeSecretRef(envFrom: any[] | undefined, secretName: string): any[] {
  if (!Array.isArray(envFrom)) return []
  return envFrom.filter(item => item?.secretRef?.name !== secretName)
}

function removeGeneratedResourceRefs(envFrom: any[], resourceNames: Set<string>): any[] {
  const generatedConfigMaps = new Set([...resourceNames].map(resourceName => `${resourceName}-env`))
  return envFrom.filter(item => !generatedConfigMaps.has(item?.configMapRef?.name))
}

function getSecretNameOverride(secretName: string, resourceName: string): string {
  return secretName.startsWith(`${resourceName}-`) ? secretName.slice(resourceName.length + 1) : secretName
}

function ensurePlainSecret(yamlData: any, config: ResolvedBootnodeRethConfig): void {
  yamlData.secrets ||= {}
  const resourceName = getBootnodeRethResourceName(config.index)
  const secretNameOverride = getSecretNameOverride(config.secretName, resourceName)
  yamlData.secrets[secretNameOverride] = {
    enabled: true,
    nameOverride: secretNameOverride,
    stringData: {
      [RETH_BOOTNODE_NODEKEY_ENV]: config.nodekey,
    },
  }
}

function removePlainSecret(
  yamlData: any,
  config: ResolvedBootnodeRethConfig,
  resourceNames: Set<string>
): void {
  if (!yamlData.secrets) return

  const secretKeys = new Set<string>([config.secretName])
  for (const resourceName of resourceNames) {
    secretKeys.add(getSecretNameOverride(config.secretName, resourceName))
  }

  for (const secretKey of secretKeys) {
    delete yamlData.secrets[secretKey]
  }

  if (Object.keys(yamlData.secrets).length === 0) delete yamlData.secrets
}

function ensureBootnodeRethExternalSecret(yamlData: any, config: ResolvedBootnodeRethConfig): void {
  yamlData.externalSecrets ||= {}
  const existing = yamlData.externalSecrets['secret-env'] || yamlData.externalSecrets[config.secretName] || {}
  delete yamlData.externalSecrets[config.secretName]
  yamlData.externalSecrets['secret-env'] = {
    data: [
      {
        remoteRef: { key: `dogeos/${config.secretName}`, property: RETH_BOOTNODE_NODEKEY_ENV },
        secretKey: RETH_BOOTNODE_NODEKEY_ENV,
      },
    ],
    provider: existing.provider || 'aws',
    refreshInterval: existing.refreshInterval || '2m',
    secretRegion: existing.secretRegion || 'us-east-1',
    serviceAccount: existing.serviceAccount || 'external-secrets',
  }
}

function removeExternalSecret(yamlData: any, secretName: string): void {
  if (!yamlData.externalSecrets) return
  delete yamlData.externalSecrets[secretName]
  delete yamlData.externalSecrets['secret-env']
  if (Object.keys(yamlData.externalSecrets).length === 0) delete yamlData.externalSecrets
}

export default class SetupL2BootnodeReth extends Command {
  static override description = 'Configure rollup-node reth bootnode P2P nodekeys'

  static override examples = [
    '<%= config.bin %> <%= command.id %> --count 2',
    '<%= config.bin %> <%= command.id %> --count 2 --secret-mode external-secret --non-interactive',
    '<%= config.bin %> <%= command.id %> --count 1 --nodekey 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ]

  static override flags = {
    count: Flags.integer({ char: 'c', description: 'Number of reth bootnode instances to configure.' }),
    'doge-config': Flags.string({ description: 'Path to Dogecoin config file (defaults to .data/doge-config.toml)' }),
    json: Flags.boolean({ default: false, description: 'Output in JSON format (stdout for data, stderr for logs)' }),
    nodekey: Flags.string({
      description: 'Existing reth bootnode private key as 64 hex chars, with or without 0x. Repeat for multiple instances.',
      multiple: true,
    }),
    'non-interactive': Flags.boolean({ char: 'N', default: false, description: 'Run without prompts. Generates missing nodekeys.' }),
    'secret-mode': Flags.string({
      description: 'How nodekey material is referenced from values YAML.',
      options: ['external-secret', 'plain'],
    }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupL2BootnodeReth) as any
    const nonInteractive = flags['non-interactive']
    const jsonMode = flags.json
    createNonInteractiveContext('setup l2-bootnode-reth', nonInteractive, jsonMode)
    const jsonCtx = new JsonOutputContext('setup l2-bootnode-reth', jsonMode)

    const { config: dogeConfig, configPath } = await loadDogeConfigWithSelection(
      flags['doge-config'],
      'scrollsdk setup doge-config'
    )
    const count = await this.resolveCount(flags.count, dogeConfig, nonInteractive, jsonCtx)
    const nodekeyFlags = Array.isArray(flags.nodekey) ? flags.nodekey : flags.nodekey ? [flags.nodekey] : []
    const resolvedInstances: ResolvedBootnodeRethConfig[] = []

    for (let index = 0; index < count; index++) {
      const existing = this.getExistingInstance(dogeConfig, index)
      const nodekey = await this.resolveNodekey(index, resolveEnvValue(nodekeyFlags[index]), existing, nonInteractive)
      const secretMode = await this.resolveSecretMode(flags['secret-mode'], existing, index, nonInteractive)
      const enodeUrl = deriveBootnodeRethEnodeUrl(nodekey, index)
      resolvedInstances.push({
        enodeUrl,
        index,
        nodekey,
        secretMode,
        secretName: `${getBootnodeRethResourceName(index)}-secret-env`,
      })
    }

    this.updateDogeConfig(dogeConfig, resolvedInstances)
    fs.writeFileSync(configPath, dogeConfigToToml(dogeConfig), 'utf8')
    jsonCtx.logSuccess(`Updated ${path.relative(process.cwd(), configPath) || configPath}`)
    jsonCtx.info(`Run scrollsdk setup prep-charts to write ${count} l2-bootnode-reth values file(s) from doge-config.toml.`)

    if (jsonMode) {
      jsonCtx.success({
        count,
        dogeConfigPath: configPath,
        instances: resolvedInstances.map(instance => ({
          enodeUrl: instance.enodeUrl,
          index: instance.index,
          secretMode: instance.secretMode,
        })),
      })
    }
  }

  private getExistingInstance(dogeConfig: DogeConfig, index: number): BootnodeRethInstanceConfig | undefined {
    return dogeConfig.bootnodeReth?.instances?.find(instance => instance.index === index)
  }

  private hasFlag(name: string): boolean {
    return this.argv.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`))
  }

  private async resolveCount(
    flagValue: number | undefined,
    dogeConfig: DogeConfig,
    nonInteractive: boolean,
    jsonCtx: JsonOutputContext
  ): Promise<number> {
    if (flagValue !== undefined) {
      if (!Number.isInteger(flagValue) || flagValue < 1) {
        jsonCtx.error('E602_INVALID_COUNT', '--count must be a positive integer.', 'CONFIGURATION', true, { count: flagValue })
      }

      return flagValue
    }

    const existingCount = dogeConfig.bootnodeReth?.instances?.length
    if (nonInteractive) return existingCount && existingCount > 0 ? existingCount : 1

    const answer = await textInput({
      default: String(existingCount && existingCount > 0 ? existingCount : 1),
      message: 'How many reth bootnodes do you want to configure?',
      required: true,
      validate: value => Number.isInteger(Number(value)) && Number(value) > 0 ? true : 'Enter a positive integer',
    })
    return Number(answer)
  }

  private async resolveNodekey(
    index: number,
    flagValue: string | undefined,
    existing: BootnodeRethInstanceConfig | undefined,
    nonInteractive: boolean
  ): Promise<string> {
    if (flagValue) return normalizeRethNodekey(flagValue)
    const existingNodekey = existing?.nodekey?.privateKey
    if (existingNodekey && nonInteractive) return normalizeRethNodekey(existingNodekey)
    if (nonInteractive) return normalizeRethNodekey(Wallet.createRandom().privateKey)

    if (existingNodekey) {
      return normalizeRethNodekey(await textInput({
        default: normalizeRethNodekey(existingNodekey),
        message: `Reth bootnode ${index} P2P nodekey:`,
        required: true,
      }))
    }

    const action = await select({
      choices: [
        { name: 'Generate a random nodekey', value: 'generate' },
        { name: 'Enter an existing nodekey', value: 'existing' },
      ],
      default: 'generate',
      message: `Reth bootnode ${index} P2P nodekey:`,
    })
    if (action === 'generate') return normalizeRethNodekey(Wallet.createRandom().privateKey)

    return normalizeRethNodekey(await textInput({
      message: `Enter reth bootnode ${index} nodekey private key (64 hex chars, 0x optional):`,
      required: true,
    }))
  }

  private async resolveSecretMode(
    flagValue: string | undefined,
    existing: BootnodeRethInstanceConfig | undefined,
    index: number,
    nonInteractive: boolean
  ): Promise<RethBootnodeSecretMode> {
    if (this.hasFlag('secret-mode')) return flagValue as RethBootnodeSecretMode

    const existingSecretMode = existing?.nodekey?.secretMode
    if (nonInteractive) return existingSecretMode || 'external-secret'
    if (!existingSecretMode) return 'external-secret'

    return select({
      choices: [
        { name: 'ExternalSecret reference', value: 'external-secret' },
        { name: 'Plain private key in values YAML', value: 'plain' },
      ],
      default: existingSecretMode,
      message: `Reth bootnode ${index} nodekey secret mode:`,
    })
  }

  private updateDogeConfig(dogeConfig: DogeConfig, resolvedInstances: ResolvedBootnodeRethConfig[]): void {
    dogeConfig.bootnodeReth ||= {}
    dogeConfig.bootnodeReth.instances = resolvedInstances.map(instance => ({
      enodeUrl: instance.enodeUrl,
      index: instance.index,
      nodekey: {
        privateKey: instance.nodekey,
        secretMode: instance.secretMode,
      },
    }))
  }
}
