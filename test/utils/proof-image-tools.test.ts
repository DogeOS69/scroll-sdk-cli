import {expect} from 'chai'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {runProofImageTools} from '../../src/utils/proof-image-tools.js'

const revision = 'a'.repeat(40)
const image = `example/proof@sha256:${'b'.repeat(64)}`
const container = 'c'.repeat(64)

function identity(placeholder = false): string {
  const batch = (placeholder ? '0' : '2').repeat(128)
  const aggregation = '1'.repeat(128)
  return JSON.stringify({
    batch_aggregation_guest: {
      app_commit_raw: `0x${aggregation}`,
      app_exe_commit: '1'.repeat(64),
      app_vm_commit: '1'.repeat(64),
      embedded_inner_batch_app_commit_raw: `0x${batch}`,
      program_commitment_hash: `0x${createHash('sha256').update(Buffer.from(aggregation, 'hex')).digest('hex')}`,
    },
    batch_guest: {app_commit_raw: `0x${batch}`, app_exe_commit: batch.slice(0, 64), app_vm_commit: batch.slice(64)},
    guest_openvm_toml_sha256: `0x${'3'.repeat(64)}`,
    image_revision: revision,
    openvm_version: '1.7',
    root_verifier_asm_sha256: `0x${'4'.repeat(64)}`,
  })
}

describe('offline proof image tools', () => {
  let root: string
  let calls: string[][]
  let workerIdentity: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-image-tools-test-'))
    calls = []
    workerIdentity = identity()
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  function run(args: string[]): string {
    calls.push(args)
    if (args[0] === 'image') return revision
    if (args[0] === 'create') return container
    if (args[0] === 'cp') fs.writeFileSync(args[2], 'native executable fixture')
    if (args.includes('--print-identity-json')) return workerIdentity
    if (args.includes('derive-scroll-identities')) {
      const mount = args.find(arg => arg.endsWith('dst=/output'))!
      const output = mount.slice('type=bind,src='.length, -',dst=/output'.length)
      fs.writeFileSync(path.join(output, 'proof-scroll-identities-v1.json'), JSON.stringify({schema: 'dogeos/proof-scroll-identities/v1'}))
    }

    return ''
  }

  function exportTools(overrides = {}) {
    return runProofImageTools({action: 'export', coordinatorImage: image, deploymentDir: root, expectedRevision: revision, output: 'generated/export', run, workerImage: image, ...overrides})
  }

  it('exports native identity and binaries with digests without starting a coordinator', () => {
    const result = exportTools({requireRealMaterialization: true})
    expect(result.receipt.batchIdentityPlaceholder).to.equal(false)
    expect(Object.keys(result.receipt.files)).to.have.length(3)
    expect(result.receipt.images).to.deep.equal({coordinator: image, worker: image})
    expect(calls).to.deep.include(['rm', container])
    expect(calls.filter(args => args[0] === 'run')).to.have.length(1)
    expect(calls.find(args => args[0] === 'run')).to.include.members(['--network', 'none', '--read-only', '--cap-drop', 'ALL', '--print-identity-json'])
    expect(fs.existsSync(path.join(result.outputDir, 'image-tools-receipt.json'))).to.equal(true)
  })

  it('records placeholders for inspection but rejects them for real materialization', () => {
    workerIdentity = identity(true)
    expect(exportTools().receipt.batchIdentityPlaceholder).to.equal(true)
    expect(() => exportTools({output: 'strict', requireRealMaterialization: true})).to.throw('placeholder batch_guest')
    expect(fs.existsSync(path.join(root, 'strict'))).to.equal(false)
  })

  it('rejects image revision mismatch before executing tools', () => {
    expect(() => exportTools({expectedRevision: 'd'.repeat(40)})).to.throw('does not match expected')
    expect(calls.some(args => args[0] === 'run')).to.equal(false)
  })

  it('rejects a compiled identity with a different revision', () => {
    workerIdentity = workerIdentity.replace(revision, 'd'.repeat(40))
    expect(() => exportTools()).to.throw('compiled identity revision')
  })

  it('removes its stopped container and staging on copy failure', () => {
    expect(() => exportTools({run(args: string[]) {
      if (args[0] === 'cp') throw new Error('copy failed')
      return run(args)
    }})).to.throw('copy failed')
    expect(calls).to.deep.include(['rm', container])
    expect(fs.readdirSync(path.join(root, 'generated'))).to.deep.equal([])
  })

  it('cleans up its allocated tool container if the Docker client times out', () => {
    expect(() => exportTools({run(args: string[]) {
      if (args[0] === 'run') {
        fs.writeFileSync(args[args.indexOf('--cidfile') + 1], container)
        throw new Error('Docker client timed out')
      }

      return run(args)
    }})).to.throw('Docker client timed out')
    expect(calls).to.deep.include(['rm', '--force', container])
    expect(fs.readdirSync(path.join(root, 'generated'))).to.deep.equal([])
  })

  it('refuses existing output, traversal and symlink escape', () => {
    fs.mkdirSync(path.join(root, 'existing'))
    expect(() => exportTools({output: 'existing'})).to.throw('Refusing to overwrite')
    expect(() => exportTools({output: '../escape'})).to.throw('inside deploymentDir')
    fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'))
    expect(() => exportTools({output: 'escape/never-create-proof-dir/output'})).to.throw('through a symlink')
    expect(calls).to.deep.equal([])
  })

  it('derives using only five read-only staged artifacts and records their fingerprints', () => {
    const artifacts = path.join(root, 'artifacts')
    for (const file of ['chunk/app.vmexe', 'chunk/openvm.toml', 'batch/app.vmexe', 'batch/openvm.toml', 'verifier/aggregate-vk']) {
      const target = path.join(artifacts, file)
      fs.mkdirSync(path.dirname(target), {recursive: true})
      fs.writeFileSync(target, file)
    }

    fs.writeFileSync(path.join(artifacts, 'private.env'), 'must not mount')
    const result = runProofImageTools({action: 'derive-scroll', artifactRoot: artifacts, deploymentDir: root, expectedRevision: revision, output: 'derived', producerImage: image, run})
    expect(Object.keys(result.receipt.inputs!)).to.have.length(5)
    expect(Object.keys(result.receipt.files)).to.deep.equal(['proof-scroll-identities-v1.json'])
    const execution = calls.find(args => args[0] === 'run')!
    expect(execution.join(' ')).not.to.include(artifacts)
    expect(execution.some(arg => arg.endsWith('dst=/input,readonly'))).to.equal(true)
    expect(fs.readdirSync(result.outputDir)).to.have.length(2)
  })
})
