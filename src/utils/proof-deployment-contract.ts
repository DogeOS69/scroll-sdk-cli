import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {ProofEnforcement, ProofGeneration, ProofTopologyMode} from '../types/proof-topology.js'
import type {ProofIntentSource} from './proof-intent.js'

import {proofManagedValuesDigest} from './proof-managed-values.js'
import {readProofMaterials} from './proof-materials.js'
import {proofRegularFile} from './proof-software-release.js'

export const DEFAULT_PROOF_DEPLOYMENT_CONTRACT = '.data/proof-deployment.json'

export interface ProofDeploymentComponent {
  enabled: boolean
  managedSha256: string
  valuesFile: string
  valuesIntegrity: 'required'
  valuesSha256: string
}

export interface ProofDeploymentContract {
  artifactStoreReceipt?: {path: string; sha256: string}
  components: {
    cubesignerSigner?: ProofDeploymentComponent
    eagerMaterializer?: ProofDeploymentComponent
    ethDaSubmitter: ProofDeploymentComponent
    proofCoordinator: ProofDeploymentComponent
    proverWorker: ProofDeploymentComponent
    tsoService: ProofDeploymentComponent
    withdrawalProcessor: ProofDeploymentComponent
  }
  enforcement: ProofEnforcement
  generatedAt: string
  generation: ProofGeneration
  generationId: string
  generator: {command: 'scrollsdk setup prep-charts'; version: 3}
  inputs?: {materials: {path: string; sha256: string}; protocolContext: {path: string; sha256: string}; publication?: {path: string; sha256: string}}
  intentSource: ProofIntentSource
  mode: ProofTopologyMode
  proofArtifactBaseUrl?: string
  schemaVersion: 8
  topology: {
    bundleDir: string
    bundleManifest: string
    bundleManifestSha256: string
    bundleRevision: string
    resolvedSidecar: string
    resolvedSidecarSha256: string
  }
  worker: {
    bundleDir?: string
    bundleId?: string
    contractFile?: string
    contractSha256?: string
    enabled: boolean
    kind: 'compiled-compose' | 'compiled-external' | 'compiled-local' | 'none'
  }
}

interface ComponentInput {
  enabled: boolean
  valuesFile: string
}

export interface ProofDeploymentContractInput {
  contractPath?: string
  cubesignerSigner?: ComponentInput
  deploymentDir: string
  eagerMaterializer?: ComponentInput
  enforcement: ProofEnforcement
  ethDaSubmitter: {valuesFile: string}
  generation: ProofGeneration
  intentSource: ProofIntentSource
  materialsReceipt?: string
  mode: ProofTopologyMode
  proofArtifactBaseUrl?: string
  proofAwsConfig?: string
  proofCoordinator: ComponentInput
  proverWorker: ComponentInput
  publicationReceipt?: string
  topology: {bundleDir: string; bundleManifest: string; bundleRevision: string; resolvedSidecar: string}
  tsoValuesFile: string
  withdrawalProcessor: ComponentInput
  worker?: {
    bundleDir?: string
    bundleId?: string
    contractFile: string
    kind: 'compiled-compose' | 'compiled-external' | 'compiled-local'
  }
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function relative(root: string, filePath: string): string {
  const resolved = path.resolve(filePath)
  const value = path.relative(path.resolve(root), resolved)
  return value.startsWith('..') || path.isAbsolute(value) ? resolved : value || '.'
}

function component(root: string, input: ComponentInput, name: string): ProofDeploymentComponent {
  if (!fs.existsSync(input.valuesFile)) throw new Error(`proof values file not found: ${input.valuesFile}`)
  return {
    enabled: input.enabled,
    managedSha256: proofManagedValuesDigest(input.valuesFile, name),
    valuesFile: relative(root, input.valuesFile),
    valuesIntegrity: 'required',
    valuesSha256: sha256File(input.valuesFile),
  }
}

export function writeProofDeploymentContract(input: ProofDeploymentContractInput): ProofDeploymentContract {
  const root = path.resolve(input.deploymentDir)
  if (input.generation === 'mock' && (input.worker || input.proverWorker.enabled)) throw new Error('mock proving must not deploy a Worker')
  const worker = input.mode === 'disabled' || input.generation === 'mock'
    ? {enabled: false, kind: 'none' as const}
    : input.worker
      ? {
          ...(input.worker.bundleDir ? {bundleDir: relative(root, input.worker.bundleDir)} : {}),
          ...(input.worker.bundleId ? {bundleId: input.worker.bundleId} : {}),
          contractFile: relative(root, input.worker.contractFile),
          contractSha256: sha256File(path.resolve(root, input.worker.contractFile)),
          enabled: true,
          kind: input.worker.kind,
        }
      : (() => { throw new Error('active topology is missing its Worker contract') })()
  const manifest = path.resolve(root, input.topology.bundleManifest)
  const sidecar = path.resolve(root, input.topology.resolvedSidecar)
  let inputs: ProofDeploymentContract['inputs']
  if (input.materialsReceipt) {
    const receiptPath = proofRegularFile(path.resolve(root, input.materialsReceipt))
    const materials = readProofMaterials(receiptPath, root)
    if (!materials.bridge) throw new Error('Selected proof materials have no protocol-bound Bridge bake')
    const protocol = proofRegularFile(path.resolve(root, materials.bridge.protocolContextPath))
    inputs = {
      materials: {path: relative(root, receiptPath), sha256: sha256File(receiptPath)},
      protocolContext: {path: relative(root, protocol), sha256: materials.bridge.protocolContextSha256},
      ...(input.publicationReceipt ? {publication: {path: relative(root, proofRegularFile(path.resolve(root, input.publicationReceipt))), sha256: sha256File(path.resolve(root, input.publicationReceipt))}} : {}),
    }
  }

  const stable = {
    ...(input.proofAwsConfig ? {artifactStoreReceipt: {path: relative(root, proofRegularFile(path.resolve(root, input.proofAwsConfig))), sha256: sha256File(path.resolve(root, input.proofAwsConfig))}} : {}),
    components: {
      ...(input.cubesignerSigner ? {cubesignerSigner: component(root, input.cubesignerSigner, 'cubesignerSigner')} : {}),
      ...(input.eagerMaterializer ? {eagerMaterializer: component(root, input.eagerMaterializer, 'eagerMaterializer')} : {}),
      ethDaSubmitter: component(root, {enabled: true, valuesFile: input.ethDaSubmitter.valuesFile}, 'ethDaSubmitter'),
      proofCoordinator: component(root, input.proofCoordinator, 'proofCoordinator'),
      proverWorker: component(root, input.proverWorker, 'proverWorker'),
      tsoService: component(root, {enabled: true, valuesFile: input.tsoValuesFile}, 'tsoService'),
      withdrawalProcessor: component(root, input.withdrawalProcessor, 'withdrawalProcessor'),
    },
    enforcement: input.enforcement,
    generation: input.generation,
    generator: {command: 'scrollsdk setup prep-charts' as const, version: 3 as const},
    intentSource: {...input.intentSource, path: relative(root, input.intentSource.path)},
    mode: input.mode,
    ...(input.proofArtifactBaseUrl ? {proofArtifactBaseUrl: input.proofArtifactBaseUrl} : {}),
    ...(inputs ? {inputs} : {}),
    schemaVersion: 8 as const,
    topology: {
      bundleDir: relative(root, input.topology.bundleDir),
      bundleManifest: relative(root, manifest),
      bundleManifestSha256: sha256File(manifest),
      bundleRevision: input.topology.bundleRevision,
      resolvedSidecar: relative(root, sidecar),
      resolvedSidecarSha256: sha256File(sidecar),
    },
    worker,
  }
  const generationId = sha256Json(stable)
  const contract: ProofDeploymentContract = {...stable, generatedAt: new Date().toISOString(), generationId}
  const target = path.resolve(root, input.contractPath ?? DEFAULT_PROOF_DEPLOYMENT_CONTRACT)
  fs.mkdirSync(path.dirname(target), {recursive: true})
  const temporary = `${target}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(contract, null, 2)}\n`)
  fs.renameSync(temporary, target)
  return contract
}

export function resolveContractFile(deploymentDir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(deploymentDir, filePath)
}

export function readProofDeploymentContract(deploymentDir = '.', contractPath = DEFAULT_PROOF_DEPLOYMENT_CONTRACT): {contract: ProofDeploymentContract; contractPath: string} {
  const resolved = path.resolve(deploymentDir, contractPath)
  if (!fs.existsSync(resolved)) throw new Error(`proof deployment contract not found: ${resolved}; run scrollsdk setup prep-charts first`)
  const contract = JSON.parse(fs.readFileSync(resolved, 'utf8')) as ProofDeploymentContract
  if (contract.schemaVersion !== 8) throw new Error(`${resolved}: unsupported proof deployment contract; rerun prep-charts`)
  return {contract, contractPath: resolved}
}

export function validateProofDeploymentContract(
  deploymentDir = '.',
  contractPath = DEFAULT_PROOF_DEPLOYMENT_CONTRACT,
): ProofDeploymentContract {
  const root = path.resolve(deploymentDir)
  const {contract} = readProofDeploymentContract(root, contractPath)
  const problems: string[] = []
  const stable = {...contract} as Partial<ProofDeploymentContract>
  delete stable.generatedAt
  delete stable.generationId
  if (sha256Json(stable) !== contract.generationId) problems.push('generation ID does not match contract contents')
  if (!['active', 'disabled'].includes(contract.mode)) problems.push('invalid proof mode')
  if (!['mock', 'real'].includes(contract.generation)) problems.push('invalid proof generation')
  if (!['enforce', 'observe'].includes(contract.enforcement)) problems.push('invalid proof enforcement')
  if (contract.enforcement === 'enforce' && (contract.mode !== 'active' || contract.generation !== 'real')) problems.push('enforcement requires active real proving')
  for (const [name, item] of Object.entries(contract.components)) {
    const values = resolveContractFile(root, item.valuesFile)
    if (!fs.existsSync(values)) problems.push(`${name}: values file is missing`)
    else if (proofManagedValuesDigest(values, name) !== item.managedSha256) problems.push(`${name}: proof-managed values changed; rerun prep-charts`)

  }

  if (contract.artifactStoreReceipt) {
    try {
      if (sha256File(proofRegularFile(resolveContractFile(root, contract.artifactStoreReceipt.path))) !== contract.artifactStoreReceipt.sha256) problems.push('artifact-store receipt checksum mismatch')
    } catch { problems.push('artifact-store receipt is missing or unsafe') }
  }

  for (const [name, binding] of Object.entries(contract.inputs ?? {})) {
    try {
      if (sha256File(proofRegularFile(resolveContractFile(root, binding.path))) !== binding.sha256) problems.push(`${name}: selected input checksum mismatch`)
    } catch { problems.push(`${name}: selected input is missing or unsafe`) }
  }

  if (contract.inputs) {
    try { readProofMaterials(resolveContractFile(root, contract.inputs.materials.path), root) }
    catch (error) { problems.push(`selected materials: ${String(error)}`) }
  }

  if (contract.worker.enabled) {
    const file = contract.worker.contractFile && resolveContractFile(root, contract.worker.contractFile)
    if (!file || !fs.existsSync(file) || sha256File(file) !== contract.worker.contractSha256) problems.push('Worker contract checksum mismatch')
  }

  const manifest = resolveContractFile(root, contract.topology.bundleManifest)
  const sidecar = resolveContractFile(root, contract.topology.resolvedSidecar)
  if (!fs.existsSync(manifest) || sha256File(manifest) !== contract.topology.bundleManifestSha256) problems.push('bundle manifest checksum mismatch')
  if (!fs.existsSync(sidecar) || sha256File(sidecar) !== contract.topology.resolvedSidecarSha256) problems.push('resolved sidecar checksum mismatch')
  if (contract.mode === 'disabled') {
    if (!contract.components.proofCoordinator.enabled) problems.push('disabled mode keeps the idle PC deployment enabled')
    if (contract.components.proverWorker.enabled || contract.worker.enabled) problems.push('disabled mode must keep Worker absent')
  } else {
    if (!contract.components.proofCoordinator.enabled) problems.push('active mode requires PC')
    if (contract.generation === 'real' && !contract.worker.enabled) problems.push('active real generation requires a Worker contract')
    if (contract.generation === 'mock' && (contract.worker.enabled || contract.components.proverWorker.enabled)) problems.push('mock proving must keep Worker absent')
  }

  if (problems.length > 0) throw new Error(`Invalid proof deployment contract:\n- ${problems.join('\n- ')}`)
  return contract
}
