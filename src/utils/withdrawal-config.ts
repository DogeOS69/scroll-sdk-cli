/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and embedded TOML are dynamic documents. */

import * as toml from '@iarna/toml'

export const WITHDRAWAL_CONFIG_FILE = 'WithdrawalProcessor.toml'
export const WITHDRAWAL_CONFIG_PATH = `/app/config/${WITHDRAWAL_CONFIG_FILE}`
export const WITHDRAWAL_PROOF_BEGIN = '# BEGIN scrollsdk managed proof configuration'
export const WITHDRAWAL_PROOF_END = '# END scrollsdk managed proof configuration'
export const WITHDRAWAL_PROOF_ACTIVATION_ENV = {
  apiEnabled: 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__ENABLED',
  mode: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE',
  requireBridge: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_BRIDGE_STATE',
  requireScroll: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_SCROLL_EXECUTION',
} as const

const WITHDRAWAL_PROOF_ACTIVATION_VALUES: Record<string, string> = {
  [WITHDRAWAL_PROOF_ACTIVATION_ENV.apiEnabled]: '{{ ternary "true" "false" .Values.withdrawalProof.enabled }}',
  [WITHDRAWAL_PROOF_ACTIVATION_ENV.mode]: '{{ ternary "production" "disabled" .Values.withdrawalProof.enabled }}',
  [WITHDRAWAL_PROOF_ACTIVATION_ENV.requireBridge]: '{{ ternary "true" "false" .Values.withdrawalProof.enabled }}',
  [WITHDRAWAL_PROOF_ACTIVATION_ENV.requireScroll]: '{{ ternary "true" "false" .Values.withdrawalProof.enabled }}',
}

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

export function defaultWithdrawalConfigToml(): string {
  return `${renderManagedProofBlock({
    proof_system: {
      mode: 'disabled',
      require_bridge_state: false,
      require_scroll_execution: false,
    },
  })}\n`
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

/** Ensure the common chart mounts the embedded application TOML at the canonical path. */
export function ensureWithdrawalConfigValues(values: Record<string, any>): string {
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
  values.configMaps.config.data ||= {}
  const existing = values.configMaps.config.data[WITHDRAWAL_CONFIG_FILE]
  if (existing !== undefined && typeof existing !== 'string') {
    throw new TypeError(`withdrawal-processor values: configMaps.config.data.${WITHDRAWAL_CONFIG_FILE} must be a string`)
  }

  values.configMaps.config.data[WITHDRAWAL_CONFIG_FILE] = existing || defaultWithdrawalConfigToml()

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

  return values.configMaps.config.data[WITHDRAWAL_CONFIG_FILE]
}

export function setWithdrawalConfigToml(values: Record<string, any>, source: string): void {
  ensureWithdrawalConfigValues(values)
  parseToml(source, 'generated config')
  values.configMaps.config.data[WITHDRAWAL_CONFIG_FILE] = source.endsWith('\n') ? source : `${source}\n`
}

/**
 * Project the single operator-facing Helm switch into the four Rust activation
 * fields that must change atomically. Deep proof topology remains TOML-owned.
 */
export function ensureWithdrawalProofActivationSwitch(values: Record<string, any>): boolean {
  let changed = false
  values.withdrawalProof ||= {}
  if (values.withdrawalProof.enabled === undefined) {
    values.withdrawalProof.enabled = false
    changed = true
  }

  if (typeof values.withdrawalProof.enabled !== 'boolean') {
    throw new TypeError('withdrawal-processor values: withdrawalProof.enabled must be a boolean')
  }

  values.env ||= []
  if (!Array.isArray(values.env)) throw new TypeError('withdrawal-processor values: env must be an array')
  for (const [name, value] of Object.entries(WITHDRAWAL_PROOF_ACTIVATION_VALUES)) {
    const existing = values.env.find((item: any) => item?.name === name)
    if (existing) {
      if (existing.value !== value || existing.valueFrom !== undefined) changed = true
      existing.value = value
      delete existing.valueFrom
    } else {
      values.env.push({ name, value })
      changed = true
    }
  }

  return changed
}

export function isWithdrawalProofActivationEnv(name: string): boolean {
  return Object.values(WITHDRAWAL_PROOF_ACTIVATION_ENV).includes(
    name as typeof WITHDRAWAL_PROOF_ACTIVATION_ENV[keyof typeof WITHDRAWAL_PROOF_ACTIVATION_ENV]
  )
}
