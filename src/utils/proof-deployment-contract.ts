import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { PreTsukiDirectSignIntent } from './pre-tsuki-direct-sign.js'
import type { ProofIntentSource } from './proof-intent.js'
import type { ProofSystemMode } from './proof-system-mode.js'

import { PRE_TSUKI_DIRECT_SIGN_TSO_ENV } from './pre-tsuki-direct-sign.js'
import {
  MANAGED_VERIFIER_BEGIN,
  MANAGED_VERIFIER_END,
} from './proof-configurator.js'
import {
  WITHDRAWAL_PROOF_BEGIN,
  WITHDRAWAL_PROOF_END,
} from './withdrawal-config.js'

export const DEFAULT_PROOF_DEPLOYMENT_CONTRACT = '.data/proof-deployment.json'

export type ProofDeploymentIntegrityPolicy = 'advisory' | 'managed-block' | 'required'

export interface ProofDeploymentFileIntegrity {
  beginMarker?: string
  endMarker?: string
  policy: ProofDeploymentIntegrityPolicy
  sha256: string
}

export interface ProofDeploymentFileBinding {
  integrity?: ProofDeploymentFileIntegrity
  key: string
  path: string
  /** Whole-file observation. Required by schema v1; advisory under schema v2/v3. */
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
    command: 'scrollsdk setup prep-charts' | 'scrollsdk setup proof-config'
    version: number
  }
  intentSource?: ProofIntentSource
  mode: ProofSystemMode
  /** Temporary, testnet-only Issue #843 recovery posture. */
  preTsukiDirectSign?: PreTsukiDirectSignIntent
  proofArtifactBaseUrl?: string
  schemaVersion: 1 | 2 | 3
  signerPolicy: {
    policyMode: 'dev_permissive' | 'production_enforce' | 'staging_scaffold'
    proofArtifactFetchMode: 'disabled' | 'http'
  }
  worker: {
    bundleDir?: string
    bundleId?: string
    enabled: boolean
    kind: 'external-production' | 'mock-compose' | 'none' | 'production-compose'
  }
}

export interface ProofDeploymentContractInput {
  contractPath?: string
  deploymentDir: string
  intentSource?: ProofIntentSource
  mode: ProofSystemMode
  preTsukiDirectSign?: PreTsukiDirectSignIntent
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
    kind?: 'mock-compose' | 'production-compose'
  }
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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

function extractManagedBlock(
  source: string,
  beginMarker: string,
  endMarker: string,
  label: string
): string {
  const beginCount = source.split(beginMarker).length - 1
  const endCount = source.split(endMarker).length - 1
  const begin = source.indexOf(beginMarker)
  const end = source.indexOf(endMarker)
  if (beginCount !== 1 || endCount !== 1 || begin < 0 || end < begin) {
    throw new Error(`${label}: expected exactly one ${beginMarker} / ${endMarker} block`)
  }

  return source.slice(begin, end + endMarker.length)
}

function bindingIntegrity(filePath: string, key: string): ProofDeploymentFileIntegrity {
  const source = fs.readFileSync(filePath, 'utf8')
  if (key === 'proofCoordinator.config.content') {
    return {
      beginMarker: MANAGED_VERIFIER_BEGIN,
      endMarker: MANAGED_VERIFIER_END,
      policy: 'managed-block',
      sha256: sha256Text(extractManagedBlock(
        source,
        MANAGED_VERIFIER_BEGIN,
        MANAGED_VERIFIER_END,
        filePath,
      )),
    }
  }

  if (key === 'configMaps.config.data.WithdrawalProcessor\\.toml') {
    return {
      beginMarker: WITHDRAWAL_PROOF_BEGIN,
      endMarker: WITHDRAWAL_PROOF_END,
      policy: 'managed-block',
      sha256: sha256Text(extractManagedBlock(
        source,
        WITHDRAWAL_PROOF_BEGIN,
        WITHDRAWAL_PROOF_END,
        filePath,
      )),
    }
  }

  return { policy: 'required', sha256: sha256File(filePath) }
}

function binding(deploymentDir: string, item: { filePath: string; key: string }): ProofDeploymentFileBinding {
  const filePath = path.resolve(item.filePath)
  if (!fs.existsSync(filePath)) throw new Error(`proof deployment binding file not found: ${filePath}`)
  return {
    integrity: bindingIntegrity(filePath, item.key),
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
      : input.worker?.kind === 'production-compose'
        ? {
            bundleDir: input.worker.bundleDir
              ? deploymentRelativePath(deploymentDir, input.worker.bundleDir)
              : undefined,
            bundleId: input.worker.bundleId,
            enabled: true,
            kind: 'production-compose' as const,
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
    generator: { command: 'scrollsdk setup prep-charts' as const, version: 1 },
    ...(input.intentSource
      ? {
          intentSource: {
            kind: input.intentSource.kind,
            path: deploymentRelativePath(deploymentDir, input.intentSource.path),
          },
        }
      : {}),
    mode: input.mode,
    ...(input.preTsukiDirectSign
      ? {preTsukiDirectSign: input.preTsukiDirectSign}
      : {}),
    ...(input.proofArtifactBaseUrl ? {proofArtifactBaseUrl: input.proofArtifactBaseUrl} : {}),
    schemaVersion: 3 as const,
    signerPolicy,
    worker,
  }
  const generationId = sha256Json(stable)
  const contractPath = path.resolve(deploymentDir, input.contractPath || DEFAULT_PROOF_DEPLOYMENT_CONTRACT)
  let generatedAt = new Date().toISOString()
  if (fs.existsSync(contractPath)) {
    try {
      const previous = JSON.parse(fs.readFileSync(contractPath, 'utf8')) as ProofDeploymentContract
      if (previous.generationId === generationId
        && sha256Json(stableContractFields(previous)) === generationId) {
        generatedAt = previous.generatedAt
      }
    } catch {
      // Invalid existing contracts are replaced by the newly generated one.
    }
  }

  const contract: ProofDeploymentContract = {
    ...stable,
    generatedAt,
    generationId,
  }
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
    throw new Error(`proof deployment contract not found: ${resolved}; run scrollsdk setup prep-charts first`)
  }

  const contract = JSON.parse(fs.readFileSync(resolved, 'utf8')) as ProofDeploymentContract
  if (![1, 2, 3].includes(contract.schemaVersion)) {
    throw new Error(`${resolved}: unsupported schemaVersion ${String(contract.schemaVersion)}`)
  }

  return { contract, contractPath: resolved }
}

export function resolveContractFile(deploymentDir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(deploymentDir, filePath)
}

export interface ProofDeploymentValidationOptions {
  strict?: boolean
}

export interface ProofDeploymentValidationResult {
  contract: ProofDeploymentContract
  warnings: string[]
}

function validateBinding(
  root: string,
  componentName: string,
  setFile: ProofDeploymentFileBinding,
  schemaVersion: 1 | 2 | 3,
  problems: string[],
  warnings: string[],
): void {
  const filePath = resolveContractFile(root, setFile.path)
  if (!fs.existsSync(filePath)) {
    problems.push(`${componentName}: set-file missing: ${setFile.path}`)
    return
  }

  const wholeFileSha256 = sha256File(filePath)
  if (schemaVersion === 1 || !setFile.integrity) {
    const nativeOperationalConfig = setFile.key === 'proofCoordinator.config.content'
      || setFile.key === 'configMaps.config.data.WithdrawalProcessor\\.toml'
    if (wholeFileSha256 !== setFile.sha256) {
      const message = `${componentName}: legacy set-file checksum mismatch: ${setFile.path}`
      if (nativeOperationalConfig) warnings.push(`${message}; regenerate with prep-charts to enable managed-block integrity`)
      else problems.push(message)
    }

    return
  }

  if (setFile.integrity.policy === 'required') {
    if (wholeFileSha256 !== setFile.integrity.sha256) {
      problems.push(`${componentName}: proof-critical set-file checksum mismatch: ${setFile.path}`)
    }

    return
  }

  if (setFile.integrity.policy === 'managed-block') {
    const {beginMarker, endMarker} = setFile.integrity
    if (!beginMarker || !endMarker) {
      problems.push(`${componentName}: managed-block integrity metadata missing markers: ${setFile.path}`)
      return
    }

    try {
      const source = fs.readFileSync(filePath, 'utf8')
      const block = extractManagedBlock(source, beginMarker, endMarker, filePath)
      if (sha256Text(block) !== setFile.integrity.sha256) {
        problems.push(`${componentName}: proof-managed block checksum mismatch: ${setFile.path}`)
      } else if (wholeFileSha256 !== setFile.sha256) {
        warnings.push(`${componentName}: operational content changed outside the proof-managed block: ${setFile.path}`)
      }
    } catch (error) {
      problems.push(`${componentName}: ${error instanceof Error ? error.message : String(error)}`)
    }

    return
  }

  if (wholeFileSha256 !== setFile.integrity.sha256) {
    warnings.push(`${componentName}: advisory set-file checksum mismatch: ${setFile.path}`)
  }
}

function parseWithdrawalPreTsukiDirectSignPin(
  root: string,
  contract: ProofDeploymentContract,
  problems: string[],
): number | undefined {
  const binding = contract.components.withdrawalProcessor.setFiles.find(
    item => item.key === 'configMaps.config.data.WithdrawalProcessor\\.toml',
  )
  if (!binding) {
    if (contract.preTsukiDirectSign) {
      problems.push('withdrawalProcessor: pre-Tsuki direct-sign validation requires the native WithdrawalProcessor.toml binding')
    }

    return undefined
  }

  const filePath = resolveContractFile(root, binding.path)
  if (!fs.existsSync(filePath)) return undefined
  try {
    const parsed = toml.parse(fs.readFileSync(filePath, 'utf8')) as {
      proof_system?: {
        pre_tsuki_direct_sign?: {
          max_end_batch_height?: unknown
        }
      }
    }
    const value = parsed.proof_system?.pre_tsuki_direct_sign?.max_end_batch_height
    if (value === undefined) return undefined
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 4_294_967_295) {
      problems.push('withdrawalProcessor: [proof_system.pre_tsuki_direct_sign].max_end_batch_height must be an integer in 1..=4294967295')
      return undefined
    }

    return value as number
  } catch (error) {
    problems.push(`withdrawalProcessor: failed to parse direct-sign projection: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function parseTsoPreTsukiDirectSignPin(
  root: string,
  contract: ProofDeploymentContract,
  problems: string[],
): number | undefined {
  const {valuesFile} = contract.components.tsoService
  if (!valuesFile) return undefined
  const filePath = resolveContractFile(root, valuesFile)
  if (!fs.existsSync(filePath)) return undefined
  try {
    const parsed = yaml.load(fs.readFileSync(filePath, 'utf8')) as {
      env?: Array<{name?: unknown; value?: unknown}>
    } | undefined
    const env = parsed?.env
    if (!Array.isArray(env)) {
      problems.push('tsoService: env must be an array for pre-Tsuki direct-sign validation')
      return undefined
    }

    const matches = env.filter(item => item?.name === PRE_TSUKI_DIRECT_SIGN_TSO_ENV)
    if (matches.length > 1) {
      problems.push(`tsoService: ${PRE_TSUKI_DIRECT_SIGN_TSO_ENV} must appear at most once`)
      return undefined
    }

    if (matches.length === 0) return undefined
    const [{value}] = matches
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      problems.push(`tsoService: ${PRE_TSUKI_DIRECT_SIGN_TSO_ENV} must be a decimal string`)
      return undefined
    }

    const parsedValue = Number(value)
    if (!Number.isSafeInteger(parsedValue) || parsedValue < 1 || parsedValue > 4_294_967_295) {
      problems.push(`tsoService: ${PRE_TSUKI_DIRECT_SIGN_TSO_ENV} must be in 1..=4294967295`)
      return undefined
    }

    return parsedValue
  } catch (error) {
    problems.push(`tsoService: failed to parse direct-sign projection: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function validatePreTsukiDirectSignProjection(
  root: string,
  contract: ProofDeploymentContract,
  problems: string[],
): void {
  const expected = contract.preTsukiDirectSign?.maxEndBatchHeight
  if (contract.preTsukiDirectSign) {
    if (contract.mode !== 'disabled') {
      problems.push('preTsukiDirectSign requires disabled mode')
    }

    if (!Number.isSafeInteger(expected) || expected! < 1 || expected! > 4_294_967_295) {
      problems.push('preTsukiDirectSign.maxEndBatchHeight must be an integer in 1..=4294967295')
    }
  }

  const withdrawalPin = parseWithdrawalPreTsukiDirectSignPin(root, contract, problems)
  const tsoPin = parseTsoPreTsukiDirectSignPin(root, contract, problems)
  if (withdrawalPin !== expected) {
    problems.push(`withdrawalProcessor: pre-Tsuki direct-sign pin ${String(withdrawalPin)} does not match contract ${String(expected)}`)
  }

  if (tsoPin !== expected) {
    problems.push(`tsoService: pre-Tsuki direct-sign pin ${String(tsoPin)} does not match contract ${String(expected)}`)
  }
}

export function validateProofDeploymentContractWithWarnings(
  deploymentDir = '.',
  contractPath = DEFAULT_PROOF_DEPLOYMENT_CONTRACT,
  options: ProofDeploymentValidationOptions = {},
): ProofDeploymentValidationResult {
  const root = path.resolve(deploymentDir)
  const { contract, contractPath: resolvedContract } = readProofDeploymentContract(root, contractPath)
  const problems: string[] = []
  const warnings: string[] = []
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
    else if (sha256File(valuesPath) !== item.valuesSha256) {
      warnings.push(`${componentName}: operational values checksum mismatch: ${item.valuesFile}`)
    }

    for (const setFile of item.setFiles) {
      validateBinding(root, componentName, setFile, contract.schemaVersion, problems, warnings)
    }
  }

  if (!contract.components.tsoService.enabled) problems.push('tso-service must remain enabled in every proof mode')
  if (!contract.components.withdrawalProcessor.enabled) problems.push('withdrawal-processor must remain enabled in every proof mode')

  // Schema v3 makes the temporary recovery posture an explicit deployment
  // contract and proves both generated runtime projections agree with it.
  // Legacy contracts remain readable without retroactively assigning intent.
  if (contract.schemaVersion === 3) {
    validatePreTsukiDirectSignProjection(root, contract, problems)
  }

  if (contract.mode === 'disabled') {
    if (contract.components.proofCoordinator.enabled) problems.push('disabled mode must not enable proof-coordinator')
    if (contract.worker.enabled || contract.worker.kind !== 'none') problems.push('disabled mode must not enable a prover worker')
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
    || !['external-production', 'production-compose'].includes(contract.worker.kind)
    || contract.signerPolicy.policyMode !== 'production_enforce'
    || contract.signerPolicy.proofArtifactFetchMode !== 'http')) {
    problems.push('production mode requires the external worker and production signer policy posture')
  }

  if (contract.mode === 'production' && contract.worker.kind === 'production-compose'
    && (!contract.worker.bundleDir || !contract.worker.bundleId)) {
    problems.push('production compose worker requires a manifest-bearing bundle')
  }

  if (options.strict) {
    problems.push(...warnings.map(warning => `strict integrity: ${warning}`))
  }

  if (problems.length > 0) {
    throw new Error(`${resolvedContract}: stale or invalid proof deployment contract:\n- ${problems.join('\n- ')}`)
  }

  return {contract, warnings}
}

export function validateProofDeploymentContract(
  deploymentDir = '.',
  contractPath = DEFAULT_PROOF_DEPLOYMENT_CONTRACT,
  options: ProofDeploymentValidationOptions = {},
): ProofDeploymentContract {
  return validateProofDeploymentContractWithWarnings(deploymentDir, contractPath, options).contract
}
