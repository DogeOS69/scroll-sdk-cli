import {expect} from 'chai'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {
  ProofDeploymentReleaseLockV1,
  ProofReleaseImportV1,
  ProofSoftwareReleaseV1,
} from '../../src/types/proof-release.js'

import {
  PROOF_DEPLOYMENT_RELEASE_LOCK_SCHEMA,
  PROOF_RELEASE_IMPORT_SCHEMA,
  PROOF_SOFTWARE_RELEASE_SCHEMA,
} from '../../src/types/proof-release.js'
import {
  PROOF_DEPLOYMENT_RELEASE_LOCK,
  PROOF_RELEASE_IMPORT_RECEIPT,
  discoverPreparedProofRelease,
  immutableProofImageReference,
  listPreparedProofReleaseLocks,
  prepareProofRelease,
  readPreparedProofRelease,
  readProofDeploymentReleaseLock,
  verifyProofTopologyReleaseBinding,
} from '../../src/utils/proof-release.js'
import {buildProofTopologyFromRelease} from '../../src/utils/proof-topology-init.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`
const hex32 = (character: string) => `0x${character.repeat(64)}`
const hex64 = (character: string) => `0x${character.repeat(128)}`

export function preparedReleaseFixture(deployment: string) {
  const root = path.join(deployment, '.data/proof-releases/release-fixture')
  const softwareRoot = path.join(root, 'software')
  const bridgeRoot = path.join(root, 'bridge')
  fs.mkdirSync(softwareRoot, {recursive: true})
  fs.mkdirSync(bridgeRoot, {recursive: true})
  const files = {
    aggregate_verification_key: 'software/keys/agg-vk.bin',
    batch_app_vmexe: 'software/batch/app.vmexe',
    batch_materializer: 'software/bin/scroll-runtime-materializer',
    batch_openvm_config: 'software/batch/openvm.toml',
    bridge_app_vmexe: 'bridge/bridge-state.vmexe',
    bridge_openvm_config: 'bridge/openvm.toml',
    chunk_app_vmexe: 'software/chunk/app.vmexe',
    chunk_materializer: 'software/bin/materialize-chunk-oneshot',
    chunk_openvm_config: 'software/chunk/openvm.toml',
    l2_range_app_vmexe: 'software/l2-range/app.vmexe',
    l2_range_openvm_config: 'software/l2-range/openvm.toml',
  }
  for (const relative of Object.values(files)) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, relative)
  }

  const scroll = {
    program_commitment_hash: hex32('1'),
    program_commitment_le_raw: hex64('2'),
    verification_key_hash: hex32('3'),
  }
  const batch = {...scroll, recursive_app_commit_raw: hex64('4')}
  const openvm = {
    app_commit_raw: hex64('5'),
    program_commitment_hash: hex32('6'),
    verification_key_hash: hex32('7'),
  }
  const images = {
    bridge_artifact_baker: {digest: digest('d'), repository: 'dogeos69/proof-artifact-baker'},
    mock_worker: {digest: digest('b'), repository: 'dogeos69/prover-worker-mock'},
    production_worker: {digest: digest('c'), repository: 'dogeos69/prover-worker'},
    topology_compiler: {digest: digest('a'), repository: 'dogeos69/dogeos-proof-topology'},
  }
  const file = (relative: string) => ({path: relative, sha256: digest('e'), size_bytes: 1})
  const release: ProofSoftwareReleaseV1 = {
    build: {
      openvm_version: '1.7.0',
      root_verifier_asm_sha256: hex32('8'),
      rust_toolchain: 'nightly-2026-03-17',
    },
    identities: {
      aggregate_verification_key_hash: hex32('7'),
      batch,
      chunk: scroll,
      l2_range: openvm,
    },
    images,
    materials: {
      aggregate_verification_key: file('keys/agg-vk.bin'),
      batch_app_vmexe: file('batch/app.vmexe'),
      batch_materializer: file('bin/scroll-runtime-materializer'),
      batch_openvm_config: file('batch/openvm.toml'),
      chunk_app_vmexe: file('chunk/app.vmexe'),
      chunk_materializer: file('bin/materialize-chunk-oneshot'),
      chunk_openvm_config: file('chunk/openvm.toml'),
      l2_range_app_vmexe: file('l2-range/app.vmexe'),
      l2_range_openvm_config: file('l2-range/openvm.toml'),
    },
    release_digest: digest('f'),
    release_id: 'proof-test-release',
    schema: PROOF_SOFTWARE_RELEASE_SCHEMA,
    schema_version: 1,
    source_revisions: {dogeos_core: '1'.repeat(40), scroll_zkvm_prover: '2'.repeat(40)},
  }
  const softwareManifest = path.join(softwareRoot, 'proof-software-release-v1.json')
  fs.writeFileSync(softwareManifest, `${JSON.stringify(release, undefined, 2)}\n`)
  const bridgeManifest = path.join(bridgeRoot, 'proof-bridge-material-v1.json')
  fs.writeFileSync(bridgeManifest, '{}\n')
  const lock: ProofDeploymentReleaseLockV1 = {
    bridge_material_digest: digest('9'),
    bridge_material_manifest: bridgeManifest,
    bridge_material_root: bridgeRoot,
    lock_digest: digest('8'),
    projection: {
      ...Object.fromEntries(Object.entries(files).map(([key, relative]) => [key, path.join(root, relative)])),
      identities: {
        aggregate_verification_key_hash: hex32('7'),
        batch,
        bridge: openvm,
        chunk: scroll,
        l2_range: openvm,
      },
      images,
    } as ProofDeploymentReleaseLockV1['projection'],
    schema: PROOF_DEPLOYMENT_RELEASE_LOCK_SCHEMA,
    schema_version: 1,
    software_release_digest: release.release_digest,
    software_release_manifest: softwareManifest,
    software_release_root: softwareRoot,
  }
  const lockPath = path.join(root, PROOF_DEPLOYMENT_RELEASE_LOCK)
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, undefined, 2)}\n`)
  const protocolContext = path.join(deployment, '.data/protocol_context.json')
  fs.mkdirSync(path.dirname(protocolContext), {recursive: true})
  fs.writeFileSync(protocolContext, '{"network":"testnet"}\n')
  const contextDigest = `sha256:${createHash('sha256').update(fs.readFileSync(protocolContext)).digest('hex')}`
  const receipt: ProofReleaseImportV1 = {
    deployment_lock: lockPath,
    deployment_lock_digest: lock.lock_digest,
    protocol_context: protocolContext,
    protocol_context_sha256: contextDigest,
    release_id: release.release_id,
    release_image: `dogeos69/proof-release@${digest('7')}`,
    schema: PROOF_RELEASE_IMPORT_SCHEMA,
    schema_version: 1,
    software_release_digest: release.release_digest,
  }
  fs.writeFileSync(
    path.join(root, PROOF_RELEASE_IMPORT_RECEIPT),
    `${JSON.stringify(receipt, undefined, 2)}\n`,
  )
  return readPreparedProofRelease(lockPath)
}

describe('official proof release deployment lock', () => {
  let deployment: string

  beforeEach(() => {
    deployment = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-release-'))
  })

  afterEach(() => fs.rmSync(deployment, {force: true, recursive: true}))

  it('requires immutable OCI release references', () => {
    expect(immutableProofImageReference(`dogeos69/proof-release@${digest('a')}`))
      .to.equal(`dogeos69/proof-release@${digest('a')}`)
    expect(() => immutableProofImageReference('dogeos69/proof-release:latest'))
      .to.throw('repository@sha256')
  })

  it('makes the staging root traversable by root-remapped Docker containers', async () => {
    const dataDir = path.join(deployment, '.data')
    fs.mkdirSync(dataDir, {recursive: true})
    fs.writeFileSync(path.join(dataDir, 'protocol_context.json'), '{"network":"testnet"}\n')
    let observedMode: number | undefined

    let failure: unknown
    try {
      await prepareProofRelease({
        deploymentDir: deployment,
        async imagePuller(imageReference, platform) {
          expect(imageReference).to.equal(`dogeos69/proof-release@${digest('7')}`)
          expect(platform).to.equal('linux/amd64')
          const releasesRoot = path.join(dataDir, 'proof-releases')
          const staging = fs.readdirSync(releasesRoot)
            .find(entry => entry.includes('.preparing-'))
          expect(staging).to.be.a('string')
          observedMode = fs.statSync(path.join(releasesRoot, staging!)).mode % 0o1000
          throw new Error('expected test stop')
        },
        releaseImage: `dogeos69/proof-release@${digest('7')}`,
      })
    } catch (error) {
      failure = error
    }

    expect(failure).to.be.instanceOf(Error)
    expect((failure as Error).message).to.equal('expected test stop')
    expect(observedMode).to.equal(0o755)
    expect(fs.readdirSync(path.join(dataDir, 'proof-releases'))).to.deep.equal([])
  })

  it('discovers and reads one prepared deployment lock', () => {
    const prepared = preparedReleaseFixture(deployment)
    expect(discoverPreparedProofRelease(deployment)).to.equal(prepared.lockPath)
    expect(prepared.release.schema).to.equal(PROOF_SOFTWARE_RELEASE_SCHEMA)
    expect(prepared.lock.schema).to.equal(PROOF_DEPLOYMENT_RELEASE_LOCK_SCHEMA)
  })

  it('lists multiple imports while requiring explicit lock selection from consumers', () => {
    const prepared = preparedReleaseFixture(deployment)
    const second = path.join(deployment, '.data/proof-releases/second')
    fs.mkdirSync(second, {recursive: true})
    fs.copyFileSync(prepared.lockPath, path.join(second, PROOF_DEPLOYMENT_RELEASE_LOCK))

    expect(listPreparedProofReleaseLocks(deployment)).to.have.length(2)
    expect(() => discoverPreparedProofRelease(deployment))
      .to.throw('multiple prepared proof releases found')
  })

  it('rejects unknown deployment-lock fields', () => {
    const prepared = preparedReleaseFixture(deployment)
    const raw = JSON.parse(fs.readFileSync(prepared.lockPath, 'utf8')) as Record<string, unknown>
    raw.typo = true
    fs.writeFileSync(prepared.lockPath, JSON.stringify(raw))
    expect(() => readProofDeploymentReleaseLock(prepared.lockPath)).to.throw('.typo is not supported')
  })

  it('rejects a changed protocol context', () => {
    const prepared = preparedReleaseFixture(deployment)
    fs.appendFileSync(prepared.receipt.protocol_context, 'changed')
    expect(() => readPreparedProofRelease(prepared.lockPath))
      .to.throw('protocol context changed after proof release preparation')
  })

  it('builds staged mock and production profiles from the authoritative projection', () => {
    const prepared = preparedReleaseFixture(deployment)
    const topology = buildProofTopologyFromRelease({
      artifactStore: {
        bucket: 'dogeos-testnet-proof-artifacts',
        endpointUrl: 'https://s3.us-west-2.amazonaws.com',
        keyPrefix: 'proof-topology',
        kind: 's3_compatible',
        region: 'us-west-2',
      },
      deploymentDir: deployment,
      deploymentName: 'dogeos-testnet',
      mode: 'mock',
      productionWorkerLaunch: 'external',
      release: prepared,
      runtime: {
        proofCoordinatorPublicUrl: 'https://proof-coordinator.example.com',
        rpcWitnessUrl: 'https://l2-rpc.example.com',
        witnessSource: 'rpc',
      },
    })
    expect(topology.mode).to.equal('mock')
    expect(topology.mock?.profile).to.equal('withdrawal_mock_prover')
    expect(topology.mock?.realScroll).to.equal(undefined)
    expect(topology.production?.profile).to.equal('real_scroll_withdrawal_full_topology')
    expect(topology.production?.realScroll.resourcesRoot).to.include('.data/proof-releases')
    expect(topology.deployment?.bridgeStagedAppExe).to.equal('bridge/bridge-state.vmexe')
    expect(() => verifyProofTopologyReleaseBinding(topology, prepared, deployment)).not.to.throw()
  })

  it('rejects topology paths that diverge from the release lock', () => {
    const prepared = preparedReleaseFixture(deployment)
    const topology = buildProofTopologyFromRelease({
      artifactStore: {
        bucket: 'proofs',
        endpointUrl: 'https://s3.us-west-2.amazonaws.com',
        keyPrefix: 'proof-topology',
        kind: 's3_compatible',
        region: 'us-west-2',
      },
      deploymentDir: deployment,
      deploymentName: 'dogeos-testnet',
      productionWorkerLaunch: 'external',
      release: prepared,
      runtime: {
        proofCoordinatorPublicUrl: 'https://proof-coordinator.example.com',
        rpcWitnessUrl: 'https://l2-rpc.example.com',
        witnessSource: 'rpc',
      },
    })
    topology.production!.realScroll.chunkAppExe = 'software/wrong.vmexe'
    expect(() => verifyProofTopologyReleaseBinding(topology, prepared, deployment))
      .to.throw('chunkAppExe does not match release lock')
  })

  it('rejects topology identities and Bridge paths that diverge from the release lock', () => {
    const prepared = preparedReleaseFixture(deployment)
    const build = () => buildProofTopologyFromRelease({
      artifactStore: {
        bucket: 'proofs',
        endpointUrl: 'https://s3.us-west-2.amazonaws.com',
        keyPrefix: 'proof-topology',
        kind: 's3_compatible' as const,
        region: 'us-west-2',
      },
      deploymentDir: deployment,
      deploymentName: 'dogeos-testnet',
      productionWorkerLaunch: 'external' as const,
      release: prepared,
      runtime: {
        proofCoordinatorPublicUrl: 'https://proof-coordinator.example.com',
        rpcWitnessUrl: 'https://l2-rpc.example.com',
        witnessSource: 'rpc' as const,
      },
    })
    const changedIdentity = build()
    changedIdentity.production!.realScroll.bridgeAppCommitRawHex = hex64('a')
    expect(() => verifyProofTopologyReleaseBinding(changedIdentity, prepared, deployment))
      .to.throw('bridgeAppCommitRawHex does not match release lock')

    const changedBridgePath = build()
    changedBridgePath.deployment!.bridgeStagedAppExe = 'software/chunk/app.vmexe'
    expect(() => verifyProofTopologyReleaseBinding(changedBridgePath, prepared, deployment))
      .to.throw('bridgeStagedAppExe does not match release lock')
  })
})
