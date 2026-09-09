import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {ProofDeploymentContractInput} from '../../src/utils/proof-deployment-contract.js'

import {
  readProofDeploymentContract,
  validateProofDeploymentContract,
  writeProofDeploymentContract,
} from '../../src/utils/proof-deployment-contract.js'

describe('proof deployment contract schema v7', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-deployment-v7-'))
    for (const [file, contents] of Object.entries({
      '.data/generated/proof-topology/bundle-manifest-v1.json': '{}\n',
      '.data/generated/proof-topology/prover-worker-v1.json': '{}\n',
      '.data/generated/proof-topology/resolved-v2.json': '{}\n',
      'values/eth-da-submitter-production.yaml': 'controller: {}\n',
      'values/proof-coordinator-production.yaml': 'controller: {}\n',
      'values/prover-worker-production.yaml': 'controller: {}\n',
      'values/tso-service-production.yaml': 'env: []\n',
      'values/withdrawal-processor-production.yaml': 'controller: {}\n',
    })) {
      const target = path.join(root, file)
      fs.mkdirSync(path.dirname(target), {recursive: true})
      fs.writeFileSync(target, contents)
    }
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  function input(mode: 'active' | 'disabled'): ProofDeploymentContractInput {
    const bundleDir = path.join(root, '.data/generated/proof-topology')
    const component = (name: string, enabled: boolean) => ({
      enabled,
      valuesFile: path.join(root, `values/${name}-production.yaml`),
    })
    return {
      deploymentDir: root,
      enforcement: 'observe',
      ethDaSubmitter: {valuesFile: path.join(root, 'values/eth-da-submitter-production.yaml')},
      generation: 'mock',
      intentSource: {kind: 'doge-config', path: path.join(root, '.data/doge-config.toml'), sha256: 'a'.repeat(64)},
      mode,
      proofCoordinator: component('proof-coordinator', true),
      proverWorker: component('prover-worker', false),
      topology: {
        bundleDir,
        bundleManifest: path.join(bundleDir, 'bundle-manifest-v1.json'),
        bundleRevision: 'b'.repeat(64),
        resolvedSidecar: path.join(bundleDir, 'resolved-v2.json'),
      },
      tsoValuesFile: path.join(root, 'values/tso-service-production.yaml'),
      withdrawalProcessor: component('withdrawal-processor', true),
    }
  }

  it('records the three switches and only the compiler bundle revision', () => {
    const contract = writeProofDeploymentContract(input('active'))
    expect(contract).to.include({enforcement: 'observe', generation: 'mock', mode: 'active', schemaVersion: 7})
    expect(contract.topology).to.have.property('bundleRevision', 'b'.repeat(64))
    expect(contract.topology).not.to.have.property('digest')
    expect(contract.topology).not.to.have.property('deploymentRevision')
    expect(contract.components.proofCoordinator.enabled).to.equal(true)
    expect(contract.worker.kind).to.equal('none')
    expect(validateProofDeploymentContract(root).generationId).to.equal(contract.generationId)
  })

  it('rejects a mock Worker and requires a production Worker for active real generation', () => {
    const mock = input('active')
    mock.proverWorker.enabled = true
    expect(() => writeProofDeploymentContract(mock)).to.throw('mock proving must not deploy a Worker')
    const real = {...input('active'), generation: 'real' as const}
    expect(() => writeProofDeploymentContract(real)).to.throw('missing its Worker contract')
    const contract = writeProofDeploymentContract({...real, worker: {
      contractFile: path.join(root, '.data/generated/proof-topology/prover-worker-v1.json'),
      kind: 'compiled-external',
    }})
    expect(contract.worker.enabled).to.equal(true)
    expect(() => validateProofDeploymentContract(root)).not.to.throw()
  })

  it('allows deployment values overlays while rejecting retired schemas and missing files', () => {
    const contract = writeProofDeploymentContract(input('disabled'))
    expect(contract.components.proofCoordinator.enabled).to.equal(true)
    expect(contract.components.proverWorker.enabled).to.equal(false)
    fs.appendFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), 'tampered: true\n')
    expect(() => validateProofDeploymentContract(root)).not.to.throw()

    fs.rmSync(path.join(root, 'values/withdrawal-processor-production.yaml'))
    expect(() => validateProofDeploymentContract(root)).to.throw('values file is missing')

    fs.writeFileSync(path.join(root, '.data/proof-deployment.json'), JSON.stringify({...contract, schemaVersion: 6}))
    expect(() => readProofDeploymentContract(root)).to.throw('unsupported proof deployment contract')
  })
})
