import {address} from 'bitcoinjs-lib'
import fs from 'node:fs'

import {assertCompressedSecp256k1PublicKey} from './attestation-signer-descriptor.js'
import {bridgeHash, parseBridgeScript} from './bridge-rotation.js'
import {tsoSignerNetwork} from './tso-signer-network.js'

export const ROTATION_EXPORT_SCHEMA = 'dogeos/rotation-export/v1'
export const MAX_ROTATION_GRACE = 260_000

export interface RotationExportSigner {label: string; public_key: string; transport_pubkey: string}
export interface RotateKeyRequest {grace_wf_txs: number; idempotency_key: string; new_bridge_redeem_script_hex: string; new_key_hash: string}
/** `dogeos/rotation-export/v1`, as the governance portal writes it. Unknown fields are ignored. */
export interface RotationExport {
  allowlist_entry: string
  current: {key_hash: string; redeem_script_hex: string; signers: RotationExportSigner[]; threshold: number}
  grace_wf_txs: number
  network: 'mainnet' | 'testnet'
  proposal: string
  protocol_instance_id: string
  schema: typeof ROTATION_EXPORT_SCHEMA
  target: {key_hash: string; p2sh_address: string; redeem_script_hex: string; signers: RotationExportSigner[]; threshold: number}
  wp_rotate_key_request: RotateKeyRequest
}

/** The parts of WP `GET /protocol-actions/rotate-key/status` the rotation commands use. */
export interface RotateKeyStatus {
  active_intent: {idempotency_key: string; status: string} | null
  current_attestation: {pubkeys: string[]; threshold: number}
  current_key_hash: string
  deprecating: {deprecation_wf_tx_number: number; key_hash: string} | null
  min_grace_wf_txs: number
  network: string
  next_wf_tx_number: number
  protocol_instance_id: string
  registered_signer_pubkeys: string[]
}

type Json = Record<string, unknown>
function object(value: unknown, label: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Rotation export: ${label} must be an object`)
  return value as Json
}

function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Rotation export: invalid ${label}`)
  return value
}

const KEY_HASH = /^0x[\da-f]{40}$/
const SCRIPT = /^(?:[\da-f]{2})+$/

function grace(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_ROTATION_GRACE) throw new Error(`Rotation export: ${label} must be an integer in 0..${MAX_ROTATION_GRACE}`)
  return value as number
}

/** One side's signers must be exactly its script's attestation keys, in script order, at its threshold. */
function side(value: unknown, label: 'current' | 'target'): RotationExport['current'] {
  const source = object(value, label)
  const keyHash = text(source.key_hash, KEY_HASH, `${label}.key_hash`)
  const script = text(source.redeem_script_hex, SCRIPT, `${label}.redeem_script_hex`)
  if (bridgeHash(script) !== keyHash) throw new Error(`Rotation export: ${label}.key_hash is not HASH160 of its redeem script`)
  const parsed = parseBridgeScript(script)
  if (!Array.isArray(source.signers)) throw new Error(`Rotation export: ${label}.signers must be an array`)
  const signers = source.signers.map((entry, index) => {
    const signer = object(entry, `${label}.signers[${index}]`)
    if (typeof signer.label !== 'string') throw new Error(`Rotation export: ${label}.signers[${index}].label must be a string`)
    return {
      label: signer.label,
      public_key: assertCompressedSecp256k1PublicKey(text(signer.public_key, /^0[23][\da-f]{64}$/, `${label} public key`), `${label} public key`),
      transport_pubkey: assertCompressedSecp256k1PublicKey(text(signer.transport_pubkey, /^0[23][\da-f]{64}$/, `${label} transport key`), `${label} transport key`),
    }
  })
  if (signers.map(s => s.public_key).join(',') !== parsed.attestation.keys.join(',')) throw new Error(`Rotation export: ${label}.signers differ from the attestation keys of its redeem script`)
  if (source.threshold !== parsed.attestation.threshold) throw new Error(`Rotation export: ${label}.threshold differs from its redeem script`)
  return {key_hash: keyHash, redeem_script_hex: script, signers, threshold: parsed.attestation.threshold}
}

/** Self-consistency of an export, using the existing bridge script parser. Run before anything else. */
export function validateRotationExport(input: unknown): RotationExport {
  const source = object(input, 'export')
  if (source.schema !== ROTATION_EXPORT_SCHEMA) throw new Error(`Rotation export: schema must be ${ROTATION_EXPORT_SCHEMA}`)
  const proposal = text(source.proposal, /^DGP-\d{4,}-rev[1-9]\d*$/, 'proposal')
  if (source.network !== 'mainnet' && source.network !== 'testnet') throw new Error('Rotation export: network must be mainnet or testnet')
  const protocolInstanceId = text(source.protocol_instance_id, /^0x[\da-f]{64}$/, 'protocol_instance_id')
  const current = side(source.current, 'current')
  const targetSide = side(source.target, 'target')
  const p2sh = address.toBase58Check(Buffer.from(targetSide.key_hash.slice(2), 'hex'), source.network === 'mainnet' ? 22 : 196)
  if (object(source.target, 'target').p2sh_address !== p2sh) throw new Error('Rotation export: target.p2sh_address is not the target script P2SH on this network')
  const target = {...targetSide, p2sh_address: p2sh}
  // The portal's transport-key rules: never the signer's own key, and unique across both sets.
  const transports = new Set<string>()
  for (const signer of [...current.signers, ...target.signers]) {
    if (signer.transport_pubkey === signer.public_key) throw new Error(`Rotation export: ${signer.label} uses its attestation key as its transport key`)
    if (transports.has(signer.transport_pubkey)) throw new Error(`Rotation export: transport key of ${signer.label} is not unique across current and target signers`)
    transports.add(signer.transport_pubkey)
  }

  const graceWfTxs = grace(source.grace_wf_txs, 'grace_wf_txs')
  const entry = text(source.allowlist_entry, /^0x[\da-f]{40}(?::\d+)?$/, 'allowlist_entry')
  const [entryHash, entryGrace] = entry.split(':')
  if (entryHash !== target.key_hash) throw new Error('Rotation export: allowlist_entry is not the target key hash')
  if (entryGrace !== undefined && entryGrace !== String(graceWfTxs)) throw new Error('Rotation export: the allowlist_entry grace differs from grace_wf_txs')
  const request = object(source.wp_rotate_key_request, 'wp_rotate_key_request')
  // The key is the bare protocol instance hex (no 0x), then the proposal.
  if (request.idempotency_key !== `${protocolInstanceId.slice(2)}-${proposal}`) throw new Error('Rotation export: wp_rotate_key_request.idempotency_key must be <protocol_instance_id hex>-<proposal>')
  if (request.new_key_hash !== target.key_hash) throw new Error('Rotation export: wp_rotate_key_request.new_key_hash differs from the target key hash')
  if (request.new_bridge_redeem_script_hex !== target.redeem_script_hex) throw new Error('Rotation export: wp_rotate_key_request script differs from the target script')
  if (grace(request.grace_wf_txs, 'wp_rotate_key_request.grace_wf_txs') !== graceWfTxs) throw new Error('Rotation export: wp_rotate_key_request.grace_wf_txs differs from grace_wf_txs')
  return {
    allowlist_entry: entry, current, grace_wf_txs: graceWfTxs, network: source.network, proposal, protocol_instance_id: protocolInstanceId,
    schema: ROTATION_EXPORT_SCHEMA, target,
    wp_rotate_key_request: {grace_wf_txs: graceWfTxs, idempotency_key: request.idempotency_key, new_bridge_redeem_script_hex: target.redeem_script_hex, new_key_hash: target.key_hash},
  }
}

export function readRotationExport(file: string): RotationExport {
  let value: unknown
  try {value = JSON.parse(fs.readFileSync(file, 'utf8'))} catch {throw new Error('Cannot read the rotation export JSON')}
  return validateRotationExport(value)
}

/** W1 must describe the export's deployment: same protocol instance and network (`mainnet` is the WP's `dogecoin`). */
export function assertDeploymentIdentity(rotation: RotationExport, status: RotateKeyStatus): void {
  if (status.protocol_instance_id.toLowerCase() !== rotation.protocol_instance_id) throw new Error('The WP serves another deployment: protocol_instance_id differs from the export')
  if (status.network !== tsoSignerNetwork(rotation.network)) throw new Error(`The WP network ${status.network} differs from the export network ${rotation.network}`)
}

/** The live bridge must still be the export's current bridge: key hash, threshold and attestation key set. */
export function assertPredecessor(rotation: RotationExport, status: RotateKeyStatus): void {
  if (status.current_key_hash.toLowerCase() !== rotation.current.key_hash) throw new Error('The live bridge key differs from the export current key; the rotation is stale or already applied')
  const live = [...status.current_attestation.pubkeys].map(key => key.toLowerCase()).sort()
  const exported = rotation.current.signers.map(signer => signer.public_key).sort()
  if (status.current_attestation.threshold !== rotation.current.threshold || live.join(',') !== exported.join(',')) throw new Error('The live attestation set or threshold differs from the export current set')
}

/** Every key the export names, current then target. */
export function rotationSigners(rotation: RotationExport): RotationExportSigner[] {
  return [...rotation.current.signers, ...rotation.target.signers]
}
