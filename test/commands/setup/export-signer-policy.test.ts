import * as toml from '@iarna/toml'
import { runCommand } from '@oclif/test'
import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const PUBKEY = `02${'11'.repeat(32)}`
const TEE_PUBKEY = `03${'22'.repeat(32)}`

describe('setup export-signer-policy operator flow', () => {
  let originalCwd: string
  let root: string

  beforeEach(() => {
    originalCwd = process.cwd()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-signer-policy-'))
    process.chdir(root)
    fs.mkdirSync('.data', { recursive: true })
    fs.writeFileSync('.data/protocol_context.json', JSON.stringify({
      genesis: { genesis_bridge_key_hash: `0x${'33'.repeat(20)}` },
    }))
    fs.writeFileSync('verifier-registry.toml', '')
    fs.writeFileSync('source-set.toml', '')
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(root, { force: true, recursive: true })
  })

  for (const provingMode of ['mock', 'production'] as const) {
    it(`exports an address-bearing ${provingMode} partner bundle`, async () => {
      fs.writeFileSync('.data/doge-config.toml', toml.stringify({
        attestationSigner: {
          activeSignerIds: ['partner-a'],
          external: [{
            endpoint: 'https://signer.partner-a.example:4040',
            id: 'partner-a',
            publicKey: PUBKEY,
          }],
          mode: 'external',
          threshold: 1,
        },
        network: 'testnet',
        proofSystem: { provingMode },
        wallet: { path: '.data/wallet.json' },
      } as toml.JsonMap))

      const { stdout } = await runCommand([
        'setup',
        'export-signer-policy',
        '--config', '.data/doge-config.toml',
        '--protocol-context', '.data/protocol_context.json',
        '--bridge-namespace-id', `0x${'44'.repeat(20)}`,
        '--protocol-instance-id', `0x${'55'.repeat(32)}`,
        '--tso-url', 'https://tso.bridge.example',
        '--signer-proof-artifact-base-url', 'https://proofs.bridge.example/proof-topology',
        '--allowed-proof-triples', `openvm_state_transition:bridge-v1:0x${'66'.repeat(32)}`,
        '--tee-allowed-signer-ids', TEE_PUBKEY,
        '--verifier-registry', 'verifier-registry.toml',
        '--source-set', 'source-set.toml',
      ])

      expect(stdout).to.include(`${provingMode} policy bundle written`)
      const policy = JSON.parse(fs.readFileSync('signer-policy-bundle/signer-policy.json', 'utf8'))
      expect(policy.provingMode).to.equal(provingMode)
      expect(policy.envelopeMaxProofArtifacts).to.equal(4)
      expect(policy.signers).to.deep.equal([{
        endpoint: 'https://signer.partner-a.example:4040',
        id: 'partner-a',
        publicKey: PUBKEY,
      }])

      const env = fs.readFileSync('signer-policy-bundle/signer-policy.env', 'utf8')
      expect(env).to.include(`ATTESTATION_SIGNER_POLICY_MODE=${provingMode === 'mock' ? 'staging_scaffold' : 'production_enforce'}`)
      expect(env).to.include('ATTESTATION_SIGNER_ENVELOPE_MAX_PROOF_ARTIFACTS=4')
      expect(env).to.include(`ATTESTATION_SIGNER_ENVELOPE_ALLOWED_TEE_SIGNER_IDS=${TEE_PUBKEY}`)

      const commands = fs.readFileSync('signer-policy-bundle/PARTNER-COMMANDS.md', 'utf8')
      expect(commands).to.include('https://signer.partner-a.example:4040')
      expect(commands).to.include('https://tso.bridge.example')
      expect(commands).to.include('https://proofs.bridge.example/proof-topology')
      expect(commands).to.include('scrollsdk signer init')
      expect(commands).to.include('kubectl -n <namespace> run signer-reachability-partner-a')
    })
  }
})
