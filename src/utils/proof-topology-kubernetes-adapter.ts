/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and TOML patches are dynamic deployment documents. */
import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'
import type {ProofSystemMode} from './proof-system-mode.js'

import {
  type CompiledProverWorkerBundleResult,
  writeCompiledProverWorkerBundle,
} from './compiled-prover-worker-bundle.js'
import {resolveDeploymentSpecEnvRefs} from './deployment-spec-generator.js'
import {
  type CompileProofTopologyOptions,
  type ProofTopologyBridgeContext,
  type ProverWorkerContractV1,
  type ValidatedProofTopologyBundle,
  compileProofTopology,
} from './proof-topology-compiler.js'
import {
  assertNoInlineWithdrawalConfig,
  ensureWithdrawalChartWiring,
  ensureWithdrawalProofActivationSwitch,
} from './withdrawal-config.js'

const MATERIALS_CONFIG_MAP = 'proof-topology-materials'
const MATERIALS_VOLUME = 'proof-topology-materials'
const RESOURCES_VOLUME = 'proof-topology-resources'
const TOPOLOGY_ANNOTATION = 'dogeos.io/proof-topology-digest'
const WORKER_READINESS_VOLUME = 'prover-worker-readiness'
const WORKER_TOKEN_VOLUME = 'prover-worker-token'

export interface ReconcileCompiledProofTopologyOptions {
  bridge?: ProofTopologyBridgeContext
  /** Test seam for a contract-compatible compiler result. */
  compile?: typeof compileProofTopology
  compilerBinary?: string
  compilerImage?: string
  coordinatorConfigPath: string
  coordinatorIngressHost?: string
  deploymentDir: string
  deploymentSpec: DeploymentSpec
  ethereumL1RpcUrl?: string
  valuesDir: string
  withdrawalConfigPath: string
}

export interface ReconcileCompiledProofTopologyResult {
  bundle: ValidatedProofTopologyBundle
  ethDaSubmitterValuesPath: string
  files: string[]
  helmSetFiles: {
    proofCoordinator: Array<{filePath: string; integrityPolicy: 'required'; key: string}>
    proverWorker: Array<{filePath: string; integrityPolicy: 'required'; key: string}>
    withdrawalProcessor: Array<{filePath: string; integrityPolicy: 'required'; key: string}>
  }
  proofArtifactBaseUrl?: string
  worker?: ProverWorkerContractV1
  workerBundle?: CompiledProverWorkerBundleResult
}

function readYaml(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) throw new Error(`proof values template not found: ${filePath}`)
  const parsed = yaml.load(fs.readFileSync(filePath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`proof values template must be a YAML mapping: ${filePath}`)
  }

  return parsed as Record<string, any>
}

function writeAtomic(filePath: string, content: string): void {
  const temporary = `${filePath}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(filePath), {recursive: true})
  fs.writeFileSync(temporary, content)
  fs.renameSync(temporary, filePath)
}

function writeYaml(filePath: string, value: Record<string, any>): void {
  writeAtomic(filePath, yaml.dump(value, {lineWidth: -1, noRefs: true}))
}

function copyAtomic(source: string, destination: string): void {
  const temporary = `${destination}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(destination), {recursive: true})
  fs.copyFileSync(source, temporary)
  fs.renameSync(temporary, destination)
}

function escapeHelmKeySegment(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('.', '\\.')
    .replaceAll(',', '\\,')
    .replaceAll('=', '\\=')
}

function filesRecursively(root: string): Array<{filePath: string; relative: string}> {
  const files: Array<{filePath: string; relative: string}> = []
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const filePath = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(filePath)
      else if (entry.isFile()) {
        files.push({
          filePath,
          relative: path.relative(root, filePath).split(path.sep).join('/'),
        })
      } else {
        throw new Error(`compiler materials contain an unsupported filesystem entry: ${filePath}`)
      }
    }
  }

  visit(root)
  return files.sort((left, right) => left.relative.localeCompare(right.relative))
}

function configureMaterials(
  values: Record<string, any>,
  materialsDir: string | undefined,
  runtimeRoot: string,
): Array<{filePath: string; integrityPolicy: 'required'; key: string}> {
  values.configMaps ||= {}
  values.persistence ||= {}
  if (!materialsDir) {
    delete values.configMaps[MATERIALS_CONFIG_MAP]
    delete values.persistence[MATERIALS_VOLUME]
    return []
  }

  const materials = filesRecursively(materialsDir)
  const data: Record<string, string> = {}
  const items: Array<{key: string; path: string}> = []
  const bindings = materials.map((material, index) => {
    const key = `material-${String(index).padStart(2, '0')}-${path.basename(material.relative)}`
    data[key] = ''
    items.push({key, path: material.relative})
    return {
      filePath: material.filePath,
      integrityPolicy: 'required' as const,
      key: `configMaps.${MATERIALS_CONFIG_MAP}.data.${escapeHelmKeySegment(key)}`,
    }
  })
  values.configMaps[MATERIALS_CONFIG_MAP] = {data, enabled: true}
  values.persistence[MATERIALS_VOLUME] = {
    enabled: true,
    items,
    mountPath: runtimeRoot,
    name: `{{ include "scroll.common.lib.chart.names.fullname" . }}-${MATERIALS_CONFIG_MAP}`,
    readOnly: true,
    type: 'configMap',
  }
  return bindings
}

function selectedRealScroll(spec: DeploymentSpec, mode: ProofSystemMode) {
  const topology = spec.proofTopology!
  return mode === 'mock'
    ? topology.mock?.realScroll
    : mode === 'production'
      ? topology.production?.realScroll
      : undefined
}

function workerArgument(worker: ProverWorkerContractV1, flag: string): string {
  const index = worker.argv.indexOf(flag)
  const value = index >= 0 ? worker.argv[index + 1] : undefined
  if (!value) throw new Error(`compiler Worker contract is missing ${flag}`)
  return value
}

function configureWorkerValues(
  filePath: string,
  input: {
    digest: string
    generatedMaterialsRoot: string
    materialsDir?: string
    resourceClaim?: string
    resourcesMountPath: string
    spec: DeploymentSpec
    worker?: ProverWorkerContractV1
  },
): Array<{filePath: string; integrityPolicy: 'required'; key: string}> {
  const values = readYaml(filePath)
  const local = input.worker?.desired_state === 'local_deployment'
  values.controller ||= {}
  values.controller.replicas = local ? 1 : 0
  annotate(values, input.digest)

  if (!local || !input.worker) {
    values.args = []
    values.env = []
    delete values.image?.digest
    delete values.persistence?.[MATERIALS_VOLUME]
    delete values.persistence?.[RESOURCES_VOLUME]
    delete values.persistence?.[WORKER_READINESS_VOLUME]
    delete values.persistence?.[WORKER_TOKEN_VOLUME]
    delete values.configMaps?.[MATERIALS_CONFIG_MAP]
    writeYaml(filePath, values)
    return []
  }

  const {worker} = input
  values.image ||= {}
  values.image.repository = worker.image.repository
  values.image.digest = worker.image.digest
  delete values.image.tag
  values.command = []
  values.args = worker.argv
  values.env = worker.environment
  values.termination ||= {}
  values.termination.gracePeriodSeconds = 420
  values.service ||= {}
  values.service.main ||= {}
  values.service.main.enabled = false
  values.automountServiceAccountToken = false

  const deployment = input.spec.proofTopology?.deployment || {}
  const tokenPath = workerArgument(worker, '--worker-token-file')
  const tokenName = path.posix.basename(tokenPath)
  const tokenKey = input.spec.proofCoordinator?.secrets?.proverWorkerTokenProperty
    || 'prover-worker-token'
  values.persistence ||= {}
  values.persistence[WORKER_TOKEN_VOLUME] = {
    enabled: true,
    items: [{key: tokenKey, path: tokenName}],
    mountPath: tokenPath,
    name: deployment.workerSecretName
      || input.spec.proofCoordinator?.secrets?.name
      || 'proof-coordinator-secrets',
    readOnly: true,
    subPath: tokenName,
    type: 'secret',
  }
  values.persistence['protocol-context'] = {
    enabled: true,
    items: [{key: 'protocol_context.json', path: 'protocol_context.json'}],
    mountPath: deployment.protocolContextPath || '/app/protocol_context.json',
    name: 'protocol-context-config',
    readOnly: true,
    subPath: 'protocol_context.json',
    type: 'configMap',
  }
  const readinessDirectory = path.posix.dirname(worker.readiness_evidence_path)
  values.persistence[WORKER_READINESS_VOLUME] = {
    enabled: true,
    mountPath: readinessDirectory,
    type: 'emptyDir',
  }

  const bindings = configureMaterials(
    values,
    input.materialsDir,
    input.generatedMaterialsRoot,
  )
  configureProofResources(
    values,
    input.resourceClaim,
    input.resourcesMountPath,
  )
  values.probes ||= {}
  for (const probe of ['readiness', 'startup']) {
    values.probes[probe] = {
      custom: true,
      enabled: true,
      spec: {
        exec: {command: ['test', '-s', worker.readiness_evidence_path]},
        failureThreshold: probe === 'startup' ? 120 : 3,
        periodSeconds: 5,
        timeoutSeconds: 2,
      },
    }
  }

  values.probes.liveness = {enabled: false}
  if (deployment.workerResources) values.resources = deployment.workerResources
  else if (
    input.spec.proofTopology?.mode === 'production'
    && input.spec.proofTopology.production?.workerLaunch === 'local_cuda'
  ) {
    values.resources = {
      limits: {'nvidia.com/gpu': 1},
      requests: {'nvidia.com/gpu': 1},
    }
  }

  if (deployment.workerNodeSelector) values.nodeSelector = deployment.workerNodeSelector
  if (deployment.workerTolerations) values.tolerations = deployment.workerTolerations
  if (deployment.workerRuntimeClassName) {
    values.runtimeClassName = deployment.workerRuntimeClassName
  }

  writeYaml(filePath, values)
  return bindings
}

function deploymentFile(root: string, relative: string, label: string): string {
  if (path.isAbsolute(relative)) throw new Error(`${label} must be deployment-relative`)
  const resolved = path.resolve(root, relative)
  const inside = path.relative(root, resolved)
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`${label} must remain inside the deployment directory`)
  }

  return resolved
}

function configureProofResources(
  values: Record<string, any>,
  claim: string | undefined,
  mountPath: string,
): void {
  values.persistence ||= {}
  if (!claim) {
    delete values.persistence[RESOURCES_VOLUME]
    return
  }

  values.persistence[RESOURCES_VOLUME] = {
    enabled: true,
    existingClaim: claim,
    mountPath,
    readOnly: true,
    type: 'pvc',
  }
}

function annotate(values: Record<string, any>, digest: string): void {
  values.podAnnotations ||= {}
  values.podAnnotations[TOPOLOGY_ANNOTATION] = digest
}

function configureWithdrawalValues(
  filePath: string,
  mode: ProofSystemMode,
  digest: string,
  materialsDir: string | undefined,
  generatedMaterialsRoot: string,
  resourceClaim: string | undefined,
  resourcesMountPath: string,
): Array<{filePath: string; integrityPolicy: 'required'; key: string}> {
  const values = readYaml(filePath)
  ensureWithdrawalChartWiring(values)
  assertNoInlineWithdrawalConfig(values)
  ensureWithdrawalProofActivationSwitch(values, mode)
  values.service ||= {}
  values.service.main ||= {}
  values.service.main.ports ||= {}
  if (mode === 'disabled') delete values.service.main.ports['proof-work']
  else {
    values.service.main.ports['proof-work'] = {
      enabled: true,
      port: 9300,
      protocol: 'TCP',
      targetPort: 9300,
    }
  }

  annotate(values, digest)
  const bindings = configureMaterials(
    values,
    materialsDir,
    generatedMaterialsRoot,
  )
  configureProofResources(values, mode === 'disabled' ? undefined : resourceClaim, resourcesMountPath)
  writeYaml(filePath, values)
  return bindings
}

function configureCoordinatorValues(
  filePath: string,
  digest: string,
  materialsDir: string,
  generatedMaterialsRoot: string,
  resourceClaim: string | undefined,
  resourcesMountPath: string,
): Array<{filePath: string; integrityPolicy: 'required'; key: string}> {
  const values = readYaml(filePath)
  // Native compiler output is authoritative. Leaving old Figment variables in
  // the chart would partially override its strict tables after compilation.
  values.env = (Array.isArray(values.env) ? values.env : []).filter(
    (item: any) => !String(item?.name || '').startsWith('DOGEOS_PROOF_COORDINATOR_'),
  )
  values.proofCoordinator ||= {}
  values.proofCoordinator.config ||= {}
  values.proofCoordinator.config.required = true
  values.controller ||= {}
  values.controller.replicas = 1
  values.service ||= {}
  values.service.main ||= {}
  values.service.main.enabled = true
  values.service.main.ports ||= {}
  values.service.main.ports.prover = {
    enabled: true,
    port: 7788,
    protocol: 'TCP',
    targetPort: 7788,
  }
  annotate(values, digest)
  const bindings = configureMaterials(
    values,
    materialsDir,
    generatedMaterialsRoot,
  )
  configureProofResources(values, resourceClaim, resourcesMountPath)
  writeYaml(filePath, values)
  return bindings
}

function configureAbsentCoordinatorValues(filePath: string, digest: string): void {
  const values = readYaml(filePath)
  values.controller ||= {}
  values.controller.replicas = 0
  values.proofCoordinator ||= {}
  values.proofCoordinator.config ||= {}
  values.proofCoordinator.config.required = false
  values.service ||= {}
  values.service.main ||= {}
  values.service.main.enabled = false
  values.configMaps ||= {}
  values.persistence ||= {}
  delete values.configMaps[MATERIALS_CONFIG_MAP]
  delete values.persistence[MATERIALS_VOLUME]
  delete values.persistence[RESOURCES_VOLUME]
  annotate(values, digest)
  writeYaml(filePath, values)
}

function envName(section: string, field: string): string {
  return `DOGEOS_ETH_DA_SUBMITTER_${section.toUpperCase()}__${field.toUpperCase()}`
}

function applySubmitterPatch(filePath: string, patchPath: string, digest: string): void {
  const values = readYaml(filePath)
  values.configMaps ||= {}
  values.configMaps.env ||= {data: {}, enabled: true}
  values.configMaps.env.data ||= {}
  const data = values.configMaps.env.data as Record<string, string>
  for (const key of Object.keys(data)) {
    if (
      key.startsWith('DOGEOS_ETH_DA_SUBMITTER_S3__')
      || key.startsWith('DOGEOS_ETH_DA_SUBMITTER_SEGMENTATION_SIDECAR__')
    ) {
      delete data[key]
    }
  }

  const patch = toml.parse(fs.readFileSync(patchPath, 'utf8')) as Record<string, unknown>
  for (const section of ['s3', 'segmentation_sidecar']) {
    const table = patch[section]
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue
    for (const [field, value] of Object.entries(table)) {
      if (!['boolean', 'number', 'string'].includes(typeof value)) {
        throw new Error(`${patchPath}: [${section}].${field} must be a scalar`)
      }

      data[envName(section, field)] = String(value)
    }
  }

  annotate(values, digest)
  writeYaml(filePath, values)
}

function argumentValue(worker: ProverWorkerContractV1 | undefined, flag: string): string | undefined {
  if (!worker) return undefined
  const index = worker.argv.indexOf(flag)
  return index >= 0 ? worker.argv[index + 1] : undefined
}

function derivedProverPublicUrl(
  spec: DeploymentSpec,
  mode: ProofSystemMode,
): string | undefined {
  if (mode !== 'production' || spec.proofTopology?.production?.workerLaunch !== 'external') {
    return undefined
  }

  const host = spec.frontend.hosts.proofCoordinator
  if (!host) throw new Error('external production Worker requires frontend.hosts.proofCoordinator')
  return `${spec.frontend.protocol || 'https'}://${host}`
}

export function reconcileCompiledProofTopology(
  options: ReconcileCompiledProofTopologyOptions,
): ReconcileCompiledProofTopologyResult {
  const spec = resolveDeploymentSpecEnvRefs(options.deploymentSpec)
  const {proofTopology: topology} = spec
  if (!topology) throw new Error('compiler adapter requires DeploymentSpec proofTopology')
  const {mode} = topology
  const valuesDir = path.resolve(options.valuesDir)
  const coordinatorValuesPath = path.join(valuesDir, 'proof-coordinator-production.yaml')
  const workerValuesPath = path.join(valuesDir, 'prover-worker-production.yaml')
  const withdrawalValuesPath = path.join(valuesDir, 'withdrawal-processor-production.yaml')
  const submitterValuesPath = path.join(valuesDir, 'eth-da-submitter-production.yaml')

  if (mode !== 'disabled' && !fs.existsSync(options.coordinatorConfigPath)) {
    throw new Error(
      `Proof Coordinator base config not found: ${options.coordinatorConfigPath}. `
      + 'Copy proof-coordinator/ProofCoordinator.toml from the scroll-sdk examples layout.',
    )
  }

  const proverPublicUrl = topology.deployment?.proverPublicUrl
    || derivedProverPublicUrl(spec, mode)
  const effectiveSpec: DeploymentSpec = {
    ...spec,
    proofTopology: {
      ...topology,
      deployment: {
        ...topology.deployment,
        ...(proverPublicUrl ? {proverPublicUrl} : {}),
      },
    },
  }
  const compileOptions: CompileProofTopologyOptions = {
    bridge: options.bridge,
    compilerBinary: options.compilerBinary,
    compilerImage: options.compilerImage,
    deploymentDir: options.deploymentDir,
    ethereumL1RpcUrl: options.ethereumL1RpcUrl,
    proofCoordinatorBaseConfig: options.coordinatorConfigPath,
    spec: effectiveSpec,
    withdrawalProcessorBaseConfig: options.withdrawalConfigPath,
  }
  const bundle = (options.compile || compileProofTopology)(compileOptions)
  if (bundle.manifest.preflight_only) {
    throw new Error('refusing to install a preflight-only proof topology bundle')
  }

  const wpSource = path.join(bundle.bundleDir, bundle.manifest.withdrawal_processor)
  copyAtomic(wpSource, options.withdrawalConfigPath)
  const coordinatorSource = bundle.manifest.proof_coordinator
    ? path.join(bundle.bundleDir, bundle.manifest.proof_coordinator)
    : undefined
  if (coordinatorSource) copyAtomic(coordinatorSource, options.coordinatorConfigPath)

  const materialsDir = bundle.manifest.generated_materials
    ? path.join(bundle.bundleDir, bundle.manifest.generated_materials)
    : undefined
  const generatedMaterialsRoot = topology.deployment?.generatedMaterialsRoot
    || '/app/data/proof-topology'
  const resourcesMountPath = topology.deployment?.resourcesMountPath
    || '/app/data/proof-release'
  const resourceClaim = topology.deployment?.resourcesPersistentVolumeClaim
  const withdrawalMaterialBindings = configureWithdrawalValues(
    withdrawalValuesPath,
    mode,
    bundle.plan.to_digest,
    materialsDir,
    generatedMaterialsRoot,
    resourceClaim,
    resourcesMountPath,
  )
  let coordinatorMaterialBindings: ReturnType<typeof configureMaterials> = []
  if (mode === 'disabled') {
    configureAbsentCoordinatorValues(coordinatorValuesPath, bundle.plan.to_digest)
  } else {
    if (!materialsDir || !coordinatorSource) {
      throw new Error('active compiler bundle is missing coordinator config or generated materials')
    }

    coordinatorMaterialBindings = configureCoordinatorValues(
      coordinatorValuesPath,
      bundle.plan.to_digest,
      materialsDir,
      generatedMaterialsRoot,
      resourceClaim,
      resourcesMountPath,
    )
  }

  if (!fs.existsSync(workerValuesPath)) {
    throw new Error(`Prover Worker values template not found: ${workerValuesPath}`)
  }

  const workerMaterialBindings = configureWorkerValues(workerValuesPath, {
    digest: bundle.plan.to_digest,
    generatedMaterialsRoot,
    materialsDir,
    resourceClaim: selectedRealScroll(spec, mode) ? resourceClaim : undefined,
    resourcesMountPath,
    spec,
    worker: bundle.worker,
  })

  let workerBundle: CompiledProverWorkerBundleResult | undefined
  if (bundle.worker?.desired_state === 'external') {
    if (!bundle.manifest.prover_worker || !materialsDir) {
      throw new Error('external compiler Worker requires its contract and generated materials')
    }

    const realScroll = selectedRealScroll(spec, mode)
    if (!realScroll) throw new Error('external compiler Worker requires selected realScroll resources')
    const deploymentRoot = path.resolve(options.deploymentDir)
    workerBundle = writeCompiledProverWorkerBundle({
      bundleDir: path.join(deploymentRoot, `prover-worker-${mode}/docker-compose`),
      contractFile: path.join(bundle.bundleDir, bundle.manifest.prover_worker),
      generatedMaterialsDir: materialsDir,
      generatedMaterialsRoot,
      protocolContextPath: deploymentFile(
        deploymentRoot,
        topology.deployment?.protocolContextSource || '.data/protocol_context.json',
        'proofTopology.deployment.protocolContextSource',
      ),
      protocolContextRuntimePath:
        topology.deployment?.protocolContextPath || '/app/protocol_context.json',
      resourcesMountPath,
      resourcesRoot: deploymentFile(
        deploymentRoot,
        realScroll.resourcesRoot,
        `proofTopology.${mode}.realScroll.resourcesRoot`,
      ),
      worker: bundle.worker,
    })
  }

  if (!bundle.manifest.eth_da_submitter) {
    throw new Error('compiler bundle is missing the eth-da-submitter projection')
  }

  applySubmitterPatch(
    submitterValuesPath,
    path.join(bundle.bundleDir, bundle.manifest.eth_da_submitter),
    bundle.plan.to_digest,
  )

  const proofCoordinatorBindings = coordinatorSource
    ? [
        {
          filePath: options.coordinatorConfigPath,
          integrityPolicy: 'required' as const,
          key: 'proofCoordinator.config.content',
        },
        ...coordinatorMaterialBindings,
      ]
    : []
  return {
    bundle,
    ethDaSubmitterValuesPath: submitterValuesPath,
    files: [
      options.withdrawalConfigPath,
      withdrawalValuesPath,
      ...(coordinatorSource ? [options.coordinatorConfigPath] : []),
      coordinatorValuesPath,
      workerValuesPath,
      submitterValuesPath,
      ...withdrawalMaterialBindings.map(binding => binding.filePath),
      ...(workerBundle?.files || []),
    ],
    helmSetFiles: {
      proofCoordinator: proofCoordinatorBindings,
      proverWorker: workerMaterialBindings,
      withdrawalProcessor: [
        {
          filePath: options.withdrawalConfigPath,
          integrityPolicy: 'required',
          key: 'configMaps.config.data.WithdrawalProcessor\\.toml',
        },
        ...withdrawalMaterialBindings,
      ],
    },
    proofArtifactBaseUrl: argumentValue(bundle.worker, '--artifact-read-base-url'),
    worker: bundle.worker,
    workerBundle,
  }
}
