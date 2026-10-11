import * as toml from '@iarna/toml'
import {keccak256} from 'ethers'
import * as yaml from 'js-yaml'
import {execFileSync, spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'

import type {RotationChainState} from './bridge-rotation.js'
import type {RotationIntentObservation} from './bridge-rotation-status.js'

import {savedDeploymentEnvFile} from './deployment-paths.js'
import {resolveDogecoinChainId} from './deployment-spec-generator.js'
import {loadPreparationEnv} from './preparation-io.js'

export type {RotationChainState} from './bridge-rotation.js'

type ObjectValue = Record<string, unknown>
type Execute = (args: string[], input?: string) => Promise<string>
export interface RotationRuntimeOptions {
  context?: string
  deploymentDir: string
  /** Injectable process/HTTP boundaries for isolated tests. */
  execute?: Execute
  fetch?: typeof fetch
  forward?: () => Promise<{close: () => void; url: string}>
  namespace?: string
  wpUrl?: string
}

const MAX_RESPONSE = 4 * 1024 * 1024
const WP_PATHS = new Set(['/protocol-actions/rotate-key/build', '/protocol-actions/rotate-key/propose'])
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid rotation runtime document')
  return value as ObjectValue
}

function uint(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 0xFF_FF_FF_FF) throw new Error(`Invalid ${label}`)
  return value
}

function hex(value: unknown, bytes: number): string {
  if (typeof value !== 'string' || !new RegExp(`^(0x)?[0-9a-fA-F]{${bytes * 2}}$`).test(value)) throw new Error('Invalid public hash in rotation runtime')
  return value.replace(/^0x/, '').toLowerCase()
}

function sha256(value: Buffer | string): string {return createHash('sha256').update(value).digest('hex')}

/** Core canonical encoding: BE integers/RPC txid, but consensus-order Dogecoin block hash. */
export function rotationProtocolOpeningId(context: unknown): string {
  const source = object(context)
  const protocol = object(source.protocol)
  const genesis = object(source.genesis)
  const outpoint = object(genesis.genesis_sequencer_outpoint)
  const numeric = (value: unknown, size: number): Buffer => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid protocol context integer')
    const result = Buffer.alloc(size)
    if (size === 8) result.writeBigUInt64BE(BigInt(value))
    else result.writeUIntBE(value, 0, size)
    return result
  }

  const bytes = (value: unknown, count: number): Buffer => Buffer.from(hex(value, count), 'hex')
  return keccak256(Buffer.concat([
    numeric(protocol.protocol_version, 2), numeric(protocol.dogecoin_chain_id, 4), numeric(protocol.l2_chain_id, 4), numeric(protocol.eth_chain_id, 8),
    bytes(outpoint.txid, 32), numeric(outpoint.vout, 4), bytes(genesis.genesis_bridge_key_hash, 20), numeric(genesis.initial_confirmed_block_number, 4),
    bytes(genesis.initial_confirmed_block_hash, 32).reverse(), bytes(genesis.initial_ethereum_block_hash, 32), numeric(genesis.initial_tx_index, 4),
    bytes(genesis.genesis_batch_hash, 32), bytes(genesis.genesis_state_root, 32), bytes(genesis.initial_system_signer, 20),
  ])).slice(2)
}

/** Captures errors privately in memory: never relay kubectl stderr, URLs, or RPC bodies. */
async function executeKubectl(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', args, {stdio: ['pipe', 'pipe', 'pipe']})
    let output = ''
    let failed = false
    const timer = setTimeout(() => {failed = true; child.kill('SIGKILL')}, 65_000)
    child.stdout.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(output) + chunk.length > MAX_RESPONSE) {failed = true; child.kill('SIGKILL')}
      else output += chunk.toString('utf8')
    })
    child.stderr.resume()
    child.stdin.on('error', () => {failed = true})
    child.on('error', () => {clearTimeout(timer); reject(new Error('Rotation Kubernetes operation failed'))})
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failed || code !== 0) reject(new Error('Rotation Kubernetes operation failed; check cluster access and WP tools'))
      else resolve(output)
    })
    child.stdin.end(input)
  })
}

export class BridgeRotationRuntime {
  readonly context: string
  readonly namespace: string
  private readonly config: ObjectValue
  private readonly deploymentDir: string
  private readonly execute: Execute
  private readonly fetcher: typeof fetch
  private readonly forward: () => Promise<{close: () => void; url: string}>
  private readonly wpUrl?: string

  constructor(options: RotationRuntimeOptions) {
    this.deploymentDir = path.resolve(options.deploymentDir)
    this.execute = options.execute ?? executeKubectl
    this.fetcher = options.fetch ?? fetch
    this.forward = options.forward ?? (() => forwardWp(this.context, this.namespace))
    try {this.config = object(toml.parse(fs.readFileSync(path.join(this.deploymentDir, '.data/doge-config.toml'), 'utf8')))} catch {throw new Error('Cannot read deployment Dogecoin configuration')}
    const specPath = [this.deploymentDir, path.dirname(this.deploymentDir)].map((directory) => path.join(directory, 'deployment-spec.yaml')).find((file) => fs.existsSync(file))
    let spec: ObjectValue = {}
    try {if (specPath) spec = object(yaml.load(fs.readFileSync(specPath, 'utf8')))} catch {throw new Error('Cannot read deployment spec infrastructure')}
    const infrastructure = spec.infrastructure ? object(spec.infrastructure) : {}
    const aws = infrastructure.aws ? object(infrastructure.aws) : {}
    const awsContext = aws.region && aws.accountId && aws.eksClusterName ? `arn:aws:eks:${aws.region}:${aws.accountId}:cluster/${aws.eksClusterName}` : undefined
    this.context = options.context ?? awsContext ?? currentKubeContext()
    if (!this.context.trim()) throw new Error('Kubernetes context is required')
    try {loadPreparationEnv(savedDeploymentEnvFile(this.deploymentDir))} catch {throw new Error('Cannot load saved deployment environment')}
    this.namespace = options.namespace ?? String(infrastructure.namespace ?? 'default')
    this.wpUrl = options.wpUrl ? validateWpUrl(options.wpUrl) : undefined
  }

  async post(endpoint: string, body: unknown): Promise<{body: unknown; status: number}> {
    if (!WP_PATHS.has(endpoint)) throw new Error('Unsupported WP rotation endpoint')
    try {
      let text: string
      let status: number
      const connection = this.wpUrl ? {close() {}, url: this.wpUrl} : await this.forward()
      try {
        const response = await this.fetcher(`${connection.url}${endpoint}`, {body: JSON.stringify(body), headers: {'content-type': 'application/json'}, method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000)})
        status = response.status
        text = await boundedBody(response)
      } finally {connection.close()}

      return {body: JSON.parse(text), status}
    } catch {throw new Error('WP rotation request failed or timed out; inspect the saved intent before retrying with the same idempotency key')}
  }

  async readIntent(idempotencyKey: string): Promise<RotationIntentObservation | null> {
    if (!/^[\w.:-]{1,200}$/.test(idempotencyKey)) throw new Error('Invalid rotation idempotency key')
    const rows = await this.sql(`SELECT i.id AS intent_id,i.status,i.new_key_hash_hex,i.new_bridge_redeem_script_hex,i.grace_wf_txs,i.bound_deprecation_wf_tx_number,i.bound_spec_id,j.id AS job_id,j.status AS job_status,j.tso_transaction_id,j.signed_txid,j.built_unsigned_txid,j.replay_prev_wf_tx_number FROM pending_rotate_key_intents i LEFT JOIN protocol_action_jobs j ON j.spec_id=i.bound_spec_id WHERE i.idempotency_key='${idempotencyKey}'`)
    if (rows.length > 1) throw new Error('Ambiguous rotation intent job binding')
    if (rows.length === 0) return null
    const row = rows[0]
    const text = (value: unknown): string => {
      if (typeof value !== 'string' || !/^[\w.:-]{1,200}$/.test(value)) throw new Error('Invalid public intent status field')
      return value
    }

    const optionalText = (source: string, target: string): Record<string, string> => row[source] === null || row[source] === undefined ? {} : {[target]: text(row[source])}
    const script = row.new_bridge_redeem_script_hex
    if (typeof script !== 'string' || !/^(?:[\dA-Fa-f]{2})+$/.test(script) || script.length > 1040) throw new Error('Invalid durable intent bridge script')
    return {
      graceWfTxs: uint(row.grace_wf_txs, 'intent grace WF count'), intentId: text(row.intent_id),
      redeemScriptHex: script.toLowerCase(), status: text(row.status),
      targetKeyHash: `0x${hex(row.new_key_hash_hex, 20)}`,
      ...optionalText('job_id', 'jobId'), ...optionalText('job_status', 'jobStatus'), ...optionalText('tso_transaction_id', 'tsoTransactionId'),
      ...(row.signed_txid ? {signedTxid: hex(row.signed_txid, 32)} : {}),
      ...(row.bound_deprecation_wf_tx_number === null || row.bound_deprecation_wf_tx_number === undefined ? {} : {deprecationWfTxNumber: uint(row.bound_deprecation_wf_tx_number, 'deprecation WF')}),
      ...(row.replay_prev_wf_tx_number === null || row.replay_prev_wf_tx_number === undefined ? {} : {activationWfTxNumber: uint(uint(row.replay_prev_wf_tx_number, 'previous WF') + 1, 'activation WF')}),
    }
  }

  async readState(): Promise<RotationChainState> {
    const localContext = fs.readFileSync(path.join(this.deploymentDir, '.data/protocol_context.json'))
    const mountedContext = await this.execute([...this.podArgs(), 'cat', '/app/protocol_context.json'])
    const context = object(JSON.parse(localContext.toString('utf8')))
    // Helm's block scalar adds a trailing newline; bind semantic protocol fields,
    // not the YAML/JSON serializer's whitespace. Keep the local file digest for
    // the frozen proposal's deployment-material binding.
    if (!isDeepStrictEqual(context, object(JSON.parse(mountedContext)))) throw new Error('WP protocol context differs from the selected deployment')
    const rows = await this.sql('SELECT s.wf_tx_number,s.state_hash,s.state_json,m.protocol_id,m.validated_tip_state_hash FROM dogeos_state_snapshots s JOIN replay_manifest m ON m.id=1 AND s.wf_tx_number=m.validated_up_to WHERE s.is_canonical=1', true)
    if (rows.length !== 1) throw new Error('Replay has no unique validated canonical head')
    const row = rows[0]
    if (hex(row.protocol_id, 32) !== rotationProtocolOpeningId(context)) throw new Error('Replay protocol binding differs from deployment context')
    if (hex(row.state_hash, 32) !== hex(row.validated_tip_state_hash, 32)) throw new Error('Replay head state hash differs from validated manifest')
    const state = object(JSON.parse(String(row.state_json)))
    const wfTxNumber = uint(row.wf_tx_number, 'WF number')
    if (uint(state.wf_tx_number, 'state WF number') !== wfTxNumber) throw new Error('Replay state WF number differs from snapshot')
    const keys = object(state.bridge_keys)
    const currentKeyHash = hex(object(keys.current_key).key_hash, 20)
    const scripts = await this.sql(`SELECT DISTINCT redeem_script_hex FROM wf_bridge_contexts WHERE lower(script_pubkey_hex)='a914${currentKeyHash}87'`)
    if (scripts.length !== 1 || typeof scripts[0].redeem_script_hex !== 'string' || !/^(?:[\dA-Fa-f]{2})+$/.test(scripts[0].redeem_script_hex)) throw new Error('Current bridge script is unavailable or ambiguous; cannot use initial deployment script')
    const redeemScriptHex = scripts[0].redeem_script_hex.toLowerCase()
    const scriptHash = createHash('ripemd160').update(createHash('sha256').update(Buffer.from(redeemScriptHex, 'hex')).digest()).digest('hex')
    if (scriptHash !== currentKeyHash) throw new Error('Current bridge script does not match validated replay key hash')
    const {network} = this.config
    if (network !== 'mainnet' && network !== 'testnet' && network !== 'regtest') throw new Error('Deployment Dogecoin network is missing')
    if (object(context.protocol).dogecoin_chain_id !== resolveDogecoinChainId(network)) throw new Error('Deployment Dogecoin network differs from the bound protocol context')
    const deprecated = keys.deprecating_key ? object(keys.deprecating_key) : undefined
    return {
      confirmedAnchorHeight: uint(object(state.deposit_queue).confirmed_block_number, 'confirmed Dogecoin anchor'),
      currentKeyHash: `0x${currentKeyHash}`,
      ...(deprecated ? {deprecating: {deprecationWfTxNumber: uint(deprecated.deprecation_wf_tx_number, 'deprecation WF'), keyHash: `0x${hex(deprecated.key_hash, 20)}`}} : {}),
      liveTipHeight: await this.liveTip(),
      minGraceWfTxs: uint(object(state.protocol_config).key_rotation_min_grace_wf_txs, 'minimum grace WF count'),
      network, protocolContextSha256: sha256(localContext), redeemScriptHex, wfTxNumber,
    }
  }

  private env(value: unknown): string {
    if (typeof value !== 'string') return ''
    return value.replaceAll(/\$ENV:([A-Z_a-z]\w*)/g, (_match, name: string) => {
      const resolved = process.env[name]
      if (resolved === undefined) throw new Error(`Required environment variable ${name} is missing`)
      return resolved
    })
  }

  private async liveTip(): Promise<number> {
    const rpc = object(this.config.rpc)
    try {
      const url = new URL(this.env(rpc.url))
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid runtime response')
      const username = this.env(rpc.username) || decodeURIComponent(url.username)
      const password = this.env(rpc.password) || decodeURIComponent(url.password)
      url.username = ''; url.password = ''
      const headers: Record<string, string> = {'content-type': 'application/json'}
      if (username || password) headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      const response = await this.fetcher(url, {body: JSON.stringify({id: 'rotation-tip', jsonrpc: '1.0', method: 'getblockcount', params: []}), headers, method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000)})
      if (!response.ok) throw new Error('Invalid runtime response')
      const body = object(JSON.parse(await boundedBody(response)))
      if (body.error) throw new Error('Invalid runtime response')
      return uint(body.result, 'Dogecoin tip')
    } catch {throw new Error('Cannot read Dogecoin tip; verify operator RPC configuration and credentials')}
  }

  private podArgs(): string[] {
    return [...(this.context ? ['--context', this.context] : []), '--namespace', this.namespace, 'exec', '-i', 'withdrawal-processor-0', '-c', 'withdrawal-processor', '--']
  }

  private async sql(query: string, replay = false): Promise<ObjectValue[]> {
    const result = await this.execute([...this.podArgs(), 'sqlite3', '-readonly', '-json', replay ? '/app/data/replay.sqlite' : '/app/data/withdrawal_processor.sqlite', query])
    try {
      const rows: unknown = JSON.parse(result || '[]')
      if (!Array.isArray(rows)) throw new Error('Invalid runtime response')
      return rows.map((row) => object(row))
    } catch {throw new Error('Invalid read-only WP database response')}
  }
}

/** A short-lived loopback tunnel avoids assuming curl exists in the WP image. */
function forwardWp(context: string, namespace: string): Promise<{close: () => void; url: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', ['--context', context, '--namespace', namespace, 'port-forward', '--address=127.0.0.1', 'pod/withdrawal-processor-0', ':3000'], {stdio: ['ignore', 'pipe', 'pipe']})
    let output = ''
    const close = () => {child.kill('SIGTERM')}
    const fail = () => {clearTimeout(timer); close(); reject(new Error('Cannot establish WP loopback tunnel'))}
    const timer = setTimeout(fail, 30_000)
    child.stderr.resume()
    child.once('error', fail)
    child.once('exit', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-4096)
      const match = output.match(/Forwarding from 127\.0\.0\.1:(\d+) -> 3000/)
      if (match) {clearTimeout(timer); resolve({close, url: `http://127.0.0.1:${match[1]}`})}
    })
  })
}

function currentKubeContext(): string {
  try {return execFileSync('kubectl', ['config', 'current-context'], {encoding: 'utf8', maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000}).trim()} catch {throw new Error('Cannot resolve Kubernetes context; select an explicit context')}
}

function validateWpUrl(value: string): string {
  let url: URL
  try {url = new URL(value)} catch {throw new Error('Invalid WP URL')}
  const localHttp = url.protocol === 'http:' && ['[::1]', '127.0.0.1', 'localhost'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !localHttp)) throw new Error('WP URL must be HTTPS or loopback HTTP without credentials, query, or path')
  return url.origin
}

async function boundedBody(response: Response): Promise<string> {
  if (!response.body) throw new Error('Empty HTTP response')
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

export {BridgeRotationRuntime as RotationRuntime}
