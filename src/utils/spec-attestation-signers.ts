import type {DeploymentSpec} from '../types/deployment-spec.js'

import {assertCompressedSecp256k1PublicKey} from './attestation-signer-descriptor.js'

/** The spec declares public identities; no partner file, credential or RPC is needed. */
export function resolveSpecAttestationSigners(spec: DeploymentSpec) {
  const entries = spec.bridge?.attestation?.signers
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('bridge.attestation.signers must contain at least one signer with name, attestationPubkey and transportPubkey')
  const names = new Set<string>()
  const keys = new Set<string>()
  const external = entries.map((entry, index) => {
    const source = `bridge.attestation.signers[${index}]`
    if (!entry || typeof entry.name !== 'string' || !/^[\da-z](?:[\da-z-]*[\da-z])?$/.test(entry.name) || entry.name.length > 63) throw new Error(`${source}.name must be a stable DNS-label identifier (at most 63 characters)`)
    if (names.has(entry.name)) throw new Error(`${source}.name must be unique`)
    names.add(entry.name)
    const readKey = (field: 'attestationPubkey' | 'transportPubkey') => {
      if (typeof entry[field] !== 'string') throw new Error(`${source}.${field} must be a compressed secp256k1 public key`)
      const key = assertCompressedSecp256k1PublicKey(entry[field], `${source}.${field}`)
      if (keys.has(key)) throw new Error(`${source}.${field}: every attestation and transport key must be distinct across all signers`)
      keys.add(key)
      return key
    }

    return {id: entry.name, publicKey: readKey('attestationPubkey'), transportPubkey: readKey('transportPubkey')}
  })
  const activeSignerIds = external.map(signer => signer.id)
  const {threshold} = spec.bridge.attestation
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > activeSignerIds.length) throw new Error('Attestation threshold must be between 1 and the selected signer count')
  return {activeSignerIds: [...activeSignerIds], external, mode: 'external' as const, threshold}
}
