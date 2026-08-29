import * as toml from '@iarna/toml'
import { runCommand } from '@oclif/test'
import { expect } from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const PUBKEY = `02${'11'.repeat(32)}`
const REPOSITORY_ROOT = process.cwd()

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
    wallet: { path: '.data/wallet.json' },
  } as toml.JsonMap))
  const spec = yaml.load(fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'src/config/deployment-spec.example.yaml'),
    'utf8',
  )) as Record<string, any>
  const image = (suffix: string): Record<string, string> => ({
    digest: `sha256:${suffix.repeat(64)}`,
    repository: 'dogeos69/test-image',
  })
  spec.proofTopology = {
    compiler: {image: image('a')},
    deployment: {resourcesPersistentVolumeClaim: 'proof-resources'},
    mode,
    ...(mode === 'mock'
      ? {
          mock: {
            artifactStore: {kind: 'local_fs'},
            profile: 'withdrawal_mock_prover',
            workerImage: image('b'),
          },
        }
      : {}),
    ...(mode === 'production'
      ? {
          production: {
            artifactStore: {kind: 'local_fs'},
            profile: 'real_scroll_withdrawal_full_topology',
            realScroll: {
              aggVerifyingKeyPath: 'keys/agg-vk.bin',
              batchProgramCommitmentHex: `0x${'44'.repeat(64)}`,
              l2RangeAggregationAppCommitRawHex: `0x${'55'.repeat(64)}`,
              resourcesRoot: 'proof-resources',
            },
            workerImage: image('c'),
            workerLaunch: 'external',
          },
        }
      : {}),
    ...(preTsukiDirectSign
      ? {
          recovery: {
            preTsukiDirectSignMaxEndBatchHeight: preTsukiDirectSign.maxEndBatchHeight,
          },
        }
      : {}),
  }

  if (mode === 'production') {
    fs.mkdirSync('proof-resources/keys', {recursive: true})
    fs.writeFileSync('proof-resources/keys/agg-vk.bin', 'test-aggregate-verifying-key')
  }

  if (mode !== 'disabled') {
    spec.proofCoordinator = {
      artifactStore: {bucket: 'proofs', region: 'us-west-2'},
      s3AuthMode: 'ambient',
    }
  }

  fs.writeFileSync('deployment-spec.yaml', yaml.dump(spec))
}

function commandArgs(...extra: string[]): string[] {
  return [
    'setup',
    'export-signer-policy',
    '--config', '.data/doge-config.toml',
    '--protocol-context', '.data/protocol_context.json',
    '--tso-url', 'https://tso.bridge.example',
    '--signer-proof-artifact-base-url', 'https://proofs.bridge.example/proof-topology',
    ...extra,
  ]
}

describe('setup export-signer-policy operator flow', () => {
  let originalCwd: string
  let originalEnvironment: NodeJS.ProcessEnv
  let root: string

  beforeEach(() => {
    originalCwd = process.cwd()
    originalEnvironment = {...process.env}
    Object.assign(process.env, {
      DB_ADMIN_PASSWORD: 'test-password',
      DOGECOIN_CLUSTER_RPC_PASSWORD: 'test-password',
      DOGECOIN_CLUSTER_RPC_USERNAME: 'test-user',
      DOGECOIN_EXTERNAL_RPC_PASSWORD: 'test-password',
      DOGECOIN_EXTERNAL_RPC_USERNAME: 'test-user',
      OWNER_ADDRESS: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    })
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-signer-policy-'))
    process.chdir(root)
    fs.mkdirSync('.data', { recursive: true })
    fs.writeFileSync('.data/protocol_context.json', JSON.stringify({
      genesis: { genesis_bridge_key_hash: `0x${'33'.repeat(20)}` },
    }))
  })

  afterEach(() => {
    process.chdir(originalCwd)
    process.env = originalEnvironment
    fs.rmSync(root, { force: true, recursive: true })
  })

  for (const provingMode of ['mock', 'production'] as const) {
    it(`exports an address-bearing ${provingMode} partner bundle`, async () => {
      writeDogeConfig(provingMode)

      const {stdout} = await runCommand(commandArgs())

      expect(stdout).to.include(`${provingMode} V2 signer policy bundle written`)
      const policy = JSON.parse(fs.readFileSync('signer-policy-bundle/signer-policy.json', 'utf8'))
      expect(policy.mode).to.equal(provingMode)
      expect(policy.schema).to.equal('dogeos/attestation-signer-policy-bundle/v2')
      expect(policy.contract).to.equal('attestation_evidence_v2')
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
      expect(commands).not.to.include('verifier-registry.toml')
      expect(commands).not.to.include('source-set.toml')

      const manifest = JSON.parse(fs.readFileSync('signer-policy-bundle/signer-policy-manifest.json', 'utf8'))
      expect(manifest.schema).to.equal('dogeos/attestation-signer-policy-manifest/v1')
      expect(manifest.files.map((entry: {file: string}) => entry.file)).to.include.members([
        'protocol_context.json',
        'signer-policy.env',
        'signer-policy.json',
      ])

      if (provingMode === 'production') {
        expect(env).to.include('ATTESTATION_SIGNER_ADVANCE_L2_AGG_VERIFYING_KEY_PATH=/etc/dogeos/advance-l2-agg-verifying-key.bin')
        expect(env).to.include(`ATTESTATION_SIGNER_ADVANCE_L2_BATCH_PROGRAM_COMMITMENT_HEX=0x${'44'.repeat(64)}`)
        expect(env).to.include(`ATTESTATION_SIGNER_L2_RANGE_AGGREGATION_PROGRAM_COMMITMENT_HEX=0x${'55'.repeat(64)}`)
        expect(fs.readFileSync('signer-policy-bundle/advance-l2-agg-verifying-key.bin', 'utf8'))
          .to.equal('test-aggregate-verifying-key')
        expect(policy.advanceL2Verifier.aggVerifyingKeySha256).to.match(/^sha256:[\da-f]{64}$/)
      } else {
        expect(policy).not.to.have.property('advanceL2Verifier')
        expect(fs.existsSync('signer-policy-bundle/advance-l2-agg-verifying-key.bin')).to.equal(false)
      }
    })
  }

  it('exports a disabled direct-sign bundle without proof topology inputs', async () => {
    writeDogeConfig('disabled')
    const args = commandArgs().filter((value, index, all) => {
      const previous = all[index - 1]
      return previous !== '--signer-proof-artifact-base-url'
        && value !== '--signer-proof-artifact-base-url'
    })
    const { stdout } = await runCommand(args)
    expect(stdout).to.include('disabled V2 signer policy bundle written')
    const policy = JSON.parse(fs.readFileSync('signer-policy-bundle/signer-policy.json', 'utf8'))
    expect(policy.mode).to.equal('disabled')
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
        && value !== '--signer-proof-artifact-base-url'
    })
    await runCommand(args)

    const policy = JSON.parse(fs.readFileSync('signer-policy-bundle/signer-policy.json', 'utf8'))
    expect(policy.preTsukiDirectSign).to.deep.equal({maxEndBatchHeight: 6863})
    const env = fs.readFileSync('signer-policy-bundle/signer-policy.env', 'utf8')
    expect(env).to.include(
      'ATTESTATION_SIGNER_PRE_TSUKI_DIRECT_SIGN_MAX_END_BATCH_HEIGHT=6863',
    )
  })

  it('does not emit any retired verifier registry, source set, or TEE envelope input', async () => {
    writeDogeConfig('mock')
    fs.writeFileSync('.data/setup_defaults.toml', 'tee_pubkey = "not-even-a-public-key"\n')

    await runCommand(commandArgs())

    const policy = JSON.parse(fs.readFileSync('signer-policy-bundle/signer-policy.json', 'utf8'))
    expect(policy).not.to.have.property('teeAllowedSignerIds')
    expect(policy).not.to.have.property('allowedProofTriples')
    const env = fs.readFileSync('signer-policy-bundle/signer-policy.env', 'utf8')
    expect(env).not.to.include('ATTESTATION_SIGNER_TEE_ALLOWED_SIGNER_IDS')
    expect(env).not.to.include('ATTESTATION_SIGNER_ENVELOPE_ALLOWED_TEE_SIGNER_IDS')
    expect(fs.existsSync('signer-policy-bundle/verifier-registry.toml')).to.equal(false)
    expect(fs.existsSync('signer-policy-bundle/source-set.toml')).to.equal(false)
  })

  it('rejects a symlinked production aggregate verifying key', async () => {
    writeDogeConfig('production')
    fs.renameSync('proof-resources/keys/agg-vk.bin', 'proof-resources/keys/real-agg-vk.bin')
    fs.symlinkSync('real-agg-vk.bin', 'proof-resources/keys/agg-vk.bin')
    const {error} = await runCommand(commandArgs())
    expect(error?.message).to.include('must be a regular non-symlink file')
  })
})
