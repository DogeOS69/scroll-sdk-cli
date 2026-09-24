import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'
import type {PolicyReceiptReference} from './cubesigner-policy-receipts.js'
import type {ProofDeploymentContract} from './proof-deployment-contract.js'

import {resolveCubesignerPolicy} from './cubesigner-policy-receipts.js'
import {readProofAwsConfig} from './proof-aws-config.js'
import {readProofMaterials} from './proof-materials.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'

export interface SignerValidationInputs {
  bundleManifest: PolicyReceiptReference
  receipts: PolicyReceiptReference[]
}

function pinnedJson(root: string, reference: PolicyReceiptReference): Record<string, unknown> {
  const file = proofRegularFile(path.resolve(root, reference.path), 4 * 1024 * 1024)
  if (!/^(sha256:)?[\da-f]{64}$/.test(reference.sha256) || proofFileHash(file) !== reference.sha256.replace(/^sha256:/, '')) throw new Error(`Evidence digest mismatch: ${reference.path}`)
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid evidence: ${reference.path}`)
  return value
}

/** Read-only evidence gate; missing provider/signer evidence is never fabricated. */
export function proofEnforcementReadiness(root: string, contract: ProofDeploymentContract, config: DogeConfig): {blockers: string[]; ready: boolean} {
  const blockers: string[] = []
  if (contract.mode !== 'active' || contract.generation !== 'real') return {blockers: ['Enforcement requires active real proving'], ready: false}
  const bindings = contract.inputs
  if (!bindings) return {blockers: ['Deployment contract has no selected materials/protocol receipts; rerun prep-charts with --proof-materials-receipt'], ready: false}
  const materials = readProofMaterials(path.resolve(root, bindings.materials.path), root)
  if (!materials.bridge || !materials.software.artifacts) blockers.push('Full real proof materials and protocol-bound Bridge bake are required')
  if (!contract.artifactStoreReceipt) blockers.push('Artifact-store receipt is not bound to the deployment contract')
  if (bindings.publication) {
    try {
      const publication = pinnedJson(root, bindings.publication)
      if (publication.schema !== 'scrollsdk/proof-program-publication/v1'
        || publication.proofTopologyBundleRevision !== contract.topology.bundleRevision
        || publication.coreRevision !== materials.software.sourceRevisions?.dogeosCore) throw new Error('Publication release/topology mismatch')
      if (contract.artifactStoreReceipt) {
        const {config: aws} = readProofAwsConfig(root, contract.artifactStoreReceipt.path)
        const store = publication.artifactStore as Record<string, unknown>
        if (store.bucket !== aws.artifactStore.bucket || store.region !== aws.artifactStore.region || store.keyPrefix !== `${aws.artifactStore.keyPrefix}/proof-programs/${publication.bundleId}`) throw new Error('Publication artifact store differs from selected AWS receipt')
      }

      const verification = publication.verification as Record<string, unknown> | undefined
      if (verification?.anonymousHttpReadback !== 'passed' || verification?.authenticatedS3Readback !== 'passed') throw new Error('Publication readback evidence is incomplete')
    } catch (error) { blockers.push(String(error)) }
  }
  else {blockers.push('Program-publication receipt is not bound to the deployment contract')}

  if (!contract.worker.enabled || !materials.images.productionWorker) blockers.push('Production Worker image and Worker contract are required')
  try {
    if (config.cubesigner?.mode !== 'production_verifier_key_policy') throw new Error('Enforcement requires explicit CubeSigner production_verifier_key_policy')
    resolveCubesignerPolicy({deploymentDir: root, keys: (config.cubesigner.roles ?? []).flatMap(role => role.keys.map(key => ({keyId: key.key_id, materialId: key.material_id, roleId: role.role_id}))), network: config.network, selection: config.cubesigner})
    const policyRelease = pinnedJson(root, config.cubesigner.policyReceipts!.release)
    const provenance = policyRelease.verifierProvenance as Record<string, unknown>
    if (policyRelease.coreRevision !== materials.software.sourceRevisions?.dogeosCore
      || policyRelease.protocolContextSha256 !== `sha256:${bindings.protocolContext.sha256}`
      || provenance.bridgeProgramSha256 !== `sha256:${materials.bridge?.artifacts.appExe.sha256}`
      || provenance.aggregateVerifyingKeySha256 !== `sha256:${materials.software.artifacts?.aggregateVerifyingKey.sha256}`) throw new Error('CubeSigner policy does not bind selected proof release/program/VK/context')
  } catch (error) { blockers.push(`CubeSigner: ${String(error)}`) }

  const signers = config.attestationSigner?.external ?? []
  const active = config.attestationSigner?.activeSignerIds ?? []
  const validation = config.attestationSigner?.policyValidation
  if (validation) {
    try {
      const bundle = pinnedJson(root, validation.bundleManifest)
      if (bundle.schema !== 'dogeos/attestation-signer-policy-manifest/v1') throw new Error('Invalid signer bundle manifest')
      const bundleDir = path.dirname(path.resolve(root, validation.bundleManifest.path))
      const files = bundle.files as Array<{file: string; sha256: string; sizeBytes: number}>
      if (!Array.isArray(files) || !files.some(item => item.file === 'signer-policy.json')) throw new Error('Signer bundle manifest has no policy')
      for (const file of files) {
        if (path.basename(file.file) !== file.file) throw new Error('Unsafe signer bundle file path')
        const full = proofRegularFile(path.join(bundleDir, file.file))
        if (`sha256:${proofFileHash(full)}` !== file.sha256 || fs.statSync(full).size !== file.sizeBytes) throw new Error('Signer bundle file drift')
      }

      const policy = JSON.parse(fs.readFileSync(path.join(bundleDir, 'signer-policy.json'), 'utf8'))
      if (policy.protocolContext?.sha256 !== `sha256:${bindings.protocolContext.sha256}` || policy.deployment?.topologyRevision !== contract.topology.bundleRevision || policy.enforcement !== 'enforce') throw new Error('Signer handoff differs from selected enforcing topology/context')
      const receipts = validation.receipts.map(reference => pinnedJson(root, reference))
      if (new Set(receipts.map(item => item.signerId)).size !== receipts.length) throw new Error('Duplicate signer-validation receipt')
      if (active.length === 0 || active.some(id => !signers.some(signer => signer.id === id))) throw new Error('Active signer set is empty or unresolved')
      for (const id of active) {
        const signer = signers.find(item => item.id === id)!
        const receipt = receipts.find(item => item.signerId === id)
        if (!receipt || receipt.schema !== 'dogeos/attestation-signer-policy-validation/v1'
          || receipt.publicKey !== signer.publicKey || receipt.policyMode !== 'enforce'
          || receipt.bundleManifestSha256 !== `sha256:${validation.bundleManifest.sha256.replace(/^sha256:/, '')}`
          || receipt.coreRevision !== materials.software.sourceRevisions?.dogeosCore
          || receipt.result !== 'passed' || !/^sha256:[\da-f]{64}$/.test(String(receipt.redactedConfigSha256))
          || !Number.isFinite(Date.parse(String(receipt.validatedAt))) || Date.parse(String(receipt.validatedAt)) > Date.now() + 300_000) throw new Error(`Missing or mismatched validation receipt for signer ${id}`)
      }
    } catch (error) { blockers.push(`External signer: ${String(error)}`) }
  }
  else {blockers.push('External Attestation Signer policy-validation receipts are missing')}

  return {blockers, ready: blockers.length === 0}
}
