import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {ProverWorkerContractV1} from '../../src/utils/proof-topology-compiler.js'

import {
  hydrateCompiledProverWorkerBundle,
  verifyCompiledProverWorkerBundle,
  writeCompiledProverWorkerBundle,
} from '../../src/utils/compiled-prover-worker-bundle.js'

const DIGEST = 'a'.repeat(64)

function worker(): ProverWorkerContractV1 {
  return {
    argv: [
      '--proof-coordinator-url',
      'https://proof.example.com',
      '--worker-token-file',
      '/app/secrets/prover-worker-token',
      '--chunk-app-exe',
      '/app/data/proof-materials/chunk/app.vmexe',
    ],
    capabilities: ['scroll_chunk'],
    desired_state: 'external',
    environment: [
      {name: 'DOGEOS_PROOF_TOPOLOGY_DIGEST', value: DIGEST},
      {
        name: 'DOGEOS_PROVER_WORKER_READY_FILE',
        value: '/run/dogeos/prover-worker-ready-v1.json',
      },
    ],
    expected_topology_digest: DIGEST,
    image: {
      digest: `sha256:${'b'.repeat(64)}`,
      repository: 'dogeos69/prover-worker',
    },
    placement: 'external',
    readiness_evidence_path: '/run/dogeos/prover-worker-ready-v1.json',
    required_build_class: 'production',
    schema_version: 1,
  }
}

function mockLocalWorker(): ProverWorkerContractV1 {
  const value = worker()
  return {
    ...value,
    desired_state: 'local_deployment',
    image: {...value.image, repository: 'dogeos69/prover-worker-mock'},
    placement: 'local_cpu',
    required_build_class: 'mock_capable',
  }
}

describe('compiled prover-worker bundle', () => {
  let root: string
  let resourcesRoot: string
  let bundleDir: string
  let contractFile: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'compiled-worker-bundle-'))
    resourcesRoot = path.join(root, 'proof-artifacts')
    bundleDir = path.join(root, 'prover-worker-production/docker-compose')
    contractFile = path.join(root, '.data/generated/proof-topology/prover-worker-v1.json')
    fs.mkdirSync(path.join(resourcesRoot, 'chunk'), {recursive: true})
    fs.writeFileSync(path.join(resourcesRoot, 'chunk/app.vmexe'), 'app')
    fs.mkdirSync(path.dirname(contractFile), {recursive: true})
    fs.writeFileSync(contractFile, `${JSON.stringify(worker(), null, 2)}\n`)
    fs.mkdirSync(path.join(root, '.data/generated/proof-topology/materials'), {recursive: true})
    fs.writeFileSync(
      path.join(root, '.data/generated/proof-topology/materials/program.json'),
      '{}\n',
    )
    fs.mkdirSync(path.join(root, '.data'), {recursive: true})
    fs.writeFileSync(path.join(root, '.data/protocol_context.json'), '{"network":"testnet"}\n')
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('renders the exact compiler image, argv, environment, and runtime mounts', () => {
    const result = writeCompiledProverWorkerBundle({
      bundleDir,
      contractFile,
      generatedMaterialsDir: path.join(root, '.data/generated/proof-topology/materials'),
      generatedMaterialsRoot: '/app/data/proof-topology',
      protocolContextPath: path.join(root, '.data/protocol_context.json'),
      protocolContextRuntimePath: '/app/protocol_context.json',
      resourcesMountPath: '/app/data/proof-materials',
      resourcesRoot,
      worker: worker(),
    })

    expect(result.bundleId).to.match(/^[\da-f]{64}$/)
    const compose = yaml.load(fs.readFileSync(path.join(bundleDir, 'docker-compose.yml'), 'utf8')) as any
    expect(compose.services['prover-worker'].image)
      .to.equal(`dogeos69/prover-worker@sha256:${'b'.repeat(64)}`)
    expect(compose.services['prover-worker'].command).to.deep.equal(worker().argv)
    expect(compose.services['prover-worker'].environment.DOGEOS_PROOF_TOPOLOGY_DIGEST)
      .to.equal(DIGEST)
    expect(compose.services['prover-worker'].volumes)
      .to.include(`${String.fromCodePoint(36)}{PROOF_RESOURCES_ROOT:?missing PROOF_RESOURCES_ROOT}:/app/data/proof-materials:ro`)
    const manifest = JSON.parse(fs.readFileSync(result.manifestFile, 'utf8'))
    expect(manifest.credentialState).to.equal('pending')
    expect(manifest.requiredResources).to.deep.include({
      path: 'chunk/app.vmexe',
      runtimePath: '/app/data/proof-materials/chunk/app.vmexe',
      sha256: manifest.requiredResources[0].sha256,
      type: 'file',
    })
  })

  it('accepts adapter-managed local CPU contracts without adding GPU runtime', () => {
    const local = mockLocalWorker()
    fs.writeFileSync(contractFile, `${JSON.stringify(local, null, 2)}\n`)
    writeCompiledProverWorkerBundle({
      bundleDir,
      contractFile,
      generatedMaterialsDir: path.join(root, '.data/generated/proof-topology/materials'),
      generatedMaterialsRoot: '/app/data/proof-topology',
      protocolContextPath: path.join(root, '.data/protocol_context.json'),
      protocolContextRuntimePath: '/app/protocol_context.json',
      resourcesMountPath: '/app/data/proof-materials',
      resourcesRoot,
      worker: local,
    })

    const compose = yaml.load(fs.readFileSync(path.join(bundleDir, 'docker-compose.yml'), 'utf8')) as any
    expect(compose.services['prover-worker'].image)
      .to.equal(`dogeos69/prover-worker-mock@sha256:${'b'.repeat(64)}`)
    expect(compose.services['prover-worker']).not.to.have.property('gpus')
  })

  it('hydrates a 0600 token without changing bundle identity and detects resource drift', () => {
    const pending = writeCompiledProverWorkerBundle({
      bundleDir,
      contractFile,
      generatedMaterialsDir: path.join(root, '.data/generated/proof-topology/materials'),
      generatedMaterialsRoot: '/app/data/proof-topology',
      protocolContextPath: path.join(root, '.data/protocol_context.json'),
      protocolContextRuntimePath: '/app/protocol_context.json',
      resourcesMountPath: '/app/data/proof-materials',
      resourcesRoot,
      worker: worker(),
    })
    const ready = hydrateCompiledProverWorkerBundle({bundleDir, workerToken: 'secret-token'})
    expect(ready.bundleId).to.equal(pending.bundleId)
    expect(verifyCompiledProverWorkerBundle({
      bundleDir,
      expectedBundleId: pending.bundleId,
      resourcesRoot,
    }).bundleId).to.equal(pending.bundleId)

    fs.writeFileSync(path.join(resourcesRoot, 'chunk/app.vmexe'), 'tampered')
    expect(() => verifyCompiledProverWorkerBundle({bundleDir, resourcesRoot}))
      .to.throw('resource SHA-256 mismatch')
  })

  it('rejects stale or corrupt bundles before writing the worker credential', () => {
    const pending = writeCompiledProverWorkerBundle({
      bundleDir,
      contractFile,
      generatedMaterialsDir: path.join(root, '.data/generated/proof-topology/materials'),
      generatedMaterialsRoot: '/app/data/proof-topology',
      protocolContextPath: path.join(root, '.data/protocol_context.json'),
      protocolContextRuntimePath: '/app/protocol_context.json',
      resourcesMountPath: '/app/data/proof-materials',
      resourcesRoot,
      worker: worker(),
    })
    const tokenPath = path.join(bundleDir, 'prover-worker.token')
    expect(() => hydrateCompiledProverWorkerBundle({
      bundleDir,
      expectedBundleId: 'f'.repeat(64),
      workerToken: 'must-not-be-written',
    })).to.throw('bundle is stale')
    expect(fs.existsSync(tokenPath)).to.equal(false)

    fs.appendFileSync(path.join(bundleDir, 'prover-worker-v1.json'), '\n')
    expect(() => hydrateCompiledProverWorkerBundle({
      bundleDir,
      expectedBundleId: pending.bundleId,
      workerToken: 'must-not-be-written',
    })).to.throw('SHA-256 does not match')
    expect(fs.existsSync(tokenPath)).to.equal(false)
    expect(JSON.parse(fs.readFileSync(pending.manifestFile, 'utf8')).credentialState)
      .to.equal('pending')
  })
})
