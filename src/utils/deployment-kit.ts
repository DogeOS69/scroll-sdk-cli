import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'

import {normalizeExternalHttpBaseUrl} from './attestation-signer-descriptor.js'
import {resolveContractFile, validateProofDeploymentContract} from './proof-deployment-contract.js'
import {readProofMaterials} from './proof-materials.js'
import {normalizeSignerProofArtifactBaseUrl} from './proof-signer-policy-input.js'
import {proofRegularFile} from './proof-software-release.js'
import {protocolOpeningId} from './protocol-opening-id.js'
import {ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE, renderSignerPolicyEnv} from './signer-policy-bundle.js'
import {protocolIdSidecarPath} from './signer-policy-derivation.js'

export const DEPLOYMENT_KIT_SCHEMA = 'dogeos/deployment-kit/v1'
export const DEPLOYMENT_KIT_MANIFEST_SCHEMA = 'dogeos/deployment-kit-manifest/v1'
export const DEPLOYMENT_KIT_MANIFEST_FILE = 'deployment-kit-manifest.json'
const KIT_VERSION = /^[\dA-Za-z][\w.-]{0,63}$/
const sha256 = (body: Buffer | string): string => createHash('sha256').update(body).digest('hex')

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
  // Read each bound file once: the kit carries exactly the bytes that were hashed.
  const contextPath = path.resolve(root, options.protocolContext)
  const context = fs.readFileSync(proofRegularFile(contextPath))
  const contextHash = sha256(context)
  if (contextHash !== contract.inputs.protocolContext.sha256) throw new Error('Protocol context differs from selected proof deployment contract')
  const protocolInstanceId = `0x${protocolOpeningId(JSON.parse(context.toString('utf8')))}`
  const sidecar = protocolIdSidecarPath(contextPath)
  if (fs.existsSync(sidecar) && `0x${fs.readFileSync(sidecar, 'utf8').trim().replace(/^0x/, '').toLowerCase()}` !== protocolInstanceId) throw new Error('Protocol id sidecar differs from the protocol context')
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
  const {network} = options.config

  const target = path.resolve(root, options.output)
  fs.mkdirSync(path.dirname(target), {recursive: true})
  if (fs.realpathSync(path.dirname(target)) !== path.dirname(target)) throw new Error('Deployment kit output parent contains a symlink')
  // Claim the output directory atomically: an existing one, even empty, is never reused.
  try {
    fs.mkdirSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Deployment kit output already exists; kits are never overwritten, select a new kit version')
    throw error
  }

  let complete = false
  try {
    const files: Array<{file: string; sha256: string; sizeBytes: number}> = []
    const write = (file: string, body: Buffer | string) => {
      fs.writeFileSync(path.join(target, file), body, {flag: 'wx'})
      files.push({file, sha256: `sha256:${sha256(body)}`, sizeBytes: Buffer.byteLength(body)})
    }

    write('protocol_context.json', context)
    write(ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE, vk)
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
    write('deployment-kit.json', JSON.stringify(kit, null, 2) + '\n')
    write('deployment-kit.env', renderSignerPolicyEnv({advanceL2Verifier, enforcement, generation, mode, network, signerProofArtifactBaseUrl, tsoUrl}))
    if (validateProofDeploymentContract(root, options.contractPath).generationId !== contract.generationId) throw new Error('Selected proof inputs changed during deployment kit export')
    // The manifest is written last, so an interrupted export never leaves a complete-looking kit.
    const manifest = JSON.stringify({files: files.sort((a, b) => (a.file < b.file ? -1 : 1)), schema: DEPLOYMENT_KIT_MANIFEST_SCHEMA}, null, 2) + '\n'
    write(DEPLOYMENT_KIT_MANIFEST_FILE, manifest)
    complete = true
    return {kitDir: target, kitVersion: options.kitVersion, manifestSha256: sha256(manifest), network, protocolInstanceId}
  } finally {
    if (!complete) fs.rmSync(target, {force: true, recursive: true})
  }
}
