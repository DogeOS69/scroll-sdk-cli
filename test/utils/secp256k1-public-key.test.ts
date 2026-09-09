import { expect } from 'chai'

import {normalizeCompressedSecp256k1PublicKey} from '../../src/utils/secp256k1-public-key.js'

const COMPRESSED_GENERATOR = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const UNCOMPRESSED_GENERATOR = '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' +
  '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8'

describe('secp256k1 public-key normalization', () => {
  it('keeps an already-compressed key canonical', () => {
    expect(normalizeCompressedSecp256k1PublicKey(COMPRESSED_GENERATOR, 'test key'))
      .to.equal(COMPRESSED_GENERATOR)
  })

  it('converts a CubeSigner-style uncompressed SEC1 key to compressed form', () => {
    expect(normalizeCompressedSecp256k1PublicKey(`0x${UNCOMPRESSED_GENERATOR.toUpperCase()}`, 'CubeSigner key'))
      .to.equal(COMPRESSED_GENERATOR)
  })

  it('rejects malformed encodings and values that are not curve points', () => {
    expect(() => normalizeCompressedSecp256k1PublicKey('abc123', 'test key'))
      .to.throw('compressed 33-byte')
    expect(() => normalizeCompressedSecp256k1PublicKey(`02${'00'.repeat(32)}`, 'test key'))
      .to.throw('not a valid secp256k1 curve point')
  })
})
