import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ProofSystemMode } from './proof-system-mode.js'

export const DEFAULT_PROOF_DEPLOYMENT_CONTRACT = '.data/proof-deployment.json'

export interface ProofDeploymentFileBinding {
  key: string
  path: string
  sha256: string
}

export interface ProofDeploymentComponent {
  enabled: boolean
  setFiles: ProofDeploymentFileBinding[]
  valuesFile?: string
  valuesSha256?: string
}

export interface ProofDeploymentContract {
  components: {
    proofCoordinator: ProofDeploymentComponent
    tsoService: ProofDeploymentComponent
    withdrawalProcessor: ProofDeploymentComponent
  }
  generatedAt: string
  generationId: string
  generator: {
    command: 'scrollsdk setup proof-config'
    version: number
  }
  mode: ProofSystemMode
  proofArtifactBaseUrl?: string
  schemaVersion: 1
  signerPolicy: {
    policyMode: 'dev_permissive' | 'production_enforce' | 'staging_scaffold'
    proofArtifactFetchMode: 'disabled' | 'http'
  }
  worker: {
    bundleDir?: string
    bundleId?: string
    enabled: boolean
    kind: 'external-production' | 'mock-compose' | 'none'
  }
}

export interface ProofDeploymentContractInput {
  contractPath?: string
  deploymentDir: string
  mode: ProofSystemMode
  proofArtifactBaseUrl?: string
  proofCoordinator: {
    enabled: boolean
    setFiles: Array<{ filePath: string; key: string }>
    valuesFile?: string
  }
  tsoValuesFile: string
  withdrawalProcessor: {
    setFiles: Array<{ filePath: string; key: string }>
    valuesFile: string
  }
  worker?: {
    bundleDir?: string
    bundleId?: string
  }
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function stableContractFields(contract: ProofDeploymentContract): Omit<ProofDeploymentContract, 'generatedAt' | 'generationId'> {
  const stable = { ...contract } as Partial<ProofDeploymentContract>
  delete stable.generatedAt
  delete stable.generationId
  return stable as Omit<ProofDeploymentContract, 'generatedAt' | 'generationId'>
}

function deploymentRelativePath(deploymentDir: string, filePath: string): string {
  const root = path.resolve(deploymentDir)
  const resolved = path.resolve(filePath)
  const relative = path.relative(root, resolved)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return relative || '.'
  return resolved
}

function binding(deploymentDir: string, item: { filePath: string; key: string }): ProofDeploymentFileBinding {
  const filePath = path.resolve(item.filePath)
  if (!fs.existsSync(filePath)) throw new Error(`proof deployment binding file not found: ${filePath}`)
  return {
    key: item.key,
    path: deploymentRelativePath(deploymentDir, filePath),
    sha256: sha256File(filePath),
  }
}

function component(
  deploymentDir: string,
  enabled: boolean,
  valuesFile: string | undefined,
  setFiles: Array<{ filePath: string; key: string }>
): ProofDeploymentComponent {
  if (!enabled && !valuesFile) return { enabled, setFiles: [] }
  if (!valuesFile) throw new Error('enabled proof deployment component is missing a values file')
  const resolvedValues = path.resolve(valuesFile)
  if (!fs.existsSync(resolvedValues)) throw new Error(`proof deployment values file not found: ${resolvedValues}`)
  return {
    enabled,
    setFiles: enabled ? setFiles.map(item => binding(deploymentDir, item)) : [],
    valuesFile: deploymentRelativePath(deploymentDir, resolvedValues),
    valuesSha256: sha256File(resolvedValues),
  }
}

export function writeProofDeploymentContract(input: ProofDeploymentContractInput): ProofDeploymentContract {
  const deploymentDir = path.resolve(input.deploymentDir)
  const signerPolicy = input.mode === 'disabled'
    ? { policyMode: 'dev_permissive' as const, proofArtifactFetchMode: 'disabled' as const }
    : input.mode === 'mock'
      ? { policyMode: 'staging_scaffold' as const, proofArtifactFetchMode: 'http' as const }
      : { policyMode: 'production_enforce' as const, proofArtifactFetchMode: 'http' as const }
  const worker = input.mode === 'disabled'
    ? { enabled: false, kind: 'none' as const }
    : input.mode === 'mock'
      ? {
          bundleDir: input.worker?.bundleDir
            ? deploymentRelativePath(deploymentDir, input.worker.bundleDir)
            : undefined,
          bundleId: input.worker?.bundleId,
          enabled: true,
          kind: 'mock-compose' as const,
        }
      : { enabled: true, kind: 'external-production' as const }
  const stable = {
    components: {
      proofCoordinator: component(
        deploymentDir,
        input.proofCoordinator.enabled,
        input.proofCoordinator.valuesFile,
        input.proofCoordinator.setFiles
      ),
      tsoService: component(deploymentDir, true, input.tsoValuesFile, []),
      withdrawalProcessor: component(
        deploymentDir,
        true,
        input.withdrawalProcessor.valuesFile,
        input.withdrawalProcessor.setFiles
      ),
    },
    generator: { command: 'scrollsdk setup proof-config' as const, version: 1 },
    mode: input.mode,
    ...(input.mode === 'disabled' ? {} : { proofArtifactBaseUrl: input.proofArtifactBaseUrl }),
    schemaVersion: 1 as const,
    signerPolicy,
    worker,
  }
  const contract: ProofDeploymentContract = {
    ...stable,
    generatedAt: new Date().toISOString(),
    generationId: sha256Json(stable),
  }
  const contractPath = path.resolve(deploymentDir, input.contractPath || DEFAULT_PROOF_DEPLOYMENT_CONTRACT)
  fs.mkdirSync(path.dirname(contractPath), { recursive: true })
  const temporary = `${contractPath}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o644 })
  fs.renameSync(temporary, contractPath)
  return contract
}

export function readProofDeploymentContract(
  deploymentDir = '.',
  contractPath = DEFAULT_PROOF_DEPLOYMENT_CONTRACT
): { contract: ProofDeploymentContract; contractPath: string } {
  const resolved = path.resolve(deploymentDir, contractPath)
  if (!fs.existsSync(resolved)) {
    throw new Error(`proof deployment contract not found: ${resolved}; run scrollsdk setup proof-config first`)
  }

  const contract = JSON.parse(fs.readFileSync(resolved, 'utf8')) as ProofDeploymentContract
  if (contract.schemaVersion !== 1) throw new Error(`${resolved}: unsupported schemaVersion ${String(contract.schemaVersion)}`)
  return { contract, contractPath: resolved }
}

export function resolveContractFile(deploymentDir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(deploymentDir, filePath)
}

export function validateProofDeploymentContract(
  deploymentDir = '.',
  contractPath = DEFAULT_PROOF_DEPLOYMENT_CONTRACT
): ProofDeploymentContract {
  const root = path.resolve(deploymentDir)
  const { contract, contractPath: resolvedContract } = readProofDeploymentContract(root, contractPath)
  const problems: string[] = []
  if (!['disabled', 'mock', 'production'].includes(contract.mode)) {
    problems.push(`unsupported mode: ${String(contract.mode)}`)
  }

  if (sha256Json(stableContractFields(contract)) !== contract.generationId) {
    problems.push('generation ID does not match the deployment contract contents')
  }

  for (const [componentName, item] of Object.entries(contract.components)) {
    if (!item.enabled && !item.valuesFile) continue
    if (!item.valuesFile || !item.valuesSha256) {
      problems.push(`${componentName}: values file metadata missing`)
      continue
    }

    const valuesPath = resolveContractFile(root, item.valuesFile)
    if (!fs.existsSync(valuesPath)) problems.push(`${componentName}: values file missing: ${item.valuesFile}`)
    else if (sha256File(valuesPath) !== item.valuesSha256) problems.push(`${componentName}: values file checksum mismatch: ${item.valuesFile}`)
    for (const setFile of item.setFiles) {
      const filePath = resolveContractFile(root, setFile.path)
      if (!fs.existsSync(filePath)) problems.push(`${componentName}: set-file missing: ${setFile.path}`)
      else if (sha256File(filePath) !== setFile.sha256) problems.push(`${componentName}: set-file checksum mismatch: ${setFile.path}`)
    }
  }

  if (!contract.components.tsoService.enabled) problems.push('tso-service must remain enabled in every proof mode')
  if (!contract.components.withdrawalProcessor.enabled) problems.push('withdrawal-processor must remain enabled in every proof mode')

  if (contract.mode === 'disabled') {
    if (contract.components.proofCoordinator.enabled) problems.push('disabled mode must not enable proof-coordinator')
    if (contract.worker.enabled || contract.worker.kind !== 'none') problems.push('disabled mode must not enable a prover worker')
    if (contract.proofArtifactBaseUrl) problems.push('disabled mode must not publish a proof artifact base URL')
    if (contract.signerPolicy.policyMode !== 'dev_permissive'
      || contract.signerPolicy.proofArtifactFetchMode !== 'disabled') {
      problems.push('disabled mode requires the direct-sign signer policy posture')
    }
  } else if (!contract.components.proofCoordinator.enabled) {
    problems.push(`${contract.mode} mode must enable proof-coordinator`)
  }

  if (contract.mode !== 'disabled' && !contract.proofArtifactBaseUrl) {
    problems.push(`${contract.mode} mode requires a proof artifact base URL`)
  }

  if (contract.mode === 'mock' && (contract.worker.kind !== 'mock-compose' || !contract.worker.bundleDir || !contract.worker.bundleId)) {
    problems.push('mock mode requires a manifest-bearing mock worker bundle')
  }

  if (contract.mode === 'mock' && (!contract.worker.enabled
    || contract.signerPolicy.policyMode !== 'staging_scaffold'
    || contract.signerPolicy.proofArtifactFetchMode !== 'http')) {
    problems.push('mock mode requires the enabled mock worker and staging signer policy posture')
  }

  if (contract.mode === 'production' && (!contract.worker.enabled
    || contract.worker.kind !== 'external-production'
    || contract.signerPolicy.policyMode !== 'production_enforce'
    || contract.signerPolicy.proofArtifactFetchMode !== 'http')) {
    problems.push('production mode requires the external worker and production signer policy posture')
  }

  if (problems.length > 0) {
    throw new Error(`${resolvedContract}: stale or invalid proof deployment contract:\n- ${problems.join('\n- ')}`)
  }

  return contract
}
