import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {prepareRealProofRelease} from '../../src/utils/proof-prepare-real.js'
import {readProofReleasePreparation} from '../../src/utils/proof-release-preparation.js'
import {proofFileHash} from '../../src/utils/proof-software-release.js'
import {releaseFixture} from '../helpers/proof-software-release.js'

describe('offline complete real preparation', () => {
  let root: string
  let sha: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-prepare-real-'))
    fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify(releaseFixture()))
    fs.writeFileSync(path.join(root, 'protocol.json'), '{}')
    sha = proofFileHash(path.join(root, 'release.json'))
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  const options = () => ({deploymentDir: root, output: 'result', protocolContext: 'protocol.json', release: 'release.json', releaseSha256: sha})

  function runner(mutate?: (out: string) => void): (args: string[]) => string {
    return args => {
      if (args[0] === 'pull') return ''
      if (args[0] === 'image') return 'a'.repeat(40)
      if (args[0] === 'rm') return ''
      expect(args[0]).to.equal('run')
      expect(args).to.include.members(['--rm', '--network', 'none', `example/proof-preparation-producer@sha256:${'b'.repeat(64)}`, '/in/protocol_context.json', '/out/artifacts'])
      expect(args).not.to.include('--gpus')
      expect(args.filter(arg => arg.startsWith('type=bind'))).to.have.length(2)
      expect(args.find(arg => arg.includes('dst=/in/protocol_context.json'))).to.match(/,readonly$/)
      const mount = args.find(arg => arg.includes('dst=/out'))!
      const out = path.join(mount.split('src=')[1].split(',')[0], 'artifacts')
      const write = (name: string, body = name) => {
        const file = path.join(out, name)
        fs.mkdirSync(path.dirname(file), {recursive: true})
        fs.writeFileSync(file, body)
      }

      for (const name of ['chunk/app.vmexe', 'chunk/openvm.toml', 'batch/app.vmexe', 'batch/openvm.toml', 'verifier/aggregate-vk']) write(name)
      write('protocol_context.json', '{}')
      for (const name of ['bridge-state.vmexe', 'openvm.toml', 'batch-aggregation.vmexe', 'batch-aggregation-openvm.toml', 'bridge-artifact-manifest.json']) write('bridge/' + name)
      write('bridge/worker-identity-bundle.json', JSON.stringify({image_revision: 'a'.repeat(40)}))
      const names = ['DOGEOS_CHUNK_VK_HASH', 'DOGEOS_CHUNK_PROGRAM_COMMITMENT', 'DOGEOS_CHUNK_PROGRAM_COMMITMENT_RAW', 'DOGEOS_BATCH_VK_HASH', 'DOGEOS_BATCH_PROGRAM_COMMITMENT', 'DOGEOS_BATCH_PROGRAM_COMMITMENT_RAW', 'DOGEOS_BATCH_SCROLL_PROGRAM_COMMITMENT_RAW', 'DOGEOS_BATCH_AGGREGATION_PROGRAM_COMMITMENT_RAW', 'DOGEOS_BRIDGE_VK_HASH', 'DOGEOS_BRIDGE_PROGRAM_COMMITMENT', 'DOGEOS_BRIDGE_APP_COMMIT_RAW']
      write('real-identity.env', names.map(name => `export ${name}=0x${'a'.repeat(name.endsWith('_RAW') ? 128 : 64)}`).join('\n'))
      mutate?.(out)
      return ''
    }
  }

  it('stages only context, uses the pinned producer and atomically captures a relocatable handoff', () => {
    const result = prepareRealProofRelease({...options(), run: runner()})
    const preparation = readProofReleasePreparation(result.preparationReceipt)
    expect(preparation.coreRevision).to.equal('a'.repeat(40))
    expect(preparation.files.protocolContext.path).to.equal(path.join(root, 'result/protocol_context.json'))
    expect(preparation.files.scroll.chunkAppExe.path).to.equal(path.join(root, 'result/chunk/app.vmexe'))
    expect(fs.readdirSync(root).some(name => name.startsWith('.proof-prepare'))).to.equal(false)
  })

  it('rejects a producer whose revision label differs from the release', () => {
    const run = runner()
    expect(() => prepareRealProofRelease({...options(), run: args => args[0] === 'image' ? 'e'.repeat(40) : run(args)})).to.throw('revision differs')
    expect(fs.existsSync(path.join(root, 'result'))).to.equal(false)
  })

  for (const problem of ['context', 'revision', 'missing', 'empty', 'symlink', 'native-failure']) {
    it(`keeps the final output absent after ${problem}`, () => {
      const run = runner(out => {
        if (problem === 'native-failure') throw new Error('injected native failure')
        if (problem === 'context') fs.writeFileSync(path.join(out, 'protocol_context.json'), '{"other":1}')
        if (problem === 'revision') fs.writeFileSync(path.join(out, 'bridge/worker-identity-bundle.json'), JSON.stringify({image_revision: 'e'.repeat(40)}))
        if (problem === 'missing') fs.rmSync(path.join(out, 'verifier/aggregate-vk'))
        if (problem === 'empty') fs.writeFileSync(path.join(out, 'bridge/openvm.toml'), '')
        if (problem === 'symlink') fs.symlinkSync(path.join(out, 'protocol_context.json'), path.join(out, 'link'))
      })
      expect(() => prepareRealProofRelease({...options(), run})).to.throw()
      expect(fs.existsSync(path.join(root, 'result'))).to.equal(false)
      expect(fs.readdirSync(root).some(name => name.startsWith('.proof-prepare'))).to.equal(false)
    })
  }
})
