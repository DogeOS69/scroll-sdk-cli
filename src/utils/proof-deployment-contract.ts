import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {PreTsukiDirectSignIntent} from './pre-tsuki-direct-sign.js'
import type {ProofIntentSource} from './proof-intent.js'
import type {ProofSystemMode} from './proof-system-mode.js'

import {PRE_TSUKI_DIRECT_SIGN_TSO_ENV} from './pre-tsuki-direct-sign.js'

export const DEFAULT_PROOF_DEPLOYMENT_CONTRACT = '.data/proof-deployment.json'

export interface ProofDeploymentFileIntegrity {
  policy: 'required'
  sha256: string
}

export interface ProofDeploymentFileBinding {
  integrity: ProofDeploymentFileIntegrity
  key: string
  path: string
  sha256: string
}

export interface ProofDeploymentComponent {
  enabled: boolean
  setFiles: ProofDeploymentFileBinding[]
  valuesFile: string
  valuesIntegrity: 'required'
  valuesSha256: string
}

export interface ProofDeploymentContract {
  components: {
    ethDaSubmitter: ProofDeploymentComponent
    proofCoordinator: ProofDeploymentComponent
    proverWorker: ProofDeploymentComponent
    tsoService: ProofDeploymentComponent
    withdrawalProcessor: ProofDeploymentComponent
  }
  generatedAt: string
  generationId: string
  generator: {
    command: 'scrollsdk setup prep-charts'
    version: 1
  }
  intentSource: ProofIntentSource
  mode: ProofSystemMode
  preTsukiDirectSign?: PreTsukiDirectSignIntent
  proofArtifactBaseUrl?: string
  schemaVersion: 5
  signerPolicy: {
    policyMode: 'dev_permissive' | 'production_enforce' | 'staging_scaffold'
    proofArtifactFetchMode: 'disabled' | 'http'
  }
  topology: {
    bundleDir: string
    bundleManifest: string
    bundleManifestSha256: string
    deploymentRevision: string
    digest: string
    resolvedSidecar: string
    resolvedSidecarSha256: string
    rolloutPlan: string
    rolloutPlanSha256: string
  }
  worker: {
    bundleDir?: string
    bundleId?: string
    contractFile?: string
    contractSha256?: string
    enabled: boolean
    kind: 'compiled-external' | 'compiled-local' | 'none'
  }
}

interface ComponentInput {
  enabled: boolean
  setFiles: Array<{filePath: string; integrityPolicy?: 'required'; key: string}>
  valuesFile: string
}

export interface ProofDeploymentContractInput {
  contractPath?: string
  deploymentDir: string
  ethDaSubmitter: {valuesFile: string}
  intentSource: ProofIntentSource
  mode: ProofSystemMode
  preTsukiDirectSign?: PreTsukiDirectSignIntent
  proofArtifactBaseUrl?: string
  proofCoordinator: ComponentInput
  proverWorker: ComponentInput
  topology: {
    bundleDir: string
    bundleManifest: string
    deploymentRevision: string
    digest: string
    resolvedSidecar: string
    rolloutPlan: string
  }
  tsoValuesFile: string
  withdrawalProcessor: ComponentInput
  worker?: {
    bundleDir?: string
    bundleId?: string
    contractFile: string
    kind: 'compiled-external' | 'compiled-local'
  }
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function stableContractFields(
  contract: ProofDeploymentContract,
): Omit<ProofDeploymentContract, 'generatedAt' | 'generationId'> {
  const stable = {...contract} as Partial<ProofDeploymentContract>
  delete stable.generatedAt
  delete stable.generationId
  return stable as Omit<ProofDeploymentContract, 'generatedAt' | 'generationId'>
}

function deploymentRelativePath(deploymentDir: string, filePath: string): string {
  const root = path.resolve(deploymentDir)
  const resolved = path.resolve(filePath)
  const relative = path.relative(root, resolved)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return relative || '.'
  }

  return resolved
}

function deploymentInputPath(deploymentDir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(deploymentDir, filePath)
}

function binding(
  deploymentDir: string,
  item: {filePath: string; key: string},
): ProofDeploymentFileBinding {
  const filePath = path.resolve(item.filePath)
  if (!fs.existsSync(filePath)) {
    throw new Error(`proof deployment binding file not found: ${filePath}`)
  }

  const sha256 = sha256File(filePath)
  return {
    integrity: {policy: 'required', sha256},
    key: item.key,
    path: deploymentRelativePath(deploymentDir, filePath),
    sha256,
  }
}

function component(
  deploymentDir: string,
  enabled: boolean,
  valuesFile: string,
  setFiles: Array<{filePath: string; key: string}>,
): ProofDeploymentComponent {
  const resolvedValues = path.resolve(valuesFile)
  if (!fs.existsSync(resolvedValues)) {
    throw new Error(`proof deployment values file not found: ${resolvedValues}`)
  }

  return {
    enabled,
    setFiles: enabled ? setFiles.map(item => binding(deploymentDir, item)) : [],
    valuesFile: deploymentRelativePath(deploymentDir, resolvedValues),
    valuesIntegrity: 'required',
    valuesSha256: sha256File(resolvedValues),
  }
}

export function writeProofDeploymentContract(
  input: ProofDeploymentContractInput,
): ProofDeploymentContract {
  const deploymentDir = path.resolve(input.deploymentDir)
  const signerPolicy = input.mode === 'disabled'
    ? {policyMode: 'dev_permissive' as const, proofArtifactFetchMode: 'disabled' as const}
    : input.mode === 'mock'
      ? {policyMode: 'staging_scaffold' as const, proofArtifactFetchMode: 'http' as const}
      : {policyMode: 'production_enforce' as const, proofArtifactFetchMode: 'http' as const}
  const worker = input.mode === 'disabled'
    ? {enabled: false, kind: 'none' as const}
    : input.worker
      ? {
          ...(input.worker.bundleDir
            ? {bundleDir: deploymentRelativePath(deploymentDir, input.worker.bundleDir)}
            : {}),
          ...(input.worker.bundleId ? {bundleId: input.worker.bundleId} : {}),
          contractFile: deploymentRelativePath(deploymentDir, input.worker.contractFile),
          contractSha256: sha256File(
            deploymentInputPath(deploymentDir, input.worker.contractFile),
          ),
          enabled: true,
          kind: input.worker.kind,
        }
      : (() => {
          throw new Error(`${input.mode} topology is missing its compiled Worker contract`)
        })()
  const stable = {
    components: {
      ethDaSubmitter: component(
        deploymentDir,
        true,
        input.ethDaSubmitter.valuesFile,
        [],
      ),
      proofCoordinator: component(
        deploymentDir,
        input.proofCoordinator.enabled,
        input.proofCoordinator.valuesFile,
        input.proofCoordinator.setFiles,
      ),
      proverWorker: component(
        deploymentDir,
        input.proverWorker.enabled,
        input.proverWorker.valuesFile,
        input.proverWorker.setFiles,
      ),
      tsoService: component(deploymentDir, true, input.tsoValuesFile, []),
      withdrawalProcessor: component(
        deploymentDir,
        true,
        input.withdrawalProcessor.valuesFile,
        input.withdrawalProcessor.setFiles,
      ),
    },
    generator: {command: 'scrollsdk setup prep-charts' as const, version: 1 as const},
    intentSource: {
      kind: input.intentSource.kind,
      path: deploymentRelativePath(deploymentDir, input.intentSource.path),
      sha256: input.intentSource.sha256,
    },
    mode: input.mode,
    ...(input.preTsukiDirectSign ? {preTsukiDirectSign: input.preTsukiDirectSign} : {}),
    ...(input.proofArtifactBaseUrl ? {proofArtifactBaseUrl: input.proofArtifactBaseUrl} : {}),
    schemaVersion: 5 as const,
    signerPolicy,
    topology: {
      bundleDir: deploymentRelativePath(deploymentDir, input.topology.bundleDir),
      bundleManifest: deploymentRelativePath(deploymentDir, input.topology.bundleManifest),
      bundleManifestSha256: sha256File(
        deploymentInputPath(deploymentDir, input.topology.bundleManifest),
      ),
      deploymentRevision: input.topology.deploymentRevision,
      digest: input.topology.digest,
      resolvedSidecar: deploymentRelativePath(deploymentDir, input.topology.resolvedSidecar),
      resolvedSidecarSha256: sha256File(
        deploymentInputPath(deploymentDir, input.topology.resolvedSidecar),
      ),
      rolloutPlan: deploymentRelativePath(deploymentDir, input.topology.rolloutPlan),
      rolloutPlanSha256: sha256File(
        deploymentInputPath(deploymentDir, input.topology.rolloutPlan),
      ),
    },
    worker,
  }
  const generationId = sha256Json(stable)
  const contractPath = path.resolve(
    deploymentDir,
    input.contractPath || DEFAULT_PROOF_DEPLOYMENT_CONTRACT,
  )
  let generatedAt = new Date().toISOString()
  if (fs.existsSync(contractPath)) {
    try {
      const previous = JSON.parse(fs.readFileSync(contractPath, 'utf8')) as ProofDeploymentContract
      if (
        previous.schemaVersion === 5
        && previous.generationId === generationId
        && sha256Json(stableContractFields(previous)) === generationId
      ) {
        generatedAt = previous.generatedAt
      }
    } catch {
      // Replace invalid generated output atomically.
    }
  }

  const contract: ProofDeploymentContract = {...stable, generatedAt, generationId}
  fs.mkdirSync(path.dirname(contractPath), {recursive: true})
  const temporary = `${contractPath}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(contract, null, 2)}\n`, {mode: 0o644})
  fs.renameSync(temporary, contractPath)
  return contract
}

export function readProofDeploymentContract(
  deploymentDir = '.',
  contractPath = DEFAULT_PROOF_DEPLOYMENT_CONTRACT,
): {contract: ProofDeploymentContract; contractPath: string} {
  const resolved = path.resolve(deploymentDir, contractPath)
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `proof deployment contract not found: ${resolved}; run scrollsdk setup prep-charts first`,
    )
  }

  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as {schemaVersion?: unknown}
  if (parsed.schemaVersion !== 5) {
    throw new Error(
      `${resolved}: only proof deployment contract schemaVersion 5 is supported; `
      + 'rerun scrollsdk setup prep-charts',
    )
  }

  return {contract: parsed as ProofDeploymentContract, contractPath: resolved}
}

export function resolveContractFile(deploymentDir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(deploymentDir, filePath)
}

function parseWithdrawalPreTsukiDirectSignPin(
  root: string,
  contract: ProofDeploymentContract,
  problems: string[],
): number | undefined {
  const item = contract.components.withdrawalProcessor.setFiles.find(
    candidate => candidate.key === 'configMaps.config.data.WithdrawalProcessor\\.toml',
  )
  if (!item) {
    if (contract.preTsukiDirectSign) {
      problems.push('withdrawalProcessor: recovery validation requires WithdrawalProcessor.toml')
    }

    return undefined
  }

  const filePath = resolveContractFile(root, item.path)
  if (!fs.existsSync(filePath)) return undefined
  try {
    const parsed = toml.parse(fs.readFileSync(filePath, 'utf8')) as {
      proof_system?: {pre_tsuki_direct_sign?: {max_end_batch_height?: unknown}}
    }
    const value = parsed.proof_system?.pre_tsuki_direct_sign?.max_end_batch_height
    if (value === undefined) return undefined
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 4_294_967_295) {
      problems.push('withdrawalProcessor: recovery max_end_batch_height must be in 1..=4294967295')
      return undefined
    }

    return value as number
  } catch (error) {
    problems.push(
      `withdrawalProcessor: failed to parse recovery projection: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}

function parseTsoPreTsukiDirectSignPin(
  root: string,
  contract: ProofDeploymentContract,
  problems: string[],
): number | undefined {
  const filePath = resolveContractFile(root, contract.components.tsoService.valuesFile)
  if (!fs.existsSync(filePath)) return undefined
  try {
    const parsed = yaml.load(fs.readFileSync(filePath, 'utf8')) as {
      env?: Array<{name?: unknown; value?: unknown}>
    } | undefined
    if (!Array.isArray(parsed?.env)) {
      problems.push('tsoService: env must be an array for recovery validation')
      return undefined
    }

    const matches = parsed.env.filter(item => item?.name === PRE_TSUKI_DIRECT_SIGN_TSO_ENV)
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

    const number = Number(value)
    if (!Number.isSafeInteger(number) || number < 1 || number > 4_294_967_295) {
      problems.push(`tsoService: ${PRE_TSUKI_DIRECT_SIGN_TSO_ENV} must be in 1..=4294967295`)
      return undefined
    }

    return number
  } catch (error) {
    problems.push(
      `tsoService: failed to parse recovery projection: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}

function validatePreTsukiDirectSignProjection(
  root: string,
  contract: ProofDeploymentContract,
  problems: string[],
): void {
  const expected = contract.preTsukiDirectSign?.maxEndBatchHeight
  if (contract.preTsukiDirectSign && contract.mode !== 'disabled') {
    problems.push('preTsukiDirectSign requires disabled mode')
  }

  const withdrawalPin = parseWithdrawalPreTsukiDirectSignPin(root, contract, problems)
  const tsoPin = parseTsoPreTsukiDirectSignPin(root, contract, problems)
  if (withdrawalPin !== expected) {
    problems.push(
      `withdrawalProcessor: recovery pin ${String(withdrawalPin)} does not match contract ${String(expected)}`,
    )
  }

  if (tsoPin !== expected) {
    problems.push(`tsoService: recovery pin ${String(tsoPin)} does not match contract ${String(expected)}`)
  }
}

function validateComponent(
  root: string,
  name: string,
  item: ProofDeploymentComponent,
  problems: string[],
): void {
  if (!item.valuesFile || !item.valuesSha256 || item.valuesIntegrity !== 'required') {
    problems.push(`${name}: required values integrity metadata missing`)
    return
  }

  const valuesPath = resolveContractFile(root, item.valuesFile)
  if (!fs.existsSync(valuesPath)) problems.push(`${name}: values file missing: ${item.valuesFile}`)
  else if (sha256File(valuesPath) !== item.valuesSha256) {
    problems.push(`${name}: values checksum mismatch: ${item.valuesFile}`)
  }

  for (const setFile of item.setFiles) {
    const filePath = resolveContractFile(root, setFile.path)
    if (!fs.existsSync(filePath)) problems.push(`${name}: set-file missing: ${setFile.path}`)
    else if (
      setFile.integrity?.policy !== 'required'
      || sha256File(filePath) !== setFile.integrity.sha256
      || setFile.sha256 !== setFile.integrity.sha256
    ) {
      problems.push(`${name}: proof-critical set-file checksum mismatch: ${setFile.path}`)
    }
  }
}

export function validateProofDeploymentContract(
  deploymentDir = '.',
  contractPath = DEFAULT_PROOF_DEPLOYMENT_CONTRACT,
): ProofDeploymentContract {
  const root = path.resolve(deploymentDir)
  const {contract, contractPath: resolvedContract} = readProofDeploymentContract(root, contractPath)
  const problems: string[] = []
  if (!['disabled', 'mock', 'production'].includes(contract.mode)) {
    problems.push(`unsupported mode: ${String(contract.mode)}`)
  }

  if (sha256Json(stableContractFields(contract)) !== contract.generationId) {
    problems.push('generation ID does not match the deployment contract contents')
  }

  if (
    !['deployment-spec', 'doge-config'].includes(contract.intentSource?.kind)
    || !contract.intentSource.path
    || !/^[\da-f]{64}$/.test(contract.intentSource.sha256)
  ) {
    problems.push('proof intent source metadata is missing or invalid')
  }

  for (const [name, componentValue] of Object.entries(contract.components)) {
    validateComponent(root, name, componentValue, problems)
  }

  if (!contract.components.ethDaSubmitter.enabled) problems.push('eth-da-submitter must remain enabled')
  if (!contract.components.tsoService.enabled) problems.push('tso-service must remain enabled')
  if (!contract.components.withdrawalProcessor.enabled) {
    problems.push('withdrawal-processor must remain enabled')
  }

  validatePreTsukiDirectSignProjection(root, contract, problems)

  if (contract.mode === 'disabled') {
    if (contract.components.proofCoordinator.enabled) {
      problems.push('disabled mode must not enable proof-coordinator')
    }

    if (contract.components.proverWorker.enabled) {
      problems.push('disabled mode must not enable local prover-worker')
    }

    if (contract.worker.enabled || contract.worker.kind !== 'none') {
      problems.push('disabled mode must not enable a prover worker')
    }

    if (
      contract.signerPolicy.policyMode !== 'dev_permissive'
      || contract.signerPolicy.proofArtifactFetchMode !== 'disabled'
    ) {
      problems.push('disabled mode requires the direct-sign signer policy posture')
    }
  } else {
    if (!contract.components.proofCoordinator.enabled) {
      problems.push(`${contract.mode} mode must enable proof-coordinator`)
    }

    if (!contract.proofArtifactBaseUrl) {
      problems.push(`${contract.mode} mode requires a proof artifact base URL`)
    }

    if (!contract.worker.enabled || contract.worker.kind === 'none') {
      problems.push(`${contract.mode} mode requires a compiled Worker contract`)
    }
  }

  if (contract.mode === 'mock' && (
    contract.signerPolicy.policyMode !== 'staging_scaffold'
    || contract.signerPolicy.proofArtifactFetchMode !== 'http'
  )) {
    problems.push('mock mode requires the staging signer policy posture')
  }

  if (contract.mode === 'production' && (
    contract.signerPolicy.policyMode !== 'production_enforce'
    || contract.signerPolicy.proofArtifactFetchMode !== 'http'
  )) {
    problems.push('production mode requires the production signer policy posture')
  }

  if (contract.worker.kind !== 'none') {
    if (!contract.worker.contractFile || !contract.worker.contractSha256) {
      problems.push('compiled Worker contract file is missing')
    } else {
      const workerFile = resolveContractFile(root, contract.worker.contractFile)
      if (!fs.existsSync(workerFile)) {
        problems.push(`compiled Worker contract file is missing: ${contract.worker.contractFile}`)
      } else if (sha256File(workerFile) !== contract.worker.contractSha256) {
        problems.push(`compiled Worker contract SHA-256 mismatch: ${contract.worker.contractFile}`)
      }
    }

    if (contract.worker.kind === 'compiled-local' && !contract.components.proverWorker.enabled) {
      problems.push('compiled-local Worker requires an enabled proverWorker component')
    }

    if (contract.worker.kind === 'compiled-external') {
      if (contract.components.proverWorker.enabled) {
        problems.push('compiled-external Worker must keep local proverWorker disabled')
      }

      if (!contract.worker.bundleDir || !contract.worker.bundleId) {
        problems.push('compiled-external Worker requires a manifest-bearing launch bundle')
      }
    }
  }

  for (const [label, file, expectedSha256] of [
    ['bundle manifest', contract.topology.bundleManifest, contract.topology.bundleManifestSha256],
    ['resolved sidecar', contract.topology.resolvedSidecar, contract.topology.resolvedSidecarSha256],
    ['rollout plan', contract.topology.rolloutPlan, contract.topology.rolloutPlanSha256],
  ]) {
    const resolved = resolveContractFile(root, file)
    if (!fs.existsSync(resolved)) problems.push(`proof topology ${label} is missing: ${file}`)
    else if (!expectedSha256 || sha256File(resolved) !== expectedSha256) {
      problems.push(`proof topology ${label} SHA-256 mismatch: ${file}`)
    }
  }

  if (!fs.existsSync(resolveContractFile(root, contract.topology.bundleDir))) {
    problems.push(`proof topology bundle is missing: ${contract.topology.bundleDir}`)
  }

  for (const [label, digest] of [
    ['digest', contract.topology.digest],
    ['deployment revision', contract.topology.deploymentRevision],
  ]) {
    if (!/^[\da-f]{64}$/.test(digest)) {
      problems.push(`proof topology ${label} must be a lowercase SHA-256 digest`)
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `${resolvedContract}: stale or invalid proof deployment contract:\n- ${problems.join('\n- ')}`,
    )
  }

  return contract
}
