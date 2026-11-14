/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values documents. */
import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import {randomBytes} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'

import type {CapacityDocument, CapacityPool} from '../types/capacity.js'
import type {DstackControllerConfig} from '../types/dstack-controller.js'
import type {DstackCredentials, DstackProvider} from './dstack-credentials.js'

import {CAPACITY_API_VERSION} from '../types/capacity.js'
import {CAPACITY_DOCUMENT, CAPACITY_PROVIDERS, applyCapacityDocument, readCapacityDocument, writeCapacityDocument} from './capacity-document.js'
import {CAPACITY_MANAGER_VALUES, type CapacityPreparationOptions, capacityIntentSpec, capacitySpec, inCapacityDocumentTerms, parseCapacityInput, prepareCapacityManager, resolveCapacityManager} from './capacity-manager.js'
import {savedDeploymentEnvFile} from './deployment-paths.js'
import {DSTACK_SERVER_CONFIG_CHECKSUM_ANNOTATION, dumpDstackControllerValues} from './dstack-controller-values.js'
import {DSTACK_CREDENTIALS_FILE, checkPrivatePath, configureDstackCredentialRefs, dstackSecretRefs, dstackServerConfigChecksum, readDstackCredentials, renderDstackSecrets, validateDstackCredentials, writeDstackCredentialSecrets, writePrivateFile} from './dstack-credentials.js'
import {readDstackControllerConfig} from './dstack-database.js'
import {loadPreparationEnv, localPath} from './preparation-io.js'
import {validateProofDeploymentContract} from './proof-deployment-contract.js'

const CONTROLLER_VALUES = 'values/dstack-controller-production.yaml'

export interface CapacityRenderOptions {
  /** Checks a new or changed Vast.ai API key with Vast.ai before anything is written. */
  checkVastKey?: (key: string) => Promise<void>
  /** Provider credentials; defaults to the process environment after loading the deployment's environment file. */
  env?: NodeJS.ProcessEnv
  envFile?: string
  /** capacity-manager preparation with the capacity commands' options; replaceable in tests. */
  prepare?: (root: string, options: CapacityPreparationOptions) => unknown
  /** Render without contacting Vast.ai, for example offline. */
  skipProviderCheck?: boolean
}

/** The request dstack 0.21.5 uses to validate a Vast.ai backend; any non-2xx status fails it. */
const VAST_KEY_CHECK_URL = 'https://console.vast.ai/api/v1/instances/'

/**
 * dstack only logs a warning when it rejects a backend key at startup and keeps
 * the previous key, so a wrong key would go unnoticed. The key is sent only to
 * Vast.ai; neither the key nor the response body is ever printed.
 */
export async function checkVastApiKey(key: string, request: typeof fetch = fetch): Promise<void> {
  let response: Response
  try {
    response = await request(VAST_KEY_CHECK_URL, {headers: {Authorization: `Bearer ${key}`}, redirect: 'error', signal: AbortSignal.timeout(30_000)})
  } catch {
    throw new Error('Cannot reach Vast.ai to check the API key; retry, or pass --skip-provider-check to render without the check. Nothing was written')
  }

  await response.body?.cancel()
  if (response.ok) return
  // Vast.ai answers an unknown key with 404 (auth_error); dstack treats every failure as invalid credentials.
  if (response.status >= 400 && response.status < 500 && response.status !== 429) throw new Error(`Vast.ai rejected the API key (HTTP ${response.status}); correct it in the environment file and retry. Nothing was written`)
  throw new Error(`Vast.ai answered the API key check with HTTP ${response.status}; retry, or pass --skip-provider-check. Nothing was written`)
}

/** Fleet configurations by name, before and after; field names only. */
/** A changed value. Capacity and controller values hold Secret references, never Secret data. */
export interface ValueChange {
  after?: unknown
  before?: unknown
  path: string
}

/** Value paths that differ; empty strings and nulls count as absent, and the TOML policy is compared by key. */
export function valueChanges(before: any, after: any, prefix = ''): ValueChange[] {
  const absent = (value: unknown) => value === undefined || value === null || value === ''
  if (absent(before) && absent(after)) return []
  if (prefix === 'manager.policy' && typeof before === 'string' && typeof after === 'string') {
    try {
      return valueChanges(toml.parse(before), toml.parse(after), 'policy')
    } catch {/* Compared as text below. */}
  }

  const isMapping = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (isMapping(before) && isMapping(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => valueChanges(before[key], after[key], prefix ? `${prefix}.${key}` : key))
  }

  return isDeepStrictEqual(before, after) ? [] : [{after, before, path: prefix || '(all)'}]
}

/** `path old -> new`; long values (certificates, digests, command lines) only as changed. */
export function formatValueChange({after, before, path: name}: ValueChange): string {
  const text = (value: unknown) => value === undefined || value === null || value === '' ? '(none)' : typeof value === 'string' ? value : JSON.stringify(value)
  const [from, to] = [text(before), text(after)]
  return from.length + to.length > 80 ? `${name} (changed)` : `${name} ${from} -> ${to}`
}

/** Fleet fields dstack 0.21.5 updates in place; the capacity-manager chart's initialization refuses any other change. */
export const FLEET_IN_PLACE_FIELDS: readonly string[] = ['backends', 'instance_types', 'max_price', 'nodes', 'regions', 'resources', 'spot_policy']

export interface FleetChanges {
  created: string[]
  unchanged: string[]
  /** Declared before and no longer; dstack keeps them until deleted with dstack tooling. */
  undeclared: string[]
  /** `fixed`: changed fields dstack cannot update in place; such a fleet needs a new name. */
  updated: Array<{changes: ValueChange[]; fields: string[]; fixed: string[]; name: string}>
}

export function fleetChanges(before: Array<Record<string, unknown>>, after: Array<Record<string, unknown>>): FleetChanges {
  const old = new Map(before.map(fleet => [String(fleet.name), fleet]))
  const changes: FleetChanges = {created: [], unchanged: [], undeclared: [], updated: []}
  for (const fleet of after) {
    const name = String(fleet.name)
    const previous = old.get(name)
    if (!previous) {changes.created.push(name); continue}
    const changed = valueChanges(previous, fleet)
    const fields = [...new Set(changed.map(change => change.path.split('.')[0]))]
    if (fields.length > 0) changes.updated.push({changes: changed, fields, fixed: fields.filter(field => !FLEET_IN_PLACE_FIELDS.includes(field)), name})
    else changes.unchanged.push(name)
  }

  const declared = new Set(after.map(fleet => String(fleet.name)))
  changes.undeclared = [...old.keys()].filter(name => !declared.has(name))
  return changes
}

/** Changes that need a new fleet name, as one message; undefined when every change can be made in place. */
export function fixedFleetChanges(fleets: FleetChanges): string | undefined {
  const fixed = fleets.updated.filter(fleet => fleet.fixed.length > 0)
  if (fixed.length === 0) return
  return `dstack cannot update ${fixed.map(fleet => `${fleet.fixed.join(', ')} of fleet ${fleet.name}`).join('; ')} in place. `
    + 'Give the fleet a new name in capacity.yaml (the new fleet is created; delete the old one with dstack tooling once it has no instances), or restore the previous value'
}

export interface CapacityRenderResult {
  addedProviders: string[]
  /** Against the previously rendered capacity-manager values. */
  fleets: FleetChanges
  /** The Vast.ai key differs from the one in the controller credential state. */
  keyRotated: boolean
  providers: string[]
  /** Backends that the controller deletes from the project when it restarts with the new config.yml. */
  removedProviders: string[]
  /** Whether config.yml differs from the one the controller values were last rendered for. */
  serverConfigChanged: boolean
}

function readYaml(root: string, file: string): any {
  return parseCapacityInput(fs.readFileSync(localPath(root, file), 'utf8'), file, yaml.load)
}

/**
 * The controller configuration for credential references, with its AWS identity taken from the controller values:
 * after preparation those values belong to the operator, so a day-2 identity change is made there.
 */
function readControllerContext(root: string) {
  const recorded = readDstackControllerConfig(localPath(root, '.data/doge-config.toml'))
  if (!recorded || recorded.enabled === false) throw new Error('This deployment has no enabled dstack controller')
  const state = readDstackCredentials(root)
  if (!state) throw new Error(`Missing ${DSTACK_CREDENTIALS_FILE}; restore the controller credential state from backup`)
  const values = readYaml(root, CONTROLLER_VALUES)
  const controller: DstackControllerConfig = {...recorded}
  if (values.defaultCredentialsEnabled === undefined) delete controller.defaultCredentialsEnabled
  else controller.defaultCredentialsEnabled = values.defaultCredentialsEnabled
  if (values.serviceAccount === undefined) delete controller.serviceAccount
  else controller.serviceAccount = values.serviceAccount
  return {controller, state, values}
}

/** Workload credentials must not fall back to the node's instance role (as generated by prep-charts). */
function checkAwsIdentity(values: any, next: DstackCredentials, podIdentity: boolean): void {
  if (!next.providers.includes('aws')) return
  const identity = podIdentity ? values.serviceAccount?.name : values.serviceAccount?.annotations?.['eks.amazonaws.com/role-arn']
  if (values.defaultCredentialsEnabled !== true || !identity) {
    throw new Error(`An AWS provider uses the controller's workload role: set defaultCredentialsEnabled: true and ${podIdentity ? 'serviceAccount.name (the Pod Identity association)' : 'serviceAccount.annotations["eks.amazonaws.com/role-arn"]'} in ${CONTROLLER_VALUES} (see docs/capacity.md, AWS providers)`)
  }

  const env = (values.extraEnv ?? []) as Array<{name?: string; value?: string}>
  if (!env.some(entry => entry.name === 'AWS_EC2_METADATA_DISABLED' && entry.value === 'true')) {
    throw new Error(`AWS dstack requires extraEnv [{name: AWS_EC2_METADATA_DISABLED, value: "true"}] in ${CONTROLLER_VALUES}, so that the controller never uses the node's instance role`)
  }
}

/** The controller credential state with capacity.yaml's providers; GCP is not managed here and stays as it is. */
function nextCredentials(state: DstackCredentials, document: CapacityDocument, env: NodeJS.ProcessEnv): DstackCredentials {
  const next: DstackCredentials = structuredClone(state)
  next.providers = [...CAPACITY_PROVIDERS.filter(provider => document.providers[provider]), ...state.providers.filter(provider => provider === 'gcp')] as DstackProvider[]
  if (document.providers.aws) next.aws = structuredClone(document.providers.aws)
  else delete next.aws
  if (document.providers.vastai) {
    const name = document.providers.vastai.apiKeyEnv
    const key = env[name]?.trim()
    if (!key || /\s/.test(key)) throw new Error(`Set ${name} to the Vast.ai API key in the deployment environment file, then retry`)
    next.vastaiApiKey = key
  } else delete next.vastaiApiKey
  validateDstackCredentials(next)
  return next
}

/**
 * Turn capacity.yaml into deployable files: the dstack Secret files under secrets/, the controller values'
 * checksum/server-config annotation (nothing else in that operator-owned file), and the capacity-manager values
 * whose chart initialization creates missing fleets and updates changed ones in place. Contacts Vast.ai to check
 * a new or changed API key, and reads the private dstack CA as capacity-manager preparation does; changes nothing
 * in the cluster.
 */
export async function renderCapacity(rootInput: string, options: CapacityRenderOptions = {}): Promise<CapacityRenderResult> {
  try {
    return await renderCapacityDocument(path.resolve(rootInput), options)
  } catch (error) {
    // The operator edited capacity.yaml, not the spec: name its fields.
    if (error instanceof Error) error.message = inCapacityDocumentTerms(error.message)
    throw error
  }
}

async function renderCapacityDocument(root: string, options: CapacityRenderOptions): Promise<CapacityRenderResult> {
  const document = readCapacityDocument(root)
  if (!document) throw new Error(`Missing ${CAPACITY_DOCUMENT}; run scrollsdk capacity deploy or render to create it`)
  const {controller, state, values} = readControllerContext(root)
  if (document.project !== state.project) throw new Error(`${CAPACITY_DOCUMENT} project must stay the controller's dstack project ${state.project}`)
  let {env} = options
  if (!env) {
    loadPreparationEnv(savedDeploymentEnvFile(root, options.envFile))
    env = process.env
  }

  // Validate everything before writing anything.
  const next = nextCredentials(state, document, env)
  checkAwsIdentity(values, next, controller.awsWorkloadIdentity === 'pod-identity')
  const refs = configureDstackCredentialRefs(controller, next)
  const spec = capacitySpec(root)
  resolveCapacityManager(spec)
  checkDstackSecretWrites(refs, next, root)
  const keyRotated = Boolean(next.vastaiApiKey && state.vastaiApiKey && next.vastaiApiKey !== state.vastaiApiKey)
  // Only a new or changed key needs the provider; an unchanged one already works or was checked before.
  if (next.vastaiApiKey && next.vastaiApiKey !== state.vastaiApiKey && !options.skipProviderCheck) await (options.checkVastKey ?? checkVastApiKey)(next.vastaiApiKey)
  const managerFile = localPath(root, CAPACITY_MANAGER_VALUES)
  const previousFleets = fs.existsSync(managerFile) ? readYaml(root, CAPACITY_MANAGER_VALUES).initialization?.fleets ?? [] : []

  // Transactional: the manager values, plan and fleet files change together or not at all.
  // The writes after it were checked above and can only fail on I/O.
  // Day-2: the operator owns the component values, so their proof-managed digests are not required to match.
  await (options.prepare ?? ((directory, preparation) => prepareCapacityManager(directory, contractRoot => validateProofDeploymentContract(contractRoot, undefined, {componentValues: false}), undefined, preparation)))(root, {fleetUpdate: true})
  if (!isDeepStrictEqual(next, state)) writePrivateFile(localPath(root, DSTACK_CREDENTIALS_FILE), JSON.stringify(next, null, 2) + '\n')
  writeDstackCredentialSecrets(refs, root)
  const checksum = dstackServerConfigChecksum(next)
  const serverConfigChanged = values.podAnnotations?.[DSTACK_SERVER_CONFIG_CHECKSUM_ANNOTATION] !== checksum
  if (serverConfigChanged) {
    values.podAnnotations = {...values.podAnnotations, [DSTACK_SERVER_CONFIG_CHECKSUM_ANNOTATION]: checksum}
    fs.writeFileSync(localPath(root, CONTROLLER_VALUES), dumpDstackControllerValues(values))
  }

  return {
    addedProviders: next.providers.filter(provider => !state.providers.includes(provider)),
    fleets: fleetChanges(previousFleets, readYaml(root, CAPACITY_MANAGER_VALUES).initialization?.fleets ?? []),
    keyRotated,
    providers: next.providers,
    removedProviders: state.providers.filter(provider => !next.providers.includes(provider)),
    serverConfigChanged,
  }
}

/**
 * The checks writeDstackCredentialSecrets would fail on, made before any write. Adds a missing monitoring
 * token to `next`, as writing the Secrets would.
 */
function checkDstackSecretWrites(controller: DstackControllerConfig, next: DstackCredentials, root: string): void {
  const refs = dstackSecretRefs(controller, next)
  if (refs.monitoring && !next.monitoringToken) {
    if (fs.existsSync(localPath(root, path.join('secrets', `${refs.monitoring.name}.yaml`)))) throw new Error('Monitoring Secret already exists but its private state is missing; restore credentials.json from backup')
    next.monitoringToken = randomBytes(32).toString('hex')
  }

  checkPrivatePath(localPath(root, DSTACK_CREDENTIALS_FILE))
  for (const secret of renderDstackSecrets(controller, next)) checkPrivatePath(localPath(root, path.join('secrets', `${secret.metadata.name}.yaml`)))
}

function parseQuantity(value: unknown): number | undefined {
  const match = typeof value === 'string' ? value.match(/^(\d+)(?:GB)?\.\.$/) : undefined
  return match ? Number(match[1]) : undefined
}

/**
 * Write capacity.yaml from the prepared intent, the current manager values and the controller credential state,
 * so that a render reproduces the current fleets; undefined when it already exists. Written by the capacity-manager
 * preparation step, and by the first capacity deploy or render of a deployment prepared before capacity.yaml.
 * Reads credentials only to skip them; never writes them. Local only.
 */
export function createCapacityDocument(rootInput: string): {document: CapacityDocument; warnings: string[]} | undefined {
  const root = path.resolve(rootInput)
  if (readCapacityDocument(root)) return undefined
  const state = readDstackCredentials(root)
  if (!state) throw new Error(`Missing ${DSTACK_CREDENTIALS_FILE}; restore the controller credential state from backup`)
  const intent = capacityIntentSpec(root)
  const config = resolveCapacityManager(intent)
  const values = readYaml(root, CAPACITY_MANAGER_VALUES)
  const policy = values.manager?.policy ? toml.parse(values.manager.policy) as any : {}
  const dstack = values.manager?.dstack ?? {}
  const warnings: string[] = []
  const initial = (values.initialization?.fleets ?? []).find((fleet: any) => fleet.name === (dstack.fleets?.[0] ?? config.fleets[0]))
  // The deployed policy names the primary provider; the intent may predate a change.
  const primaryProvider = (policy.pool?.provider ?? config.provider) as CapacityPool['provider']
  const primary: CapacityPool = {
    fleet: dstack.fleets?.[0] ?? config.fleets[0], gpu: (policy.pool?.gpu_class ?? config.gpu) as CapacityPool['gpu'],
    ...((dstack.instanceTypes ?? config.instanceTypes).length > 0 ? {instanceTypes: dstack.instanceTypes ?? config.instanceTypes} : {}),
    maxPricePerHourUsd: dstack.maxPricePerHourUsd ?? config.maxPricePerHourUsd,
    ...(primaryProvider === 'vastai' ? {minReliability: config.minReliability} : {}),
    provider: primaryProvider, regions: dstack.regions ?? config.regions,
  }
  if ((dstack.fleets ?? config.fleets).length > 1) warnings.push(`Only the first primary fleet (${primary.fleet}) is in capacity.yaml; capacity manages one primary fleet`)
  const fallbackName = dstack.fallbackFleet === undefined ? config.fallback?.fleet : dstack.fallbackFleet || undefined
  const fallback: CapacityPool | undefined = fallbackName && config.fallback ? {
    fleet: fallbackName, gpu: config.fallback.gpu, ...(config.fallback.instanceTypes?.length ? {instanceTypes: config.fallback.instanceTypes} : {}),
    maxPricePerHourUsd: config.fallback.maxPricePerHourUsd, ...(config.fallback.provider === 'vastai' ? {minReliability: config.fallback.minReliability ?? config.minReliability} : {}),
    provider: config.fallback.provider, regions: config.fallback.regions,
  } : undefined
  if (fallbackName && !config.fallback) warnings.push(`Fallback fleet ${fallbackName} is set in the values but not in the intent; add it to ${CAPACITY_DOCUMENT} by hand`)
  const providers: CapacityDocument['providers'] = {}
  if (state.providers.includes('vastai')) providers.vastai = {apiKeyEnv: intent.preparation?.dstack?.vastaiApiKeyEnv ?? 'VASTAI_API_KEY'}
  if (state.providers.includes('aws')) providers.aws = structuredClone(state.aws!)
  if (state.providers.includes('gcp')) warnings.push('The GCP backend is not managed by capacity.yaml and stays as it is')
  const family = policy.families ?? {}
  const document: CapacityDocument = {
    apiVersion: CAPACITY_API_VERSION, ...(fallback ? {fallback} : {}), primary, project: state.project, providers,
    resources: {
      cpus: parseQuantity(initial?.resources?.cpu) ?? config.fleet.cpus, diskGiB: parseQuantity(initial?.resources?.disk?.size) ?? config.fleet.diskSizeGiB,
      idleSeconds: typeof initial?.idle_duration === 'string' && /^\d+s$/.test(initial.idle_duration) ? Number.parseInt(initial.idle_duration, 10) : config.fleet.idleDurationSeconds,
      memoryGiB: parseQuantity(initial?.resources?.memory) ?? config.fleet.memoryGiB,
    },
    runtimeEstimates: {
      bridgeStateSeconds: family.bridge_state?.runtime_seconds ?? config.runtimeEstimates.bridgeStateSeconds,
      l2RangeAggregationSeconds: family.l2_range_aggregation?.runtime_seconds ?? config.runtimeEstimates.l2RangeAggregationSeconds,
      scrollBatchSeconds: family.scroll_batch?.runtime_seconds ?? config.runtimeEstimates.scrollBatchSeconds,
      scrollChunkSeconds: family.scroll_chunk?.runtime_seconds ?? config.runtimeEstimates.scrollChunkSeconds,
    },
    scaling: {
      maxHourlyCostUsd: policy.pool?.max_hourly_cost_usd ?? config.maxHourlyCostUsd, maxWorkers: policy.global?.max_workers ?? config.maxWorkers,
      minWorkers: policy.global?.liveness_floor ?? config.minWorkers, scaleDownTtlSeconds: policy.global?.scale_down_ttl_seconds ?? config.scaleDownTtlSeconds,
      steadyStateFloor: policy.global?.steady_state_floor ?? config.steadyStateFloor,
      targetDrainSeconds: policy.global?.target_drain_seconds ?? config.targetDrainSeconds,
    },
  }
  // Leave the default budget implicit, so it keeps following the pool prices.
  const budget = policy.pool?.hourly_cost_usd_per_worker ?? config.workerBudgetUsdPerHour
  if (budget !== Math.max(primary.maxPricePerHourUsd, fallback?.maxPricePerHourUsd ?? 0)) document.scaling!.workerBudgetUsdPerHour = budget
  // Reject a document that the shared rules would refuse, before writing it.
  resolveCapacityManager(applyCapacityDocument(intent, document))
  writeCapacityDocument(root, document)
  return {document, warnings}
}

/** After capacity-manager preparation: start capacity.yaml when this deployment's controller credentials are managed here. */
export function createCapacityDocumentAfterPreparation(root: string): string[] {
  const controller = readDstackControllerConfig(localPath(root, '.data/doge-config.toml'))
  if (!controller || controller.enabled === false || !readDstackCredentials(root)) return []
  return createCapacityDocument(root)?.warnings ?? []
}
