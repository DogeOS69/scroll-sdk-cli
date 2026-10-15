import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'
import type {PolicyReceiptReference} from './cubesigner-policy-receipts.js'
import type {ProofDeploymentContract} from './proof-deployment-contract.js'

import {resolveCubesignerPolicy} from './cubesigner-policy-receipts.js'
import {deploymentKitBlockers} from './deployment-kit-record.js'
import {readProofAwsConfig} from './proof-aws-config.js'
import {readProofMaterials} from './proof-materials.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'

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
      // Runtime topology revisions are not a publication integrity boundary.
      // Content-specific publication comparison is deferred; see docs/spec-preparation.md.
      if (publication.schema !== 'scrollsdk/proof-program-publication/v1'
        || publication.coreRevision !== materials.software.sourceRevisions?.dogeosCore) throw new Error('Publication release mismatch')
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
    if (!config.cubesigner?.mode) throw new Error('Select an explicit CubeSigner policy mode')
    resolveCubesignerPolicy({deploymentDir: root, keys: (config.cubesigner.roles ?? []).flatMap(role => role.keys.map(key => ({keyId: key.key_id, materialId: key.material_id, roleId: role.role_id}))), network: config.network, selection: config.cubesigner})
    if (config.cubesigner.mode === 'production_verifier_key_policy') {
      const policyRelease = pinnedJson(root, config.cubesigner.policyReceipts!.release)
      const provenance = policyRelease.verifierProvenance as Record<string, unknown>
      if (policyRelease.coreRevision !== materials.software.sourceRevisions?.dogeosCore
        || policyRelease.protocolContextSha256 !== `sha256:${bindings.protocolContext.sha256}`
        || provenance.bridgeProgramSha256 !== `sha256:${materials.bridge?.artifacts.appExe.sha256}`
        || provenance.aggregateVerifyingKeySha256 !== `sha256:${materials.software.artifacts?.aggregateVerifyingKey.sha256}`) throw new Error('CubeSigner policy does not bind selected proof release/program/VK/context')
    }
  } catch (error) { blockers.push(`CubeSigner: ${String(error)}`) }

  blockers.push(...deploymentKitBlockers(root, contract, config))
  return {blockers, ready: blockers.length === 0}
}
