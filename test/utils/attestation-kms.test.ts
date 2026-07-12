import { expect } from 'chai'
import { generateKeyPairSync } from 'node:crypto'

import { deriveCompressedSecp256k1PublicKeyFromSpkiDer, getAttestationSignerKmsRole } from '../../src/utils/attestation-kms.js'
import { sanitizeName, truncateIamRoleName } from '../../src/utils/kms-signer-provisioner.js'

function base64UrlToBuffer(value: string): Buffer {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  return Buffer.from(`${normalized}${'='.repeat((4 - normalized.length % 4) % 4)}`, 'base64')
}

describe('attestation KMS utilities', () => {
  it('derives deterministic per-instance KMS and IRSA resource names', () => {
    const networkAlias = sanitizeName('Testnet')
    const eksCluster = sanitizeName('dogeos-testnet-cluster')
    const roles = [0, 1, 2].map(index => getAttestationSignerKmsRole(index))

    expect(roles.map(role => `alias/dogeos/${networkAlias}/${eksCluster}/${role.aliasSuffix}`)).to.deep.equal([
      'alias/dogeos/testnet/dogeos-testnet-cluster/attestation-signer-0',
      'alias/dogeos/testnet/dogeos-testnet-cluster/attestation-signer-1',
      'alias/dogeos/testnet/dogeos-testnet-cluster/attestation-signer-2',
    ])
    expect(roles.map(role => role.defaultServiceAccount)).to.deep.equal([
      'attestation-signer-0',
      'attestation-signer-1',
      'attestation-signer-2',
    ])
    expect(roles.map(role => truncateIamRoleName(`dogeos-${networkAlias}-${eksCluster}-${role.roleSuffix}`))).to.deep.equal([
      'dogeos-testnet-dogeos-testnet-cluster-attestation-signer-0-kms',
      'dogeos-testnet-dogeos-testnet-cluster-attestation-signer-1-kms',
      'dogeos-testnet-dogeos-testnet-cluster-attestation-signer-2-kms',
    ])
  })

  it('derives the canonical compressed signer ID from an AWS-style SPKI public key', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const jwk = publicKey.export({ format: 'jwk' })
    const x = base64UrlToBuffer(jwk.x as string)
    const y = base64UrlToBuffer(jwk.y as string)
    const prefix = (y.at(-1) as number) % 2 === 0 ? '02' : '03'

    expect(deriveCompressedSecp256k1PublicKeyFromSpkiDer(spki)).to.equal(`${prefix}${x.toString('hex')}`)
  })
})
