import { runCommand } from '@oclif/test'
import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { writeProverWorkerMockBundle } from '../../../src/utils/prover-worker-mock-bundle.js'
import {
  writeProverWorkerProductionBundle,
  writeProverWorkerReleaseManifest,
} from '../../../src/utils/prover-worker-production-bundle.js'

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

  it('auto-detects and verifies a production bundle and its release hashes', async () => {
    const releaseRoot = path.join(root, 'proof-artifacts')
    const artifacts: Record<string, string> = {
      'batch/app.vmexe': 'batch-vmexe',
      'batch/openvm.toml': 'batch-config',
      'bridge/batch-aggregation.vmexe': 'aggregation-vmexe',
      'bridge/batch-aggregation-openvm.toml': 'aggregation-config',
      'bridge/bridge-artifact-manifest.json': '{}',
      'bridge/bridge-state.vmexe': 'bridge-vmexe',
      'bridge/openvm.toml': 'bridge-config',
      'bridge/protocol_context.json': '{}',
      'chunk/app.vmexe': 'chunk-vmexe',
      'chunk/openvm.toml': 'chunk-config',
    }
    for (const [relative, content] of Object.entries(artifacts)) {
      const target = path.join(releaseRoot, relative)
      fs.mkdirSync(path.dirname(target), {recursive: true})
      fs.writeFileSync(target, content)
    }

    writeProverWorkerReleaseManifest({
      image: `dogeos69/prover-worker-cuda@sha256:${'c'.repeat(64)}`,
      releaseRoot,
    })
    const bundleDir = path.join(root, 'prover-worker-production/docker-compose')
    const workerToken = '<PRODUCTION_TOKEN_FIXTURE_MUST_NOT_BE_LOGGED>'
    const bundle = writeProverWorkerProductionBundle({
      aggregationL2ChainId: 6_281_971,
      artifactReadBaseUrl: 'https://proofs.example.com/proof-topology',
      coordinatorUrl: 'https://proof-coordinator.example.com',
      dir: bundleDir,
      releaseRoot,
      workerToken,
    })
    const {stderr, stdout} = await runCommand([
      'setup',
      'proof-worker-check',
      '--bundle-dir',
      bundleDir,
      '--expected-bundle-id',
      bundle.bundleId,
      '--json',
    ])
    const response = JSON.parse(stdout)

    expect(response.success).to.equal(true)
    expect(response.data.mode).to.equal('production')
    expect(response.data.bundleId).to.equal(bundle.bundleId)
    expect(`${stdout}\n${stderr}`).not.to.include(workerToken)
  })
})
