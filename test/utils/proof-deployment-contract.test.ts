import { expect } from 'chai'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { buildProofHelmArgs } from '../../src/commands/helper/proof-helm.js'
import {
  validateProofDeploymentContract,
  validateProofDeploymentContractWithWarnings,
  writeProofDeploymentContract,
} from '../../src/utils/proof-deployment-contract.js'

const WITHDRAWAL_TOML = `ordinary_setting = "operator-owned"

# BEGIN scrollsdk managed proof configuration
[proof_system]
mode = "disabled"
# END scrollsdk managed proof configuration
`

const COORDINATOR_TOML = `poll_interval_ms = 1000

# BEGIN scrollsdk managed verifier configuration
[verifier]
verifier_import_mode = "dev_dummy"
# END scrollsdk managed verifier configuration
`

function refreshGenerationId(contract: Record<string, any>): void {
  const stable = {...contract}
  delete stable.generatedAt
  delete stable.generationId
  contract.generationId = createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

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

    fs.writeFileSync(
      path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
      WITHDRAWAL_TOML,
    )
    fs.writeFileSync(
      path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      COORDINATOR_TOML,
    )
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
    expect(contract.schemaVersion).to.equal(2)
    expect(contract.components.proofCoordinator.enabled).to.equal(false)
    expect(contract.components.withdrawalProcessor.setFiles[0].integrity?.policy).to.equal('managed-block')
    expect(contract.worker).to.deep.equal({ enabled: false, kind: 'none' })
    expect(contract.signerPolicy).to.deep.equal({
      policyMode: 'dev_permissive',
      proofArtifactFetchMode: 'disabled',
    })
    expect(validateProofDeploymentContract(root).generationId).to.equal(contract.generationId)
  })

  it('preserves the generation timestamp when identical inputs are regenerated', () => {
    const input = {
      deploymentDir: root,
      mode: 'disabled' as const,
      proofCoordinator: { enabled: false, setFiles: [] },
      tsoValuesFile: path.join(root, 'values/tso-service-production.yaml'),
      withdrawalProcessor: {
        setFiles: [{
          filePath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
          key: 'configMaps.config.data.WithdrawalProcessor\\.toml',
        }],
        valuesFile: path.join(root, 'values/withdrawal-processor-production.yaml'),
      },
    }
    const first = writeProofDeploymentContract(input)
    const contractPath = path.join(root, '.data/proof-deployment.json')
    const fixedGeneratedAt = '2026-01-02T03:04:05.000Z'
    fs.writeFileSync(contractPath, `${JSON.stringify({...first, generatedAt: fixedGeneratedAt}, null, 2)}\n`)
    const before = fs.readFileSync(contractPath, 'utf8')

    const second = writeProofDeploymentContract(input)

    expect(second.generatedAt).to.equal(fixedGeneratedAt)
    expect(fs.readFileSync(contractPath, 'utf8')).to.equal(before)
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

  it('allows ordinary values drift by default but rejects it in strict mode', () => {
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
    const result = validateProofDeploymentContractWithWarnings(root)
    expect(result.warnings).to.deep.equal([
      'withdrawalProcessor: operational values checksum mismatch: values/withdrawal-processor-production.yaml',
    ])
    expect(() => validateProofDeploymentContract(root, undefined, {strict: true}))
      .to.throw('strict integrity: withdrawalProcessor: operational values checksum mismatch')
  })

  it('allows native operational drift while protecting the proof-managed block', () => {
    writeProofDeploymentContract({
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
    const configPath = path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
    fs.appendFileSync(configPath, 'operator_tuning = 2\n')
    const result = validateProofDeploymentContractWithWarnings(root)
    expect(result.warnings).to.deep.equal([
      'withdrawalProcessor: operational content changed outside the proof-managed block: withdrawal-processor/WithdrawalProcessor.toml',
    ])

    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, 'utf8').replace('mode = "disabled"', 'mode = "mock"'),
    )
    expect(() => validateProofDeploymentContract(root)).to.throw(
      'proof-managed block checksum mismatch: withdrawal-processor/WithdrawalProcessor.toml',
    )
  })

  it('applies the same managed-block boundary to proof-coordinator config', () => {
    writeProofDeploymentContract({
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
        setFiles: [],
        valuesFile: path.join(root, 'values/withdrawal-processor-production.yaml'),
      },
    })
    const configPath = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    fs.appendFileSync(configPath, 'operator_tuning = 2\n')
    const result = validateProofDeploymentContractWithWarnings(root)
    expect(result.warnings).to.deep.equal([
      'proofCoordinator: operational content changed outside the proof-managed block: proof-coordinator/ProofCoordinator.toml',
    ])

    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, 'utf8').replace('verifier_import_mode = "dev_dummy"', 'verifier_import_mode = "production"'),
    )
    expect(() => validateProofDeploymentContract(root)).to.throw(
      'proof-managed block checksum mismatch: proof-coordinator/ProofCoordinator.toml',
    )
  })

  it('keeps proof manifests under required whole-file integrity', () => {
    writeProofDeploymentContract({
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
    const manifest = path.join(root, 'proof-artifacts/mock-manifests/scroll-chunk.json')
    fs.appendFileSync(manifest, 'drift\n')
    expect(() => validateProofDeploymentContract(root)).to.throw(
      'proof-critical set-file checksum mismatch: proof-artifacts/mock-manifests/scroll-chunk.json',
    )
  })

  it('reads a legacy v1 contract and treats native whole-file drift as advisory', () => {
    writeProofDeploymentContract({
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
    const contractPath = path.join(root, '.data/proof-deployment.json')
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'))
    contract.schemaVersion = 1
    contract.generator.command = 'scrollsdk setup proof-config'
    delete contract.components.withdrawalProcessor.setFiles[0].integrity
    refreshGenerationId(contract)
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`)

    fs.appendFileSync(
      path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
      'operator_tuning = 2\n',
    )
    const result = validateProofDeploymentContractWithWarnings(root)
    expect(result.warnings[0]).to.include(
      'legacy set-file checksum mismatch: withdrawal-processor/WithdrawalProcessor.toml',
    )
  })

  it('keeps non-native set-files strict when reading a legacy v1 contract', () => {
    writeProofDeploymentContract({
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
    const contractPath = path.join(root, '.data/proof-deployment.json')
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'))
    contract.schemaVersion = 1
    contract.generator.command = 'scrollsdk setup proof-config'
    for (const component of Object.values(contract.components) as any[]) {
      for (const setFile of component.setFiles) delete setFile.integrity
    }

    refreshGenerationId(contract)
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`)

    fs.appendFileSync(
      path.join(root, 'proof-artifacts/mock-manifests/scroll-chunk.json'),
      'drift\n',
    )
    expect(() => validateProofDeploymentContract(root)).to.throw(
      'legacy set-file checksum mismatch: proof-artifacts/mock-manifests/scroll-chunk.json',
    )
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
