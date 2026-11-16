import {Transaction} from 'bitcoinjs-lib'
import bitcore from 'bitcore-lib-doge'
import {createHash} from 'node:crypto'

import {normalizeCompressedSecp256k1PublicKey} from './secp256k1-public-key.js'

/**
 * The sequencing 2-of-2 that holds output 0 of every WF transaction:
 * `P2SH(OP_2 <tee> <proposer> OP_2 OP_CHECKMULTISIG)`, compressed keys, the TEE
 * key first. Mirror of Core `signer_psbt_policy::sequencing_redeem_script`.
 */
export const SEQUENCING_REDEEM_BYTES = 71

const hash160 = (bytes: Buffer): string => createHash('ripemd160').update(createHash('sha256').update(bytes).digest()).digest('hex')

function compressedKey(value: unknown, label: string): string {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!/^0[23][\da-f]{64}$/.test(key)) throw new Error(`${label} must be a compressed secp256k1 public key (33 bytes, 02 or 03 prefix)`)
  return normalizeCompressedSecp256k1PublicKey(key, label)
}

/** Hex of the canonical redeem script; rejects uncompressed, invalid or equal keys. */
export function sequencingRedeemScript(teePublicKey: unknown, proposerPublicKey: unknown): string {
  const tee = compressedKey(teePublicKey, 'TEE public key')
  const proposer = compressedKey(proposerPublicKey, 'Sequencing (proposer) public key')
  if (tee === proposer) throw new Error('The sequencing (proposer) key must differ from the TEE key')
  return `5221${tee}21${proposer}52ae`
}

/** scriptPubKey hex of the 2-of-2's P2SH output. */
export function sequencingScriptPubkey(teePublicKey: unknown, proposerPublicKey: unknown): string {
  return `a914${hash160(Buffer.from(sequencingRedeemScript(teePublicKey, proposerPublicKey), 'hex'))}87`
}

/** P2SH address of the 2-of-2 on the selected Dogecoin network. */
export function sequencingAddress(teePublicKey: unknown, proposerPublicKey: unknown, network: string): string {
  const selected = network === 'mainnet' ? bitcore.Networks.livenet : network === 'regtest' ? bitcore.Networks.regtest : bitcore.Networks.testnet
  const scriptHash = Buffer.from(hash160(Buffer.from(sequencingRedeemScript(teePublicKey, proposerPublicKey), 'hex')), 'hex')
  return new bitcore.Address(scriptHash, selected, 'scripthash').toString()
}

/**
 * The proposer key must be a dedicated key. A TEE, attestation or recovery key
 * in that position defeats the separation of roles the 2-of-2 exists for, and
 * attestation signers refuse to sign input 0.
 */
export function assertDedicatedProposerKey(proposerPublicKey: string, roles: {attestation?: string[]; feeWallet?: string; recovery?: string[]; tee?: string}): void {
  const proposer = compressedKey(proposerPublicKey, 'Sequencing (proposer) public key')
  for (const [role, keys] of [['TEE', roles.tee ? [roles.tee] : []], ['attestation', roles.attestation ?? []], ['recovery', roles.recovery ?? []], ['fee wallet', roles.feeWallet ? [roles.feeWallet] : []]] as const) {
    if (keys.some(key => normalizeCompressedSecp256k1PublicKey(key, `${role} public key`) === proposer)) throw new Error(`The sequencing (proposer) key must not also be a ${role} key`)
  }
}

export type SequencerSeedKind = 'other' | 'p2pkh' | 'two-of-two'

/**
 * Classify the genesis sequencer output by its script shape. The Withdrawal
 * Processor decides the same way: a P2SH seed puts the chain on the sequencing
 * 2-of-2, a P2PKH seed is the legacy form.
 */
export function sequencerSeedKind(txHex: string, vout: number): SequencerSeedKind {
  const output = Transaction.fromHex(txHex).outs[vout]
  if (!output) throw new Error(`Genesis sequencer transaction has no output ${vout}`)
  const script = Buffer.from(output.script).toString('hex')
  if (/^a914[\da-f]{40}87$/.test(script)) return 'two-of-two'
  if (/^76a914[\da-f]{40}88ac$/.test(script)) return 'p2pkh'
  return 'other'
}
