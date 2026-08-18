import * as toml from '@iarna/toml'
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

  it('projects one temporary recovery pin to WP, TSO, and the deployment contract', () => {
    const result = reconcileProofKubernetes({
      deploymentDir: root,
      intent: {
        intent: {
          mode: 'disabled',
          preTsukiDirectSign: {maxEndBatchHeight: 6863},
        },
        source: {
          kind: 'doge-config',
          path: path.join(root, '.data/doge-config.toml'),
        },
      },
      network: 'testnet',
    })

    expect(result.contract.preTsukiDirectSign).to.deep.equal({maxEndBatchHeight: 6863})
    const withdrawal = toml.parse(
      fs.readFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), 'utf8'),
    ) as any
    expect(withdrawal.proof_system.pre_tsuki_direct_sign.max_end_batch_height).to.equal(6863)
    const tso = yaml.load(
      fs.readFileSync(path.join(root, 'values/tso-service-production.yaml'), 'utf8'),
    ) as any
    expect(tso.env).to.deep.include({
      name: 'TSO_PRE_TSUKI_DIRECT_SIGN_MAX_END_BATCH_HEIGHT',
      value: '6863',
    })
    expect(() => validateProofDeploymentContract(root)).not.to.throw()

    const retired = reconcileProofKubernetes({
      deploymentDir: root,
      intent: {
        intent: {mode: 'disabled'},
        source: {
          kind: 'doge-config',
          path: path.join(root, '.data/doge-config.toml'),
        },
      },
    })
    expect(retired.contract.preTsukiDirectSign).to.equal(undefined)
    const retiredWithdrawal = toml.parse(
      fs.readFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), 'utf8'),
    ) as any
    expect(retiredWithdrawal.proof_system.pre_tsuki_direct_sign).to.equal(undefined)
    const retiredTso = yaml.load(
      fs.readFileSync(path.join(root, 'values/tso-service-production.yaml'), 'utf8'),
    ) as any
    expect(retiredTso.env.some(
      (item: any) => item.name === 'TSO_PRE_TSUKI_DIRECT_SIGN_MAX_END_BATCH_HEIGHT',
    )).to.equal(false)
  })

  it('rejects the temporary recovery posture on mainnet before mutating files', () => {
    const valuesFile = path.join(root, 'values/tso-service-production.yaml')
    const nativeFile = path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
    const beforeValues = fs.readFileSync(valuesFile, 'utf8')
    const beforeNative = fs.readFileSync(nativeFile, 'utf8')

    expect(() => reconcileProofKubernetes({
      deploymentDir: root,
      intent: {
        intent: {
          mode: 'disabled',
          preTsukiDirectSign: {maxEndBatchHeight: 6863},
        },
        source: {
          kind: 'doge-config',
          path: path.join(root, '.data/doge-config.toml'),
        },
      },
      network: 'mainnet',
    })).to.throw('testnet-only')
    expect(fs.readFileSync(valuesFile, 'utf8')).to.equal(beforeValues)
    expect(fs.readFileSync(nativeFile, 'utf8')).to.equal(beforeNative)
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
      aggregationL2ChainId: 6_281_971,
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

  it('rejects a missing mock aggregation chain ID before mutating proof-owned files', () => {
    const valuesFile = path.join(root, 'values/withdrawal-processor-production.yaml')
    const nativeFile = path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
    const beforeValues = fs.readFileSync(valuesFile, 'utf8')
    const beforeNative = fs.readFileSync(nativeFile, 'utf8')

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
    })).to.throw('mock mode requires general.CHAIN_ID_L2')
    expect(fs.readFileSync(valuesFile, 'utf8')).to.equal(beforeValues)
    expect(fs.readFileSync(nativeFile, 'utf8')).to.equal(beforeNative)
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
