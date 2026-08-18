import * as toml from '@iarna/toml'
import { runCommand } from '@oclif/test'
import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const PUBKEY = `02${'11'.repeat(32)}`
const TEE_PUBKEY = `03${'22'.repeat(32)}`
const COMPRESSED_GENERATOR = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const UNCOMPRESSED_GENERATOR = '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' +
  '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8'

function writeDogeConfig(
  mode: 'disabled' | 'mock' | 'production',
  preTsukiDirectSign?: {maxEndBatchHeight: number},
): void {
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
    proofSystem: { mode, ...(preTsukiDirectSign ? {preTsukiDirectSign} : {}) },
    wallet: { path: '.data/wallet.json' },
  } as toml.JsonMap))
}

function commandArgs(...extra: string[]): string[] {
  return [
    'setup',
    'export-signer-policy',
    '--config', '.data/doge-config.toml',
    '--protocol-context', '.data/protocol_context.json',
    '--bridge-namespace-id', `0x${'44'.repeat(20)}`,
    '--protocol-instance-id', `0x${'55'.repeat(32)}`,
    '--tso-url', 'https://tso.bridge.example',
    '--signer-proof-artifact-base-url', 'https://proofs.bridge.example/proof-topology',
    '--allowed-proof-triples', `openvm_state_transition:bridge-v1:0x${'66'.repeat(32)}`,
    ...extra,
  ]
}

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
      writeDogeConfig(provingMode)

      const { stdout } = await runCommand(commandArgs(
        '--tee-allowed-signer-ids', TEE_PUBKEY,
        '--verifier-registry', 'verifier-registry.toml',
        '--source-set', 'source-set.toml'
      ))

      expect(stdout).to.include(`${provingMode} policy bundle written`)
      const policy = JSON.parse(fs.readFileSync('signer-policy-bundle/signer-policy.json', 'utf8'))
      expect(policy.mode).to.equal(provingMode)
      expect(policy.envelopeMaxProofArtifacts).to.equal(4)
      expect(policy.signers).to.deep.equal([{
        endpoint: 'https://signer.partner-a.example:4040',
        id: 'partner-a',
        publicKey: PUBKEY,
      }])

      const env = fs.readFileSync('signer-policy-bundle/signer-policy.env', 'utf8')
      expect(env).to.include(`ATTESTATION_SIGNER_POLICY_MODE=${provingMode === 'mock' ? 'staging_scaffold' : 'production_enforce'}`)
      expect(env).to.include('ATTESTATION_SIGNER_PROTOCOL_CONTEXT_JSON=/etc/dogeos/protocol_context.json')
      expect(env).to.include('ATTESTATION_SIGNER_ARTIFACT_ALLOWED_ORIGINS=https://proofs.bridge.example')
      expect(env).not.to.include('ATTESTATION_SIGNER_BRIDGE_NAMESPACE_ID')
      expect(fs.readFileSync('signer-policy-bundle/protocol_context.json', 'utf8'))
        .to.equal(fs.readFileSync('.data/protocol_context.json', 'utf8'))

      const commands = fs.readFileSync('signer-policy-bundle/PARTNER-COMMANDS.md', 'utf8')
      expect(commands).to.include('https://signer.partner-a.example:4040')
      expect(commands).to.include('https://tso.bridge.example')
      expect(commands).to.include('https://proofs.bridge.example/proof-topology')
      expect(commands).to.include('scrollsdk signer init')
      expect(commands).to.include('kubectl -n <namespace> run signer-reachability-partner-a')
    })
  }

  it('exports a disabled direct-sign bundle without proof topology inputs', async () => {
    writeDogeConfig('disabled')
    const args = commandArgs().filter((value, index, all) => {
      const previous = all[index - 1]
      return previous !== '--signer-proof-artifact-base-url'
        && previous !== '--allowed-proof-triples'
        && value !== '--signer-proof-artifact-base-url'
        && value !== '--allowed-proof-triples'
    })
    const { stdout } = await runCommand(args)
    expect(stdout).to.include('disabled policy bundle written')
    const policy = JSON.parse(fs.readFileSync('signer-policy-bundle/signer-policy.json', 'utf8'))
    expect(policy.mode).to.equal('disabled')
    expect(policy.envelopeMaxProofArtifacts).to.equal(0)
    const env = fs.readFileSync('signer-policy-bundle/signer-policy.env', 'utf8')
    expect(env).to.include('ATTESTATION_SIGNER_POLICY_MODE=dev_permissive')
    expect(env).to.include('ATTESTATION_SIGNER_PROTOCOL_CONTEXT_JSON=/etc/dogeos/protocol_context.json')
    expect(env).not.to.include('ATTESTATION_SIGNER_ARTIFACT_ALLOWED_ORIGINS')
  })

  it('exports the temporary recovery pin from canonical proof intent', async () => {
    writeDogeConfig('disabled', {maxEndBatchHeight: 6863})
    const args = commandArgs().filter((value, index, all) => {
      const previous = all[index - 1]
      return previous !== '--signer-proof-artifact-base-url'
        && previous !== '--allowed-proof-triples'
        && value !== '--signer-proof-artifact-base-url'
        && value !== '--allowed-proof-triples'
    })
    await runCommand(args)

    const policy = JSON.parse(fs.readFileSync('signer-policy-bundle/signer-policy.json', 'utf8'))
    expect(policy.preTsukiDirectSign).to.deep.equal({maxEndBatchHeight: 6863})
    const env = fs.readFileSync('signer-policy-bundle/signer-policy.env', 'utf8')
    expect(env).to.include(
      'ATTESTATION_SIGNER_PRE_TSUKI_DIRECT_SIGN_MAX_END_BATCH_HEIGHT=6863',
    )
  })

  it('leaves TEE allowlists empty in mock mode without reading a legacy setup_defaults key', async () => {
    writeDogeConfig('mock')
    fs.writeFileSync('.data/setup_defaults.toml', 'tee_pubkey = "not-even-a-public-key"\n')

    await runCommand(commandArgs())

    const policy = JSON.parse(fs.readFileSync('signer-policy-bundle/signer-policy.json', 'utf8'))
    expect(policy.teeAllowedSignerIds).to.equal('')
    const env = fs.readFileSync('signer-policy-bundle/signer-policy.env', 'utf8')
    expect(env).not.to.include('ATTESTATION_SIGNER_TEE_ALLOWED_SIGNER_IDS')
    expect(env).not.to.include('ATTESTATION_SIGNER_ENVELOPE_ALLOWED_TEE_SIGNER_IDS')
    const registry = fs.readFileSync('signer-policy-bundle/verifier-registry.toml', 'utf8')
    expect(registry).to.include('proof_kind = "openvm_state_transition"')
    expect(registry).to.include('verifier_id = "bridge-v1"')
    expect(registry).to.include(`vk_hash = "0x${'66'.repeat(32)}"`)
    const sourceSet = fs.readFileSync('signer-policy-bundle/source-set.toml', 'utf8')
    expect(sourceSet).to.include('Mock/e2e_harness source-set scaffold')
  })

  it('normalizes a legacy uncompressed CubeSigner key for production policy', async () => {
    writeDogeConfig('production')
    fs.writeFileSync('.data/setup_defaults.toml', `tee_pubkey = "${UNCOMPRESSED_GENERATOR}"\n`)

    await runCommand(commandArgs('--source-set', 'source-set.toml'))

    const policy = JSON.parse(fs.readFileSync('signer-policy-bundle/signer-policy.json', 'utf8'))
    expect(policy.teeAllowedSignerIds).to.equal(COMPRESSED_GENERATOR)
    const env = fs.readFileSync('signer-policy-bundle/signer-policy.env', 'utf8')
    expect(env).not.to.include('ATTESTATION_SIGNER_TEE_ALLOWED_SIGNER_IDS')
    expect(env).not.to.include('ATTESTATION_SIGNER_ENVELOPE_ALLOWED_TEE_SIGNER_IDS')
  })
})
