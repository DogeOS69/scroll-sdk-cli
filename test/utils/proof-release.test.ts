import {expect} from 'chai'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {
  ProofBridgeMaterialV1,
  ProofReleaseFileV1,
  ProofSoftwareReleaseV1,
} from '../../src/types/proof-release.js'

import {
  PROOF_BRIDGE_MATERIAL_SCHEMA,
  PROOF_SOFTWARE_RELEASE_SCHEMA,
} from '../../src/types/proof-release.js'
import {
  PROOF_BRIDGE_MATERIAL_MANIFEST,
  PROOF_SOFTWARE_RELEASE_MANIFEST,
  discoverPreparedProofProductionInputs,
  immutableProofImageReference,
  parseImmutableProofImageReference,
  prepareProofProductionInputs,
  readPreparedProofProductionInputs,
  readProofBridgeMaterial,
  readProofSoftwareRelease,
  verifyProductionReleaseBinding,
} from '../../src/utils/proof-release.js'
import {buildProofTopology} from '../../src/utils/proof-topology-init.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`
const hex32 = (character: string) => `0x${character.repeat(64)}`
const hex64 = (character: string) => `0x${character.repeat(128)}`

function sha256(contents: Buffer | string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

function material(root: string, relative: string): ProofReleaseFileV1 {
  const contents = Buffer.from(`fixture:${relative}`)
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), {recursive: true})
  fs.writeFileSync(target, contents)
  return {path: relative, sha256: sha256(contents), size_bytes: contents.length}
}

function sourceFixture(deployment: string): {
  bridgeManifest: string
  protocolContext: string
  release: ProofSoftwareReleaseV1
  softwareManifest: string
} {
  const sourceRoot = path.join(deployment, 'producer-output')
  const softwareRoot = path.join(sourceRoot, 'software')
  const bridgeRoot = path.join(sourceRoot, 'bridge')
  fs.mkdirSync(softwareRoot, {recursive: true})
  fs.mkdirSync(bridgeRoot, {recursive: true})
  const scrollIdentity = {
    program_commitment_hash: hex32('1'),
    program_commitment_le_raw: hex64('2'),
    verification_key_hash: hex32('3'),
  }
  const l2RangeIdentity = {
    app_commit_raw: hex64('4'),
    program_commitment_hash: hex32('5'),
    verification_key_hash: hex32('6'),
  }
  const release: ProofSoftwareReleaseV1 = {
    build: {
      openvm_version: '1.7.0',
      root_verifier_asm_sha256: hex32('7'),
      rust_toolchain: 'nightly-2026-03-17',
    },
    identities: {
      aggregate_verification_key_hash: l2RangeIdentity.verification_key_hash,
      batch: {...scrollIdentity, recursive_app_commit_raw: hex64('8')},
      chunk: scrollIdentity,
      l2_range: l2RangeIdentity,
    },
    images: {
      bridge_artifact_baker: {
        digest: digest('d'),
        repository: 'dogeos69/proof-artifact-baker',
      },
      mock_worker: {digest: digest('b'), repository: 'dogeos69/prover-worker-mock'},
      production_worker: {digest: digest('c'), repository: 'dogeos69/prover-worker'},
      topology_compiler: {
        digest: digest('a'),
        repository: 'dogeos69/dogeos-proof-topology',
      },
    },
    materials: {
      aggregate_verification_key: material(softwareRoot, 'keys/agg-vk.bin'),
      batch_app_vmexe: material(softwareRoot, 'batch/app.vmexe'),
      batch_materializer: material(softwareRoot, 'bin/scroll-runtime-materializer'),
      batch_openvm_config: material(softwareRoot, 'batch/openvm.toml'),
      chunk_app_vmexe: material(softwareRoot, 'chunk/app.vmexe'),
      chunk_materializer: material(softwareRoot, 'bin/materialize-chunk-oneshot'),
      chunk_openvm_config: material(softwareRoot, 'chunk/openvm.toml'),
      l2_range_app_vmexe: material(softwareRoot, 'l2-range/app.vmexe'),
      l2_range_openvm_config: material(softwareRoot, 'l2-range/openvm.toml'),
    },
    release_digest: digest('f'),
    release_id: 'proof-test-release',
    schema: PROOF_SOFTWARE_RELEASE_SCHEMA,
    schema_version: 1,
    source_revisions: {dogeos_core: '1'.repeat(40), scroll_zkvm_prover: '2'.repeat(40)},
  }
  const softwareManifest = path.join(softwareRoot, PROOF_SOFTWARE_RELEASE_MANIFEST)
  fs.writeFileSync(softwareManifest, `${JSON.stringify(release, undefined, 2)}\n`)

  const protocolContext = path.join(deployment, '.data/protocol_context.json')
  fs.mkdirSync(path.dirname(protocolContext), {recursive: true})
  fs.writeFileSync(protocolContext, '{"network":"testnet"}\n')
  const bridge: ProofBridgeMaterialV1 = {
    bridge_material_digest: digest('9'),
    files: {
      bridge_app_vmexe: material(bridgeRoot, 'bridge-state.vmexe'),
      bridge_openvm_config: material(bridgeRoot, 'openvm.toml'),
      l2_range_app_vmexe: material(bridgeRoot, 'l2-range/app.vmexe'),
      l2_range_openvm_config: material(bridgeRoot, 'l2-range/openvm.toml'),
      native_staged_manifest: material(bridgeRoot, 'bridge-state-artifact-v1.json'),
    },
    genesis_sequencer_outpoint_index: 0,
    genesis_state_hash: hex32('a'),
    identities: {
      bridge: {
        app_commit_raw: hex64('b'),
        program_commitment_hash: hex32('c'),
        verification_key_hash: hex32('d'),
      },
      l2_range: l2RangeIdentity,
    },
    openvm_version: release.build.openvm_version,
    protocol_context_sha256: sha256(fs.readFileSync(protocolContext)),
    root_verifier_asm_sha256: release.build.root_verifier_asm_sha256,
    schema: PROOF_BRIDGE_MATERIAL_SCHEMA,
    schema_version: 1,
    software_release_digest: release.release_digest,
  }
  const bridgeManifest = path.join(bridgeRoot, PROOF_BRIDGE_MATERIAL_MANIFEST)
  fs.writeFileSync(bridgeManifest, `${JSON.stringify(bridge, undefined, 2)}\n`)
  return {bridgeManifest, protocolContext, release, softwareManifest}
}

async function preparedFixture(deployment: string) {
  const source = sourceFixture(deployment)
  const prepared = await prepareProofProductionInputs({
    bridgeManifestPath: source.bridgeManifest,
    deploymentDir: deployment,
    protocolContextPath: source.protocolContext,
    softwareManifestPath: source.softwareManifest,
  })
  return {prepared, source}
}

function artifactStore() {
  return {
    bucket: 'dogeos-testnet-proof-artifacts',
    endpointUrl: 'https://s3.us-west-2.amazonaws.com',
    keyPrefix: 'proof-topology',
    kind: 's3_compatible' as const,
    region: 'us-west-2',
  }
}

describe('proof production inputs', () => {
  let deployment: string

  beforeEach(() => {
    deployment = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-release-'))
  })

  afterEach(() => fs.rmSync(deployment, {force: true, recursive: true}))

  it('parses only immutable image references', () => {
    const value = `dogeos69/dogeos-proof-topology@${digest('a')}`
    const parsed = parseImmutableProofImageReference(value)
    expect(immutableProofImageReference(parsed)).to.equal(value)
    expect(() => parseImmutableProofImageReference('dogeos69/dogeos-proof-topology:latest'))
      .to.throw('repository@sha256')
  })

  it('validates producer software and Bridge manifests with their files', () => {
    const fixture = sourceFixture(deployment)
    expect(readProofSoftwareRelease(fixture.softwareManifest).release_id)
      .to.equal('proof-test-release')
    expect(readProofBridgeMaterial(fixture.bridgeManifest).software_release_digest)
      .to.equal(fixture.release.release_digest)
  })

  it('builds disabled/mock topology without any release manifest', () => {
    const topology = buildProofTopology({
      artifactStore: artifactStore(),
      compilerImage: {
        digest: digest('a'),
        repository: 'dogeos69/dogeos-proof-topology',
      },
      deploymentDir: deployment,
      deploymentName: 'dogeos-testnet',
      mockWorkerImage: {digest: digest('b'), repository: 'dogeos69/prover-worker-mock'},
      mode: 'mock',
      runtime: {proofCoordinatorPublicUrl: 'https://proof-coordinator.example.com'},
    })
    expect(topology.mode).to.equal('mock')
    expect(topology.mock?.profile).to.equal('withdrawal_mock_prover')
    expect(topology.production).to.equal(undefined)
    expect(topology.deployment?.resourcesPersistentVolumeClaim).to.equal(undefined)
  })

  it('imports the two production manifests and stages both profiles', async () => {
    const {prepared} = await preparedFixture(deployment)
    expect(discoverPreparedProofProductionInputs(deployment)).to.equal(prepared.receiptPath)
    expect(readPreparedProofProductionInputs(prepared.resourcesRoot).release.release_id)
      .to.equal('proof-test-release')

    const topology = buildProofTopology({
      artifactStore: artifactStore(),
      compilerImage: prepared.release.images.topology_compiler,
      deploymentDir: deployment,
      deploymentName: 'dogeos-testnet',
      mockWorkerImage: prepared.release.images.mock_worker,
      mode: 'disabled',
      production: {inputs: prepared, workerLaunch: 'external'},
      runtime: {
        proofCoordinatorPublicUrl: 'https://proof-coordinator.example.com',
        publicS3EndpointUrl: 'https://s3.us-west-2.amazonaws.com',
        rpcWitnessUrl: 'https://l2-rpc.example.com',
        witnessSource: 'rpc',
      },
    })
    expect(topology.production?.release.softwareReleaseDigest)
      .to.equal(prepared.release.release_digest)
    expect(topology.production?.realScroll.chunkAppExe).to.equal(undefined)
    expect(topology.production).not.to.have.property('workerImage')
    expect(() => verifyProductionReleaseBinding(topology, deployment)).not.to.throw()
  })

  it('rejects changed deployment protocol context', async () => {
    const {prepared} = await preparedFixture(deployment)
    fs.appendFileSync(prepared.protocolContextPath, 'changed')
    expect(() => readPreparedProofProductionInputs(prepared.resourcesRoot))
      .to.throw('protocol context changed')
  })

  it('does not silently reuse production inputs for another protocol context', async () => {
    const {source} = await preparedFixture(deployment)
    const anotherProtocolContext = path.join(deployment, '.data/another-protocol-context.json')
    fs.writeFileSync(anotherProtocolContext, '{"network":"another-testnet"}\n')

    let error: unknown
    try {
      await prepareProofProductionInputs({
        bridgeManifestPath: source.bridgeManifest,
        deploymentDir: deployment,
        protocolContextPath: anotherProtocolContext,
        softwareManifestPath: source.softwareManifest,
      })
    } catch (error_) {
      error = error_
    }

    expect(error).to.be.instanceOf(Error)
    expect((error as Error).message).to.include(
      'do not match the requested software release and protocol context',
    )
  })

  it('rejects topology bindings that diverge from prepared inputs', async () => {
    const {prepared} = await preparedFixture(deployment)
    const topology = buildProofTopology({
      artifactStore: artifactStore(),
      compilerImage: prepared.release.images.topology_compiler,
      deploymentDir: deployment,
      deploymentName: 'dogeos-testnet',
      mockWorkerImage: prepared.release.images.mock_worker,
      production: {inputs: prepared, workerLaunch: 'external'},
      runtime: {
        proofCoordinatorPublicUrl: 'https://proof-coordinator.example.com',
        publicS3EndpointUrl: 'https://s3.us-west-2.amazonaws.com',
        rpcWitnessUrl: 'https://l2-rpc.example.com',
        witnessSource: 'rpc',
      },
    })
    topology.production!.release.bridgeMaterialDigest = digest('0')
    expect(() => verifyProductionReleaseBinding(topology, deployment))
      .to.throw('does not match the prepared two-manifest inputs')
  })
})
