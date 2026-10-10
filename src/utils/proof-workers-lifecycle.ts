import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {WorkerCapacityPlan} from './proof-workers-plan.js'

import {digest, localPath, writeJson} from './preparation-io.js'

export type CapacityExec = (args: string[], input?: string) => string
export interface CapacityState {planId: string; startedAt: number; status: 'applying' | 'cleanup-requested' | 'destroyed' | 'submitted'}
const PYTHON = '/root/.local/share/uv/tools/dstack/bin/python'
const adapter = () => fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/proof-workers-controller.py'), 'utf8')

export function capacityExec(args: string[], input?: string): string {
  const result = spawnSync('kubectl', args, {encoding: 'utf8', input, maxBuffer: 8 * 1024 * 1024, timeout: 180_000})
  // kubectl/API errors can contain command stdin, environment or provider secrets.
  if (result.error || result.status !== 0) throw new Error('Worker Kubernetes/controller operation failed; run proof-workers status before retrying (remote details omitted)')
  return result.stdout
}

function kubectl(plan: WorkerCapacityPlan): string[] {return ['--context', plan.target.context, '--namespace', plan.target.namespace]}

export function watchdogManifest(plan: WorkerCapacityPlan, startedAt: number): Record<string, unknown> {
  const name = `sdk-worker-guard-${plan.id.slice(0, 16)}`
  return {apiVersion: 'batch/v1', kind: 'Job', metadata: {labels: {'scrollsdk-plan': plan.id.slice(0, 32)}, name}, spec: {
    backoffLimit: 100, template: {metadata: {labels: {'scrollsdk-plan': plan.id.slice(0, 32)}}, spec: {
      automountServiceAccountToken: false, containers: [{command: [PYTHON, '-c', adapter()], env: [{name: 'DSTACK_SERVER_ADMIN_TOKEN', valueFrom: {secretKeyRef: {key: plan.target.authKey, name: plan.target.authSecret}}},
          {name: 'SCROLLSDK_DSTACK_URL', value: `http://${plan.target.deployment}:${plan.target.port}`},
          {name: 'SCROLLSDK_GUARD_PAYLOAD', value: JSON.stringify({action: 'guard', plan, startedAt})}], image: plan.target.image,
        name: 'watchdog',
        readinessProbe: {exec: {command: [PYTHON, '-c', 'import pathlib; assert pathlib.Path("/tmp/scrollsdk-watchdog-ready").exists()']}, periodSeconds: 2},
        resources: {limits: {cpu: '250m', memory: '512Mi'}, requests: {cpu: '25m', memory: '128Mi'}},
      }],
      restartPolicy: 'OnFailure',
    }},
    ttlSecondsAfterFinished: 86_400,
  }}
}

function remote(plan: WorkerCapacityPlan, action: string, run: CapacityExec, extra: Record<string, unknown> = {}): {workers: Array<{fleet: string; run: string}>} {
  const result = run([...kubectl(plan), 'exec', '-i', `deployment/${plan.target.deployment}`, '-c', 'controller', '--', PYTHON, '-c', adapter()], JSON.stringify({action, plan, ...extra}))
  return JSON.parse(result)
}

export function readCapacityPlan(root: string): WorkerCapacityPlan {
  const file = localPath(root, '.scrollsdk/proof-workers/plan.json')
  if (digest(fs.readFileSync(file)) !== fs.readFileSync(localPath(root, '.scrollsdk/proof-workers/plan.sha256'), 'utf8').trim()) throw new Error('Capacity plan checksum mismatch; do not edit a reviewed plan')
  const plan = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkerCapacityPlan
  if (plan.schema !== 'scrollsdk/proof-workers/v1' || !/^[\da-f]{64}$/.test(plan.id)) throw new Error('Invalid worker capacity plan')
  return plan
}

function operateWorkerCapacityUnlocked(root: string, action: 'apply' | 'destroy' | 'status', run: CapacityExec = capacityExec, now = Date.now() / 1000): unknown {
  const plan = readCapacityPlan(root)
  const stateFile = localPath(root, '.scrollsdk/proof-workers/state.json')
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) as CapacityState : undefined
  if (state && state.planId !== plan.id) throw new Error('Capacity state does not match the reviewed plan')
  if (action === 'status') {
    const status = remote(plan, 'status', run)
    const guardRaw = run([...kubectl(plan), 'get', 'job', `sdk-worker-guard-${plan.id.slice(0, 16)}`, '--ignore-not-found', '-o', 'json'])
    const guard = guardRaw.trim() ? JSON.parse(guardRaw) as {status?: {active?: number; failed?: number; succeeded?: number}} : undefined
    const watchdog = {active: guard?.status?.active ?? 0, failed: guard?.status?.failed ?? 0, present: Boolean(guard), succeeded: guard?.status?.succeeded ?? 0}
    return {...status, localState: state?.status ?? 'planned', rentalEnvelopeUsd: plan.rentalEnvelopeUsd, watchdog,
      ...(state ? {cleanupDeadline: new Date((state.startedAt + plan.wallTimeoutSeconds) * 1000).toISOString()} : {})}
  }

  if (action === 'destroy') {
    state = {...state, planId: plan.id, startedAt: state?.startedAt ?? now, status: 'cleanup-requested'}
    writeJson(stateFile, state)
    const result = remote(plan, 'destroy', run)
    const gone = result.workers.length === plan.workers.length && result.workers.every(w => ['aborted', 'absent', 'done', 'failed', 'stopped', 'terminated'].includes(w.run) && ['absent', 'terminated'].includes(w.fleet))
    if (gone) {state.status = 'destroyed'; writeJson(stateFile, state)}
    return {...result, message: gone ? 'Controller confirms no active owned fleet; verify provider billing separately' : 'Deletion requested; rerun status/destroy until fleets are terminated. Watchdog remains active.', status: state.status}
  }

  if (state && ['cleanup-requested', 'destroyed'].includes(state.status)) throw new Error('This session is being retired; apply never restarts it')
  if (state && now >= state.startedAt + plan.config.startupTimeoutMinutes * 60) throw new Error('Session submission window has expired; inspect status, destroy and plan a new session')
  if (!state) {
    state = {planId: plan.id, startedAt: now, status: 'applying'}
    writeJson(stateFile, state)
  }

  const guard = watchdogManifest(plan, state.startedAt)
  run([...kubectl(plan), 'apply', '-f', '-'], JSON.stringify(guard))
  run([...kubectl(plan), 'wait', '--for=jsonpath={.status.active}=1', `job/sdk-worker-guard-${plan.id.slice(0, 16)}`, '--timeout=90s'])
  run([...kubectl(plan), 'wait', '--for=condition=Ready', 'pod', '-l', `job-name=sdk-worker-guard-${plan.id.slice(0, 16)}`, '--timeout=90s'])
  const token = fs.readFileSync(localPath(root, plan.tokenFile), 'utf8').trim()
  if (!token || /\s/.test(token)) throw new Error('Hydrate the Worker token with setup proof-worker before applying capacity')
  const result = remote(plan, 'apply', run, {startedAt: state.startedAt, token})
  state.status = 'submitted'
  writeJson(stateFile, state)
  return {...result, message: 'GPU submission accepted; use status and coordinator evidence to verify actual proof work', status: 'submitted'}
}

export function retireCapacitySession(root: string, newSession?: string): void {
  const directory = localPath(root, '.scrollsdk/proof-workers')
  if (!fs.existsSync(directory)) return
  if (newSession && readCapacityPlan(root).session === newSession) throw new Error('Choose a different session name; retired resources must not be reused')
  const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8')) as CapacityState
  if (state.status !== 'destroyed') throw new Error('Destroy and confirm the previous session before starting a new session')
  fs.renameSync(directory, localPath(root, `.scrollsdk/proof-workers-${state.planId.slice(0, 16)}`))
}

export function operateWorkerCapacity(root: string, action: 'apply' | 'destroy' | 'status', run: CapacityExec = capacityExec, now = Date.now() / 1000): unknown {
  if (action === 'status') return operateWorkerCapacityUnlocked(root, action, run, now)
  const lock = localPath(root, '.scrollsdk/proof-workers/operation.lock')
  const fd = fs.openSync(lock, 'wx', 0o600)
  try {
    fs.writeSync(fd, String(process.pid))
    return operateWorkerCapacityUnlocked(root, action, run, now)
  } finally {fs.closeSync(fd); fs.unlinkSync(lock)}
}
