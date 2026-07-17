import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  deriveBridgeNamespaceId,
  deriveProtocolInstanceId,
  deriveTeeAllowedSignerIds,
  deriveTsoUrl,
  protocolIdSidecarPath,
} from '../../src/utils/signer-policy-derivation.js'

describe('signer-policy-derivation', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-policy-derivation-'))
  })

  afterEach(() => fs.rmSync(root, { force: true, recursive: true }))

  describe('protocol instance id', () => {
    it('mirrors the dogeos-core sidecar naming (extension replaced by .protocol_id)', () => {
      expect(protocolIdSidecarPath(path.join(root, '.data/protocol_context.json')))
        .to.equal(path.join(root, '.data/protocol_context.protocol_id'))
    })

    it('reads and 0x-normalizes the bare-hex sidecar written by generate_protocol_context', () => {
      const contextPath = path.join(root, 'protocol_context.json')
      const protocolId = 'ab'.repeat(32)
      fs.writeFileSync(path.join(root, 'protocol_context.protocol_id'), `${protocolId}\n`)

      const derived = deriveProtocolInstanceId(contextPath)
      expect(derived?.value).to.equal(`0x${protocolId}`)
      expect(derived?.source).to.equal(path.join(root, 'protocol_context.protocol_id'))
    })

    it('accepts an already 0x-prefixed sidecar', () => {
      const contextPath = path.join(root, 'protocol_context.json')
      fs.writeFileSync(path.join(root, 'protocol_context.protocol_id'), `0x${'CD'.repeat(32)}\n`)

      expect(deriveProtocolInstanceId(contextPath)?.value).to.equal(`0x${'cd'.repeat(32)}`)
    })

    it('returns undefined when the sidecar is missing', () => {
      expect(deriveProtocolInstanceId(path.join(root, 'protocol_context.json'))).to.equal(undefined)
    })

    it('rejects a sidecar that is not a 32-byte hex value', () => {
      const contextPath = path.join(root, 'protocol_context.json')
      fs.writeFileSync(path.join(root, 'protocol_context.protocol_id'), 'not-a-hash\n')

      expect(() => deriveProtocolInstanceId(contextPath)).to.throw('does not contain a 32-byte hex protocol_id')
    })
  })

  describe('bridge namespace id', () => {
    it('reads the byte-array form under the [default] profile table written by generate-bridge-info-cli', () => {
      const file = path.join(root, 'GenerateBridgeInfo.toml')
      fs.writeFileSync(file, `[default]
network = "testnet"
namespace_id = [136, 103, 197, 158, 34, 190, 133, 61, 144, 81, 235, 194, 88, 246, 71, 181, 236, 0, 84, 44]
`)

      const derived = deriveBridgeNamespaceId(file)
      expect(derived?.value).to.equal('0x8867c59e22be853d9051ebc258f647b5ec00542c')
      expect(derived?.source).to.equal(`${file} namespace_id`)
    })

    it('accepts a flat hex-string form for hand-maintained files', () => {
      const file = path.join(root, 'GenerateBridgeInfo.toml')
      fs.writeFileSync(file, 'namespace_id = "0x2222222222222222222222222222222222222222"\n')

      expect(deriveBridgeNamespaceId(file)?.value).to.equal('0x2222222222222222222222222222222222222222')
    })

    it('returns undefined when the file or key is absent', () => {
      expect(deriveBridgeNamespaceId(path.join(root, 'GenerateBridgeInfo.toml'))).to.equal(undefined)

      const file = path.join(root, 'GenerateBridgeInfo.toml')
      fs.writeFileSync(file, '[default]\nnetwork = "testnet"\n')
      expect(deriveBridgeNamespaceId(file)).to.equal(undefined)
    })

    it('rejects a namespace_id array that is not 20 bytes', () => {
      const file = path.join(root, 'GenerateBridgeInfo.toml')
      fs.writeFileSync(file, '[default]\nnamespace_id = [1, 2, 3]\n')

      expect(() => deriveBridgeNamespaceId(file)).to.throw('must be an array of 20 bytes')
    })
  })

  describe('TSO url', () => {
    it('builds https://<ingress.TSO_HOST> from config.toml', () => {
      const configPath = path.join(root, 'config.toml')
      fs.writeFileSync(configPath, '[ingress]\nTSO_HOST = "tso.bridge.example"\n')

      const derived = deriveTsoUrl(configPath)
      expect(derived?.value).to.equal('https://tso.bridge.example')
      expect(derived?.source).to.equal(`${configPath} [ingress].TSO_HOST`)
    })

    it('returns undefined when config.toml or the ingress host is absent', () => {
      expect(deriveTsoUrl(path.join(root, 'config.toml'))).to.equal(undefined)

      const configPath = path.join(root, 'config.toml')
      fs.writeFileSync(configPath, '[ingress]\nFRONTEND_HOST = "front.example"\n')
      expect(deriveTsoUrl(configPath)).to.equal(undefined)
    })
  })

  describe('TEE allowed signer ids', () => {
    it('reads the cubesigner tee_pubkey from setup_defaults.toml', () => {
      const defaultsPath = path.join(root, 'setup_defaults.toml')
      const teePubkey = `02${'ef'.repeat(32)}`
      fs.writeFileSync(defaultsPath, `tee_pubkey = "${teePubkey}"\nattestation_key_count = 3\n`)

      const derived = deriveTeeAllowedSignerIds(defaultsPath)
      expect(derived?.value).to.equal(teePubkey)
      expect(derived?.source).to.equal(`${defaultsPath} tee_pubkey`)
    })

    it('strips a 0x prefix and lowercases', () => {
      const defaultsPath = path.join(root, 'setup_defaults.toml')
      fs.writeFileSync(defaultsPath, `tee_pubkey = "0x03${'AB'.repeat(32)}"\n`)

      expect(deriveTeeAllowedSignerIds(defaultsPath)?.value).to.equal(`03${'ab'.repeat(32)}`)
    })

    it('returns undefined when the file or key is absent', () => {
      expect(deriveTeeAllowedSignerIds(path.join(root, 'setup_defaults.toml'))).to.equal(undefined)

      const defaultsPath = path.join(root, 'setup_defaults.toml')
      fs.writeFileSync(defaultsPath, 'attestation_key_count = 3\n')
      expect(deriveTeeAllowedSignerIds(defaultsPath)).to.equal(undefined)
    })

    it('rejects a tee_pubkey that is not a compressed secp256k1 key', () => {
      const defaultsPath = path.join(root, 'setup_defaults.toml')
      fs.writeFileSync(defaultsPath, `tee_pubkey = "04${'ab'.repeat(32)}"\n`)

      expect(() => deriveTeeAllowedSignerIds(defaultsPath)).to.throw('not a compressed secp256k1 public key')
    })
  })
})
