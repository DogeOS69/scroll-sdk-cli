/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and native TOML are dynamic documents. */

import * as toml from '@iarna/toml'

import type {ProofTopologyMode} from '../types/proof-topology.js'

export const WITHDRAWAL_CONFIG_FILE = 'WithdrawalProcessor.toml'
export const WITHDRAWAL_CONFIG_PATH = `/app/config/${WITHDRAWAL_CONFIG_FILE}`
export const WITHDRAWAL_DEPLOYMENT_BEGIN = '# BEGIN scrollsdk managed deployment configuration'
export const WITHDRAWAL_DEPLOYMENT_END = '# END scrollsdk managed deployment configuration'
/** Default native config location relative to the deployment working directory. */
export const WITHDRAWAL_NATIVE_CONFIG_RELPATH = 'withdrawal-processor/WithdrawalProcessor.toml'
export const WITHDRAWAL_PROOF_ACTIVATION_ENV = {
  devDummyScrollInput: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__DEV_DUMMY__SCROLL_INPUT',
  mode: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE',
  requireBridge: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_BRIDGE_STATE',
  requireScroll: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_SCROLL_EXECUTION',
} as const
// A partial proof_work_api environment table replaces the complete native TOML
// table in Figment. Keep recognizing the old switch so setup removes it, but
// never project it again; proof-work topology is owned wholly by native TOML.
const RETIRED_WITHDRAWAL_PROOF_API_ENABLED_ENV = 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__ENABLED'

function parseToml(source: string, label: string): void {
  try {
    toml.parse(source)
  } catch (error) {
    throw new Error(`${label}: invalid WithdrawalProcessor TOML: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function markerCount(source: string, marker: string): number {
  return source.split(marker).length - 1
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Drop undefined leaves so @iarna/toml stringify never sees them. */
function stripUndefinedDeep(value: any): any {
  if (Array.isArray(value)) return value.map(item => stripUndefinedDeep(item))
  if (!isPlainObject(value)) return value
  const result: Record<string, any> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    result[key] = stripUndefinedDeep(item)
  }

  return result
}

/** Overlay wins; plain objects merge recursively; arrays and scalars replace. */
function deepMergeToml(base: any, overlay: any): any {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay
  const result: Record<string, any> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = key in result ? deepMergeToml(result[key], value) : value
  }

  return result
}

function deleteTomlPath(root: Record<string, any>, segments: string[]): void {
  let cursor: any = root
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(cursor?.[segment])) return
    cursor = cursor[segment]
  }

  delete cursor[segments.at(-1) as string]
}

export interface MergeWithdrawalDeploymentOptions {
  /** Table/key paths to remove after the merge (e.g. a retired blob provider). */
  deletePaths?: string[][]
}

/**
 * Merge deployment facts into the CLI-owned deployment block.
 *
 * Facts overwrite their keys; every other key inside the block (operator
 * tuning like fee rates or indexer cadence) survives. The block must be the
 * first content of the file so its top-level scalars stay at TOML document
 * root. Compiler-rendered native configs do not preserve comments, including
 * these markers, so a markerless config is structurally absorbed: root
 * scalars and tables touched by deployment facts move into a rebuilt managed
 * block, while unrelated tables remain after it. A marked block that drifted
 * below a hand-maintained table still fails closed.
 */
export function mergeWithdrawalManagedDeploymentBlock(
  source: string,
  facts: toml.JsonMap,
  options: MergeWithdrawalDeploymentOptions = {}
): string {
  parseToml(source, 'existing config')
  const beginCount = markerCount(source, WITHDRAWAL_DEPLOYMENT_BEGIN)
  const endCount = markerCount(source, WITHDRAWAL_DEPLOYMENT_END)
  if (beginCount !== endCount || beginCount > 1) {
    throw new Error(
      `WithdrawalProcessor TOML must contain either zero or one ${WITHDRAWAL_DEPLOYMENT_BEGIN} / ${WITHDRAWAL_DEPLOYMENT_END} block`
    )
  }

  let existing: Record<string, any> = {}
  let head = ''
  let tail = source
  if (beginCount === 1) {
    const begin = source.indexOf(WITHDRAWAL_DEPLOYMENT_BEGIN)
    const end = source.indexOf(WITHDRAWAL_DEPLOYMENT_END)
    if (end < begin) throw new Error(`WithdrawalProcessor TOML has ${WITHDRAWAL_DEPLOYMENT_END} before its begin marker`)
    const inner = source.slice(begin + WITHDRAWAL_DEPLOYMENT_BEGIN.length, end)
    try {
      existing = toml.parse(inner) as Record<string, any>
    } catch (error) {
      throw new Error(`managed deployment block is not standalone-parseable TOML: ${error instanceof Error ? error.message : String(error)}`)
    }

    head = source.slice(0, begin)
    tail = source.slice(end + WITHDRAWAL_DEPLOYMENT_END.length)
  } else {
    // dogeos-proof-topology parses and reserializes the native config, so the
    // next prep-charts run sees a valid but markerless rendered file. Merely
    // prepending facts would duplicate tables such as [dogecoin_indexer]. Move
    // every root scalar (which cannot safely appear after a TOML table) and
    // each fact-owned top-level table into the reconstructed managed block.
    const remainder = toml.parse(source) as Record<string, any>
    for (const [key, value] of Object.entries(remainder)) {
      if (!isPlainObject(value) || key in facts) {
        existing[key] = value
        delete remainder[key]
      }
    }

    tail = toml.stringify(remainder as toml.JsonMap).trimEnd()
    if (tail !== '') tail = `\n\n${tail}\n`
  }

  const merged = deepMergeToml(existing, stripUndefinedDeep(facts)) as Record<string, any>
  for (const segments of options.deletePaths || []) deleteTomlPath(merged, segments)

  const block = `${WITHDRAWAL_DEPLOYMENT_BEGIN}\n${toml.stringify(merged as toml.JsonMap).trimEnd()}\n${WITHDRAWAL_DEPLOYMENT_END}`
  const candidate = beginCount === 1
    ? `${head}${block}${tail}`
    : `${block}${tail}`
  parseToml(candidate, 'generated config')

  // Top-level scalars silently attach to the preceding table if any TOML
  // precedes the block; verify they landed at document root.
  const parsed = toml.parse(candidate) as Record<string, any>
  for (const [key, value] of Object.entries(merged)) {
    if (isPlainObject(value)) continue
    if (JSON.stringify(parsed[key]) !== JSON.stringify(value)) {
      throw new Error(
        `WithdrawalProcessor TOML: the ${WITHDRAWAL_DEPLOYMENT_BEGIN} block must be the first content of the file so top-level key ${key} stays at document root`
      )
    }
  }

  return candidate.endsWith('\n') ? candidate : `${candidate}\n`
}

function asInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be an integer; got ${String(value)}`)
  return parsed
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

export interface WithdrawalDeploymentFactsInput {
  dogecoinIndexerStartHeight: number
  dogecoinRpcUrl: unknown
  ethereumDa: {
    beaconRpcUrl?: unknown
    expectedBatcherAddress?: unknown
    inboxWorkerStartBlock?: unknown
    l1RpcUrl: unknown
    s3?: {
      enabled: boolean
      keyPrefix?: unknown
      publicBaseUrl?: unknown
    }
  }
  genesisSequencerTxHex: unknown
  initialBridgeRedeemScriptHex: unknown
  l2BootstrapNextStartingBlockHeight?: unknown
  l2MessageQueueAddress: unknown
  l2MessengerAddress: unknown
  l2RpcUrl: unknown
  networkStr: unknown
  tsoUrl?: unknown
}

export interface WithdrawalDeploymentFacts {
  deletePaths: string[][]
  /** Deployment facts re-asserted on every prep-charts run. */
  facts: toml.JsonMap
}

/**
 * Build deployment facts derived from config.toml / doge-config. These facts
 * overwrite their matching keys; template-owned strategy and limits survive.
 */
export function buildWithdrawalDeploymentFacts(input: WithdrawalDeploymentFactsInput): WithdrawalDeploymentFacts {
  const {s3} = input.ethereumDa
  const s3Enabled = s3?.enabled === true && nonEmpty(s3.publicBaseUrl) !== undefined
  const expectedBatcher = nonEmpty(input.ethereumDa.expectedBatcherAddress)
  const inboxStartBlock = asInteger(input.ethereumDa.inboxWorkerStartBlock, 'defaults.ethereumDaEmbeddedIndexerStartBlock')
  const beaconRpcUrl = nonEmpty(input.ethereumDa.beaconRpcUrl)
  const facts = {
    dogecoin_indexer: {
      start_height: Math.max(0, input.dogecoinIndexerStartHeight),
    },
    dogecoin_rpc_url: nonEmpty(input.dogecoinRpcUrl),
    dogeos_indexer: {
      message_queue_address: nonEmpty(input.l2MessageQueueAddress),
      messenger_address: nonEmpty(input.l2MessengerAddress),
      rpc_url: nonEmpty(input.l2RpcUrl),
    },
    ethereum_da: {
      blob_source: {
        ...(s3Enabled ? {
          aws_s3: {
            key_prefix: nonEmpty(s3?.keyPrefix),
            url: nonEmpty(s3?.publicBaseUrl),
          },
        } : {}),
        ...(beaconRpcUrl ? { beacon_node: { url: beaconRpcUrl } } : {}),
      },
      ...(inboxStartBlock === undefined && expectedBatcher === undefined ? {} : {
        inbox_worker: {
          ...(expectedBatcher ? { expected_batchers: [expectedBatcher] } : {}),
          start_block: inboxStartBlock,
        },
      }),
      l1_rpc_url: nonEmpty(input.ethereumDa.l1RpcUrl),
    },
    genesis_sequencer_tx_hex: nonEmpty(input.genesisSequencerTxHex),
    initial_bridge_redeem_script_hex: nonEmpty(input.initialBridgeRedeemScriptHex),
    l2_bootstrap_next_starting_block_height: asInteger(
      input.l2BootstrapNextStartingBlockHeight,
      'defaults.l2BootstrapNextStartingBlockHeight'
    ),
    network_str: nonEmpty(input.networkStr),
    tso_url: nonEmpty(input.tsoUrl) || 'http://tso-service:3000',
  } as unknown as toml.JsonMap

  return {
    // The current loader rejects these former parallel authorities. Remove
    // them from an existing scrollsdk-managed block during migration.
    deletePaths: [
      ['bridge_address'],
      ['bridge_script_hex'],
      ['genesis_sequencer_txid'],
      ['genesis_sequencer_vout'],
      ['ethereum_da', 'eth_chain_id'],
      ['ethereum_da', 'l2_chain_id'],
      ...(s3Enabled ? [] : [['ethereum_da', 'blob_source', 'aws_s3']]),
    ],
    facts,
  }
}

/**
 * Remove plain-value DOGEOS_WITHDRAWAL_* env entries that are now TOML-owned.
 * Secret-backed entries (valueFrom) and the proof-system activation projections
 * stay; figment still honors ad-hoc env overrides applied outside values.
 */
export function stripMigratedWithdrawalEnv(
  values: Record<string, any>
): Array<{ key: string; newValue: string; oldValue: string }> {
  if (!Array.isArray(values.env)) return []
  const changes: Array<{ key: string; newValue: string; oldValue: string }> = []
  for (let index = values.env.length - 1; index >= 0; index--) {
    const entry = values.env[index]
    const name = String(entry?.name || '')
    if (!name.startsWith('DOGEOS_WITHDRAWAL_')) continue
    if (entry.valueFrom !== undefined) continue
    if (isWithdrawalProofActivationEnv(name)) continue
    changes.push({
      key: `env.${name}`,
      newValue: 'removed (owned by WithdrawalProcessor.toml)',
      oldValue: String(entry.value ?? 'undefined'),
    })
    values.env.splice(index, 1)
  }

  return changes.reverse()
}

/**
 * Ensure the chart consumes the application TOML at the canonical path: the
 * --config arg, the config ConfigMap toggle, and its mount. The proof topology
 * reconciler embeds the compiler-rendered TOML in the final self-contained
 * values document after ordinary chart processing completes.
 */
export function ensureWithdrawalChartWiring(values: Record<string, any>): void {
  if (values.args !== undefined && !Array.isArray(values.args)) {
    throw new TypeError('withdrawal-processor values: args must be an array')
  }

  values.args ||= []
  const configFlagIndex = values.args.indexOf('--config')
  if (configFlagIndex === -1) {
    values.args.push('--config', WITHDRAWAL_CONFIG_PATH)
  } else if (values.args[configFlagIndex + 1] === undefined) {
    values.args.push(WITHDRAWAL_CONFIG_PATH)
  } else {
    values.args[configFlagIndex + 1] = WITHDRAWAL_CONFIG_PATH
  }

  values.configMaps ||= {}
  values.configMaps.config ||= {}
  values.configMaps.config.enabled = true

  values.persistence ||= {}
  values.persistence['withdrawal-processor-config'] ||= {}
  Object.assign(values.persistence['withdrawal-processor-config'], {
    enabled: true,
    mountPath: WITHDRAWAL_CONFIG_PATH,
    name: '{{ include "withdrawal-processor.fullname" . }}-config',
    readOnly: true,
    subPath: WITHDRAWAL_CONFIG_FILE,
    type: 'configMap',
  })

  // Migrate the historical `odAnnotations` typo and make signer topology
  // changes restart the workload that consumes the generated ConfigMap.
  values.podAnnotations ||= {}
  if (values.odAnnotations && typeof values.odAnnotations === 'object') {
    values.podAnnotations = { ...values.odAnnotations, ...values.podAnnotations }
  }

  delete values.odAnnotations
  values.podAnnotations['checksum/tso-signers'] = '{{ .Values.tsoSigners | toJson | sha256sum }}'
}

/**
 * Project only the chart-level lifecycle switch. PR #937 compiler output owns
 * [proof_system].mode and enforcement in native TOML; all old Figment proof
 * environment overrides are removed so they cannot replace that strict table.
 */
export function ensureWithdrawalProofActivationSwitch(
  values: Record<string, any>,
  topologyMode: ProofTopologyMode = 'disabled'
): boolean {
  values.withdrawalProof ||= {}
  values.env ||= []
  if (!Array.isArray(values.env)) throw new TypeError('withdrawal-processor values: env must be an array')
  const before = JSON.stringify([values.withdrawalProof, values.env])

  const enabled = topologyMode === 'active'
  values.withdrawalProof.enabled = enabled
  delete values.withdrawalProof.mode
  delete values.withdrawalProof.provingMode
  const unmanagedEnv = values.env.filter(
    (item: any) => !isWithdrawalProofActivationEnv(String(item?.name || ''))
  )
  values.env = unmanagedEnv

  return before !== JSON.stringify([values.withdrawalProof, values.env])
}

export function isWithdrawalProofActivationEnv(name: string): boolean {
  return name === RETIRED_WITHDRAWAL_PROOF_API_ENABLED_ENV
    || Object.values(WITHDRAWAL_PROOF_ACTIVATION_ENV).includes(
      name as typeof WITHDRAWAL_PROOF_ACTIVATION_ENV[keyof typeof WITHDRAWAL_PROOF_ACTIVATION_ENV]
    )
}
