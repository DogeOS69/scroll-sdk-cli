import { runCommand } from '@oclif/test'
import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

describe('setup proof-worker-release', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-worker-release-command-'))
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
      const target = path.join(root, relative)
      fs.mkdirSync(path.dirname(target), {recursive: true})
      fs.writeFileSync(target, content)
    }
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('writes the versioned release manifest with one immutable image input', async () => {
    const image = `dogeos69/prover-worker-cuda@sha256:${'d'.repeat(64)}`
    const {stderr, stdout} = await runCommand([
      'setup',
      'proof-worker-release',
      '--release-root',
      root,
      '--image',
      image,
      '--json',
    ])
    const response = JSON.parse(stdout)
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'worker-release.json'), 'utf8'))

    expect(response.success).to.equal(true)
    expect(response.data.manifestFile).to.equal(path.join(root, 'worker-release.json'))
    expect(manifest.schemaVersion).to.equal(1)
    expect(manifest.image).to.equal(image)
    expect(manifest.artifacts.scrollChunk.appVmexe.sha256).to.match(/^[\da-f]{64}$/)
    expect(stderr).not.to.include(image)
  })
})
