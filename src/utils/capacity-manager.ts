/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and compiled deployment documents. */
import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import {isDeepStrictEqual} from 'node:util'

import type {CapacityManagerConfig} from '../types/capacity-manager.js'
import type {DeploymentSpec} from '../types/deployment-spec.js'
import type {ProofProgramPublicationV1} from '../types/proof-program-publication.js'
import type {ProofWorkerImageCheckV1} from '../types/proof-worker-image-check.js'
import type {ProverWorkerContractV1} from './proof-topology-compiler.js'

import {digest, localPath, writeJson} from './preparation-io.js'
import {resolveContractFile, validateProofDeploymentContract} from './proof-deployment-contract.js'
import {workerCommand} from './proof-workers-plan.js'
import {mergeBootstrapValues} from './spec-bootstrap.js'

export const CAPACITY_MANAGER_VALUES = 'values/capacity-manager-production.yaml'
export const CAPACITY_MANAGER_PLAN = '.scrollsdk/capacity-manager/plan.json'
const architectures = {A100: '80', A6000: '86', L4: '89', RTX3090: '86', RTX4090: '89'}

export function resolveCapacityManager(spec: DeploymentSpec): Required<CapacityManagerConfig> {
  const input = spec.capacityManager
  if (!input) throw new Error('Declare capacityManager in the deployment spec')
  if (spec.proofWorkers) throw new Error('capacityManager and proofWorkers are mutually exclusive; retire the SDK session before switching')
  if (!spec.dstackController || spec.dstackController.enabled === false || spec.proofTopology?.mode !== 'active' || spec.proofTopology.generation !== 'real') throw new Error('capacityManager requires enabled dstackController and active real proving')
  const wpUrl = new URL(spec.proofTopology.deployment.proofWorkPublicUrl ?? 'http://withdrawal-processor:9300')
  if (!['http:', 'https:'].includes(wpUrl.protocol) || wpUrl.username || wpUrl.password || wpUrl.search || wpUrl.hash) throw new Error('capacityManager requires a credential-free WP HTTP endpoint')
  const config = {...input, instanceTypes: input.instanceTypes ?? [], maxHourlyCostUsd: input.maxHourlyCostUsd ?? (input.provider === 'aws' ? 3 : 1.6), maxPricePerHourUsd: input.maxPricePerHourUsd ?? (input.provider === 'aws' ? 1.5 : 0.8), maxWorkers: input.maxWorkers ?? 2, minWorkers: input.minWorkers ?? 1, scaleDownTtlSeconds: input.scaleDownTtlSeconds ?? 300, targetDrainSeconds: input.targetDrainSeconds ?? 600, workerIdPrefix: input.workerIdPrefix ?? `cm-${digest(spec.metadata.name).slice(0, 16)}`}
  if (!['aws', 'vastai'].includes(config.provider) || !Object.hasOwn(architectures, config.gpu)) throw new Error('Unsupported capacityManager provider/GPU')
  if (!config.image?.repository || !/^[\w./:-]+$/.test(config.image.repository) || !/^sha256:[\da-f]{64}$/.test(config.image.digest)) throw new Error('capacityManager.image must select a published immutable capacity-manager binary image')
  if (!/^[a-z][\da-z-]{0,29}$/.test(config.workerIdPrefix)) throw new Error('capacityManager.workerIdPrefix must be a lowercase resource prefix, at most 30 characters')
  for (const [key, values] of Object.entries({fleets: config.fleets, instanceTypes: config.instanceTypes, project: [config.project], regions: config.regions})) {
    if (!Array.isArray(values) || (key !== 'instanceTypes' && values.length === 0) || values.some(v => typeof v !== 'string' || !/^[\da-z][\w.-]*$/.test(v))) throw new Error(`capacityManager.${key} must contain explicit resource names`)
  }

  for (const key of ['maxWorkers', 'minWorkers', 'scaleDownTtlSeconds', 'targetDrainSeconds'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < (key === 'minWorkers' || key === 'scaleDownTtlSeconds' ? 0 : 1)) throw new Error(`capacityManager.${key} has an invalid integer value`)
  }

  // Core's dstack adapter reserves eight extra slots and caps the inventory at 1024.
  if (config.maxWorkers > 1016 || config.minWorkers > config.maxWorkers) throw new Error('capacityManager worker bounds exceed Core capacity or minWorkers exceeds maxWorkers')
  for (const key of ['maxPricePerHourUsd', 'maxHourlyCostUsd'] as const) if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`capacityManager.${key} must be positive and finite`)
  if (config.maxHourlyCostUsd < config.maxPricePerHourUsd * config.minWorkers) throw new Error('capacityManager hourly budget cannot fund its minimum workers at the selected price ceiling')
  return config
}

export function assertSdkWorkersRetired(root: string): void {
  const state = localPath(root, '.scrollsdk/proof-workers/state.json')
  const plan = localPath(root, '.scrollsdk/proof-workers/plan.json')
  if (fs.existsSync(plan) && (!fs.existsSync(state) || JSON.parse(fs.readFileSync(state, 'utf8')).status !== 'destroyed')) throw new Error('Retire the existing SDK proof-workers session with status/destroy before preparing capacity-manager')
}

export function buildCapacityManagerValues(spec: DeploymentSpec, worker: ProverWorkerContractV1, publication: ProofProgramPublicationV1, imageCheck: ProofWorkerImageCheckV1): Record<string, any> {
  const config = resolveCapacityManager(spec)
  if (!/^sha256:[\da-f]{64}$/.test(worker.image.digest) || worker.required_build_class !== 'production' || !isDeepStrictEqual(worker.image, imageCheck.image) || !imageCheck.cudaArchitectures.includes(architectures[config.gpu])) throw new Error('capacityManager GPU/image does not match the checked production Worker')
  if (publication.verification.anonymousHttpReadback !== 'passed' || publication.verification.authenticatedS3Readback !== 'passed') throw new Error('Publish and verify Worker artifacts before preparing capacity-manager')
  const families = Object.fromEntries([['scroll_chunk', 60], ['scroll_batch', 300], ['l2_range_aggregation', 1800], ['bridge_state', 1800]].map(([name, seconds]) => [name, {max_workers: config.maxWorkers, min_vram_gib: 16, min_workers: 0, runtime_seconds: seconds}]))
  const policy = {families, global: {liveness_floor: config.minWorkers, max_workers: config.maxWorkers, scale_down_ttl_seconds: config.scaleDownTtlSeconds, steady_state_floor: 1, target_drain_seconds: config.targetDrainSeconds}, pool: {gpu_class: config.gpu, hourly_cost_usd_per_worker: config.maxPricePerHourUsd, max_hourly_cost_usd: config.maxHourlyCostUsd, max_workers: config.maxWorkers, provider: config.provider, provider_diversity_min: 1, vram_gib: config.gpu === 'L4' ? 22 : 24}}
  return {image: config.image, manager: {dstack: {fleets: config.fleets, instanceTypes: config.instanceTypes, maxPricePerHourUsd: config.maxPricePerHourUsd, project: config.project, regions: config.regions}, policy: toml.stringify(policy as any), proofWorkBaseUrl: spec.proofTopology!.deployment.proofWorkPublicUrl ?? 'http://withdrawal-processor:9300', workerCommand: workerCommand(worker, publication, '{worker_id}', architectures[config.gpu]), workerIdPrefix: config.workerIdPrefix, workerImage: `${worker.image.repository}@${worker.image.digest}`, workerTokenSecret: `cm_worker_${digest(config.workerIdPrefix).slice(0, 16)}`}, prepared: true}
}

export function prepareCapacityManager(root: string, readContract = validateProofDeploymentContract): {namespace: string; project: string; valuesFile: string} {
  const spec = JSON.parse(fs.readFileSync(localPath(root, '.scrollsdk/intent.json'), 'utf8')) as DeploymentSpec
  resolveCapacityManager(spec)
  assertSdkWorkersRetired(root)
  const contract = readContract(root)
  if (contract.mode !== 'active' || contract.generation !== 'real' || !contract.worker.contractFile || !contract.inputs?.publication) throw new Error('capacity-manager requires compiled active/real topology and published Worker artifacts')
  const read = (file: string) => JSON.parse(fs.readFileSync(resolveContractFile(root, file), 'utf8'))
  const projected = buildCapacityManagerValues(spec, read(contract.worker.contractFile), read(contract.inputs.publication.path), read('.data/proof-worker-image-check-v1.json'))
  const file = localPath(root, CAPACITY_MANAGER_VALUES)
  if (!fs.existsSync(file)) throw new Error('Copy the capacity-manager production values template from the matching SDK checkout before preparation')
  const controller = yaml.load(fs.readFileSync(localPath(root, 'values/dstack-controller-production.yaml'), 'utf8')) as any
  const coordinator = yaml.load(fs.readFileSync(localPath(root, contract.components.proofCoordinator.valuesFile), 'utf8')) as any
  const dstackNamespace = spec.dstackController?.monitoring?.namespace ?? 'dstack-system'
  const dstackName = controller.fullnameOverride ?? 'dstack-controller'
  projected.manager.dstack.serverUrl = `http://${dstackName}.${dstackNamespace}.svc:${controller.service?.port ?? 3000}`
  projected.wpAuth = {existingSecret: coordinator.persistence.secrets.name, key: 'proof-work-token'}
  const content = mergeBootstrapValues(fs.readFileSync(file, 'utf8'), yaml.dump(projected))
  const values = yaml.load(content) as any
  // Fixed, separately named manager: deployment/selector and Secret destination are a shared contract.
  if (values.fullnameOverride !== 'capacity-manager' || values.dstackAuth.existingSecret !== 'capacity-manager-dstack-auth') throw new Error('Keep capacity-manager fullnameOverride and dstackAuth.existingSecret at their template names')
  const previousFile = localPath(root, CAPACITY_MANAGER_PLAN)
  const fingerprint = digest(JSON.stringify(projected))
  if (fs.existsSync(previousFile) && read(CAPACITY_MANAGER_PLAN).fingerprint !== fingerprint) throw new Error('Capacity configuration changed; drain the old manager and archive its local plan before preparing the replacement')
  const wpFile = localPath(root, contract.components.withdrawalProcessor.valuesFile)
  const wp = yaml.load(fs.readFileSync(wpFile, 'utf8')) as any
  if (!wp.networkPolicy?.enabled) throw new Error('Enable WP NetworkPolicy before preparing capacity-manager')
  wp.networkPolicy.allowFrom.capacityManager = [{podSelector: {matchLabels: {'app.kubernetes.io/name': 'capacity-manager'}}}]
  fs.writeFileSync(wpFile, yaml.dump(wp, {lineWidth: -1, noRefs: true}))
  fs.writeFileSync(file, content)
  writeJson(previousFile, {dstack: {auth: controller.auth, deployment: dstackName, namespace: dstackNamespace}, fingerprint, generationId: contract.generationId, namespace: spec.infrastructure.namespace ?? 'default', project: projected.manager.dstack.project, proofSecret: coordinator.persistence.secrets.name, schema: 'scrollsdk/capacity-manager/v1', valuesFile: CAPACITY_MANAGER_VALUES, workerSecret: spec.proofTopology?.deployment.workerSecretName ?? coordinator.persistence.secrets.name, workerTokenSecret: projected.manager.workerTokenSecret})
  return {namespace: spec.infrastructure.namespace ?? 'default', project: projected.manager.dstack.project, valuesFile: file}
}
