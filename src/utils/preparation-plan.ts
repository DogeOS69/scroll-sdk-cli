import bitcore from 'bitcore-lib-doge'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {resolveBridgeGenesisImage} from '../commands/setup/bridge-init.js'
import {resolveCapacityManager} from './capacity-manager.js'
import {DeploymentSpecFieldError} from './deployment-spec-fields.js'
import {loadDeploymentSpec, resolveDeploymentSpecEnvRefs, validateDeploymentSpec} from './deployment-spec-generator.js'
import {validateDstackAwsBackend} from './dstack-credentials.js'
import {usesDstackPostgres} from './dstack-database.js'
import {validateExistingAlb, validateExistingAlbSdk} from './existing-alb.js'
import {validateExistingNlbSdk} from './existing-nlb.js'
import {validateExternalAwsRoles} from './external-aws-roles.js'
import {feeVaultRecipientHash} from './fee-vault-recipient.js'
import {usesWorkloadRoles} from './preparation-aws-roles.js'
import {needsPreparationPolicy} from './preparation-cubesigner-policy.js'
import {dstackAwsIntent} from './preparation-dstack-aws.js'
import {usesManagedHelper} from './preparation-helper-identity.js'
import {AwaitingInput, digest, loadPreparationEnv, localPath, privateWrite, writeJson} from './preparation-io.js'
import {resolvePreparationProofRelease} from './preparation-release.js'
import {PREPARATION_STAGES, type PreparationStage, prerequisiteStages, stageCommand, stagedPreparationSteps} from './preparation-stages.js'
import {resolveSpecAttestationSigners} from './spec-attestation-signers.js'
import {planSpecBootstrap, resolveSdkRevision} from './spec-bootstrap.js'
import {resolveCubesignerIdentity} from './spec-cubesigner.js'
import {specDstackController, specKubernetesTarget} from './spec-kubernetes-target.js'
import {resolveSpecProofStorage} from './spec-proof-storage.js'
import {specAwsSecretPrefix} from './spec-secret-prefix.js'

export interface PreparationStep {effect: 'chain' | 'cloud' | 'local' | 'read'; id: string; retry: 'reconcile' | 'safe'; stage?: PreparationStage; title: string}
export const PREPARATION_SCHEMA = 'scrollsdk/preparation/v6'
export interface PreparationPlan {deploymentName: string; envFile?: string; id: string; schema: typeof PREPARATION_SCHEMA; sdkDirectory: string; specHash: string; steps: PreparationStep[]}
export interface PreparationState {
  completedStage?: PreparationStage
  currentStep?: string
  deferred?: string[]
  files: Record<string, string>
  nextStage?: PreparationStage
  planId: string
  status: 'failed' | 'pending' | 'prepared' | 'recovery-required' | 'running' | 'stage-complete' | 'waiting'
  steps: Record<string, 'completed' | 'failed' | 'recovery-required' | 'running'>
  waiting?: AwaitingInput['details']
  warnings?: string[]
}
export const WORKFLOW_DIR = '.scrollsdk'
export function preparationSteps(spec: DeploymentSpec, staged = false): PreparationStep[] {
  const p = spec.preparation!
  const steps: PreparationStep[] = []
  const add = (id: string, title: string, effect: PreparationStep['effect'] = 'local', retry: PreparationStep['retry'] = 'safe') => steps.push({effect, id, retry, title})
  add('bootstrap', 'Generate configuration from pinned SDK templates')
  if (p.bridge.mode === 'production') add('bridge-fee-wallet', 'Derive and pin the fee-wallet public identity from DOGECOIN_FEE_WALLET_KEY')
  const workloadRoles = usesWorkloadRoles(spec)
  if (spec.infrastructure?.provider === 'aws') add('aws-resources', 'Read external resource metadata for production values', 'read')
  add('identities', 'Prepare declared service identities and deployment account', JSON.stringify(spec.identities ?? {}).includes('aws_kms') ? 'read' : 'local')
  if (p.proofAws) add('proof-aws', 'Read proof bucket and Secret references', 'read')
  if (p.bridge.production?.sequencerKms) add('bridge-sequencer-kms', 'Read and pin the existing Bridge signing identity', 'read')
  const dstack = spec.dstackController && spec.dstackController.enabled !== false
  if (dstack && dstackAwsIntent(spec)) add('dstack-aws', 'Read the external dstack controller role', 'read')
  if (dstack && spec.capacityManager?.connection?.mode === 'existing-alb') add('dstack-network', 'Read the existing private dstack endpoint', 'read')
  if (workloadRoles) add('aws-roles', 'Resolve externally managed workload roles and bind their ARNs', 'read')
  if (dstack) {
    add('dstack', 'Prepare dstack controller credentials and config')
    if (p.dstack?.initializeDatabase) add('dstack-db', 'Initialize dstack in the existing PostgreSQL server', 'cloud')
  }

  if (p.databases?.includes('blockscout')) add('blockscout-db', 'Initialize Blockscout in the existing PostgreSQL server', 'cloud')
  add('genesis', 'Generate native L2 genesis and contract artifacts')
  add('bridge-prepare', 'Compute protocol seed from genesis')
  if (p.bridge.mode === 'production') {
    add('ethereum-anchor', 'Validate and bind the selected Ethereum DA anchor', 'read')
    if (usesManagedHelper(spec)) {
      add('managed-helper-prepare', 'Prepare helper distribution with independently managed Bridge public keys')
      add('managed-helper-funding', 'Wait for and verify helper funding', 'read')
      add('managed-helper-setup', 'Broadcast helper distribution transaction', 'chain', 'reconcile')
      add('bridge-info', 'Derive the namespace and final Bridge address')
      add('managed-helper-fund', 'Broadcast marked Bridge funding from helper outputs', 'chain', 'reconcile')
      add('managed-helper-verify', 'Verify helper distribution and marked Bridge funding', 'read')
    } else {
      add('production-wallets', 'Wait for and verify sequencer and fee-wallet funding', 'read')
      add('bridge-info', 'Derive the namespace and final Bridge address')
      add('production-funding', 'Wait for and verify marked Bridge funding', 'read')
    }
  } else {
    add('helper-funding', 'Wait for and verify test-helper funding', 'read')
    add('helper-setup', 'Broadcast test-helper setup transaction', 'chain', 'reconcile')
    add('bridge-info', 'Derive namespace and final Bridge address')
    add('helper-fund', 'Broadcast test-helper Bridge/deposit-seed transactions', 'chain', 'reconcile')
  }

  if (staged && needsPreparationPolicy(spec)) add('cubesigner-policy-build', 'Export the release CubeSigner policy Wasm for governance review')
  add('protocol-context', 'Generate canonical protocol context')
  add('external-inputs', 'Import declared external runtime and policy inputs')
  if (p.proofRelease) {
    add('proof-release-bake', 'Bake real proof identities for this protocol context')
    add('proof-materializer-export', 'Export materializers from the release coordinator image')
    add('proof-worker-image-check', 'Check the release CUDA Worker against the baked identities')
  }

  add('proof-materials', 'Prepare or consume proof materials for the selected mode')
  add('charts', 'Compile topology and reconcile service configuration')
  if (p.proofPublication) {
    add('proof-publish', 'Publish and verify the approved real-proof program bundle', 'cloud')
    add('charts-published', 'Bind publication receipt into service configuration')
  }

  add('secrets', 'Generate private runtime Secrets')
  if (staged && spec.bridge?.cubesigner) add('cubesigner-session', 'Validate/reuse or create the scoped CubeSigner runtime session (provider mutation when absent)', 'cloud')
  if (spec.proofTopology?.enforcement === 'enforce') {
    add('deployment-kit', 'Export the signer deployment kit')
    if (p.deploymentKitPublication?.mode === 's3') add('deployment-kit-published', 'Publish and verify the signer deployment kit in the selected S3 bucket', 'cloud')
    else add('deployment-kit-published', 'Wait for the deployment kit publication record')
  }

  add('proof-check', 'Validate proof configuration and required evidence')
  if (staged && spec.bridge?.cubesigner) add('cubesigner-secret-upload', 'Upload only the CubeSigner runtime Secrets', 'cloud')
  if (p.secretUpload) add('secret-upload', 'Upload declared runtime Secrets', 'cloud')

  if (spec.capacityManager) add('capacity-manager', 'Prepare Core capacity-manager values for separate Helm installation (no allocation now)')

  return staged ? stagedPreparationSteps(steps) : steps
}

export function validatePreparation(spec: DeploymentSpec): void {
  if (spec.capacityManager) resolveCapacityManager(spec)
  specKubernetesTarget(spec)
  specDstackController(spec)
  feeVaultRecipientHash(spec.contracts?.feeVaultDogeRecipientAddress ?? '', spec.dogecoin.network)
  const p = spec.preparation

  specAwsSecretPrefix(spec)
  if (!p) throw new Error('preparation is required for setup plan; plain generate-from-spec remains available')
  validateExternalAwsRoles(spec)
  if (p.tsoAlbEdge && typeof p.tsoAlbEdge.enabled !== 'boolean') throw new Error('tsoAlbEdge.enabled must be boolean')
  if (p.tsoAlbEdge?.enabled && (!spec.infrastructure.aws?.region || !spec.infrastructure.aws.eksClusterName || !specKubernetesTarget(spec).kubeContext)) throw new Error('tsoAlbEdge requires explicit AWS region, EKS cluster and Kubernetes context')
  if (p.deploymentKitPublication && !['manual', 's3'].includes(p.deploymentKitPublication.mode)) throw new Error('deploymentKitPublication.mode must be manual or s3')
  if (p.deploymentKitPublication?.mode === 's3' && (spec.proofTopology?.enforcement !== 'enforce' || !spec.proofArtifacts?.s3?.bucket)) throw new Error('S3 deployment kit publication requires enforcing proof topology and a selected proof artifacts bucket')
  if (!['helper', 'production'].includes(p.bridge?.mode)) throw new Error('preparation.bridge.mode must explicitly select production or helper')
  if (p.bridge.mode !== 'production' && p.bridge.production) throw new Error('Production Bridge inputs require preparation.bridge.mode: production')
  if (!p.bridge.image?.includes('@sha256:')) throw new Error('preparation.bridge.image must select an immutable bridge-genesis-tools digest')
  resolveBridgeGenesisImage(p.bridge.image)
  if (!Number.isSafeInteger(spec.bridge.confirmationsRequired) || spec.bridge.confirmationsRequired < 1) throw new Error('Preparation requires at least one funding confirmation')
  if ('attestationDescriptors' in p) throw new Error('Remove preparation.attestationDescriptors; declare public identities in bridge.attestation.signers')
  resolveSpecAttestationSigners(spec)
  if (!['existing', 'mock', 'real'].includes(p.proofMaterials?.mode)) throw new Error('preparation.proofMaterials.mode is required')
  if (p.proofMaterials.mode === 'mock' && !p.proofMaterials.mockWorkerImage) throw new Error('Mock material preparation requires mockWorkerImage')
  if (p.proofRelease && (p.proofMaterials.mode !== 'real' || spec.proofTopology?.generation !== 'real')) throw new Error('proofRelease requires real proof material preparation and real topology generation')
  if (p.proofRelease && [p.proofMaterials.preparationReceipt, p.proofMaterials.productionWorkerReceipt, p.proofMaterials.chunkMaterializer, p.proofMaterials.batchMaterializer].some(Boolean)) throw new Error('proofRelease derives material inputs; do not also supply preparation/Worker receipts or materializer paths')
  if (p.proofMaterials.mode === 'real' && !p.proofRelease && (!p.proofMaterials.preparationReceipt || !p.proofMaterials.chunkMaterializer || !p.proofMaterials.batchMaterializer)) throw new Error('Real material preparation requires a preparation receipt and both materializers')
  if (p.proofMaterials.mode !== 'existing' && p.proofMaterials.mode !== spec.proofTopology?.generation) throw new Error('Material preparation must match proofTopology.generation')
  if (p.proofPublication && !(p.proofPublication.release ?? p.proofRelease?.manifest)) throw new Error('Publication requires a proof release manifest')
  if (p.proofPublication && Boolean(p.proofPublication.release) !== Boolean(p.proofPublication.releaseSha256)) throw new Error('Publication release and releaseSha256 must be supplied together')
  if (p.proofPublication && (!/^[\da-f]{64}$/.test(p.proofPublication.releaseSha256 ?? p.proofRelease?.sha256 ?? '') || spec.proofTopology?.generation !== 'real')) throw new Error('Publication requires a pinned release manifest and real generation')
  if (p.archive && p.archive.action !== 'configure') throw new Error('Prepare the archive bucket externally; preparation.archive.action must be configure')
  if (p.archive?.publicRead !== undefined && typeof p.archive.publicRead !== 'boolean') throw new Error('Archive publicRead must be a boolean')
  if (p.proofAws && p.proofAws.action !== 'reuse') throw new Error('Prepare the proof bucket and permissions externally; proofAws.action must select reuse')
  if (p.proofAws?.action === 'reuse' && p.proofAws.publicReadMode === 'direct-s3') throw new Error('Reuse proof resources with existing-public-s3 or existing-gateway; direct-s3 manages bucket policy')
  if (p.proofAws && !['direct-s3', 'existing-gateway', 'existing-public-s3'].includes(p.proofAws.publicReadMode)) throw new Error('Invalid proof public-read mode')
  if (p.secretUpload?.provider === 'aws' && !p.secretUpload.awsRegion && !spec.infrastructure.aws?.region) throw new Error('AWS Secret upload requires an explicit region in secretUpload or infrastructure.aws')
  if (p.secretUpload && spec.dstackController?.enabled !== false && spec.dstackController && !specKubernetesTarget(spec).kubeContext) throw new Error('Dstack Secret upload requires an explicit Kubernetes context')
  if (p.proofAws?.publicReadMode === 'existing-gateway' && !p.proofAws.publicEndpointUrl) throw new Error('Existing proof gateway requires publicEndpointUrl')
  if ((p.proofMaterials.mode !== 'existing' || p.proofMaterials.receipt) && resolveSpecProofStorage(spec).proofTopology?.active?.artifactStore.kind !== 's3_compatible') throw new Error('Topology derived from a material receipt requires the declared S3 proof artifact store')
  if (p.secretUpload && !['aws', 'vault'].includes(p.secretUpload.provider)) throw new Error('Secret upload provider must be aws or vault')
  if (spec.dstackController && spec.dstackController.enabled !== false && !p.dstack) throw new Error('Enabled dstack requires preparation.dstack with explicit import or external credentials mode')
  if (p.dstack && !['external', 'import'].includes(p.dstack.mode)) throw new Error('Dstack preparation mode must be import or external')
  if (p.dstack?.mode === 'import' && (!p.dstack.providers?.length || p.dstack.providers.includes('vastai') && !p.dstack.vastaiApiKeyFile && !p.dstack.vastaiApiKeyEnv || p.dstack.providers.includes('gcp') && !p.dstack.gcpServiceAccountFile)) throw new Error('Dstack import requires providers and their credential file or environment references')
  dstackAwsIntent(spec)
  if (p.dstack?.mode === 'import' && p.dstack.providers?.includes('aws')) validateDstackAwsBackend(p.dstack.aws)
  if (p.dstack?.vastaiApiKeyEnv && !/^[A-Z_a-z]\w*$/.test(p.dstack.vastaiApiKeyEnv)) throw new Error('Dstack vastaiApiKeyEnv must name an environment variable')
  if (p.dstack?.vastaiApiKeyEnv && p.dstack.vastaiApiKeyFile) throw new Error('Choose vastaiApiKeyEnv or vastaiApiKeyFile, not both')
  if (p.dstack?.databaseUrlEnv && !/^[A-Z_a-z]\w*$/.test(p.dstack.databaseUrlEnv)) throw new Error('Dstack databaseUrlEnv must name an environment variable')
  if (p.dstack?.databaseUrlEnv && p.dstack.initializeDatabase) throw new Error('Choose existing dstack databaseUrlEnv or initializeDatabase')
  if (usesDstackPostgres(spec.dstackController) && !p.dstack?.initializeDatabase && !p.dstack?.databaseUrlEnv) throw new Error('PostgreSQL dstack requires initializeDatabase or databaseUrlEnv')
  if (p.dstack?.initializeDatabase !== undefined && typeof p.dstack.initializeDatabase !== 'boolean') throw new Error('initializeDatabase must be boolean')
  if (p.dstack && (!spec.dstackController || spec.dstackController.enabled === false)) throw new Error('Dstack preparation requires an enabled dstackController')
  if (p.dstack?.providers?.some(provider => !['aws', 'gcp', 'vastai'].includes(provider))) throw new Error('Unsupported dstack credential provider')
  if (p.proofAws && (!spec.infrastructure.aws?.eksClusterName || !spec.infrastructure.aws.region)) throw new Error('Proof AWS provisioning requires an existing EKS cluster and region')
  if (p.bridge.mode === 'helper' && !spec.bridge.seedString?.trim()) throw new Error('Test-helper preparation requires bridge.seedString')
  if (p.bridge.mode === 'helper' && (spec.dogecoin.network === 'mainnet' || spec.metadata.environment === 'mainnet')) throw new Error('The deterministic helper is test-only; choose production Bridge preparation')
  if (p.bridge.mode === 'production') {
    const publicKey = (value: unknown) => {
      try {if (typeof value !== 'string' || !/^(02|03)[\da-f]{64}$/i.test(value)) throw new Error('Invalid key'); return bitcore.PublicKey.fromString(value)} catch {throw new Error('Production Bridge requires valid compressed public keys')}
    }

    const policy = p.bridge.production
    if (!policy) throw new Error('preparation.bridge.production must declare independently managed Dogecoin wallets')
    if (policy.funding !== undefined && !['external', 'helper'].includes(policy.funding)) throw new Error('production.funding must be helper or external')
    const anchor = policy.ethereumAnchor
    if (anchor?.blockTag !== undefined) {
      if (anchor.blockTag !== 'finalized' || anchor.blockNumber !== undefined || anchor.transactionIndex !== undefined) throw new Error('Use ethereumAnchor.blockTag: finalized alone, or explicit blockNumber and transactionIndex')
    } else if (!anchor || [anchor.blockNumber, anchor.transactionIndex].some(value => !Number.isSafeInteger(value) || value! < 0)) {
      throw new Error('Production Bridge requires ethereumAnchor.blockTag: finalized or explicit blockNumber and transactionIndex')
    }

    if ('feeWalletPublicKey' in policy || 'feeWalletKeyEnv' in policy) throw new Error('Remove feeWalletPublicKey and feeWalletKeyEnv from spec; apply derives the fee-wallet identity from DOGECOIN_FEE_WALLET_KEY in deployment.env')
    publicKey(spec.bridge.cubesigner?.publicKey)
    if (policy.sequencerKms) {
      const kms = policy.sequencerKms
      if (policy.sequencerPublicKey !== undefined || policy.sequencerKeyEnv !== undefined) throw new Error('sequencerKms replaces sequencerPublicKey and sequencerKeyEnv; remove the local sequencer inputs')
      if (kms.action !== 'reuse') throw new Error('Prepare the Bridge signing key externally; sequencerKms.action must be reuse')
      if (spec.infrastructure.provider !== 'aws' || !spec.infrastructure.aws?.region || !spec.infrastructure.aws.eksClusterName) throw new Error('Bridge sequencer KMS requires AWS region and an existing EKS cluster')
      if (kms.region !== undefined && !kms.region.trim()) throw new Error('sequencerKms.region must not be empty')
      if (kms.action === 'reuse' && !kms.keyId?.trim()) throw new Error('sequencerKms reuse requires keyId')
      if (spec.images?.services?.withdrawalProcessor?.tag === 'v0.3.0-beta.6') throw new Error('Bridge sequencer KMS requires withdrawal-processor:v0.3.0-beta.6-kms or another KMS-enabled image')
    } else {
      publicKey(policy.sequencerPublicKey)
      if (!policy.sequencerKeyEnv || !/^[A-Z_a-z]\w*$/.test(policy.sequencerKeyEnv)) throw new Error('Production wallet key references must name environment variables')
    }

    if (!Array.isArray(spec.bridge.recovery.publicKeys) || new Set(spec.bridge.recovery.publicKeys.map(key => key.toLowerCase())).size !== spec.bridge.recovery.publicKeys.length || spec.bridge.recovery.publicKeys.length < spec.bridge.recovery.threshold || spec.bridge.recovery.threshold < 1) throw new Error('Recovery keys must be unique and satisfy the threshold')
    spec.bridge.recovery.publicKeys.forEach(value => publicKey(value))
    if (!Number.isSafeInteger(spec.bridge.recovery.timelock) || spec.bridge.recovery.timelock <= 100 || spec.bridge.recovery.timelock >= 500_000_000) throw new Error('Production Bridge needs an explicit recovery timelock block height')
  }

  for (const item of p.inputs ?? []) {
    if (dstackAwsIntent(spec) && item.destination === '.data/dstack-aws.json') throw new Error('Dstack AWS preparation generates its own resource record; remove dstack-aws.json from external inputs')
    if (p.proofAws && item.destination === '.data/proof-aws.json') throw new Error('proofAws generates its own receipt; remove proof-aws.json from external inputs')
    if (!item.source || !/^(\.data|secrets)\//.test(item.destination) || /(?:^|\/)(?:doge-config\.toml|setup_defaults\.toml|protocol_seed\.toml|protocol_context\.json|GenerateBridgeInfo\.toml|bridge\.json|bridge-sequencer-kms\.json|bridge-fee-wallet\.json|production-.*\.json|output-.*|genesis\.json)$/.test(item.destination)) throw new Error('External inputs may not overwrite managed Bridge or deployment state')
    localPath('/deployment', item.destination)
  }

  localPath('/deployment', p.bridge.fundingFile ?? '.scrollsdk/inputs/bridge-funding.json')
  if (p.bridge.fundingFile && !p.bridge.fundingFile.startsWith('.scrollsdk/inputs/')) throw new Error('Funding input must live under .scrollsdk/inputs/')
}

function operatorEditableArtifact(relative: string): boolean {
  return relative === 'Makefile' || /^values\/.*\.ya?ml$/.test(relative)
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

  const kits = fs.readdirSync(root).filter(name => DEPLOYMENT_KIT_DIRECTORY.test(name)).sort()
  for (const name of ['genesis.json', 'genesis.yaml', 'config.toml', 'config-contracts.toml', 'Makefile', '.data', 'values', 'secrets', 'withdrawal-processor', 'proof-coordinator', 'eth-da-submitter', ...kits]) visit(name)
  return files
}

export async function createPreparationPlan(options: {envFile?: string; output: string; sdkDirectory: string; spec: string; staged?: boolean}): Promise<PreparationPlan> {
  const savedPlan = path.join(path.resolve(options.output), WORKFLOW_DIR, 'plan.json')
  if (fs.existsSync(savedPlan)) assertCurrentPlan(JSON.parse(fs.readFileSync(savedPlan, 'utf8')))
  if (options.staged === false) throw new Error('Only staged preparation is supported; use setup plan and its stage commands')
  const envFile = options.envFile ? path.resolve(options.envFile) : undefined
  loadPreparationEnv(envFile)
  let spec: DeploymentSpec
  try {spec = resolveDeploymentSpecEnvRefs(loadDeploymentSpec(path.resolve(options.spec)))} catch (error) {
    if (error instanceof DeploymentSpecFieldError) throw error
    throw new Error('Cannot load DeploymentSpec; check field names, YAML syntax and environment references (values omitted)')
  }

  // Reject a missing/invalid withdrawal destination before SDK lookup, CubeSigner
  // authentication or proof-release downloads. Apply rechecks it on saved plans.
  feeVaultRecipientHash(spec.contracts?.feeVaultDogeRecipientAddress ?? '', spec.dogecoin.network)
  // Persist the choice in new plans. Previously saved plans keep their original funding path.
  if (spec.preparation?.bridge.mode === 'production' && spec.preparation.bridge.production) spec.preparation.bridge.production.funding ??= 'helper'
  spec.templates = {sdkRevision: resolveSdkRevision(options.sdkDirectory, spec.templates?.sdkRevision)}
  // Selected external bindings must be usable by the frozen SDK before any
  // provider identity queries or release downloads, not only at bootstrap.
  validateExistingAlb(spec)
  validateExistingAlbSdk(options.sdkDirectory, spec)
  validateExistingNlbSdk(options.sdkDirectory, spec)
  spec = resolveCubesignerIdentity(spec)
  spec = await resolvePreparationProofRelease(spec, options.output)
  const validation = validateDeploymentSpec(spec)
  if (!validation.valid) throw new Error(`Invalid spec fields: ${validation.errors.map(e => `${e.path} (${e.code})`).join(', ')}`)
  validatePreparation(spec)
  planSpecBootstrap(spec, options.sdkDirectory)
  const root = path.resolve(options.output)
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('Deployment root cannot be a symlink')
  const specText = JSON.stringify(spec, null, 2) + '\n'
  const body = {...(envFile ? {envFile} : {}), deploymentName: spec.metadata.name, schema: PREPARATION_SCHEMA as typeof PREPARATION_SCHEMA, sdkDirectory: fs.realpathSync(options.sdkDirectory), specHash: digest(specText), steps: preparationSteps(spec, true)}
  const plan = {...body, id: digest(JSON.stringify(body))}
  const directory = path.join(root, WORKFLOW_DIR)
  if (fs.existsSync(path.join(directory, 'state.json'))) {
    const current = JSON.parse(fs.readFileSync(path.join(directory, 'plan.json'), 'utf8')) as PreparationPlan
    if (current.id === plan.id) return current
    throw new Error('An existing preparation plan is immutable; supply external inputs and rerun the same preparation command, or choose a new deployment directory for a different spec')
  }

  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) throw new Error('setup plan requires an empty output directory')
  // Publish the initial plan as one directory, so an interrupted write cannot
  // leave a nonempty output with no state from which to resume.
  fs.mkdirSync(path.dirname(root), {mode: 0o700, recursive: true})
  const staging = fs.mkdtempSync(path.join(path.dirname(root), `.${path.basename(root)}.plan-`))
  try {
    privateWrite(path.join(staging, '.scrollsdkignore'), '.scrollsdk/\n.data/contracts-build/\n')
    privateWrite(path.join(staging, WORKFLOW_DIR, 'intent.json'), specText)
    writeJson(path.join(staging, WORKFLOW_DIR, 'plan.json'), plan)
    writeJson(path.join(staging, WORKFLOW_DIR, 'state.json'), {files: {}, nextStage: 'aws' as const, planId: plan.id, status: 'pending', steps: {}} satisfies PreparationState)
    // Rename may replace an empty directory, but refuses a concurrent writer's
    // nonempty output. Never remove the destination to make room.
    fs.renameSync(staging, root)
  } finally {fs.rmSync(staging, {force: true, recursive: true})}

  return plan
}

const DEPLOYMENT_KIT_DIRECTORY = /^deployment-kit-k-[\da-f]{12}$/
/** A schema identifies an execution contract, not a particular CLI build. */
function assertCurrentPlan(plan: PreparationPlan): void {
  if (plan.schema !== PREPARATION_SCHEMA) throw new Error('Unsupported preparation plan: old plans are not migrated. Preserve the existing deployment directory; use its original CLI or create a new plan in a separate empty directory')
}

export interface PreparationRunner {run(step: PreparationStep, spec: DeploymentSpec, root: string, plan: PreparationPlan): Promise<void>}
export async function applyPreparation(rootInput: string, runner: PreparationRunner, progress: (step: PreparationStep) => void = () => {}, options: {deferCubesigner?: boolean; dogecoinRoutingSpec?: string; refreshRuntime?: boolean; stage?: PreparationStage; warn?: (message: string) => void} = {}): Promise<PreparationState> {
  if (options.refreshRuntime || options.dogecoinRoutingSpec) throw new Error('Legacy runtime refresh is not supported; use staged preparation')
  const root = fs.realpathSync(rootInput)
  const directory = localPath(root, WORKFLOW_DIR)
  const planPath = localPath(root, `${WORKFLOW_DIR}/plan.json`)
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8')) as PreparationPlan
  assertCurrentPlan(plan)
  const text = fs.readFileSync(localPath(root, `${WORKFLOW_DIR}/intent.json`), 'utf8')
  const {id, ...body} = plan
  const warnings: string[] = []
  const warn = (message: string): void => {warnings.push(message); options.warn?.(message)}
  if (digest(JSON.stringify(body)) !== id) throw new Error('Saved plan content changed: restore .scrollsdk/plan.json from backup')
  if (digest(text) !== plan.specHash) throw new Error('Saved intent content changed: restore .scrollsdk/intent.json from backup; a different intent requires a new plan')
  loadPreparationEnv(plan.envFile)
  const spec = JSON.parse(text) as DeploymentSpec
  validatePreparation(spec)
  const steps = preparationSteps(spec, true)
  const statePath = localPath(root, `${WORKFLOW_DIR}/state.json`)
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as PreparationState
  state.warnings = warnings
  if (state.planId !== id) throw new Error('Workflow state does not match plan')
  const contract = (items: PreparationStep[]) => items.map(({effect, id, retry, stage}) => ({effect, id, retry, stage}))
  if (JSON.stringify(contract(steps)) !== JSON.stringify(contract(plan.steps))) throw new Error('Preparation workflow differs from this plan; old plans are not migrated. Preserve the directory and use the CLI that created it')
  if (!options.stage) throw new Error(`Select a preparation stage: ${stageCommand(steps.find(step => state.steps[step.id] !== 'completed' && !state.deferred?.includes(step.id))?.stage ?? 'aws', root)}`)
  if (options.stage) {
    const index = PREPARATION_STAGES.indexOf(options.stage)
    if (index < 0) throw new Error('Unknown preparation stage')
    const missing = steps.find(step => prerequisiteStages(options.stage!).includes(step.stage!) && state.steps[step.id] !== 'completed' && !state.deferred?.includes(step.id))
    if (missing) throw new Error(`Prerequisite ${missing.stage} is incomplete. Run ${stageCommand(missing.stage!, root)}`)
  }

  state.nextStage = steps.find(step => state.steps[step.id] !== 'completed' && !state.deferred?.includes(step.id))?.stage
  const lock = path.join(directory, 'apply.lock')
  // Never steal an ambiguous lock. An interrupted process leaves an explicit recovery record.
  let fd: number
  try {fd = fs.openSync(lock, 'wx', 0o600)} catch {throw new Error('Another apply owns .scrollsdk/apply.lock; if interrupted, verify its recorded host/PID is no longer running before removing that lock')}
  fs.writeFileSync(fd, JSON.stringify({host: os.hostname(), pid: process.pid})); fs.closeSync(fd)
  try {
    if (options.stage === 'aws') {
      // Previous success is not a cache of cloud state. Invalidate the entire
      // stage before the first call so a failed attempt blocks dependants.
      for (const step of plan.steps.filter(step => step.stage === 'aws' && step.id !== 'bootstrap')) delete state.steps[step.id]
      state.nextStage = 'aws'
      state.status = 'running'
      delete state.completedStage
      writeJson(statePath, state)
    }

    const missingArtifacts: string[] = []
    for (const [file, hash] of Object.entries(state.files)) {
      const current = localPath(root, file)
      if (!fs.existsSync(current)) missingArtifacts.push(file)
      else if (!operatorEditableArtifact(file) && digest(fs.readFileSync(current)) !== hash) warn(`Prepared artifact changed: ${file}. Continuing with the current file; completed steps will not be regenerated.`)
    }

    if (missingArtifacts.length > 0) {
      state.status = 'recovery-required'
      state.waiting = {message: `Prepared artifacts are missing: ${missingArtifacts.join(', ')}. Restore these files from the deployment backup, then retry. Completed steps, credentials and transactions will not be replayed automatically.`}
      delete state.completedStage
      // Keep the missing entries so a second attempt cannot silently accept the loss.
      writeJson(statePath, state)
      return state
    }

    for (const step of plan.steps) {
      if (options.stage && step.stage !== options.stage) continue
      if (state.steps[step.id] === 'completed') continue
      if (['cubesigner-secret-upload', 'cubesigner-session'].includes(step.id)) {
        if (options.deferCubesigner) {state.deferred = [...new Set([...(state.deferred ?? []), step.id])]; continue}
        state.deferred = state.deferred?.filter(id => id !== step.id)
      }

      if (state.steps[step.id] === 'recovery-required' || state.steps[step.id] === 'running' && step.retry === 'reconcile') {
        state.status = 'recovery-required'; state.currentStep = step.id
        state.waiting = {message: 'A transaction may already have been broadcast. Reconcile on-chain results and partial artifacts; this workflow will not replay this step automatically'}
        writeJson(statePath, state); return state
      }

      progress(step)
      state.status = 'running'; state.currentStep = step.id; delete state.waiting; delete state.completedStage
      state.nextStage = step.stage
      state.steps[step.id] = 'running'; writeJson(statePath, state)
      try {
        const priorStage = process.env.SCROLLSDK_PREPARATION_STAGE
        try {
          if (step.stage === 'aws') process.env.SCROLLSDK_PREPARATION_STAGE = 'aws'
          await runner.run(step, spec, root, plan)
        } finally {
          if (priorStage === undefined) delete process.env.SCROLLSDK_PREPARATION_STAGE
          else process.env.SCROLLSDK_PREPARATION_STAGE = priorStage
        }

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

    state.status = plan.steps.every(step => state.steps[step.id] === 'completed') ? 'prepared' : 'stage-complete'
    if (options.stage) {
      state.completedStage = options.stage
      state.nextStage = plan.steps.find(step => state.steps[step.id] !== 'completed' && !state.deferred?.includes(step.id))?.stage
    }

    delete state.currentStep; delete state.waiting
    state.files = fingerprint(root)
    writeJson(statePath, state)
    return state
  } finally {fs.unlinkSync(lock)}
}
