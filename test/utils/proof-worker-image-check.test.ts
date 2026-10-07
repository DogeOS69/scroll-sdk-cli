import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  assertProofWorkerImageMatchesPreparation,
  checkProofWorkerImage,
  readProofWorkerImageCheck,
} from '../../src/utils/proof-worker-image-check.js'

const revision = 'a'.repeat(40)
const digest = `sha256:${'b'.repeat(64)}`
const batch = `0x${'c'.repeat(128)}`
const aggregation = `0x${'d'.repeat(128)}`

describe('production proof Worker image check', () => {
  let root: string
  let calls: string[][]
  let labels: Record<string, string>

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-worker-image-check-'))
    calls = []
    labels = {
      'dogeos.batch.program-commitment.raw': batch,
      'dogeos.batch-aggregation.program-commitment.raw': aggregation,
      'dogeos.component': 'proving',
      'dogeos.cuda.archs': '86,89',
      'dogeos.service': 'prover-worker-cuda',
      'org.opencontainers.image.revision': revision,
      'org.opencontainers.image.title': 'prover-worker-cuda',
    }
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  const run = (args: string[]) => {
    calls.push(args)
    return args[0] === 'image' ? JSON.stringify(labels) : ''
  }

  function check(output = path.join(root, 'receipt.json')) {
    return checkProofWorkerImage({
      expectedBatchAggregationProgramCommitmentRaw: aggregation,
      expectedBatchProgramCommitmentRaw: batch,
      expectedCoreRevision: revision,
      image: {digest, repository: 'dogeos69/prover-worker-cuda'},
      output,
      run,
    })
  }

  it('pins revision, compiled commitments and CUDA architectures without running the image', () => {
    const result = check()
    expect(result.receipt.cudaArchitectures).to.deep.equal(['86', '89'])
    expect(result.receipt.image).to.deep.equal({digest, repository: 'dogeos69/prover-worker-cuda'})
    expect(calls[0]).to.deep.equal(['pull', `dogeos69/prover-worker-cuda@${digest}`])
    expect(calls.filter(args => args[0] === 'run')).to.deep.equal([])
    expect(readProofWorkerImageCheck(result.receiptPath).coreRevision).to.equal(revision)
  })

  for (const [name, label, value, expected] of [
    ['revision', 'org.opencontainers.image.revision', 'e'.repeat(40), 'revision'],
    ['batch identity', 'dogeos.batch.program-commitment.raw', `0x${'e'.repeat(128)}`, 'Batch commitment'],
    ['aggregation identity', 'dogeos.batch-aggregation.program-commitment.raw', `0x${'e'.repeat(128)}`, 'Batch aggregation commitment'],
    ['service', 'dogeos.service', 'wrong-worker', 'service'],
  ]) {
    it(`rejects a mismatched ${name}`, () => {
      labels[label] = value
      expect(() => check()).to.throw(expected)
      expect(fs.existsSync(path.join(root, 'receipt.json'))).to.equal(false)
    })
  }

  it('refuses malformed CUDA labels and existing output', () => {
    labels['dogeos.cuda.archs'] = '86,86'
    expect(() => check()).to.throw('unique comma-separated')
    labels['dogeos.cuda.archs'] = '86'
    check()
    expect(() => check()).to.throw('Refusing to overwrite')
  })

  it('cross-checks both compiled commitments when material import joins the receipts', () => {
    const worker = check().receipt
    const identityFile = path.join(root, 'identity.env')
    const env = {
      DOGEOS_BATCH_AGGREGATION_PROGRAM_COMMITMENT_RAW: aggregation,
      DOGEOS_BATCH_PROGRAM_COMMITMENT: `0x${'1'.repeat(64)}`,
      DOGEOS_BATCH_PROGRAM_COMMITMENT_RAW: batch,
      DOGEOS_BATCH_SCROLL_PROGRAM_COMMITMENT_RAW: `0x${'2'.repeat(128)}`,
      DOGEOS_BATCH_VK_HASH: `0x${'3'.repeat(64)}`,
      DOGEOS_BRIDGE_APP_COMMIT_RAW: `0x${'4'.repeat(128)}`,
      DOGEOS_BRIDGE_PROGRAM_COMMITMENT: `0x${'5'.repeat(64)}`,
      DOGEOS_BRIDGE_VK_HASH: `0x${'6'.repeat(64)}`,
      DOGEOS_CHUNK_PROGRAM_COMMITMENT: `0x${'7'.repeat(64)}`,
      DOGEOS_CHUNK_PROGRAM_COMMITMENT_RAW: `0x${'8'.repeat(128)}`,
      DOGEOS_CHUNK_VK_HASH: `0x${'9'.repeat(64)}`,
    }
    fs.writeFileSync(identityFile, Object.entries(env).map(([key, value]) => `export ${key}=${value}`).join('\n'))
    const preparation = {
      coreRevision: revision,
      files: {identityEnv: {path: identityFile, sha256: 'unused', sizeBytes: 1}},
    }
    expect(() => assertProofWorkerImageMatchesPreparation(worker, preparation)).not.to.throw()

    fs.writeFileSync(identityFile, fs.readFileSync(identityFile, 'utf8').replace(batch, `0x${'e'.repeat(128)}`))
    expect(() => assertProofWorkerImageMatchesPreparation(worker, preparation)).to.throw('different Batch commitments')
  })
})
