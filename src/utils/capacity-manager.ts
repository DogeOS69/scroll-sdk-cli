/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and compiled deployment documents. */
import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'

import type {CapacityManagerConfig} from '../types/capacity-manager.js'
import type {DeploymentSpec} from '../types/deployment-spec.js'
import type {ProofProgramPublicationV1} from '../types/proof-program-publication.js'
import type {ProofWorkerImageCheckV1} from '../types/proof-worker-image-check.js'
import type {ProverWorkerContractV1} from './proof-topology-compiler.js'

import {capacityConnectionUrl, validateCapacityConnection} from './capacity-manager-network.js'
import {workerLaunch} from './capacity-manager-worker.js'
import {DSTACK_CONTROLLER_IMAGE} from './dstack-controller-values.js'
import {validateDstackAwsBackend} from './dstack-credentials.js'
import {assertDstackInternalIngress} from './dstack-internal-tls.js'
import {GenerationTransaction} from './generation-transaction.js'
import {dstackAwsIntent, withPreparedDstackAws} from './preparation-dstack-aws.js'
import {digest, localPath, writeJson} from './preparation-io.js'
import {DEFAULT_PROOF_DEPLOYMENT_CONTRACT, readProofDeploymentContract, resolveContractFile, validateProofDeploymentContract} from './proof-deployment-contract.js'
import {assertCapacityChartVersions, loadSdkTemplateFiles, mergeBootstrapValues} from './spec-bootstrap.js'
import {bindMakefileTarget, specDstackController, specKubernetesTarget} from './spec-kubernetes-target.js'

export const CAPACITY_MANAGER_VALUES = 'values/capacity-manager-production.yaml'
export const CAPACITY_MANAGER_PLAN = '.scrollsdk/capacity-manager/plan.json'
const CAPACITY_MANAGER_CONFIG = '.scrollsdk/capacity-manager/config.json'
// Include only capacity inputs/outputs; workflow locks, env and receipts stay excluded.
export const CAPACITY_MANAGER_STATE_PATHS = ['.scrollsdk/intent.json', '.scrollsdk/plan.json', '.scrollsdk/proof-workers/plan.json', '.scrollsdk/proof-workers/state.json', '.scrollsdk/capacity-manager'] as const

export function parseCapacityInput<T>(content: string, label: string, parse: (content: string) => T): T {
  try {return parse(content)} catch {
    // YAML and JSON parser errors can include credential-bearing source excerpts.
    throw new Error(`Invalid ${label}; correct its syntax and retry (private contents omitted)`)
  }
}

function readCapacitySpec(file: string, label: string, parse: (content: string) => unknown): DeploymentSpec {
  return parseCapacityInput(fs.readFileSync(file, 'utf8'), label, parse) as DeploymentSpec
}

export function capacitySpec(root: string): DeploymentSpec {
  if (fs.existsSync(localPath(root, CAPACITY_MANAGER_CONFIG))) throw new Error('Separate capacity-manager config is no longer supported; restore the saved deployment intent and use setup render')
  return withPreparedDstackAws(root, readCapacitySpec(localPath(root, '.scrollsdk/intent.json'), 'frozen intent (.scrollsdk/intent.json)', JSON.parse))
}

const architectures = {A10G: '86', A100: '80', A6000: '86', L4: '89', L40S: '89', RTX3090: '86', RTX4090: '89'}

/** Match Core's transport boundary and preserve the operator's TLS endpoint. */
export function capacityManagerDstackUrl(value: unknown): string {
  const fail = (): never => {throw new Error('capacity-manager: set manager.dstack.serverUrl in values/capacity-manager-production.yaml to a verified HTTPS controller endpoint (HTTP is allowed only on an IP loopback address)')}
  if (typeof value !== 'string' || !value || /[\s\\]|<[^>]+>|\$env:/i.test(value)) return fail()
  let url: URL
  try {url = new URL(value)} catch {return fail()}
  const loopback = /^127(?:\.\d+){3}$/.test(url.hostname) || url.hostname === '[::1]'
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || !url.hostname || url.username || url.password || value.includes('?') || value.includes('#')) return fail()
  return value
}

export function resolveCapacityManager(spec: DeploymentSpec): {fleet: Required<NonNullable<CapacityManagerConfig['fleet']>>} & {runtimeEstimates: Required<NonNullable<CapacityManagerConfig['runtimeEstimates']>>} & Pick<CapacityManagerConfig, 'connection' | 'fallback'> & Required<Omit<CapacityManagerConfig, 'connection' | 'fallback' | 'fleet' | 'runtimeEstimates'>> {
  const input = spec.capacityManager
  if (!input) throw new Error('Declare capacityManager in the deployment spec')
  if ('proofWorkers' in spec) throw new Error('proofWorkers has been removed; select capacityManager in the deployment spec')
  if (!spec.dstackController || spec.dstackController.enabled === false || spec.proofTopology?.mode !== 'active' || spec.proofTopology.generation !== 'real') throw new Error('capacityManager requires enabled dstackController and active real proving')
  const wpUrl = new URL(spec.proofTopology.deployment.proofWorkPublicUrl ?? 'http://withdrawal-processor:9300')
  if (!['http:', 'https:'].includes(wpUrl.protocol) || wpUrl.username || wpUrl.password || wpUrl.search || wpUrl.hash) throw new Error('capacityManager requires a credential-free WP HTTP endpoint')
  validateCapacityConnection(input.connection)
  const runtimeEstimates = {bridgeStateSeconds: 1800, l2RangeAggregationSeconds: 1800, scrollBatchSeconds: 300, scrollChunkSeconds: 60, ...input.runtimeEstimates}
  for (const value of Object.values(runtimeEstimates)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('capacityManager.runtimeEstimates must contain positive integer seconds')
  const fleet = {action: input.fleet?.action ?? 'create', cpus: input.fleet?.cpus ?? 16, diskSizeGiB: input.fleet?.diskSizeGiB ?? 200, idleDurationSeconds: input.fleet?.idleDurationSeconds ?? 600, memoryGiB: input.fleet?.memoryGiB ?? (input.gpu === 'L40S' ? 128 : 64)}
  const config = {...input, fleet, instanceTypes: input.instanceTypes ?? [], maxHourlyCostUsd: input.maxHourlyCostUsd ?? (input.provider === 'aws' ? 3 : 1.6), maxPricePerHourUsd: input.maxPricePerHourUsd ?? (input.provider === 'aws' ? 1.5 : 0.8), maxWorkers: input.maxWorkers ?? 2, minReliability: input.minReliability ?? 0.95, minWorkers: input.minWorkers ?? 1, runtimeEstimates, scaleDownTtlSeconds: input.scaleDownTtlSeconds ?? 300, targetDrainSeconds: input.targetDrainSeconds ?? 600, workerIdPrefix: input.workerIdPrefix ?? `cm-${digest(spec.metadata.name).slice(0, 16)}`}
  if (!['aws', 'vastai'].includes(config.provider) || !Object.hasOwn(architectures, config.gpu)) throw new Error('Unsupported capacityManager provider/GPU')
  if (!config.image?.repository || !/^[\w./:-]+$/.test(config.image.repository) || !/^sha256:[\da-f]{64}$/.test(config.image.digest)) throw new Error('capacityManager.image must select a published immutable capacity-manager binary image')
  if (!/^[a-z][\da-z-]{0,29}$/.test(config.workerIdPrefix)) throw new Error('capacityManager.workerIdPrefix must be a lowercase resource prefix, at most 30 characters')
  for (const [key, values] of Object.entries({fleets: config.fleets, instanceTypes: config.instanceTypes, project: [config.project], regions: config.regions})) {
    if (!Array.isArray(values) || (key !== 'instanceTypes' && values.length === 0) || values.some(v => typeof v !== 'string' || !/^[\da-z][\w.-]*$/.test(v))) throw new Error(`capacityManager.${key} must contain explicit resource names`)
  }

  if (!['create', 'reuse'].includes(fleet.action)) throw new Error('capacityManager.fleet.action must be create or reuse')
  for (const key of ['cpus', 'diskSizeGiB', 'idleDurationSeconds', 'memoryGiB'] as const) if (!Number.isSafeInteger(fleet[key]) || fleet[key] < (key === 'idleDurationSeconds' ? 0 : 1)) throw new Error(`capacityManager.fleet.${key} must be a valid integer`)
  if (new Set(config.fleets).size !== config.fleets.length || config.fleets.some(name => !/^[a-z](?:[\da-z-]{0,61}[\da-z])?$/.test(name))) throw new Error('capacityManager.fleets must contain unique lowercase fleet names')
  const preparation = spec.preparation?.dstack
  if (preparation?.project && preparation.project !== config.project) throw new Error('preparation.dstack.project must match capacityManager.project; omit the duplicate project setting')
  if (preparation?.mode === 'import') {
    if (!preparation.providers?.includes(config.provider)) throw new Error('preparation.dstack.providers must include the capacityManager provider')
    if (config.provider === 'aws') {
      validateDstackAwsBackend(preparation.aws)
      if (config.regions.some(region => !preparation.aws!.vpcIds[region])) throw new Error('Every capacityManager AWS region requires an explicit dstack VPC ID')
      // Importing the AWS provider always prepares or verifies the controller role.
      dstackAwsIntent(spec)
    }
  }

  for (const key of ['maxWorkers', 'minWorkers', 'scaleDownTtlSeconds', 'targetDrainSeconds'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < (key === 'minWorkers' || key === 'scaleDownTtlSeconds' ? 0 : 1)) throw new Error(`capacityManager.${key} has an invalid integer value`)
  }

  if (!Number.isFinite(config.minReliability) || config.minReliability < 0.95 || config.minReliability > 1) throw new Error('capacityManager.minReliability must be between 0.95 and 1')

  // Core's dstack adapter reserves eight extra slots and caps the inventory at 1024.
  if (config.maxWorkers > 1016 || config.minWorkers > config.maxWorkers) throw new Error('capacityManager worker bounds exceed Core capacity or minWorkers exceeds maxWorkers')
  for (const key of ['maxPricePerHourUsd', 'maxHourlyCostUsd'] as const) if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`capacityManager.${key} must be positive and finite`)
  if (config.maxHourlyCostUsd < config.maxPricePerHourUsd * config.minWorkers) throw new Error('capacityManager hourly budget cannot fund its minimum workers at the selected price ceiling')
  if (config.fallback) {
    const {fallback} = config
    if (config.provider !== 'aws' || fallback.provider !== 'vastai') throw new Error('capacityManager.fallback requires AWS primary and Vast fallback')
    if (config.fleets.includes(fallback.fleet)) throw new Error('Fallback fleet must be distinct from primary fleets')
    if (!Number.isFinite(fallback.maxPricePerHourUsd) || fallback.maxPricePerHourUsd <= 0 || fallback.maxPricePerHourUsd > config.maxPricePerHourUsd) throw new Error('Fallback price must be positive and no greater than the primary per-worker budget estimate')
    resolveCapacityManager(fallbackSpec(spec))
    const vram = {A10G: 22, A100: 40, A6000: 48, L4: 22, L40S: 44, RTX3090: 24, RTX4090: 24}
    const required = ['A10G', 'L4'].includes(config.gpu) ? 22 : config.gpu === 'L40S' ? 44 : 24
    if (vram[fallback.gpu] < required) throw new Error('Fallback GPU does not meet the primary policy VRAM requirement')
  }

  return config
}

function fallbackSpec(spec: DeploymentSpec): DeploymentSpec {
  const primary = spec.capacityManager!
  const fallback = primary.fallback!
  return {...spec, capacityManager: {...primary, fallback: undefined, fleet: {...primary.fleet, memoryGiB: primary.fleet?.memoryGiB ?? (primary.gpu === 'L40S' ? 128 : 64)}, fleets: [fallback.fleet], gpu: fallback.gpu, instanceTypes: [], maxHourlyCostUsd: primary.maxHourlyCostUsd ?? 3, maxPricePerHourUsd: fallback.maxPricePerHourUsd, minReliability: fallback.minReliability ?? primary.minReliability, provider: fallback.provider, regions: fallback.regions}}
}

/** Reviewable dstack 0.21.5 fleet intent; preparation never requests initial instances. */
export function capacityManagerFleets(spec: DeploymentSpec): {action: 'create' | 'reuse'; configurations: Record<string, any>[]} {
  const config = resolveCapacityManager(spec)
  const configurations = config.fleets.map(name => ({
    ...(config.provider === 'vastai' ? {backend_options: [{min_reliability: config.minReliability, offer_order: 'price', type: 'vastai'}]} : {}),
    backends: [config.provider],
    idle_duration: `${config.fleet.idleDurationSeconds}s`,
    ...(config.instanceTypes.length > 0 ? {instance_types: config.instanceTypes} : {}),
    max_price: config.maxPricePerHourUsd,
    name,
    nodes: {max: config.maxWorkers, min: 0, target: 0},
    regions: config.regions,
    resources: {cpu: `${config.fleet.cpus}..`, disk: {size: `${config.fleet.diskSizeGiB}GB..`}, gpu: {count: 1, name: [config.gpu], vendor: 'nvidia'}, memory: `${config.fleet.memoryGiB}GB..`},
    spot_policy: 'on-demand',
    type: 'fleet',
  }))
  if (config.fallback) configurations.push(...capacityManagerFleets(fallbackSpec(spec)).configurations as typeof configurations)
  return {action: config.fleet.action, configurations}
}

export function assertSdkWorkersRetired(root: string): void {
  const state = localPath(root, '.scrollsdk/proof-workers/state.json')
  const plan = localPath(root, '.scrollsdk/proof-workers/plan.json')
  if (fs.existsSync(plan) && (!fs.existsSync(state) || parseCapacityInput(fs.readFileSync(state, 'utf8'), 'proof-worker state JSON', JSON.parse).status !== 'destroyed')) throw new Error('A legacy manual worker session is still recorded. Retire its remote resources with the original tooling before activating Capacity Manager')
}

/** Keep operator tuning unless the spec explicitly owns the same field. */
export function preserveCapacityTuning(spec: DeploymentSpec, values: any, existing: any): void {
  const intent = spec.capacityManager!
  const oldPolicy = existing.manager?.policy ? toml.parse(existing.manager.policy) as any : {}
  const policy = toml.parse(values.manager.policy) as any
  for (const [family, field] of [['scroll_chunk', 'scrollChunkSeconds'], ['scroll_batch', 'scrollBatchSeconds'], ['l2_range_aggregation', 'l2RangeAggregationSeconds'], ['bridge_state', 'bridgeStateSeconds']] as const) {
    const value = oldPolicy.families?.[family]?.runtime_seconds
    if (intent.runtimeEstimates?.[field] === undefined && value !== undefined) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Capacity runtime estimates must be positive seconds')
      policy.families[family].runtime_seconds = value
    }
  }

  for (const [field, key] of [['targetDrainSeconds', 'target_drain_seconds'], ['scaleDownTtlSeconds', 'scale_down_ttl_seconds']] as const) {
    const value = oldPolicy.global?.[key]
    if (intent[field] === undefined && value !== undefined) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Capacity drain/scale-down tuning must be positive seconds')
      policy.global[key] = value
    }
  }

  values.manager.policy = toml.stringify(policy)
  for (const fleet of values.initialization?.fleets ?? []) {
    const old = existing.initialization?.fleets?.find((item: any) => item.name === fleet.name)
    if (!old) continue
    for (const [field, key] of [['cpus', 'cpu'], ['memoryGiB', 'memory'], ['diskSizeGiB', 'disk']] as const) {
      if (intent.fleet?.[field] === undefined && old.resources?.[key] !== undefined) fleet.resources[key] = structuredClone(old.resources[key])
    }

    if (intent.fleet?.idleDurationSeconds === undefined && old.idle_duration !== undefined) fleet.idle_duration = old.idle_duration
  }
}

export function buildCapacityManagerValues(spec: DeploymentSpec, worker: ProverWorkerContractV1, publication: ProofProgramPublicationV1, imageCheck: ProofWorkerImageCheckV1): Record<string, any> {
  const config = resolveCapacityManager(spec)
  if (!/^sha256:[\da-f]{64}$/.test(worker.image.digest) || worker.required_build_class !== 'production' || !isDeepStrictEqual(worker.image, imageCheck.image) || !imageCheck.cudaArchitectures.includes(architectures[config.gpu])) throw new Error('capacityManager GPU/image does not match the checked production Worker')
  if (publication.verification.anonymousHttpReadback !== 'passed' || publication.verification.authenticatedS3Readback !== 'passed') throw new Error('Publish and verify Worker artifacts before preparing capacity-manager')
  const families = Object.fromEntries([['scroll_chunk', config.runtimeEstimates.scrollChunkSeconds], ['scroll_batch', config.runtimeEstimates.scrollBatchSeconds], ['l2_range_aggregation', config.runtimeEstimates.l2RangeAggregationSeconds], ['bridge_state', config.runtimeEstimates.bridgeStateSeconds]].map(([name, seconds]) => [name, {max_workers: config.maxWorkers, min_vram_gib: 16, min_workers: 0, runtime_seconds: seconds}]))
  const policy = {families, global: {liveness_floor: config.minWorkers, max_workers: config.maxWorkers, scale_down_ttl_seconds: config.scaleDownTtlSeconds, steady_state_floor: 1, target_drain_seconds: config.targetDrainSeconds}, pool: {gpu_class: config.gpu, hourly_cost_usd_per_worker: config.maxPricePerHourUsd, max_hourly_cost_usd: config.maxHourlyCostUsd, max_workers: config.maxWorkers, provider: config.provider, provider_diversity_min: 1, vram_gib: ['A10G', 'L4'].includes(config.gpu) ? 22 : config.gpu === 'L40S' ? 44 : 24}}
  const selectedArchitectures = [architectures[config.gpu], ...(config.fallback ? [architectures[config.fallback.gpu]] : [])]
  if (selectedArchitectures.some(architecture => !imageCheck.cudaArchitectures.includes(architecture))) throw new Error('Fallback GPU/image does not match the checked production Worker')
  const launch = workerLaunch(worker, publication, '{worker_id}', selectedArchitectures)
  return {image: config.image, manager: {dstack: {fallbackFleet: config.fallback?.fleet ?? '', fleets: config.fleets, instanceTypes: config.instanceTypes, maxPricePerHourUsd: config.maxPricePerHourUsd, project: config.project, regions: config.regions}, policy: toml.stringify(policy as any), proofWorkBaseUrl: spec.proofTopology!.deployment.proofWorkPublicUrl ?? 'http://withdrawal-processor:9300', workerCommand: launch.command, workerEnv: launch.env, workerIdPrefix: config.workerIdPrefix, workerImage: `${worker.image.repository}@${worker.image.digest}`}, prepared: true}
}

export function prepareCapacityManager(root: string, readContract = validateProofDeploymentContract): {namespace: string; project: string; valuesFile: string} {
  const transaction = GenerationTransaction.begin(root, CAPACITY_MANAGER_STATE_PATHS)
  try {
    const result = prepareCapacityManagerInDirectory(transaction.stagingRoot, readContract)
    const valuesFile = transaction.toOriginalPath(result.valuesFile)
    transaction.commit()
    return {...result, valuesFile}
  } catch (error) {
    transaction.rollback()
    throw error
  }
}

function prepareCapacityManagerInDirectory(root: string, readContract: typeof validateProofDeploymentContract): {namespace: string; project: string; valuesFile: string} {
  const spec = capacitySpec(root)
  resolveCapacityManager(spec)
  assertSdkWorkersRetired(root)
  const contract = readContract(root)
  if (contract.mode !== 'active' || contract.generation !== 'real' || !contract.worker.contractFile || !contract.inputs?.publication) throw new Error('capacity-manager requires compiled active/real topology and published Worker artifacts')
  const read = (file: string) => parseCapacityInput(fs.readFileSync(resolveContractFile(root, file), 'utf8'), file, JSON.parse)
  const projected = buildCapacityManagerValues(spec, read(contract.worker.contractFile), read(contract.inputs.publication.path), read('.data/proof-worker-image-check-v1.json'))
  const file = localPath(root, CAPACITY_MANAGER_VALUES)
  let template: string
  if (fs.existsSync(file)) template = fs.readFileSync(file, 'utf8')
  else {
    const planFile = localPath(root, '.scrollsdk/plan.json')
    const sdkDirectory = fs.existsSync(planFile) ? read('.scrollsdk/plan.json').sdkDirectory : undefined
    if (!sdkDirectory || !spec.templates?.sdkRevision) throw new Error('Missing capacity-manager values: restore the saved SDK checkout with the frozen templates.sdkRevision available')
    template = loadSdkTemplateFiles(path.resolve(sdkDirectory), spec.templates.sdkRevision).files[CAPACITY_MANAGER_VALUES]
    if (!template) throw new Error('Pinned SDK revision lacks capacity-manager production values')
  }

  const readValues = (file: string) => parseCapacityInput(fs.readFileSync(localPath(root, file), 'utf8'), file, yaml.load) as any
  const controller = readValues('values/dstack-controller-production.yaml')
  const coordinator = readValues(contract.components.proofCoordinator.valuesFile)
  specDstackController(spec)
  const dstackNamespace = specKubernetesTarget(spec).namespace
  const dstackName = controller.fullnameOverride ?? 'dstack-controller'
  const existing = parseCapacityInput(template, 'capacity-manager values YAML', yaml.load) as any
  if (spec.capacityManager?.connection && spec.dstackController?.internalTls) throw new Error('Select one dstack TLS owner: capacityManager.connection or dstackController.internalTls')
  if (spec.capacityManager?.connection?.mode === 'existing-alb' && controller.ingress?.enabled) throw new Error('Disable dstack Ingress before selecting the separately managed internal ALB')
  if (spec.dstackController?.internalTls) assertDstackInternalIngress(controller, spec.dstackController.internalTls)
  projected.manager.dstack.serverUrl = capacityManagerDstackUrl(spec.dstackController?.internalTls ? `https://${spec.dstackController.internalTls.hostname}` : capacityConnectionUrl(root, spec.capacityManager?.connection) ?? existing.manager?.dstack?.serverUrl)
  projected.dstackAuth = controller.auth
  if (!controller.auth?.existingSecret || !controller.auth?.key) throw new Error('Dstack auth Secret reference is required')
  projected.wpAuth = {existingSecret: coordinator.persistence.secrets.name, key: 'proof-work-token'}
  // dogeos-core #1598: the manager holds the coordinator's worker-credential
  // master and mints one credential per run. It is read from the coordinator's
  // own Secret, never from a worker Secret, and no dstack project secret is used.
  projected.workerCredentialMaster = {existingSecret: coordinator.persistence.secrets.name, key: 'prover-worker-token'}
  // Clear a shared-token binding kept from older generated values; the chart
  // refuses both modes at once.
  projected.manager.workerTokenSecret = ''
  const makefile = localPath(root, 'Makefile')
  if (fs.existsSync(makefile)) assertCapacityChartVersions(fs.readFileSync(makefile, 'utf8'), spec)

  const content = mergeBootstrapValues(template, yaml.dump(projected))
  const values = yaml.load(content) as any
  // Fixed, separately named manager: deployment/selector and Secret destination are a shared contract.
  if (values.fullnameOverride !== 'capacity-manager') throw new Error('Keep capacity-manager fullnameOverride at its template name')
  const planFile = localPath(root, CAPACITY_MANAGER_PLAN)
  const fleetIntent = capacityManagerFleets(spec)
  values.initialization = {
    enabled: true, fleetAction: fleetIntent.action, fleets: fleetIntent.configurations,
    image: DSTACK_CONTROLLER_IMAGE, provider: spec.capacityManager!.provider,
    ...(spec.capacityManager!.fallback ? {fallbackProvider: spec.capacityManager!.fallback.provider} : {}),
    privateDns: spec.capacityManager?.connection?.mode === 'existing-alb' || Boolean(spec.dstackController?.internalTls),
  }
  preserveCapacityTuning(spec, values, existing)
  if (spec.capacityManager?.connection?.mode === 'existing-alb') {
    const binding = read('.scrollsdk/capacity-manager/dstack-targetgroupbinding.json')
    controller.targetGroupBinding = binding.spec
    fs.writeFileSync(localPath(root, 'values/dstack-controller-production.yaml'), yaml.dump(controller, {lineWidth: -1, noRefs: true}))
  }

  const wpFile = localPath(root, contract.components.withdrawalProcessor.valuesFile)
  const wp = readValues(contract.components.withdrawalProcessor.valuesFile)
  if (!wp.networkPolicy?.enabled) throw new Error('Enable WP NetworkPolicy before preparing capacity-manager')
  wp.networkPolicy.allowFrom ??= {}
  wp.networkPolicy.allowFrom.capacityManager = [{podSelector: {matchLabels: {'app.kubernetes.io/name': 'capacity-manager'}}}]
  fs.writeFileSync(wpFile, yaml.dump(wp, {lineWidth: -1, noRefs: true}))
  fs.writeFileSync(file, yaml.dump(values, {lineWidth: -1, noRefs: true}))
  if (fs.existsSync(makefile)) fs.writeFileSync(makefile, bindMakefileTarget(fs.readFileSync(makefile, 'utf8'), spec))
  const fleetFiles = fleetIntent.configurations.map(configuration => {
    const relative = `.scrollsdk/capacity-manager/fleets/${configuration.name}.yaml`
    const content = yaml.dump(configuration, {lineWidth: -1, noRefs: true})
    fs.mkdirSync(localPath(root, '.scrollsdk/capacity-manager/fleets'), {recursive: true})
    fs.writeFileSync(localPath(root, relative), content)
    return {path: relative}
  })
  writeJson(planFile, {...specKubernetesTarget(spec), dstack: {auth: controller.auth, deployment: dstackName, namespace: dstackNamespace, serverUrl: projected.manager.dstack.serverUrl}, fleets: {action: fleetIntent.action, files: fleetFiles}, generationId: contract.generationId, namespace: spec.infrastructure.namespace ?? 'default', privateDns: spec.capacityManager?.connection?.mode === 'existing-alb' || Boolean(spec.dstackController?.internalTls), project: projected.manager.dstack.project, proofSecret: coordinator.persistence.secrets.name, ...(spec.capacityManager!.fallback ? {fallbackProvider: spec.capacityManager!.fallback.provider} : {}), provider: spec.capacityManager!.provider, schema: 'scrollsdk/capacity-manager/v1', valuesFile: CAPACITY_MANAGER_VALUES, workerCredentialMaster: projected.workerCredentialMaster})
  return {namespace: spec.infrastructure.namespace ?? 'default', project: projected.manager.dstack.project, valuesFile: file}
}

/** Called inside prep-charts' filesystem transaction, after proof reconciliation. */
export function prepareCapacityManagerIfSelected(root: string): void {
  const intent = localPath(root, '.scrollsdk/intent.json')
  if (!fs.existsSync(intent)) return
  const spec = capacitySpec(root)
  if (!spec.capacityManager) return
  // Initial proof rendering precedes publication. Final rendering must prepare it.
  if (!fs.existsSync(localPath(root, DEFAULT_PROOF_DEPLOYMENT_CONTRACT))) return
  if (!readProofDeploymentContract(root).contract.inputs?.publication) return
  prepareCapacityManagerInDirectory(root, validateProofDeploymentContract)
}
