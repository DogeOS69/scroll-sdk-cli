import * as toml from '@iarna/toml'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {ProofCoordinatorConfig} from '../types/deployment-spec.js'
import type {DogeConfig, Network} from '../types/doge-config.js'
import type {ProofTopologySpec} from '../types/proof-topology.js'

import {
  loadDeploymentSpec,
  resolveDeploymentSpecEnvRefs,
  resolveEnvRefsDeep,
  validateDeploymentSpec,
} from './deployment-spec-generator.js'

export const DEFAULT_DEPLOYMENT_SPEC_FILES = ['deployment-spec.yaml', 'deployment-spec.yml'] as const
export const DEFAULT_DOGE_CONFIG_FILE = '.data/doge-config.toml'

export interface ProofTopologyIntent {
  enforcement: ProofTopologySpec['enforcement']
  generation: ProofTopologySpec['generation']
  mode: ProofTopologySpec['mode']
}

export interface ProofIntentSource {
  kind: 'deployment-spec' | 'doge-config'
  path: string
  sha256: string
}

export interface ResolvedProofIntent {
  deploymentName: string
  intent: ProofTopologyIntent
  network: Network
  proofCoordinator?: ProofCoordinatorConfig
  proofTopology: ProofTopologySpec
  proverPublicUrl?: string
  source: ProofIntentSource
  warnings: string[]
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be a table`)
  return value as Record<string, unknown>
}

function known(value: unknown, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(mapping(value, label))) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is not supported`)
  }
}

function validateShape(value: unknown, source: string): void {
  const root = mapping(value, `${source}: proof_topology`)
  known(root, ['active', 'compiler', 'deployment', 'enforcement', 'generation', 'mode'], `${source}: proof_topology`)
  known(root.compiler, ['identityFilePath', 'image'], `${source}: proof_topology.compiler`)
  known(mapping(root.compiler, 'compiler').image, ['digest', 'repository'], `${source}: proof_topology.compiler.image`)
  known(root.deployment, [
    'artifactKeyPrefix', 'coordinatorId', 'generatedMaterialsRoot', 'l2GenesisJson',
    'mockWorkerImage', 'productionWorkerImage', 'proofWorkBind', 'proofWorkPublicUrl',
    'proofWorkTokenFile', 'protocolContextPath', 'proverBind', 'proverPublicUrl',
    'publicS3EndpointUrl', 'readinessEvidencePath', 'resourcesMountPath',
    'resourcesPersistentVolumeClaim', 'workerNodeSelector', 'workerResources',
    'workerDeploymentBackend', 'workerRuntimeClassName', 'workerSecretName',
    'workerTokenFile', 'workerTolerations',
  ], `${source}: proof_topology.deployment`)
  const deployment = mapping(root.deployment, 'deployment')
  known(deployment.mockWorkerImage, ['digest', 'repository'], `${source}: proof_topology.deployment.mockWorkerImage`)
  if (deployment.productionWorkerImage !== undefined) {
    known(deployment.productionWorkerImage, ['digest', 'repository'], `${source}: proof_topology.deployment.productionWorkerImage`)
  }

  if (root.active !== undefined) {
    known(root.active, ['artifactStore', 'profile', 'realScroll', 'workerLaunch'], `${source}: proof_topology.active`)
    const active = mapping(root.active, 'active')
    known(active.artifactStore, ['bucket', 'endpointUrl', 'forcePathStyle', 'kind', 'maxReadBodyBytes', 'region'], `${source}: proof_topology.active.artifactStore`)
    known(active.realScroll, [
      'aggVerifyingKeyPath', 'batchAppConfig', 'batchAppExe', 'batchBackendProfile',
      'batchMaterializerBinaryPath', 'batchParallelism', 'batchProgramCommitmentHashHex',
      'batchProgramCommitmentHex', 'batchProverRequirements', 'batchVerificationKeyHashHex',
      'bridgeAppCommitRawHex', 'bridgeProgramCommitmentHashHex', 'bridgeVerificationKeyHashHex',
      'chunkAppConfig', 'chunkAppExe', 'chunkBackendProfile', 'chunkBlockWitnessDir',
      'chunkMaterializerBinaryPath', 'chunkMaterializerTimeoutMs', 'chunkParallelism',
      'chunkProgramCommitmentHashHex', 'chunkProgramCommitmentHex', 'chunkProverRequirements',
      'chunkVerificationKeyHashHex', 'chunkWitnessRpcUrl', 'chunkWitnessSource',
      'l2RangeAggregationAppCommitRawHex', 'l2RangeAggregationProgramCommitmentHashHex',
      'l2RangeAggregationVerificationKeyHashHex', 'regtestPinnedGenesisSequencerOutpoint',
      'resourcesRoot', 'workerId', 'workerMaxBodyBytes',
    ], `${source}: proof_topology.active.realScroll`)
  }
}

function assertImage(value: {digest?: string; repository?: string} | undefined, label: string): void {
  if (!value?.repository?.trim() || !value.digest || !/^sha256:[\da-f]{64}$/.test(value.digest)) {
    throw new Error(`${label} must be a digest-pinned image`)
  }
}

function validateTopology(topology: ProofTopologySpec, source: string): void {
  if (!['active', 'disabled'].includes(topology.mode)) throw new Error(`${source}: mode must be active or disabled`)
  if (!['mock', 'real'].includes(topology.generation)) throw new Error(`${source}: generation must be mock or real`)
  if (!['enforce', 'observe'].includes(topology.enforcement)) throw new Error(`${source}: enforcement must be observe or enforce`)
  if (topology.enforcement === 'enforce' && topology.mode !== 'active') {
    throw new Error(`${source}: enforcement=enforce requires mode=active`)
  }

  if (topology.enforcement === 'enforce' && topology.generation !== 'real') {
    throw new Error(`${source}: enforcement=enforce requires generation=real`)
  }

  assertImage(topology.compiler?.image, `${source}: compiler.image`)
  if (!topology.compiler?.identityFilePath?.trim()) {
    throw new Error(`${source}: compiler.identityFilePath is required`)
  }
  assertImage(topology.deployment?.mockWorkerImage, `${source}: deployment.mockWorkerImage`)
  if (topology.deployment?.productionWorkerImage !== undefined) {
    assertImage(topology.deployment.productionWorkerImage, `${source}: deployment.productionWorkerImage`)
  }

  if (topology.generation === 'real') {
    assertImage(topology.deployment?.productionWorkerImage, `${source}: real generation requires deployment.productionWorkerImage`)
  }

  if (!topology.deployment?.artifactKeyPrefix?.trim()) throw new Error(`${source}: deployment.artifactKeyPrefix is required`)
  if (!topology.active) throw new Error(`${source}: active profile must be staged even while disabled`)
  if (topology.mode === 'active' && topology.generation === 'real' && !topology.active.profile.startsWith('real_scroll_')) {
    throw new Error(`${source}: real generation requires a real_scroll profile`)
  }
}

function fromDogeConfig(configPath: string, config: DogeConfig): ResolvedProofIntent {
  const raw = config.proof_topology
  if (!raw) throw new Error(`${configPath}: [proof_topology] is required`)
  validateShape(raw, configPath)
  const topology = resolveEnvRefsDeep(raw) as ProofTopologySpec
  validateTopology(topology, configPath)
  const coordinator = topology.deployment.coordinatorId
  return {
    deploymentName: coordinator?.endsWith('-proof-coordinator')
      ? coordinator.slice(0, -'-proof-coordinator'.length)
      : `dogeos-${config.network}`,
    intent: {enforcement: topology.enforcement, generation: topology.generation, mode: topology.mode},
    network: config.network,
    proofTopology: topology,
    proverPublicUrl: topology.deployment.proverPublicUrl,
    source: {kind: 'doge-config', path: configPath, sha256: sha256File(configPath)},
    warnings: [],
  }
}

function fromDeploymentSpec(specPath: string): ResolvedProofIntent {
  const spec = resolveDeploymentSpecEnvRefs(loadDeploymentSpec(specPath))
  const validation = validateDeploymentSpec(spec)
  if (!validation.valid) throw new Error(`${specPath}: ${validation.errors.map(error => `${error.path}: ${error.message}`).join('; ')}`)
  if (!spec.proofTopology) throw new Error(`${specPath}: proofTopology is required`)
  validateTopology(spec.proofTopology, specPath)
  const host = spec.frontend.hosts.proofCoordinator
  return {
    deploymentName: spec.metadata.name,
    intent: {
      enforcement: spec.proofTopology.enforcement,
      generation: spec.proofTopology.generation,
      mode: spec.proofTopology.mode,
    },
    network: spec.dogecoin.network,
    proofCoordinator: spec.proofCoordinator,
    proofTopology: spec.proofTopology,
    proverPublicUrl: host ? `${spec.frontend.protocol ?? 'https'}://${host}` : spec.proofTopology.deployment.proverPublicUrl,
    source: {kind: 'deployment-spec', path: specPath, sha256: sha256File(specPath)},
    warnings: validation.warnings.map(warning => `${warning.path}: ${warning.message}`),
  }
}

export function resolveProofIntent(options: {
  deploymentDir?: string
  dogeConfig?: DogeConfig
  dogeConfigPath?: string
  required?: boolean
  specPath?: string
}): ResolvedProofIntent | undefined {
  const deploymentDir = path.resolve(options.deploymentDir ?? '.')
  const configPath = path.resolve(deploymentDir, options.dogeConfigPath ?? DEFAULT_DOGE_CONFIG_FILE)
  const explicitSpec = options.specPath ? path.resolve(deploymentDir, options.specPath) : undefined
  if (explicitSpec) return fromDeploymentSpec(explicitSpec)
  if (options.dogeConfig?.proof_topology) return fromDogeConfig(configPath, options.dogeConfig)
  for (const name of DEFAULT_DEPLOYMENT_SPEC_FILES) {
    const candidate = path.join(deploymentDir, name)
    if (fs.existsSync(candidate)) {
      const raw = loadDeploymentSpec(candidate)
      if (raw.proofTopology) return fromDeploymentSpec(candidate)
    }
  }

  if (fs.existsSync(configPath)) {
    const parsed = toml.parse(fs.readFileSync(configPath, 'utf8')) as unknown as DogeConfig
    if (parsed.proof_topology) return fromDogeConfig(configPath, parsed)
  }

  if (options.required) throw new Error('No proof topology found; run scrollsdk setup doge-config --proof-topology')
  return undefined
}
