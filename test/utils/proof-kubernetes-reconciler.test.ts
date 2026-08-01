import { expect } from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { validateProofDeploymentContract } from '../../src/utils/proof-deployment-contract.js'
import {
  reconcileProofKubernetes,
  resolveProofReleasePaths,
} from '../../src/utils/proof-kubernetes-reconciler.js'

describe('proof Kubernetes reconciler', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-kubernetes-'))
    fs.mkdirSync(path.join(root, 'values'), { recursive: true })
    fs.mkdirSync(path.join(root, 'withdrawal-processor'), { recursive: true })
    fs.writeFileSync(path.join(root, 'values/tso-service-production.yaml'), yaml.dump({ env: [] }))
    fs.writeFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), yaml.dump({
      configMaps: { config: { enabled: true } },
      env: [],
      service: { main: { ports: {} } },
    }))
    fs.writeFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), '')
  })

  afterEach(() => {
    fs.rmSync(root, { force: true, recursive: true })
  })

  it('reconciles the default disabled posture without a deployment spec', () => {
    const result = reconcileProofKubernetes({
      deploymentDir: root,
      intent: {
        intent: { mode: 'disabled' },
        source: {
          kind: 'doge-config',
          path: path.join(root, '.data/doge-config.toml'),
        },
      },
    })

    expect(result.mode).to.equal('disabled')
    expect(result.contract.intentSource).to.deep.equal({
      kind: 'doge-config',
      path: '.data/doge-config.toml',
    })
    expect(result.contract.components.tsoService.enabled).to.equal(true)
    expect(result.contract.components.withdrawalProcessor.enabled).to.equal(true)
    expect(result.contract.components.proofCoordinator.enabled).to.equal(false)
    expect(validateProofDeploymentContract(root).generationId)
      .to.equal(result.contract.generationId)
  })

  it('removes generated worker bundles and hydrated tokens in disabled mode', () => {
    for (const [bundleDir, tokenFile] of [
      ['prover-worker-mock/docker-compose', 'prover-worker.env'],
      ['prover-worker-production/docker-compose', 'prover-worker.token'],
    ]) {
      const dir = path.join(root, bundleDir)
      fs.mkdirSync(dir, {recursive: true})
      fs.writeFileSync(path.join(dir, tokenFile), 'sensitive-fixture-token\n', {mode: 0o600})
    }

    reconcileProofKubernetes({
      deploymentDir: root,
      intent: {
        intent: {mode: 'disabled'},
        source: {
          kind: 'doge-config',
          path: path.join(root, '.data/doge-config.toml'),
        },
      },
    })

    expect(fs.existsSync(path.join(root, 'prover-worker-mock'))).to.equal(false)
    expect(fs.existsSync(path.join(root, 'prover-worker-production'))).to.equal(false)
  })

  it('derives all production release inputs from one optional release root', () => {
    const release = resolveProofReleasePaths(root, './proof-releases/v2026.07.1')

    expect(release.artifactManifest)
      .to.equal(path.join(root, 'proof-releases/v2026.07.1/release.json'))
    expect(release.programManifests).to.deep.equal([
      path.join(root, 'proof-releases/v2026.07.1/manifests/scroll-chunk.json'),
      path.join(root, 'proof-releases/v2026.07.1/manifests/scroll-batch.json'),
      path.join(root, 'proof-releases/v2026.07.1/manifests/advance-l2-aggregation.json'),
      path.join(root, 'proof-releases/v2026.07.1/manifests/bridge-transition.json'),
    ])
    expect(release.statementNamespace)
      .to.equal(path.join(root, 'proof-releases/v2026.07.1/manifests/statement-namespace.json'))
  })

  it('rejects a missing mock worker endpoint before mutating proof-owned files', () => {
    const valuesFile = path.join(root, 'values/withdrawal-processor-production.yaml')
    const nativeFile = path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
    const beforeValues = fs.readFileSync(valuesFile, 'utf8')
    const beforeNative = fs.readFileSync(nativeFile, 'utf8')

    expect(() => reconcileProofKubernetes({
      deploymentDir: root,
      intent: {
        intent: {
          artifactReadBaseUrl: 'https://proofs.example.com/proof-topology',
          mode: 'mock',
        },
        source: {
          kind: 'doge-config',
          path: path.join(root, '.data/doge-config.toml'),
        },
      },
    })).to.throw('ingress.PROOF_COORDINATOR_HOST')
    expect(fs.readFileSync(valuesFile, 'utf8')).to.equal(beforeValues)
    expect(fs.readFileSync(nativeFile, 'utf8')).to.equal(beforeNative)
  })

  it('does not use generated values as the active infrastructure source', () => {
    expect(() => reconcileProofKubernetes({
      coordinatorIngressHost: 'proof-coordinator.example.com',
      deploymentDir: root,
      intent: {
        intent: {
          artifactReadBaseUrl: 'https://proofs.example.com/proof-topology',
          mode: 'mock',
        },
        source: {
          kind: 'doge-config',
          path: path.join(root, '.data/doge-config.toml'),
        },
      },
    })).to.throw('needs an explicit proof infrastructure source')
  })

  it('rejects an incomplete production worker release before mutating proof-owned files', () => {
    const valuesFile = path.join(root, 'values/withdrawal-processor-production.yaml')
    const nativeFile = path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
    const beforeValues = fs.readFileSync(valuesFile, 'utf8')
    const beforeNative = fs.readFileSync(nativeFile, 'utf8')

    expect(() => reconcileProofKubernetes({
      aggregationL2ChainId: 6_281_971,
      coordinatorIngressHost: 'proof-coordinator.example.com',
      deploymentDir: root,
      intent: {
        intent: {
          artifactReadBaseUrl: 'https://proofs.example.com/proof-topology',
          mode: 'production',
        },
        source: {
          kind: 'doge-config',
          path: path.join(root, '.data/doge-config.toml'),
        },
      },
    })).to.throw('worker-release.json')
    expect(fs.readFileSync(valuesFile, 'utf8')).to.equal(beforeValues)
    expect(fs.readFileSync(nativeFile, 'utf8')).to.equal(beforeNative)
  })
})
