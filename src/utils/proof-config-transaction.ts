import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'
import type {ProofEnforcement, ProofGeneration, ProofTopologyMode} from '../types/proof-topology.js'
import type {ProofDeploymentContract} from './proof-deployment-contract.js'
import type {ProofProgramPublicationPlan} from './proof-program-publication.js'
import type {ProofTopologyRuntimeInput} from './proof-topology-init.js'

import {cubesignerLiveEvidenceProjection, cubesignerPolicyEnvironment, resolveCubesignerPolicy} from './cubesigner-policy-receipts.js'
import {dogeConfigToToml} from './doge-config.js'
import {resolveDogecoinServiceRpcUrl} from './kubernetes-endpoints.js'
import {readProofAwsConfig} from './proof-aws-config.js'
import {proofArtifactS3Endpoint} from './proof-aws-provisioner.js'
import {validateProofDeploymentContract} from './proof-deployment-contract.js'
import {proofEnforcementReadiness} from './proof-enforcement-readiness.js'
import {resolveProofIntent} from './proof-intent.js'
import {reconcileProofKubernetes} from './proof-kubernetes-reconciler.js'
import {parseImmutableProofImage, parseProofIdentityEnv, prepareProofMaterials} from './proof-materials.js'
import {prepareRealProofRelease} from './proof-prepare-real.js'
import {planProofProgramPublication, publishProofProgramBundle} from './proof-program-publication.js'
import {readProofReleasePreparation} from './proof-release-preparation.js'
import {assertTopologyUsesSharedArtifactStore, sharedArtifactStoreFromDogeConfig} from './proof-shared-artifact-store.js'
import {proofFileHash, proofRegularFile, readProofSoftwareRelease} from './proof-software-release.js'
import {proofTopologyEthereumDaBlobSource, validateProofTopologyBundle} from './proof-topology-compiler.js'
import {buildProofTopology} from './proof-topology-init.js'
import {checkProofWorkerImage} from './proof-worker-image-check.js'
import {deriveTsoUrl} from './signer-policy-derivation.js'
import {writeSignerPolicyHandoff} from './signer-policy-handoff.js'

export interface ProofConfigRequest {
  deploymentName: string
  enforcement: ProofEnforcement
  generation: ProofGeneration
  mode: ProofTopologyMode
  runtime: ProofTopologyRuntimeInput
  tsoUrl?: string
}
const PREPARED = 'proof-config-prepared.json'
const PREPARED_CONTRACT = '.data/proof-deployment-prepared.json'
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const jsonWrite = (file: string, value: unknown): void => { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600}) }

function snapshot(root: string): Record<string, {sha256: string; sizeBytes: number}> {
  const files: Record<string, {sha256: string; sizeBytes: number}> = {}
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Prepared generation contains a symlink')
      if (entry.isDirectory()) visit(file)
      else {
        if (!entry.isFile()) throw new Error('Prepared generation contains a non-file')
        files[path.relative(root, file).split(path.sep).join('/')] = {sha256: proofFileHash(file), sizeBytes: fs.statSync(file).size}
      }
    }
  }

  visit(root)
  return files
}

function copyTree(source: string, destination: string, inputs: Map<string, string>): void {
  if (fs.lstatSync(source).isSymbolicLink()) throw new Error(`Symlink deployment input: ${source}`)
  if (fs.statSync(source).isDirectory()) {
    fs.mkdirSync(destination, {recursive: true})
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(destination, name), inputs)
  } else {
    proofRegularFile(source)
    fs.mkdirSync(path.dirname(destination), {recursive: true})
    const before = proofFileHash(source)
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
    if (before !== proofFileHash(destination) || before !== proofFileHash(source)) throw new Error(`Deployment input changed while copying: ${source}`)
    inputs.set(source, before)
  }
}

function portablePlan(plan: ProofProgramPublicationPlan, root: string): ProofProgramPublicationPlan {
  return {...plan, files: plan.files.map(file => ({...file, source: path.relative(root, file.source).split(path.sep).join('/')}))}
}

/** A complete candidate is made visible by one rename. Active deployment files
 * are inputs only; no AWS/Kubernetes/provider mutation occurs in preparation. */
export function prepareProofConfig(options: {
  deploymentDir: string; output: string; prepareReal?: typeof prepareRealProofRelease; release: string; releaseSha256: string
  request: ProofConfigRequest
}): {directory: string; publicationPlan?: ProofProgramPublicationPlan; receipt: string; receiptSha256: string; warnings: string[]} {
  const root = fs.realpathSync(options.deploymentDir)
  const selected = readProofSoftwareRelease(path.resolve(root, options.release), options.releaseSha256)
  const {request} = options
  if (request?.runtime && ('artifactKeyPrefix' in request.runtime || 'publicS3EndpointUrl' in request.runtime)) throw new Error('Artifact prefix and public endpoint are derived from proof-aws.json; omit duplicate request inputs')
  if (!request || !['mock', 'real'].includes(request.generation) || !['active', 'disabled'].includes(request.mode) || !['enforce', 'observe'].includes(request.enforcement) || !/^[\da-z][\da-z-]+$/.test(request.deploymentName)) throw new Error('Invalid high-level proof configuration request')
  const target = path.resolve(root, options.output)
  if (target === root || root.startsWith(target + path.sep) || fs.existsSync(target)) throw new Error('Output must be a new candidate directory')
  for (const directory of ['values', '.data', 'withdrawal-processor', 'proof-coordinator', 'eth-da-submitter']) {
    const source = path.join(root, directory)
    if (target === source || target.startsWith(source + path.sep)) throw new Error('Candidate output cannot be inside an input directory')
  }

  const inputs = new Map<string, string>()
  fs.mkdirSync(path.dirname(target), {recursive: true})
  if (fs.realpathSync(path.dirname(target)) !== path.dirname(target)) throw new Error('Output parent contains a symlink')
  const lock = target + '.prepare-lock'
  fs.mkdirSync(lock, {mode: 0o700})
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.proof-config-'))
  try {
    for (const input of ['.data/doge-config.toml', '.data/protocol_context.json', '.data/proof-aws.json', 'values', 'withdrawal-processor', 'proof-coordinator', 'eth-da-submitter']) {
      const source = path.join(root, input)
      if (fs.existsSync(source)) copyTree(source, path.join(stage, input), inputs)
    }

    const configPath = path.join(stage, '.data/doge-config.toml')
    const config = toml.parse(fs.readFileSync(proofRegularFile(configPath), 'utf8')) as unknown as DogeConfig
    if (config.network === 'mainnet' && request.enforcement !== 'enforce') throw new Error('Mainnet requires proof enforcement')
    const runtime = {...request.runtime, observeRealProofDeadlineMs: request.runtime?.observeRealProofDeadlineMs ?? config.proof_topology?.observeRealProofDeadlineMs}
    if (!Number.isSafeInteger(runtime.observeRealProofDeadlineMs) || runtime.observeRealProofDeadlineMs! <= 0) throw new Error('runtime.observeRealProofDeadlineMs must be a positive safe integer, supplied in the request or existing proof topology')
    // Receipt dependencies stay in the deployment input root and are hash-checked
    // before projection; generated live evidence is copied into the chart map.
    const policy = resolveCubesignerPolicy({deploymentDir: root, keys: (config.cubesigner?.roles ?? []).flatMap(role => role.keys.map(key => ({keyId: key.key_id, materialId: key.material_id, roleId: role.role_id}))), network: config.network, selection: config.cubesigner})
    if (config.cubesigner?.policyReceipts) {
      // Preserve explicit references across the candidate-directory boundary.
      for (const ref of Object.values(config.cubesigner.policyReceipts)) {
        if (ref && typeof ref === 'object' && 'path' in ref) ref.path = path.resolve(root, ref.path)
      }
    }

    const signerValidation = config.attestationSigner?.policyValidation
    if (signerValidation) {
      for (const ref of [signerValidation.bundleManifest, ...signerValidation.receipts]) ref.path = path.resolve(root, ref.path)
    }

    const {config: aws} = readProofAwsConfig(stage)
    assertTopologyUsesSharedArtifactStore(aws.artifactStore, sharedArtifactStoreFromDogeConfig(config), 'proof AWS')
    fs.copyFileSync(selected.path, path.join(stage, 'dogeos-proof-release-v1.json'))
    const {images} = selected.manifest
    let real: Parameters<typeof prepareProofMaterials>[0] | undefined
    if (request.generation === 'real') {
      const prepared = (options.prepareReal ?? prepareRealProofRelease)({deploymentDir: stage, output: '.data/preparation', protocolContext: '.data/protocol_context.json', release: 'dogeos-proof-release-v1.json', releaseSha256: selected.sha256})
      const preparation = readProofReleasePreparation(prepared.preparationReceipt)
      const identities = parseProofIdentityEnv(fs.readFileSync(preparation.files.identityEnv.path, 'utf8'))
      checkProofWorkerImage({expectedBatchAggregationProgramCommitmentRaw: identities.DOGEOS_BATCH_AGGREGATION_PROGRAM_COMMITMENT_RAW, expectedBatchProgramCommitmentRaw: identities.DOGEOS_BATCH_PROGRAM_COMMITMENT_RAW, expectedCoreRevision: selected.manifest.source.revision, image: parseImmutableProofImage(images.productionWorker.reference, 'production Worker'), output: path.join(stage, '.data/proof-worker-image-check-v1.json')})
      real = {
        batchMaterializer: preparation.files.batchMaterializer.path, bridgeArtifactDir: path.dirname(preparation.files.bridge.nativeManifest.path), chunkMaterializer: preparation.files.chunkMaterializer.path,
        deploymentDir: stage,
        generation: 'real',
        identityEnv: preparation.files.identityEnv.path, images: {mockWorker: parseImmutableProofImage(images.mockWorker.reference, 'mock Worker'), productionWorker: parseImmutableProofImage(images.productionWorker.reference, 'production Worker'), topologyCompiler: parseImmutableProofImage(images.topologyCompiler.reference, 'compiler')},
        producerManifest: preparation.files.producerManifest.path, protocolContext: path.join(stage, '.data/protocol_context.json'),
        workerIdentityBundle: preparation.files.bridge.workerIdentityBundle.path,
      }
    }

    const materials = prepareProofMaterials(real ?? {deploymentDir: stage, generation: 'mock', images: {mockWorker: parseImmutableProofImage(images.mockWorker.reference, 'mock Worker'), topologyCompiler: parseImmutableProofImage(images.topologyCompiler.reference, 'compiler')}})
    config.proof_topology = buildProofTopology({artifactStore: {bucket: aws.artifactStore.bucket, endpointUrl: proofArtifactS3Endpoint(aws.artifactStore.region), forcePathStyle: false, kind: 's3_compatible', region: aws.artifactStore.region}, deploymentName: request.deploymentName, enforcement: request.enforcement, generation: request.generation, materials: materials.receipt, mode: request.mode, runtime: {...runtime, artifactKeyPrefix: aws.artifactStore.keyPrefix, publicS3EndpointUrl: aws.artifactReadTransport.publicEndpointUrl}})
    fs.writeFileSync(configPath, dogeConfigToToml(config))
    const cubeFile = path.join(stage, 'values/cubesigner-signer-production.yaml')
    if (fs.existsSync(cubeFile)) {
      const values = yaml.load(fs.readFileSync(cubeFile, 'utf8')) as Record<string, unknown>
      const env = cubesignerPolicyEnvironment(policy)
      const current = (values.env ?? []) as Array<{name: string}>
      values.env = [...current.filter(item => !Object.hasOwn(env, item.name)), ...Object.entries(env).map(([name, value]) => ({name, value}))]
      const live = cubesignerLiveEvidenceProjection(policy)
      values.configMaps = {...values.configMaps as object, ...live.configMaps}
      values.persistence = {...values.persistence as object, ...live.persistence}
      fs.writeFileSync(cubeFile, yaml.dump(values, {lineWidth: -1, noRefs: true}))
    }

    // Pin the coordinator image that owns the receipt-verified materializers.
    const pcFile = path.join(stage, 'values/proof-coordinator-production.yaml')
    const pcValues = yaml.load(fs.readFileSync(pcFile, 'utf8')) as Record<string, unknown>
    pcValues.image = {...pcValues.image as object, ...parseImmutableProofImage(images.coordinator.reference, 'coordinator'), tag: ''}
    fs.writeFileSync(pcFile, yaml.dump(pcValues, {lineWidth: -1, noRefs: true}))
    const intent = resolveProofIntent({deploymentDir: stage, dogeConfig: config, dogeConfigPath: configPath, required: true})!
    reconcileProofKubernetes({deploymentDir: stage, ethereumDaBlobSource: proofTopologyEthereumDaBlobSource(config.ethereumDa), ethereumL1RpcUrl: config.ethereumDa?.submitterRpcUrl, intent, materialsReceipt: request.generation === 'real' ? '.data/proof-materials-v1.json' : undefined, proofTopologyBridge: {dogecoinNetwork: config.network, dogecoinRpcPassword: String(config.dogecoinClusterRpc?.password ?? ''), dogecoinRpcUrl: resolveDogecoinServiceRpcUrl(config), dogecoinRpcUser: String(config.dogecoinClusterRpc?.username ?? '')}})
    const contract = validateProofDeploymentContract(stage)
    validateProofTopologyBundle(path.join(stage, contract.topology.bundleDir), {preflightOnly: false})
    if (config.attestationSigner?.mode === 'external') {
      const tsoUrl = request.tsoUrl ?? deriveTsoUrl(path.join(root, 'config.toml'))?.value
      if (!tsoUrl) throw new Error('External signer handoff requires request.tsoUrl or config.toml [ingress].TSO_HOST')
      writeSignerPolicyHandoff({config, deploymentDir: stage, output: 'signer-policy-bundle', protocolContext: '.data/protocol_context.json', tsoUrl})
    }

    let publicationPlan: ProofProgramPublicationPlan | undefined
    if (request.generation === 'real' && request.mode === 'active') {
      publicationPlan = portablePlan(planProofProgramPublication({deploymentDir: stage, materialsReceipt: '.data/proof-materials-v1.json', proofAwsConfig: '.data/proof-aws.json', release: 'dogeos-proof-release-v1.json', releaseSha256: selected.sha256, topologyBundle: contract.topology.bundleDir}), stage)
      fs.renameSync(path.join(stage, '.data/proof-deployment.json'), path.join(stage, PREPARED_CONTRACT))
    }

    // Preparation handoff paths are local absolute paths. Only this known receipt
    // needs rebasing; opaque native programs and compiler files remain verbatim.
    const handoff = path.join(stage, '.data/preparation/proof-release-preparation-v1.json')
    if (fs.existsSync(handoff)) fs.writeFileSync(handoff, fs.readFileSync(handoff, 'utf8').replaceAll(JSON.stringify(stage).slice(1, -1), JSON.stringify(target).slice(1, -1)))
    const readiness = proofEnforcementReadiness(stage, contract, config)
    const warnings = [...policy.warnings, ...readiness.blockers.map(blocker => `Enforcement pending: ${blocker}`)]
    const receipt = {contract: publicationPlan ? PREPARED_CONTRACT : '.data/proof-deployment.json',createdAt: new Date().toISOString(), releaseSha256: selected.sha256, request, schema: 'scrollsdk/proof-config-prepared/v1', warnings, ...(publicationPlan ? {publicationPlan, publicationPlanSha256: hash(publicationPlan)} : {}), files: snapshot(stage)}
    jsonWrite(path.join(stage, PREPARED), receipt)
    if (proofFileHash(selected.path) !== selected.sha256) throw new Error('Selected release changed during preparation')
    for (const [source, expected] of inputs) {
      if (proofFileHash(proofRegularFile(source)) !== expected) throw new Error(`Deployment input changed during preparation: ${source}`)
    }

    fs.renameSync(stage, target)
    return {directory: target, publicationPlan, receipt: path.join(target, PREPARED), receiptSha256: proofFileHash(path.join(target, PREPARED)), warnings}
  } finally {
    fs.rmSync(stage, {force: true, recursive: true})
    fs.rmdirSync(lock)
  }
}

export async function publishProofConfig(options: {apply: boolean; awsProfile?: string; receipt: string; receiptSha256: string}): Promise<unknown> {
  const file = proofRegularFile(options.receipt)
  if (proofFileHash(file) !== options.receiptSha256.replace(/^sha256:/, '')) throw new Error('Prepared receipt digest mismatch')
  const root = path.dirname(file)
  const prepared = JSON.parse(fs.readFileSync(file, 'utf8')) as {contract: string; files: ReturnType<typeof snapshot>; publicationPlan: ProofProgramPublicationPlan; publicationPlanSha256: string; releaseSha256: string; schema: string}
  if (prepared.schema !== 'scrollsdk/proof-config-prepared/v1' || !prepared.publicationPlan) throw new Error('Receipt has no real-program publication plan')
  for (const [relative, expected] of Object.entries(prepared.files)) {
    const resolved = path.resolve(root, relative)
    if (!resolved.startsWith(root + path.sep) || proofFileHash(proofRegularFile(resolved)) !== expected.sha256 || fs.statSync(resolved).size !== expected.sizeBytes) throw new Error(`Prepared input changed: ${relative}`)
  }

  const contract = validateProofDeploymentContract(root, prepared.contract)
  const common = {deploymentDir: root, materialsReceipt: '.data/proof-materials-v1.json', proofAwsConfig: '.data/proof-aws.json', release: 'dogeos-proof-release-v1.json', releaseSha256: prepared.releaseSha256, topologyBundle: contract.topology.bundleDir}
  const plan = portablePlan(planProofProgramPublication(common), root)
  if (hash(plan) !== prepared.publicationPlanSha256 || hash(prepared.publicationPlan) !== prepared.publicationPlanSha256) throw new Error('Publication plan changed after preparation')
  if (!options.apply) return {apply: false, publicationPlan: plan}
  const lock = path.join(root, '.proof-config-publish-lock')
  fs.mkdirSync(lock, {mode: 0o700})
  try {
    if (fs.existsSync(path.join(root, '.data/proof-deployment.json')) || fs.existsSync(path.join(root, '.data/proof-program-publication-v1.json'))) throw new Error('Prepared configuration was already published or has a publication receipt; refusing repeated mutation')
    const config = toml.parse(fs.readFileSync(path.join(root, contract.intentSource.path), 'utf8')) as unknown as DogeConfig
    const before = proofEnforcementReadiness(root, contract, config)
    const pending = before.blockers.filter(item => item !== 'Program-publication receipt is not bound to the deployment contract')
    if (contract.enforcement === 'enforce' && pending.length > 0) throw new Error(`Enforcement evidence is incomplete before publication: ${pending.join('; ')}`)
    const expectedPlan = {...prepared.publicationPlan, files: prepared.publicationPlan.files.map(item => ({...item, source: path.resolve(root, item.source)}))}
    const publication = await publishProofProgramBundle({...common, awsProfile: options.awsProfile, expectedPlan, output: '.data/proof-program-publication-v1.json'})
    const stable = {...contract, inputs: {...contract.inputs!, publication: {path: '.data/proof-program-publication-v1.json', sha256: proofFileHash(publication.receiptPath)}}} as Partial<typeof contract>
    delete stable.generatedAt
    delete stable.generationId
    const final = {...stable, generatedAt: new Date().toISOString(), generationId: hash(stable)} as ProofDeploymentContract
    // S3 is content-addressed and may already contain this bundle after a failed
    // readback. Activate nothing if local generation inputs drifted during upload.
    for (const [relative, expected] of Object.entries(prepared.files)) {
      if (proofFileHash(proofRegularFile(path.join(root, relative))) !== expected.sha256) throw new Error(`Published but local input changed: ${relative}`)
    }

    const readiness = proofEnforcementReadiness(root, final, config)
    if (contract.enforcement === 'enforce' && !readiness.ready) throw new Error(`Published but final enforcement checks failed: ${readiness.blockers.join('; ')}`)
    validateProofDeploymentContract(root, prepared.contract)
    jsonWrite(path.join(root, '.data/proof-deployment.json'), final)
    return {apply: true, contract: path.join(root, '.data/proof-deployment.json'), enforcementReadiness: readiness, publication: publication.receiptPath}
  } finally { fs.rmdirSync(lock) }
}
