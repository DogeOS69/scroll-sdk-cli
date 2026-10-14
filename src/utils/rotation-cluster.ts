import * as yaml from 'js-yaml'
import {execFileSync, spawn} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {type LivenessOutpoint, type RotateKeyRequest, type RotateKeyStatus, isOutpoint} from './rotation-export.js'
import {WP_VALUES_FILE} from './tso-signer-polls.js'

/** The `/build` and `/propose` body: the export's request plus the operator's liveness outpoint. */
export type RotateKeyIntentRequest = {liveness_outpoint: LivenessOutpoint} & RotateKeyRequest

/** WP `GET /protocol-actions/rotate-key/intents/{key}` (dogeos-core #1535). */
export interface RotateKeyIntent {
  activation_wf_tx_number: null | number
  deprecation_wf_tx_number: null | number
  job_status: null | string
  payload: {grace_wf_txs: number; liveness_outpoint: LivenessOutpoint; new_bridge_redeem_script_hex: string; new_key_hash: string}
  signed_txid: null | string
  status: string
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
    return intent
  }

  async wpStatus(): Promise<RotateKeyStatus> {
    const response = await this.request(this.wpUrl, 'withdrawal-processor-0', `${ROTATE_KEY}/status`)
    if (response.status === 404) throw new Error('The WP rotate-key routes are not enabled (HTTP 404); deploy a WP with rotate_key_v2 and the status routes first')
    const status = wpJson(response, 'status') as RotateKeyStatus
    // A missing field must never read as "no deprecating key" or "no active intent".
    if (!('deprecating' in status) || !('active_intent' in status) || !Array.isArray(status.registered_signer_pubkeys) || !Array.isArray(status.current_attestation?.pubkeys)) throw new Error('WP rotate-key status is missing required fields')
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
