import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'

import {normalizeExternalHttpBaseUrl} from './attestation-signer-descriptor.js'
import {resolveDogecoinChainId} from './deployment-spec-generator.js'
import {type ProofDeploymentContract, resolveContractFile, validateProofDeploymentContract} from './proof-deployment-contract.js'
import {readProofMaterials} from './proof-materials.js'
import {normalizeSignerProofArtifactBaseUrl} from './proof-signer-policy-input.js'
import {proofRegularFile} from './proof-software-release.js'
import {protocolOpeningId} from './protocol-opening-id.js'
import {ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE, renderSignerPolicyEnv} from './signer-policy-bundle.js'
import {protocolIdSidecarPath} from './signer-policy-derivation.js'

export const DEPLOYMENT_KIT_SCHEMA = 'dogeos/deployment-kit/v1'
export const DEPLOYMENT_KIT_MANIFEST_SCHEMA = 'dogeos/deployment-kit-manifest/v1'
export const DEPLOYMENT_KIT_MANIFEST_FILE = 'deployment-kit-manifest.json'
export const DEPLOYMENT_KIT_VERSION = /^k-[\da-f]{12}$/
const sha256 = (body: Buffer | string): string => createHash('sha256').update(body).digest('hex')

/** `deployment-kit-<version>`: the canonical kit directory, directly under the deployment. */
export function deploymentKitDirectory(version: string): string {
  return `deployment-kit-${version}`
}

export interface DeploymentKitRecord {
  kitDir: string
  kitVersion: string
  /** sha256 of deployment-kit-manifest.json: the kit identity published on the deployment record. */
  manifestSha256: string
  network: string
  protocolInstanceId: string
}

/** The kit's exact files (name -> bytes) and identity, built from the deployment inputs without writing. */
export interface DeploymentKitContent {
  files: Map<string, Buffer>
  manifestSha256: string
  network: string
  protocolInstanceId: string
  version: string
}

export interface DeploymentKitInputs {
  config: DogeConfig
  contract: ProofDeploymentContract
  deploymentDir: string
  protocolContext: string
  signerProofArtifactBaseUrl?: string
  tsoUrl: string
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}

/**
 * The protocol instance id of the bound context. The kit names the doge-config
 * network, so the context must be for that network; bridge-init's sidecar,
 * when present, must agree.
 */
function protocolInstanceIdFor(context: Buffer, contextPath: string, network: DogeConfig['network']): string {
  const protocol = JSON.parse(context.toString('utf8'))
  if (protocol?.protocol?.dogecoin_chain_id !== resolveDogecoinChainId(network)) throw new Error(`Protocol context Dogecoin chain id does not match the configured network ${network}`)
  const protocolInstanceId = `0x${protocolOpeningId(protocol)}`
  const sidecar = protocolIdSidecarPath(contextPath)
  if (fs.existsSync(sidecar) && `0x${fs.readFileSync(sidecar, 'utf8').trim().replace(/^0x/, '').toLowerCase()}` !== protocolInstanceId) throw new Error('Protocol id sidecar differs from the protocol context')
  return protocolInstanceId
}

/**
 * The deployment kit for signer operators, built from the selected contract and
 * its verified proof-materials record. It carries no signer roster, current
 * Bridge key or rotation material. Its version is derived from the
 * signer-relevant fields alone, so the same inputs always give the same kit.
 */
export function deploymentKitContent(options: DeploymentKitInputs): DeploymentKitContent {
  const root = path.resolve(options.deploymentDir)
  const {contract} = options
  const {enforcement, generation, mode} = contract
  if (mode !== 'active' || generation !== 'real' || enforcement !== 'enforce') throw new Error(`Deployment kits require an active/real/enforce contract; selected contract is ${mode}/${generation}/${enforcement}`)
  if (!contract.inputs) throw new Error('Selected contract has no bound materials receipt; rerun prep-charts with --proof-materials-receipt')
  // Read each bound file once: the kit carries exactly the bytes that were hashed.
  const contextPath = path.resolve(root, options.protocolContext)
  const context = fs.readFileSync(proofRegularFile(contextPath))
  const contextHash = sha256(context)
  if (contextHash !== contract.inputs.protocolContext.sha256) throw new Error('Protocol context differs from selected proof deployment contract')
  const {network} = options.config
  const protocolInstanceId = protocolInstanceIdFor(context, contextPath, network)
  const tsoUrl = normalizeExternalHttpBaseUrl(options.tsoUrl, 'TSO URL', {remoteNetwork: 'signer operator network'})
  const artifact = options.signerProofArtifactBaseUrl ?? contract.proofArtifactBaseUrl
  if (!artifact) throw new Error('Selected proof contract has no signer artifact URL')
  const signerProofArtifactBaseUrl = normalizeSignerProofArtifactBaseUrl(artifact)
  const materials = readProofMaterials(resolveContractFile(root, contract.inputs.materials.path), root)
  if (!materials.software.artifacts) throw new Error('Deployment kit requires full real proof materials')
  const vk = fs.readFileSync(proofRegularFile(path.resolve(root, materials.software.artifacts.aggregateVerifyingKey.path)))
  if (sha256(vk) !== materials.software.artifacts.aggregateVerifyingKey.sha256) throw new Error('Aggregate verifying key differs from the selected proof materials')
  const batch = materials.software.identities.batch.appCommitRaw
  const aggregation = materials.software.identities.l2Range.appCommitRaw
  if (!/^0x[\da-f]{128}$/.test(batch) || !/^0x[\da-f]{128}$/.test(aggregation)) throw new Error('Selected verifier commitments are malformed')
  const advanceL2Verifier = {aggVerifyingKeyFile: ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE, aggVerifyingKeySha256: `sha256:${sha256(vk)}`, batchProgramCommitmentHex: batch, l2RangeAggregationProgramCommitmentHex: aggregation}
  const signerFields = {
    advance_l2_verifier: {agg_verifying_key_file: advanceL2Verifier.aggVerifyingKeyFile, agg_verifying_key_sha256: advanceL2Verifier.aggVerifyingKeySha256, batch_program_commitment_hex: batch, l2_range_aggregation_program_commitment_hex: aggregation},
    // The same origin renderSignerPolicyEnv writes to ATTESTATION_SIGNER_ARTIFACT_ALLOWED_ORIGINS.
    artifact_origins: [new URL(signerProofArtifactBaseUrl).origin],
    network,
    policy_mode: enforcement,
    protocol_context_sha256: `sha256:${contextHash}`,
    protocol_instance_id: protocolInstanceId,
    tso_url: tsoUrl,
  }
  const version = `k-${sha256(canonicalJson(signerFields)).slice(0, 12)}`
  const kit = {
    advance_l2_verifier: signerFields.advance_l2_verifier,
    artifact_origins: signerFields.artifact_origins,
    kit_version: version,
    network,
    policy_mode: enforcement,
    protocol_context: {file: 'protocol_context.json', sha256: signerFields.protocol_context_sha256},
    protocol_instance_id: protocolInstanceId,
    schema: DEPLOYMENT_KIT_SCHEMA,
    tso_url: tsoUrl,
  }
  const files = new Map<string, Buffer>([
    ['deployment-kit.env', Buffer.from(renderSignerPolicyEnv({advanceL2Verifier, enforcement, generation, mode, network, signerProofArtifactBaseUrl, tsoUrl}))],
    ['deployment-kit.json', Buffer.from(JSON.stringify(kit, null, 2) + '\n')],
    ['protocol_context.json', context],
    [ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE, vk],
  ])
  const entries = [...files.keys()].sort().map(file => ({file, sha256: `sha256:${sha256(files.get(file)!)}`, sizeBytes: files.get(file)!.length}))
  const manifest = Buffer.from(JSON.stringify({files: entries, schema: DEPLOYMENT_KIT_MANIFEST_SCHEMA}, null, 2) + '\n')
  files.set(DEPLOYMENT_KIT_MANIFEST_FILE, manifest)
  return {files, manifestSha256: sha256(manifest), network, protocolInstanceId, version}
}

/**
 * Read-only: the directory must hold exactly the kit's files, each a regular
 * file (no symlink in any path component) with byte-identical content.
 */
export function verifyDeploymentKit(directory: string, content: DeploymentKitContent): void {
  const stat = fs.lstatSync(directory, {throwIfNoEntry: false})
  if (!stat?.isDirectory()) throw new Error(`Deployment kit directory is missing: ${directory}`)
  const names = fs.readdirSync(directory).sort()
  if (names.join('\n') !== [...content.files.keys()].sort().join('\n')) throw new Error(`Deployment kit ${directory} does not hold exactly the kit files`)
  for (const [name, body] of content.files) {
    if (!fs.readFileSync(proofRegularFile(path.join(directory, name))).equals(body)) throw new Error(`Deployment kit file differs from the deployment inputs: ${name}`)
  }
}

/**
 * Write the kit into `deployment-kit-<version>` (or `output`). The same inputs
 * give the same kit, so an existing directory with exactly that content is a
 * no-op; any other existing directory is refused and never overwritten.
 */
export function writeDeploymentKit(options: {contractPath?: string; output?: string} & Omit<DeploymentKitInputs, 'contract'>): DeploymentKitRecord {
  const root = path.resolve(options.deploymentDir)
  const contract = validateProofDeploymentContract(root, options.contractPath)
  const content = deploymentKitContent({...options, contract})
  const target = path.resolve(root, options.output ?? deploymentKitDirectory(content.version))
  const record = {kitDir: target, kitVersion: content.version, manifestSha256: content.manifestSha256, network: content.network, protocolInstanceId: content.protocolInstanceId}
  const assertInputsUnchanged = () => {
    if (validateProofDeploymentContract(root, options.contractPath).generationId !== contract.generationId) throw new Error('Selected proof inputs changed during deployment kit export')
  }

  fs.mkdirSync(path.dirname(target), {recursive: true})
  if (fs.realpathSync(path.dirname(target)) !== path.dirname(target)) throw new Error('Deployment kit output parent contains a symlink')
  // Claim the output directory atomically; an existing one must already be this exact kit.
  try {
    fs.mkdirSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    try {verifyDeploymentKit(target, content)} catch {throw new Error(`Deployment kit output ${target} already exists with other content; kits are never overwritten`)}
    assertInputsUnchanged()
    return record
  }

  let complete = false
  try {
    // The manifest is written last, so an interrupted export never leaves a complete-looking kit.
    for (const [name, body] of content.files) if (name !== DEPLOYMENT_KIT_MANIFEST_FILE) fs.writeFileSync(path.join(target, name), body, {flag: 'wx'})
    assertInputsUnchanged()
    fs.writeFileSync(path.join(target, DEPLOYMENT_KIT_MANIFEST_FILE), content.files.get(DEPLOYMENT_KIT_MANIFEST_FILE)!, {flag: 'wx'})
    complete = true
    return record
  } finally {
    if (!complete) fs.rmSync(target, {force: true, recursive: true})
  }
}
