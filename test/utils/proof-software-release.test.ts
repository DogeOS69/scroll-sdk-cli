import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {proofFileHash, readProofSoftwareRelease, validateProofSoftwareRelease} from '../../src/utils/proof-software-release.js'
import {releaseFixture} from '../helpers/proof-software-release.js'

describe('immutable proof software release', () => {
  it('rejects short revisions, mutable images, missing or unknown images and other schemas', () => {
    expect(validateProofSoftwareRelease(releaseFixture()).schema).to.equal('dogeos/proof-release/v1')
    expect(() => validateProofSoftwareRelease(releaseFixture('a'.repeat(39)))).to.throw('Invalid core revision')
    const mutable = releaseFixture()
    mutable.images['proof-preparation-producer'] = 'example/producer:latest'
    expect(() => validateProofSoftwareRelease(mutable)).to.throw('repository@sha256')
    const missing = releaseFixture() as unknown as {images: Record<string, string>}
    delete missing.images['prover-worker-cuda']
    expect(() => validateProofSoftwareRelease(missing)).to.throw('missing or unknown')
    const unknown = releaseFixture() as unknown as {images: Record<string, string>}
    unknown.images.producer = `example/producer@sha256:${'b'.repeat(64)}`
    expect(() => validateProofSoftwareRelease(unknown)).to.throw('missing or unknown')
    expect(() => validateProofSoftwareRelease({...releaseFixture(), genericBundle: {}})).to.throw('missing or unknown')
    expect(() => validateProofSoftwareRelease({...releaseFixture(), schema: 'future'})).to.throw('Unsupported')
  })

  it('requires the approved digest and rejects parent-directory symlinks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-release-'))
    try {
      const dir = path.join(root, 'real')
      fs.mkdirSync(dir)
      const file = path.join(dir, 'release.json')
      fs.writeFileSync(file, JSON.stringify(releaseFixture()))
      const sha = proofFileHash(file)
      expect(readProofSoftwareRelease(file, sha).sha256).to.equal(sha)
      expect(() => readProofSoftwareRelease(file, '0'.repeat(64))).to.throw('digest mismatch')
      fs.symlinkSync(dir, path.join(root, 'link'))
      expect(() => readProofSoftwareRelease(path.join(root, 'link/release.json'), sha)).to.throw('symlink')
      fs.appendFileSync(file, ' ')
      expect(() => readProofSoftwareRelease(file, sha)).to.throw('digest mismatch')
    } finally { fs.rmSync(root, {force: true, recursive: true}) }
  })
})
