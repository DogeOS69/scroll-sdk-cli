import bitcore from 'bitcore-lib-doge'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {resolveBridgeGenesisImage} from '../commands/setup/bridge-init.js'
import {DeploymentSpecFieldError} from './deployment-spec-fields.js'
import {loadDeploymentSpec, resolveDeploymentSpecEnvRefs, validateDeploymentSpec} from './deployment-spec-generator.js'
import {usesDstackPostgres} from './dstack-database.js'
import {AwaitingInput, digest, loadPreparationEnv, localPath, privateWrite, writeJson} from './preparation-io.js'
import {resolvePreparationProofRelease} from './preparation-release.js'
import {planSpecBootstrap, resolveSdkRevision} from './spec-bootstrap.js'
import {resolveCubesignerIdentity} from './spec-cubesigner.js'
import {resolveSpecProofStorage} from './spec-proof-storage.js'

export interface PreparationStep {effect: 'chain' | 'cloud' | 'local' | 'read'; id: string; retry: 'reconcile' | 'safe'; title: string}
export interface PreparationPlan {deploymentName: string; envFile?: string; id: string; schema: 'scrollsdk/preparation/v1'; sdkDirectory: string; specHash: string; steps: PreparationStep[]}
export interface PreparationState {
  currentStep?: string
  files: Record<string, string>
  planId: string
  status: 'failed' | 'pending' | 'prepared' | 'recovery-required' | 'running' | 'waiting'
  steps: Record<string, 'completed' | 'failed' | 'recovery-required' | 'running'>
  waiting?: AwaitingInput['details']
}
export const WORKFLOW_DIR = '.scrollsdk'
export function preparationSteps(spec: DeploymentSpec): PreparationStep[] {
  const p = spec.preparation!
  const steps: PreparationStep[] = []
  const add = (id: string, title: string, effect: PreparationStep['effect'] = 'local', retry: PreparationStep['retry'] = 'safe') => steps.push({effect, id, retry, title})
  add('bootstrap', 'Generate configuration from pinned SDK templates')
  add('identities', 'Prepare declared service identities and deployment account', JSON.stringify(spec.identities).includes('aws_kms') ? 'cloud' : 'local')
  if (p.archive) add('archive', 'Reconcile declared DA archive resources and writer access', 'cloud')
  if (p.proofAws) add('proof-aws', p.proofAws.action === 'reuse' ? 'Discover existing proof artifact store and workload access' : 'Provision proof artifact store and workload access', p.proofAws.action === 'reuse' ? 'read' : 'cloud')
  if (spec.dstackController && spec.dstackController.enabled !== false) {
    add('dstack', 'Prepare dstack controller credentials and config')
    if (p.dstack?.initializeDatabase) add('dstack-db', 'Initialize dstack in the existing PostgreSQL server', 'cloud')
  }

  if (p.databases?.includes('blockscout')) add('blockscout-db', 'Initialize Blockscout in the existing PostgreSQL server', 'cloud')
  add('descriptors', 'Import partner public descriptors')
  add('genesis', 'Generate native L2 genesis and contract artifacts')
  add('bridge-prepare', 'Compute protocol seed from genesis')
  if (p.bridge.mode === 'production') {
    add('ethereum-anchor', 'Validate and bind the selected Ethereum DA anchor', 'read')
    add('production-wallets', 'Wait for and verify sequencer and fee-wallet funding', 'read')
    add('bridge-info', 'Derive the namespace and final Bridge address')
    add('production-funding', 'Wait for and verify marked Bridge funding', 'read')
  } else {
    add('helper-funding', 'Wait for and verify test-helper funding', 'read')
    add('helper-setup', 'Broadcast test-helper setup transaction', 'chain', 'reconcile')
    add('bridge-info', 'Derive namespace and final Bridge address')
    add('helper-fund', 'Broadcast test-helper Bridge/deposit-seed transactions', 'chain', 'reconcile')
  }

  add('protocol-context', 'Generate canonical protocol context')
  add('external-inputs', 'Import declared external runtime and policy inputs')
  if (p.proofRelease) {
    add('proof-release-bake', 'Bake real proof identities for this protocol context')
    add('proof-materializer-export', 'Export materializers from the release coordinator image')
    add('proof-worker-check', 'Check the release CUDA Worker against the baked identities')
  }

  add('proof-materials', 'Prepare or consume proof materials for the selected mode')
  add('charts', 'Compile topology and reconcile service configuration')
  if (p.proofPublication) {
    add('proof-publish', 'Publish and verify the approved real-proof program bundle', 'cloud')
    add('charts-published', 'Bind publication receipt into service configuration')
  }

  add('secrets', 'Generate private runtime Secrets')
  add('signer-policy', 'Export partner signer policy bundle')
  if (spec.proofTopology?.enforcement === 'enforce') {
    add('signer-receipts', 'Wait for and validate partner policy receipts')
    add('charts-validated', 'Regenerate configuration with validated partner evidence')
  }

  add('proof-check', 'Validate proof configuration and required evidence')
  if (p.secretUpload) add('secret-upload', 'Upload declared runtime Secrets', 'cloud')
  return steps
}

export function validatePreparation(spec: DeploymentSpec): void {
  const p = spec.preparation
  if (!p) throw new Error('preparation is required for setup plan; plain generate-from-spec remains available')
  if (!['helper', 'production'].includes(p.bridge?.mode)) throw new Error('preparation.bridge.mode must explicitly select production or helper')
  if (!p.bridge.image?.includes('@sha256:')) throw new Error('preparation.bridge.image must select an immutable bridge-genesis-tools digest')
  resolveBridgeGenesisImage(p.bridge.image)
  if (!Number.isSafeInteger(spec.bridge.confirmationsRequired) || spec.bridge.confirmationsRequired < 1) throw new Error('Preparation requires at least one funding confirmation')
  if (!Array.isArray(p.attestationDescriptors) || p.attestationDescriptors.length === 0) throw new Error('preparation.attestationDescriptors must name the partner descriptor files (they may arrive later)')
  for (const file of p.attestationDescriptors) if (typeof file !== 'string' || !file.trim()) throw new Error('Descriptor paths must be non-empty')
  if (!['existing', 'mock', 'real'].includes(p.proofMaterials?.mode)) throw new Error('preparation.proofMaterials.mode is required')
  if (p.proofMaterials.mode === 'mock' && !p.proofMaterials.mockWorkerImage) throw new Error('Mock material preparation requires mockWorkerImage')
  if (p.proofRelease && (p.proofMaterials.mode !== 'real' || spec.proofTopology?.generation !== 'real')) throw new Error('proofRelease requires real proof material preparation and real topology generation')
  if (p.proofRelease && [p.proofMaterials.preparationReceipt, p.proofMaterials.productionWorkerReceipt, p.proofMaterials.chunkMaterializer, p.proofMaterials.batchMaterializer].some(Boolean)) throw new Error('proofRelease derives material inputs; do not also supply preparation/Worker receipts or materializer paths')
  if (p.proofMaterials.mode === 'real' && !p.proofRelease && (!p.proofMaterials.preparationReceipt || !p.proofMaterials.chunkMaterializer || !p.proofMaterials.batchMaterializer)) throw new Error('Real material preparation requires a preparation receipt and both materializers')
  if (p.proofMaterials.mode !== 'existing' && p.proofMaterials.mode !== spec.proofTopology?.generation) throw new Error('Material preparation must match proofTopology.generation')
  if (p.proofPublication && !(p.proofPublication.release ?? p.proofRelease?.manifest)) throw new Error('Publication requires a proof release manifest')
  if (p.proofPublication && Boolean(p.proofPublication.release) !== Boolean(p.proofPublication.releaseSha256)) throw new Error('Publication release and releaseSha256 must be supplied together')
  if (p.proofPublication && (!/^[\da-f]{64}$/.test(p.proofPublication.releaseSha256 ?? p.proofRelease?.sha256 ?? '') || spec.proofTopology?.generation !== 'real')) throw new Error('Publication requires a pinned release manifest and real generation')
  if (p.archive && !['configure', 'create'].includes(p.archive.action)) throw new Error('Archive action must be configure or create')
  if (p.proofAws && !['create', 'reuse'].includes(p.proofAws.action)) throw new Error('proofAws.action must select create or reuse')
  if (p.proofAws?.action === 'reuse' && p.proofAws.publicReadMode === 'direct-s3') throw new Error('Reuse proof resources with existing-public-s3 or existing-gateway; direct-s3 manages bucket policy')
  if (p.proofAws?.action === 'create' && (p.proofAws.coordinatorRoleName || p.proofAws.withdrawalRoleName)) throw new Error('Existing role names require proofAws.action: reuse')
  if (p.proofAws && !['direct-s3', 'existing-gateway', 'existing-public-s3'].includes(p.proofAws.publicReadMode)) throw new Error('Invalid proof public-read mode')
  if (p.secretUpload?.provider === 'aws' && !p.secretUpload.awsRegion && !spec.infrastructure.aws?.region) throw new Error('AWS Secret upload requires an explicit region in secretUpload or infrastructure.aws')
  if (p.secretUpload && spec.dstackController?.enabled !== false && spec.dstackController && !p.secretUpload.kubeContext) throw new Error('Dstack Secret upload requires an explicit Kubernetes context')
  if (p.proofAws?.publicReadMode === 'existing-gateway' && !p.proofAws.publicEndpointUrl) throw new Error('Existing proof gateway requires publicEndpointUrl')
  if ((p.proofMaterials.mode !== 'existing' || p.proofMaterials.receipt) && resolveSpecProofStorage(spec).proofTopology?.active?.artifactStore.kind !== 's3_compatible') throw new Error('Topology derived from a material receipt requires the declared S3 proof artifact store')
  if (p.secretUpload && !['aws', 'vault'].includes(p.secretUpload.provider)) throw new Error('Secret upload provider must be aws or vault')
  if (spec.dstackController && spec.dstackController.enabled !== false && !p.dstack) throw new Error('Enabled dstack requires preparation.dstack with explicit import or external credentials mode')
  if (p.dstack && !['external', 'import'].includes(p.dstack.mode)) throw new Error('Dstack preparation mode must be import or external')
  if (p.dstack?.mode === 'import' && (!p.dstack.providers?.length || p.dstack.providers.includes('vastai') && !p.dstack.vastaiApiKeyFile && !p.dstack.vastaiApiKeyEnv || p.dstack.providers.includes('gcp') && !p.dstack.gcpServiceAccountFile)) throw new Error('Dstack import requires providers and their credential file or environment references')
  if (p.dstack?.vastaiApiKeyEnv && !/^[A-Z_a-z]\w*$/.test(p.dstack.vastaiApiKeyEnv)) throw new Error('Dstack vastaiApiKeyEnv must name an environment variable')
  if (p.dstack?.vastaiApiKeyEnv && p.dstack.vastaiApiKeyFile) throw new Error('Choose vastaiApiKeyEnv or vastaiApiKeyFile, not both')
  if (p.dstack?.databaseUrlEnv && !/^[A-Z_a-z]\w*$/.test(p.dstack.databaseUrlEnv)) throw new Error('Dstack databaseUrlEnv must name an environment variable')
  if (p.dstack?.databaseUrlEnv && p.dstack.initializeDatabase) throw new Error('Choose existing dstack databaseUrlEnv or initializeDatabase')
  if (usesDstackPostgres(spec.dstackController) && !p.dstack?.initializeDatabase && !p.dstack?.databaseUrlEnv) throw new Error('PostgreSQL dstack requires initializeDatabase or databaseUrlEnv')
  if (p.dstack?.initializeDatabase !== undefined && typeof p.dstack.initializeDatabase !== 'boolean') throw new Error('initializeDatabase must be boolean')
  if (p.dstack && (!spec.dstackController || spec.dstackController.enabled === false)) throw new Error('Dstack preparation requires an enabled dstackController')
  if (p.dstack?.providers?.some(provider => !['gcp', 'vastai'].includes(provider))) throw new Error('Unsupported dstack credential provider')
  if (p.proofAws && (!spec.infrastructure.aws?.eksClusterName || !spec.infrastructure.aws.region)) throw new Error('Proof AWS provisioning requires an existing EKS cluster and region')
  if (p.bridge.mode === 'helper' && !spec.bridge.seedString?.trim()) throw new Error('Test-helper preparation requires bridge.seedString')
  if (p.bridge.mode === 'helper' && (spec.dogecoin.network === 'mainnet' || spec.metadata.environment === 'mainnet')) throw new Error('The deterministic helper is test-only; choose production Bridge preparation')
  if (p.bridge.mode === 'production') {
    const publicKey = (value: unknown) => {
      try {if (typeof value !== 'string' || !/^(02|03)[\da-f]{64}$/i.test(value)) throw new Error('Invalid key'); return bitcore.PublicKey.fromString(value)} catch {throw new Error('Production Bridge requires valid compressed public keys')}
    }

    const policy = p.bridge.production
    if (!policy) throw new Error('preparation.bridge.production must declare independently managed Dogecoin wallets and recovery keys')
    const anchor = policy.ethereumAnchor
    if (anchor?.blockTag !== undefined) {
      if (anchor.blockTag !== 'finalized' || anchor.blockNumber !== undefined || anchor.transactionIndex !== undefined) throw new Error('Use ethereumAnchor.blockTag: finalized alone, or explicit blockNumber and transactionIndex')
    } else if (!anchor || [anchor.blockNumber, anchor.transactionIndex].some(value => !Number.isSafeInteger(value) || value! < 0)) {
      throw new Error('Production Bridge requires ethereumAnchor.blockTag: finalized or explicit blockNumber and transactionIndex')
    }

    for (const value of [policy.sequencerPublicKey, policy.feeWalletPublicKey, spec.bridge.teePubkey]) publicKey(value)
    if (policy.sequencerPublicKey.toLowerCase() === policy.feeWalletPublicKey.toLowerCase()) throw new Error('Production sequencer and fee wallet must have different keys')
    for (const name of [policy.sequencerKeyEnv, policy.feeWalletKeyEnv]) if (!/^[A-Z_a-z]\w*$/.test(name)) throw new Error('Production wallet key references must name environment variables')
    if (!Array.isArray(policy.recoveryPublicKeys) || new Set(policy.recoveryPublicKeys.map(key => key.toLowerCase())).size !== policy.recoveryPublicKeys.length || policy.recoveryPublicKeys.length < spec.bridge.thresholds.recovery || spec.bridge.thresholds.recovery < 1) throw new Error('Recovery keys must be unique and satisfy the threshold')
    policy.recoveryPublicKeys.forEach(value => publicKey(value))
    if (!Number.isSafeInteger(spec.bridge.timelock) || spec.bridge.timelock <= 100 || spec.bridge.timelock >= 500_000_000) throw new Error('Production Bridge needs an explicit recovery timelock block height')
  }

  for (const item of p.inputs ?? []) {
    if (p.proofAws && item.destination === '.data/proof-aws.json') throw new Error('proofAws generates its own receipt; remove proof-aws.json from external inputs')
    if (!item.source || !/^(\.data|secrets)\//.test(item.destination) || /(?:^|\/)(?:doge-config\.toml|setup_defaults\.toml|protocol_seed\.toml|protocol_context\.json|GenerateBridgeInfo\.toml|bridge\.json|production-.*\.json|output-.*|genesis\.json)$/.test(item.destination)) throw new Error('External inputs may not overwrite managed Bridge or deployment state')
    localPath('/deployment', item.destination)
  }

  localPath('/deployment', p.bridge.fundingFile ?? '.scrollsdk/inputs/bridge-funding.json')
  if (p.bridge.fundingFile && !p.bridge.fundingFile.startsWith('.scrollsdk/inputs/')) throw new Error('Funding input must live under .scrollsdk/inputs/')
}

function fingerprint(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const visit = (relative: string): void => {
    const file = localPath(root, relative)
    if (!fs.existsSync(file) || relative === '.data/contracts-build') return
    const stat = fs.lstatSync(file)
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(`${relative}/${name}`)
    else if (stat.isFile()) files[relative] = digest(fs.readFileSync(file))
    else throw new Error(`Unsupported managed artifact: ${relative}`)
  }

  for (const name of ['config.toml', 'config-contracts.toml', 'Makefile', '.data', 'values', 'secrets', 'withdrawal-processor', 'proof-coordinator', 'eth-da-submitter', 'signer-policy-bundle']) visit(name)
  return files
}

export async function createPreparationPlan(options: {envFile?: string; output: string; sdkDirectory: string; spec: string}): Promise<PreparationPlan> {
  const envFile = options.envFile ? path.resolve(options.envFile) : undefined
  loadPreparationEnv(envFile)
  let spec: DeploymentSpec
  try {spec = resolveDeploymentSpecEnvRefs(loadDeploymentSpec(path.resolve(options.spec)))} catch (error) {
    if (error instanceof DeploymentSpecFieldError) throw error
    throw new Error('Cannot load DeploymentSpec; check field names, YAML syntax and environment references (values omitted)')
  }

  spec.templates = {sdkRevision: resolveSdkRevision(options.sdkDirectory, spec.templates?.sdkRevision)}
  spec = resolveCubesignerIdentity(spec)
  spec = await resolvePreparationProofRelease(spec, options.output)
  const validation = validateDeploymentSpec(spec)
  if (!validation.valid) throw new Error(`Invalid spec fields: ${validation.errors.map(e => `${e.path} (${e.code})`).join(', ')}`)
  validatePreparation(spec)
  planSpecBootstrap(spec, options.sdkDirectory)
  const root = path.resolve(options.output)
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('Deployment root cannot be a symlink')
  const specText = JSON.stringify(spec, null, 2) + '\n'
  const body = {...(envFile ? {envFile} : {}), deploymentName: spec.metadata.name, schema: 'scrollsdk/preparation/v1' as const, sdkDirectory: fs.realpathSync(options.sdkDirectory), specHash: digest(specText), steps: preparationSteps(spec)}
  const plan = {...body, id: digest(JSON.stringify(body))}
  const directory = path.join(root, WORKFLOW_DIR)
  if (fs.existsSync(path.join(directory, 'state.json'))) {
    const current = JSON.parse(fs.readFileSync(path.join(directory, 'plan.json'), 'utf8')) as PreparationPlan
    if (current.id === plan.id) return current
    throw new Error('An existing preparation plan is immutable; supply external inputs and rerun apply, or choose a new deployment directory for a different spec')
  }

  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) throw new Error('setup plan requires an empty output directory')
  fs.mkdirSync(root, {mode: 0o700, recursive: true})
  fs.chmodSync(root, 0o700)
  privateWrite(path.join(root, '.gitignore'), '/.scrollsdk/\n/.data/\n/secrets/\n/config.toml\n/config-contracts.toml\n/values/\n/signer-policy-bundle/\n/withdrawal-processor/\n/proof-coordinator/\n/eth-da-submitter/\n')
  privateWrite(path.join(root, '.scrollsdkignore'), '.scrollsdk/\n.data/contracts-build/\n')
  privateWrite(path.join(directory, 'intent.json'), specText)
  writeJson(path.join(directory, 'plan.json'), plan)
  writeJson(path.join(directory, 'state.json'), {files: {}, planId: plan.id, status: 'pending', steps: {}} satisfies PreparationState)
  return plan
}

export interface PreparationRunner {run(step: PreparationStep, spec: DeploymentSpec, root: string, plan: PreparationPlan): Promise<void>}
export async function applyPreparation(rootInput: string, runner: PreparationRunner, progress: (step: PreparationStep) => void = () => {}): Promise<PreparationState> {
  const root = fs.realpathSync(rootInput)
  const directory = localPath(root, WORKFLOW_DIR)
  const plan = JSON.parse(fs.readFileSync(localPath(root, `${WORKFLOW_DIR}/plan.json`), 'utf8')) as PreparationPlan
  const text = fs.readFileSync(localPath(root, `${WORKFLOW_DIR}/intent.json`), 'utf8')
  const {id, ...body} = plan
  if (plan.schema !== 'scrollsdk/preparation/v1' || digest(JSON.stringify(body)) !== id || digest(text) !== plan.specHash) throw new Error('Preparation plan or frozen intent changed')
  loadPreparationEnv(plan.envFile)
  const spec = JSON.parse(text) as DeploymentSpec
  validatePreparation(spec)
  if (JSON.stringify(preparationSteps(spec)) !== JSON.stringify(plan.steps)) throw new Error('CLI workflow changed; this plan requires its original CLI version')
  const statePath = localPath(root, `${WORKFLOW_DIR}/state.json`)
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as PreparationState
  if (state.planId !== id) throw new Error('Workflow state does not match plan')
  const lock = path.join(directory, 'apply.lock')
  // Never steal an ambiguous lock. An interrupted process leaves an explicit recovery record.
  let fd: number
  try {fd = fs.openSync(lock, 'wx', 0o600)} catch {throw new Error('Another apply owns .scrollsdk/apply.lock; if interrupted, verify its recorded host/PID is no longer running before removing that lock')}
  fs.writeFileSync(fd, JSON.stringify({host: os.hostname(), pid: process.pid})); fs.closeSync(fd)
  try {
    for (const [file, hash] of Object.entries(state.files)) if (!fs.existsSync(localPath(root, file)) || digest(fs.readFileSync(localPath(root, file))) !== hash) throw new Error(`Prepared artifact changed outside the workflow: ${file}`)
    for (const step of plan.steps) {
      if (state.steps[step.id] === 'completed') continue
      if (state.steps[step.id] === 'recovery-required' || state.steps[step.id] === 'running' && step.retry === 'reconcile') {
        state.status = 'recovery-required'; state.currentStep = step.id
        state.waiting = {message: 'A transaction may already have been broadcast. Reconcile on-chain results and partial artifacts; this workflow will not replay this step automatically'}
        writeJson(statePath, state); return state
      }

      progress(step)
      state.status = 'running'; state.currentStep = step.id; delete state.waiting
      state.steps[step.id] = 'running'; writeJson(statePath, state)
      try {
        await runner.run(step, spec, root, plan)
        state.steps[step.id] = 'completed'
      } catch (error) {
        state.status = error instanceof AwaitingInput ? 'waiting' : step.retry === 'reconcile' ? 'recovery-required' : 'failed'
        state.steps[step.id] = state.status === 'recovery-required' ? 'recovery-required' : 'failed'
        if (!(error instanceof AwaitingInput)) {
          const log = localPath(root, `${WORKFLOW_DIR}/logs/${step.id}.log`)
          fs.mkdirSync(path.dirname(log), {mode: 0o700, recursive: true})
          fs.appendFileSync(log, `${error instanceof Error ? error.stack : 'Step failed'}\n`, {mode: 0o600})
        }

        state.waiting = error instanceof AwaitingInput ? error.details : {message: `Step ${step.id} failed; details are in the private step log. No later steps ran`}
        state.files = fingerprint(root); writeJson(statePath, state)
        return state
      }

      state.files = fingerprint(root); writeJson(statePath, state)
    }

    state.status = 'prepared'; delete state.currentStep; delete state.waiting
    writeJson(statePath, state)
    return state
  } finally {fs.unlinkSync(lock)}
}
