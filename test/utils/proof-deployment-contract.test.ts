import {expect} from 'chai'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {ProofDeploymentContractInput} from '../../src/utils/proof-deployment-contract.js'

import {buildProofHelmArgs} from '../../src/commands/helper/proof-helm.js'
import {
  readProofDeploymentContract,
  validateProofDeploymentContract,
  writeProofDeploymentContract,
} from '../../src/utils/proof-deployment-contract.js'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('proof deployment contract schema v5', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-deployment-contract-'))
    const contents: Record<string, string> = {
      '.data/generated/proof-topology/bundle-manifest-v1.json': '{}\n',
      '.data/generated/proof-topology/prover-worker-v1.json': '{}\n',
      '.data/generated/proof-topology/resolved-v2.json': '{}\n',
      '.data/generated/proof-topology/rollout-plan-v1.json': '{}\n',
      'proof-coordinator/ProofCoordinator.toml': '[verifier]\nverifier_import_mode = "dev_dummy"\n',
      'values/eth-da-submitter-production.yaml': 'controller: {}\n',
      'values/proof-coordinator-production.yaml': 'controller: {}\n',
      'values/prover-worker-production.yaml': 'controller: {}\n',
      'values/tso-service-production.yaml': 'env: []\n',
      'values/withdrawal-processor-production.yaml': 'controller: {}\n',
      'withdrawal-processor/WithdrawalProcessor.toml': '[proof_system]\nmode = "disabled"\n',
    }
    for (const [file, content] of Object.entries(contents)) {
      const target = path.join(root, file)
      fs.mkdirSync(path.dirname(target), {recursive: true})
      fs.writeFileSync(target, content)
    }
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  function input(mode: 'disabled' | 'mock' = 'disabled'): ProofDeploymentContractInput {
    const bundleDir = path.join(root, '.data/generated/proof-topology')
    const active = mode !== 'disabled'
    return {
      deploymentDir: root,
      ethDaSubmitter: {
        valuesFile: path.join(root, 'values/eth-da-submitter-production.yaml'),
      },
      intentSource: {
        kind: 'deployment-spec',
        path: path.join(root, 'deployment-spec.yaml'),
        sha256: 'c'.repeat(64),
      },
      mode,
      ...(active
        ? {proofArtifactBaseUrl: 'http://proof-coordinator:7788/v1/prover/objects'}
        : {}),
      proofCoordinator: {
        enabled: active,
        setFiles: active
          ? [{
              filePath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
              integrityPolicy: 'required',
              key: 'proofCoordinator.config.content',
            }]
          : [],
        valuesFile: path.join(root, 'values/proof-coordinator-production.yaml'),
      },
      proverWorker: {
        enabled: active,
        setFiles: [],
        valuesFile: path.join(root, 'values/prover-worker-production.yaml'),
      },
      topology: {
        bundleDir,
        bundleManifest: path.join(bundleDir, 'bundle-manifest-v1.json'),
        deploymentRevision: 'b'.repeat(64),
        digest: 'a'.repeat(64),
        resolvedSidecar: path.join(bundleDir, 'resolved-v2.json'),
        rolloutPlan: path.join(bundleDir, 'rollout-plan-v1.json'),
      },
      tsoValuesFile: path.join(root, 'values/tso-service-production.yaml'),
      withdrawalProcessor: {
        enabled: true,
        setFiles: [{
          filePath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
          integrityPolicy: 'required',
          key: 'configMaps.config.data.WithdrawalProcessor\\.toml',
        }],
        valuesFile: path.join(root, 'values/withdrawal-processor-production.yaml'),
      },
      ...(active
        ? {
            worker: {
              contractFile: path.join(bundleDir, 'prover-worker-v1.json'),
              kind: 'compiled-local' as const,
            },
          }
        : {}),
    }
  }

  it('always writes a strict schema-v5 compiler contract', () => {
    const contract = writeProofDeploymentContract(input())

    expect(contract.schemaVersion).to.equal(5)
    expect(contract.intentSource).to.deep.equal({
      kind: 'deployment-spec',
      path: 'deployment-spec.yaml',
      sha256: 'c'.repeat(64),
    })
    expect(contract.worker).to.deep.equal({enabled: false, kind: 'none'})
    expect(contract.components.proofCoordinator.enabled).to.equal(false)
    expect(contract.components.proverWorker.enabled).to.equal(false)
    expect(contract.components.ethDaSubmitter.valuesIntegrity).to.equal('required')
    expect(validateProofDeploymentContract(root).generationId).to.equal(contract.generationId)
  })

  it('records compiler evidence and compiled Worker identity', () => {
    const contract = writeProofDeploymentContract(input('mock'))

    expect(contract.topology).to.deep.include({
      bundleDir: '.data/generated/proof-topology',
      bundleManifestSha256: sha256('{}\n'),
      deploymentRevision: 'b'.repeat(64),
      digest: 'a'.repeat(64),
    })
    expect(contract.worker).to.deep.include({
      contractFile: '.data/generated/proof-topology/prover-worker-v1.json',
      contractSha256: sha256('{}\n'),
      enabled: true,
      kind: 'compiled-local',
    })
    expect(contract.components.proofCoordinator.setFiles[0].integrity.policy)
      .to.equal('required')
    expect(validateProofDeploymentContract(root).generationId).to.equal(contract.generationId)
  })

  it('rejects old contract schemas instead of migrating them', () => {
    const contract = writeProofDeploymentContract(input()) as unknown as Record<string, unknown>
    contract.schemaVersion = 4
    fs.writeFileSync(
      path.join(root, '.data/proof-deployment.json'),
      `${JSON.stringify(contract, null, 2)}\n`,
    )

    expect(() => readProofDeploymentContract(root))
      .to.throw('only proof deployment contract schemaVersion 5 is supported')
  })

  it('fails closed on any generated values or set-file drift', () => {
    writeProofDeploymentContract(input('mock'))
    fs.appendFileSync(path.join(root, 'values/prover-worker-production.yaml'), 'tampered: true\n')
    expect(() => validateProofDeploymentContract(root))
      .to.throw('proverWorker: values checksum mismatch')

    writeProofDeploymentContract(input('mock'))
    fs.appendFileSync(
      path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
      'tampered = true\n',
    )
    expect(() => validateProofDeploymentContract(root))
      .to.throw('withdrawalProcessor: proof-critical set-file checksum mismatch')
  })

  it('builds Helm arguments only from schema-v5 bindings', () => {
    const contract = writeProofDeploymentContract(input('mock'))
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
      `configMaps.config.data.WithdrawalProcessor\\.toml=${path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')}`,
    ])
  })

  it('preserves generatedAt when compiler output is byte-identical', () => {
    const first = writeProofDeploymentContract(input())
    const contractPath = path.join(root, '.data/proof-deployment.json')
    const generatedAt = '2026-01-02T03:04:05.000Z'
    fs.writeFileSync(
      contractPath,
      `${JSON.stringify({...first, generatedAt}, null, 2)}\n`,
    )
    const second = writeProofDeploymentContract(input())
    expect(second.generatedAt).to.equal(generatedAt)
  })
})
