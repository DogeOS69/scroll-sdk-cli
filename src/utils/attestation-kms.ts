import { createPublicKey } from 'node:crypto'

import type { KmsSignerProvisionRole } from './kms-signer-provisioner.js'

function base64UrlToBuffer(value: string): Buffer {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padding = '='.repeat((4 - normalized.length % 4) % 4)
  return Buffer.from(`${normalized}${padding}`, 'base64')
}

export function getAttestationSignerKmsRole(instance: number | string): KmsSignerProvisionRole {
  const suffix = typeof instance === 'number' ? String(instance) : instance.replace(/^signer-/, '')
  const serviceName = `attestation-signer-${suffix}`
  return {
    aliasSuffix: serviceName,
    defaultServiceAccount: serviceName,
    description: `DogeOS attestation signer ${instance} secp256k1 signing key`,
    purposeTag: 'bridge-attestation',
    role: `ATTESTATION_SIGNER_${suffix.toUpperCase().replaceAll('-', '_')}`,
    roleSuffix: `${serviceName}-kms`,
    service: 'attestation-signer',
  }
}

export function deriveCompressedSecp256k1PublicKeyFromSpkiDer(publicKeyBase64: string): string {
  const publicKey = createPublicKey({
    format: 'der',
    key: Buffer.from(publicKeyBase64, 'base64'),
    type: 'spki',
  })
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey
  if (!jwk.x || !jwk.y) {
    throw new Error('KMS public key did not contain secp256k1 x/y coordinates')
  }

  const x = base64UrlToBuffer(jwk.x)
  const y = base64UrlToBuffer(jwk.y)
  if (x.length !== 32 || y.length !== 32) {
    throw new Error(`Unexpected KMS public key coordinate length: x=${x.length}, y=${y.length}`)
  }

  const prefix = (y.at(-1) as number) % 2 === 0 ? 0x02 : 0x03
  return Buffer.concat([Buffer.from([prefix]), x]).toString('hex')
}
