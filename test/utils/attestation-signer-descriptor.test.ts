import { expect } from 'chai'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import {
  ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA,
  assertCompressedSecp256k1PublicKey,
  fetchSignerHealth,
  loadAttestationSignerDescriptor,
  normalizeSignerEndpoint,
  validateAttestationSignerDescriptor,
} from '../../src/utils/attestation-signer-descriptor.js'

// Deterministic valid compressed secp256k1 key (generator point G).
const VALID_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

function validDescriptor(): Record<string, unknown> {
  return {
    endpoint: 'https://signer.partner.example:4040',
    id: 'partner-a-signer-0',
    network: 'testnet',
    publicKey: VALID_PUBKEY,
    schema: ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA,
  }
}

describe('attestation-signer descriptor contract', () => {
  it('accepts a well-formed descriptor and normalizes endpoint + key case', () => {
    const raw = { ...validDescriptor(), endpoint: 'https://signer.partner.example:4040/', publicKey: VALID_PUBKEY.toUpperCase() }
    const descriptor = validateAttestationSignerDescriptor(raw, 'test')
    expect(descriptor.endpoint).to.equal('https://signer.partner.example:4040')
    expect(descriptor.publicKey).to.equal(VALID_PUBKEY)
    expect(descriptor.id).to.equal('partner-a-signer-0')
  })

  it('rejects a wrong or missing schema marker', () => {
    expect(() => validateAttestationSignerDescriptor({ ...validDescriptor(), schema: 'v0' }, 'test')).to.throw(/schema/)
    const withoutSchema = validDescriptor()
    delete withoutSchema.schema
    expect(() => validateAttestationSignerDescriptor(withoutSchema, 'test')).to.throw(/schema/)
  })

  it('rejects uncompressed, malformed, and off-curve public keys', () => {
    expect(() => assertCompressedSecp256k1PublicKey(`04${'ab'.repeat(64)}`, 'test')).to.throw(/compressed/)
    expect(() => assertCompressedSecp256k1PublicKey('02deadbeef', 'test')).to.throw(/compressed/)
    expect(() => assertCompressedSecp256k1PublicKey(`02${'ff'.repeat(32)}`, 'test')).to.throw(/not a valid secp256k1 point/)
  })

  it('rejects a descriptor still carrying the signer-init endpoint placeholder', () => {
    expect(() => validateAttestationSignerDescriptor(
      { ...validDescriptor(), endpoint: 'https://REPLACE-WITH-YOUR-SIGNER-ENDPOINT' },
      'test'
    )).to.throw(/placeholder/)
  })

  it('rejects endpoints with paths, queries, credentials, or non-http schemes', () => {
    expect(() => normalizeSignerEndpoint('https://a.example/sign', 'test')).to.throw(/bare base URL/)
    expect(() => normalizeSignerEndpoint('https://a.example/?x=1', 'test')).to.throw(/bare base URL/)
    expect(() => normalizeSignerEndpoint('https://user:pw@a.example', 'test')).to.throw(/bare base URL/)
    expect(() => normalizeSignerEndpoint('ftp://a.example', 'test')).to.throw(/http or https/)
    expect(() => normalizeSignerEndpoint('not-a-url', 'test')).to.throw(/absolute/)
    expect(normalizeSignerEndpoint('http://10.0.0.5:4040', 'test')).to.equal('http://10.0.0.5:4040')
  })

  it('rejects loopback and unspecified hosts that TSO can never reach cross-operator', () => {
    for (const endpoint of [
      'http://localhost:4040',
      'http://signer.localhost:4040',
      'http://127.0.0.1:4040',
      'http://0.0.0.0:4040',
      'http://[::1]:4040',
      'http://[::]:4040',
    ]) {
      expect(() => validateAttestationSignerDescriptor({ ...validDescriptor(), endpoint }, 'test'))
        .to.throw('cannot be reached from the bridge operator\'s TSO network')
    }
  })

  it('rejects bad ids and unknown networks', () => {
    expect(() => validateAttestationSignerDescriptor({ ...validDescriptor(), id: 'Bad_Id' }, 'test')).to.throw(/DNS-label/)
    expect(() => validateAttestationSignerDescriptor({ ...validDescriptor(), id: '-lead' }, 'test')).to.throw(/DNS-label/)
    expect(() => validateAttestationSignerDescriptor({ ...validDescriptor(), network: 'devnet' }, 'test')).to.throw(/network must be one of/)
  })

  it('probes /health, extracts the public key, and reports actionable connectivity errors', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ network: 'testnet', public_key: VALID_PUBKEY }))
      } else {
        res.statusCode = 404
        res.end()
      }
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const { port } = server.address() as { port: number }
    try {
      const health = await fetchSignerHealth(`http://127.0.0.1:${port}`, 10_000, { allowLoopback: true })
      expect(health.publicKey).to.equal(VALID_PUBKEY)
      expect(health.network).to.equal('testnet')
    } finally {
      await new Promise(resolve => { server.close(resolve) })
    }

    // Closed port must surface the cause, not a bare "fetch failed".
    try {
      await fetchSignerHealth(`http://127.0.0.1:${port}`, 10_000, { allowLoopback: true })
      expect.fail('expected fetchSignerHealth to reject on a closed port')
    } catch (error) {
      expect((error as Error).message).to.match(/GET http.*failed/).and.to.match(/check DNS, connectivity/)
    }
  })

  it('loads and validates a descriptor file from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'descriptor-test-'))
    try {
      const file = path.join(dir, 'signer.json')
      fs.writeFileSync(file, JSON.stringify(validDescriptor()))
      const descriptor = loadAttestationSignerDescriptor(file)
      expect(descriptor.publicKey).to.equal(VALID_PUBKEY)

      fs.writeFileSync(file, '{not json')
      expect(() => loadAttestationSignerDescriptor(file)).to.throw(/failed to read descriptor/)
    } finally {
      fs.rmSync(dir, { force: true, recursive: true })
    }
  })
})
