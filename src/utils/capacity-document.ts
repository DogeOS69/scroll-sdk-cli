import * as yaml from 'js-yaml'
import fs from 'node:fs'

import type {CapacityDocument, CapacityPool} from '../types/capacity.js'
import type {CapacityManagerConfig} from '../types/capacity-manager.js'
import type {DeploymentSpec} from '../types/deployment-spec.js'

import {CAPACITY_API_VERSION} from '../types/capacity.js'
import {validateDstackAwsBackend} from './dstack-credentials.js'
import {localPath} from './preparation-io.js'

/** Runtime capacity of a prepared deployment, next to `values/`. */
export const CAPACITY_DOCUMENT = 'capacity.yaml'
export const CAPACITY_PROVIDERS = ['aws', 'vastai'] as const
export type CapacityProvider = typeof CAPACITY_PROVIDERS[number]

type Mapping = Record<string, unknown>

function mapping(value: unknown, label: string, keys: readonly string[], required: readonly string[] = []): Mapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a mapping`)
  const result = value as Mapping
  const unknown = Object.keys(result).filter(key => !keys.includes(key))
  if (unknown.length > 0) throw new Error(`${label} has unsupported fields: ${unknown.join(', ')}`)
  const missing = required.filter(key => result[key] === undefined)
  if (missing.length > 0) throw new Error(`${label} requires ${missing.join(', ')}`)
  return result
}

function integer(value: unknown, label: string, minimum: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < minimum)) throw new Error(`${label} must be an integer >= ${minimum}`)
}

function price(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) throw new Error(`${label} must be a positive number`)
}

function validatePool(value: unknown, label: string, document: CapacityDocument): CapacityPool {
  const pool = mapping(value, label, ['fleet', 'gpu', 'instanceTypes', 'maxPricePerHourUsd', 'minReliability', 'provider', 'regions'], ['fleet', 'gpu', 'maxPricePerHourUsd', 'provider', 'regions']) as unknown as CapacityPool
  if (!CAPACITY_PROVIDERS.includes(pool.provider)) throw new Error(`${label}.provider must be aws or vastai`)
  if (!Array.isArray(pool.regions) || pool.regions.length === 0 || pool.regions.some(region => typeof region !== 'string')) throw new Error(`${label}.regions must list at least one region`)
  if (!document.providers[pool.provider]) throw new Error(`${label}.provider ${pool.provider} is not configured under providers`)
  if (pool.provider === 'aws') {
    const missing = pool.regions.filter(region => !document.providers.aws!.vpcIds[region])
    if (missing.length > 0) throw new Error(`${label}.regions need a VPC ID under providers.aws.vpcIds: ${missing.join(', ')}`)
  }

  price(pool.maxPricePerHourUsd, `${label}.maxPricePerHourUsd`)
  if (pool.minReliability !== undefined && pool.provider !== 'vastai') throw new Error(`${label}.minReliability applies only to Vast.ai`)
  return pool
}

/** Structural checks; budget, GPU and price rules are shared with the spec through resolveCapacityManager. */
export function validateCapacityDocument(input: unknown): CapacityDocument {
  const document = mapping(input, CAPACITY_DOCUMENT, ['apiVersion', 'fallback', 'primary', 'project', 'providers', 'resources', 'runtimeEstimates', 'scaling'], ['apiVersion', 'primary', 'project', 'providers']) as unknown as CapacityDocument
  if (document.apiVersion !== CAPACITY_API_VERSION) throw new Error(`${CAPACITY_DOCUMENT} apiVersion must be ${CAPACITY_API_VERSION}`)
  if (typeof document.project !== 'string' || !/^[\w-]{1,50}$/.test(document.project)) throw new Error(`${CAPACITY_DOCUMENT} project must be a dstack project name`)
  const providers = mapping(document.providers, 'providers', CAPACITY_PROVIDERS)
  if (Object.keys(providers).length === 0) throw new Error('providers must configure at least one provider')
  if (providers.vastai !== undefined) {
    const vast = mapping(providers.vastai, 'providers.vastai', ['apiKeyEnv'], ['apiKeyEnv'])
    if (typeof vast.apiKeyEnv !== 'string' || !/^[A-Z_a-z]\w*$/.test(vast.apiKeyEnv)) throw new Error('providers.vastai.apiKeyEnv must name an environment variable')
  }

  if (providers.aws !== undefined) {
    mapping(providers.aws, 'providers.aws', ['iamInstanceProfile', 'publicIps', 'vpcIds'], ['vpcIds'])
    validateDstackAwsBackend(document.providers.aws)
  }

  const primary = validatePool(document.primary, 'primary', document)
  if (document.fallback !== undefined && validatePool(document.fallback, 'fallback', document).fleet === primary.fleet) throw new Error('fallback.fleet must differ from primary.fleet')

  if (document.resources !== undefined) {
    const resources = mapping(document.resources, 'resources', ['cpus', 'diskGiB', 'idleSeconds', 'memoryGiB'])
    for (const [key, value] of Object.entries(resources)) integer(value, `resources.${key}`, key === 'idleSeconds' ? 0 : 1)
  }

  if (document.scaling !== undefined) {
    const scaling = mapping(document.scaling, 'scaling', ['maxHourlyCostUsd', 'maxWorkers', 'minWorkers', 'scaleDownTtlSeconds', 'steadyStateFloor', 'targetDrainSeconds', 'workerBudgetUsdPerHour'])
    for (const key of ['maxWorkers', 'minWorkers', 'scaleDownTtlSeconds', 'steadyStateFloor', 'targetDrainSeconds']) integer(scaling[key], `scaling.${key}`, 0)
    for (const key of ['maxHourlyCostUsd', 'workerBudgetUsdPerHour']) price(scaling[key], `scaling.${key}`)
  }

  if (document.runtimeEstimates !== undefined) mapping(document.runtimeEstimates, 'runtimeEstimates', ['bridgeStateSeconds', 'l2RangeAggregationSeconds', 'scrollBatchSeconds', 'scrollChunkSeconds'])
  return document
}

export function readCapacityDocument(root: string): CapacityDocument | undefined {
  const file = localPath(root, CAPACITY_DOCUMENT)
  if (!fs.existsSync(file)) return undefined
  let parsed: unknown
  try {parsed = yaml.load(fs.readFileSync(file, 'utf8'))} catch {throw new Error(`Invalid ${CAPACITY_DOCUMENT} YAML; correct its syntax and retry`)}
  return validateCapacityDocument(parsed)
}

/** Reading order for operators: where, which providers, which pools, then tuning. */
const DOCUMENT_ORDER = ['apiVersion', 'project', 'providers', 'primary', 'fallback', 'resources', 'scaling', 'runtimeEstimates']

export function writeCapacityDocument(root: string, document: CapacityDocument): void {
  validateCapacityDocument(document)
  const ordered = Object.fromEntries(DOCUMENT_ORDER.filter(key => key in document).map(key => [key, document[key as keyof CapacityDocument]]))
  fs.writeFileSync(localPath(root, CAPACITY_DOCUMENT), '# Runtime GPU capacity. Edit, then run scrollsdk capacity deploy (docs/capacity.md).\n'
    + '# Holds environment variable names only; credential values stay in the private environment file.\n'
    + yaml.dump(ordered, {lineWidth: -1, noRefs: true}), {mode: 0o644})
}

/**
 * The capacity document as the spec's capacityManager. Release and transport
 * inputs (manager image, connection, worker ID prefix) stay with the intent.
 */
export function capacityManagerFromDocument(document: CapacityDocument, base: CapacityManagerConfig): CapacityManagerConfig {
  const {fallback, primary, resources, scaling} = document
  return {
    ...(base.connection ? {connection: base.connection} : {}),
    ...(fallback ? {fallback: {fleet: fallback.fleet, gpu: fallback.gpu, ...(fallback.instanceTypes ? {instanceTypes: fallback.instanceTypes} : {}), maxPricePerHourUsd: fallback.maxPricePerHourUsd, ...(fallback.minReliability === undefined ? {} : {minReliability: fallback.minReliability}), provider: fallback.provider, regions: fallback.regions}} : {}),
    fleet: {action: base.fleet?.action ?? 'create', cpus: resources?.cpus, diskSizeGiB: resources?.diskGiB, idleDurationSeconds: resources?.idleSeconds, memoryGiB: resources?.memoryGiB},
    fleets: [primary.fleet],
    gpu: primary.gpu,
    image: base.image,
    ...(primary.instanceTypes ? {instanceTypes: primary.instanceTypes} : {}),
    maxHourlyCostUsd: scaling?.maxHourlyCostUsd,
    maxPricePerHourUsd: primary.maxPricePerHourUsd,
    maxWorkers: scaling?.maxWorkers,
    minReliability: primary.minReliability,
    minWorkers: scaling?.minWorkers,
    project: document.project,
    provider: primary.provider,
    regions: primary.regions,
    runtimeEstimates: document.runtimeEstimates,
    scaleDownTtlSeconds: scaling?.scaleDownTtlSeconds,
    steadyStateFloor: scaling?.steadyStateFloor,
    targetDrainSeconds: scaling?.targetDrainSeconds,
    workerBudgetUsdPerHour: scaling?.workerBudgetUsdPerHour,
    ...(base.workerIdPrefix ? {workerIdPrefix: base.workerIdPrefix} : {}),
  }
}

/**
 * The spec with capacity taken from the document. Providers belong to the
 * document, so the plan-time provider import is not consulted.
 */
export function applyCapacityDocument(spec: DeploymentSpec, document: CapacityDocument): DeploymentSpec {
  if (!spec.capacityManager) throw new Error('capacity.yaml requires a deployment prepared with capacityManager')
  const config = capacityManagerFromDocument(document, spec.capacityManager)
  for (const key of Object.keys(config) as Array<keyof CapacityManagerConfig>) if (config[key] === undefined) delete config[key]
  for (const key of Object.keys(config.fleet!) as Array<keyof NonNullable<CapacityManagerConfig['fleet']>>) if (config.fleet![key] === undefined) delete config.fleet![key]
  return {...spec, capacityManager: config, preparation: spec.preparation ? {...spec.preparation, dstack: {mode: 'external'}} : spec.preparation}
}
