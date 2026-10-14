import {opcodes as op, script} from 'bitcoinjs-lib'
import {createHash} from 'node:crypto'

import {assertCompressedSecp256k1PublicKey} from './attestation-signer-descriptor.js'

export interface BridgeScript {
  attestation: {keys: string[]; threshold: number}; namespace: string; recovery: {keys: string[]; threshold: number}
  tee: string; timelock: number
}
export function bridgeHash(hex: string): string {return `0x${createHash('ripemd160').update(createHash('sha256').update(Buffer.from(hex, 'hex')).digest()).digest('hex')}`}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be an integer between ${min} and ${max}`)
  return value as number
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
