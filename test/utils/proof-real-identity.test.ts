import * as toml from '@iarna/toml'
import {expect} from 'chai'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {DogeConfig} from '../../src/types/doge-config.js'
import type {ProofMaterialsV1} from '../../src/types/proof-materials.js'
import type {ProofDeploymentContract} from '../../src/utils/proof-deployment-contract.js'

import {importCubesignerPolicy} from '../../src/utils/cubesigner-policy-import.js'
import {proofEnforcementReadiness} from '../../src/utils/proof-enforcement-readiness.js'
import {prepareProofMaterials, readProofMaterials} from '../../src/utils/proof-materials.js'
import {renderProofTopologySource} from '../../src/utils/proof-topology-compiler.js'
import {buildProofTopology} from '../../src/utils/proof-topology-init.js'
import {policyReceiptFixture} from '../helpers/cubesigner-policy-receipts.js'

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
      protocolContext: write('protocol_context.json', '{}'),
      scrollArtifacts: {
        aggregateVerifyingKey: artifact('software/root-vk').path,
        batchAppConfig: artifact('software/batch.toml').path,
        batchAppExe: artifact('software/batch.vmexe').path,
        chunkAppConfig: artifact('software/chunk.toml').path,
        chunkAppExe: artifact('software/chunk.vmexe').path,
        coreRevision: 'c'.repeat(40),
      },
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

  function governedExternalPolicy() {
    const prepared = prepareProofMaterials(fixture(root).options)
    fs.mkdirSync(path.join(root, 'withdrawal-processor'), {recursive: true})
    fs.writeFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), '[proof_system]\ncorrectness_policy_transport = "bridge_proof_ref_v1"\n')
    const receipts = policyReceiptFixture(root)
    const refs = receipts.selection.policyReceipts
    fs.mkdirSync(path.join(root, '.data'), {recursive: true})
    fs.writeFileSync(path.join(root, '.data/protocol_context.json'), '{}')
    fs.writeFileSync(path.join(root, 'context.json'), '{}')
    refs.protocolContext.sha256 = `sha256:${hash('{}')}`
    const component = Buffer.from([0, 97, 115, 109, 13, 0, 1, 0])
    fs.writeFileSync(path.join(root, 'policy.wasm'), component)
    const release = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'))
    release.protocolContextSha256 = refs.protocolContext.sha256
    release.wasm.sha256 = `sha256:${hash(component)}`
    release.requiresLiveEvidence = false
    delete (refs as {liveEvidence?: unknown}).liveEvidence
    release.verifierProvenance = {
      aggregateVerifyingKeySha256: `sha256:${prepared.receipt.software.artifacts!.aggregateVerifyingKey.sha256}`,
      bridgeProgramSha256: `sha256:${prepared.receipt.bridge!.artifacts.appExe.sha256}`,
    }
    const save = () => {
      const body = JSON.stringify(release)
      fs.writeFileSync(path.join(root, 'release.json'), body)
      refs.release.sha256 = `sha256:${hash(body)}`
      const attachment = JSON.parse(fs.readFileSync(path.join(root, 'attachment.json'), 'utf8'))
      attachment.releaseSha256 = refs.release.sha256
      attachment.policyArtifactDigest = release.wasm.sha256
      const attached = JSON.stringify(attachment)
      fs.writeFileSync(path.join(root, 'attachment.json'), attached)
      refs.attachment.sha256 = `sha256:${hash(attached)}`
    }

    save()
    importCubesignerPolicy({buildScriptRevision: 'b'.repeat(40), coreRevision: release.coreRevision,
      directory: root, expectedProtocolContextSha256: hash('{}'), expectedWasmSha256: hash(component),
      run: (_command, args) => args.includes('rev-parse') ? String(args.at(-1)).replace('^{commit}', '') : '#!/bin/sh\n',
      sourceRepo: root, wasm: 'policy.wasm'})
    const contract = {enforcement: 'enforce', generation: 'real', inputs: {materials: {path: prepared.receiptPath}, protocolContext: {sha256: hash('{}')}}, mode: 'active',
      worker: {enabled: true}} as ProofDeploymentContract
    const config = {cubesigner: {...receipts.selection,
      roles: [{keys: [{key_id: 'key-1', material_id: 'material-1'}], role_id: 'role-1'}]}, network: 'mainnet'} as unknown as DogeConfig
    const check = () => proofEnforcementReadiness(root, contract, config).blockers.filter(item => item.startsWith('CubeSigner:'))
    return {check, release, save}
  }

  it('accepts a separately imported policy commit only with matching proof artifact bindings', () => {
    const input = governedExternalPolicy()
    expect(input.check()).to.deep.equal([])
    fs.rmSync(path.join(root, '.scrollsdk/inputs/cubesigner-policy/compiler.json'))
    expect(input.check().join(' ')).to.include('without a matching verified external-build import')
    // Existing releases built from the same source still work without an external selection.
    input.release.coreRevision = 'c'.repeat(40)
    input.save()
    expect(input.check()).to.deep.equal([])
  })

  it('rejects plain or absent WP transport for the governed production policy', () => {
    const input = governedExternalPolicy()
    for (const source of ['[proof_system]\ncorrectness_policy_transport = "plain"\n', '[proof_system]\n']) {
      fs.writeFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), source)
      expect(input.check().join(' ')).to.include('requires WP proof_system.correctness_policy_transport')
    }
  })

  it('rejects modified external build provenance even when governed release receipts still match', () => {
    const input = governedExternalPolicy()
    fs.appendFileSync(path.join(root, '.data/cubesigner-policy/build-receipt.json'), ' ')
    expect(input.check().join(' ')).to.include('External policy receipt digest mismatch')
  })

  it('does not expose private WP TOML in a parsing failure', () => {
    const input = governedExternalPolicy()
    fs.writeFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), 'password = NONFUNCTIONAL_PRIVATE_VALUE')
    const blockers = input.check().join(' ')
    expect(blockers).to.include('WP native configuration is missing or invalid')
    expect(blockers).not.to.include('NONFUNCTIONAL_PRIVATE_VALUE')
  })

  it('rejects a different governed Wasm than the imported component', () => {
    const input = governedExternalPolicy()
    const different = Buffer.from([0, 97, 115, 109, 13, 0, 1, 0, 0])
    fs.writeFileSync(path.join(root, 'policy.wasm'), different)
    input.release.wasm.sha256 = `sha256:${hash(different)}`
    input.release.wasm.sizeBytes = different.length
    input.save()
    expect(input.check().join(' ')).to.include('without a matching verified external-build import')
  })

  for (const field of ['bridgeProgramSha256', 'aggregateVerifyingKeySha256']) {
    it(`retains the selected proof ${field} check for external policy builds`, () => {
      const input = governedExternalPolicy()
      input.release.verifierProvenance[field] = `sha256:${'f'.repeat(64)}`
      input.save()
      expect(input.check().join(' ')).to.include('does not bind selected proof release/program/VK/context')
    })
  }

  it('rejects an external policy when its current protocol context changes', () => {
    const input = governedExternalPolicy()
    fs.writeFileSync(path.join(root, '.data/protocol_context.json'), '{"changed":true}')
    expect(input.check().join(' ')).to.include('previous Bridge')
  })

  it('keeps enforcement evidence checks independent of testnet CubeSigner transport mode', () => {
    const input = fixture(root)
    const prepared = prepareProofMaterials(input.options)
    const contract = {
      enforcement: 'enforce', generation: 'real', inputs: {materials: {path: prepared.receiptPath}, protocolContext: {sha256: hash('{}')}}, mode: 'active',
      worker: {enabled: true},
    } as ProofDeploymentContract
    const config = {cubesigner: {mode: 'transport_only', roles: []}, network: 'testnet'} as unknown as DogeConfig
    const report = proofEnforcementReadiness(root, contract, config)
    expect(report.blockers.filter(item => item.startsWith('CubeSigner:'))).to.deep.equal([])
    expect(report.ready).to.equal(false)
    expect(report.blockers.some(item => item.startsWith('Deployment kit: no published kit is recorded'))).to.equal(true)
    expect(report.blockers).to.include('Program-publication receipt is not bound to the deployment contract')
    config.network = 'mainnet'
    expect(proofEnforcementReadiness(root, contract, config).blockers.join(' ')).to.include('forbidden on mainnet')
    config.network = 'testnet'
    config.cubesigner!.mode = 'production_verifier_key_policy'
    expect(proofEnforcementReadiness(root, contract, config).blockers.join(' ')).to.include('requires release and attachment receipts')
    delete config.cubesigner!.mode
    expect(proofEnforcementReadiness(root, contract, config).blockers.join(' ')).to.include('explicit CubeSigner policy mode')
  })

  it('allows runtime topology changes while retaining publication digest, release and readback checks', () => {
    const prepared = prepareProofMaterials(fixture(root).options)
    const file = path.join(root, 'publication.json')
    const publication = {
      coreRevision: 'c'.repeat(40), proofTopologyBundleRevision: 'old-runtime-topology',
      schema: 'scrollsdk/proof-program-publication/v1',
      verification: {anonymousHttpReadback: 'passed', authenticatedS3Readback: 'passed'},
    }
    const contract = {
      enforcement: 'enforce', generation: 'real',
      inputs: {materials: {path: prepared.receiptPath}, protocolContext: {sha256: hash('{}')}, publication: {path: 'publication.json', sha256: ''}},
      mode: 'active', topology: {bundleRevision: 'new-runtime-topology'}, worker: {enabled: true},
    } as ProofDeploymentContract
    const config = {cubesigner: {mode: 'transport_only', roles: []}, network: 'testnet'} as unknown as DogeConfig
    const save = () => {
      const content = JSON.stringify(publication)
      fs.writeFileSync(file, content)
      contract.inputs!.publication!.sha256 = hash(content)
    }

    save()
    const original = proofEnforcementReadiness(root, contract, config)
    // Other missing deployment evidence still blocks readiness.
    expect(original.ready).to.equal(false)
    // This intentionally minimal receipt now lacks the canonical content evidence.
    expect(original.blockers.join(' ')).to.include('Publication content must bind exactly')
    expect(original.blockers.some(item => /revision|Evidence digest/.test(item))).to.equal(false)
    fs.appendFileSync(file, ' ')
    expect(proofEnforcementReadiness(root, contract, config).blockers.join(' ')).to.include('Evidence digest mismatch')
    publication.coreRevision = 'd'.repeat(40)
    save()
    expect(proofEnforcementReadiness(root, contract, config).blockers.join(' ')).to.include('Publication release mismatch')
    publication.coreRevision = 'c'.repeat(40)
    publication.verification.anonymousHttpReadback = 'failed'
    save()
    expect(proofEnforcementReadiness(root, contract, config).blockers.join(' ')).to.include('Publication readback evidence is incomplete')
  })

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

  it('accepts an explicitly selected real identity and rejects a different Bridge binding', () => {
    const input = fixture(root)
    const selected = path.join(root, 'selected-worker.json')
    fs.writeFileSync(selected, JSON.stringify({...input.bundle, bridge_guest: {...input.bundle.bridge_guest, verification_key_hash: `0x${'f'.repeat(64)}`}}))
    expect(() => prepareProofMaterials({...input.options, workerIdentityBundle: selected})).to.throw('does not match the identity probe')
    fs.copyFileSync(input.bundlePath, selected)
    const prepared = prepareProofMaterials({...input.options, workerIdentityBundle: selected})
    const receipt = readProofMaterials(prepared.receiptPath, root)
    expect(fs.readFileSync(path.join(root, receipt.software.compilerIdentity!.path), 'utf8')).to.equal(fs.readFileSync(selected, 'utf8'))
  })

  it('uses a versioned proof material directory as the topology resource root', () => {
    const input = fixture(root)
    const prepared = prepareProofMaterials({
      ...input.options,
      outputReceipt: path.join(root, '.data/proof-materials-release-a.json'),
      outputRoot: path.join(root, '.data/proof-materials/release-a'),
    })
    const receipt = readProofMaterials(prepared.receiptPath, root)
    const selected = topology(receipt)

    expect(selected.active?.realScroll.resourcesRoot)
      .to.equal('.data/proof-materials/release-a')
    expect(selected.compiler.identityFilePath)
      .to.equal('.data/proof-materials/release-a/bridge/worker-identity-bundle.json')
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
