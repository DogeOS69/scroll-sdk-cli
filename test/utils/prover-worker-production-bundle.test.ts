import { expect } from 'chai'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  type ProverWorkerReleaseManifestV1,
  hydrateProverWorkerProductionBundle,
  verifyProverWorkerProductionBundle,
  writeProverWorkerProductionBundle,
  writeProverWorkerReleaseManifest,
} from '../../src/utils/prover-worker-production-bundle.js'

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function writeRelease(root: string): string {
  const contents: Record<string, string> = {
    'batch/app.vmexe': 'batch-vmexe',
    'batch/openvm.toml': 'batch-config',
    'bridge/batch-aggregation.vmexe': 'aggregation-vmexe',
    'bridge/batch-aggregation-openvm.toml': 'aggregation-config',
    'bridge/bridge-artifact-manifest.json': '{"schema_version":2}',
    'bridge/bridge-state.vmexe': 'bridge-vmexe',
    'bridge/openvm.toml': 'bridge-config',
    'bridge/protocol_context.json': '{"network":"fixture"}',
    'chunk/app.vmexe': 'chunk-vmexe',
    'chunk/openvm.toml': 'chunk-config',
  }
  for (const [relative, content] of Object.entries(contents)) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, content)
  }

  const file = (relative: string) => ({
    path: relative,
    sha256: sha256(contents[relative]),
  })
  const manifest: ProverWorkerReleaseManifestV1 = {
    artifacts: {
      advanceL2Aggregation: {
        appVmexe: file('bridge/batch-aggregation.vmexe'),
        openvmConfig: file('bridge/batch-aggregation-openvm.toml'),
      },
      bridgeArtifactManifest: file('bridge/bridge-artifact-manifest.json'),
      bridgeGenesisContext: file('bridge/protocol_context.json'),
      bridgeTransition: {
        appVmexe: file('bridge/bridge-state.vmexe'),
        openvmConfig: file('bridge/openvm.toml'),
      },
      scrollBatch: {
        appVmexe: file('batch/app.vmexe'),
        openvmConfig: file('batch/openvm.toml'),
      },
      scrollChunk: {
        appVmexe: file('chunk/app.vmexe'),
        openvmConfig: file('chunk/openvm.toml'),
      },
    },
    image: `dogeos69/prover-worker-cuda@sha256:${'a'.repeat(64)}`,
    schemaVersion: 1,
  }
  const manifestFile = path.join(root, 'worker-release.json')
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifestFile
}

describe('production prover-worker bundle', () => {
  let root: string
  let releaseRoot: string
  let bundleDir: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-worker-bundle-'))
    releaseRoot = path.join(root, 'proof-artifacts')
    bundleDir = path.join(root, 'prover-worker-production/docker-compose')
    writeRelease(releaseRoot)
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('generates a credential-pending all-family bundle from one release manifest', () => {
    const bundle = writeProverWorkerProductionBundle({
      aggregationL2ChainId: 6_281_971,
      artifactReadBaseUrl: 'https://proofs.example.com/proof-topology',
      coordinatorUrl: 'https://proof-coordinator.example.com',
      dir: bundleDir,
      releaseRoot,
    })

    expect(bundle.bundleId).to.match(/^[\da-f]{64}$/)
    expect(fs.existsSync(path.join(bundleDir, 'prover-worker.token'))).to.equal(false)
    const compose = fs.readFileSync(path.join(bundleDir, 'docker-compose.yml'), 'utf8')
    expect(compose).to.include(`dogeos69/prover-worker-cuda@sha256:${'a'.repeat(64)}`)
    expect(compose).to.include('--worker-token-file')
    expect(compose).to.include('--enable-prove-advance-l2-aggregation')
    expect(compose).to.include('/dogeos/artifacts/bridge/protocol_context.json')
    const firstManifest = fs.readFileSync(bundle.manifestFile, 'utf8')
    expect(JSON.parse(firstManifest)).not.to.have.property('generatedAt')
    writeProverWorkerProductionBundle({
      aggregationL2ChainId: 6_281_971,
      artifactReadBaseUrl: 'https://proofs.example.com/proof-topology',
      coordinatorUrl: 'https://proof-coordinator.example.com',
      dir: bundleDir,
      releaseRoot,
    })
    expect(fs.readFileSync(bundle.manifestFile, 'utf8')).to.equal(firstManifest)
    expect(() => verifyProverWorkerProductionBundle({dir: bundleDir}))
      .to.throw('worker credential is pending')
  })

  it('hydrates a raw 0600 token file without changing the deterministic bundle ID', () => {
    const pending = writeProverWorkerProductionBundle({
      aggregationL2ChainId: '6281971',
      artifactReadBaseUrl: 'https://proofs.example.com/proof-topology',
      coordinatorUrl: 'https://proof-coordinator.example.com',
      dir: bundleDir,
      releaseRoot,
    })
    const token = '<PRODUCTION_WORKER_TOKEN_FIXTURE>'
    const ready = hydrateProverWorkerProductionBundle({
      dir: bundleDir,
      workerToken: token,
    })

    expect(ready.bundleId).to.equal(pending.bundleId)
    expect(fs.readFileSync(path.join(bundleDir, 'prover-worker.token'), 'utf8')).to.equal(`${token}\n`)
    // POSIX permission bits are intentionally expressed in octal.
    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(path.join(bundleDir, 'prover-worker.token')).mode & 0o777).to.equal(0o600)
    expect(JSON.stringify(JSON.parse(fs.readFileSync(ready.manifestFile, 'utf8'))))
      .not.to.include(token)
    expect(verifyProverWorkerProductionBundle({
      dir: bundleDir,
      expectedBundleId: pending.bundleId,
    }).bundleId).to.equal(pending.bundleId)
  })

  it('fails closed when a release artifact changes after generation', () => {
    writeProverWorkerProductionBundle({
      aggregationL2ChainId: 6_281_971,
      artifactReadBaseUrl: 'https://proofs.example.com/proof-topology',
      coordinatorUrl: 'https://proof-coordinator.example.com',
      dir: bundleDir,
      releaseRoot,
      workerToken: 'token',
    })
    fs.appendFileSync(path.join(releaseRoot, 'chunk/app.vmexe'), '-tampered')

    expect(() => verifyProverWorkerProductionBundle({dir: bundleDir}))
      .to.throw('release artifact SHA-256 mismatch')
  })

  it('rejects a mutable worker image before writing a bundle', () => {
    const manifestFile = writeRelease(releaseRoot)
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    manifest.image = 'dogeos69/prover-worker-cuda:latest'
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

    expect(() => writeProverWorkerProductionBundle({
      aggregationL2ChainId: 6_281_971,
      artifactReadBaseUrl: 'https://proofs.example.com/proof-topology',
      coordinatorUrl: 'https://proof-coordinator.example.com',
      dir: bundleDir,
      releaseRoot,
    })).to.throw('image must be dogeos69/prover-worker-cuda@sha256')
  })

  it('lets the release pipeline generate the manifest from the conventional layout', () => {
    fs.rmSync(path.join(releaseRoot, 'worker-release.json'))
    const manifestFile = writeProverWorkerReleaseManifest({
      image: `dogeos69/prover-worker-cuda@sha256:${'b'.repeat(64)}`,
      releaseRoot,
    })
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))

    expect(manifest.artifacts.scrollChunk.appVmexe.path).to.equal('chunk/app.vmexe')
    expect(manifest.artifacts.advanceL2Aggregation.appVmexe.path)
      .to.equal('bridge/batch-aggregation.vmexe')
    expect(manifest.artifacts.bridgeGenesisContext.path)
      .to.equal('bridge/protocol_context.json')
  })
})
