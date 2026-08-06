import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ProofFamily } from './proof-configurator.js'
import type { ResolvedProofIntent } from './proof-intent.js'

import {
  DEFAULT_PROOF_AWS_CONFIG,
  proofAwsValuesProjection,
  readOptionalProofAwsConfig,
} from './proof-aws-config.js'
import { applyProofAwsValues } from './proof-aws-provisioner.js'
import {
  DEFAULT_PROOF_COORDINATOR_CONFIG,
  DEFAULT_PROOF_PROGRAM_MANIFESTS,
  DEFAULT_STATEMENT_NAMESPACE_CONFIG,
  configureDisabledProofValues,
  configureProofValues,
} from './proof-configurator.js'
import { scaffoldProofCoordinatorConfig } from './proof-coordinator-scaffold.js'
import {
  type ProofDeploymentContract,
  writeProofDeploymentContract,
} from './proof-deployment-contract.js'
import {
  PROVER_WORKER_MOCK_BUNDLE_DIR,
  type ProverWorkerMockBundleResult,
  writeProverWorkerMockBundle,
} from './prover-worker-mock-bundle.js'
import {
  PROVER_WORKER_PRODUCTION_BUNDLE_DIR,
  type ProverWorkerProductionBundleResult,
  verifyProverWorkerRelease,
  writeProverWorkerProductionBundle,
} from './prover-worker-production-bundle.js'
import { WITHDRAWAL_NATIVE_CONFIG_RELPATH } from './withdrawal-config.js'

export interface ProofReleasePaths {
  artifactManifest: string
  programManifests: string[]
  releaseRoot: string
  statementNamespace: string
}

export interface ReconcileProofKubernetesOptions {
  aggregationL2ChainId?: number | string
  bridgeBackendProfile?: string
  coordinatorConfigPath?: string
  coordinatorIngressHost?: string
  deploymentDir?: string
  intent: ResolvedProofIntent
  proofAwsConfigPath?: string
  scaffoldCoordinatorConfig?: boolean
  scrollBatchBackendProfile?: string
  valuesDir?: string
  verifierIds?: Partial<Record<ProofFamily, string>>
  withdrawalConfigPath?: string
  workerBundleDir?: string
}

export interface ReconcileProofKubernetesResult {
  contract: ProofDeploymentContract
  files: string[]
  mode: ResolvedProofIntent['intent']['mode']
  proofAwsConfigPath?: string
  release: ProofReleasePaths
  scaffoldedCoordinatorConfig: boolean
  workerBundle?: ProverWorkerMockBundleResult | ProverWorkerProductionBundleResult
}

export function resolveProofReleasePaths(
  deploymentDir: string,
  release?: string,
): ProofReleasePaths {
  const root = path.resolve(deploymentDir)
  const releaseRoot = path.resolve(root, release || 'proof-artifacts')
  return {
    artifactManifest: path.join(releaseRoot, 'release.json'),
    programManifests: DEFAULT_PROOF_PROGRAM_MANIFESTS.map(manifest => {
      const relativeToDefaultRoot = path.relative('proof-artifacts', manifest)
      return path.join(releaseRoot, relativeToDefaultRoot)
    }),
    releaseRoot,
    statementNamespace: release
      ? path.join(releaseRoot, 'manifests', 'statement-namespace.json')
      : path.resolve(root, DEFAULT_STATEMENT_NAMESPACE_CONFIG),
  }
}

function coordinatorExternalUrl(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '')
  if (/^https?:\/\//.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

function readValues(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`proof values template not found: ${filePath}`)
  }

  const value = yaml.load(fs.readFileSync(filePath, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`proof values template must be a YAML mapping: ${filePath}`)
  }

  return value as Record<string, unknown>
}

function writeValues(filePath: string, value: Record<string, unknown>): void {
  fs.writeFileSync(filePath, yaml.dump(value, {lineWidth: -1, noRefs: true}))
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

function preflightExternalWorker(
  options: ReconcileProofKubernetesOptions,
  release: ProofReleasePaths,
): void {
  const {mode} = options.intent.intent
  if (mode === 'disabled') return
  if (!options.coordinatorIngressHost) {
    throw new Error(
      `${mode} mode requires ingress.PROOF_COORDINATOR_HOST in config.toml `
      + 'so the external worker bundle has a coordinator URL',
    )
  }

  const aggregationL2ChainId = String(options.aggregationL2ChainId ?? '').trim()
  if (!/^[1-9]\d*$/.test(aggregationL2ChainId)) {
    throw new Error(
      `${mode} mode requires general.CHAIN_ID_L2 in config.toml as a non-zero decimal integer `
      + 'for standalone L2 aggregation',
    )
  }

  if (mode !== 'production') return

  // Fail before scaffolding or mutating proof-owned values when the production
  // worker release is incomplete. writeProverWorkerProductionBundle verifies it
  // again when binding the final bundle identity.
  verifyProverWorkerRelease({releaseRoot: release.releaseRoot})
}

/**
 * Deterministically reconcile only deployment-owned proof configuration.
 *
 * This deliberately performs no AWS/Kubernetes calls and does not read a
 * bearer token. In mock mode it emits a credential-pending worker bundle whose
 * stable bundle ID can be recorded in the deployment contract; an explicit
 * worker-host preparation step hydrates the secret later.
 */
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
  if (!fs.existsSync(tsoValuesFile)) {
    throw new Error(`TSO values file not found: ${tsoValuesFile}`)
  }

  const release = resolveProofReleasePaths(deploymentDir, options.intent.intent.release)
  const {mode} = options.intent.intent
  const disabled = mode === 'disabled'
  preflightExternalWorker(options, release)
  const proofAwsConfigPath = disabled
    ? undefined
    : projectProofAwsConfig(deploymentDir, valuesDir, options.proofAwsConfigPath)
  if (
    !disabled
    && !proofAwsConfigPath
    && options.intent.source.kind !== 'deployment-spec'
  ) {
    throw new Error(
      `${options.intent.source.path}: ${mode} mode needs an explicit proof infrastructure source; `
      + `run scrollsdk setup proof-aws-init to create ${DEFAULT_PROOF_AWS_CONFIG}, `
      + 'or declare proofCoordinator infrastructure in a DeploymentSpec',
    )
  }

  let scaffoldedCoordinatorConfig = false
  let result: ReturnType<typeof configureDisabledProofValues> | ReturnType<typeof configureProofValues>

  if (disabled) {
    result = configureDisabledProofValues({ valuesDir, withdrawalConfigPath })
  } else {
    const {artifactReadBaseUrl} = options.intent.intent
    if (!artifactReadBaseUrl) {
      throw new Error(
        `${options.intent.source.path}: proofSystem.artifactReadBaseUrl is required for ${mode} mode`,
      )
    }

    if (options.scaffoldCoordinatorConfig !== false) {
      const scaffold = scaffoldProofCoordinatorConfig({
        coordinatorConfigPath,
        provingMode: mode,
        valuesDir,
        withdrawalConfigPath,
      })
      scaffoldedCoordinatorConfig = scaffold.created
    }

    result = configureProofValues({
      artifactManifestPath: mode === 'mock' ? undefined : release.artifactManifest,
      bridgeBackendProfile: options.bridgeBackendProfile,
      coordinatorConfigPath,
      coordinatorIngressHost: options.coordinatorIngressHost,
      manifestPaths: mode === 'mock' ? undefined : release.programManifests,
      provingMode: mode,
      scrollBatchBackendProfile: options.scrollBatchBackendProfile,
      signerProofArtifactBaseUrl: artifactReadBaseUrl,
      statementNamespacePath: release.statementNamespace,
      valuesDir,
      verifierIds: options.verifierIds,
      withdrawalConfigPath,
    })
  }

  let workerBundle:
    | ProverWorkerMockBundleResult
    | ProverWorkerProductionBundleResult
    | undefined
  if (mode === 'mock') {
    workerBundle = writeProverWorkerMockBundle({
      aggregationL2ChainId: options.aggregationL2ChainId!,
      artifactReadBaseUrl: options.intent.intent.artifactReadBaseUrl!,
      coordinatorUrl: coordinatorExternalUrl(options.coordinatorIngressHost!),
      dir: options.workerBundleDir || path.join(deploymentDir, PROVER_WORKER_MOCK_BUNDLE_DIR),
    })
  } else if (mode === 'production') {
    workerBundle = writeProverWorkerProductionBundle({
      aggregationL2ChainId: options.aggregationL2ChainId!,
      artifactReadBaseUrl: options.intent.intent.artifactReadBaseUrl!,
      coordinatorUrl: coordinatorExternalUrl(options.coordinatorIngressHost!),
      dir: options.workerBundleDir
        || path.join(deploymentDir, PROVER_WORKER_PRODUCTION_BUNDLE_DIR),
      releaseRoot: release.releaseRoot,
    })
  }

  // Conventional worker bundle directories are CLI-owned generated output and
  // may contain hydrated bearer tokens. Never leave an inactive-mode bundle
  // behind where an operator could accidentally start it.
  if (mode !== 'mock') {
    fs.rmSync(path.join(deploymentDir, path.dirname(PROVER_WORKER_MOCK_BUNDLE_DIR)), {
      force: true,
      recursive: true,
    })
  }

  if (mode !== 'production') {
    fs.rmSync(path.join(deploymentDir, path.dirname(PROVER_WORKER_PRODUCTION_BUNDLE_DIR)), {
      force: true,
      recursive: true,
    })
  }

  const contract = writeProofDeploymentContract({
    deploymentDir,
    intentSource: options.intent.source,
    mode,
    ...(proofAwsConfigPath ? {proofAwsConfigPath} : {}),
    proofArtifactBaseUrl: options.intent.intent.artifactReadBaseUrl,
    proofCoordinator: {
      enabled: !disabled,
      setFiles: result.helmSetFiles.proofCoordinator,
      valuesFile: disabled ? undefined : path.join(valuesDir, 'proof-coordinator-production.yaml'),
    },
    tsoValuesFile,
    withdrawalProcessor: {
      setFiles: result.helmSetFiles.withdrawalProcessor,
      valuesFile: path.join(valuesDir, 'withdrawal-processor-production.yaml'),
    },
    worker: workerBundle
      ? {
          bundleDir: workerBundle.bundleDir,
          bundleId: workerBundle.bundleId,
          kind: mode === 'production' ? 'production-compose' : 'mock-compose',
        }
      : undefined,
  })

  return {
    contract,
    files: result.files,
    mode,
    release,
    scaffoldedCoordinatorConfig,
    ...(workerBundle ? { workerBundle } : {}),
  }
}
