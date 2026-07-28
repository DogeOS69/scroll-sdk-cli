import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { buildProofHelmArgs } from '../../src/commands/helper/proof-helm.js'
import {
  validateProofDeploymentContract,
  writeProofDeploymentContract,
} from '../../src/utils/proof-deployment-contract.js'

describe('proof deployment contract', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-deployment-contract-'))
    for (const file of [
      'values/withdrawal-processor-production.yaml',
      'values/proof-coordinator-production.yaml',
      'values/tso-service-production.yaml',
      'withdrawal-processor/WithdrawalProcessor.toml',
      'proof-coordinator/ProofCoordinator.toml',
      'proof-artifacts/mock-manifests/scroll-chunk.json',
    ]) {
      const target = path.join(root, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, `${file}\n`)
    }
  })

  afterEach(() => fs.rmSync(root, { force: true, recursive: true }))

  it('records a disabled deployment with no coordinator or worker', () => {
    const contract = writeProofDeploymentContract({
      deploymentDir: root,
      mode: 'disabled',
      proofCoordinator: { enabled: false, setFiles: [] },
      tsoValuesFile: path.join(root, 'values/tso-service-production.yaml'),
      withdrawalProcessor: {
        setFiles: [{
          filePath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
          key: 'configMaps.config.data.WithdrawalProcessor\\.toml',
        }],
        valuesFile: path.join(root, 'values/withdrawal-processor-production.yaml'),
      },
    })
    expect(contract.mode).to.equal('disabled')
    expect(contract.components.proofCoordinator.enabled).to.equal(false)
    expect(contract.worker).to.deep.equal({ enabled: false, kind: 'none' })
    expect(contract.signerPolicy).to.deep.equal({
      policyMode: 'dev_permissive',
      proofArtifactFetchMode: 'disabled',
    })
    expect(validateProofDeploymentContract(root).generationId).to.equal(contract.generationId)
  })

  it('builds Helm set-file arguments solely from the generated contract', () => {
    const contract = writeProofDeploymentContract({
      deploymentDir: root,
      mode: 'production',
      proofArtifactBaseUrl: 'https://proofs.example.com/topology',
      proofCoordinator: {
        enabled: true,
        setFiles: [{
          filePath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
          key: 'proofCoordinator.config.content',
        }],
        valuesFile: path.join(root, 'values/proof-coordinator-production.yaml'),
      },
      tsoValuesFile: path.join(root, 'values/tso-service-production.yaml'),
      withdrawalProcessor: {
        setFiles: [{
          filePath: path.join(root, 'proof-artifacts/mock-manifests/scroll-chunk.json'),
          key: 'configMaps.proof-manifests.data.scroll-chunk\\.json',
        }],
        valuesFile: path.join(root, 'values/withdrawal-processor-production.yaml'),
      },
    })
    const args = buildProofHelmArgs({
      chart: 'oci://example/withdrawal-processor',
      component: contract.components.withdrawalProcessor,
      deploymentDir: root,
      namespace: 'bridge',
      release: 'withdrawal-processor',
      version: '1.2.3',
    })
    expect(args).to.include.members([
      '--values',
      path.join(root, 'values/withdrawal-processor-production.yaml'),
      '--set-file',
      `configMaps.proof-manifests.data.scroll-chunk\\.json=${path.join(root, 'proof-artifacts/mock-manifests/scroll-chunk.json')}`,
    ])
  })

  it('rejects a deployment file changed after setup', () => {
    writeProofDeploymentContract({
      deploymentDir: root,
      mode: 'disabled',
      proofCoordinator: { enabled: false, setFiles: [] },
      tsoValuesFile: path.join(root, 'values/tso-service-production.yaml'),
      withdrawalProcessor: {
        setFiles: [],
        valuesFile: path.join(root, 'values/withdrawal-processor-production.yaml'),
      },
    })
    fs.appendFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), 'drift\n')
    expect(() => validateProofDeploymentContract(root)).to.throw('checksum mismatch')
  })

  it('rejects contract posture tampering even when referenced files are unchanged', () => {
    writeProofDeploymentContract({
      deploymentDir: root,
      mode: 'disabled',
      proofCoordinator: { enabled: false, setFiles: [] },
      tsoValuesFile: path.join(root, 'values/tso-service-production.yaml'),
      withdrawalProcessor: {
        setFiles: [],
        valuesFile: path.join(root, 'values/withdrawal-processor-production.yaml'),
      },
    })
    const contractPath = path.join(root, '.data/proof-deployment.json')
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'))
    contract.signerPolicy.policyMode = 'production_enforce'
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`)
    expect(() => validateProofDeploymentContract(root)).to.throw('generation ID does not match')
  })
})
