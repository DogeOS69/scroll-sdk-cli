import { execFileSync } from 'node:child_process'
import { createPublicKey } from 'node:crypto'

import type { KmsSignerProvisionRole } from './kms-signer-provisioner.js'

function awsCli(args: string[], profile?: string): string {
  const fullArgs = [...args]
  if (profile) fullArgs.push('--profile', profile)
  try {
    return execFileSync('aws', fullArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new Error(`aws ${args.slice(0, 2).join(' ')} failed${stderr ? `: ${stderr}` : ''} (is the AWS CLI installed and are your credentials configured?)`)
  }
}

/**
 * Signer-operator helpers: run with the OPERATOR's AWS credentials against
 * their own account; nothing here touches bridge-operator infrastructure.
 */
export function fetchKmsCompressedPublicKey(keyId: string, region: string, profile?: string): string {
  const spkiBase64 = awsCli(['kms', 'get-public-key', '--key-id', keyId, '--region', region, '--query', 'PublicKey', '--output', 'text'], profile)
  return deriveCompressedSecp256k1PublicKeyFromSpkiDer(spkiBase64)
}

export function createKmsSigningKey(description: string, region: string, profile?: string): string {
  const output = awsCli(['kms', 'create-key', '--key-spec', 'ECC_SECG_P256K1', '--key-usage', 'SIGN_VERIFY', '--description', description, '--region', region, '--output', 'json'], profile)
  const arn = JSON.parse(output)?.KeyMetadata?.Arn
  if (typeof arn !== 'string' || arn === '') throw new Error('aws kms create-key returned no KeyMetadata.Arn')
  return arn
}

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
