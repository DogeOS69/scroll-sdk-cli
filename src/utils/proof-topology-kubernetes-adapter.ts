/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and TOML patches are dynamic deployment documents. */
import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {ProofCoordinatorConfig} from '../types/deployment-spec.js'
import type {ProofTopologySpec} from '../types/proof-topology.js'

import {
  type CompiledProverWorkerBundleResult,
  PROVER_WORKER_EXECUTABLE,
  writeCompiledProverWorkerBundle,
} from './compiled-prover-worker-bundle.js'
import {
  type CompileProofTopologyOptions,
  type ProofTopologyBridgeContext,
  type ProofTopologyEthereumDaBlobSource,
  type ProverWorkerContractV1,
  type ValidatedProofTopologyBundle,
  compileProofTopology,
} from './proof-topology-compiler.js'
import {
  WITHDRAWAL_CONFIG_FILE,
  ensureWithdrawalChartWiring,
  ensureWithdrawalProofActivationSwitch,
} from './withdrawal-config.js'

const MATERIALS_CONFIG_MAP = 'proof-topology-materials'
const MATERIALS_VOLUME = 'proof-topology-materials'
const RESOURCES_VOLUME = 'proof-topology-resources'
const GENESIS_VOLUME = 'genesis'
const TOPOLOGY_BUNDLE_ANNOTATION = 'dogeos.io/proof-topology-bundle-revision'
const RETIRED_TOPOLOGY_ANNOTATIONS = [
  'dogeos.io/proof-topology-digest',
  'dogeos.io/proof-topology-deployment-revision',
] as const
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
  deploymentName: string
  ethereumDaBlobSource?: ProofTopologyEthereumDaBlobSource
  ethereumL1RpcUrl?: string
  network: string
  proofCoordinator?: ProofCoordinatorConfig
  proofTopology: ProofTopologySpec
  proverPublicUrl?: string
  valuesDir: string
  withdrawalConfigPath: string
}

export interface ReconcileCompiledProofTopologyResult {
  bundle: ValidatedProofTopologyBundle
  ethDaSubmitterValuesPath: string
  files: string[]
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
): void {
  values.configMaps ||= {}
  values.persistence ||= {}
  if (!materialsDir) {
    delete values.configMaps[MATERIALS_CONFIG_MAP]
    delete values.persistence[MATERIALS_VOLUME]
    return
  }

  const materials = filesRecursively(materialsDir)
  const data: Record<string, string> = {}
  const items: Array<{key: string; path: string}> = []
  for (const [index, material] of materials.entries()) {
    const key = `material-${String(index).padStart(2, '0')}-${path.basename(material.relative)}`
    data[key] = fs.readFileSync(material.filePath, 'utf8')
    items.push({key, path: material.relative})
  }

  values.configMaps[MATERIALS_CONFIG_MAP] = {data, enabled: true}
  values.persistence[MATERIALS_VOLUME] = {
    enabled: true,
    items,
    mountPath: runtimeRoot,
    name: `{{ include "scroll.common.lib.chart.names.fullname" . }}-${MATERIALS_CONFIG_MAP}`,
    readOnly: true,
    type: 'configMap',
  }
}

function selectedRealScroll(topology: ProofTopologySpec) {
  return topology.mode === 'active' ? topology.active?.realScroll : undefined
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
    bundleRevision: string
    generatedMaterialsRoot: string
    materialsDir?: string
    proofCoordinator?: ProofCoordinatorConfig
    resourceClaim?: string
    resourcesMountPath: string
    topology: ProofTopologySpec
    worker?: ProverWorkerContractV1
  },
): void {
  const values = readYaml(filePath)
  const local = input.worker?.desired_state === 'local_deployment'
    && (input.topology.deployment.workerDeploymentBackend || 'docker_compose') === 'kubernetes'
  values.controller ||= {}
  values.controller.replicas = local ? 1 : 0
  annotate(values, input.bundleRevision)

  if (!local || !input.worker) {
    values.command = []
    values.args = []
    values.env = []
    delete values.image?.digest
    delete values.persistence?.[MATERIALS_VOLUME]
    delete values.persistence?.[RESOURCES_VOLUME]
    delete values.persistence?.[WORKER_READINESS_VOLUME]
    delete values.persistence?.[WORKER_TOKEN_VOLUME]
    delete values.configMaps?.[MATERIALS_CONFIG_MAP]
    delete values.nodeSelector
    delete values.resources
    delete values.runtimeClassName
    delete values.tolerations
    writeYaml(filePath, values)
    return
  }

  const {worker} = input
  values.image ||= {}
  values.image.repository = worker.image.repository
  values.image.digest = worker.image.digest
  delete values.image.tag
  values.command = [PROVER_WORKER_EXECUTABLE]
  values.args = worker.argv
  values.env = worker.environment
  values.termination ||= {}
  values.termination.gracePeriodSeconds = 420
  values.service ||= {}
  values.service.main ||= {}
  values.service.main.enabled = false
  values.automountServiceAccountToken = false

  const deployment = input.topology.deployment || {}
  const tokenPath = workerArgument(worker, '--worker-token-file')
  const tokenName = path.posix.basename(tokenPath)
  const tokenKey = input.proofCoordinator?.secrets?.proverWorkerTokenProperty
    || 'prover-worker-token'
  values.persistence ||= {}
  values.persistence[WORKER_TOKEN_VOLUME] = {
    enabled: true,
    items: [{key: tokenKey, path: tokenName}],
    mountPath: tokenPath,
    name: deployment.workerSecretName
      || input.proofCoordinator?.secrets?.name
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

  configureMaterials(
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
  if (input.topology.generation === 'real') {
    if (deployment.workerResources) values.resources = deployment.workerResources
    else if (input.topology.active?.workerLaunch === 'local_cuda') {
      values.resources = {
        limits: {'nvidia.com/gpu': 1},
        requests: {'nvidia.com/gpu': 1},
      }
    } else delete values.resources

    if (deployment.workerNodeSelector) values.nodeSelector = deployment.workerNodeSelector
    else delete values.nodeSelector
    if (deployment.workerTolerations) values.tolerations = deployment.workerTolerations
    else delete values.tolerations
    if (deployment.workerRuntimeClassName) {
      values.runtimeClassName = deployment.workerRuntimeClassName
    } else delete values.runtimeClassName
  } else {
    // Production GPU placement is dormant in mock mode. Mock must remain
    // schedulable on the ordinary cluster nodes used before production cutover.
    delete values.nodeSelector
    delete values.resources
    delete values.runtimeClassName
    delete values.tolerations
  }

  writeYaml(filePath, values)
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

function annotate(
  values: Record<string, any>,
  bundleRevision: string,
): void {
  values.podAnnotations ||= {}
  for (const key of RETIRED_TOPOLOGY_ANNOTATIONS) delete values.podAnnotations[key]
  values.podAnnotations[TOPOLOGY_BUNDLE_ANNOTATION] = bundleRevision
}

function configureWithdrawalValues(
  filePath: string,
  configContent: string,
  mode: ProofTopologySpec['mode'],
  bundleRevision: string,
  materialsDir: string | undefined,
  generatedMaterialsRoot: string,
  resourceClaim: string | undefined,
  resourcesMountPath: string,
): void {
  const values = readYaml(filePath)
  ensureWithdrawalChartWiring(values)
  values.configMaps ||= {}
  values.configMaps.config ||= {}
  values.configMaps.config.enabled = true
  values.configMaps.config.data ||= {}
  values.configMaps.config.data[WITHDRAWAL_CONFIG_FILE] = configContent
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

  annotate(values, bundleRevision)
  configureMaterials(
    values,
    materialsDir,
    generatedMaterialsRoot,
  )
  configureProofResources(values, mode === 'disabled' ? undefined : resourceClaim, resourcesMountPath)
  writeYaml(filePath, values)
}

function configureL2Genesis(values: Record<string, any>, l2GenesisJson: string): void {
  values.persistence ||= {}
  values.persistence[GENESIS_VOLUME] = {
    enabled: true,
    mountPath: l2GenesisJson,
    name: 'genesis-config',
    readOnly: true,
    subPath: 'genesis.json',
    type: 'configMap',
  }
}

function configureCoordinatorValues(
  filePath: string,
  configContent: string,
  bundleRevision: string,
  materialsDir: string,
  generatedMaterialsRoot: string,
  resourceClaim: string | undefined,
  resourcesMountPath: string,
  l2GenesisJson: string,
): void {
  const values = readYaml(filePath)
  // Native compiler output is authoritative. Leaving old Figment variables in
  // the chart would partially override its strict tables after compilation.
  values.env = (Array.isArray(values.env) ? values.env : []).filter(
    (item: any) => !String(item?.name || '').startsWith('DOGEOS_PROOF_COORDINATOR_'),
  )
  values.proofCoordinator ||= {}
  values.proofCoordinator.config ||= {}
  values.proofCoordinator.config.content = configContent
  values.proofCoordinator.config.existingConfigMap = ''
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
  values.ingress ||= {}
  values.ingress.main ||= {}
  values.ingress.main.enabled = true
  annotate(values, bundleRevision)
  configureMaterials(
    values,
    materialsDir,
    generatedMaterialsRoot,
  )
  configureL2Genesis(values, l2GenesisJson)
  configureProofResources(values, resourceClaim, resourcesMountPath)
  writeYaml(filePath, values)
}

function configureAbsentCoordinatorValues(
  filePath: string,
  bundleRevision: string,
  generation: ProofTopologySpec['generation'],
  l2GenesisJson: string,
): void {
  const values = readYaml(filePath)
  // The deployment keeps PC warm across proof-mode changes. A disabled
  // compiler bundle intentionally has no PC projection, so install a minimal
  // observe/local_fs idle config instead of retaining a stale active topology.
  // With WP's proof-work API disabled it has no work to claim, and active
  // compilation replaces this config atomically later.
  values.env = (Array.isArray(values.env) ? values.env : []).filter(
    (item: any) => !String(item?.name || '').startsWith('DOGEOS_PROOF_COORDINATOR_'),
  )
  values.controller ||= {}
  values.controller.replicas = 1
  values.proofCoordinator ||= {}
  values.proofCoordinator.config ||= {}
  values.proofCoordinator.config.content = [
    '# Idle Proof Coordinator configuration for disabled proof topology.',
    '# WP does not expose proof work and no prover gateway or materializer runs.',
    'protocol_context_json = "/app/protocol_context.json"',
    'proof_work_base_url = "http://127.0.0.1:9300"',
    'coordinator_id = "proof-coordinator-idle"',
    `generation = "${generation}"`,
    '',
    '[artifact_store]',
    'kind = "local_fs"',
    'root = "/app/data/proof-artifacts"',
    '',
    '[verifier]',
    'enforcement = "observe"',
    '',
  ].join('\n')
  values.proofCoordinator.config.existingConfigMap = ''
  values.proofCoordinator.config.required = true
  values.service ||= {}
  values.service.main ||= {}
  values.service.main.enabled = true
  values.ingress ||= {}
  values.ingress.main ||= {}
  values.ingress.main.enabled = true
  values.configMaps ||= {}
  values.persistence ||= {}
  delete values.configMaps[MATERIALS_CONFIG_MAP]
  delete values.persistence[MATERIALS_VOLUME]
  delete values.persistence[RESOURCES_VOLUME]
  configureL2Genesis(values, l2GenesisJson)
  annotate(values, bundleRevision)
  writeYaml(filePath, values)
}

function envName(section: string, field: string): string {
  return `DOGEOS_ETH_DA_SUBMITTER_${section.toUpperCase()}__${field.toUpperCase()}`
}

function applySubmitterPatch(
  filePath: string,
  patchPath: string,
  bundleRevision: string,
): void {
  const values = readYaml(filePath)
  values.configMaps ||= {}
  values.configMaps.env ||= {data: {}, enabled: true}
  values.configMaps.env.data ||= {}
  const data = values.configMaps.env.data as Record<string, string>
  for (const key of Object.keys(data)) {
    if (key.startsWith('DOGEOS_ETH_DA_SUBMITTER_SEGMENTATION_SIDECAR__')) {
      delete data[key]
    }
  }

  const patch = toml.parse(fs.readFileSync(patchPath, 'utf8')) as Record<string, unknown>
  const patchS3 = patch.s3
  if (patchS3 && typeof patchS3 === 'object' && !Array.isArray(patchS3)) {
    const s3 = patchS3 as Record<string, unknown>
    if (s3.enabled === true) {
      // dogeos-core intentionally uses one submitter [s3] client for raw DA
      // blobs and segmentation sidecars. Refuse to let compiler output point
      // that shared client at a different namespace from the deployment-owned
      // ethereumDa.blobArchive.s3 projection already present in the values.
      for (const field of ['bucket', 'region', 'key_prefix'] as const) {
        const key = envName('s3', field)
        if (String(data[key] ?? '') !== String(s3[field] ?? '')) {
          throw new Error(
            `${patchPath}: compiler [s3].${field} (${String(s3[field])}) does not match `
            + `canonical eth-da-submitter ${key} (${String(data[key])})`,
          )
        }
      }
    }
    // A disabled proof topology may disable only segmentation publishing. Its
    // reset patch must not turn off the durable raw DA archive uploader.
  }

  for (const section of ['segmentation_sidecar', ...(patchS3 && (patchS3 as Record<string, unknown>).enabled === true ? ['s3'] : [])]) {
    const table = patch[section]
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue
    for (const [field, value] of Object.entries(table)) {
      if (!['boolean', 'number', 'string'].includes(typeof value)) {
        throw new Error(`${patchPath}: [${section}].${field} must be a scalar`)
      }

      data[envName(section, field)] = String(value)
    }
  }

  annotate(values, bundleRevision)
  writeYaml(filePath, values)
}

function argumentValue(worker: ProverWorkerContractV1 | undefined, flag: string): string | undefined {
  if (!worker) return undefined
  const index = worker.argv.indexOf(flag)
  return index >= 0 ? worker.argv[index + 1] : undefined
}

function derivedProverPublicUrl(options: ReconcileCompiledProofTopologyOptions): string | undefined {
  const {proofTopology: topology} = options
  if (topology.mode === 'disabled') return undefined

  if (options.proverPublicUrl) return options.proverPublicUrl
  if (options.coordinatorIngressHost) return `https://${options.coordinatorIngressHost}`
  throw new Error(
    `${topology.mode} Worker requires proofTopology.deployment.proverPublicUrl `
    + 'or a Proof Coordinator ingress host reachable over HTTPS',
  )
}

export function reconcileCompiledProofTopology(
  options: ReconcileCompiledProofTopologyOptions,
): ReconcileCompiledProofTopologyResult {
  const {proofTopology: topology} = options
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
    || derivedProverPublicUrl(options)
  const effectiveTopology: ProofTopologySpec = {
    ...topology,
    deployment: {
      ...topology.deployment,
      ...(proverPublicUrl ? {proverPublicUrl} : {}),
    },
  }
  const compileOptions: CompileProofTopologyOptions = {
    bridge: options.bridge,
    compilerBinary: options.compilerBinary,
    compilerImage: options.compilerImage,
    deploymentDir: options.deploymentDir,
    deploymentName: options.deploymentName,
    ethereumDaBlobSource: options.ethereumDaBlobSource,
    ethereumL1RpcUrl: options.ethereumL1RpcUrl,
    network: options.network,
    proofCoordinatorBaseConfig: options.coordinatorConfigPath,
    proofTopology: effectiveTopology,
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
    || '/app/data/proof-materials'
  const l2GenesisJson = topology.deployment?.l2GenesisJson
    || '/app/genesis/genesis.json'
  const resourceClaim = topology.deployment?.resourcesPersistentVolumeClaim
  const selectedResourceClaim = selectedRealScroll(topology) ? resourceClaim : undefined
  configureWithdrawalValues(
    withdrawalValuesPath,
    fs.readFileSync(options.withdrawalConfigPath, 'utf8'),
    mode,
    bundle.manifest.bundle_revision,
    materialsDir,
    generatedMaterialsRoot,
    selectedResourceClaim,
    resourcesMountPath,
  )
  if (mode === 'disabled') {
    configureAbsentCoordinatorValues(
      coordinatorValuesPath,
      bundle.manifest.bundle_revision,
      topology.generation,
      l2GenesisJson,
    )
  } else {
    if (!materialsDir || !coordinatorSource) {
      throw new Error('active compiler bundle is missing coordinator config or generated materials')
    }

    configureCoordinatorValues(
      coordinatorValuesPath,
      fs.readFileSync(options.coordinatorConfigPath, 'utf8'),
      bundle.manifest.bundle_revision,
      materialsDir,
      generatedMaterialsRoot,
      selectedResourceClaim,
      resourcesMountPath,
      l2GenesisJson,
    )
  }

  if (!fs.existsSync(workerValuesPath)) {
    throw new Error(`Prover Worker values template not found: ${workerValuesPath}`)
  }

  configureWorkerValues(workerValuesPath, {
    bundleRevision: bundle.manifest.bundle_revision,
    generatedMaterialsRoot,
    materialsDir,
    proofCoordinator: options.proofCoordinator,
    resourceClaim: selectedResourceClaim,
    resourcesMountPath,
    topology,
    worker: bundle.worker,
  })

  let workerBundle: CompiledProverWorkerBundleResult | undefined
  const workerDeploymentBackend = topology.deployment.workerDeploymentBackend || 'docker_compose'
  const composeWorker = bundle.worker && (
    bundle.worker.desired_state === 'external'
    || workerDeploymentBackend === 'docker_compose'
  ) ? bundle.worker : undefined
  if (composeWorker) {
    if (!bundle.manifest.prover_worker || !materialsDir) {
      throw new Error('Docker Compose Worker requires its compiler contract and generated materials')
    }

    const realScroll = selectedRealScroll(topology)
    if (!realScroll) throw new Error('Docker Compose Worker requires selected realScroll resources')
    const deploymentRoot = path.resolve(options.deploymentDir)
    const selectedResourcesRoot = realScroll.resourcesRoot
    if (!selectedResourcesRoot) {
      throw new Error(`Docker Compose ${mode} Worker requires a deployment-relative resources root`)
    }

    workerBundle = writeCompiledProverWorkerBundle({
      bundleDir: path.join(deploymentRoot, `prover-worker-${mode}/docker-compose`),
      contractFile: path.join(bundle.bundleDir, bundle.manifest.prover_worker),
      generatedMaterialsDir: materialsDir,
      generatedMaterialsRoot,
      protocolContextPath: deploymentFile(
        deploymentRoot,
        '.data/protocol_context.json',
        'deployment protocol context',
      ),
      protocolContextRuntimePath:
        topology.deployment?.protocolContextPath || '/app/protocol_context.json',
      resourcesMountPath,
      resourcesRoot: deploymentFile(
        deploymentRoot,
        selectedResourcesRoot,
        'proofTopology.active.realScroll.resourcesRoot',
      ),
      worker: composeWorker,
    })
  }

  if (!bundle.manifest.eth_da_submitter) {
    throw new Error('compiler bundle is missing the eth-da-submitter projection')
  }

  applySubmitterPatch(
    submitterValuesPath,
    path.join(bundle.bundleDir, bundle.manifest.eth_da_submitter),
    bundle.manifest.bundle_revision,
  )

  const generatedMaterialFiles = materialsDir
    ? filesRecursively(materialsDir).map(material => material.filePath)
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
      ...generatedMaterialFiles,
      ...(workerBundle?.files || []),
    ],
    proofArtifactBaseUrl: argumentValue(bundle.worker, '--artifact-read-base-url'),
    worker: bundle.worker,
    workerBundle,
  }
}
