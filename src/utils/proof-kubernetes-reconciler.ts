import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {ProofTopologySpec} from '../types/proof-topology.js'
import type {CompiledProverWorkerBundleResult} from './compiled-prover-worker-bundle.js'
import type {ProofAwsConfig} from './proof-aws-config.js'
import type {ResolvedProofIntent} from './proof-intent.js'

import {
  PRE_TSUKI_DIRECT_SIGN_TSO_ENV,
  assertPreTsukiDirectSignPosture,
} from './pre-tsuki-direct-sign.js'
import {
  DEFAULT_PROOF_AWS_CONFIG,
  proofAwsValuesProjection,
  readOptionalProofAwsConfig,
} from './proof-aws-config.js'
import {applyProofAwsValues} from './proof-aws-provisioner.js'
import {
  type ProofDeploymentContract,
  writeProofDeploymentContract,
} from './proof-deployment-contract.js'
import {DEFAULT_PROOF_COORDINATOR_CONFIG} from './proof-signer-policy-input.js'
import {
  type ProofTopologyBridgeContext,
  type ProofTopologyRolloutPlanV1,
} from './proof-topology-compiler.js'
import {reconcileCompiledProofTopology} from './proof-topology-kubernetes-adapter.js'
import {WITHDRAWAL_NATIVE_CONFIG_RELPATH} from './withdrawal-config.js'

export interface ReconcileProofKubernetesOptions {
  coordinatorConfigPath?: string
  coordinatorIngressHost?: string
  deploymentDir?: string
  ethereumL1RpcUrl?: string
  intent: ResolvedProofIntent
  network?: string
  proofAwsConfigPath?: string
  proofTopologyBridge?: ProofTopologyBridgeContext
  proofTopologyCompilerBinary?: string
  proofTopologyCompilerImage?: string
  valuesDir?: string
  withdrawalConfigPath?: string
}

export interface ReconcileProofKubernetesResult {
  contract: ProofDeploymentContract
  files: string[]
  mode: ResolvedProofIntent['intent']['mode']
  proofAwsConfigPath?: string
  rolloutPlan: ProofTopologyRolloutPlanV1
  workerBundle?: CompiledProverWorkerBundleResult
}

function readValues(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) throw new Error(`proof values template not found: ${filePath}`)
  const value = yaml.load(fs.readFileSync(filePath, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`proof values template must be a YAML mapping: ${filePath}`)
  }

  return value as Record<string, unknown>
}

function writeValues(filePath: string, value: Record<string, unknown>): void {
  fs.writeFileSync(filePath, yaml.dump(value, {lineWidth: -1, noRefs: true}))
}

function projectTsoPreTsukiDirectSignPin(filePath: string, pin?: number): void {
  const values = readValues(filePath)
  const env = values.env ?? []
  if (!Array.isArray(env)) throw new Error(`${filePath}: env must be an array`)
  const projected = env.filter(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true
    return String((item as {name?: unknown}).name || '') !== PRE_TSUKI_DIRECT_SIGN_TSO_ENV
  })
  if (pin !== undefined) projected.push({name: PRE_TSUKI_DIRECT_SIGN_TSO_ENV, value: String(pin)})
  values.env = projected
  writeValues(filePath, values)
}

export function projectProofAwsConfig(
  deploymentDir: string,
  valuesDir: string,
  configPath?: string,
): string | undefined {
  const loaded = readOptionalProofAwsConfig(
    deploymentDir,
    configPath || DEFAULT_PROOF_AWS_CONFIG,
  )
  if (!loaded) return undefined

  const coordinatorValuesPath = path.join(valuesDir, 'proof-coordinator-production.yaml')
  const withdrawalValuesPath = path.join(valuesDir, 'withdrawal-processor-production.yaml')
  const coordinatorValues = readValues(coordinatorValuesPath)
  const withdrawalValues = readValues(withdrawalValuesPath)
  applyProofAwsValues(
    coordinatorValues,
    withdrawalValues,
    proofAwsValuesProjection(loaded.config),
  )
  writeValues(coordinatorValuesPath, coordinatorValues)
  writeValues(withdrawalValuesPath, withdrawalValues)
  return loaded.configPath
}

function normalizedKeyPrefix(value: string): string {
  return value.trim().replaceAll(/^\/+|\/+$/g, '')
}

/** Fail before compilation when staged topology coordinates disagree with provisioned AWS facts. */
export function assertProofAwsMatchesTopology(
  topology: ProofTopologySpec,
  proofAws: ProofAwsConfig,
): void {
  for (const [profileName, profile] of [
    ['mock', topology.mock],
    ['production', topology.production],
  ] as const) {
    const store = profile?.artifactStore
    if (!store || store.kind !== 's3_compatible') continue
    for (const [field, actual, expected] of [
      ['bucket', store.bucket, proofAws.artifactStore.bucket],
      ['region', store.region, proofAws.artifactStore.region],
      [
        'keyPrefix',
        store.keyPrefix && normalizedKeyPrefix(store.keyPrefix),
        normalizedKeyPrefix(proofAws.artifactStore.keyPrefix),
      ],
    ] as const) {
      if (actual !== expected) {
        throw new Error(
          `proofTopology.${profileName}.artifactStore.${field} (${String(actual)}) does not match `
          + `.data/proof-aws.json (${expected}); update the staged profile or provision matching resources`,
        )
      }
    }
  }
}

/** Compile one resolved proof topology and project its strict service configs. */
export function reconcileProofKubernetes(
  options: ReconcileProofKubernetesOptions,
): ReconcileProofKubernetesResult {
  const deploymentDir = path.resolve(options.deploymentDir || '.')
  const valuesDir = path.resolve(options.valuesDir || path.join(deploymentDir, 'values'))
  const coordinatorConfigPath = path.resolve(
    options.coordinatorConfigPath
    || path.join(deploymentDir, DEFAULT_PROOF_COORDINATOR_CONFIG),
  )
  const withdrawalConfigPath = path.resolve(
    options.withdrawalConfigPath
    || path.join(deploymentDir, WITHDRAWAL_NATIVE_CONFIG_RELPATH),
  )
  const tsoValuesFile = path.join(valuesDir, 'tso-service-production.yaml')
  if (!fs.existsSync(tsoValuesFile)) throw new Error(`TSO values file not found: ${tsoValuesFile}`)

  const {mode, preTsukiDirectSign} = options.intent.intent
  assertPreTsukiDirectSignPosture({
    mode,
    network: options.network,
    preTsukiDirectSign,
    source: options.intent.source.path,
  })

  const loadedProofAws = readOptionalProofAwsConfig(
    deploymentDir,
    options.proofAwsConfigPath || DEFAULT_PROOF_AWS_CONFIG,
  )
  if (loadedProofAws) {
    assertProofAwsMatchesTopology(options.intent.proofTopology, loadedProofAws.config)
  }

  const proofAwsConfigPath = projectProofAwsConfig(
    deploymentDir,
    valuesDir,
    options.proofAwsConfigPath,
  )
  projectTsoPreTsukiDirectSignPin(tsoValuesFile, preTsukiDirectSign?.maxEndBatchHeight)

  const compiled = reconcileCompiledProofTopology({
    bridge: options.proofTopologyBridge,
    compilerBinary: options.proofTopologyCompilerBinary,
    compilerImage: options.proofTopologyCompilerImage,
    coordinatorConfigPath,
    coordinatorIngressHost: options.coordinatorIngressHost,
    deploymentDir,
    deploymentName: options.intent.deploymentName,
    ethereumL1RpcUrl: options.ethereumL1RpcUrl,
    network: options.intent.network,
    proofCoordinator: options.intent.proofCoordinator,
    proofTopology: options.intent.proofTopology,
    proverPublicUrl: options.intent.proverPublicUrl,
    valuesDir,
    withdrawalConfigPath,
  })
  const disabled = mode === 'disabled'
  const workerContractFile = compiled.bundle.manifest.prover_worker
    ? path.join(compiled.bundle.bundleDir, compiled.bundle.manifest.prover_worker)
    : undefined
  const contract = writeProofDeploymentContract({
    deploymentDir,
    ethDaSubmitter: {valuesFile: compiled.ethDaSubmitterValuesPath},
    intentSource: options.intent.source,
    mode,
    preTsukiDirectSign,
    proofArtifactBaseUrl: compiled.proofArtifactBaseUrl,
    proofCoordinator: {
      enabled: !disabled,
      setFiles: compiled.helmSetFiles.proofCoordinator,
      valuesFile: path.join(valuesDir, 'proof-coordinator-production.yaml'),
    },
    proverWorker: {
      enabled: compiled.worker?.desired_state === 'local_deployment',
      setFiles: compiled.helmSetFiles.proverWorker,
      valuesFile: path.join(valuesDir, 'prover-worker-production.yaml'),
    },
    topology: {
      bundleDir: compiled.bundle.bundleDir,
      bundleManifest: path.join(compiled.bundle.bundleDir, 'bundle-manifest-v1.json'),
      deploymentRevision: compiled.bundle.plan.to_deployment_revision,
      digest: compiled.bundle.plan.to_digest,
      resolvedSidecar: path.join(
        compiled.bundle.bundleDir,
        compiled.bundle.manifest.resolved_sidecar,
      ),
      rolloutPlan: path.join(compiled.bundle.bundleDir, compiled.bundle.manifest.rollout_plan),
    },
    tsoValuesFile,
    withdrawalProcessor: {
      enabled: true,
      setFiles: compiled.helmSetFiles.withdrawalProcessor,
      valuesFile: path.join(valuesDir, 'withdrawal-processor-production.yaml'),
    },
    worker: compiled.worker && workerContractFile
      ? {
          bundleDir: compiled.workerBundle?.bundleDir,
          bundleId: compiled.workerBundle?.bundleId,
          contractFile: workerContractFile,
          kind: compiled.worker.desired_state === 'external'
            ? 'compiled-external'
            : 'compiled-local',
        }
      : undefined,
  })

  return {
    contract,
    files: compiled.files,
    mode,
    ...(proofAwsConfigPath ? {proofAwsConfigPath} : {}),
    rolloutPlan: compiled.bundle.plan,
    ...(compiled.workerBundle ? {workerBundle: compiled.workerBundle} : {}),
  }
}
