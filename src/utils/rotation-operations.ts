/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values are operator-owned dynamic documents. */
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {RotateKeyIntent, RotationCluster} from './rotation-cluster.js'
import type {RotateKeyStatus, RotationExport} from './rotation-export.js'

import {assertDeploymentIdentity, assertPredecessor, rotationSigners} from './rotation-export.js'
import {tsoSignerNetwork} from './tso-signer-network.js'

export const WP_VALUES_FILE = 'values/withdrawal-processor-production.yaml'

/** Runs an external tool (helm, make, kubectl); injectable for tests. Throws on failure. */
export type Run = (command: string, args: string[], cwd: string) => string
export const runTool: Run = (command, args, cwd) => execFileSync(command, args, {cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000})

// ---------------------------------------------------------------- register

/**
 * Merge every current and target key into the WP `tsoSigners`, in the chart's
 * field names. Never removes or replaces an entry: an identical entry is a
 * no-op, and a key already registered with another transport key (or the
 * reverse, or another role/delivery/network) is an error.
 */
const REGISTRATION_FIELDS = ['delivery', 'network', 'publicKeyOverride', 'roles', 'signatureMode', 'transportPubkey'].join(',')

export function mergeRotationSigners(existing: unknown, rotation: RotationExport): {added: string[]; signers: any[]} {
  if (!Array.isArray(existing)) throw new Error(`${WP_VALUES_FILE} has no tsoSigners list`)
  const signers = [...existing]
  const network = tsoSignerNetwork(rotation.network)
  const added: string[] = []
  for (const signer of rotationSigners(rotation)) {
    const matches = signers.filter((entry: any) => String(entry?.publicKeyOverride ?? '').toLowerCase() === signer.public_key || String(entry?.transportPubkey ?? '').toLowerCase() === signer.transport_pubkey)
    if (matches.length === 0) {
      signers.push({delivery: 'pull', network, publicKeyOverride: signer.public_key, roles: ['Attestation'], signatureMode: 'ecdsa', transportPubkey: signer.transport_pubkey})
      added.push(signer.public_key)
      continue
    }

    // An existing entry must be exactly the registration this command would add.
    const same = (entry: any) => Object.keys(entry).sort().join(',') === REGISTRATION_FIELDS
      && String(entry.publicKeyOverride).toLowerCase() === signer.public_key && String(entry.transportPubkey).toLowerCase() === signer.transport_pubkey
      && entry.delivery === 'pull' && entry.network === network && entry.signatureMode === 'ecdsa'
      && Array.isArray(entry.roles) && entry.roles.length === 1 && entry.roles[0] === 'Attestation'
    if (matches.length > 1 || !same(matches[0])) throw new Error(`Signer ${signer.label} (${signer.public_key}) conflicts with an existing tsoSigners entry (another transport key, public key, role, network, signature mode or field); nothing was written`)
  }

  return {added, signers}
}

/** The WP chart and version the deployment Makefile installs, so `helm template` renders the same release. */
function wpChart(deploymentDir: string, run: Run): string[] {
  const printed = run('make', ['-s', '--no-print-directory', '--eval=rotation-print-wp-chart: ; @echo $(WITHDRAWAL_PROCESSOR_CHART) $(WITHDRAWAL_PROCESSOR_CHART_VERSION)', 'rotation-print-wp-chart'], deploymentDir).trim().split(/\s+/)
  if (printed.length !== 2 || !printed[0]) throw new Error('Cannot read WITHDRAWAL_PROCESSOR_CHART and its version from the deployment Makefile')
  return [printed[0], '--version', printed[1]]
}

export interface RegisterOptions {cluster: RotationCluster; now?: () => number; rotation: RotationExport; run?: Run; sleep?: (ms: number) => Promise<void>; waitSeconds?: number}
export interface RegisterResult {added: string[]; installed: boolean; registered: true}

export async function registerRotation(options: RegisterOptions): Promise<RegisterResult> {
  const {cluster, rotation} = options
  const run = options.run ?? runTool
  const status = await cluster.wpStatus()
  assertDeploymentIdentity(rotation, status)
  assertPredecessor(rotation, status)
  const file = path.join(cluster.deploymentDir, WP_VALUES_FILE)
  let values: any
  try {values = yaml.load(fs.readFileSync(file, 'utf8'))} catch {throw new Error(`Cannot read ${WP_VALUES_FILE}`)}
  const {added, signers} = mergeRotationSigners(values?.tsoSigners, rotation)
  const wanted = rotationSigners(rotation).map(signer => signer.public_key)
  const live = new Set(status.registered_signer_pubkeys.map(key => key.toLowerCase()))
  // Install when keys were added, or when an earlier install failed after the values were saved.
  const install = added.length > 0 || wanted.some(key => !live.has(key))
  if (install) {
    const merged = yaml.dump({...values, tsoSigners: signers}, {lineWidth: -1, noRefs: true})
    // Render the merged values with the chart's own guards before writing anything.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-register-'))
    try {
      fs.writeFileSync(path.join(scratch, 'values.yaml'), merged, {mode: 0o600})
      try {run('helm', ['template', 'withdrawal-processor', ...wpChart(cluster.deploymentDir, run), '--namespace', cluster.namespace, '--values', path.join(scratch, 'values.yaml')], cluster.deploymentDir)} catch {throw new Error('helm template rejected the merged tsoSigners; nothing was written')}
    } finally {fs.rmSync(scratch, {force: true, recursive: true})}

    if (added.length > 0) {
      const temporary = `${file}.tmp-${process.pid}`
      // eslint-disable-next-line no-bitwise -- keep the values file permissions
      fs.writeFileSync(temporary, merged, {flag: 'wx', mode: fs.statSync(file).mode & 0o777})
      fs.renameSync(temporary, file)
    }

    try {
      run('make', ['install-withdrawal-processor', `KUBE_CONTEXT=${cluster.context}`, `NAMESPACE=${cluster.namespace}`], cluster.deploymentDir)
      run('kubectl', ['--context', cluster.context, '-n', cluster.namespace, 'rollout', 'status', 'statefulset/withdrawal-processor', '--timeout=300s'], cluster.deploymentDir)
    } catch {throw new Error(`The WP install or rollout failed${added.length > 0 ? ` after ${WP_VALUES_FILE} was updated` : ''}; fix it and re-run register, which installs again until the WP reports every key`)}
  }

  // The WP only reports keys the TSO confirmed to it; wait for every export key.
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (ms => new Promise(resolve => {setTimeout(resolve, ms)}))
  const deadline = now() + (options.waitSeconds ?? 300) * 1000
  for (;;) {
    const registered = new Set((await cluster.wpStatus()).registered_signer_pubkeys.map(key => key.toLowerCase()))
    const missing = wanted.filter(key => !registered.has(key))
    if (missing.length === 0) return {added, installed: install, registered: true}
    if (now() >= deadline) throw new Error(`The WP does not report these keys as registered yet: ${missing.join(', ')}`)
    await sleep(5000)
  }
}

// ---------------------------------------------------------------- online

const POLL_METRIC = /^tso_core_signer_last_poll_timestamp_seconds{signer_pubkey="([\dA-Fa-f]+)"}\s+(\S+)\s*$/

/** `tso_core_signer_last_poll_timestamp_seconds{signer_pubkey}` samples, by lowercase key. */
export function parseLastPolls(metrics: string): Map<string, number> {
  const polls = new Map<string, number>()
  for (const line of metrics.split('\n')) {
    const match = POLL_METRIC.exec(line.trim())
    if (match) polls.set(match[1].toLowerCase(), Number(match[2]))
  }

  return polls
}

/** What a passing online check does not prove; printed with every online result. */
export const ONLINE_CHECK_LIMITS = 'Point-in-time: each key made a transport-key-authenticated TSO poll in the last 60 s. It does not prove the signer release, enforce vs observe mode, RPC or key-backend health, that old signers loaded the allowlist entry, or that the new set can sign. If the WP defers dispatch, the handoff happens later without another check.'

export interface OnlineResult {
  current: {fresh: number; required: number}
  passed: boolean
  signers: {fresh: boolean; lastPoll: null | number; publicKey: string; set: 'current' | 'target'}[]
}

/**
 * A key is online when its last authenticated poll is within `now - 60s ..= now + 5s`; a
 * missing sample or one further in the future fails. Pass: every target key, and at least M
 * of the live current attestation keys (members and M from the WP, never the export).
 */
export function onlineCheck(rotation: RotationExport, status: RotateKeyStatus, polls: Map<string, number>, nowSeconds: number): OnlineResult {
  const entry = (publicKey: string, set: 'current' | 'target') => {
    const lastPoll = polls.get(publicKey.toLowerCase()) ?? null
    return {fresh: lastPoll !== null && lastPoll >= nowSeconds - 60 && lastPoll <= nowSeconds + 5, lastPoll, publicKey: publicKey.toLowerCase(), set}
  }

  const current = status.current_attestation.pubkeys.map(key => entry(key, 'current'))
  const target = rotation.target.signers.map(signer => entry(signer.public_key, 'target'))
  const fresh = current.filter(item => item.fresh).length
  return {current: {fresh, required: status.current_attestation.threshold}, passed: target.every(item => item.fresh) && fresh >= status.current_attestation.threshold, signers: [...current, ...target]}
}

export async function checkOnline(cluster: RotationCluster, rotation: RotationExport, status: RotateKeyStatus, now = Date.now): Promise<OnlineResult> {
  return onlineCheck(rotation, status, parseLastPolls(await cluster.tsoMetrics()), Math.floor(now() / 1000))
}

// ---------------------------------------------------------------- send

export const INTENT_EXIT_CODES: Record<string, number> = {bound: 2, completed: 0, failed_terminal: 1, pending: 2, superseded: 1}

/** The stored intent must be this export's request; otherwise the key was reused for another rotation. */
export function assertIntentMatches(rotation: RotationExport, intent: RotateKeyIntent): void {
  const request = rotation.wp_rotate_key_request
  if (intent.payload.new_key_hash.toLowerCase() !== request.new_key_hash || intent.payload.new_bridge_redeem_script_hex.toLowerCase() !== request.new_bridge_redeem_script_hex || intent.payload.grace_wf_txs !== request.grace_wf_txs) throw new Error(`The WP already stores a different rotation under idempotency key ${request.idempotency_key}; do not resubmit`)
}

export type SendOutcome =
  | {exitCode: number; intent: RotateKeyIntent; kind: 'existing'}
  | {kind: 'preview'; response: unknown}
  | {kind: 'proposed'; response: unknown; status: number}

export interface SendOptions {cluster: RotationCluster; now?: () => number; preview: boolean; rotation: RotationExport}

/**
 * Report an existing intent and stop, or, for a new intent, run the predecessor, overlap and
 * online checks and then POST `/build` (preview, non-durable) or `/propose` (durable).
 */
export async function sendRotation(options: SendOptions): Promise<SendOutcome> {
  const {cluster, rotation} = options
  const status = await cluster.wpStatus()
  assertDeploymentIdentity(rotation, status)
  const request = rotation.wp_rotate_key_request
  const intent = await cluster.wpIntent(request.idempotency_key)
  if (intent) {
    // A pending or bound intent is driven by the WP scheduler; re-running only reports.
    assertIntentMatches(rotation, intent)
    return {exitCode: INTENT_EXIT_CODES[intent.status] ?? 1, intent, kind: 'existing'}
  }

  assertPredecessor(rotation, status)
  if (status.deprecating) throw new Error(`A previous rotation is still in its grace window (deprecating ${status.deprecating.key_hash} until WF ${status.deprecating.deprecation_wf_tx_number})`)
  if (status.active_intent) throw new Error(`The WP already has an active rotation intent ${status.active_intent.idempotency_key} (${status.active_intent.status})`)
  const online = await checkOnline(cluster, rotation, status, options.now)
  if (!online.passed) throw new Error(`Online check failed: ${online.current.fresh}/${online.current.required} current and ${online.signers.filter(s => s.set === 'target' && s.fresh).length}/${rotation.target.signers.length} target signers polled in the last 60 s; run bridge rotation online for details`)
  if (options.preview) {
    const response = await cluster.postWp('/build', request)
    if (response.status !== 200) throw new Error(`WP preview (/build) returned HTTP ${response.status}; nothing was stored`)
    return {kind: 'preview', response: response.body}
  }

  let response: {body: unknown; status: number}
  try {
    response = await cluster.postWp('/propose', request)
  } catch {throw new Error('The /propose request failed: the submission may already be stored. Re-run send with the same export; it reports the stored intent instead of resubmitting')}

  if (response.status !== 200 && response.status !== 202) throw new Error(`/propose returned HTTP ${response.status}: the submission may already be stored. Re-run send with the same export; it reports the stored intent instead of resubmitting`)
  return {kind: 'proposed', response: response.body, status: response.status}
}

/** Sibling file of the export, e.g. `rotation-export.send.json`. */
export function besideExport(exportFile: string, suffix: string): string {
  const parsed = path.parse(path.resolve(exportFile))
  return path.join(parsed.dir, `${parsed.name}.${suffix}.json`)
}
