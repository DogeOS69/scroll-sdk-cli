import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {ProofCoordinatorConfig} from '../types/deployment-spec.js'
import type {DogeConfig, Network} from '../types/doge-config.js'
import type {ProofTopologySpec} from '../types/proof-topology.js'
import type {PreTsukiDirectSignIntent} from './pre-tsuki-direct-sign.js'
import type {ProofSystemMode} from './proof-system-mode.js'

import {
  loadDeploymentSpec,
  resolveDeploymentSpecEnvRefs,
  resolveEnvRefsDeep,
  validateDeploymentSpec,
} from './deployment-spec-generator.js'
import {
  proofReleaseManifestSha256,
  readProofRelease,
  verifyProofTopologyReleaseBinding,
} from './proof-release.js'

export const DEFAULT_DEPLOYMENT_SPEC_FILES = [
  'deployment-spec.yaml',
  'deployment-spec.yml',
] as const
export const DEFAULT_DOGE_CONFIG_FILE = '.data/doge-config.toml'

export interface ProofTopologyIntent {
  mode: ProofSystemMode
  preTsukiDirectSign?: PreTsukiDirectSignIntent
}

export interface ProofIntentSource {
  kind: 'deployment-spec' | 'doge-config'
  path: string
  sha256: string
}

/**
 * Deployment-neutral proof input consumed by the compiler and Kubernetes
 * adapter. DeploymentSpec and doge-config are only source adapters for this
 * canonical representation.
 */
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

function isMapping(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertKnownKeys(value: unknown, keys: readonly string[], label: string): void {
  if (!isMapping(value)) throw new Error(`${label} must be a TOML table`)
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`)
  }
}

function assertDogeTopologyShape(value: unknown, source: string): void {
  const label = `${source}: proof_topology`
  assertKnownKeys(value, ['compiler', 'deployment', 'mock', 'mode', 'production', 'recovery'], label)
  const topology = value as Record<string, unknown>
  assertKnownKeys(topology.compiler, ['image'], `${label}.compiler`)
  const compiler = topology.compiler as Record<string, unknown>
  assertKnownKeys(compiler.image, ['digest', 'repository'], `${label}.compiler.image`)
  if (topology.deployment !== undefined) {
    assertKnownKeys(topology.deployment, [
      'artifactLocalRoot',
      'bridgeStagedAppConfig',
      'bridgeStagedAppExe',
      'coordinatorId',
      'generatedMaterialsRoot',
      'proofWorkBind',
      'proofWorkPublicUrl',
      'proofWorkTokenFile',
      'protocolContextPath',
      'protocolContextSource',
      'proverBind',
      'proverPublicUrl',
      'readinessEvidencePath',
      'resourcesMountPath',
      'resourcesPersistentVolumeClaim',
      'workerNodeSelector',
      'workerResources',
      'workerRuntimeClassName',
      'workerSecretName',
      'workerTokenFile',
      'workerTolerations',
    ], `${label}.deployment`)
    const deployment = topology.deployment as Record<string, unknown>
    if (deployment.workerResources !== undefined) {
      assertKnownKeys(
        deployment.workerResources,
        ['limits', 'requests'],
        `${label}.deployment.workerResources`,
      )
    }

    if (deployment.workerTolerations !== undefined) {
      if (!Array.isArray(deployment.workerTolerations)) {
        throw new TypeError(`${label}.deployment.workerTolerations must be an array`)
      }

      for (const [index, toleration] of deployment.workerTolerations.entries()) {
        assertKnownKeys(
          toleration,
          ['effect', 'key', 'operator', 'tolerationSeconds', 'value'],
          `${label}.deployment.workerTolerations[${index}]`,
        )
      }
    }
  }

  const artifactStoreKeys = [
    'bucket',
    'endpointUrl',
    'forcePathStyle',
    'keyPrefix',
    'kind',
    'maxReadBodyBytes',
    'region',
  ]
  const realScrollKeys = [
    'aggVerifyingKeyPath',
    'batchAppConfig',
    'batchAppExe',
    'batchBackendProfile',
    'batchMaterializerBinaryPath',
    'batchParallelism',
    'batchProgramCommitmentHashHex',
    'batchProgramCommitmentHex',
    'batchProverRequirements',
    'batchVerificationKeyHashHex',
    'bridgeAppCommitRawHex',
    'bridgeProgramCommitmentHashHex',
    'bridgeVerificationKeyHashHex',
    'chunkAppConfig',
    'chunkAppExe',
    'chunkBackendProfile',
    'chunkBlockWitnessDir',
    'chunkMaterializerBinaryPath',
    'chunkMaterializerTimeoutMs',
    'chunkParallelism',
    'chunkProgramCommitmentHashHex',
    'chunkProgramCommitmentHex',
    'chunkProverRequirements',
    'chunkVerificationKeyHashHex',
    'chunkWitnessRpcUrl',
    'chunkWitnessSource',
    'l2RangeAggregationAppCommitRawHex',
    'l2RangeAggregationProgramCommitmentHashHex',
    'l2RangeAggregationVerificationKeyHashHex',
    'proofCoordinatorPublicUrl',
    'regtestPinnedGenesisSequencerOutpoint',
    'resourcesRoot',
    's3PublicEndpointUrl',
    'workerId',
    'workerMaxBodyBytes',
  ]
  for (const profileName of ['mock', 'production']) {
    const rawProfile = topology[profileName]
    if (rawProfile === undefined) continue
    assertKnownKeys(
      rawProfile,
      [
        'artifactStore',
        'profile',
        'realScroll',
        'workerImage',
        ...(profileName === 'production' ? ['workerLaunch'] : []),
      ],
      `${label}.${profileName}`,
    )
    const profile = rawProfile as Record<string, unknown>
    if (profile.artifactStore !== undefined) {
      assertKnownKeys(
        profile.artifactStore,
        artifactStoreKeys,
        `${label}.${profileName}.artifactStore`,
      )
    }

    if (profile.workerImage !== undefined) {
      assertKnownKeys(
        profile.workerImage,
        ['digest', 'repository'],
        `${label}.${profileName}.workerImage`,
      )
    }

    if (profile.realScroll !== undefined) {
      assertKnownKeys(
        profile.realScroll,
        realScrollKeys,
        `${label}.${profileName}.realScroll`,
      )
    }
  }

  if (topology.recovery !== undefined) {
    assertKnownKeys(
      topology.recovery,
      ['preTsukiDirectSignMaxEndBatchHeight'],
      `${label}.recovery`,
    )
  }
}

function specDeclaresProofTopology(filePath: string): boolean {
  const parsed = yaml.load(fs.readFileSync(filePath, 'utf8'))
  return isMapping(parsed)
    && (parsed.proofTopology !== undefined || parsed.proofSystem !== undefined)
}

function discoverDeploymentSpecAuthority(
  deploymentDir: string,
  explicitSpecPath?: string,
): string | undefined {
  if (explicitSpecPath) {
    const resolved = path.resolve(deploymentDir, explicitSpecPath)
    if (!fs.existsSync(resolved)) throw new Error(`DeploymentSpec file not found: ${resolved}`)
    if (!specDeclaresProofTopology(resolved)) {
      throw new Error(`${resolved}: proofTopology is required when --spec is used for proof configuration`)
    }

    return resolved
  }

  const authorities = DEFAULT_DEPLOYMENT_SPEC_FILES
    .map(file => path.resolve(deploymentDir, file))
    .filter(file => fs.existsSync(file) && specDeclaresProofTopology(file))
  if (authorities.length > 1) {
    throw new Error(
      `Multiple conventional DeploymentSpec proof authorities found: ${authorities.join(', ')}. `
      + 'Keep proofTopology in exactly one source.',
    )
  }

  return authorities[0]
}

function readDogeConfig(filePath: string): DogeConfig | undefined {
  if (!fs.existsSync(filePath)) return undefined
  const parsed = toml.parse(fs.readFileSync(filePath, 'utf8')) as unknown
  if (!isMapping(parsed)) throw new Error(`${filePath}: doge-config must be a TOML table`)
  return parsed as unknown as DogeConfig
}

function assertImage(
  image: {digest?: string; repository?: string} | undefined,
  label: string,
): void {
  if (!image?.repository?.trim()) throw new Error(`${label}.repository is required`)
  if (!image.digest || !/^sha256:[\da-f]{64}$/.test(image.digest)) {
    throw new Error(`${label}.digest must match sha256:[0-9a-f]{64}`)
  }
}

function validateDogeTopology(topology: ProofTopologySpec, network: Network, source: string): string[] {
  if (!['disabled', 'mock', 'production'].includes(topology.mode)) {
    throw new Error(`${source}: proof_topology.mode must be disabled, mock, or production`)
  }

  assertImage(topology.compiler?.image, `${source}: proof_topology.compiler.image`)
  const selected = topology.mode === 'mock'
    ? topology.mock
    : topology.mode === 'production'
      ? topology.production
      : undefined
  if (topology.mode !== 'disabled' && !selected) {
    throw new Error(`${source}: proof_topology.${topology.mode} is required by the selected mode`)
  }

  if (selected) assertImage(selected.workerImage, `${source}: proof_topology.${topology.mode}.workerImage`)
  if (
    topology.production
    && !['external', 'local_cpu', 'local_cuda'].includes(topology.production.workerLaunch)
  ) {
    throw new Error(
      `${source}: proof_topology.production.workerLaunch must be external, local_cpu, or local_cuda`,
    )
  }

  const recoveryPin = topology.recovery?.preTsukiDirectSignMaxEndBatchHeight
  if (
    topology.recovery
    && (!Number.isSafeInteger(recoveryPin) || recoveryPin! < 1 || recoveryPin! > 4_294_967_295)
  ) {
    throw new Error(
      `${source}: proof_topology.recovery.preTsukiDirectSignMaxEndBatchHeight must be an integer in 1..=4294967295`,
    )
  }

  if (topology.recovery && topology.mode !== 'disabled') {
    throw new Error(`${source}: proof_topology.recovery requires disabled mode`)
  }

  if (topology.recovery && network === 'mainnet') {
    throw new Error(`${source}: proof_topology.recovery is testnet-only`)
  }

  const warnings: string[] = []
  if (!topology.mock) {
    warnings.push('proof_topology.mock is not staged; a later mode-only switch to mock will fail preflight')
  }

  if (!topology.production) {
    warnings.push('proof_topology.production is not staged; a later mode-only switch to production will fail preflight')
  }

  return warnings
}

function fromDeploymentSpec(specPath: string): ResolvedProofIntent {
  const deploymentSpec = resolveDeploymentSpecEnvRefs(loadDeploymentSpec(specPath))
  const validation = validateDeploymentSpec(deploymentSpec)
  if (!validation.valid) {
    throw new Error(
      `${specPath}: DeploymentSpec validation failed:\n${validation.errors
        .map(error => `- ${error.path}: ${error.message}`)
        .join('\n')}`,
    )
  }

  const topology = deploymentSpec.proofTopology
  if (!topology) throw new Error(`${specPath}: proofTopology is required`)
  const proverHost = deploymentSpec.frontend.hosts.proofCoordinator
  return {
    deploymentName: deploymentSpec.metadata.name,
    intent: {
      mode: topology.mode,
      ...(topology.recovery
        ? {
            preTsukiDirectSign: {
              maxEndBatchHeight: topology.recovery.preTsukiDirectSignMaxEndBatchHeight,
            },
          }
        : {}),
    },
    network: deploymentSpec.dogecoin.network,
    proofCoordinator: deploymentSpec.proofCoordinator,
    proofTopology: topology,
    ...(proverHost
      ? {proverPublicUrl: `${deploymentSpec.frontend.protocol || 'https'}://${proverHost}`}
      : {}),
    source: {kind: 'deployment-spec', path: specPath, sha256: sha256File(specPath)},
    warnings: validation.warnings.map(warning => `${warning.path}: ${warning.message}`),
  }
}

function verifyDogeProofRelease(
  rawConfig: DogeConfig,
  topology: ProofTopologySpec,
  deploymentDir: string,
  configPath: string,
): string[] {
  const binding = rawConfig.proof_release
  if (!binding) {
    return [
      'proof_release is not recorded; rerun scrollsdk setup doge-config --proof-topology '
      + 'to bind release images, identities, and material hashes',
    ]
  }

  assertKnownKeys(
    binding,
    ['manifestPath', 'manifestSha256', 'releaseId'],
    `${configPath}: proof_release`,
  )
  if (!/^[\da-f]{64}$/.test(binding.manifestSha256)) {
    throw new Error(`${configPath}: proof_release.manifestSha256 must be lowercase SHA-256 hex`)
  }

  const manifestPath = path.resolve(deploymentDir, binding.manifestPath)
  const actualDigest = proofReleaseManifestSha256(manifestPath)
  if (actualDigest !== binding.manifestSha256) {
    throw new Error(
      `${configPath}: proof release manifest changed: expected ${binding.manifestSha256}, `
      + `got ${actualDigest} for ${manifestPath}`,
    )
  }

  const release = readProofRelease(manifestPath)
  if (release.releaseId !== binding.releaseId) {
    throw new Error(
      `${configPath}: proof_release.releaseId ${binding.releaseId} does not match `
      + `${release.releaseId} in ${manifestPath}`,
    )
  }

  verifyProofTopologyReleaseBinding(topology, release, deploymentDir)
  return []
}

function fromDogeConfig(
  configPath: string,
  rawConfig: DogeConfig,
  deploymentDir: string,
): ResolvedProofIntent {
  const {network} = rawConfig
  if (!['mainnet', 'regtest', 'testnet'].includes(network)) {
    throw new Error(`${configPath}: top-level network must be mainnet, testnet, or regtest`)
  }

  const rawTopology = rawConfig.proof_topology
  if (!rawTopology) throw new Error(`${configPath}: [proof_topology] is required`)
  assertDogeTopologyShape(rawTopology, configPath)
  const topology = resolveEnvRefsDeep(rawTopology) as ProofTopologySpec
  const warnings = [
    ...validateDogeTopology(topology, network, configPath),
    ...verifyDogeProofRelease(rawConfig, topology, deploymentDir, configPath),
  ]
  return {
    deploymentName: `dogeos-${network}`,
    intent: {
      mode: topology.mode,
      ...(topology.recovery
        ? {
            preTsukiDirectSign: {
              maxEndBatchHeight: topology.recovery.preTsukiDirectSignMaxEndBatchHeight,
            },
          }
        : {}),
    },
    network,
    proofTopology: topology,
    source: {kind: 'doge-config', path: configPath, sha256: sha256File(configPath)},
    warnings,
  }
}

interface ResolveProofIntentOptions {
  deploymentDir?: string
  dogeConfig?: DogeConfig
  dogeConfigPath?: string
  required?: boolean
  specPath?: string
}

export function resolveProofIntent(
  options: {required: false} & ResolveProofIntentOptions,
): ResolvedProofIntent | undefined
export function resolveProofIntent(
  options: {required?: true} & ResolveProofIntentOptions,
): ResolvedProofIntent
export function resolveProofIntent(
  options: ResolveProofIntentOptions,
): ResolvedProofIntent | undefined {
  const deploymentDir = path.resolve(options.deploymentDir || '.')
  const configPath = path.resolve(
    deploymentDir,
    options.dogeConfigPath || DEFAULT_DOGE_CONFIG_FILE,
  )
  const dogeConfig = options.dogeConfig || readDogeConfig(configPath)
  const dogeAuthority = Boolean(dogeConfig?.proof_topology)
  const specPath = discoverDeploymentSpecAuthority(deploymentDir, options.specPath)

  if (dogeAuthority && specPath) {
    throw new Error(
      `Conflicting proof topology sources:\n- ${configPath}: [proof_topology]\n`
      + `- ${specPath}: proofTopology\nKeep proof topology in exactly one source.`,
    )
  }

  if (specPath) return fromDeploymentSpec(specPath)
  if (dogeAuthority && dogeConfig) return fromDogeConfig(configPath, dogeConfig, deploymentDir)
  if (options.required !== false) {
    throw new Error(
      `proof topology is not configured; add [proof_topology] to ${configPath} `
      + 'or add proofTopology to one DeploymentSpec',
    )
  }

  return undefined
}
