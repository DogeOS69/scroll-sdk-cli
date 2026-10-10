import {address, opcodes as op, script} from 'bitcoinjs-lib'
import {createHash} from 'node:crypto'

import {assertCompressedSecp256k1PublicKey} from './attestation-signer-descriptor.js'

export const MIN_ROTATION_RECOVERY_DELAY = 259_200
export const MAX_ROTATION_GRACE = 260_000
export type RotationNetwork = 'mainnet' | 'regtest' | 'testnet'
export interface RotationSigner {attestationPubkey: string; name: string; transportPubkey: string}
export interface RotationSpec {
  attestation: {signers: RotationSigner[]; threshold?: number}
  graceWfTxs?: number
  name: string
  timelock?: {marginBlocks?: number; policy: 'preserve' | 'refresh'}
}
export interface RotationChainState {
  confirmedAnchorHeight: number; currentKeyHash: string; deprecating?: {deprecationWfTxNumber: number; keyHash: string}; liveTipHeight: number
  minGraceWfTxs: number; network: RotationNetwork; protocolContextSha256: string; redeemScriptHex: string
  wfTxNumber: number
}
export interface BridgeScript {
  attestation: {keys: string[]; threshold: number}; namespace: string; recovery: {keys: string[]; threshold: number}
  tee: string; timelock: number
}
export interface RotationProposal {
  current: {keyHash: string; redeemScriptHex: string}; deployment: {namespace: string; protocolContextSha256: string}; graceWfTxs: number
  name: string
  network: RotationNetwork
  observedWfTxNumber: number
  schema: 'dogeos/attestation-rotation/v1'
  target: {address: string; keyHash: string; redeemScriptHex: string; signers: RotationSigner[]; threshold: number}
  timelock: {anchorHeight: number; newHeight: number; oldHeight: number; policy: 'preserve' | 'refresh'}
}
export interface RotationEnvelope {proposal: RotationProposal; sha256: string}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  return JSON.stringify(value)
}

export function proposalDigest(value: unknown): string {return createHash('sha256').update(canonicalJson(value)).digest('hex')}
export function bridgeHash(hex: string): string {return `0x${createHash('ripemd160').update(createHash('sha256').update(Buffer.from(hex, 'hex')).digest()).digest('hex')}`}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be an integer between ${min} and ${max}`)
  return value as number
}

function exactKeys(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label} contains unsupported fields or is not an object`)
}

export function parseBridgeScript(hex: string): BridgeScript {
  if (!/^(?:[\da-f]{2})+$/.test(hex) || hex.length > 1040) throw new Error('Bridge script must be lowercase hex and at most 520 bytes')
  const chunks = script.decompile(Buffer.from(hex, 'hex'))
  if (!chunks) throw new Error('Invalid bridge script')
  let index = 0
  const take = () => chunks[index++]
  const opcode = (expected: number) => {if (take() !== expected) throw new Error('Unexpected bridge script layout')}
  const data = (size: number) => {const item = take(); if (!(item instanceof Uint8Array) || item.length !== size) throw new Error('Invalid bridge script data'); return Buffer.from(item).toString('hex')}
  const number = () => {const item = take(); if (typeof item === 'number') {if (item === op.OP_0) return 0; if (item >= op.OP_1 && item <= op.OP_16) return item - op.OP_1 + 1; throw new Error('Invalid script number')} if (!item) throw new Error('Missing script number'); return script.number.decode(item, 5, true)}
  const multisig = () => {
    const threshold = number(); const keys: string[] = []
    while (chunks[index] instanceof Uint8Array && (chunks[index] as Uint8Array).length === 33) keys.push(assertCompressedSecp256k1PublicKey(data(33), 'bridge key'))
    if (number() !== keys.length || new Set(keys).size !== keys.length) throw new Error('Invalid bridge multisig key set')
    integer(threshold, 'Multisig threshold', 1, keys.length); opcode(op.OP_CHECKMULTISIGVERIFY)
    return {keys, threshold}
  }

  const namespace = data(20); opcode(op.OP_DROP); opcode(op.OP_IF)
  const attestation = multisig(); const tee = assertCompressedSecp256k1PublicKey(data(33), 'TEE key'); opcode(op.OP_CHECKSIGVERIFY); opcode(op.OP_ELSE)
  const timelock = integer(number(), 'Recovery timelock', 0, 499_999_999); opcode(op.OP_CHECKLOCKTIMEVERIFY); opcode(op.OP_DROP)
  const recovery = multisig(); opcode(op.OP_ENDIF); opcode(op.OP_1)
  if (index !== chunks.length || [...attestation.keys, ...recovery.keys].includes(tee)) throw new Error('Invalid bridge script suffix or TEE role reuse')
  return {attestation, namespace, recovery, tee, timelock}
}

export function encodeBridgeScript(value: BridgeScript): string {
  const ms = (v: BridgeScript['attestation']) => [script.number.encode(v.threshold), ...v.keys.map(k => Buffer.from(k, 'hex')), script.number.encode(v.keys.length), op.OP_CHECKMULTISIGVERIFY]
  const hex = Buffer.from(script.compile([Buffer.from(value.namespace, 'hex'), op.OP_DROP, op.OP_IF, ...ms(value.attestation), Buffer.from(value.tee, 'hex'), op.OP_CHECKSIGVERIFY, op.OP_ELSE, script.number.encode(value.timelock), op.OP_CHECKLOCKTIMEVERIFY, op.OP_DROP, ...ms(value.recovery), op.OP_ENDIF, op.OP_1])).toString('hex')
  parseBridgeScript(hex)
  return hex
}

export function validateRotationSpec(input: unknown): RotationSpec {
  exactKeys(input, ['name', 'attestation', 'graceWfTxs', 'timelock'], 'rotation spec')
  if (typeof input.name !== 'string' || !/^[\da-z][\da-z-]{0,62}$/.test(input.name)) throw new Error('Rotation name must be a lowercase DNS label')
  exactKeys(input.attestation, ['threshold', 'signers'], 'attestation')
  if (!Array.isArray(input.attestation.signers) || input.attestation.signers.length === 0) throw new Error('Target signers are required')
  const names = new Set<string>(); const keys = new Set<string>()
  for (const signer of input.attestation.signers) {
    exactKeys(signer, ['name', 'attestationPubkey', 'transportPubkey'], 'signer')
    if (typeof signer.name !== 'string' || !/^[\da-z][\da-z-]{0,62}$/.test(signer.name) || names.has(signer.name)) throw new Error('Signer names must be unique lowercase DNS labels')
    names.add(signer.name)
    for (const field of ['attestationPubkey', 'transportPubkey']) {
      if (typeof signer[field] !== 'string') throw new Error('Each signer needs both public keys')
      const key = assertCompressedSecp256k1PublicKey(signer[field] as string, field)
      if (keys.has(key)) throw new Error('Every attestation and transport public key must be distinct')
      keys.add(key); signer[field] = key
    }
  }

  if (input.attestation.threshold !== undefined) integer(input.attestation.threshold, 'threshold', 1, input.attestation.signers.length)
  if (input.graceWfTxs !== undefined) integer(input.graceWfTxs, 'graceWfTxs', 1, MAX_ROTATION_GRACE)
  if (input.timelock !== undefined) {
    exactKeys(input.timelock, ['policy', 'marginBlocks'], 'timelock')
    if (!['preserve', 'refresh'].includes(String(input.timelock.policy))) throw new Error('timelock.policy must be preserve or refresh')
    if (input.timelock.marginBlocks !== undefined) {
      if (input.timelock.policy !== 'refresh') throw new Error('marginBlocks only applies to refresh')
      integer(input.timelock.marginBlocks, 'marginBlocks', 1, 499_999_999)
    }
  }

  return input as unknown as RotationSpec
}

export function createRotationProposal(input: unknown, state: RotationChainState): RotationEnvelope {
  const spec = validateRotationSpec(input)
  if (!/^[\da-f]{64}$/.test(state.protocolContextSha256) || bridgeHash(state.redeemScriptHex) !== state.currentKeyHash) throw new Error('Current bridge script or protocol context binding is invalid')
  const old = parseBridgeScript(state.redeemScriptHex)
  const threshold = spec.attestation.threshold ?? old.attestation.threshold
  integer(threshold, 'threshold', 1, spec.attestation.signers.length)
  const targetKeys = spec.attestation.signers.map(s => s.attestationPubkey).sort()
  if (targetKeys.some(k => old.attestation.keys.includes(k))) throw new Error('Core requires completely disjoint old and new attestation keys')
  const grace = spec.graceWfTxs ?? state.minGraceWfTxs
  integer(grace, 'graceWfTxs', state.minGraceWfTxs, MAX_ROTATION_GRACE)
  const anchor = Math.max(state.liveTipHeight, state.confirmedAnchorHeight)
  const policy = spec.timelock?.policy ?? 'preserve'
  const timelock = policy === 'refresh' ? Math.max(old.timelock, anchor + MIN_ROTATION_RECOVERY_DELAY + (spec.timelock?.marginBlocks ?? 10_000)) : old.timelock
  if (timelock < anchor + MIN_ROTATION_RECOVERY_DELAY) throw new Error('Existing timelock has insufficient remaining delay. Explicitly choose timelock.policy: refresh, then review the new recovery height')
  const newHex = encodeBridgeScript({...old, attestation: {keys: targetKeys, threshold}, timelock})
  const hash = bridgeHash(newHex)
  const proposal: RotationProposal = {
    current: {keyHash: state.currentKeyHash, redeemScriptHex: state.redeemScriptHex}, deployment: {namespace: old.namespace, protocolContextSha256: state.protocolContextSha256}, graceWfTxs: grace,
    name: spec.name,
    network: state.network,
    observedWfTxNumber: state.wfTxNumber,
    schema: 'dogeos/attestation-rotation/v1', target: {address: address.toBase58Check(Buffer.from(hash.slice(2), 'hex'), state.network === 'mainnet' ? 22 : 196), keyHash: hash, redeemScriptHex: newHex, signers: spec.attestation.signers, threshold}, timelock: {anchorHeight: anchor, newHeight: timelock, oldHeight: old.timelock, policy},
  }
  return {proposal, sha256: proposalDigest(proposal)}
}

export function validateRotationEnvelope(envelope: RotationEnvelope): RotationProposal {
  const p = envelope.proposal
  if (!p || p.schema !== 'dogeos/attestation-rotation/v1' || envelope.sha256 !== proposalDigest(p)) throw new Error('Rotation proposal digest mismatch')
  const old = parseBridgeScript(p.current.redeemScriptHex)
  const rebuilt = createRotationProposal({attestation: {signers: p.target.signers, threshold: p.target.threshold}, graceWfTxs: p.graceWfTxs, name: p.name, timelock: p.timelock.policy === 'refresh' ? {marginBlocks: p.timelock.newHeight - p.timelock.anchorHeight - MIN_ROTATION_RECOVERY_DELAY, policy: 'refresh'} : {policy: 'preserve'}}, {
    confirmedAnchorHeight: p.timelock.anchorHeight, currentKeyHash: p.current.keyHash, liveTipHeight: p.timelock.anchorHeight, minGraceWfTxs: 1,
    network: p.network, protocolContextSha256: p.deployment.protocolContextSha256, redeemScriptHex: p.current.redeemScriptHex, wfTxNumber: p.observedWfTxNumber,
  })
  if (old.namespace !== p.deployment.namespace || canonicalJson(rebuilt.proposal) !== canonicalJson(p)) throw new Error('Proposal does not match its scripts or declared intent')
  return p
}

export function assertRotationAdmission(envelope: RotationEnvelope, state: RotationChainState): void {
  const p = validateRotationEnvelope(envelope)
  if (p.deployment.protocolContextSha256 !== state.protocolContextSha256 || p.network !== state.network || p.current.keyHash !== state.currentKeyHash || p.current.redeemScriptHex !== state.redeemScriptHex) throw new Error('Current deployment or bridge changed; create and approve a new proposal')
  if (state.deprecating && state.wfTxNumber + 1 < state.deprecating.deprecationWfTxNumber) throw new Error('Previous rotation overlap is still active')
  if (p.timelock.newHeight < Math.max(state.liveTipHeight, state.confirmedAnchorHeight) + MIN_ROTATION_RECOVERY_DELAY) throw new Error('Frozen timelock has expired for admission; create and approve a new proposal')
  integer(p.graceWfTxs, 'graceWfTxs', state.minGraceWfTxs, MAX_ROTATION_GRACE)
  integer(state.wfTxNumber + 1 + p.graceWfTxs, 'deprecation WF', 1, 0xFF_FF_FF_FF)
}

/** A frozen proposal remains authoritative, but changed input must never be silently ignored. */
export function assertRotationSpecUnchanged(input: unknown, envelope: RotationEnvelope): void {
  const p = validateRotationEnvelope(envelope)
  const candidate = createRotationProposal(input, {
    confirmedAnchorHeight: p.timelock.anchorHeight, currentKeyHash: p.current.keyHash,
    liveTipHeight: p.timelock.anchorHeight, minGraceWfTxs: p.graceWfTxs, network: p.network,
    protocolContextSha256: p.deployment.protocolContextSha256, redeemScriptHex: p.current.redeemScriptHex,
    wfTxNumber: p.observedWfTxNumber,
  })
  if (candidate.sha256 !== envelope.sha256) throw new Error('rotation-spec.yaml differs from the frozen proposal; use a new rotation name and repeat plan and approval')
}
