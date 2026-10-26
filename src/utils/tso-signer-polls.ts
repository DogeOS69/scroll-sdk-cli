/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values are operator-owned dynamic documents. */
import * as yaml from 'js-yaml'
import {spawn} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * TSO pull-signer liveness, read from `tso_core_signer_last_poll_timestamp_seconds{signer_pubkey}`.
 * The TSO sets it only after a poll authenticated by that key's transport key.
 */
const POLL_METRIC = /^tso_core_signer_last_poll_timestamp_seconds{signer_pubkey="([\dA-Fa-f]+)"}\s+(\S+)\s*$/
export const WP_VALUES_FILE = 'values/withdrawal-processor-production.yaml'

/** Every sample, by lowercase public key. */
export function parseLastPolls(metrics: string): Map<string, number> {
  const polls = new Map<string, number>()
  for (const line of metrics.split('\n')) {
    const match = POLL_METRIC.exec(line.trim())
    if (match) polls.set(match[1].toLowerCase(), Number(match[2]))
  }

  return polls
}

/** A poll is fresh within `now - 60 s ..= now + 5 s`; further in the future is clock skew and fails. */
export function isFreshPoll(lastPoll: number | undefined, nowSeconds: number): boolean {
  return lastPoll !== undefined && Number.isFinite(lastPoll) && lastPoll >= nowSeconds - 60 && lastPoll <= nowSeconds + 5
}

/** The Attestation keys registered in the WP `tsoSigners`: the registry the TSO authenticates. */
export function registeredAttestationKeys(deploymentDir: string): string[] {
  let values: any
  try {values = yaml.load(fs.readFileSync(path.join(deploymentDir, WP_VALUES_FILE), 'utf8'))} catch {throw new Error(`Cannot read ${WP_VALUES_FILE}`)}
  if (!Array.isArray(values?.tsoSigners)) throw new Error(`${WP_VALUES_FILE} has no tsoSigners list`)
  // Validate every entry before selecting by role, so a malformed entry is never silently skipped.
  for (const entry of values.tsoSigners) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.roles) || entry.roles.some((role: unknown) => typeof role !== 'string')) throw new Error(`${WP_VALUES_FILE}: a tsoSigners entry has no roles list`)
  }

  const keys = values.tsoSigners.filter((entry: any) => entry.roles.includes('Attestation')).map((entry: any) => {
    const key = String(entry.publicKeyOverride ?? '').toLowerCase()
    if (!/^0[23][\da-f]{64}$/.test(key)) throw new Error(`${WP_VALUES_FILE}: an Attestation entry has no compressed publicKeyOverride`)
    return key
  })
  if (keys.length === 0) throw new Error(`${WP_VALUES_FILE} registers no Attestation signers`)
  return keys
}

export interface SignerLiveness {passed: boolean; signers: {fresh: boolean; lastPoll: null | number; publicKey: string}[]}

/** Every registered key must appear in the TSO metrics with a fresh authenticated poll. */
export function signerLiveness(keys: string[], metrics: string, nowSeconds: number): SignerLiveness {
  const polls = parseLastPolls(metrics)
  const signers = keys.map(publicKey => ({fresh: isFreshPoll(polls.get(publicKey), nowSeconds), lastPoll: polls.get(publicKey) ?? null, publicKey}))
  return {passed: signers.every(signer => signer.fresh), signers}
}

/**
 * The post-rollout acceptance check behind `deployment-preflight --proof-live`: for an
 * enforcing deployment, every registered Attestation signer has a fresh
 * authenticated TSO poll. A failure means liveness, not safety.
 */
export async function liveSignerAcceptance(options: {context?: string; deploymentDir: string; enforcement: string; namespace: string; now: () => number; readMetrics: (target: {context: string; namespace: string}) => Promise<string>}): Promise<SignerLiveness> {
  if (options.enforcement !== 'enforce') throw new Error('--proof-live applies to enforcing deployments; observe and mock deployments have no signer kit')
  if (!options.context) throw new Error('--proof-live requires --kube-context')
  const keys = registeredAttestationKeys(options.deploymentDir)
  const live = signerLiveness(keys, await options.readMetrics({context: options.context, namespace: options.namespace}), Math.floor(options.now() / 1000))
  if (!live.passed) throw new Error(`Not accepted: these registered Attestation signers have no fresh authenticated TSO poll (last 60 s): ${live.signers.filter(signer => !signer.fresh).map(signer => signer.publicKey).join(', ')}. Signing stalls until they poll; nothing is signed incorrectly`)
  return live
}

/** TSO `/metrics` over a short-lived loopback port-forward to `tso-service-0`. */
export async function readTsoMetrics(options: {context: string; namespace: string}): Promise<string> {
  const tunnel = await forwardPod(options.context, options.namespace, 'tso-service-0', 3000)
  try {
    const response = await fetch(`${tunnel.url}/metrics`, {redirect: 'error', signal: AbortSignal.timeout(30_000)})
    if (response.status !== 200) throw new Error(`TSO /metrics returned HTTP ${response.status}`)
    const text = await response.text()
    if (text.length > 4 * 1024 * 1024) throw new Error('TSO /metrics response exceeds limit')
    return text
  } finally {tunnel.close()}
}

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
