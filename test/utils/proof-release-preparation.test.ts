import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  captureProofReleasePreparation,
  readProofReleasePreparation,
} from '../../src/utils/proof-release-preparation.js'

const revision = 'a'.repeat(40)
const hex32 = (character: string) => `0x${character.repeat(64)}`
const hex64 = (character: string) => `0x${character.repeat(128)}`

describe('proof release preparation receipt', () => {
  let root: string
  let artifacts: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-release-preparation-'))
    artifacts = path.join(root, 'artifacts')
    const write = (relative: string, body = relative) => {
      const file = path.join(artifacts, relative)
      fs.mkdirSync(path.dirname(file), {recursive: true})
      fs.writeFileSync(file, body)
    }

    const identities = {
      DOGEOS_BATCH_AGGREGATION_PROGRAM_COMMITMENT_RAW: hex64('1'),
      DOGEOS_BATCH_PROGRAM_COMMITMENT: hex32('2'),
      DOGEOS_BATCH_PROGRAM_COMMITMENT_RAW: hex64('3'),
      DOGEOS_BATCH_SCROLL_PROGRAM_COMMITMENT_RAW: hex64('4'),
      DOGEOS_BATCH_VK_HASH: hex32('5'),
      DOGEOS_BRIDGE_APP_COMMIT_RAW: hex64('6'),
      DOGEOS_BRIDGE_PROGRAM_COMMITMENT: hex32('7'),
      DOGEOS_BRIDGE_VK_HASH: hex32('8'),
      DOGEOS_CHUNK_PROGRAM_COMMITMENT: hex32('9'),
      DOGEOS_CHUNK_PROGRAM_COMMITMENT_RAW: hex64('a'),
      DOGEOS_CHUNK_VK_HASH: hex32('b'),
    }
    write('real-identity.env', Object.entries(identities).map(([key, value]) => `export ${key}=${value}`).join('\n'))
    write('protocol_context.json', '{}')
    for (const file of ['chunk/app.vmexe', 'chunk/openvm.toml', 'batch/app.vmexe', 'batch/openvm.toml', 'verifier/aggregate-vk']) write(file)
    write('bridge/worker-identity-bundle.json', JSON.stringify({image_revision: revision}))
    for (const file of [
      'bridge-state.vmexe',
      'openvm.toml',
      'bridge-artifact-manifest.json',
      'batch-aggregation.vmexe',
      'batch-aggregation-openvm.toml',
    ]) write(`bridge/${file}`)
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('captures the prepare-real output tree and detects later drift', () => {
    const output = path.join(root, 'receipt.json')
    const result = captureProofReleasePreparation({
      artifactRoot: artifacts,
      expectedCoreRevision: revision,
      output,
    })
    expect(result.receipt.schema).to.equal('scrollsdk/proof-release-preparation/v1')
    expect(result.receipt.files.bridge.workerIdentityBundle.path)
      .to.equal(path.join(artifacts, 'bridge/worker-identity-bundle.json'))
    expect(result.receipt.files.scroll.aggregateVerifyingKey.path).to.equal(path.join(artifacts, 'verifier/aggregate-vk'))
    expect(readProofReleasePreparation(output).coreRevision).to.equal(revision)

    fs.appendFileSync(path.join(artifacts, 'protocol_context.json'), ' ')
    expect(() => readProofReleasePreparation(output)).to.throw('content drift')
  })

  it('rejects an unexpected core revision and never writes the receipt', () => {
    const output = path.join(root, 'receipt.json')
    expect(() => captureProofReleasePreparation({
      artifactRoot: artifacts,
      expectedCoreRevision: 'c'.repeat(40),
      output,
    })).to.throw('does not match expected')
    expect(fs.existsSync(output)).to.equal(false)
  })

  it('rejects symlinked inputs and refuses to overwrite a receipt', () => {
    const output = path.join(root, 'receipt.json')
    captureProofReleasePreparation({artifactRoot: artifacts, expectedCoreRevision: revision, output})
    expect(() => captureProofReleasePreparation({artifactRoot: artifacts, expectedCoreRevision: revision, output}))
      .to.throw('Refusing to overwrite')

    fs.unlinkSync(path.join(artifacts, 'chunk/app.vmexe'))
    fs.symlinkSync(path.join(artifacts, 'batch/app.vmexe'), path.join(artifacts, 'chunk/app.vmexe'))
    expect(() => captureProofReleasePreparation({
      artifactRoot: artifacts,
      expectedCoreRevision: revision,
      output: path.join(root, 'second.json'),
    })).to.throw('nonempty regular, non-symlink')
  })
})
