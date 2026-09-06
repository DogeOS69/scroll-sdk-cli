import * as toml from '@iarna/toml'
import {expect} from 'chai'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {resolveProofIntent} from '../../src/utils/proof-intent.js'
import {
  prepareProofMaterials,
  readProofMaterials,
} from '../../src/utils/proof-materials.js'
import {renderProofTopologySource} from '../../src/utils/proof-topology-compiler.js'
import {buildProofTopology} from '../../src/utils/proof-topology-init.js'

function sha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function proofImage(character: string, repository: string) {
  return {digest: `sha256:${character.repeat(64)}`, repository}
}

describe('PR #937 two-switch proof adapter', () => {
  let root: string
  let mockWorkerIdentity: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollsdk-proof-two-switch-'))
    mockWorkerIdentity = path.join(root, 'mock-worker-identity.json')
    const aggregationRaw = `0x${'1'.repeat(128)}`
    fs.writeFileSync(mockWorkerIdentity, JSON.stringify({
      batch_aggregation_guest: {
        app_commit_raw: aggregationRaw,
        app_exe_commit: '1'.repeat(64),
        app_vm_commit: '1'.repeat(64),
        embedded_inner_batch_app_commit_raw: `0x${'0'.repeat(128)}`,
        program_commitment_hash: `0x${createHash('sha256').update(Buffer.from(aggregationRaw.slice(2), 'hex')).digest('hex')}`,
      },
      batch_guest: {
        app_commit_raw: `0x${'0'.repeat(128)}`,
        app_exe_commit: '0'.repeat(64),
        app_vm_commit: '0'.repeat(64),
      },
      guest_openvm_toml_sha256: `0x${'2'.repeat(64)}`,
      image_revision: 'test-revision',
      openvm_version: '1.7',
      root_verifier_asm_sha256: `0x${'3'.repeat(64)}`,
    }))
  })

  afterEach(() => {
    fs.rmSync(root, {force: true, recursive: true})
  })

  it('imports allow-listed identities and renders explicit mode/generation/enforcement', () => {
    const producer = path.join(root, 'producer')
    fs.mkdirSync(producer)
    const files = {
      batch_openvm_toml: path.join(producer, 'batch-openvm.toml'),
      batch_vmexe: path.join(producer, 'batch.vmexe'),
      chunk_openvm_toml: path.join(producer, 'chunk-openvm.toml'),
      chunk_vmexe: path.join(producer, 'chunk.vmexe'),
      root_agg_verifying_key: path.join(producer, 'root-vk'),
    }
    for (const [name, filePath] of Object.entries(files)) fs.writeFileSync(filePath, name)
    const manifest = path.join(root, 'producer.json')
    fs.writeFileSync(manifest, JSON.stringify({
      artifacts: Object.fromEntries(Object.entries(files).map(([name, filePath]) => [name, {
        path: filePath,
        sha256: sha256(filePath),
        size_bytes: fs.statSync(filePath).size,
      }])),
      dogeos_core_commit: 'core-revision',
      producer: {commit: 'producer-revision'},
      toolchain: {openvm_tag: 'v1.4.0', rust: 'nightly-test'},
    }))
    const hex32 = (character: string) => `0x${character.repeat(64)}`
    const hex64 = (character: string) => `0x${character.repeat(128)}`
    const identityEnv = path.join(root, 'identity.env')
    fs.writeFileSync(identityEnv, [
      `export DOGEOS_BATCH_AGGREGATION_PROGRAM_COMMITMENT_RAW=${hex64('1')}`,
      `export DOGEOS_BATCH_PROGRAM_COMMITMENT=${hex32('2')}`,
      `export DOGEOS_BATCH_PROGRAM_COMMITMENT_RAW=${hex64('3')}`,
      `export DOGEOS_BATCH_SCROLL_PROGRAM_COMMITMENT_RAW=${hex64('4')}`,
      `export DOGEOS_BATCH_VK_HASH=${hex32('5')}`,
      `export DOGEOS_BRIDGE_APP_COMMIT_RAW=${hex64('6')}`,
      `export DOGEOS_BRIDGE_PROGRAM_COMMITMENT=${hex32('7')}`,
      `export DOGEOS_BRIDGE_VK_HASH=${hex32('8')}`,
      `export DOGEOS_CHUNK_PROGRAM_COMMITMENT=${hex32('9')}`,
      `export DOGEOS_CHUNK_PROGRAM_COMMITMENT_RAW=${hex64('a')}`,
      `export DOGEOS_CHUNK_VK_HASH=${hex32('b')}`,
      '',
    ].join('\n'))
    const chunkMaterializer = path.join(root, 'chunk-materializer')
    const batchMaterializer = path.join(root, 'batch-materializer')
    fs.writeFileSync(chunkMaterializer, 'chunk materializer')
    fs.writeFileSync(batchMaterializer, 'batch materializer')
    const image = (character: string, repository: string) => ({
      digest: `sha256:${character.repeat(64)}`,
      repository,
    })
    const prepared = prepareProofMaterials({
      batchMaterializer,
      chunkMaterializer,
      deploymentDir: root,
      generation: 'real',
      identityEnv,
      images: {
        mockWorker: image('c', 'dogeos69/prover-worker-mock'),
        topologyCompiler: image('e', 'dogeos69/dogeos-proof-topology'),
      },
      mockWorkerIdentity,
      producerManifest: manifest,
    })

    expect(prepared.receipt.software.identities.bridge.appCommitRaw).to.equal(hex64('6'))
    const topology = buildProofTopology({
      artifactStore: {
        bucket: 'proof-bucket',
        endpointUrl: 'https://s3.us-east-1.amazonaws.com',
        kind: 's3_compatible',
        region: 'us-east-1',
      },
      deploymentName: 'dogeos-test',
      materials: prepared.receipt,
      runtime: {
        artifactKeyPrefix: 'proof-topology',
        proofCoordinatorPublicUrl: 'https://proof-coordinator.example.com',
        publicS3EndpointUrl: 'https://s3.us-east-1.amazonaws.com',
        rpcWitnessUrl: 'https://l2-rpc.example.com',
      },
    })
    const source = toml.parse(renderProofTopologySource(topology, root)) as {
      proof_topology: Record<string, unknown>
    }
    expect(source.proof_topology).to.include({
      enforcement: 'observe',
      generation: 'mock',
      mode: 'disabled',
    })
    expect(source.proof_topology).to.have.property('active')
    expect(source.proof_topology).not.to.have.property('mock')
    expect(source.proof_topology).not.to.have.property('production')
    expect(topology.deployment).not.to.have.property('productionWorkerImage')
    expect(topology.deployment).not.to.have.property('artifactLocalRoot')
    expect(topology.active?.profile).to.equal('withdrawal_mock_prover_real_materialize')

    const stagedRealProfile = {
      ...topology,
      active: {...topology.active!, profile: 'real_scroll_withdrawal_full_topology' as const},
      mode: 'active' as const,
    }
    const configPath = path.join(root, 'doge-config.toml')
    fs.writeFileSync(configPath, toml.stringify({network: 'testnet', proof_topology: stagedRealProfile} as unknown as toml.JsonMap))
    expect(resolveProofIntent({deploymentDir: root, dogeConfigPath: configPath, required: true})?.intent)
      .to.deep.equal({enforcement: 'observe', generation: 'mock', mode: 'active'})

    fs.writeFileSync(configPath, toml.stringify({
      network: 'testnet',
      proof_topology: {
        ...stagedRealProfile,
        deployment: {
          ...stagedRealProfile.deployment,
          artifactLocalRoot: '/operator-selected/path',
        },
      },
    } as unknown as toml.JsonMap))
    expect(() => resolveProofIntent({deploymentDir: root, dogeConfigPath: configPath, required: true}))
      .to.throw('proof_topology.deployment.artifactLocalRoot is not supported')

    fs.writeFileSync(configPath, toml.stringify({
      network: 'testnet',
      proof_topology: {...stagedRealProfile, generation: 'real'},
    } as unknown as toml.JsonMap))
    expect(() => resolveProofIntent({deploymentDir: root, dogeConfigPath: configPath, required: true}))
      .to.throw('real generation requires deployment.productionWorkerImage')
  })

  it('detects imported material drift before topology compilation', () => {
    const materialRoot = path.join(root, '.data/proof-materials/software')
    fs.mkdirSync(materialRoot, {recursive: true})
    const file = path.join(materialRoot, 'artifact')
    fs.writeFileSync(file, 'original')
    const entry = {
      path: path.relative(root, file),
      sha256: sha256(file),
      sizeBytes: fs.statSync(file).size,
    }
    const identity = {
      appCommitRaw: `0x${'1'.repeat(128)}`,
      programCommitmentHash: `0x${createHash('sha256').update(Buffer.from('1'.repeat(128), 'hex')).digest('hex')}`,
      verificationKeyHash: `0x${'2'.repeat(64)}`,
    }
    const receiptPath = path.join(root, '.data/proof-materials-v1.json')
    fs.writeFileSync(receiptPath, JSON.stringify({
      generatedAt: new Date(0).toISOString(),
      images: {
        mockWorker: {digest: `sha256:${'3'.repeat(64)}`, repository: 'mock'},
        productionWorker: {digest: `sha256:${'4'.repeat(64)}`, repository: 'real'},
        topologyCompiler: {digest: `sha256:${'5'.repeat(64)}`, repository: 'compiler'},
      },
      schema: 'scrollsdk/proof-materials/v1',
      schemaVersion: 1,
      software: {
        artifacts: {
          aggregateVerifyingKey: entry,
          batchAppConfig: entry,
          batchAppExe: entry,
          batchMaterializer: entry,
          chunkAppConfig: entry,
          chunkAppExe: entry,
          chunkMaterializer: entry,
        },
        identities: {batch: identity, bridge: identity, chunk: identity, l2Range: identity},
        identitySource: 'real_identity_probe',
        openvmVersion: 'v1',
        rustToolchain: 'nightly',
        sourceRevisions: {dogeosCore: 'core', scrollZkvmProver: 'producer'},
      },
    }))
    expect(() => readProofMaterials(receiptPath, root)).not.to.throw()
    fs.writeFileSync(file, 'changed')
    expect(() => readProofMaterials(receiptPath, root)).to.throw('content drift')
  })

  it('prepares and renders mock topology from shared identities without real proving files', () => {
    const hex64 = (character: string) => `0x${character.repeat(128)}`
    const image = (character: string, repository: string) => ({
      digest: `sha256:${character.repeat(64)}`,
      repository,
    })
    const prepared = prepareProofMaterials({
      deploymentDir: root,
      generation: 'mock',
      images: {
        mockWorker: image('c', 'dogeos69/prover-worker-mock'),
        topologyCompiler: image('e', 'dogeos69/dogeos-proof-topology'),
      },
      mockWorkerIdentity,
    })

    expect(prepared.receipt.software.artifacts).to.equal(undefined)
    expect(prepared.receipt.software.compilerIdentity).to.include({
      path: '.data/proof-materials/software/identity/worker-identity.json',
    })
    expect(prepared.receipt.software.identitySource).to.equal('dogeos_core_synthetic_mock_v1')
    expect(fs.existsSync(path.join(root, '.data/proof-materials/software/identity/worker-identity.json'))).to.equal(true)
    const reloaded = readProofMaterials(prepared.receiptPath, root)
    const topology = buildProofTopology({
      artifactStore: {
        bucket: 'proof-bucket',
        endpointUrl: 'https://s3.us-east-1.amazonaws.com',
        kind: 's3_compatible',
        region: 'us-east-1',
      },
      deploymentName: 'dogeos-test',
      generation: 'mock',
      materials: reloaded,
      mode: 'active',
      runtime: {
        proofCoordinatorPublicUrl: 'https://proof-coordinator.example.com',
        workerLaunch: 'external',
      },
    })
    const source = toml.parse(renderProofTopologySource(topology, root)) as {
      proof_topology: {active: {real_scroll: Record<string, unknown>; worker_launch: string}}
    }
    expect(topology.active?.profile).to.equal('withdrawal_mock_prover')
    expect(source.proof_topology.active.worker_launch).to.equal('external')
    expect(source.proof_topology.active.real_scroll).to.include({
      batch_program_commitment_hex: hex64('8'),
      chunk_program_commitment_hex: hex64('3'),
    })
    expect(source.proof_topology.active.real_scroll).not.to.have.any.keys(
      'agg_verifying_key_path',
      'batch_app_exe',
      'batch_materializer_binary_path',
      'chunk_app_exe',
      'chunk_materializer_binary_path',
      'l2_range_aggregation_app_commit_raw_hex',
      'l2_range_aggregation_program_commitment_hash_hex',
    )
    expect(source.proof_topology.active.real_scroll).to.have.property(
      'l2_range_aggregation_verification_key_hash_hex',
    )

    const receipt = JSON.parse(fs.readFileSync(prepared.receiptPath, 'utf8')) as {
      software: {identities: {chunk: {verificationKeyHash: string}}}
    }
    receipt.software.identities.chunk.verificationKeyHash = `0x${'2'.repeat(64)}`
    fs.writeFileSync(prepared.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
    expect(() => readProofMaterials(prepared.receiptPath, root)).to.throw(
      'Synthetic mock proof identities differ from the dogeos-core PR #937 fixture table',
    )
  })

  it('selects real segmentation and materializers for mock proving with imported real identities', () => {
    const hex32 = (character: string) => `0x${character.repeat(64)}`
    const hex64 = (character: string) => `0x${character.repeat(128)}`
    const identityEnv = path.join(root, 'real-identity.env')
    fs.writeFileSync(identityEnv, [
      `export DOGEOS_BATCH_AGGREGATION_PROGRAM_COMMITMENT_RAW=${hex64('1')}`,
      `export DOGEOS_BATCH_PROGRAM_COMMITMENT=${hex32('2')}`,
      `export DOGEOS_BATCH_PROGRAM_COMMITMENT_RAW=${hex64('3')}`,
      `export DOGEOS_BATCH_SCROLL_PROGRAM_COMMITMENT_RAW=${hex64('4')}`,
      `export DOGEOS_BATCH_VK_HASH=${hex32('5')}`,
      `export DOGEOS_BRIDGE_APP_COMMIT_RAW=${hex64('6')}`,
      `export DOGEOS_BRIDGE_PROGRAM_COMMITMENT=${hex32('7')}`,
      `export DOGEOS_BRIDGE_VK_HASH=${hex32('8')}`,
      `export DOGEOS_CHUNK_PROGRAM_COMMITMENT=${hex32('9')}`,
      `export DOGEOS_CHUNK_PROGRAM_COMMITMENT_RAW=${hex64('a')}`,
      `export DOGEOS_CHUNK_VK_HASH=${hex32('b')}`,
      '',
    ].join('\n'))
    const prepared = prepareProofMaterials({
      deploymentDir: root,
      generation: 'mock',
      identityEnv,
      images: {
        mockWorker: proofImage('c', 'dogeos69/prover-worker-mock'),
        topologyCompiler: proofImage('e', 'dogeos69/dogeos-proof-topology'),
      },
      mockWorkerIdentity,
    })

    expect(prepared.receipt.software.artifacts).to.equal(undefined)
    expect(prepared.receipt.software.identitySource).to.equal('real_identity_probe')
    const topology = buildProofTopology({
      artifactStore: {
        bucket: 'proof-bucket',
        endpointUrl: 'https://s3.us-east-1.amazonaws.com',
        kind: 's3_compatible',
        region: 'us-east-1',
      },
      deploymentName: 'dogeos-test',
      generation: 'mock',
      materials: prepared.receipt,
      mode: 'active',
      runtime: {
        proofCoordinatorPublicUrl: 'https://proof-coordinator.example.com',
        rpcWitnessUrl: 'https://l2-rpc.example.com',
        witnessSource: 'rpc',
      },
    })

    expect(topology.generation).to.equal('mock')
    expect(topology.enforcement).to.equal('observe')
    expect(topology.active?.profile).to.equal('withdrawal_mock_prover_real_materialize')
    expect(topology.active?.realScroll).not.to.have.property('chunkAppExe')
    expect(topology.active?.realScroll).not.to.have.property('batchAppExe')
  })

  it('refreshes explicit mock image pins without replacing prepared identities or files', () => {
    const prepared = prepareProofMaterials({
      deploymentDir: root,
      generation: 'mock',
      images: {
        mockWorker: proofImage('1', 'dogeos69/prover-worker-mock'),
        topologyCompiler: proofImage('2', 'dogeos69/dogeos-proof-topology'),
      },
      mockWorkerIdentity,
    })
    const marker = path.join(root, '.data/proof-materials/operator-marker')
    fs.writeFileSync(marker, 'preserve')

    const refreshed = prepareProofMaterials({
      deploymentDir: root,
      generation: 'mock',
      images: {
        mockWorker: proofImage('3', 'dogeos69/prover-worker-mock'),
        topologyCompiler: proofImage('4', 'dogeos69/dogeos-proof-topology'),
      },
      mockWorkerIdentity,
      refreshExistingImages: true,
    })

    expect(refreshed.receipt.images.mockWorker.digest).to.equal(`sha256:${'3'.repeat(64)}`)
    expect(refreshed.receipt.images.topologyCompiler.digest).to.equal(`sha256:${'4'.repeat(64)}`)
    expect(refreshed.receipt.software).to.deep.equal(prepared.receipt.software)
    expect(fs.readFileSync(marker, 'utf8')).to.equal('preserve')
    expect(readProofMaterials(refreshed.receiptPath, root).images).to.deep.equal(refreshed.receipt.images)
  })

  it('refuses implicit or incomplete replacement of existing proof materials', () => {
    const options = {
      deploymentDir: root,
      generation: 'mock' as const,
      images: {
        mockWorker: proofImage('1', 'dogeos69/prover-worker-mock'),
        topologyCompiler: proofImage('2', 'dogeos69/dogeos-proof-topology'),
      },
      mockWorkerIdentity,
    }
    prepareProofMaterials(options)
    expect(() => prepareProofMaterials(options)).to.throw(
      'mock image refresh requires explicit --compiler-image and --mock-worker-image',
    )

    fs.rmSync(path.join(root, '.data/proof-materials-v1.json'))
    expect(() => prepareProofMaterials({...options, refreshExistingImages: true})).to.throw(
      'both the material directory and receipt are required',
    )
  })
})
