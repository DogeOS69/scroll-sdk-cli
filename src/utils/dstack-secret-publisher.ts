import * as yaml from 'js-yaml'
import {spawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {DstackControllerConfig} from '../types/dstack-controller.js'
import type {DstackSecret} from './dstack-credentials.js'

import {DSTACK_SERVER_CONFIG_CHECKSUM_ANNOTATION} from './dstack-controller-values.js'
import {dstackSecretRefs, dstackServerConfigChecksum, readDstackCredentials, renderDstackSecrets} from './dstack-credentials.js'
import {parseDatabaseUrl} from './dstack-database.js'

function privateYaml(content: string): unknown {
  try {
    return yaml.load(content)
  } catch {
    throw new Error('Invalid dstack YAML; contents omitted')
  }
}

/** Read the exact managed files, never glob arbitrary Secret manifests. */
export function loadDstackSecretPublication(config: DstackControllerConfig, valuesFile: string, namespace: string): DstackSecret[] {
  return readDstackSecretPublication(config, valuesFile, namespace).secrets
}

/**
 * Values without the checksum annotation predate it (older CLI or generate-from-spec before credentials existed):
 * publishing stays allowed and the caller warns that helm upgrade will not restart the controller. A different
 * checksum means the values were generated for another config.yml and is refused.
 */
function readDstackSecretPublication(config: DstackControllerConfig, valuesFile: string, namespace: string): {checksumMissing: boolean; secrets: DstackSecret[]} {
  if (!/^[\da-z]([\da-z-]*[\da-z])?$/.test(namespace) || namespace.length > 63) throw new Error('Invalid Kubernetes namespace')
  if (config.monitoring?.enabled !== false && namespace !== (config.monitoring?.namespace ?? 'default')) throw new Error('Dstack monitoring namespace differs from the Secret upload destination')
  const state = readDstackCredentials()
  if (!state) throw new Error('Run setup dstack-config and setup gen-secrets --dstack-only first')
  const refs = dstackSecretRefs(config, state)
  if (!fs.existsSync(valuesFile)) throw new Error('Dstack production values are missing; run setup prep-charts or setup generate-from-spec first')
  const values = privateYaml(fs.readFileSync(valuesFile, 'utf8')) as DstackControllerConfig
  // Values are chart input, not the public controller schema (which has enabled).
  const valuesRefs = dstackSecretRefs({
    auth: values?.auth, credentialSecrets: values?.credentialSecrets,
    database: values?.database?.type === 'sqlite' ? {type: 'sqlite'} : values?.database,
    monitoring: values?.monitoring, serverConfig: values?.serverConfig,
  }, state)
  if (JSON.stringify(refs) !== JSON.stringify(valuesRefs)) throw new Error('Dstack Secret references differ from production values; regenerate values before publishing')
  const expected = renderDstackSecrets(config, state)
  if (refs.database) expected.push({apiVersion: 'v1', kind: 'Secret', metadata: {name: refs.database.name}, stringData: {}, type: 'Opaque'})
  const publication = expected.map(template => {
    const file = path.join('secrets', `${template.metadata.name}.yaml`)
    if (!fs.existsSync(file)) throw new Error(`Missing ${file}; run setup gen-secrets --dstack-only`)
    const secret = privateYaml(fs.readFileSync(file, 'utf8')) as DstackSecret
    if (!secret || secret.apiVersion !== 'v1' || secret.kind !== 'Secret' || secret.type !== 'Opaque'
      || secret.metadata?.name !== template.metadata.name || (secret.metadata.namespace && secret.metadata.namespace !== namespace)
      || !secret.stringData || typeof secret.stringData !== 'object' || Array.isArray(secret.stringData)) throw new Error(`Invalid dstack Secret manifest: ${file}`)
    const data = secret.stringData
    if (refs.database?.name === template.metadata.name) {
      if (Object.keys(data).length !== 1 || typeof data[refs.database.key] !== 'string') throw new Error('Invalid dstack database Secret data')
      const url = parseDatabaseUrl(data[refs.database.key])
      if (url.protocol !== 'postgresql+asyncpg:' || url.searchParams.has('sslmode')) throw new Error('Dstack database Secret requires asyncpg URL with ssl, not sslmode')
    } else if (Object.keys(data).length !== Object.keys(template.stringData).length
      || Object.entries(template.stringData).some(([key, value]) => data[key] !== value)) {
      throw new Error(`Stale dstack Secret file: ${file}; rerun setup gen-secrets --dstack-only`)
    }

    // Whitelist the outgoing object: input metadata/annotations cannot inject resources.
    return {...template, metadata: {name: template.metadata.name, namespace}, stringData: {...data}}
  })
  // Without a matching checksum, helm upgrade would not restart the controller,
  // and the uploaded config.yml would stay unused until some later restart.
  const recorded = (values as {podAnnotations?: Record<string, unknown>} | undefined)?.podAnnotations?.[DSTACK_SERVER_CONFIG_CHECKSUM_ANNOTATION]
  if (recorded !== undefined && recorded !== dstackServerConfigChecksum(state)) {
    throw new Error(`Dstack production values carry the ${DSTACK_SERVER_CONFIG_CHECKSUM_ANNOTATION} of a different controller config; on a deployment with capacity.yaml use scrollsdk capacity deploy, during preparation rerun setup prep-charts --dstack-only, so that helm upgrade restarts the controller with it`)
  }

  return {checksumMissing: recorded === undefined, secrets: publication}
}

/** For values without the checksum annotation; names no values. */
export const DSTACK_CHECKSUM_MISSING_WARNING = `The dstack production values have no ${DSTACK_SERVER_CONFIG_CHECKSUM_ANNOTATION} annotation, so helm upgrade will not restart the controller `
  + 'and dstack keeps its previous config.yml. Use scrollsdk capacity deploy, which sets the annotation, or restart the controller deployment after the upload.'

export type KubectlRunner = (args: string[], stdin?: string) => Promise<string>

export interface ApplyConflict {
  fields: string[]
  /** Field manager with the API server's qualifiers, for example `"kubectl-patch" using v1`. */
  manager: string
}

// The API server's apply conflict message (k8s.io/apiserver fieldmanager): one
// conflict is `Apply failed with 1 conflict: conflict with <manager>: <path>`;
// several are grouped as `conflicts with <manager>:` lines, each followed by
// `- <path>` lines.
const CONFLICT_HEADER = /Apply failed with (\d+) conflicts?: /g
const MANAGER = String.raw`("[\w .:@/+-]{1,128}"(?: with subresource "[\w-]{1,64}")?(?: using [\w./-]{1,64})?(?: at [\d:TZ+-]{1,32})?)`
const SINGLE_CONFLICT = new RegExp(String.raw`^conflict with ${MANAGER}: (\S+)$`)
const GROUP_HEADER = new RegExp(String.raw`^conflicts with ${MANAGER}:$`)
const GROUP_FIELD = /^- (\S+)$/
const MAX_STDERR = 64 * 1024

/**
 * Field paths name keys, not values, except set-element (`[=...]`) and keyed
 * list (`[name="..."]`) selectors, which Secret data does not use. Accept only
 * plain dotted key paths so no value can be reflected into an error.
 */
function safeFieldPath(value: string): string | undefined {
  return value.length <= 256 && /^(?:\.[\w-]+)+$/.test(value) ? value : undefined
}

function parseConflictBlock(text: string, expected: number): ApplyConflict[] | undefined {
  const lines = text.split('\n').map(line => line.trimEnd())
  const conflicts: ApplyConflict[] = []
  const single = SINGLE_CONFLICT.exec(lines[0])
  if (single) {
    const field = safeFieldPath(single[2])
    if (!field) return undefined
    conflicts.push({fields: [field], manager: single[1]})
  } else {
    let current: ApplyConflict | undefined
    for (const line of lines) {
      const group = GROUP_HEADER.exec(line)
      if (group) {
        current = {fields: [], manager: group[1]}
        conflicts.push(current)
        continue
      }

      const entry = GROUP_FIELD.exec(line)
      if (!entry || !current) break
      const field = safeFieldPath(entry[1])
      if (!field) return undefined
      current.fields.push(field)
    }
  }

  const count = conflicts.reduce((total, conflict) => total + conflict.fields.length, 0)
  return count > 0 && count === expected && conflicts.every(conflict => conflict.fields.length > 0) ? conflicts : undefined
}

/**
 * Extract only field managers and field paths from server-side apply conflict
 * output. Returns undefined unless every conflict message matches the API
 * server's format exactly; callers then keep the whole output suppressed.
 */
export function parseApplyConflicts(stderr: string): ApplyConflict[] | undefined {
  const headers = [...stderr.slice(0, MAX_STDERR).matchAll(CONFLICT_HEADER)]
  if (headers.length === 0) return undefined
  const conflicts: ApplyConflict[] = []
  for (const [index, header] of headers.entries()) {
    const start = header.index! + header[0].length
    const block = parseConflictBlock(stderr.slice(start, headers[index + 1]?.index ?? stderr.length), Number(header[1]))
    if (!block) return undefined
    conflicts.push(...block)
  }

  return conflicts
}

/** Credential-free summary: manager names and field paths only. */
export function describeApplyConflicts(conflicts: ApplyConflict[]): string {
  return conflicts.map(conflict => `${conflict.manager} owns ${conflict.fields.join(', ')}`).join('; ')
}

/**
 * Use stdin, not shell/argv, for payloads. Suppress kubectl error bodies (may
 * echo Secrets), except the field managers and paths of an apply conflict.
 */
export const runSecretKubectl: KubectlRunner = (args, stdin) => new Promise((resolve, reject) => {
  const child = spawn('kubectl', args, {stdio: ['pipe', 'pipe', 'pipe']})
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {stdout += chunk})
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {if (stderr.length < MAX_STDERR) stderr += chunk})
  child.stdin.on('error', () => { /* Exit/error below reports a redacted failure. */ })
  child.on('error', () => reject(new Error('Unable to execute kubectl; check its installation and kubeconfig')))
  child.on('close', code => {
    if (code === 0) {
      resolve(stdout)
      return
    }

    const conflicts = parseApplyConflicts(stderr)
    reject(new Error(conflicts
      ? `Kubectl server-side apply failed (exit ${code}) on field ownership: ${describeApplyConflicts(conflicts)}. `
        + 'Another field manager changed these fields. Carry that change into the CLI inputs, or remove the other manager\'s ownership after reviewing the live object, then retry. '
        + 'Do not force the apply: it discards the other change. Other kubectl output was suppressed because it may contain credentials.'
      : `Kubectl failed (exit ${code}); response suppressed because it may contain credentials. Check context, namespace, RBAC and Secret field ownership.`))
  })
  child.stdin.end(stdin)
})

interface LiveSecret {
  data?: Record<string, string>
  metadata?: {name?: string}
}

interface ServerConfig {
  encryption?: {keys?: unknown}
  projects?: unknown
}

/** A project's backends that dstack deletes when it restarts with the new config.yml. */
export interface DstackBackendRemoval {
  backends: string[]
  project: string
}

/** Backend types per listed project. Types only: never credentials or other fields. */
function projectBackends(config: ServerConfig | undefined): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  if (!Array.isArray(config?.projects)) return result
  for (const project of config.projects as Array<{backends?: unknown; name?: unknown}>) {
    if (typeof project?.name !== 'string' || !/^[\w.-]{1,64}$/.test(project.name)) continue
    const types = (Array.isArray(project.backends) ? project.backends : [])
      .map(backend => (backend as {type?: unknown})?.type)
      .filter((type): type is string => typeof type === 'string' && /^[\w-]{1,32}$/.test(type))
    result.set(project.name, new Set(types))
  }

  return result
}

/**
 * dstack 0.21.5 reconciles each project listed in config.yml at startup and
 * deletes backend types the file does not list (an omitted list deletes all).
 * Projects no longer listed are left untouched. Backends created through the
 * dstack API in a listed project are deleted as well, but cannot be seen here.
 */
export function dstackBackendRemovals(live: ServerConfig | undefined, next: ServerConfig | undefined): DstackBackendRemoval[] {
  const desired = projectBackends(next)
  const removals: DstackBackendRemoval[] = []
  for (const [project, backends] of projectBackends(live)) {
    const kept = desired.get(project)
    if (!kept) continue
    const removed = [...backends].filter(type => !kept.has(type)).sort()
    if (removed.length > 0) removals.push({backends: removed, project})
  }

  return removals
}

/** Refuse accidental replacement of an existing controller's identity/encryption keys. */
export async function publishDstackSecrets(options: {
  config: DstackControllerConfig
  context: string
  dryRun?: boolean
  namespace: string
  /** Called after the live readback and before any write; may throw to abort. */
  onBackendRemovals?: (removals: DstackBackendRemoval[]) => Promise<void> | void
  /** Validate live identity and server-side admission before other upload destinations mutate. */
  preflightOnly?: boolean
  runner?: KubectlRunner
  valuesFile: string
}): Promise<{
  /** Backends that the controller restart will delete; only from a live readback (not in dry-run). */
  backendRemovals?: DstackBackendRemoval[]
  /** The values lack the checksum annotation; see DSTACK_CHECKSUM_MISSING_WARNING. */
  checksumMissing: boolean
  context: string
  dryRun: boolean
  namespace: string
  secrets: string[]
  /** Whether the live config.yml differs, so the controller must restart to use it; only from a live readback. */
  serverConfigChanged?: boolean
}> {
  if (!options.context.trim()) throw new Error('An explicit Kubernetes context is required')
  const {checksumMissing, secrets} = readDstackSecretPublication(options.config, options.valuesFile, options.namespace)
  const result = {checksumMissing, context: options.context, dryRun: Boolean(options.dryRun), namespace: options.namespace, secrets: secrets.map(secret => secret.metadata.name)}
  if (options.dryRun) return result
  const runner = options.runner ?? runSecretKubectl
  const prefix = ['--context', options.context, '--namespace', options.namespace, '--request-timeout=30s']
  const state = readDstackCredentials()!
  const refs = dstackSecretRefs(options.config, state)
  const liveText = await runner([...prefix, 'get', 'secret', refs.server.name, refs.auth.name, ...(refs.monitoring ? [refs.monitoring.name] : []), '--ignore-not-found', '-o', 'json'])
  let live: {items?: LiveSecret[]}
  try {
    // kubectl exits successfully with empty stdout when all explicitly named
    // Secrets are absent and --ignore-not-found is set (fresh installation).
    // Runner failures still reject above; malformed nonempty output is an error.
    live = liveText.trim() ? JSON.parse(liveText) : {items: []}
    if (!Array.isArray(live.items)) throw new Error('invalid')
  } catch {
    throw new Error('Invalid Kubernetes Secret readback; contents omitted')
  }

  const nextServerContent = secrets.find(secret => secret.metadata.name === refs.server.name)!.stringData[refs.server.key]
  const nextServer = privateYaml(nextServerContent) as ServerConfig
  let liveServer: ServerConfig | undefined
  let liveServerContent: string | undefined
  for (const secret of live.items!) {
    if (refs.monitoring && secret.metadata?.name === refs.monitoring.name) {
      const token = Buffer.from(secret.data?.[refs.monitoring.key] ?? '', 'base64').toString('utf8')
      if (token !== state.monitoringToken) throw new Error('Existing monitoring token differs from local state; restore matching credentials before publishing')
    }

    if (secret.metadata?.name === refs.auth.name) {
      const token = Buffer.from(secret.data?.[refs.auth.key] ?? '', 'base64').toString('utf8')
      if (token !== state.adminToken) throw new Error('Existing controller admin token differs from local state; restore the matching credential state before publishing')
    }

    if (secret.metadata?.name === refs.server.name) {
      const content = Buffer.from(secret.data?.[refs.server.key] ?? '', 'base64').toString('utf8')
      const server = privateYaml(content) as ServerConfig
      liveServer = server
      liveServerContent = content
      const expectedKeys = [{name: 'primary', secret: state.encryptionKey, type: 'aes'}]
      // Compare parsed YAML semantically, independent of mapping field order.
      const keys = server?.encryption?.keys as Array<{name?: string; secret?: string; type?: string}> | undefined
      if (!Array.isArray(keys) || keys.length !== 1 || keys[0]?.name !== expectedKeys[0].name
        || keys[0]?.type !== 'aes' || keys[0]?.secret !== state.encryptionKey) {
        throw new Error('Existing controller encryption keys differ from local state; restore matching state before publishing')
      }
    }
  }

  const backendRemovals = dstackBackendRemovals(liveServer, nextServer)
  // Report before writing: the upload itself deletes nothing, the next restart does.
  if (backendRemovals.length > 0) await options.onBackendRemovals?.(backendRemovals)

  // Server-side apply needs data rather than stringData for reliable field ownership.
  const items = secrets.map(({stringData, ...secret}) => ({...secret, data: Object.fromEntries(Object.entries(stringData).map(([key, value]) => [key, Buffer.from(value).toString('base64')]))}))
  const payload = JSON.stringify({apiVersion: 'v1', items, kind: 'List'})
  const apply = [...prefix, 'apply', '--server-side', '--field-manager=scrollsdk-dstack', '-f', '-', '-o', 'name']
  await runner([...apply, '--dry-run=server'], payload)
  if (!options.preflightOnly) await runner(apply, payload)
  return {
    ...result,
    backendRemovals,
    serverConfigChanged: liveServerContent !== nextServerContent,
  }
}

/** Names and backend types only. */
export function dstackBackendRemovalWarning(removal: DstackBackendRemoval): string {
  return `Restarting the dstack controller with the uploaded config.yml deletes backend types [${removal.backends.join(', ')}] from project ${removal.project}. `
    + 'If they are still needed, keep them in capacity.yaml and run scrollsdk capacity deploy instead. '
    + 'Backends created through the dstack API or UI in that project are deleted too; the Secret does not show them.'
}

export const DSTACK_RESTART_NOTE = 'dstack reads config.yml only at startup. Install or upgrade the dstack-controller release with the regenerated values: '
  + 'their checksum/server-config annotation restarts a running controller.'
