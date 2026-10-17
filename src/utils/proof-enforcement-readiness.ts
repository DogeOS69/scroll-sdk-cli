import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'
import type {ProofProgramPublicationV1} from '../types/proof-program-publication.js'
import type {PolicyReceiptReference} from './cubesigner-policy-receipts.js'
import type {ProofDeploymentContract} from './proof-deployment-contract.js'

import {EXTERNAL_POLICY_INPUT, type ExternalPolicySelection, verifyExternalPolicy} from './cubesigner-policy-import.js'
import {resolveCubesignerPolicy} from './cubesigner-policy-receipts.js'
import {deploymentKitBlockers} from './deployment-kit-record.js'
import {readProofAwsConfig} from './proof-aws-config.js'
import {readProofMaterials} from './proof-materials.js'
import {assertProofPublicationContent} from './proof-program-publication.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'

function pinnedJson(root: string, reference: PolicyReceiptReference): Record<string, unknown> {
  const file = proofRegularFile(path.resolve(root, reference.path), 4 * 1024 * 1024)
  if (!/^(sha256:)?[\da-f]{64}$/.test(reference.sha256) || proofFileHash(file) !== reference.sha256.replace(/^sha256:/, '')) throw new Error(`Evidence digest mismatch: ${reference.path}`)
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid evidence: ${reference.path}`)
  return value
}

/** A deployment-specific policy build can have a different source commit from the proof images. */
function policySourceMatches(root: string, release: Record<string, unknown>, proofRevision: string | undefined): boolean {
  if (release.coreRevision === proofRevision) return true
  const selectionFile = path.resolve(root, EXTERNAL_POLICY_INPUT)
  if (!fs.existsSync(selectionFile)) return false
  const selection = JSON.parse(fs.readFileSync(proofRegularFile(selectionFile, 16 * 1024), 'utf8')) as ExternalPolicySelection
  if (selection.method !== 'external' || selection.expectedCoreRevision !== release.coreRevision) return false
  // Verify the pinned import receipt, script provenance, component bytes and current context.
  // Merely declaring a different revision is not enough. Program/VK/context bindings
  // to the selected proof release are checked separately below.
  const imported = verifyExternalPolicy(root, selection)
  return (release.wasm as {sha256?: unknown} | undefined)?.sha256 === `sha256:${imported.wasmSha256}`
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
      // Runtime topology revisions are not a publication integrity boundary.
      if (publication.schema !== 'scrollsdk/proof-program-publication/v1'
        || publication.coreRevision !== materials.software.sourceRevisions?.dogeosCore) throw new Error('Publication release mismatch')
      if (contract.artifactStoreReceipt) {
        const {config: aws} = readProofAwsConfig(root, contract.artifactStoreReceipt.path)
        const store = publication.artifactStore as Record<string, unknown>
        if (store.bucket !== aws.artifactStore.bucket || store.region !== aws.artifactStore.region || store.keyPrefix !== `${aws.artifactStore.keyPrefix}/proof-programs/${publication.bundleId}`) throw new Error('Publication artifact store differs from selected AWS receipt')
      }

      const verification = publication.verification as Record<string, unknown> | undefined
      if (verification?.anonymousHttpReadback !== 'passed' || verification?.authenticatedS3Readback !== 'passed') throw new Error('Publication readback evidence is incomplete')
      assertProofPublicationContent(root, contract, materials, publication as unknown as ProofProgramPublicationV1)
    } catch (error) { blockers.push(String(error)) }
  }
  else {blockers.push('Program-publication receipt is not bound to the deployment contract')}

  if (!contract.worker.enabled || !materials.images.productionWorker) blockers.push('Production Worker image and Worker contract are required')
  try {
    if (!config.cubesigner?.mode) throw new Error('Select an explicit CubeSigner policy mode')
    resolveCubesignerPolicy({deploymentDir: root, keys: (config.cubesigner.roles ?? []).flatMap(role => role.keys.map(key => ({keyId: key.key_id, materialId: key.material_id, roleId: role.role_id}))), network: config.network, selection: config.cubesigner})
    if (config.cubesigner.mode === 'production_verifier_key_policy') {
      const policyRelease = pinnedJson(root, config.cubesigner.policyReceipts!.release)
      const provenance = policyRelease.verifierProvenance as Record<string, unknown>
      if (!policySourceMatches(root, policyRelease, materials.software.sourceRevisions?.dogeosCore)) throw new Error('CubeSigner policy source differs from the proof release without a matching verified external-build import')
      if (policyRelease.protocolContextSha256 !== `sha256:${bindings.protocolContext.sha256}`
        || provenance.bridgeProgramSha256 !== `sha256:${materials.bridge?.artifacts.appExe.sha256}`
        || provenance.aggregateVerifyingKeySha256 !== `sha256:${materials.software.artifacts?.aggregateVerifyingKey.sha256}`) throw new Error('CubeSigner policy does not bind selected proof release/program/VK/context')
    }
  } catch (error) { blockers.push(`CubeSigner: ${String(error)}`) }

  blockers.push(...deploymentKitBlockers(root, contract, config))
  return {blockers, ready: blockers.length === 0}
}
