import { runCommand } from '@oclif/test'
import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { writeProverWorkerMockBundle } from '../../../src/utils/prover-worker-mock-bundle.js'

describe('setup proof-worker-check', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-worker-check-'))
  })

  afterEach(() => {
    fs.rmSync(root, { force: true, recursive: true })
  })

  it('returns the verified bundle ID without exposing the worker token', async () => {
    const workerToken = '<WORKER_TOKEN_FIXTURE_MUST_NOT_BE_LOGGED>'
    const bundle = writeProverWorkerMockBundle({
      artifactReadBaseUrl: 'https://proofs.example.com/proof-topology',
      coordinatorUrl: 'https://proof-coordinator.example.com',
      dir: root,
      workerToken,
    })
    const { stderr, stdout } = await runCommand([
      'setup',
      'proof-worker-check',
      '--bundle-dir',
      root,
      '--expected-bundle-id',
      bundle.bundleId,
      '--json',
    ])
    const response = JSON.parse(stdout)

    expect(response.success).to.equal(true)
    expect(response.data.bundleId).to.equal(bundle.bundleId)
    expect(`${stdout}\n${stderr}`).not.to.include(workerToken)
  })
})
