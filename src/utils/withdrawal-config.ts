/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and native TOML are dynamic documents. */

import * as toml from '@iarna/toml'

import type { ProofSystemMode } from './proof-system-mode.js'

export type { ProvingMode } from './proof-system-mode.js'

export const WITHDRAWAL_CONFIG_FILE = 'WithdrawalProcessor.toml'
export const WITHDRAWAL_CONFIG_PATH = `/app/config/${WITHDRAWAL_CONFIG_FILE}`
export const WITHDRAWAL_PROOF_BEGIN = '# BEGIN scrollsdk managed proof configuration'
export const WITHDRAWAL_PROOF_END = '# END scrollsdk managed proof configuration'
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

const MANAGED_PROOF_TABLES = new Set([
  'local_bridge_proof_runtime',
  'proof_artifact_transport',
  'proof_control_plane_gate',
  'proof_execution_worker',
  'proof_system',
  'proof_task_policy',
  'proof_work_api',
  'scroll_worker_api',
])

const RETIRED_PROOF_TOP_LEVEL_KEYS = new Set([
  'proving_mode',
  'scroll_proof_input_policy',
])

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

/**
 * Remove legacy unmarked proof tables while preserving unrelated TOML and comments.
 * This is used once when adopting managed markers in an existing values file.
 */
function stripUnmarkedManagedProofTables(source: string): string {
  const kept: string[] = []
  let skipTable = false
  let sawTable = false

  for (const line of source.split(/\r?\n/)) {
    const table = line.match(/^\s*\[{1,2}\s*([\w.-]+)\s*]{1,2}\s*(?:#.*)?$/)
    if (table) {
      sawTable = true
      const root = table[1].split('.')[0]
      skipTable = MANAGED_PROOF_TABLES.has(root)
    }

    if (!sawTable) {
      const assignment = line.match(/^\s*([\w-]+)\s*=/)
      if (assignment && RETIRED_PROOF_TOP_LEVEL_KEYS.has(assignment[1])) continue
    }

    if (!skipTable) kept.push(line)
  }

  return kept.join('\n').trimEnd()
}

function renderManagedProofBlock(proofConfig: toml.JsonMap): string {
  return `${WITHDRAWAL_PROOF_BEGIN}\n${toml.stringify(proofConfig).trimEnd()}\n${WITHDRAWAL_PROOF_END}`
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
  /** Seeded only where the operator has not set the key (existing wins). */
  defaults?: toml.JsonMap
  /** Table/key paths to remove after the merge (e.g. a retired blob provider). */
  deletePaths?: string[][]
}

/**
 * Merge deployment facts into the CLI-owned deployment block.
 *
 * Facts overwrite their keys; every other key inside the block (operator
 * tuning like fee rates or indexer cadence) survives verbatim. The block must
 * be the first content of the file so its top-level scalars stay at TOML
 * document root — a missing block is prepended, and a block that drifted below
 * a hand-maintained table fails closed.
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
  }

  const seeded = deepMergeToml(stripUndefinedDeep(options.defaults || {}), existing)
  const merged = deepMergeToml(seeded, stripUndefinedDeep(facts)) as Record<string, any>
  for (const segments of options.deletePaths || []) deleteTomlPath(merged, segments)

  const block = `${WITHDRAWAL_DEPLOYMENT_BEGIN}\n${toml.stringify(merged as toml.JsonMap).trimEnd()}\n${WITHDRAWAL_DEPLOYMENT_END}`
  const candidate = beginCount === 1
    ? `${head}${block}${tail}`
    : `${block}\n\n${source.replace(/^\n+/, '')}`
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

function asBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

export interface WithdrawalDeploymentFactsInput {
  bridgeAddress: unknown
  dogecoinIndexerStartHeight: number
  dogecoinRpcUrl: unknown
  ethereumDa: {
    beaconRpcUrl?: unknown
    ethChainId: unknown
    expectedBatcherAddress?: unknown
    inboxWorkerStartBlock?: unknown
    l1RpcUrl: unknown
    l2ChainId: unknown
    minFinality?: unknown
    s3?: {
      enabled: boolean
      keyPrefix?: unknown
      publicBaseUrl?: unknown
      timeoutMs?: unknown
      treatForbiddenAsMissing?: unknown
    }
  }
  genesisSequencerTxid: unknown
  genesisSequencerVout: unknown
  initialBridgeRedeemScriptHex: unknown
  l2BootstrapNextStartingBlockHeight?: unknown
  l2MessageQueueAddress: unknown
  l2MessengerAddress: unknown
  l2RpcUrl: unknown
  networkStr: unknown
  tsoUrl?: unknown
}

export interface WithdrawalDeploymentFacts {
  /** Curated starting values seeded only where the operator has not set a key. */
  defaults: toml.JsonMap
  deletePaths: string[][]
  /** Deployment facts re-asserted on every prep-charts run. */
  facts: toml.JsonMap
}

/**
 * Split the deployment configuration prep-charts computes into facts (derived
 * from config.toml / doge-config; overwrite the operator on every run) and
 * curated defaults (seeded once; operator tuning inside the managed block
 * survives subsequent runs).
 */
export function buildWithdrawalDeploymentFacts(input: WithdrawalDeploymentFactsInput): WithdrawalDeploymentFacts {
  const {s3} = input.ethereumDa
  const s3Enabled = s3?.enabled === true && nonEmpty(s3.publicBaseUrl) !== undefined
  const expectedBatcher = nonEmpty(input.ethereumDa.expectedBatcherAddress)
  const inboxStartBlock = asInteger(input.ethereumDa.inboxWorkerStartBlock, 'defaults.ethereumDaEmbeddedIndexerStartBlock')
  const beaconRpcUrl = nonEmpty(input.ethereumDa.beaconRpcUrl)
  const facts = {
    bridge_address: nonEmpty(input.bridgeAddress),
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
            timeout_ms: asInteger(s3?.timeoutMs, 'ethereumDa.blobArchive.s3.timeoutMs'),
            treat_forbidden_as_missing: asBoolean(s3?.treatForbiddenAsMissing),
            url: nonEmpty(s3?.publicBaseUrl),
          },
        } : {}),
        ...(beaconRpcUrl ? { beacon_node: { url: beaconRpcUrl } } : {}),
      },
      eth_chain_id: asInteger(input.ethereumDa.ethChainId, 'ethereumDa.chainId'),
      ...(inboxStartBlock === undefined && expectedBatcher === undefined ? {} : {
        inbox_worker: {
          ...(expectedBatcher ? { expected_batchers: [expectedBatcher] } : {}),
          start_block: inboxStartBlock,
        },
      }),
      l1_rpc_url: nonEmpty(input.ethereumDa.l1RpcUrl),
      l2_chain_id: asInteger(input.ethereumDa.l2ChainId, 'general.CHAIN_ID_L2'),
      min_finality: nonEmpty(input.ethereumDa.minFinality),
    },
    genesis_sequencer_txid: nonEmpty(input.genesisSequencerTxid),
    genesis_sequencer_vout: asInteger(input.genesisSequencerVout, 'withdrawalProcessor.genesis_sequencer_vout'),
    initial_bridge_redeem_script_hex: nonEmpty(input.initialBridgeRedeemScriptHex),
    l2_bootstrap_next_starting_block_height: asInteger(
      input.l2BootstrapNextStartingBlockHeight,
      'defaults.l2BootstrapNextStartingBlockHeight'
    ),
    network_str: nonEmpty(input.networkStr),
    // Deployment-mode gates pinned by the SDK for the current proof gate.
    rotate_sequencer_signer_v2: false,
    tso_url: nonEmpty(input.tsoUrl) || 'http://tso-service:3000',
    wf_withdrawal_parity_v1: true,
  } as unknown as toml.JsonMap

  const defaults = {
    advance_l1_builder_v2: false,
    advance_l2_builder_v2: true,
    api_port: 3000,
    cleanup_timeout_secs: 3600,
    database_url: 'sqlite:///app/data/withdrawal_processor.sqlite',
    debug_skip_broadcast: false,
    debug_skip_tso_polling: false,
    dogecoin_indexer: { confirmations: 6, poll_interval_ms: 1000 },
    dogeos_indexer: { confirmations: 12, log_query_batch_size: 10_000, poll_interval_ms: 1000, start_block: 0 },
    ethereum_da: {
      artifact_metadata_sqlite_path: '/app/data/eth-da-artifact-metadata.sqlite',
      artifact_store_root: '/app/data/eth-da-blob-artifacts',
      blob_source: { timeout_ms: 10_000 },
      inbox_worker: {
        cursor_id: 'eth_da_inbox',
        enabled: true,
        finalized_depth: 64,
        ingest_depth: 1,
        max_blocks_per_cycle: 64,
        poll_interval_ms: 6000,
        rollback_lookback: 128,
        safe_depth: 32,
        status_poll_interval_ms: 5000,
        writer_id: 'withdrawal-processor',
      },
      indexer_sqlite_path: '/app/data/eth-da-indexer.sqlite',
    },
    fee_rate_sat_per_kvb: 1_000_000,
    leaf_verification_required: false,
    max_deposits_per_advance_l1: 32,
    max_withdrawal_outputs_per_tx: 256,
    protocol_context_json: '/app/protocol_context.json',
    replay_sqlite_path: '/app/data/replay.sqlite',
    require_change_tracking: false,
    rotate_key_v2: false,
    strict_l1_validation: false,
    strict_l2_validation: false,
    tso_timeout_minutes: 30,
    utxo_manager_intermediate: {
      allow_inflight_bridge_outputs: true,
      bridge_min_confirmations: 10,
      bridge_strategy: {
        band: {
          balance_band_ratio: 0.1,
          floor_absolute_sats: 1_000_000,
          max_balance_additions: 3,
          sweep_floor_ratio: 0.5,
          target_active_utxos: 100,
          target_size_ratio: 1,
        },
        dust_floor_sats: 1_000_000,
        max_inputs: 60,
        strategy: 'band',
      },
      high_thresh_sats: 10_000_000_000,
      prefer_inflight_bridge_outputs: false,
    },
  } as unknown as toml.JsonMap

  return {
    defaults,
    deletePaths: s3Enabled ? [] : [['ethereum_da', 'blob_source', 'aws_s3']],
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

/** Replace or adopt the CLI-owned proof block without rewriting unrelated TOML. */
export function replaceWithdrawalManagedProofBlock(
  source: string,
  proofConfig: toml.JsonMap
): string {
  parseToml(source, 'existing config')
  const beginCount = markerCount(source, WITHDRAWAL_PROOF_BEGIN)
  const endCount = markerCount(source, WITHDRAWAL_PROOF_END)
  if (beginCount !== endCount || beginCount > 1) {
    throw new Error(
      `WithdrawalProcessor TOML must contain either zero or one ${WITHDRAWAL_PROOF_BEGIN} / ${WITHDRAWAL_PROOF_END} block`
    )
  }

  const managed = renderManagedProofBlock(proofConfig)
  let candidate: string
  if (beginCount === 1) {
    const begin = source.indexOf(WITHDRAWAL_PROOF_BEGIN)
    const end = source.indexOf(WITHDRAWAL_PROOF_END)
    if (end < begin) throw new Error(`WithdrawalProcessor TOML has ${WITHDRAWAL_PROOF_END} before its begin marker`)
    candidate = `${source.slice(0, begin)}${managed}${source.slice(end + WITHDRAWAL_PROOF_END.length)}`
  } else {
    const unmanaged = stripUnmarkedManagedProofTables(source)
    candidate = `${unmanaged}${unmanaged ? '\n\n' : ''}${managed}\n`
  }

  parseToml(candidate, 'generated config')
  return candidate.endsWith('\n') ? candidate : `${candidate}\n`
}

/**
 * Ensure the chart consumes the application TOML at the canonical path: the
 * --config arg, the config ConfigMap toggle, and its mount. Does not touch the
 * TOML content itself — in native-file mode the content arrives via helm
 * --set-file rather than inline values.
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
}

/**
 * Drop an inline embedded TOML from values (native-file mode: helm --set-file
 * supplies the ConfigMap key, and a stale inline copy would shadow-confuse).
 * Returns the removed source only so callers can report that migration; it is
 * never used to create or seed the required native template.
 */
export function removeInlineWithdrawalConfig(values: Record<string, any>): string | undefined {
  const existing = values.configMaps?.config?.data?.[WITHDRAWAL_CONFIG_FILE]
  if (existing === undefined) return undefined
  if (typeof existing !== 'string') {
    throw new TypeError(`withdrawal-processor values: configMaps.config.data.${WITHDRAWAL_CONFIG_FILE} must be a string`)
  }

  delete values.configMaps.config.data[WITHDRAWAL_CONFIG_FILE]
  if (Object.keys(values.configMaps.config.data).length === 0) delete values.configMaps.config.data
  return existing
}

/**
 * Atomically project CLI-owned proof-system activation state into explicit Rust
 * env. The generic chart only renders these values and has no knowledge of
 * proof modes. exact_mock is present only for active mock mode; proof-work API
 * topology remains wholly in native TOML so Figment never replaces that table
 * with an incomplete environment projection.
 */
export function ensureWithdrawalProofActivationSwitch(
  values: Record<string, any>,
  proofSystemMode: ProofSystemMode = 'disabled'
): boolean {
  values.withdrawalProof ||= {}
  values.env ||= []
  if (!Array.isArray(values.env)) throw new TypeError('withdrawal-processor values: env must be an array')
  const before = JSON.stringify([values.withdrawalProof, values.env])

  const enabled = proofSystemMode !== 'disabled'
  values.withdrawalProof.enabled = enabled
  values.withdrawalProof.mode = proofSystemMode
  if (enabled) values.withdrawalProof.provingMode = proofSystemMode
  else delete values.withdrawalProof.provingMode
  const unmanagedEnv = values.env.filter(
    (item: any) => !isWithdrawalProofActivationEnv(String(item?.name || ''))
  )
  const activationEnv: Array<{ name: string; value: string }> = [
    {
      name: WITHDRAWAL_PROOF_ACTIVATION_ENV.mode,
      value: enabled ? (proofSystemMode === 'mock' ? 'dev_dummy' : 'production') : 'disabled',
    },
    {
      name: WITHDRAWAL_PROOF_ACTIVATION_ENV.requireScroll,
      value: enabled ? 'true' : 'false',
    },
    {
      name: WITHDRAWAL_PROOF_ACTIVATION_ENV.requireBridge,
      value: enabled ? 'true' : 'false',
    },
  ]
  if (proofSystemMode === 'mock') {
    activationEnv.push({
      name: WITHDRAWAL_PROOF_ACTIVATION_ENV.devDummyScrollInput,
      value: 'exact_mock',
    })
  }

  values.env = [...unmanagedEnv, ...activationEnv]

  return before !== JSON.stringify([values.withdrawalProof, values.env])
}

export function isWithdrawalProofActivationEnv(name: string): boolean {
  return name === RETIRED_WITHDRAWAL_PROOF_API_ENABLED_ENV
    || Object.values(WITHDRAWAL_PROOF_ACTIVATION_ENV).includes(
      name as typeof WITHDRAWAL_PROOF_ACTIVATION_ENV[keyof typeof WITHDRAWAL_PROOF_ACTIVATION_ENV]
    )
}
