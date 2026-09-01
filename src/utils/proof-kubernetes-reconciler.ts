import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {ProofTopologySpec} from '../types/proof-topology.js'
import type {CompiledProverWorkerBundleResult} from './compiled-prover-worker-bundle.js'
import type {ProofAwsConfig} from './proof-aws-config.js'
import type {ProofDeploymentContract} from './proof-deployment-contract.js'
import type {ResolvedProofIntent} from './proof-intent.js'
import type {ProofTopologyEthereumDaBlobSource} from './proof-topology-compiler.js'

import {DEFAULT_PROOF_AWS_CONFIG, proofAwsValuesProjection, readOptionalProofAwsConfig} from './proof-aws-config.js'
import {applyProofAwsValues} from './proof-aws-provisioner.js'
import {writeProofDeploymentContract} from './proof-deployment-contract.js'
import {DEFAULT_PROOF_COORDINATOR_CONFIG} from './proof-signer-policy-input.js'
import {reconcileCompiledProofTopology} from './proof-topology-kubernetes-adapter.js'
import {WITHDRAWAL_NATIVE_CONFIG_RELPATH} from './withdrawal-config.js'

export interface ReconcileProofKubernetesOptions {
  coordinatorConfigPath?: string
  coordinatorIngressHost?: string
  deploymentDir?: string
  ethereumDaBlobSource?: ProofTopologyEthereumDaBlobSource
  ethereumL1RpcUrl?: string
  intent: ResolvedProofIntent
  network?: string
  proofAwsConfigPath?: string
  proofTopologyBridge?: {
    dogecoinNetwork: string
    dogecoinRpcPassword: string
    dogecoinRpcUrl: string
    dogecoinRpcUser: string
  }
  proofTopologyCompilerBinary?: string
  proofTopologyCompilerImage?: string
  valuesDir?: string
  withdrawalConfigPath?: string
}

export interface ReconcileProofKubernetesResult {
  bundleRevision: string
  contract: ProofDeploymentContract
  files: string[]
  mode: ProofTopologySpec['mode']
  proofAwsConfigPath?: string
  workerBundle?: CompiledProverWorkerBundleResult
}

function readValues(filePath: string): Record<string, unknown> {
  const parsed = yaml.load(fs.readFileSync(filePath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`values must be a YAML mapping: ${filePath}`)
  return parsed as Record<string, unknown>
}

function writeValues(filePath: string, value: Record<string, unknown>): void {
  fs.writeFileSync(filePath, yaml.dump(value, {lineWidth: -1, noRefs: true}))
}

export function projectProofAwsConfig(deploymentDir: string, valuesDir: string, configPath?: string): string | undefined {
  const loaded = readOptionalProofAwsConfig(deploymentDir, configPath || DEFAULT_PROOF_AWS_CONFIG)
  if (!loaded) return undefined
  const coordinatorPath = path.join(valuesDir, 'proof-coordinator-production.yaml')
  const withdrawalPath = path.join(valuesDir, 'withdrawal-processor-production.yaml')
  const coordinator = readValues(coordinatorPath)
  const withdrawal = readValues(withdrawalPath)
  applyProofAwsValues(coordinator, withdrawal, proofAwsValuesProjection(loaded.config))
  writeValues(coordinatorPath, coordinator)
  writeValues(withdrawalPath, withdrawal)
  return loaded.configPath
}

function normalizedPrefix(value: string): string {
  return value.trim().replaceAll(/^\/+|\/+$/g, '')
}

export function assertProofAwsMatchesTopology(topology: ProofTopologySpec, proofAws: ProofAwsConfig): void {
  const store = topology.active?.artifactStore
  if (!store || store.kind !== 's3_compatible') return
  for (const [field, actual, expected] of [
    ['bucket', store.bucket, proofAws.artifactStore.bucket],
    ['region', store.region, proofAws.artifactStore.region],
    ['keyPrefix', normalizedPrefix(topology.deployment.artifactKeyPrefix), normalizedPrefix(proofAws.artifactStore.keyPrefix)],
  ] as const) {
    if (actual !== expected) throw new Error(`proofTopology active artifact ${field} (${String(actual)}) does not match .data/proof-aws.json (${expected})`)
  }

  if (topology.deployment.publicS3EndpointUrl !== proofAws.artifactReadTransport.publicEndpointUrl) {
    throw new Error('proofTopology.deployment.publicS3EndpointUrl does not match .data/proof-aws.json')
  }
}

export function reconcileProofKubernetes(options: ReconcileProofKubernetesOptions): ReconcileProofKubernetesResult {
  const deploymentDir = path.resolve(options.deploymentDir || '.')
  const valuesDir = path.resolve(options.valuesDir || path.join(deploymentDir, 'values'))
  const coordinatorConfigPath = path.resolve(options.coordinatorConfigPath || path.join(deploymentDir, DEFAULT_PROOF_COORDINATOR_CONFIG))
  const withdrawalConfigPath = path.resolve(options.withdrawalConfigPath || path.join(deploymentDir, WITHDRAWAL_NATIVE_CONFIG_RELPATH))
  const proofAws = readOptionalProofAwsConfig(deploymentDir, options.proofAwsConfigPath || DEFAULT_PROOF_AWS_CONFIG)
  if (proofAws) assertProofAwsMatchesTopology(options.intent.proofTopology, proofAws.config)
  const proofAwsConfigPath = projectProofAwsConfig(deploymentDir, valuesDir, options.proofAwsConfigPath)
  const compiled = reconcileCompiledProofTopology({
    bridge: options.proofTopologyBridge,
    compilerBinary: options.proofTopologyCompilerBinary,
    compilerImage: options.proofTopologyCompilerImage,
    coordinatorConfigPath,
    coordinatorIngressHost: options.coordinatorIngressHost,
    deploymentDir,
    deploymentName: options.intent.deploymentName,
    ethereumDaBlobSource: options.ethereumDaBlobSource,
    ethereumL1RpcUrl: options.ethereumL1RpcUrl,
    network: options.intent.network,
    proofCoordinator: options.intent.proofCoordinator,
    proofTopology: options.intent.proofTopology,
    proverPublicUrl: options.intent.proverPublicUrl,
    valuesDir,
    withdrawalConfigPath,
  })
  const workerContract = compiled.bundle.manifest.prover_worker
    ? path.join(compiled.bundle.bundleDir, compiled.bundle.manifest.prover_worker)
    : undefined
  const workerDeploymentBackend = options.intent.proofTopology.deployment.workerDeploymentBackend
    || 'docker_compose'
  const kubernetesWorker = compiled.worker?.desired_state === 'local_deployment'
    && workerDeploymentBackend === 'kubernetes'
  const workerKind = compiled.worker?.desired_state === 'external'
    ? 'compiled-external' as const
    : workerDeploymentBackend === 'docker_compose'
      ? 'compiled-compose' as const
      : 'compiled-local' as const
  const contract = writeProofDeploymentContract({
    deploymentDir,
    enforcement: options.intent.proofTopology.enforcement,
    ethDaSubmitter: {valuesFile: compiled.ethDaSubmitterValuesPath},
    generation: options.intent.proofTopology.generation,
    intentSource: options.intent.source,
    mode: options.intent.proofTopology.mode,
    proofArtifactBaseUrl: compiled.proofArtifactBaseUrl,
    proofCoordinator: {
      // PC is a stable deployment service. In disabled mode it runs the
      // chart's minimal idle config; active mode installs compiler output.
      enabled: true,
      valuesFile: path.join(valuesDir, 'proof-coordinator-production.yaml'),
    },
    proverWorker: {
      enabled: kubernetesWorker,
      valuesFile: path.join(valuesDir, 'prover-worker-production.yaml'),
    },
    topology: {
      bundleDir: compiled.bundle.bundleDir,
      bundleManifest: path.join(compiled.bundle.bundleDir, 'bundle-manifest-v1.json'),
      bundleRevision: compiled.bundle.manifest.bundle_revision,
      resolvedSidecar: path.join(compiled.bundle.bundleDir, compiled.bundle.manifest.resolved_sidecar),
    },
    tsoValuesFile: path.join(valuesDir, 'tso-service-production.yaml'),
    withdrawalProcessor: {
      enabled: true,
      valuesFile: path.join(valuesDir, 'withdrawal-processor-production.yaml'),
    },
    worker: compiled.worker && workerContract ? {
      bundleDir: compiled.workerBundle?.bundleDir,
      bundleId: compiled.workerBundle?.bundleId,
      contractFile: workerContract,
      kind: workerKind,
    } : undefined,
  })
  return {
    bundleRevision: compiled.bundle.manifest.bundle_revision,
    contract,
    files: compiled.files,
    mode: options.intent.proofTopology.mode,
    proofAwsConfigPath,
    workerBundle: compiled.workerBundle,
  }
}
