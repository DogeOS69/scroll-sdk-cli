/* eslint-disable @typescript-eslint/no-explicit-any -- Existing deployment TOML and command adapters use dynamic fields */
import * as toml from '@iarna/toml'
import {checkbox, input, password, select} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import {Wallet} from 'ethers'
import fs from 'node:fs'
import path from 'node:path'

import {writeConfigs} from '../../utils/config-writer.js'
import {inspectContractOwner} from '../../utils/contract-owner.js'
import {loadDeploymentSpec} from '../../utils/deployment-spec-generator.js'
import {loadDogeConfigWithSelection} from '../../utils/doge-config.js'
import {CliExitError, JsonOutputContext} from '../../utils/json-output.js'
import {normalizeSignerBackend, setupManagedSigner} from '../../utils/managed-signer-setup.js'
import {resolveEnvValue} from '../../utils/non-interactive.js'
import SetupL2BootnodeReth from './l2-bootnode-reth.js'
import SetupL2SequencerReth, {normalizeSignerMode} from './l2-sequencer-reth.js'

export const KEYSTORE_SERVICES = ['sequencer-reth', 'bootnode-reth', 'fee-oracle', 'eth-da-submitter'] as const
export type KeystoreService = typeof KEYSTORE_SERVICES[number]
export interface IdentityTask {index?: number; indices?: number[]; service: KeystoreService}

// Existing DeploymentSpec output stores service accounts in config.toml. Import
// only missing identity inputs; doge-config remains authoritative once prepared.
function inheritServiceIdentity(config: any, main: any, service?: KeystoreService): void {
  for (const [name, signerKey, prefix] of [
    ['fee-oracle', 'l2GasOracleSender', 'L2_GAS_ORACLE_SENDER'],
    ['eth-da-submitter', 'l1CommitSender', 'L1_COMMIT_SENDER'],
  ]) {
    if (service && service !== name) continue
    if (!config.signers?.[signerKey] && main.signers?.[signerKey]) {
      config.signers ||= {}; config.signers[signerKey] = {...main.signers[signerKey]}
    }

    for (const suffix of ['ADDR', 'PRIVATE_KEY']) {
      if (suffix === 'PRIVATE_KEY' && config.signers?.[signerKey]?.backend === 'aws_kms') continue
      const key = `${prefix}_${suffix}`
      if (!config.accounts?.[key] && main.accounts?.[key]) {
        config.accounts ||= {}; config.accounts[key] = main.accounts[key]
      }
    }
  }
}

function countIndices(count: number): number[] {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Node counts must be non-negative integers')
  return Array.from({length: count}, (_, index) => index)
}

function configuredIndices(instances: any[] = []): number[] {
  const indices = instances.map(instance => instance.index)
  if (indices.some(index => !Number.isSafeInteger(index) || index < 0) || new Set(indices).size !== indices.length) {
    throw new Error('Configured node instances must have unique non-negative integer indices')
  }

  return indices.sort((a, b) => a - b)
}

export function planKeystore(config: any, flags: any): IdentityTask[] {
  const service = flags.service as KeystoreService | undefined
  if (service && !KEYSTORE_SERVICES.includes(service)) throw new Error('Unsupported keystore service')
  if (flags.index !== undefined && service !== 'sequencer-reth') throw new Error('--index requires --service sequencer-reth')
  if (flags.index !== undefined && (!Number.isSafeInteger(flags.index) || flags.index < 0)) throw new Error('--index must be a non-negative integer')
  if (flags.index !== undefined && flags['sequencer-count'] !== undefined) throw new Error('Use either --index or --sequencer-count')
  if (service && flags['sequencer-count'] !== undefined && service !== 'sequencer-reth') throw new Error('--sequencer-count requires the sequencer service')
  if (service && flags['bootnode-count'] !== undefined && service !== 'bootnode-reth') throw new Error('--bootnode-count requires the bootnode service')
  const tasks: IdentityTask[] = []
  for (const name of KEYSTORE_SERVICES) {
    if (service && service !== name) continue
    if (name === 'sequencer-reth' || name === 'bootnode-reth') {
      const sequencer = name === 'sequencer-reth'
      const instances = config[sequencer ? 'sequencerReth' : 'bootnodeReth']?.instances
      const existing = configuredIndices(instances)
      const count = flags[sequencer ? 'sequencer-count' : 'bootnode-count']
      let indices = count === undefined ? existing : countIndices(count)
      if (sequencer && flags.index !== undefined) indices = [flags.index]
      else if (service && count === undefined && indices.length === 0) indices = [0]
      if (count !== undefined && existing.some(index => !indices.includes(index))) {
        throw new Error('gen-keystore does not remove existing node identities; keep their indices in the requested count')
      }

      if (sequencer) tasks.push(...indices.map(index => ({index, service: name})))
      else if (indices.length > 0) tasks.push({indices, service: name})
    } else {
      const key = name === 'fee-oracle' ? 'l2GasOracleSender' : 'l1CommitSender'
      const account = name === 'fee-oracle' ? 'L2_GAS_ORACLE_SENDER' : 'L1_COMMIT_SENDER'
      if (service || config.signers?.[key] || config.accounts?.[`${account}_PRIVATE_KEY`] || config.accounts?.[`${account}_ADDR`]) tasks.push({service: name})
    }
  }

  const identityFlags = ['kms-key-id', 'role-arn', 'service-account', 'signer-private-key', 'nodekey', 'signer-backend', 'signer-mode', 'secret-mode', 'nodekey-secret-mode']
  if (identityFlags.some(name => flags[name] !== undefined) && (tasks.length !== 1 || (tasks[0].indices?.length ?? 1) !== 1)) {
    throw new Error('Identity-specific flags require exactly one service instance; select it with --service and, for a sequencer, --index')
  }

  if (flags['secret-mode'] && flags['nodekey-secret-mode'] && flags['secret-mode'] !== flags['nodekey-secret-mode']) throw new Error('Conflicting nodekey Secret modes')
  if (flags['signer-mode'] && flags['signer-mode'] !== 'aws-kms' && flags['secret-mode'] && flags['signer-mode'] !== flags['secret-mode']) throw new Error('Conflicting local signer Secret modes')
  if (flags['signer-backend'] && flags['signer-mode']) throw new Error('Use either --signer-backend or --signer-mode')
  for (const name of ['nodekey', 'secret-mode']) if (flags[name] && !['bootnode-reth', 'sequencer-reth'].includes(tasks[0]?.service)) throw new Error(`--${name} is only supported for Reth nodes`)
  for (const name of ['signer-mode', 'nodekey-secret-mode']) if (flags[name] && tasks[0]?.service !== 'sequencer-reth') throw new Error(`--${name} is only supported for sequencer-reth`)
  if (tasks[0]?.service === 'bootnode-reth' && ['signer-backend', 'kms-key-id', 'signer-private-key', 'role-arn', 'service-account'].some(name => flags[name])) throw new Error('Bootnodes only need a local P2P nodekey, not a transaction signer or KMS key')
  return tasks
}

function checkedWallet(key: string, label: string): Wallet {
  try { return new Wallet(resolveEnvValue(key) || '') }
  catch { throw new Error(`${label}: invalid private key or unresolved environment reference`) }
}

function assertLocalIdentity(key: string | undefined, address: string | undefined, label: string): void {
  if (!key) {
    if (address) throw new Error(`${label}: an address exists without its private key; import the existing key before continuing`)
    return
  }

  const wallet = checkedWallet(key, label)
  if (address && wallet.address.toLowerCase() !== address.toLowerCase()) throw new Error(`${label}: private key and configured address do not match`)
}

export function validateKeystoreIdentities(config: any, tasks: IdentityTask[], flags: any): void {
  for (const task of tasks) {
    const sequencer = task.service === 'sequencer-reth'
    const bootnode = task.service === 'bootnode-reth'
    const instances = config[sequencer ? 'sequencerReth' : 'bootnodeReth']?.instances || []
    if (sequencer || bootnode) {
      for (const index of task.indices || [task.index]) {
        const current = instances.find((instance: any) => instance.index === index)
        const key = current?.nodekey?.privateKey
        if (key) checkedWallet(key, `${task.service} nodekey`)
        if (flags.nodekey && key && checkedWallet(flags.nodekey, 'nodekey').address !== checkedWallet(key, 'nodekey').address) throw new Error('Refusing to replace an existing P2P nodekey')
      }

      if (flags.nodekey) checkedWallet(flags.nodekey, 'nodekey')
      if (bootnode) continue
    }

    const signerKey = task.service === 'fee-oracle' ? 'l2GasOracleSender' : 'l1CommitSender'
    const account = task.service === 'fee-oracle' ? 'L2_GAS_ORACLE_SENDER' : 'L1_COMMIT_SENDER'
    const current = sequencer ? instances.find((instance: any) => instance.index === task.index)?.signer : config.signers?.[signerKey]
    const existingKey = sequencer ? current?.privateKey : config.accounts?.[`${account}_PRIVATE_KEY`]
    const address = sequencer ? current?.address : config.accounts?.[`${account}_ADDR`] || current?.expectedAddress
    if (current?.kmsKeyId && (sequencer ? !current.mode : !current.backend)) throw new Error(`${task.service}: existing KMS reference requires an explicit configured backend`)
    const existingKms = sequencer ? current?.mode === 'aws_kms' : current?.backend === 'aws_kms'
    const selectedKms = flags['signer-mode'] ? normalizeSignerMode(flags['signer-mode']) === 'aws_kms' : flags['signer-backend'] ? normalizeSignerBackend(flags['signer-backend']) === 'aws_kms' : existingKms
    if ((existingKey || address || current?.kmsKeyId) && existingKms !== selectedKms) throw new Error(`${task.service}: changing an existing signer backend requires an explicit identity migration`)
    if (flags['kms-key-id'] && current?.kmsKeyId && flags['kms-key-id'] !== current.kmsKeyId) throw new Error('Refusing to replace an existing KMS key reference')
    if (selectedKms) {
      if (flags['signer-private-key']) throw new Error('A KMS signer cannot also receive a local private key')
      if (address && !current?.kmsKeyId && !flags['kms-key-id']) throw new Error(`${task.service}: existing address has no KMS key reference`)
      if (!sequencer && current?.expectedAddress && address && current.expectedAddress.toLowerCase() !== address.toLowerCase()) throw new Error(`${task.service}: KMS expected address and configured account address do not match`)
    } else {
      if (flags['kms-key-id']) throw new Error('--kms-key-id requires an AWS KMS signer backend')
      assertLocalIdentity(flags['signer-private-key'] || existingKey, address, task.service)
      if (flags['signer-private-key'] && existingKey && checkedWallet(flags['signer-private-key'], task.service).address !== checkedWallet(existingKey, task.service).address) throw new Error('Refusing to replace an existing signer private key')
    }
  }
}

// Collect all interactive choices before validation, file writes, or AWS calls.
// Execution then uses the same deterministic adapters as automation.
export const keystorePrompts = {checkbox, input, password, select}
interface PlannedIdentity {flags: any; task: IdentityTask}

async function promptKey(label: string, required: boolean): Promise<string | undefined> {
  if (!required) {
    const action = await keystorePrompts.select({
      choices: [{name: 'Generate a new random key', value: 'generate'}, {name: 'Import an existing key', value: 'import'}],
      message: `${label}:`,
    })
    if (action === 'generate') return undefined
  }

  return keystorePrompts.password({
    mask: '*',
    message: `${label}${required ? ' (required to preserve the configured address)' : ''}:`,
    validate(value) {
      try { checkedWallet(value, label); return true }
      catch { return 'Enter a valid private key or a resolvable $ENV: reference' }
    },
  })
}

async function promptIdentity(config: any, task: IdentityTask, base: any): Promise<any> {
  const flags = {...base}
  const sequencer = task.service === 'sequencer-reth'
  const node = sequencer || task.service === 'bootnode-reth'
  const instance = node ? config[sequencer ? 'sequencerReth' : 'bootnodeReth']?.instances?.find((item: any) => item.index === (task.index ?? task.indices?.[0])) : undefined
  const label = `${task.service}${node ? ` [${task.index ?? task.indices?.join(', ')}]` : ''}`
  if (node && !instance?.nodekey?.privateKey && !flags.nodekey && (task.indices?.length ?? 1) === 1) flags.nodekey = await promptKey(`${label} P2P nodekey`, false)
  if (!sequencer && node) return flags

  const signer = sequencer ? instance?.signer : config.signers?.[task.service === 'fee-oracle' ? 'l2GasOracleSender' : 'l1CommitSender']
  const prefix = task.service === 'fee-oracle' ? 'L2_GAS_ORACLE_SENDER' : 'L1_COMMIT_SENDER'
  const key = sequencer ? signer?.privateKey : config.accounts?.[`${prefix}_PRIVATE_KEY`]
  const address = sequencer ? signer?.address : config.accounts?.[`${prefix}_ADDR`] || signer?.expectedAddress
  if (!flags['signer-backend'] && !flags['signer-mode'] && !signer?.mode && !signer?.backend && !key && !address) {
    flags['signer-backend'] = await keystorePrompts.select({
      choices: [{name: 'Local private key', value: 'local'}, {name: 'AWS KMS (may create KMS and IAM resources)', value: 'aws-kms'}],
      message: `${label} signing backend:`,
    })
  }

  const backend = flags['signer-backend'] || flags['signer-mode'] || signer?.backend || signer?.mode
  if (backend === 'aws-kms' || backend === 'aws_kms') {
    if (!signer?.kmsKeyId || !signer?.kmsRegion || !address) {
      for (const [flag, field, message] of [
        ['aws-region', 'kmsRegion', 'AWS region'],
        ['eks-cluster', 'eksCluster', 'EKS cluster name or ARN'],
        ['network-alias', 'networkAlias', 'Resource alias (for example devnet)'],
        ['namespace', 'namespace', 'Kubernetes namespace'],
      ]) {
        if (flag !== 'namespace' && resolveEnvValue(flags[flag])) continue
        flags[flag] = (await keystorePrompts.input({default: signer?.[field] || flags[flag], message: `${label}: ${message}:`, required: true})).trim()
      }
    }
  } else if (!key && !flags['signer-private-key']) {
    flags['signer-private-key'] = await promptKey(`${label} signing private key`, Boolean(address))
  }

  return flags
}

async function interactivePlan(config: any, flags: any, accountsOnly: boolean): Promise<PlannedIdentity[]> {
  // Reject contradictory command-line flags before asking questions.
  planKeystore(config, flags)
  if (accountsOnly) return []
  if (!flags.service && ['signer-backend', 'signer-mode', 'signer-private-key', 'nodekey', 'secret-mode', 'nodekey-secret-mode', 'kms-key-id', 'role-arn', 'service-account'].some(name => flags[name] !== undefined)) throw new Error('Select --service when supplying identity-specific flags in interactive mode')
  const services = flags.service ? [flags.service as KeystoreService] : await keystorePrompts.checkbox({
    choices: KEYSTORE_SERVICES.map(service => ({checked: true, name: service, value: service})),
    message: 'Services whose signing identities / P2P keys should be prepared (space to select):',
    required: !flags.accounts && !flags['activity-helper'],
  })
  const plans: PlannedIdentity[] = []
  for (const service of services) {
    const scoped = {...flags, service}
    if (service !== 'sequencer-reth') { delete scoped['sequencer-count']; delete scoped.index }
    if (service !== 'bootnode-reth') delete scoped['bootnode-count']
    const node = service === 'sequencer-reth' || service === 'bootnode-reth'
    if (node && scoped.index === undefined) {
      const countFlag = service === 'sequencer-reth' ? 'sequencer-count' : 'bootnode-count'
      if (scoped[countFlag] === undefined && !config[service === 'sequencer-reth' ? 'sequencerReth' : 'bootnodeReth']?.instances?.length) {
        scoped[countFlag] = Number(await keystorePrompts.input({
          default: '1', message: `${service} instance count:`,
          validate: value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) || 'Enter a non-negative integer',
        }))
      }
    }

    for (const task of planKeystore(config, scoped)) plans.push({flags: await promptIdentity(config, task, scoped), task})
  }

  return plans
}

export default class SetupGenKeystore extends Command {
  static override description = 'Prepare Reth node and service signing identities using local keys or AWS KMS'
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> -N',
    '<%= config.bin %> <%= command.id %> --service sequencer-reth --index 0 --signer-backend aws-kms --aws-region us-east-1 --eks-cluster dogeos-devnet --network-alias devnet -N',
    '<%= config.bin %> <%= command.id %> --service bootnode-reth --bootnode-count 2 -N',
    '<%= config.bin %> <%= command.id %> --service fee-oracle --signer-backend local -N',
    '<%= config.bin %> <%= command.id %> --service eth-da-submitter -N',
    '<%= config.bin %> <%= command.id %> --accounts -N',
  ]

  static override flags = {
    ...SetupL2SequencerReth.flags,
    accounts: Flags.boolean({allowNo: true, description: 'Prepare/reuse deployer; default an empty OWNER_ADDR to deployer and check owner signing access.'}),
    'activity-helper': Flags.boolean({default: false, description: 'Also prepare the optional testnet activity account in config.toml.'}),
    'bootnode-count': Flags.integer({description: 'Prepare Reth bootnode indices 0 through count-1; never deletes existing identities.'}),
    'from-spec': Flags.string({description: 'Use DeploymentSpec node counts after generating doge-config from that spec.'}),
    index: Flags.integer({char: 'i', description: 'One sequencer index; requires --service sequencer-reth.'}),
    'secret-mode': Flags.string({description: 'Secret reference mode for the selected Reth node.', options: ['external-secret', 'plain']}),
    'sequencer-count': Flags.integer({description: 'Prepare Reth sequencer indices 0 through count-1; never deletes existing identities.'}),
    service: Flags.string({description: 'Prepare only this service. Omit to select services interactively; -N/--json processes declared identities.', options: [...KEYSTORE_SERVICES]}),
    'signer-backend': Flags.string({description: 'Backend for the selected signing identity; otherwise reuse its configured backend.', options: ['local', 'aws-kms']}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(SetupGenKeystore) as any
    const output = new JsonOutputContext('setup gen-keystore', flags.json)
    try {
      flags.accounts ??= !flags.service && fs.existsSync('config.toml')
      if (flags['from-spec']) {
        const spec = loadDeploymentSpec(path.resolve(flags['from-spec']))
        if (!flags.service || flags.service === 'sequencer-reth') flags['sequencer-count'] ??= spec.infrastructure.sequencerCount
        if (!flags.service || flags.service === 'bootnode-reth') flags['bootnode-count'] ??= spec.infrastructure.bootnodeCount
      }

      const {config, configPath} = await loadDogeConfigWithSelection(flags['doge-config'])
      const main = fs.existsSync('config.toml') ? toml.parse(fs.readFileSync('config.toml', 'utf8')) : {}
      inheritServiceIdentity(config, main)
      const accountsOnly = !flags.service && !flags['from-spec'] && flags['sequencer-count'] === undefined && flags['bootnode-count'] === undefined && this.argv.some(arg => arg === '--accounts' || arg === '--activity-helper')
      const plans = accountsOnly ? [] : flags['non-interactive'] || flags.json
        ? planKeystore(config, flags).map(task => ({flags, task}))
        : await interactivePlan(config, flags, accountsOnly)
      const tasks = plans.map(plan => plan.task)
      if (tasks.length === 0 && !flags.accounts && !flags['activity-helper']) throw new Error('No configured identities. Select --service, supply node counts, or use --accounts for the deployer.')
      for (const plan of plans) validateKeystoreIdentities(config, [plan.task], plan.flags)
      output.info(`Service identities selected: ${tasks.length > 0 ? tasks.map(task => task.service + (task.index === undefined ? task.indices ? ` [${task.indices.join(', ')}]` : '' : ` [${task.index}]`)).join('; ') : 'none (deployment accounts only)'}`)
      const accounts = this.prepareAccounts(flags)
      const reports: Record<string, unknown>[] = []
      // Persist each completed service so reruns reuse it if a later provider operation fails.
      for (const {flags: taskFlags, task} of plans) {
        const flags = taskFlags
        const prepared = {...flags, 'doge-config': configPath, 'non-interactive': true}
        const args = [...this.argv.filter(arg => arg.startsWith('--')), ...Object.keys(flags).filter(name => flags[name] !== undefined && name !== 'namespace').map(name => `--${name}`)]
        if (taskFlags.namespace !== 'default' && taskFlags.namespace !== undefined) args.push('--namespace')
        if (task.service === 'sequencer-reth') {
          prepared.index = task.index
          const current = config.sequencerReth?.instances?.find(instance => instance.index === task.index)
          if (flags['signer-backend']) {
            prepared['signer-mode'] = flags['signer-backend'] === 'aws-kms' ? 'aws-kms' : flags['secret-mode'] || current?.signer?.mode?.replace('_', '-') || 'external-secret'
            args.push('--signer-mode')
          } else if (flags['secret-mode']) {
            if (current?.signer?.mode === 'aws_kms') {
              prepared['nodekey-secret-mode'] = flags['secret-mode']; args.push('--nodekey-secret-mode')
            } else { prepared['signer-mode'] = flags['secret-mode']; args.push('--signer-mode') }
          }

          if (prepared['signer-mode'] === 'aws-kms' && flags['secret-mode']) {
            prepared['nodekey-secret-mode'] = flags['secret-mode']; args.push('--nodekey-secret-mode')
          }

          prepared['kms-key-id'] ||= current?.signer?.kmsKeyId
          prepared['role-arn'] ||= current?.signer?.serviceAccountRoleArn
          prepared.nodekey ||= current?.nodekey?.privateKey ? resolveEnvValue(current.nodekey.privateKey) : undefined
          prepared['signer-private-key'] ||= current?.signer?.privateKey ? resolveEnvValue(current.signer.privateKey) : undefined
          reports.push({service: task.service, ...await new SetupL2SequencerReth(args, this.config).prepareIdentity(prepared, output)})
        } else if (task.service === 'bootnode-reth') {
          prepared.indices = task.indices
          prepared.count = task.indices!.length
          reports.push({service: task.service, ...await new SetupL2BootnodeReth(args, this.config).prepareIdentity(prepared, output)})
        } else {
          const {config: latest} = await loadDogeConfigWithSelection(configPath)
          inheritServiceIdentity(latest, main, task.service)
          const signerKey = task.service === 'fee-oracle' ? 'l2GasOracleSender' : 'l1CommitSender'
          const prefix = task.service === 'fee-oracle' ? 'L2_GAS_ORACLE_SENDER' : 'L1_COMMIT_SENDER'
          prepared['kms-key-id'] ||= latest.signers?.[signerKey]?.kmsKeyId
          prepared['role-arn'] ||= latest.signers?.[signerKey]?.serviceAccountRoleArn
          if (flags['signer-private-key']) {
            latest.accounts ||= {}
            ;(latest.accounts as any)[`${prefix}_PRIVATE_KEY`] = flags['signer-private-key']
          }

          const result = await setupManagedSigner({configureArchive: false, dogeConfig: latest, dogeConfigPath: configPath, flags: prepared, hasFlag: name => args.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`)), jsonCtx: output, jsonMode: flags.json, nonInteractive: true, signerKey})
          reports.push({address: result.address, service: task.service, signer: result.signerConfig})
        }
      }

      if (accounts) {
        if (flags.accounts) {
          for (const warning of inspectContractOwner(accounts.accounts).warnings) output.addWarning(warning)
        }

        const latest = toml.parse(fs.readFileSync('config.toml', 'utf8')) as any
        latest.accounts ||= {}
        for (const prefix of [...(flags.accounts ? ['DEPLOYER'] : []), ...(flags['activity-helper'] ? ['L2_TESTNET_ACTIVITY_HELPER'] : [])]) {
          for (const suffix of ['ADDR', 'PRIVATE_KEY']) latest.accounts[`${prefix}_${suffix}`] = accounts.accounts[`${prefix}_${suffix}`]
        }

        if (flags.accounts) latest.accounts.OWNER_ADDR = accounts.accounts.OWNER_ADDR
        if (!writeConfigs(latest, undefined, undefined, flags.json)) throw new Error('Unable to save deployment accounts')
        fs.chmodSync('config.toml', 0o600)
      }

      for (const report of reports) {
        const signer = report.signer as {address?: string; backend?: string} | undefined
        output.info(`${report.service}${report.index === undefined ? '' : ` [${report.index}]`}: prepared${report.address || signer?.address ? `; address ${report.address || signer?.address}` : ''}${signer?.backend ? `; backend ${signer.backend}` : ''}`)
      }

      output.logSuccess(`Prepared ${reports.length} service identity task(s)${accounts ? ' and deployment accounts' : ''}. Use gen-secrets and prep-charts to generate deployment files.`)
      output.success({accounts: accounts ? Object.fromEntries(Object.entries(accounts.accounts).filter(([key]) => key.endsWith('_ADDR'))) : undefined, dogeConfigPath: configPath, identities: reports})
    } catch (error) {
      if (error instanceof CliExitError) throw error
      output.error('E620_KEYSTORE_PREPARATION_FAILED', error instanceof Error ? error.message : 'Identity preparation failed', 'CONFIGURATION', true)
    }
  }

  private prepareAccounts(flags: any): any | undefined {
    if (!flags.accounts && !flags['activity-helper']) return undefined
    const config = toml.parse(fs.readFileSync('config.toml', 'utf8')) as any
    config.accounts ||= {}
    for (const prefix of [...(flags.accounts ? ['DEPLOYER'] : []), ...(flags['activity-helper'] ? ['L2_TESTNET_ACTIVITY_HELPER'] : [])]) {
      const key = config.accounts[`${prefix}_PRIVATE_KEY`]
      const address = config.accounts[`${prefix}_ADDR`]
      assertLocalIdentity(key, address, prefix)
      const wallet = key ? checkedWallet(key, prefix) : Wallet.createRandom()
      config.accounts[`${prefix}_PRIVATE_KEY`] = key || wallet.privateKey
      config.accounts[`${prefix}_ADDR`] = wallet.address
    }

    if (flags.accounts) {
      config.accounts.OWNER_ADDR ||= config.accounts.DEPLOYER_ADDR
      inspectContractOwner(config.accounts)
    }

    return config
  }
}
