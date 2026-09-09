import {expect} from 'chai'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {prepareProofMaterials, readProofMaterials, syntheticMockProofIdentities} from '../../src/utils/proof-materials.js'
import {awsS3Endpoint, buildProofTopology} from '../../src/utils/proof-topology-init.js'

const raw = (c: string) => `0x${c.repeat(128)}`
const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex')

describe('native Scroll identity import for mock materialization', () => {
  it('uses regional AWS endpoints including us-east-1 for the uploader safety probe', () => {
    expect(awsS3Endpoint('us-east-1')).to.equal('https://s3.us-east-1.amazonaws.com')
    expect(awsS3Endpoint('us-west-2')).to.equal('https://s3.us-west-2.amazonaws.com')
  })
  let root: string
  let evidence: string
  let bundle: string
  let vk: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-identity-import-'))
    evidence = path.join(root, 'scroll.json')
    bundle = path.join(root, 'worker.json')
    vk = path.join(root, 'vk')
    fs.writeFileSync(vk, 'aggregate VK')
    const family = (c: string) => ({
      program_commitment_hash: `0x${hash(Buffer.from(raw(c).slice(2), 'hex'))}`,
      program_commitment_le_raw: raw(c),
      verification_key_hash: `0x${'1'.repeat(64)}`,
    })
    fs.writeFileSync(evidence, JSON.stringify({
      artifacts: {aggregate_verification_key: {sha256: `sha256:${hash('aggregate VK')}`, size_bytes: 12}},
      batch: {...family('2'), recursive_app_commit_raw: raw('3')},
      chunk: family('4'),
      openvm_version: '1.7',
      schema: 'dogeos/proof-scroll-identities/v1',
      schema_version: 1,
    }))
    fs.writeFileSync(bundle, JSON.stringify({
      batch_aggregation_guest: {
        app_commit_raw: raw('5'), app_exe_commit: '5'.repeat(64), app_vm_commit: '5'.repeat(64),
        embedded_inner_batch_app_commit_raw: raw('3'),
        program_commitment_hash: `0x${hash(Buffer.from(raw('5').slice(2), 'hex'))}`,
      },
      batch_guest: {app_commit_raw: raw('3'), app_exe_commit: '3'.repeat(64), app_vm_commit: '3'.repeat(64)},
      guest_openvm_toml_sha256: `0x${'6'.repeat(64)}`,
      image_revision: 'test', openvm_version: '1.7', root_verifier_asm_sha256: `0x${'7'.repeat(64)}`,
    }))
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  function prepare(overrides = {}) {
    return prepareProofMaterials({
      aggregateVerifyingKey: vk, batchMaterializer: vk, chunkMaterializer: vk,
      deploymentDir: root, generation: 'mock',
      images: {
        mockWorker: {digest: `sha256:${'a'.repeat(64)}`, repository: 'example/mock'},
        topologyCompiler: {digest: `sha256:${'b'.repeat(64)}`, repository: 'example/compiler'},
      },
      scrollIdentityEvidence: evidence, workerIdentityBundle: bundle, ...overrides,
    })
  }

  it('imports native Chunk/Batch and compiled Aggregation while keeping Bridge explicitly mock', () => {
    const result = prepare()
    const loaded = readProofMaterials(result.receiptPath, root)
    expect(loaded.software.identitySource).to.equal('dogeos_core_scroll_identity_v1')
    expect(loaded.software.identities.bridge).to.deep.equal(syntheticMockProofIdentities().bridge)
    expect(loaded.software.identities.batch.appCommitRaw).to.equal(raw('2'))
    expect(loaded.software.identities.l2Range.appCommitRaw).to.equal(raw('5'))
    expect(loaded.bridge).to.equal(undefined)
    const options = {
      artifactStore: {bucket: 'proof', endpointUrl: 'https://s3.us-east-1.amazonaws.com', kind: 's3_compatible' as const, region: 'us-east-1'},
      deploymentName: 'devnet', materials: loaded,
      runtime: {observeRealProofDeadlineMs: 1_800_000, proofCoordinatorPublicUrl: 'https://pc.example.com', rpcWitnessUrl: 'https://rpc.example.com'},
    }
    expect(buildProofTopology({...options, generation: 'mock'}).active?.profile).to.equal('withdrawal_mock_prover_real_materialize')
    expect(() => buildProofTopology({...options, generation: 'real'})).to.throw('requires identities produced by')
    fs.appendFileSync(path.join(root, loaded.software.scrollIdentityEvidence!.path), ' ')
    expect(() => readProofMaterials(result.receiptPath, root)).to.throw('content drift')
  })

  it('rejects a different VK or OpenVM version', () => {
    fs.writeFileSync(vk, 'wrong')
    expect(() => prepare()).to.throw('aggregate VK differs')
    fs.writeFileSync(vk, 'aggregate VK')
    fs.writeFileSync(evidence, fs.readFileSync(evidence, 'utf8').replace('1.7', '1.6'))
    expect(() => prepare()).to.throw('OpenVM versions differ')
  })

  it('rejects a stale compiled Batch identity and inconsistent native hash', () => {
    const body = fs.readFileSync(evidence, 'utf8')
    fs.writeFileSync(evidence, body.replace(raw('3'), raw('9')))
    expect(() => prepare()).to.throw('does not match DOGEOS_BATCH_PROGRAM_COMMITMENT_RAW')
    fs.writeFileSync(evidence, body.replace(raw('2'), raw('9')))
    expect(() => prepare()).to.throw('native commitment hash mismatch')
  })

  it('rejects real generation, mixed sources and a missing native Worker bundle', () => {
    expect(() => prepare({generation: 'real'})).to.throw('mock-only')
    expect(() => prepare({identityEnv: 'unused'})).to.throw('cannot be combined')
    expect(() => prepare({workerIdentityBundle: undefined})).to.throw('requires --worker-identity-bundle')
  })
})
