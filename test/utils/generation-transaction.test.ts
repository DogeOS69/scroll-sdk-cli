import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { GenerationTransaction } from '../../src/utils/generation-transaction.js'

describe('generation transaction', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-transaction-'))
    fs.mkdirSync(path.join(root, 'values'), {recursive: true})
    fs.writeFileSync(path.join(root, 'values/existing.yaml'), 'before\n')
    fs.writeFileSync(path.join(root, 'values/remove.yaml'), 'remove me\n')
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('keeps all staged writes and deletions invisible until commit', () => {
    const transaction = GenerationTransaction.begin(root)
    const stagedValues = transaction.toStagingPath(path.join(root, 'values'))
    fs.writeFileSync(path.join(stagedValues, 'existing.yaml'), 'after\n')
    fs.rmSync(path.join(stagedValues, 'remove.yaml'))
    fs.writeFileSync(path.join(stagedValues, 'new.yaml'), 'new\n')

    expect(fs.readFileSync(path.join(root, 'values/existing.yaml'), 'utf8'))
      .to.equal('before\n')
    expect(fs.existsSync(path.join(root, 'values/remove.yaml'))).to.equal(true)
    expect(fs.existsSync(path.join(root, 'values/new.yaml'))).to.equal(false)

    const result = transaction.commit()
    expect(fs.readFileSync(path.join(root, 'values/existing.yaml'), 'utf8'))
      .to.equal('after\n')
    expect(fs.existsSync(path.join(root, 'values/remove.yaml'))).to.equal(false)
    expect(fs.readFileSync(path.join(root, 'values/new.yaml'), 'utf8'))
      .to.equal('new\n')
    expect(result.changedFiles).to.have.members([
      path.join(root, 'values/existing.yaml'),
      path.join(root, 'values/new.yaml'),
      path.join(root, 'values/remove.yaml'),
    ])
    expect(fs.existsSync(transaction.stagingRoot)).to.equal(false)
  })

  it('discards the complete generation when rollback is requested', () => {
    const transaction = GenerationTransaction.begin(root)
    const stagedValues = transaction.toStagingPath(path.join(root, 'values'))
    fs.writeFileSync(path.join(stagedValues, 'existing.yaml'), 'partial\n')
    fs.rmSync(path.join(stagedValues, 'remove.yaml'))
    fs.writeFileSync(path.join(stagedValues, 'new.yaml'), 'partial\n')

    transaction.rollback()

    expect(fs.readFileSync(path.join(root, 'values/existing.yaml'), 'utf8'))
      .to.equal('before\n')
    expect(fs.readFileSync(path.join(root, 'values/remove.yaml'), 'utf8'))
      .to.equal('remove me\n')
    expect(fs.existsSync(path.join(root, 'values/new.yaml'))).to.equal(false)
    expect(fs.existsSync(transaction.stagingRoot)).to.equal(false)
  })

  it('removes generated directories after their files are deleted', () => {
    const bundleDir = path.join(root, 'prover-worker-mock/docker-compose')
    fs.mkdirSync(bundleDir, {recursive: true})
    fs.writeFileSync(path.join(bundleDir, 'prover-worker.env'), 'sensitive fixture\n')
    const transaction = GenerationTransaction.begin(root)

    fs.rmSync(
      transaction.toStagingPath(bundleDir),
      {recursive: true},
    )
    const result = transaction.commit()

    expect(fs.existsSync(bundleDir)).to.equal(false)
    expect(result.changedFiles).to.include(bundleDir)
    expect(result.changedFiles).to.include(path.join(bundleDir, 'prover-worker.env'))
  })

  it('rejects advanced output paths outside the deployment root', () => {
    const transaction = GenerationTransaction.begin(root)
    try {
      expect(() => transaction.toStagingPath(path.dirname(root)))
        .to.throw('outside deployment root')
    } finally {
      transaction.rollback()
    }
  })

  it('does not read a large untouched clone into one Buffer when mtimes lose sub-millisecond precision', () => {
    const largeFile = path.join(root, 'large-snapshot.tar')
    fs.writeFileSync(largeFile, Buffer.alloc(17 * 1024 * 1024, 0x5A))
    const originalMtime = fs.statSync(largeFile).mtimeMs
    const transaction = GenerationTransaction.begin(root)
    const stagedLargeFile = transaction.toStagingPath(largeFile)

    fs.utimesSync(stagedLargeFile, new Date(), new Date(originalMtime + 0.5))

    const result = transaction.commit()
    expect(result.changedFiles).not.to.include(largeFile)
    expect(fs.statSync(largeFile).size).to.equal(17 * 1024 * 1024)
  })

  it('keeps versioned operational-artifact exclusions outside the staging tree and change set', () => {
    const operationalDir = path.join(root, 'snapshots/generated')
    const operationalFile = path.join(operationalDir, 'reth-export.tar.gz')
    fs.mkdirSync(operationalDir, {recursive: true})
    fs.writeFileSync(operationalFile, 'large operational artifact fixture\n')
    fs.writeFileSync(path.join(root, '.scrollsdkignore'), [
      '# Not chart-generation input',
      'snapshots/generated/',
      '',
    ].join('\n'))

    const transaction = GenerationTransaction.begin(root)
    expect(fs.existsSync(transaction.toStagingPath(operationalDir))).to.equal(false)
    fs.writeFileSync(
      path.join(transaction.toStagingPath(path.join(root, 'values')), 'existing.yaml'),
      'after exclusion\n',
    )

    const result = transaction.commit()
    expect(fs.readFileSync(operationalFile, 'utf8')).to.equal('large operational artifact fixture\n')
    expect(result.changedFiles).to.deep.equal([path.join(root, 'values/existing.yaml')])
  })
})
