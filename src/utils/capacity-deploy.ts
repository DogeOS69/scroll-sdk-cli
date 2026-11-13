/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and dstack config.yml documents. */
import * as yaml from 'js-yaml'
import {execFile, spawn} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {CAPACITY_MANAGER_PLAN, CAPACITY_MANAGER_VALUES, capacitySpec, parseCapacityInput} from './capacity-manager.js'
import {type CapacityRenderOptions, type FleetChanges, type ValueChange, fixedFleetChanges, fleetChanges, formatValueChange, renderCapacity, valueChanges} from './capacity-runtime.js'
import {DSTACK_CREDENTIALS_FILE, dstackSecretRefs, readDstackCredentials} from './dstack-credentials.js'
import {readDstackControllerConfig} from './dstack-database.js'
import {publishDstackSecrets, runSecretKubectl} from './dstack-secret-publisher.js'
import {localPath} from './preparation-io.js'
import {specKubernetesTarget} from './spec-kubernetes-target.js'

const CONTROLLER_VALUES = 'values/dstack-controller-production.yaml'

/** External programs; replaceable in tests. Never return or print Secret data except to the caller. */
export interface CapacityDeployDeps {
  /** Asks the operator after the summary was shown; only called when confirmation is needed and allowed. */
  confirm: () => Promise<boolean>
  /** `helm get values` output as JSON, or undefined when the release does not exist. */
  helmValues: (release: string, context: string, namespace: string) => Promise<any | undefined>
  kubectl: (args: string[]) => Promise<string>
  /** Runs a Makefile target in the deployment directory. */
  make: (target: string, variables: Record<string, string>, cwd: string) => Promise<void>
  /** Uploads the dstack Secrets, as setup push-secrets --dstack-only. */
  publish: typeof publishDstackSecrets
  /** Shows the change summary, before any confirmation or cluster change. */
  show: (lines: string[], summary: CapacityDeploySummary) => void
}

export interface CapacityDeployOptions extends CapacityRenderOptions {
  /** Confirmation is possible (an interactive terminal without --json). */
  interactive: boolean
  /** Kubernetes context; must match the prepared target when one is recorded. */
  kubeContext?: string
  /** Restart the controller even if config.yml did not change, so dstack retries creating its backends. */
  restartController?: boolean
  yes?: boolean
}

export interface CapacityDeploySummary {
  backends: {added: string[]; removed: string[]}
  /** Controller values that differ from the installed release, for example the checksum annotation. */
  controllerChanges: ValueChange[]
  /** The controller restarts: config.yml or its values changed, or --restart-controller. */
  controllerRestart: boolean
  fleets: FleetChanges
  keyRotated: boolean
  /** Last four characters of the Vast.ai key in the running config.yml and in the rendered one, so the operator knows which key is which. */
  keySuffixes?: {after: string; before: string}
  /** Other capacity-manager values that differ from the installed release. */
  managerChanges: ValueChange[]
}

export interface CapacityDeployResult {
  applied: boolean
  context: string
  namespace: string
  notes: string[]
  summary: CapacityDeploySummary
}

/** A failed step, with what state it leaves and what to do next. */
export class CapacityDeployError extends Error {
  constructor(readonly step: string, message: string) {
    super(message)
  }
}

function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {maxBuffer: 64 * 1024 * 1024}, (error, stdout) => {
      // Output is suppressed: it may contain Secret data.
      if (error) reject(new Error(`${command} ${args.slice(0, 3).join(' ')} failed`))
      else resolve(stdout)
    })
  })
}

export const defaultCapacityDeployDeps: Omit<CapacityDeployDeps, 'confirm' | 'show'> = {
  async helmValues(release, context, namespace) {
    const list = await capture('helm', ['list', '--kube-context', context, '--namespace', namespace, '--filter', `^${release}$`, '--output', 'json'])
    if ((JSON.parse(list || '[]') as unknown[]).length === 0) return
    return JSON.parse(await capture('helm', ['get', 'values', release, '--kube-context', context, '--namespace', namespace, '--output', 'json']) || '{}') ?? {}
  },
  kubectl: args => runSecretKubectl(args),
  make: (target, variables, cwd) => new Promise((resolve, reject) => {
    // Progress goes to stderr, so --json keeps stdout for the result.
    const child = spawn('make', [target, ...Object.entries(variables).map(([name, value]) => `${name}=${value}`)], {cwd, stdio: ['ignore', 2, 2]})
    child.on('error', () => reject(new Error('Unable to execute make')))
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`make ${target} exited with ${code}`)))
  }),
  publish: publishDstackSecrets,
}

/** Enough to tell keys apart in the provider console, as cloud consoles do; never the whole key. */
function keySuffix(key: string): string {
  return key.length >= 16 ? `...${key.slice(-4)}` : '(short key)'
}

function backendTypes(config: any): string[] {
  return (config?.projects ?? []).flatMap((project: any) => (project.backends ?? []).map((backend: any) => String(backend.type))).sort()
}

function vastKey(config: any): string | undefined {
  return (config?.projects ?? []).flatMap((project: any) => project.backends ?? []).find((backend: any) => backend.type === 'vastai')?.creds?.api_key
}

const NEW_RELEASE: ValueChange[] = [{path: '(new release)'}]

const CHECKSUM = 'checksum/server-config'

function describeValues(changes: ValueChange[]): string[] {
  // The same change in every proof family is one change for the operator.
  return [...new Set(changes.map(change => change.before === undefined && change.after === undefined ? change.path : formatValueChange({...change, path: change.path.replace(/^policy\.families\.[^.]+\./, 'policy.families.*.')})))].map(line => `      ${line}`)
}

/** Human-readable summary lines. Secret data is never shown: only the Vast.ai key's rotation is reported. */
export function describeCapacityChanges(summary: CapacityDeploySummary, target: string): string[] {
  const lines = [`Changes against the running deployment (${target}):`]
  for (const backend of summary.backends.added) lines.push(`  backend  + ${backend}`)
  for (const backend of summary.backends.removed) lines.push(`  backend  - ${backend}  deleted from the dstack project when the controller restarts`)
  if (summary.keyRotated) lines.push(`  backend  ~ vastai  API key rotated${summary.keySuffixes ? ` (${summary.keySuffixes.before} -> ${summary.keySuffixes.after})` : ''}`)
  // The checksum annotation is how config.yml changes restart the controller; name it as such.
  const controllerChanges = summary.controllerChanges.map(change => change.path === `podAnnotations.${CHECKSUM}` ? {path: 'config.yml checksum annotation (restarts the controller)'} : change)
  if (controllerChanges.length > 0) lines.push('  dstack-controller values:', ...describeValues(controllerChanges))
  if (!hasChanges(summary)) return [...lines, '  nothing']
  lines.push(summary.controllerRestart ? '  dstack-controller restarts; the dstack API is unavailable for about a minute' : '  dstack-controller does not restart')
  for (const fleet of summary.fleets.created) lines.push(`  fleet    + ${fleet}  created with no instances`)
  for (const fleet of summary.fleets.updated) {
    lines.push(fleet.fixed.length > 0 ? `  fleet    ! ${fleet.name}  cannot be updated in place (${fleet.fixed.join(', ')}); needs a new fleet name` : `  fleet    ~ ${fleet.name}  updated in place:`, ...describeValues(fleet.changes))
  }

  for (const fleet of summary.fleets.undeclared) lines.push(`  fleet    ! ${fleet}  no longer declared; stays in dstack until deleted with dstack tooling`)
  if (summary.managerChanges.length > 0) lines.push('  capacity-manager settings:', ...describeValues(summary.managerChanges))
  return lines
}

function hasChanges(summary: CapacityDeploySummary): boolean {
  return summary.controllerRestart || summary.managerChanges.length > 0 || summary.backends.added.length + summary.backends.removed.length > 0
    || summary.fleets.created.length + summary.fleets.updated.length > 0 || summary.keyRotated
}

/** Files and directories render writes, relative to the deployment directory. */
const RENDERED = [DSTACK_CREDENTIALS_FILE, 'Makefile', 'secrets', 'values', '.scrollsdk/capacity-manager']

function renderedFiles(root: string): string[] {
  const walk = (file: string): string[] => {
    if (!fs.existsSync(file)) return []
    const stat = fs.lstatSync(file)
    if (stat.isDirectory()) return fs.readdirSync(file).flatMap(entry => walk(path.join(file, entry)))
    return stat.isFile() ? [file] : []
  }

  return RENDERED.flatMap(relative => walk(localPath(root, relative)))
}

/** Saves the files render writes; the returned function puts them back, for a deployment that stops before the cluster. */
function keepRenderedFiles(root: string): () => void {
  const saved = new Map(renderedFiles(root).map(file => [file, {data: fs.readFileSync(file), mode: fs.statSync(file).mode % 0o1000}]))
  return () => {
    for (const file of renderedFiles(root)) if (!saved.has(file)) fs.rmSync(file)
    for (const [file, {data, mode}] of saved) {
      if (fs.existsSync(file) && fs.readFileSync(file).equals(data)) continue
      fs.writeFileSync(file, data, {mode})
      fs.chmodSync(file, mode)
    }
  }
}

/**
 * Render capacity.yaml, show what changes against the running deployment, and after confirmation upload the
 * dstack Secrets, upgrade the controller (restarting it when config.yml changed) and upgrade the capacity
 * manager, whose pre-upgrade hook checks the backends and creates or updates the fleets. Every step can be
 * repeated: after a failure, fix the cause and run it again.
 */
export async function deployCapacity(rootInput: string, options: CapacityDeployOptions, deps: CapacityDeployDeps): Promise<CapacityDeployResult> {
  const root = path.resolve(rootInput)
  const restore = keepRenderedFiles(root)
  const progress = {cluster: false}
  try {
    return await deployRendered(root, options, deps, progress)
  } catch (error) {
    // Once the upload starts, the files describe what is being deployed and stay for the rerun.
    if (!progress.cluster) restore()
    throw error
  }
}

async function deployRendered(root: string, options: CapacityDeployOptions, deps: CapacityDeployDeps, progress: {cluster: boolean}): Promise<CapacityDeployResult> {
  await renderCapacity(root, options)
  const spec = capacitySpec(root)
  const recorded = specKubernetesTarget(spec)
  if (recorded.kubeContext && options.kubeContext && options.kubeContext !== recorded.kubeContext) throw new Error('Kubernetes context differs from the prepared deployment target')
  const context = options.kubeContext ?? recorded.kubeContext
  if (!context) throw new Error('The prepared deployment records no Kubernetes context; pass --kube-context')
  const plan = parseCapacityInput(fs.readFileSync(localPath(root, CAPACITY_MANAGER_PLAN), 'utf8'), 'capacity-manager plan', JSON.parse) as any
  const {namespace} = recorded
  const dstackNamespace: string = plan.dstack?.namespace ?? namespace
  const dstackDeployment: string = plan.dstack?.deployment ?? 'dstack-controller'
  const controller = readDstackControllerConfig(localPath(root, '.data/doge-config.toml'))!
  const state = readDstackCredentials(root)!
  const {server} = dstackSecretRefs(controller, state)
  const nextServer = (yaml.load(fs.readFileSync(localPath(root, path.join('secrets', `${server.name}.yaml`)), 'utf8')) as any).stringData[server.key] as string

  // The running deployment, not the previous render: an earlier render may not have been deployed.
  const liveText = await deps.kubectl(['--context', context, '--namespace', dstackNamespace, '--request-timeout=30s', 'get', 'secret', server.name, '--ignore-not-found', '-o', 'json'])
  const liveServer = liveText.trim() ? Buffer.from(JSON.parse(liveText).data?.[server.key] ?? '', 'base64').toString('utf8') : undefined
  const live = liveServer ? yaml.load(liveServer) : undefined
  const next = yaml.load(nextServer)
  const installed = await deps.helmValues('capacity-manager', context, namespace)
  const installedController = await deps.helmValues('dstack-controller', context, dstackNamespace)
  const controllerValues = yaml.load(fs.readFileSync(localPath(root, CONTROLLER_VALUES), 'utf8')) as any
  // Any controller values change rolls its pod, for example the first checksum annotation on an older deployment.
  const controllerChanges = installedController ? valueChanges(installedController, controllerValues) : NEW_RELEASE
  const values = yaml.load(fs.readFileSync(localPath(root, CAPACITY_MANAGER_VALUES), 'utf8')) as any
  // Fleet changes are reported separately, and the initialization action is chosen by the command, not the operator.
  const strip = (document: any) => {
    const copy = structuredClone(document ?? {})
    if (copy.initialization) {
      delete copy.initialization.fleets
      delete copy.initialization.fleetAction
    }

    return copy
  }

  const liveKey = vastKey(live)
  const nextKey = vastKey(next)
  const summary: CapacityDeploySummary = {
    backends: {added: backendTypes(next).filter(type => !backendTypes(live).includes(type)), removed: backendTypes(live).filter(type => !backendTypes(next).includes(type))},
    controllerChanges,
    controllerRestart: liveServer !== nextServer || controllerChanges.length > 0 || Boolean(options.restartController),
    fleets: fleetChanges(installed?.initialization?.fleets ?? [], values.initialization?.fleets ?? []),
    keyRotated: Boolean(liveKey && nextKey && liveKey !== nextKey),
    ...(liveKey && nextKey && liveKey !== nextKey ? {keySuffixes: {after: keySuffix(nextKey), before: keySuffix(liveKey)}} : {}),
    managerChanges: installed ? valueChanges(strip(installed), strip(values)) : NEW_RELEASE,
  }
  const result: CapacityDeployResult = {applied: false, context, namespace, notes: [], summary}
  if (summary.fleets.undeclared.length > 0) result.notes.push(`Fleets no longer declared stay in dstack: ${summary.fleets.undeclared.join(', ')}. Delete them with dstack tooling when they have no instances (docs/capacity.md, Deleting a fleet).`)
  deps.show(describeCapacityChanges(summary, `${context}/${namespace}`), summary)
  if (!hasChanges(summary)) return result
  const unchanged = 'Nothing changed in the cluster or in the deployment files; capacity.yaml keeps your edits'
  const fixed = fixedFleetChanges(summary.fleets)
  if (fixed) throw new Error(`${fixed}. ${unchanged}`)
  if (!options.yes) {
    if (!options.interactive) throw new Error(`Review the changes (above, or the summary in the --json error context), then rerun with --yes to deploy them (non-interactive runs do not prompt). ${unchanged}`)
    if (!await deps.confirm()) throw new Error(`Deployment cancelled. ${unchanged}`)
  }

  const step = async (name: string, hint: string, action: () => Promise<unknown>) => {
    try {
      await action()
    } catch (error) {
      throw new CapacityDeployError(name, `${name} failed: ${(error as Error).message}. ${hint}`)
    }
  }

  const variables = {KUBE_CONTEXT: context, NAMESPACE: namespace}
  progress.cluster = true
  const previous = process.cwd()
  try {
    // The publisher reads the deployment's relative paths.
    process.chdir(root)
    await step('Uploading the dstack Secrets', 'The controller has not restarted. Fix the cause and rerun scrollsdk capacity deploy.', () => deps.publish({
      config: controller, context, namespace: dstackNamespace, onBackendRemovals() {/* Shown and confirmed above. */}, valuesFile: CONTROLLER_VALUES,
    }))
  } finally {
    process.chdir(previous)
  }

  const logs = `kubectl --context ${context} --namespace ${dstackNamespace} logs deployment/${dstackDeployment}`
  const restartedAt = new Date().toISOString()
  await step('Upgrading dstack-controller', `The previous capacity manager keeps running. Check ${logs}, then rerun scrollsdk capacity deploy.`, async () => {
    await deps.make('install-dstack-controller', variables, root)
    if (options.restartController && liveServer === nextServer && controllerChanges.length === 0) await deps.kubectl(['--context', context, '--namespace', dstackNamespace, 'rollout', 'restart', `deployment/${dstackDeployment}`])
    await deps.kubectl(['--context', context, '--namespace', dstackNamespace, 'rollout', 'status', `deployment/${dstackDeployment}`, '--timeout', '5m'])
  })
  if (summary.controllerRestart) {
    // dstack only logs a backend it cannot create or update (keeping the previous one), so read it from the log.
    const log = await deps.kubectl(['--context', context, '--namespace', dstackNamespace, 'logs', `deployment/${dstackDeployment}`, `--since-time=${restartedAt}`, '--tail=5000'])
    const failed = [...new Set([...log.matchAll(/Failed to (?:create|update) backend (\w+)/g)].map(match => match[1]))].sort()
    if (failed.length > 0) {
      throw new CapacityDeployError('Checking dstack backends', `dstack could not create or update backend ${failed.join(', ')} when it restarted (see "Failed to create backend" or "Failed to update backend" in ${logs}). `
        + 'The previous capacity manager keeps running and no fleet changed; an existing backend keeps its previous credentials. '
        + 'Fix the credentials, then rerun scrollsdk capacity deploy (with --restart-controller if the fix was outside the deployment files).'
        + (summary.keyRotated ? ` Do not revoke any Vast.ai key yet: dstack keeps the key it used before this deployment, not the one ending in ${summary.keySuffixes!.after}.` : ''))
    }
  }

  await step('Upgrading capacity-manager', 'The previous capacity manager keeps running and no fleet changed. If its initialization reported a missing backend, '
    + `dstack could not create it: look for "Failed to create backend" in ${logs}, fix the credentials, then rerun scrollsdk capacity deploy --restart-controller.`
    + (summary.keyRotated ? ' Do not revoke any Vast.ai key yet.' : ''), () => deps.make('install-capacity-manager', variables, root))
  result.applied = true
  if (summary.keyRotated) {
    result.notes.push(`dstack now uses the Vast.ai key ending in ${summary.keySuffixes!.after}. The key ending in ${summary.keySuffixes!.before} is no longer configured; revoke it in Vast.ai unless something else uses it.`)
  }

  return result
}
