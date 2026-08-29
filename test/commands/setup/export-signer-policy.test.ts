import * as toml from '@iarna/toml'
import { runCommand } from '@oclif/test'
import { expect } from 'chai'
import * as yaml from 'js-yaml'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const PUBKEY = `02${'11'.repeat(32)}`
const REPOSITORY_ROOT = process.cwd()
const digest = (character: string) => `sha256:${character.repeat(64)}`
const hex32 = (character: string) => `0x${character.repeat(64)}`
const hex64 = (character: string) => `0x${character.repeat(128)}`

function sha256(contents: Buffer | string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

function writeProductionInputs(image: (suffix: string) => Record<string, string>) {
  const resourcesRoot = path.resolve('.data/proof-production')
  const softwareRoot = path.join(resourcesRoot, 'software')
  const bridgeRoot = path.join(resourcesRoot, 'bridge')
  const releaseFile = (root: string, relative: string, contents = `fixture:${relative}`) => {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, contents)
    return {path: relative, sha256: sha256(contents), size_bytes: Buffer.byteLength(contents)}
  }

  const l2Range = {
    app_commit_raw: hex64('5'),
    program_commitment_hash: hex32('5'),
    verification_key_hash: hex32('6'),
  }
  const softwareReleaseDigest = digest('f')
  const release = {
    build: {
      openvm_version: '1.7.0',
      root_verifier_asm_sha256: hex32('7'),
      rust_toolchain: 'nightly-2026-03-17',
    },
    identities: {
      aggregate_verification_key_hash: l2Range.verification_key_hash,
      batch: {
        program_commitment_hash: hex32('4'),
        program_commitment_le_raw: hex64('4'),
        recursive_app_commit_raw: hex64('8'),
        verification_key_hash: hex32('3'),
      },
      chunk: {
        program_commitment_hash: hex32('1'),
        program_commitment_le_raw: hex64('2'),
        verification_key_hash: hex32('3'),
      },
      l2_range: l2Range,
    },
    images: {
      bridge_artifact_baker: image('d'),
      mock_worker: image('b'),
      production_worker: image('c'),
      topology_compiler: image('a'),
    },
    materials: {
      aggregate_verification_key: releaseFile(
        softwareRoot,
        'keys/agg-vk.bin',
        'test-aggregate-verifying-key',
      ),
      batch_app_vmexe: releaseFile(softwareRoot, 'batch/app.vmexe'),
      batch_materializer: releaseFile(softwareRoot, 'bin/batch-materializer'),
      batch_openvm_config: releaseFile(softwareRoot, 'batch/openvm.toml'),
      chunk_app_vmexe: releaseFile(softwareRoot, 'chunk/app.vmexe'),
      chunk_materializer: releaseFile(softwareRoot, 'bin/chunk-materializer'),
      chunk_openvm_config: releaseFile(softwareRoot, 'chunk/openvm.toml'),
      l2_range_app_vmexe: releaseFile(softwareRoot, 'l2-range/app.vmexe'),
      l2_range_openvm_config: releaseFile(softwareRoot, 'l2-range/openvm.toml'),
    },
    release_digest: softwareReleaseDigest,
    release_id: 'proof-test-release',
    schema: 'dogeos/proof-software-release/v1',
    schema_version: 1,
    source_revisions: {dogeos_core: '1'.repeat(40), scroll_zkvm_prover: '2'.repeat(40)},
  }
  const softwareManifest = path.join(softwareRoot, 'proof-software-release-v1.json')
  fs.writeFileSync(softwareManifest, `${JSON.stringify(release, undefined, 2)}\n`)

  const protocolContext = path.resolve('.data/protocol_context.json')
  const protocolContextDigest = sha256(fs.readFileSync(protocolContext))
  const bridgeMaterialDigest = digest('9')
  const bridge = {
    bridge_material_digest: bridgeMaterialDigest,
    files: {
      bridge_app_vmexe: releaseFile(bridgeRoot, 'bridge-state.vmexe'),
      bridge_openvm_config: releaseFile(bridgeRoot, 'openvm.toml'),
      l2_range_app_vmexe: releaseFile(bridgeRoot, 'l2-range/app.vmexe'),
      l2_range_openvm_config: releaseFile(bridgeRoot, 'l2-range/openvm.toml'),
      native_staged_manifest: releaseFile(bridgeRoot, 'bridge-state-artifact-v1.json'),
    },
    genesis_sequencer_outpoint_index: 0,
    genesis_state_hash: hex32('a'),
    identities: {
      bridge: {
        app_commit_raw: hex64('b'),
        program_commitment_hash: hex32('c'),
        verification_key_hash: hex32('d'),
      },
      l2_range: l2Range,
    },
    openvm_version: release.build.openvm_version,
    protocol_context_sha256: protocolContextDigest,
    root_verifier_asm_sha256: release.build.root_verifier_asm_sha256,
    schema: 'dogeos/proof-bridge-material/v1',
    schema_version: 1,
    software_release_digest: softwareReleaseDigest,
  }
  const bridgeManifest = path.join(bridgeRoot, 'proof-bridge-material-v1.json')
  fs.writeFileSync(bridgeManifest, `${JSON.stringify(bridge, undefined, 2)}\n`)
  fs.writeFileSync(
    path.join(resourcesRoot, 'scrollsdk-proof-production-inputs-v1.json'),
    `${JSON.stringify({
      bridge_material_digest: bridgeMaterialDigest,
      bridge_material_manifest: bridgeManifest,
      bridge_material_root: bridgeRoot,
      protocol_context: protocolContext,
      protocol_context_sha256: protocolContextDigest,
      release_id: release.release_id,
      resources_root: resourcesRoot,
      schema: 'scrollsdk/proof-production-inputs/v1',
      schema_version: 1,
      software_release_digest: softwareReleaseDigest,
      software_release_manifest: softwareManifest,
      software_release_root: softwareRoot,
    }, undefined, 2)}\n`,
  )
  return {
    bridgeManifest: 'bridge/proof-bridge-material-v1.json',
    bridgeMaterialDigest,
    bridgeRoot: 'bridge',
    resourcesRoot: '.data/proof-production',
    softwareManifest: 'software/proof-software-release-v1.json',
    softwareReleaseDigest,
    softwareRoot: 'software',
  }
}

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
    digest: digest(suffix),
    repository: 'dogeos69/test-image',
  })
  const productionRelease = mode === 'production' ? writeProductionInputs(image) : undefined
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
              chunkWitnessRpcUrl: 'https://l2-rpc.example.com',
              chunkWitnessSource: 'rpc',
            },
            release: productionRelease,
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
    fs.renameSync(
      '.data/proof-production/software/keys/agg-vk.bin',
      '.data/proof-production/software/keys/real-agg-vk.bin',
    )
    fs.symlinkSync(
      'real-agg-vk.bin',
      '.data/proof-production/software/keys/agg-vk.bin',
    )
    const {error} = await runCommand(commandArgs())
    expect(error?.message).to.include('must be a regular non-symlink file')
  })
})
