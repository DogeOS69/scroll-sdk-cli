/* eslint-disable @typescript-eslint/no-explicit-any -- Kubernetes documents. */
import {spawn, spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {readCapacityDocument} from './capacity-document.js'
import {savedDeploymentEnvFile} from './deployment-paths.js'
import {readDstackCredentials} from './dstack-credentials.js'
import {loadPreparationEnv, localPath} from './preparation-io.js'
import {specKubernetesTarget} from './spec-kubernetes-target.js'
import {specAwsSecretPrefix} from './spec-secret-prefix.js'

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/run.js')
const SECRETS = 'secrets'
const BACKUP = '.scrollsdk/secrets-sync-backup'
/**
 * Signing and node keys are pinned: a running deployment never changes them through a sync.
 * `signer_key` covers the withdrawal processor's fee and sequencer signer keys.
 */
const PINNED_KEY = /private_key|signer_key|nodekey|^priv_key$|^private-key$/i
const ES_RESOURCE = 'externalsecrets.external-secrets.io'

export interface SecretDestination {awsPrefix?: string; awsRegion?: string; provider: 'aws' | 'vault'}

export interface SecretFileChange {
  file: string
  /** Keys whose values changed (names only); `*` for a whole JSON or YAML document. */
  keys: string[]
  /** How the change reaches the cluster. */
  route: 'manual' | 'push'
  /** Secret store name for pushed files. */
  secret?: string
  status: 'added' | 'changed' | 'removed'
}

export interface SecretsSyncResult {
  applied: boolean
  changes: SecretFileChange[]
  externalSecrets: Array<{name: string; secret: string; synced?: boolean; target: string}>
  /** Commands for changes `secrets sync` does not upload itself. */
  manual: string[]
  restarts: string[]
}

export interface SecretsSyncDeps {
  /** Regenerate secrets/ from the deployment inputs (setup gen-secrets). */
  generate: (root: string) => Promise<void>
  /** kubectl with the deployment's context and namespace; never returns error output. */
  kube: (args: string[]) => string
  now: () => Date
  /** Upload one secrets/ file; returns the secret store names written. */
  push: (root: string, file: string, destination: SecretDestination) => Promise<string[]>
  sleep: (ms: number) => Promise<void>
}

type Snapshot = Map<string, Buffer>

function snapshot(root: string): Snapshot {
  const result: Snapshot = new Map()
  const visit = (relative: string): void => {
    const file = localPath(root, relative)
    if (!fs.existsSync(file)) return
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error(`${relative} is a symbolic link; secrets/ must contain regular files`)
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(`${relative}/${name}`)
    else if (stat.isFile()) result.set(relative, fs.readFileSync(file))
  }

  visit(SECRETS)
  return result
}

function restore(root: string, saved: Snapshot): void {
  for (const relative of snapshot(root).keys()) if (!saved.has(relative)) fs.rmSync(localPath(root, relative), {force: true})
  for (const [relative, content] of saved) {
    const file = localPath(root, relative)
    fs.mkdirSync(path.dirname(file), {mode: 0o700, recursive: true})
    fs.writeFileSync(file, content, {mode: 0o600})
    fs.chmodSync(file, 0o600)
  }
}

function writeBackup(root: string, saved: Snapshot): void {
  const directory = localPath(root, BACKUP)
  if (fs.existsSync(directory)) throw new Error(`An earlier secrets sync did not finish: ${BACKUP} holds the secrets/ files from before it. Compare and restore them, then delete that directory`)
  fs.mkdirSync(directory, {mode: 0o700, recursive: true})
  for (const [relative, content] of saved) {
    const file = path.join(directory, relative)
    fs.mkdirSync(path.dirname(file), {mode: 0o700, recursive: true})
    fs.writeFileSync(file, content, {mode: 0o600})
  }
}

function envEntries(content: Buffer): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of content.toString('utf8').split(/\r?\n/)) {
    const entry = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=(.*)$/)
    if (entry) result.set(entry[1], entry[2])
  }

  return result
}

const digest = (content: Buffer | undefined) => content ? createHash('sha256').update(content).digest('hex') : undefined

/** File and key names that changed; never values. */
export function compareSecrets(before: Snapshot, after: Snapshot): SecretFileChange[] {
  const changes: SecretFileChange[] = []
  for (const relative of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(relative)
    const next = after.get(relative)
    if (digest(old) === digest(next)) continue
    const file = relative.slice(SECRETS.length + 1)
    const nested = file.includes('/')
    const status = old === undefined ? 'added' : next === undefined ? 'removed' : 'changed'
    let keys = ['*']
    if (file.endsWith('.env')) {
      const a = old ? envEntries(old) : new Map()
      const b = next ? envEntries(next) : new Map()
      keys = [...new Set([...a.keys(), ...b.keys()])].filter(key => a.get(key) !== b.get(key)).sort()
    }

    const pushable = !nested && !file.startsWith('cubesigner-signer') && (file.endsWith('.env') || file.endsWith('.json'))
    const route = pushable && status !== 'removed' ? 'push' : 'manual'
    changes.push({file, keys, route, ...(route === 'push' ? {secret: file.endsWith('.env') ? `${path.basename(file, '.env')}-env` : path.basename(file, '.json')} : {}), status})
  }

  return changes
}

function savedIntent(root: string): DeploymentSpec {
  const file = localPath(root, '.scrollsdk/intent.json')
  if (!fs.existsSync(file)) throw new Error('No saved deployment intent (.scrollsdk/intent.json); secrets sync needs a deployment prepared with setup plan')
  try {return JSON.parse(fs.readFileSync(file, 'utf8'))} catch {throw new Error('Invalid saved deployment intent (contents omitted)')}
}

/** The prepared Kubernetes target; an explicit context must match a recorded one. */
export function secretsKubeTarget(root: string, context: string, namespace?: string): {context: string; namespace: string} {
  const target = specKubernetesTarget(savedIntent(path.resolve(root)))
  if (target.kubeContext && context !== target.kubeContext) throw new Error('Kubernetes context differs from the prepared deployment target')
  if (namespace && namespace !== target.namespace) throw new Error('Namespace differs from the prepared deployment target')
  return {context, namespace: target.namespace}
}

/** The saved secret store destination, as the upload-secrets stage uses it. */
export function secretDestination(root: string): SecretDestination {
  const spec = savedIntent(path.resolve(root))
  const upload = spec.preparation?.secretUpload ?? (spec.infrastructure.provider === 'aws' ? {provider: 'aws' as const} : undefined)
  if (!upload || !['aws', 'vault'].includes(upload.provider)) throw new Error('The deployment has no AWS or Vault secret store destination (preparation.secretUpload)')
  if (upload.provider === 'vault') return {provider: 'vault'}
  const awsRegion = ('awsRegion' in upload ? upload.awsRegion : undefined) ?? spec.infrastructure.aws?.region
  if (!awsRegion) throw new Error('The deployment has no AWS region for its secret store')
  return {awsPrefix: specAwsSecretPrefix(spec), awsRegion, provider: 'aws'}
}

function remoteKeys(externalSecret: any): string[] {
  return [
    ...(externalSecret.spec?.data ?? []).map((entry: any) => entry?.remoteRef?.key),
    ...(externalSecret.spec?.dataFrom ?? []).map((entry: any) => entry?.extract?.key),
  ].filter((key): key is string => typeof key === 'string')
}

function storeName(destination: SecretDestination, secret: string): string {
  return destination.provider === 'aws' ? `${destination.awsPrefix}/${secret}` : secret
}

function matches(destination: SecretDestination, key: string, secret: string): boolean {
  return destination.provider === 'aws' ? key === storeName(destination, secret) : key === secret || key.endsWith(`/${secret}`)
}

function json(output: string): any {
  try {return JSON.parse(output)} catch {throw new Error('Invalid Kubernetes readback (contents omitted)')}
}

/** Workloads that read one of the target Secrets through env, envFrom or volumes. */
function readers(kube: SecretsSyncDeps['kube'], targets: Set<string>): string[] {
  const list = json(kube(['get', 'deployments,statefulsets,daemonsets', '-o', 'json']))
  const result: string[] = []
  for (const item of list.items ?? []) {
    const spec = item.spec?.template?.spec ?? {}
    const containers = [...(spec.containers ?? []), ...(spec.initContainers ?? [])]
    const names = new Set<string>([
      ...containers.flatMap((container: any) => (container.env ?? []).map((entry: any) => entry.valueFrom?.secretKeyRef?.name)),
      ...containers.flatMap((container: any) => (container.envFrom ?? []).map((entry: any) => entry.secretRef?.name)),
      ...(spec.volumes ?? []).map((volume: any) => volume.secret?.secretName),
      ...(spec.volumes ?? []).flatMap((volume: any) => (volume.projected?.sources ?? []).map((source: any) => source.secret?.name)),
    ].filter(Boolean))
    if ([...names].some(name => targets.has(name))) result.push(`${String(item.kind).toLowerCase()}/${item.metadata.name}`)
  }

  return result.sort()
}

/**
 * dstack provider keys reach the controller through capacity.yaml and its controller credential state, not
 * through secrets/. Reports (by name only) a Vast.ai key in the environment that the controller does not use.
 */
function dstackProviderKeyChange(root: string): string | undefined {
  const state = readDstackCredentials(root)
  const variable = readCapacityDocument(root)?.providers.vastai?.apiKeyEnv
  if (!state?.vastaiApiKey || !variable) return undefined
  const value = process.env[variable]?.trim()
  return value && value !== state.vastaiApiKey ? `${variable}: the dstack controller uses another Vast.ai key; deploy it with scrollsdk capacity deploy` : undefined
}

/**
 * Regenerate secrets/ from the deployment inputs and report which files and
 * keys changed. With `apply`, upload only changed files, force their
 * ExternalSecrets to sync and wait for them; otherwise restore secrets/.
 * Restarts are reported, never performed.
 */
export async function syncSecrets(rootInput: string, options: {apply: boolean; context: string; envFile?: string; namespace: string}, deps: SecretsSyncDeps): Promise<SecretsSyncResult> {
  const root = path.resolve(rootInput)
  if (!options.context.trim()) throw new Error('An explicit Kubernetes context is required')
  const destination = secretDestination(root)
  if (!fs.existsSync(localPath(root, SECRETS))) throw new Error('No secrets/ directory; this deployment has not generated its secrets yet')
  loadPreparationEnv(savedDeploymentEnvFile(root, options.envFile))
  const before = snapshot(root)
  writeBackup(root, before)
  let changes: SecretFileChange[]
  try {
    await deps.generate(root)
    changes = compareSecrets(before, snapshot(root))
    const pinned = changes.flatMap(change => change.keys.filter(key => PINNED_KEY.test(key)).map(key => `${change.file}:${key}`))
    if (pinned.length > 0) throw new Error(`Refusing to change signing or node keys through secrets sync: ${pinned.join(', ')}. Restore the previous inputs; these keys are never rotated on a running deployment`)
    if (!options.apply) restore(root, before)
  } catch (error) {
    restore(root, before)
    fs.rmSync(localPath(root, BACKUP), {force: true, recursive: true})
    throw error
  }

  const pushed = changes.filter(change => change.route === 'push')
  const manual = changes.filter(change => change.route === 'manual').map(change => change.status === 'removed'
    ? `${change.file}: removed from secrets/; its store secret and any ExternalSecret keep the previous value, so retire them by hand once nothing uses them`
    : change.file.includes('/') ? `${change.file}: in a subdirectory of secrets/, which secrets sync does not upload`
    : change.file.startsWith('dstack-controller')
    ? `${change.file}: scrollsdk setup push-secrets --dstack-only --kube-context ${options.context} --namespace ${options.namespace} --non-interactive`
    : change.file === 'scroll-monitor-slack.yaml' ? `${change.file}: scrollsdk setup monitoring-secrets --apply --kube-context ${options.context} --namespace ${options.namespace}`
      : `${change.file}: not uploaded by secrets sync; apply it with the command that owns it`)
  const providerKey = dstackProviderKeyChange(root)
  if (providerKey) manual.push(providerKey)
  const result: SecretsSyncResult = {applied: options.apply, changes, externalSecrets: [], manual, restarts: []}
  let uploaded = false
  try {
    const all = pushed.length > 0 ? json(deps.kube(['get', ES_RESOURCE, '-o', 'json'])).items ?? [] : []
    result.externalSecrets = pushed.flatMap(change => all.filter((item: any) => remoteKeys(item).some(key => matches(destination, key, change.secret!)))
      .map((item: any) => ({name: item.metadata.name as string, secret: change.secret!, target: (item.spec?.target?.name ?? item.metadata.name) as string})))
    const workloads = result.externalSecrets.length > 0 ? readers(deps.kube, new Set(result.externalSecrets.map(item => item.target))) : []
    result.restarts = workloads.map(workload => `kubectl --context ${options.context} --namespace ${options.namespace} rollout restart ${workload}`)
    if (!options.apply) return result
    for (const change of pushed) {
      // push-secrets can finish without writing, for example when the Vault pod is absent.
      if (!(await deps.push(root, change.file, destination)).includes(change.secret!)) throw new Error(`setup push-secrets did not write ${change.secret}; check the ${destination.provider === 'aws' ? 'AWS Secrets Manager' : 'Vault'} destination`)
    }

    uploaded = true
  } catch (error) {
    // Before every upload succeeded, put the old files back so that a rerun detects and
    // uploads the same changes again; uploads are idempotent.
    if (options.apply) restore(root, before)
    throw new Error(`${(error as Error).message}${options.apply ? '. secrets/ was restored; fix the cause and rerun secrets sync --apply' : ''}`)
  } finally {
    if (!options.apply || !uploaded) fs.rmSync(localPath(root, BACKUP), {force: true, recursive: true})
  }

  const requested = deps.now()
  try {
    for (const item of result.externalSecrets) deps.kube(['annotate', ES_RESOURCE, item.name, `force-sync=${Math.floor(requested.getTime() / 1000)}`, '--overwrite'])
    for (const item of result.externalSecrets) {
      for (let attempt = 0; attempt < 60 && !item.synced; attempt++) {
        const status = json(deps.kube(['get', ES_RESOURCE, item.name, '-o', 'json'])).status ?? {}
        const ready = (status.conditions ?? []).some((condition: any) => condition.type === 'Ready' && condition.status === 'True')
        // refreshTime has second precision.
        if (ready && Date.parse(status.refreshTime ?? '') >= Math.floor(requested.getTime() / 1000) * 1000) item.synced = true
        else {
          await deps.sleep(2000)
          // After provider errors ESO backs off; a new annotation value triggers another attempt now.
          if (attempt % 10 === 9) deps.kube(['annotate', ES_RESOURCE, item.name, `force-sync=${Math.floor(deps.now().getTime() / 1000)}-${attempt}`, '--overwrite'])
        }
      }

      item.synced ??= false
    }
  } finally {
    // The secret store already holds the new values; the new files are the record of them.
    fs.rmSync(localPath(root, BACKUP), {force: true, recursive: true})
  }

  return result
}

function runCli(root: string, args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, '--json'], {cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'ignore']})
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {if (output.length < 1024 * 1024) output += chunk})
    child.once('error', () => reject(new Error(`Unable to run scrollsdk ${args.slice(0, 2).join(' ')}`)))
    child.once('close', code => {
      let parsed: any
      try {parsed = JSON.parse(output.slice(output.indexOf('{')))} catch {parsed = undefined}
      // Structured CLI errors are already credential-free; anything else stays suppressed.
      if (code === 0 && parsed?.success !== false) resolve(parsed?.data)
      else reject(new Error(`scrollsdk ${args.slice(0, 2).join(' ')} failed${typeof parsed?.error?.message === 'string' ? `: ${parsed.error.message}` : ' (output suppressed)'}`))
    })
  })
}

export function defaultSecretsSyncDeps(context: string, namespace: string): SecretsSyncDeps {
  return {
    async generate(root) {await runCli(root, ['setup', 'gen-secrets', '--non-interactive'])},
    kube(args) {
      const result = spawnSync('kubectl', ['--context', context, '--namespace', namespace, ...args], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000})
      if (result.error || result.status !== 0) throw new Error(`kubectl ${args[0]} failed; check the context, namespace and RBAC (remote details omitted)`)
      return result.stdout
    },
    now: () => new Date(),
    async push(root, file, destination) {
      const data = await runCli(root, ['setup', 'push-secrets', '--provider', destination.provider, '--secret-file', path.join(SECRETS, file), '--skip-yaml-update', '--non-interactive',
        ...(destination.provider === 'aws' ? ['--aws-region', destination.awsRegion!, '--aws-prefix', destination.awsPrefix!] : [])])
      return Array.isArray(data?.secretsPushed) ? data.secretsPushed : []
    },
    sleep: ms => new Promise(resolve => {setTimeout(resolve, ms)}),
  }
}
