/* eslint-disable @typescript-eslint/no-explicit-any -- Operator TOML and Helm values are dynamic documents. */
import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../types/doge-config.js'
import type {RotationEnvelope, RotationProposal} from './bridge-rotation.js'

import {assertRotationSpecUnchanged, canonicalJson, parseBridgeScript, proposalDigest, validateRotationEnvelope} from './bridge-rotation.js'
import {deriveTsoUrl} from './signer-policy-derivation.js'
import {writeSignerPolicyHandoff} from './signer-policy-handoff.js'

function parsePrivateToml(source: string): toml.JsonMap {
  try {return toml.parse(source)} catch {throw new Error('Invalid private deployment TOML; inspect the local file without publishing its contents')}
}

function parsePrivateYaml(source: string): unknown {
  try {return yaml.load(source)} catch {throw new Error('Invalid private Helm values YAML; inspect the local file without publishing its contents')}
}

export function writeRotationFile(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), {mode: 0o700, recursive: true})
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Refusing a symlink rotation file')
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, value, {flag: 'wx', mode: 0o600})
  fs.renameSync(temp, file)
}

export function rotationJson(file: string, value: unknown): void {writeRotationFile(file, `${JSON.stringify(value, null, 2)}\n`)}
export function readRotationJson<T>(file: string): T {return JSON.parse(fs.readFileSync(file, 'utf8')) as T}
export function runtimeDirectory(root: string): string {
  const matches = [root, path.join(root, 'runtime'), path.join(root, 'deployment')].filter(dir => fs.existsSync(path.join(dir, '.data/protocol_context.json')))
  if (matches.length === 0) throw new Error('No runtime deployment found (expected runtime/.data/protocol_context.json or .data/protocol_context.json)')
  return matches[0]
}

export function rotationDirectory(root: string, name: string): string {
  if (!/^[\da-z][\da-z-]{0,62}$/.test(name)) throw new Error('Invalid rotation name')
  return path.join(root, 'rotations', name)
}

export function saveRotationPlan(root: string, envelope: RotationEnvelope, selectedDir?: string): string {
  const p = validateRotationEnvelope(envelope)
  const dir = selectedDir ? path.resolve(root, selectedDir) : rotationDirectory(root, p.name)
  if (fs.existsSync(path.join(dir, 'proposal.json'))) {
    const old = readRotationJson<RotationEnvelope>(path.join(dir, 'proposal.json'))
    if (old.sha256 !== envelope.sha256) throw new Error('Rotation name already contains a different frozen proposal; use a new name')
    validateRotationEnvelope(old)
    return dir
  }

  rotationJson(path.join(dir, 'proposal.json'), envelope)
  writeRotationFile(path.join(dir, 'rotation-policy.toml'), `[rotation_policy]\nallowed_next_bridge_script_hashes = ["${p.target.keyHash}"]\n`)
  const current = parseBridgeScript(p.current.redeemScriptHex)
  writeRotationFile(path.join(dir, 'summary.md'), `# Attestation rotation ${p.name}\n\nProposal SHA-256: ${envelope.sha256}\n\nCurrent bridge: ${p.current.keyHash}\nTarget bridge: ${p.target.keyHash}\nTarget address: ${p.target.address}\n\nCurrent attestation keys: ${current.attestation.keys.join(', ')}\nTarget members: ${p.target.signers.map(s => `${s.name}: ${s.attestationPubkey}`).join(', ')}\nThreshold: ${current.attestation.threshold} -> ${p.target.threshold}\nRecovery height: ${p.timelock.oldHeight} -> ${p.timelock.newHeight} (${p.timelock.policy})\nGrace: ${p.graceWfTxs} WF transactions\n\nNamespace, TEE and ordered recovery keys/threshold are unchanged. Verify the complete scripts in proposal.json independently. This checksum identifies a proposal; it is not an authenticated approval. New operators must retain their own RPC trust policy. Old instances, keys and databases must remain available through overlap.\n`)
  return dir
}

export function loadRotationPlan(root: string, specFile = 'rotation-spec.yaml', selectedDir?: string, checkSpec = true): {dir: string; envelope: RotationEnvelope} {
  const base = selectedDir ? path.resolve(root, selectedDir) : root
  const spec = checkSpec || !selectedDir ? yaml.load(fs.readFileSync(path.resolve(base, specFile), 'utf8')) as {name?: string} : undefined
  const dir = selectedDir ? base : rotationDirectory(root, spec?.name ?? '')
  const envelope = readRotationJson<RotationEnvelope>(path.join(dir, 'proposal.json'))
  validateRotationEnvelope(envelope)
  if (checkSpec) assertRotationSpecUnchanged(spec, envelope)
  return {dir, envelope}
}

export interface RotationStageReceipt {files: Record<string, string>; proposalSha256: string; status: 'applied' | 'prepared'}
function assertCurrentRegistrations(external: NonNullable<NonNullable<DogeConfig['attestationSigner']>['external']>, tsoSigners: any[], p: RotationProposal): void {
  const current = parseBridgeScript(p.current.redeemScriptHex)
  if (!tsoSigners.some((s: any) => s.roles?.length === 1 && s.roles[0] === 'Correctness')) throw new Error('Existing TSO Correctness registration is required and must be retained')
  for (const key of current.attestation.keys) {
    const member = external.find(s => s.publicKey.toLowerCase().replace(/^0x/, '') === key)
    if (!member) throw new Error('Current signer is absent from deployment registry')
    const registrations = tsoSigners.filter((s: any) => s.publicKeyOverride?.toLowerCase().replace(/^0x/, '') === key)
    if (registrations.length !== 1 || registrations[0].transportPubkey !== member.transportPubkey || registrations[0].delivery !== 'pull' || registrations[0].network !== p.network || registrations[0].roles?.length !== 1 || registrations[0].roles[0] !== 'Attestation') throw new Error('Current signer TSO registration is missing or mismatched; reconcile runtime values before staging')
  }

}

export function enableRotationRoute(source: string): string {
  parsePrivateToml(source)
  const firstTable = source.search(/^\s*\[/m)
  const offset = firstTable < 0 ? source.length : firstTable
  const root = source.slice(0, offset)
  const rest = source.slice(offset)
  const assignment = /^(\s*rotate_key_v2\s*=\s*)(?:true|false)([^\n\r]*)$/m
  const updated = assignment.test(root) ? root.replace(assignment, '$1true$2') + rest : `rotate_key_v2 = true\n${source}`
  if (parsePrivateToml(updated).rotate_key_v2 !== true) throw new Error('Unable to enable the native WP rotation route')
  return updated
}

/** Merge by identity, never replace old members or copy signer-owned authorization policy. */
export function mergeRotationRegistrations(config: DogeConfig, values: any, p: RotationProposal): void {
  const registry = config.attestationSigner
  if (registry?.mode !== 'external' || !registry.external?.length || !Array.isArray(values.tsoSigners)) throw new Error('Rotation requires existing external signer registry and TSO registrations')
  assertCurrentRegistrations(registry.external, values.tsoSigners, p)

  for (const signer of p.target.signers) {
    const existing = registry.external.find(s => s.id === signer.name || [s.publicKey, s.transportPubkey].some(key => [signer.attestationPubkey, signer.transportPubkey].includes(key)))
    if (existing && (existing.id !== signer.name || existing.publicKey !== signer.attestationPubkey || existing.transportPubkey !== signer.transportPubkey)) throw new Error('Target identity conflicts with an existing signer registration')
    if (!existing) registry.external.push({id: signer.name, publicKey: signer.attestationPubkey, transportPubkey: signer.transportPubkey})
    const registered = values.tsoSigners.find((s: any) => s.publicKeyOverride === signer.attestationPubkey || s.transportPubkey === signer.transportPubkey)
    if (registered && (registered.publicKeyOverride !== signer.attestationPubkey || registered.transportPubkey !== signer.transportPubkey || registered.delivery !== 'pull' || registered.network !== p.network || !registered.roles?.includes('Attestation'))) throw new Error('Target identity conflicts with TSO registration')
    if (!registered) values.tsoSigners.push({delivery: 'pull', network: p.network, publicKeyOverride: signer.attestationPubkey, roles: ['Attestation'], signatureMode: 'ecdsa', transportPubkey: signer.transportPubkey})
  }

  const native = values.configMaps?.config?.data?.['WithdrawalProcessor.toml']
  if (typeof native !== 'string') throw new Error('Missing compiler-rendered WithdrawalProcessor.toml in values')
  values.configMaps.config.data['WithdrawalProcessor.toml'] = enableRotationRoute(native)
}

export function prepareRotationStage(runtime: string, dir: string, envelope: RotationEnvelope): RotationStageReceipt {
  const p = validateRotationEnvelope(envelope)
  const filenames = ['.data/doge-config.toml', 'values/withdrawal-processor-production.yaml', 'withdrawal-processor/WithdrawalProcessor.toml']
  const config = parsePrivateToml(fs.readFileSync(path.join(runtime, filenames[0]), 'utf8')) as unknown as DogeConfig
  const values = parsePrivateYaml(fs.readFileSync(path.join(runtime, filenames[1]), 'utf8')) as any
  mergeRotationRegistrations(config, values, p)
  const handoff = path.join(dir, 'signer-deployment')
  if (fs.existsSync(handoff)) {
    const reference = readRotationJson<{proposalSha256: string}>(path.join(handoff, 'rotation-reference.json'))
    if (reference.proposalSha256 !== envelope.sha256) throw new Error('Existing handoff belongs to another proposal')
  } else {
    const tsoUrl = deriveTsoUrl(path.join(runtime, 'config.toml'))?.value
    if (!tsoUrl) throw new Error('Missing TSO ingress URL in config.toml')
    const temporary = fs.mkdtempSync(path.join(dir, '.handoff-'))
    try {
      const output = path.join(temporary, 'package')
      writeSignerPolicyHandoff({config, deploymentDir: runtime, output, protocolContext: '.data/protocol_context.json', tsoUrl})
      rotationJson(path.join(output, 'rotation-reference.json'), {currentKeyHash: p.current.keyHash, note: 'The deployment bundle protocol context retains genesis identity. Current/target bridge scripts are in the independently approved rotation proposal. No signer-owned rotation policy is imported.', proposalSha256: envelope.sha256, targetKeyHash: p.target.keyHash})
      fs.renameSync(output, handoff)
    } finally {fs.rmSync(temporary, {force: true, recursive: true})}
  }

  const nativeBase = enableRotationRoute(fs.readFileSync(path.join(runtime, filenames[2]), 'utf8'))
  const next = [toml.stringify(config as unknown as toml.JsonMap), yaml.dump(values, {lineWidth: -1, noRefs: true}), nativeBase]
  const files: Record<string, string> = {}
  filenames.forEach((file, i) => {
    const backup = path.join(dir, 'private-backup', file)
    if (!fs.existsSync(backup)) writeRotationFile(backup, fs.readFileSync(path.join(runtime, file), 'utf8'))
    writeRotationFile(path.join(runtime, file), next[i])
    files[file] = proposalDigest(next[i])
  })
  const receipt: RotationStageReceipt = {files, proposalSha256: envelope.sha256, status: 'prepared'}
  rotationJson(path.join(dir, 'stage.json'), receipt)
  return receipt
}

export function assertStageUnchanged(runtime: string, dir: string, digest: string): void {
  const receipt = readRotationJson<RotationStageReceipt>(path.join(dir, 'stage.json'))
  if (receipt.proposalSha256 !== digest || receipt.status !== 'applied') throw new Error('Run rotation stage successfully before apply')
  for (const [file, hash] of Object.entries(receipt.files)) if (proposalDigest(fs.readFileSync(path.join(runtime, file), 'utf8')) !== hash) throw new Error('Staged runtime configuration changed; review and rerun stage')
}

export interface RotationApproval {approvedAt: string; proposalSha256: string; schema: 'dogeos/rotation-approval/v1'; signerAttestationPubkey: string; targetKeyHash: string}
export interface RotationReadiness {advanceL1: true; advanceL2: true; checkedAt: string; proposalSha256: string; schema: 'dogeos/rotation-readiness/v1'; signerAttestationPubkey: string; transportPubkey: string; tsoConnected: true}
export function assertRotationReceipts(dir: string, envelope: RotationEnvelope): void {
  const p = validateRotationEnvelope(envelope)
  const files = fs.readdirSync(path.join(dir, 'receipts')).filter(f => f.endsWith('.json'))
  const receipts = files.map(file => readRotationJson<RotationApproval | RotationReadiness>(path.join(dir, 'receipts', file)))
  for (const key of parseBridgeScript(p.current.redeemScriptHex).attestation.keys) {
    if (!receipts.some(r => r.schema === 'dogeos/rotation-approval/v1' && r.proposalSha256 === envelope.sha256 && r.signerAttestationPubkey === key && r.targetKeyHash === p.target.keyHash && Number.isFinite(Date.parse(r.approvedAt)))) throw new Error('An approval receipt is required from every current signer')
  }

  for (const signer of p.target.signers) {
    if (!receipts.some(r => r.schema === 'dogeos/rotation-readiness/v1' && r.proposalSha256 === envelope.sha256 && r.signerAttestationPubkey === signer.attestationPubkey && r.transportPubkey === signer.transportPubkey && r.advanceL1 === true && r.advanceL2 === true && r.tsoConnected === true && Number.isFinite(Date.parse(r.checkedAt)))) throw new Error('A readiness receipt is required from every target signer')
  }
}

export function equalFrozenPayload(a: unknown, b: unknown): boolean {return canonicalJson(a) === canonicalJson(b)}
