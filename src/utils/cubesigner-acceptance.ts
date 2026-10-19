import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'

import {requirePolicy} from './cubesigner-governance.js'
import {cubesignerLiveEvidenceProjection, cubesignerPolicyEnvironment, resolveCubesignerPolicy} from './cubesigner-policy-receipts.js'
import {localPath, privateWrite} from './preparation-io.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'

/** A reviewed exercise report is evidence, not a test that this CLI performed. */
export function validateLiveAcceptance(report: Record<string, unknown>, artifactDigest: string, baseUrl?: string): void {
  requirePolicy(report.schema === 'scrollsdk/cubesigner-live-acceptance/v1' && report.result === 'passed'
    && report.realProofSigned === true && report.tamperedProofDeniedBeforeNativeSigning === true && report.artifactStoreReadback === true
    && report.wpTransport === 'bridge_proof_ref_v1' && report.gatewayMode === 'production_verifier_key_policy'
    && report.policyArtifactDigest === artifactDigest, 'Real signing and denial acceptance evidence is incomplete')
  if (baseUrl) requirePolicy(typeof report.proofArtifactUrl === 'string' && report.proofArtifactUrl.startsWith(baseUrl.replace(/\/$/, '') + '/'), 'Acceptance proof artifact is outside the compiled resolver root')
  requirePolicy(report.scope === undefined || ['canary', 'production'].includes(String(report.scope)), 'Unknown acceptance scope')
  if (report.scope === 'canary') {
    requirePolicy(typeof report.keyId === 'string' && report.keyId.startsWith('Key#') && report.canaryKeyType === 'SecpDogeAddr'
      && report.canaryUnregisteredAndUnfunded === true && report.canaryGovernanceVerified === true
      && typeof report.targetKeyId === 'string' && report.targetKeyId.startsWith('Key#') && report.productionBindingReviewed === true,
    'Canary evidence requires governed unregistered mainnet-type identity and a reviewed production binding')
  }

  requirePolicy(typeof report.proofArtifactUrl === 'string' && new URL(report.proofArtifactUrl).protocol === 'https:'
    && ['proofSha256', 'signingResponseSha256', 'denialResponseSha256'].every(field => /^sha256:[\da-f]{64}$/.test(String(report[field]))), 'Acceptance requires real proof/store and positive/negative response references')
}

/** Late evidence changes only the selected references and signer evidence projection, never genesis or proof materials. */
export function importLiveAcceptance(directory: string, reportPath: string) {
  const root = fs.realpathSync(directory)
  const configFile = localPath(root, '.data/doge-config.toml')
  const config = toml.parse(fs.readFileSync(proofRegularFile(configFile), 'utf8')) as unknown as DogeConfig
  const selection = config.cubesigner
  const refs = selection?.expectedPolicy ?? selection?.policyReceipts
  requirePolicy(selection?.mode === 'production_verifier_key_policy' && refs, 'Prepare production policy inputs first')
  const keys = (selection.roles ?? []).flatMap(role => role.keys.map(key => ({keyId: key.key_id, materialId: key.material_id, roleId: role.role_id})))
  const source = proofRegularFile(path.resolve(root, reportPath), 512 * 1024)
  const report = JSON.parse(fs.readFileSync(source, 'utf8'))
  const resolved = resolveCubesignerPolicy({deploymentDir: root, keys, network: config.network, scope: 'preparation', selection})
  requirePolicy(resolved.policy, 'Prepared production policy is incomplete')
  const release = JSON.parse(fs.readFileSync(proofRegularFile(path.resolve(root, refs.release.path)), 'utf8'))
  validateLiveAcceptance(report, resolved.policy.policyArtifactDigest, release.bindings?.proofArtifactBaseUrl)
  const target = `.scrollsdk/inputs/cubesigner-policy/live-${proofFileHash(source)}.json`
  const old = refs.liveEvidence
  const next = {path: target, sha256: `sha256:${proofFileHash(source)}`}
  requirePolicy(!old || old.sha256.replace(/^sha256:/, '') === proofFileHash(source), 'Different live evidence is already selected; review replacement explicitly')
  privateWrite(localPath(root, target), fs.readFileSync(source))
  refs.liveEvidence = next
  // Validates the exact key, policy and context; invalid evidence cannot change managed configuration.
  const validated = resolveCubesignerPolicy({deploymentDir: root, keys, network: config.network, scope: 'preparation', selection})
  const file = localPath(root, 'values/cubesigner-signer-production.yaml')
  // Existing unrelated values remain intact. No complete chart regeneration is needed.
  const values = yaml.load(fs.readFileSync(proofRegularFile(file), 'utf8')) as Record<string, any>
  const env = cubesignerPolicyEnvironment(validated)
  const fields = ['DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_LIVE_EVIDENCE_REPORT_PATH', 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_LIVE_EVIDENCE_REPORT_DIGEST']
  requirePolicy(Array.isArray(values.env) && fields.every(name => values.env.filter((entry: {name: string}) => entry.name === name).length === 1), 'Signer evidence env entries are missing or duplicated')
  values.env = values.env.map((entry: {name: string}) => fields.includes(entry.name) ? {name: entry.name, value: env[entry.name]} : entry)
  const projection = cubesignerLiveEvidenceProjection(validated)
  values.configMaps = {...values.configMaps, ...projection.configMaps}
  values.persistence = {...values.persistence, ...projection.persistence}
  // Either interrupted write leaves activation closed; retrying the same report completes both.
  privateWrite(configFile, toml.stringify(config as unknown as toml.JsonMap))
  privateWrite(file, yaml.dump(values, {lineWidth: -1}))
  return {activation: 'pending-fresh-verification', evidence: next, installed: 'not-verified', limitation: 'The CLI validated report bindings; the controlled signing exercise remains external evidence.',
    nextCommand: 'scrollsdk setup cubesigner-policy verify-activation --dir .', status: 'reviewed-acceptance-imported'}
}
