import * as toml from '@iarna/toml'
import {expect} from 'chai'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {ProofMaterialsV1} from '../../src/types/proof-materials.js'

import {prepareProofMaterials, readProofMaterials} from '../../src/utils/proof-materials.js'
import {renderProofTopologySource} from '../../src/utils/proof-topology-compiler.js'
import {buildProofTopology} from '../../src/utils/proof-topology-init.js'

const raw = (character: string) => `0x${character.repeat(128)}`
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const commitmentHash = (value: string) => `0x${hash(Buffer.from(value.slice(2), 'hex'))}`
const guest = (character: string) => ({
  app_commit_raw: raw(character),
  app_exe_commit: character.repeat(64),
  app_vm_commit: character.repeat(64),
})

function fixture(root: string) {
  const write = (relative: string, body: string) => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, body)
    return file
  }

  const artifact = (relative: string) => {
    const file = write(relative, relative)
    return {path: file, sha256: hash(relative), size_bytes: Buffer.byteLength(relative)}
  }

  const bundle = {
    batch_aggregation_guest: {
      ...guest('3'),
      embedded_inner_batch_app_commit_raw: raw('2'),
      program_commitment_hash: commitmentHash(raw('3')),
    },
    batch_guest: guest('2'),
    bridge_guest: {
      app_commit_raw: raw('4'),
      program_commitment_hash: commitmentHash(raw('4')),
      verification_key_hash: `0x${'5'.repeat(64)}`,
    },
    guest_openvm_toml_sha256: `0x${'6'.repeat(64)}`,
    image_revision: 'core-revision',
    openvm_version: '1.7',
    root_verifier_asm_sha256: `0x${'7'.repeat(64)}`,
  }
  const {bridge_guest: bridge, ...mockBundle} = bundle
  const bridgeExe = artifact('bridge/bridge-state.vmexe')
  const bridgeConfig = artifact('bridge/openvm.toml')
  const aggregationExe = artifact('bridge/batch-aggregation.vmexe')
  const aggregationConfig = artifact('bridge/batch-aggregation-openvm.toml')
  const manifest = {
    ...bridge,
    advance_l2_batch_aggregation_app_commit_raw: raw('3'),
    advance_l2_batch_aggregation_app_config_sha256: `0x${aggregationConfig.sha256}`,
    advance_l2_batch_aggregation_inner_batch_app_commit_raw: raw('2'),
    advance_l2_batch_aggregation_vmexe_sha256: `0x${aggregationExe.sha256}`,
    advance_l2_batch_aggregation_vmexe_size_bytes: aggregationExe.size_bytes,
    advance_l2_inner_batch_app_commit_raw: raw('2'),
    app_config_sha256: `0x${bridgeConfig.sha256}`,
    genesis_sequencer_outpoint_index: 0,
    genesis_state_hash: `0x${'8'.repeat(64)}`,
    openvm_version: '1.7',
    schema_version: 1,
    vmexe_sha256: `0x${bridgeExe.sha256}`,
    vmexe_size_bytes: bridgeExe.size_bytes,
  }
  const manifestPath = write('bridge/bridge-artifact-manifest.json', JSON.stringify(manifest))
  const bundlePath = write('bridge/worker-identity-bundle.json', `${JSON.stringify(bundle, null, 2)}\n`)
  const env = {
    DOGEOS_BATCH_AGGREGATION_PROGRAM_COMMITMENT_RAW: raw('3'),
    DOGEOS_BATCH_PROGRAM_COMMITMENT: commitmentHash(raw('2')),
    DOGEOS_BATCH_PROGRAM_COMMITMENT_RAW: raw('2'),
    DOGEOS_BATCH_SCROLL_PROGRAM_COMMITMENT_RAW: raw('2'),
    DOGEOS_BATCH_VK_HASH: `0x${'9'.repeat(64)}`,
    DOGEOS_BRIDGE_APP_COMMIT_RAW: bridge.app_commit_raw,
    DOGEOS_BRIDGE_PROGRAM_COMMITMENT: bridge.program_commitment_hash,
    DOGEOS_BRIDGE_VK_HASH: bridge.verification_key_hash,
    DOGEOS_CHUNK_PROGRAM_COMMITMENT: commitmentHash(raw('1')),
    DOGEOS_CHUNK_PROGRAM_COMMITMENT_RAW: raw('1'),
    DOGEOS_CHUNK_VK_HASH: `0x${'a'.repeat(64)}`,
  }
  const image = (repository: string) => ({digest: `sha256:${'b'.repeat(64)}`, repository})
  return {
    bundle,
    bundlePath,
    manifest,
    manifestPath,
    options: {
      batchMaterializer: write('batch-materializer', 'batch'),
      bridgeArtifactDir: path.join(root, 'bridge'),
      chunkMaterializer: write('chunk-materializer', 'chunk'),
      deploymentDir: root,
      generation: 'real' as const,
      identityEnv: write('identity.env', Object.entries(env).map(([key, value]) => `export ${key}=${value}`).join('\n')),
      images: {mockWorker: image('mock'), productionWorker: image('real'), topologyCompiler: image('compiler')},
      mockWorkerIdentity: write('mock-worker.json', JSON.stringify(mockBundle)),
      producerManifest: write('producer.json', JSON.stringify({
        artifacts: {
          batch_openvm_toml: artifact('software/batch.toml'),
          batch_vmexe: artifact('software/batch.vmexe'),
          chunk_openvm_toml: artifact('software/chunk.toml'),
          chunk_vmexe: artifact('software/chunk.vmexe'),
          root_agg_verifying_key: artifact('software/root-vk'),
        },
        dogeos_core_commit: 'core-revision',
        producer: {commit: 'producer-revision'},
        toolchain: {openvm_tag: 'v1.7', rust: 'nightly-test'},
      })),
      protocolContext: write('protocol_context.json', '{}'),
    },
  }
}

function topology(materials: ProofMaterialsV1) {
  return buildProofTopology({
    artifactStore: {bucket: 'proof-bucket', endpointUrl: 'https://s3.us-east-1.amazonaws.com', kind: 's3_compatible', region: 'us-east-1'},
    deploymentName: 'real-test',
    generation: 'real',
    materials,
    mode: 'active',
    runtime: {observeRealProofDeadlineMs: 1_800_000, proofCoordinatorPublicUrl: 'https://proof.example.com', rpcWitnessUrl: 'https://l2.example.com'},
  })
}

describe('real bake worker identity import', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollsdk-real-identity-'))
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('preserves the real bundle through receipt reload and selects it as the compiler input', () => {
    const input = fixture(root)
    const prepared = prepareProofMaterials(input.options)
    const receipt = readProofMaterials(prepared.receiptPath, root)
    const selected = topology(receipt)
    expect(selected.compiler.identityFilePath).to.equal('.data/proof-materials/bridge/worker-identity-bundle.json')
    expect(selected.compiler.identityFilePath).not.to.equal(receipt.bridge!.artifacts.nativeManifest.path)
    const imported = path.join(root, selected.compiler.identityFilePath!)
    expect(fs.readFileSync(imported)).to.deep.equal(fs.readFileSync(input.bundlePath))
    const source = toml.parse(renderProofTopologySource(selected, root))
    const active = (source.proof_topology as toml.JsonMap).active as toml.JsonMap
    expect(active.real_scroll).not.to.have.any.keys(
      'batch_program_commitment_hex', 'bridge_app_commit_raw_hex',
      'bridge_verification_key_hash_hex', 'l2_range_aggregation_app_commit_raw_hex',
    )
    expect(active.real_scroll).to.have.property('chunk_program_commitment_hex', raw('1'))
    fs.appendFileSync(imported, ' ')
    expect(() => readProofMaterials(prepared.receiptPath, root)).to.throw('content drift')
  })

  it('refuses legacy real receipts instead of passing the artifact manifest as an identity bundle', () => {
    const input = fixture(root)
    const prepared = prepareProofMaterials(input.options)
    delete prepared.receipt.bridge!.artifacts.workerIdentityBundle
    fs.writeFileSync(prepared.receiptPath, JSON.stringify(prepared.receipt))
    const legacy = readProofMaterials(prepared.receiptPath, root)
    expect(() => topology(legacy)).to.throw('worker-identity-bundle.json compiler input; rerun setup proof-materials')
  })

  it('uses the deployment bake Bridge commitment when the software probe used a different genesis', () => {
    const input = fixture(root)
    const env = fs.readFileSync(input.options.identityEnv, 'utf8')
      .replace(`DOGEOS_BRIDGE_APP_COMMIT_RAW=${raw('4')}`, `DOGEOS_BRIDGE_APP_COMMIT_RAW=${raw('e')}`)
      .replace(`DOGEOS_BRIDGE_PROGRAM_COMMITMENT=${commitmentHash(raw('4'))}`, `DOGEOS_BRIDGE_PROGRAM_COMMITMENT=${commitmentHash(raw('e'))}`)
    fs.writeFileSync(input.options.identityEnv, env)
    const prepared = prepareProofMaterials(input.options)
    const receipt = readProofMaterials(prepared.receiptPath, root)
    expect(receipt.software.identities.bridge.appCommitRaw).to.equal(raw('e'))
    expect(topology(receipt).active?.realScroll.bridgeAppCommitRawHex).to.equal(raw('4'))
  })

  for (const scenario of ['missing bundle', 'mock bundle', 'wrong probe', 'wrong manifest', 'placeholder batch'] as const) {
    it(`rejects a ${scenario} before publishing a receipt`, () => {
      const input = fixture(root)
      let expected: string
      switch (scenario) {
      case 'missing bundle': {
        fs.unlinkSync(input.bundlePath)
        expected = 'worker-identity-bundle.json'
        break
      }

      case 'mock bundle': {
        fs.copyFileSync(input.options.mockWorkerIdentity, input.bundlePath)
        expected = 'bridge_guest'
        break
      }

      case 'wrong probe': {
        input.bundle.bridge_guest.verification_key_hash = `0x${'c'.repeat(64)}`
        fs.writeFileSync(input.bundlePath, JSON.stringify(input.bundle))
        expected = 'does not match the identity probe'
        break
      }

      case 'wrong manifest': {
        input.manifest.app_commit_raw = raw('d')
        fs.writeFileSync(input.manifestPath, JSON.stringify(input.manifest))
        expected = 'does not match the Bridge artifact manifest'
        break
      }

      case 'placeholder batch': {
        input.bundle.batch_guest = guest('0')
        fs.writeFileSync(input.bundlePath, JSON.stringify(input.bundle))
        expected = 'all-zero mock placeholder'
        break
      }
      }

      expect(() => prepareProofMaterials(input.options)).to.throw(expected)
      expect(fs.existsSync(path.join(root, '.data/proof-materials-v1.json'))).to.equal(false)
      expect(fs.existsSync(path.join(root, '.data/proof-materials'))).to.equal(false)
    })
  }
})
