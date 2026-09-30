import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'

import {assertGenesisSequencerAmount} from './bridge-constants.js'
import {inspectContractOwner} from './contract-owner.js'
import {resolveCubesignerPolicy} from './cubesigner-policy-receipts.js'

export interface DeploymentPreflight {
  blockers: string[]
  dstack: {configured: boolean; valuesPresent: boolean}
  warnings: string[]
}

function readToml(file: string): toml.JsonMap {
  try {return toml.parse(fs.readFileSync(file, 'utf8'))} catch {throw new Error(`Cannot read valid TOML: ${file}; contents omitted`)}
}

/** Read-only checks for the currently supported configuration and deployment. */
export function inspectDeployment(options: {
  deploymentDir: string; dogeConfig?: string; requireDstack?: boolean
}): DeploymentPreflight {
  const root = path.resolve(options.deploymentDir)
  const result: DeploymentPreflight = {blockers: [], dstack: {configured: false, valuesPresent: false}, warnings: []}
  const dogeFile = path.resolve(root, options.dogeConfig ?? '.data/doge-config.toml')
  const config = readToml(dogeFile) as unknown as DogeConfig
  try {
    const main = readToml(path.join(root, 'config.toml'))
    result.warnings.push(...inspectContractOwner(main.accounts as Record<string, unknown>).warnings)
  } catch (error) {result.blockers.push(error instanceof Error ? error.message : String(error))}

  try {
    assertGenesisSequencerAmount(readToml(path.join(root, '.data/setup_defaults.toml')).sequencer_target_amount)
  } catch (error) {result.blockers.push(error instanceof Error ? error.message : String(error))}

  if (config.cubesigner?.mode) {
    try {
      const policy = resolveCubesignerPolicy({deploymentDir: root, keys: (config.cubesigner.roles ?? []).flatMap(role => role.keys.map(key => ({keyId: key.key_id, materialId: key.material_id, roleId: role.role_id}))), network: config.network, selection: config.cubesigner})
      result.warnings.push(...policy.warnings)
    } catch (error) {result.blockers.push(error instanceof Error ? error.message : String(error))}
  }
  else {result.blockers.push('Set cubesigner.mode explicitly in the source configuration: transport_only for non-mainnet, or production_verifier_key_policy with its receipts')}

  const wpFile = path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
  const wp = readToml(wpFile)
  const fee = wp.fee_rate_sat_per_kvb
  if (typeof fee !== 'number' || !Number.isSafeInteger(fee) || fee < 100_000) result.blockers.push('WP fee_rate_sat_per_kvb must be an integer >= 100000; choose the fee explicitly in the native input')
  else if (fee < 1_000_000) result.warnings.push('WP fee_rate_sat_per_kvb is below the recommended 1000000')
  const da = wp.ethereum_da as toml.JsonMap | undefined
  const inbox = da?.inbox_worker as toml.JsonMap | undefined
  if (inbox && (!Array.isArray(inbox.expected_batchers) || inbox.expected_batchers.length === 0)) result.blockers.push('WP ethereum_da.inbox_worker.expected_batchers must be nonempty, even when disabled; regenerate from the submitter signer via prep-charts')

  const genesis = JSON.parse(fs.readFileSync(path.join(root, '.data/genesis.json'), 'utf8')) as {gasLimit?: number | string}
  const values = yaml.load(fs.readFileSync(path.join(root, 'values/eth-da-submitter-production.yaml'), 'utf8')) as {configMaps?: {env?: {data?: Record<string, unknown>}}}
  const limit = values.configMaps?.env?.data?.DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_L2_GAS_PER_CHUNK
  // An omitted chart/env override is resolved by the current native default.
  const chunkGas = Number(limit ?? 20_000_000)
  const blockGas = Number(genesis.gasLimit)
  if (!Number.isSafeInteger(blockGas) || blockGas <= 0 || !Number.isSafeInteger(chunkGas) || chunkGas <= blockGas) result.blockers.push('eth-da-submitter max_l2_gas_per_chunk must be strictly greater than the genesis gasLimit; set a valid explicit limit')

  result.dstack.configured = Boolean(config.dstackController && config.dstackController.enabled !== false)
  result.dstack.valuesPresent = fs.existsSync(path.join(root, 'values/dstack-controller-production.yaml'))
  if (!result.dstack.configured || !result.dstack.valuesPresent) {
    const message = 'dstack controller is not fully configured/generated; run dstack-config, gen-secrets --dstack-only and prep-charts --dstack-only before installing its chart'
    if (options.requireDstack) result.blockers.push(message)
    else result.warnings.push(message)
  }

  result.warnings.push('Run setup artifact-access for the current S3 prefix and signer network-check on each Docker signer host; configuration checks do not establish live connectivity.')
  return result
}
