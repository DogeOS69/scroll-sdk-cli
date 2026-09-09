import * as secp256k1 from 'tiny-secp256k1'

/**
 * Normalize a SEC1 secp256k1 public key to dogeos-core's canonical compressed
 * representation. CubeSigner returns uncompressed (04 + X + Y) keys on some
 * API paths, while dogeos-core always serializes bridge keys as 02/03 + X.
 *
 * Accepting both encodings at external/config boundaries keeps existing
 * deployments readable; returning only compressed bytes gives bridge genesis,
 * and CubeSigner policy inputs one stable identity.
 */
export function normalizeCompressedSecp256k1PublicKey(value: string, source: string): string {
  const normalized = value.trim().toLowerCase().replace(/^0x/, '')
  const isCompressed = /^0[23][\da-f]{64}$/.test(normalized)
  const isUncompressed = /^04[\da-f]{128}$/.test(normalized)
  if (!isCompressed && !isUncompressed) {
    throw new Error(`${source} must be a SEC1 secp256k1 public key encoded as compressed 33-byte (02/03 + X) or uncompressed 65-byte (04 + X + Y) hex`)
  }

  const point = Buffer.from(normalized, 'hex')
  if (!secp256k1.isPoint(point)) {
    throw new Error(`${source} is not a valid secp256k1 curve point`)
  }

  return Buffer.from(secp256k1.pointCompress(point, true)).toString('hex')
}
