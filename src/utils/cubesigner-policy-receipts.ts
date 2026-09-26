import fs from 'node:fs'
import path from 'node:path'

import type {CubesignerProductionPolicy} from '../types/doge-config.js'

import {proofFileHash, proofRegularFile} from './proof-software-release.js'

export type CubesignerPolicyMode = 'production_verifier_key_policy' | 'transport_only'
export interface PolicyReceiptReference {path: string; sha256: string}
export interface CubesignerPolicyReceiptInputs {
  attachment: PolicyReceiptReference
  environment: string
  liveEvidence?: PolicyReceiptReference
  organization: string
  protocolContext: PolicyReceiptReference
  release: PolicyReceiptReference
}
export interface CubesignerPolicySelection {
  mode?: CubesignerPolicyMode
  policyReceipts?: CubesignerPolicyReceiptInputs
  productionPolicy?: CubesignerProductionPolicy
}
type ObjectValue = Record<string, unknown>
const REQUEST_CONTRACT = 'dogeos-cubesigner-compact-psbt-bridge-proof-ref-v1-sign-all-scripts-false-unprefixed-hex-explain-v3'
const SDK_VERSION = '0.4.281'
export const LIVE_POLICY_EVIDENCE_PATH = '/app/proof-policy/live-evidence.json'

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as ObjectValue
}

function string(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || (pattern && !pattern.test(value))) throw new Error(`Invalid ${label}`)
  return value
}

function digest(value: unknown, label: string): string {return string(value, label, /^sha256:[\da-f]{64}$/)}
function timestamp(value: unknown, label: string): void {
  if (!Number.isFinite(Date.parse(string(value, label))) || Date.parse(String(value)) > Date.now() + 300_000) throw new Error(`Invalid ${label}`)
}

function readFile(root: string, reference: PolicyReceiptReference, maxBytes: number): string {
  if (!reference || !/^(sha256:)?[\da-f]{64}$/.test(reference.sha256)) throw new Error('Policy input requires a pinned SHA-256')
  const file = proofRegularFile(path.resolve(root, reference.path), maxBytes)
  if (proofFileHash(file) !== reference.sha256.replace(/^sha256:/, '')) throw new Error(`Policy input digest mismatch: ${reference.path}`)
  return file
}

function receipt(root: string, reference: PolicyReceiptReference, schema: string): {file: string; value: ObjectValue} {
  const file = readFile(root, reference, 4 * 1024 * 1024)
  const value = object(JSON.parse(fs.readFileSync(file, 'utf8')), schema)
  if (value.schema !== schema) throw new Error(`Unsupported ${schema} receipt`)
  timestamp(value.createdAt, `${schema}.createdAt`)
  return {file, value}
}

/** Import provider readback evidence only. This function never attaches a policy. */
export function resolveCubesignerPolicy(input: {
  deploymentDir?: string
  keys: Array<{keyId: string; materialId: string; roleId: string}>
  network: string
  selection?: CubesignerPolicySelection
}): {liveEvidence?: string; mode: CubesignerPolicyMode; policy?: CubesignerProductionPolicy; warnings: string[]} {
  const {selection} = input
  const mode = selection?.mode
  if (!mode) {
    if (selection?.productionPolicy?.liveEvidenceReportPath) throw new Error('Legacy live evidence has no verified mount; import receipt-backed liveEvidence before generating values')
    // One-release migration behavior retains the fail-closed runtime default.
    // Enforcement readiness rejects this legacy path; no transport downgrade.
    return {mode: 'production_verifier_key_policy', policy: selection?.productionPolicy, warnings: ['CubeSigner mode is implicit legacy configuration; select an explicit mode and import policy receipts before enforcement']}
  }

  if (!['production_verifier_key_policy', 'transport_only'].includes(mode)) throw new Error('Unsupported CubeSigner policy mode')
  const root = path.resolve(input.deploymentDir ?? '.')
  const refs = selection?.policyReceipts
  if (mode === 'transport_only') {
    if (input.network === 'mainnet') throw new Error('CubeSigner transport_only is forbidden on mainnet')
    const warnings = ['CubeSigner transport_only is not production-ready and cannot satisfy proof enforcement']
    if (refs?.attachment) {
      const attached = receipt(root, refs.attachment, 'dogeos/cubesigner-policy-attachment/v1').value
      if (attached.policyIdentifier) warnings.push('The key has a hosted policy attached; transport_only does not bypass that policy')
    }

    return {mode, warnings}
  }

  if (!refs) throw new Error('Explicit production_verifier_key_policy requires release and attachment receipts')
  if (selection?.productionPolicy) throw new Error('Receipt-backed policy conflicts with manually transcribed productionPolicy')
  if (input.keys.length !== 1) throw new Error('Policy attachment requires the exact singleton CubeSigner key and role')
  const key = input.keys[0]
  const release = receipt(root, refs.release, 'dogeos/cubesigner-policy-release/v1')
  const attachment = receipt(root, refs.attachment, 'dogeos/cubesigner-policy-attachment/v1').value
  const r = release.value
  string(r.coreRevision, 'policy core revision', /^[\da-f]{40}$/)
  const identifier = string(r.policyIdentifier, 'immutable policy identifier', /^[\da-z][\d._a-z-]{2,63}\/v[1-9]\d{0,8}$/)
  if (r.sdkVersion !== SDK_VERSION || r.requestContract !== REQUEST_CONTRACT) throw new Error('Policy SDK/request contract mismatch')
  const authority = string(r.proofResolverAuthority, 'proof resolver authority')
  const url = new URL(authority)
  if (url.protocol !== 'https:' || url.origin !== authority || url.username || url.password) throw new Error('Policy resolver must be an HTTPS authority')
  const wasm = object(r.wasm, 'policy Wasm')
  const artifactDigest = digest(wasm.sha256, 'policy artifact digest')
  const wasmFile = readFile(path.dirname(release.file), {path: string(wasm.path, 'Wasm path'), sha256: artifactDigest}, 128 * 1024 * 1024)
  if (wasm.sizeBytes !== fs.statSync(wasmFile).size) throw new Error('Policy Wasm size mismatch')
  if (!fs.readFileSync(wasmFile).subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) throw new Error('Policy artifact is not Wasm')
  const context = readFile(root, refs.protocolContext, 4 * 1024 * 1024)
  if (digest(r.protocolContextSha256, 'policy protocol digest') !== `sha256:${proofFileHash(context)}`) throw new Error('Policy release belongs to a different protocol context')
  const tests = object(r.tests, 'policy tests')
  if (tests.result !== 'passed') throw new Error('Policy release tests did not pass')
  readFile(path.dirname(release.file), {path: string(tests.path, 'policy tests path'), sha256: digest(tests.sha256, 'policy tests digest')}, 16 * 1024 * 1024)
  const bindings = {environment: string(refs.environment, 'CubeSigner environment'), organization: string(refs.organization, 'CubeSigner organization'), ...key, policyArtifactDigest: artifactDigest, policyIdentifier: identifier, proofResolverAuthority: authority, releaseSha256: `sha256:${proofFileHash(release.file)}`}
  for (const [field, expected] of Object.entries(bindings)) {
    if (attachment[field] !== expected) throw new Error(`Policy attachment ${field} does not match selected release/key`)
  }

  if (attachment.readback !== 'verified' || attachment.c2fEgressAuthority !== authority) throw new Error('Policy attachment lacks matching provider readback/C2F egress')
  const policy: CubesignerProductionPolicy = {
    policyArtifactDigest: artifactDigest, policyIdentifier: identifier, programIdentityDigest: digest(r.programIdentityDigest, 'program identity digest'),
    proofResolverAuthority: authority,
    verifierIdentityDigest: digest(r.verifierIdentityDigest, 'verifier identity digest'),
  }
  const provenance = object(r.verifierProvenance, 'verifier provenance')
  digest(provenance.bridgeProgramSha256, 'BridgeState program provenance')
  digest(provenance.aggregateVerifyingKeySha256, 'aggregate VK provenance')
  let liveEvidence: string | undefined
  if (r.requiresLiveEvidence === true || refs.liveEvidence) {
    if (!refs.liveEvidence) throw new Error('Selected policy requires live evidence')
    liveEvidence = readFile(root, refs.liveEvidence, 512 * 1024)
    const report = object(JSON.parse(fs.readFileSync(liveEvidence, 'utf8')), 'live evidence')
    if (report.result !== 'passed' || report.policyIdentifier !== identifier || report.keyId !== key.keyId || report.protocolContextSha256 !== r.protocolContextSha256) throw new Error('Live evidence does not bind the selected policy, key and context')
    policy.liveEvidenceReportDigest = `sha256:${proofFileHash(liveEvidence)}`
    policy.liveEvidenceReportPath = LIVE_POLICY_EVIDENCE_PATH
  }

  return {liveEvidence, mode, policy, warnings: []}
}

export function cubesignerPolicyEnvironment(resolved: ReturnType<typeof resolveCubesignerPolicy>): Record<string, string> {
  const p = resolved.policy
  return {
    DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_ARTIFACT_DIGEST: p?.policyArtifactDigest ?? '',
    DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_IDENTIFIER: p?.policyIdentifier ?? '',
    DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_LIVE_EVIDENCE_REPORT_DIGEST: p?.liveEvidenceReportDigest ?? '',
    DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_LIVE_EVIDENCE_REPORT_PATH: p?.liveEvidenceReportPath ?? '',
    DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_MODE: resolved.mode,
    DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_PROGRAM_IDENTITY_DIGEST: p?.programIdentityDigest ?? '',
    DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_PROOF_RESOLVER_AUTHORITY: p?.proofResolverAuthority ?? '',
    DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_VERIFIER_IDENTITY_DIGEST: p?.verifierIdentityDigest ?? '',
  }
}

export function cubesignerLiveEvidenceProjection(resolved: ReturnType<typeof resolveCubesignerPolicy>): {
  configMaps: Record<string, unknown>; persistence: Record<string, unknown>
} {
  if (!resolved.liveEvidence) return {configMaps: {}, persistence: {}}
  return {
    configMaps: {'proof-policy-live-evidence': {data: {'live-evidence.json': fs.readFileSync(resolved.liveEvidence, 'utf8')}, enabled: true}},
    persistence: {'proof-policy-live-evidence': {enabled: true, mountPath: LIVE_POLICY_EVIDENCE_PATH, name: 'proof-policy-live-evidence', readOnly: true, subPath: 'live-evidence.json', type: 'configMap'}},
  }
}
