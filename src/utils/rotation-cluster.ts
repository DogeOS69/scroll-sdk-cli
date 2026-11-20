import * as yaml from 'js-yaml'
import {execFileSync, spawn} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {KEY_ROTATION_MAX_GRACE_BLOCKS} from '../constants/deployment.js'
import {type LivenessOutpoint, type RotateKeyRequest, type RotateKeyStatus, isOutpoint} from './rotation-export.js'
import {WP_VALUES_FILE} from './tso-signer-polls.js'

/** The `/build` and `/propose` body: the export's request plus the operator's liveness outpoint. */
export type RotateKeyIntentRequest = {liveness_outpoint: LivenessOutpoint} & RotateKeyRequest

/** The WP's rotate-key intent states (`RotateKeyIntentStatus` in core). */
export type RotateKeyIntentStatus = 'bound' | 'completed' | 'failed_terminal' | 'pending' | 'superseded'
const INTENT_STATUSES: ReadonlySet<string> = new Set<RotateKeyIntentStatus>(['bound', 'completed', 'failed_terminal', 'pending', 'superseded'])
export function isIntentStatus(status: unknown): status is RotateKeyIntentStatus {
  return typeof status === 'string' && INTENT_STATUSES.has(status)
}

/** A grace the WP stores: 1..=260,000 Dogecoin blocks. */
function isStatedGrace(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= KEY_ROTATION_MAX_GRACE_BLOCKS
}

/**
 * A field of a WP response that the deposit-cutoff change added or redefined (a grace in blocks, a
 * cutoff height). A missing one means a WP from before that change; a present but invalid one is
 * reported with its value, since redeploying would not help.
 */
function wpField(value: unknown, valid: (value: unknown) => boolean, field: string): void {
  if (value === undefined) throw new Error(`WP rotate-key ${field} is missing; deploy a WP that reports the deposit cutoff height`)
  if (!valid(value)) throw new Error(`WP rotate-key ${field} is ${JSON.stringify(value)}, outside the range core allows`)
}

/** A Dogecoin block height as core stores it: a u32. */
function isBlockHeight(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xFF_FF_FF_FF
}

/** WP `GET /protocol-actions/rotate-key/intents/{key}` (dogeos-core #1535; deposit cutoff fields #1911). */
export interface RotateKeyIntent {
  activation_wf_tx_number: null | number
  /** The bound deposit cutoff height; null until the intent binds. */
  deposit_cutoff_height: null | number
  job_status: null | string
  payload: {grace_blocks: number; liveness_outpoint: LivenessOutpoint; new_bridge_redeem_script_hex: string; new_key_hash: string}
  signed_txid: null | string
  status: RotateKeyIntentStatus
}

export type Forward = (pod: string, port: number) => Promise<{close: () => void; url: string}>
export interface RotationClusterOptions {
  context?: string
  deploymentDir: string
  /** Injectable HTTP and tunnel boundaries for isolated tests. */
  fetch?: typeof fetch
  forward?: Forward
  namespace?: string
  tsoUrl?: string
  wpUrl?: string
}

const MAX_RESPONSE = 4 * 1024 * 1024
export const ROTATE_KEY = '/protocol-actions/rotate-key'

/**
 * The deployment's WP and TSO, reached over a short-lived loopback port-forward
 * unless explicit loopback/HTTPS URLs are given. Read-only except `postWp`.
 */
export class RotationCluster {
  readonly deploymentDir: string
  readonly namespace: string
  private contextValue?: string
  private readonly fetcher: typeof fetch
  private readonly forward: Forward
  private readonly tsoUrl?: string
  private readonly wpUrl?: string

  constructor(options: RotationClusterOptions) {
    this.deploymentDir = path.resolve(options.deploymentDir)
    const infrastructure = deploymentInfrastructure(this.deploymentDir)
    const aws = (infrastructure.aws ?? {}) as Record<string, unknown>
    this.contextValue = options.context ?? (aws.region && aws.accountId && aws.eksClusterName ? `arn:aws:eks:${aws.region}:${aws.accountId}:cluster/${aws.eksClusterName}` : undefined)
    this.namespace = options.namespace ?? String(infrastructure.namespace ?? 'default')
    this.fetcher = options.fetch ?? fetch
    this.forward = options.forward ?? ((pod, port) => forwardPod(this.context, this.namespace, pod, port))
    this.wpUrl = options.wpUrl ? serviceUrl(options.wpUrl, 'WP') : undefined
    this.tsoUrl = options.tsoUrl ? serviceUrl(options.tsoUrl, 'TSO') : undefined
  }

  /** Resolved only when the cluster is actually used. */
  get context(): string {
    this.contextValue ??= currentKubeContext()
    return this.contextValue
  }

  async postWp(route: '/build' | '/propose', body: RotateKeyIntentRequest): Promise<{body: unknown; status: number}> {
    const response = await this.request(this.wpUrl, 'withdrawal-processor-0', `${ROTATE_KEY}${route}`, {body: JSON.stringify(body), headers: {'content-type': 'application/json'}, method: 'POST'})
    let parsed: unknown
    try {parsed = JSON.parse(response.text)} catch {parsed = undefined}
    return {body: parsed, status: response.status}
  }

  async tsoMetrics(): Promise<string> {
    const response = await this.request(this.tsoUrl, 'tso-service-0', '/metrics')
    if (response.status !== 200) throw new Error(`TSO /metrics returned HTTP ${response.status}`)
    return response.text
  }

  async wpIntent(idempotencyKey: string): Promise<RotateKeyIntent | null> {
    const response = await this.request(this.wpUrl, 'withdrawal-processor-0', `${ROTATE_KEY}/intents/${encodeURIComponent(idempotencyKey)}`)
    if (response.status === 404) return null
    const intent = wpJson(response, 'intent') as RotateKeyIntent
    if (!isOutpoint(intent?.payload?.liveness_outpoint)) throw new Error('WP rotate-key intent has no valid payload.liveness_outpoint')
    if (typeof intent.payload.new_key_hash !== 'string' || typeof intent.payload.new_bridge_redeem_script_hex !== 'string') throw new Error('WP rotate-key intent has no payload.new_key_hash or payload.new_bridge_redeem_script_hex')
    // A WP from before the deposit-cutoff change lacks these; never read that as a different rotation.
    wpField(intent.payload.grace_blocks, isStatedGrace, 'intent payload.grace_blocks')
    wpField(intent.deposit_cutoff_height, value => value === null || isBlockHeight(value), 'intent deposit_cutoff_height')
    if (!isIntentStatus(intent.status)) throw new Error(`WP rotate-key intent has status ${JSON.stringify(intent.status)}, which this CLI does not know; upgrade the CLI before acting on it`)
    // The WP sets the height in the same update that binds the intent.
    if (intent.status === 'bound' && intent.deposit_cutoff_height === null) throw new Error('WP rotate-key intent is bound but reports no deposit_cutoff_height')
    return intent
  }

  async wpStatus(): Promise<RotateKeyStatus> {
    const response = await this.request(this.wpUrl, 'withdrawal-processor-0', `${ROTATE_KEY}/status`)
    if (response.status === 404) throw new Error('The WP rotate-key routes are not enabled (HTTP 404); deploy a WP with [transitions] rotate_key = true and the status routes first')
    const status = wpJson(response, 'status') as RotateKeyStatus
    // A missing field must never read as "no deprecating key" or "no active intent".
    if (!('deprecating' in status) || !('active_intent' in status) || !Array.isArray(status.registered_signer_pubkeys) || !Array.isArray(status.current_attestation?.pubkeys)) throw new Error('WP rotate-key status is missing required fields')
    wpField(status.min_grace_blocks, isStatedGrace, 'status min_grace_blocks')
    if (status.deprecating !== null) wpField(status.deprecating?.deposit_cutoff_height, isBlockHeight, 'status deprecating.deposit_cutoff_height')
    return status
  }

  private async request(base: string | undefined, pod: string, route: string, init: RequestInit = {}): Promise<{status: number; text: string}> {
    const connection = base ? {close() {}, url: base} : await this.forward(pod, 3000)
    try {
      const response = await this.fetcher(`${connection.url}${route}`, {...init, redirect: 'error', signal: AbortSignal.timeout(60_000)})
      return {status: response.status, text: await boundedBody(response)}
    } finally {connection.close()}
  }
}

/** The deployment directory: `--dir` itself, or its `runtime/` or `deployment/` child, holding the WP values. */
export function deploymentDirectory(root: string): string {
  const resolved = path.resolve(root)
  const match = [resolved, path.join(resolved, 'runtime'), path.join(resolved, 'deployment')].find(directory => fs.existsSync(path.join(directory, WP_VALUES_FILE)))
  if (!match) throw new Error('No deployment found: expected values/withdrawal-processor-production.yaml under --dir, --dir/runtime or --dir/deployment')
  return match
}

function wpJson(response: {status: number; text: string}, what: string): unknown {
  if (response.status !== 200) throw new Error(`WP rotate-key ${what} returned HTTP ${response.status}`)
  try {return JSON.parse(response.text)} catch {throw new Error(`WP rotate-key ${what} returned invalid JSON`)}
}

function deploymentInfrastructure(root: string): Record<string, unknown> {
  const file = [root, path.dirname(root)].map(directory => path.join(directory, 'deployment-spec.yaml')).find(candidate => fs.existsSync(candidate))
  if (!file) return {}
  try {
    const spec = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | undefined
    return (spec?.infrastructure ?? {}) as Record<string, unknown>
  } catch {throw new Error('Cannot read deployment spec infrastructure')}
}

/** A short-lived loopback tunnel avoids assuming curl exists in the service image. */
function forwardPod(context: string, namespace: string, pod: string, port: number): Promise<{close: () => void; url: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', ['--context', context, '--namespace', namespace, 'port-forward', '--address=127.0.0.1', `pod/${pod}`, `:${port}`], {stdio: ['ignore', 'pipe', 'pipe']})
    let output = ''
    const close = () => {child.kill('SIGTERM')}
    const fail = () => {clearTimeout(timer); close(); reject(new Error(`Cannot establish a loopback tunnel to ${pod}`))}
    const timer = setTimeout(fail, 30_000)
    child.stderr.resume()
    child.once('error', fail)
    child.once('exit', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-4096)
      const match = output.match(new RegExp(`Forwarding from 127\\.0\\.0\\.1:(\\d+) -> ${port}`))
      if (match) {clearTimeout(timer); child.removeListener('exit', fail); resolve({close, url: `http://127.0.0.1:${match[1]}`})}
    })
  })
}

function currentKubeContext(): string {
  try {return execFileSync('kubectl', ['config', 'current-context'], {encoding: 'utf8', maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000}).trim()} catch {throw new Error('Cannot resolve Kubernetes context; pass --context')}
}

function serviceUrl(value: string, label: string): string {
  let url: URL
  try {url = new URL(value)} catch {throw new Error(`Invalid ${label} URL`)}
  const localHttp = url.protocol === 'http:' && ['[::1]', '127.0.0.1', 'localhost'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !localHttp)) throw new Error(`${label} URL must be HTTPS or loopback HTTP without credentials, query, or path`)
  return url.origin
}

async function boundedBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      length += value.length
      if (length > MAX_RESPONSE) throw new Error('HTTP response exceeds limit')
      chunks.push(value)
    }

    return Buffer.concat(chunks).toString('utf8')
  } finally {await reader.cancel()}
}
