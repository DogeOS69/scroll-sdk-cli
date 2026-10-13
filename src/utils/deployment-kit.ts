import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'

import {normalizeExternalHttpBaseUrl} from './attestation-signer-descriptor.js'
import {resolveContractFile, validateProofDeploymentContract} from './proof-deployment-contract.js'
import {readProofMaterials} from './proof-materials.js'
import {normalizeSignerProofArtifactBaseUrl} from './proof-signer-policy-input.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'
import {protocolOpeningId} from './protocol-opening-id.js'
import {ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE, renderSignerPolicyEnv} from './signer-policy-bundle.js'
import {protocolIdSidecarPath} from './signer-policy-derivation.js'

export const DEPLOYMENT_KIT_SCHEMA = 'dogeos/deployment-kit/v1'
export const DEPLOYMENT_KIT_MANIFEST_SCHEMA = 'dogeos/deployment-kit-manifest/v1'
export const DEPLOYMENT_KIT_MANIFEST_FILE = 'deployment-kit-manifest.json'
const KIT_VERSION = /^[\dA-Za-z][\w.-]{0,63}$/

export interface DeploymentKitRecord {
  kitDir: string
  kitVersion: string
  /** sha256 of deployment-kit-manifest.json: the kit identity published on the deployment record. */
  manifestSha256: string
  network: string
  protocolInstanceId: string
}

/**
 * Export the bridge-owned, reusable deployment kit for signer operators from
 * the selected deployment contract and its verified proof-materials record.
 * It carries no signer roster, current Bridge key or rotation material, and
 * an existing output directory is never overwritten.
 */
export function writeDeploymentKit(options: {
  config: DogeConfig; contractPath?: string; deploymentDir: string; kitVersion: string; output: string; protocolContext: string; signerProofArtifactBaseUrl?: string; tsoUrl: string
}): DeploymentKitRecord {
  const root = path.resolve(options.deploymentDir)
  if (!KIT_VERSION.test(options.kitVersion)) throw new Error('Kit version must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit')
  const contract = validateProofDeploymentContract(root, options.contractPath)
  const {enforcement, generation, mode} = contract
  if (mode !== 'active' || generation !== 'real' || enforcement !== 'enforce') throw new Error(`Deployment kits require an active/real/enforce contract; selected contract is ${mode}/${generation}/${enforcement}`)
  if (!contract.inputs) throw new Error('Selected contract has no bound materials receipt; rerun prep-charts with --proof-materials-receipt')
  const contextPath = path.resolve(root, options.protocolContext)
  const context = proofRegularFile(contextPath)
  const contextHash = proofFileHash(context)
  if (contextHash !== contract.inputs.protocolContext.sha256) throw new Error('Protocol context differs from selected proof deployment contract')
  const protocolInstanceId = `0x${protocolOpeningId(JSON.parse(fs.readFileSync(context, 'utf8')))}`
  const sidecar = protocolIdSidecarPath(contextPath)
  if (fs.existsSync(sidecar) && `0x${fs.readFileSync(sidecar, 'utf8').trim().replace(/^0x/, '').toLowerCase()}` !== protocolInstanceId) throw new Error('Protocol id sidecar differs from the protocol context')
  const tsoUrl = normalizeExternalHttpBaseUrl(options.tsoUrl, 'TSO URL', {remoteNetwork: 'signer operator network'})
  const artifact = options.signerProofArtifactBaseUrl ?? contract.proofArtifactBaseUrl
  if (!artifact) throw new Error('Selected proof contract has no signer artifact URL')
  const signerProofArtifactBaseUrl = normalizeSignerProofArtifactBaseUrl(artifact)
  const materials = readProofMaterials(resolveContractFile(root, contract.inputs.materials.path), root)
  if (!materials.software.artifacts) throw new Error('Deployment kit requires full real proof materials')
  const vk = proofRegularFile(path.resolve(root, materials.software.artifacts.aggregateVerifyingKey.path))
  const batch = materials.software.identities.batch.appCommitRaw
  const aggregation = materials.software.identities.l2Range.appCommitRaw
  if (!/^0x[\da-f]{128}$/.test(batch) || !/^0x[\da-f]{128}$/.test(aggregation)) throw new Error('Selected verifier commitments are malformed')
  const advanceL2Verifier = {aggVerifyingKeyFile: ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE, aggVerifyingKeySha256: `sha256:${proofFileHash(vk)}`, batchProgramCommitmentHex: batch, l2RangeAggregationProgramCommitmentHex: aggregation}
  const {network} = options.config

  const target = path.resolve(root, options.output)
  if (fs.existsSync(target)) throw new Error('Deployment kit output already exists; kits are never overwritten, select a new kit version')
  fs.mkdirSync(path.dirname(target), {recursive: true})
  if (fs.realpathSync(path.dirname(target)) !== path.dirname(target)) throw new Error('Deployment kit output parent contains a symlink')
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.deployment-kit-'))
  try {
    fs.copyFileSync(context, path.join(stage, 'protocol_context.json'))
    fs.copyFileSync(vk, path.join(stage, ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE))
    const kit = {
      advance_l2_verifier: {agg_verifying_key_file: advanceL2Verifier.aggVerifyingKeyFile, agg_verifying_key_sha256: advanceL2Verifier.aggVerifyingKeySha256, batch_program_commitment_hex: batch, l2_range_aggregation_program_commitment_hex: aggregation},
      // The same origin renderSignerPolicyEnv writes to ATTESTATION_SIGNER_ARTIFACT_ALLOWED_ORIGINS.
      artifact_origins: [new URL(signerProofArtifactBaseUrl).origin],
      deployment: {generation_id: contract.generationId, inputs: contract.inputs, topology_revision: contract.topology.bundleRevision},
      kit_version: options.kitVersion,
      network,
      policy_mode: enforcement,
      protocol_context: {file: 'protocol_context.json', sha256: `sha256:${contextHash}`},
      protocol_instance_id: protocolInstanceId,
      schema: DEPLOYMENT_KIT_SCHEMA,
      tso_url: tsoUrl,
    }
    fs.writeFileSync(path.join(stage, 'deployment-kit.json'), JSON.stringify(kit, null, 2) + '\n')
    fs.writeFileSync(path.join(stage, 'deployment-kit.env'), renderSignerPolicyEnv({advanceL2Verifier, enforcement, generation, mode, network, signerProofArtifactBaseUrl, tsoUrl}))
    const files = fs.readdirSync(stage).sort().map(file => ({file, sha256: `sha256:${proofFileHash(path.join(stage, file))}`, sizeBytes: fs.statSync(path.join(stage, file)).size}))
    fs.writeFileSync(path.join(stage, DEPLOYMENT_KIT_MANIFEST_FILE), JSON.stringify({files, schema: DEPLOYMENT_KIT_MANIFEST_SCHEMA}, null, 2) + '\n')
    const manifestSha256 = proofFileHash(path.join(stage, DEPLOYMENT_KIT_MANIFEST_FILE))
    if (proofFileHash(context) !== contextHash || proofFileHash(vk) !== advanceL2Verifier.aggVerifyingKeySha256.slice('sha256:'.length) || validateProofDeploymentContract(root, options.contractPath).generationId !== contract.generationId) throw new Error('Selected proof inputs changed during deployment kit export')
    fs.renameSync(stage, target)
    return {kitDir: target, kitVersion: options.kitVersion, manifestSha256, network, protocolInstanceId}
  } finally { fs.rmSync(stage, {force: true, recursive: true}) }
}
