import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'
import type {ValidatedProofTopologyBundle} from '../../src/utils/proof-topology-compiler.js'

import {reconcileCompiledProofTopology} from '../../src/utils/proof-topology-kubernetes-adapter.js'

const DIGEST = 'a'.repeat(64)
const REVISION = 'b'.repeat(64)
const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`

function spec(mode: 'disabled' | 'mock' | 'production'): DeploymentSpec {
  return {
    dogecoin: {network: 'testnet'},
    frontend: {
      baseDomain: 'example.com',
      externalUrls: {},
      hosts: {
        adminDashboard: 'admin.example.com',
        blockscout: 'explorer.example.com',
        bridgeHistoryApi: 'bridge.example.com',
        coordinatorApi: 'coordinator.example.com',
        frontend: 'portal.example.com',
        grafana: 'grafana.example.com',
        proofCoordinator: 'proof.example.com',
        rollupExplorerApi: 'rollup.example.com',
        rpcGateway: 'rpc.example.com',
      },
      protocol: 'https',
    },
    metadata: {environment: 'testnet', name: 'adapter-test'},
    proofTopology: {
      compiler: {
        image: {digest: IMAGE_DIGEST, repository: 'dogeos69/dogeos-proof-topology'},
      },
      deployment: {protocolContextSource: '.data/protocol_context.json'},
      mock: {
        artifactStore: {kind: 'local_fs'},
        profile: 'cheap_scroll_chunk',
        workerImage: {digest: IMAGE_DIGEST, repository: 'dogeos69/prover-worker-mock'},
      },
      mode,
      production: {
        artifactStore: {
          bucket: 'proofs',
          keyPrefix: 'proofs',
          kind: 's3_compatible',
          region: 'test',
        },
        profile: 'real_scroll_withdrawal_full_topology',
        realScroll: {
          aggVerifyingKeyPath: 'keys/agg.vk',
          batchAppConfig: 'batch/openvm.toml',
          batchAppExe: 'batch/app.vmexe',
          batchMaterializerBinaryPath: 'bin/materializer',
          batchProgramCommitmentHashHex: `0x${'1'.repeat(64)}`,
          batchProgramCommitmentHex: `0x${'2'.repeat(128)}`,
          batchVerificationKeyHashHex: `0x${'3'.repeat(64)}`,
          bridgeAppCommitRawHex: `0x${'4'.repeat(128)}`,
          bridgeProgramCommitmentHashHex: `0x${'5'.repeat(64)}`,
          bridgeVerificationKeyHashHex: `0x${'6'.repeat(64)}`,
          chunkAppConfig: 'chunk/openvm.toml',
          chunkAppExe: 'chunk/app.vmexe',
          chunkMaterializerBinaryPath: 'bin/materializer',
          chunkProgramCommitmentHashHex: `0x${'7'.repeat(64)}`,
          chunkProgramCommitmentHex: `0x${'8'.repeat(128)}`,
          chunkVerificationKeyHashHex: `0x${'9'.repeat(64)}`,
          l2RangeAggregationAppCommitRawHex: `0x${'a'.repeat(128)}`,
          l2RangeAggregationProgramCommitmentHashHex: `0x${'b'.repeat(64)}`,
          l2RangeAggregationVerificationKeyHashHex: `0x${'c'.repeat(64)}`,
          resourcesRoot: 'proof-artifacts',
        },
        workerImage: {digest: IMAGE_DIGEST, repository: 'dogeos69/prover-worker'},
        workerLaunch: 'external',
      },
    },
    version: '1.0',
  } as DeploymentSpec
}

function fakeBundle(
  root: string,
  mode: 'disabled' | 'mock' | 'production',
): ValidatedProofTopologyBundle {
  const active = mode !== 'disabled'
  fs.mkdirSync(root, {recursive: true})
  fs.writeFileSync(path.join(root, 'withdrawal-processor.toml'), `[proof_system]\nmode = "${active ? 'dev_dummy' : 'disabled'}"\n`)
  fs.writeFileSync(path.join(root, 'eth-da-submitter.patch.toml'), active
    ? `[s3]\nenabled = true\nbucket = "proofs"\nregion = "test"\nkey_prefix = "topologies/${DIGEST}"\n\n[segmentation_sidecar]\nenabled = true\ns3 = true\nlocal_root = ""\nmax_read_body_bytes = 1024\n`
    : '[s3]\nenabled = false\n\n[segmentation_sidecar]\nenabled = false\ns3 = false\nlocal_root = ""\n')
  if (active) {
    fs.writeFileSync(path.join(root, 'proof-coordinator.toml'), 'coordinator_id = "compiled"\n')
    fs.mkdirSync(path.join(root, 'materials/program-manifests'), {recursive: true})
    fs.writeFileSync(path.join(root, 'materials/program-manifests/scroll-chunk.json'), '{}\n')
    fs.writeFileSync(path.join(root, 'materials/scroll-statement-namespace.json'), '{}\n')
  }

  const worker = active
    ? {
        argv: [
          '--proof-coordinator-url',
          'http://proof-coordinator:7788',
          '--artifact-read-base-url',
          'http://proof-coordinator:7788/v1/prover/objects',
          '--worker-token-file',
          '/app/secrets/prover-worker-token',
          ...(mode === 'production'
            ? ['--chunk-app-exe', '/app/data/proof-release/chunk/app.vmexe']
            : []),
        ],
        capabilities: ['scroll_chunk'],
        desired_state: mode === 'production' ? 'external' as const : 'local_deployment' as const,
        environment: [{name: 'DOGEOS_PROOF_TOPOLOGY_DIGEST', value: DIGEST}],
        expected_topology_digest: DIGEST,
        image: {
          digest: IMAGE_DIGEST,
          repository: mode === 'production'
            ? 'dogeos69/prover-worker'
            : 'dogeos69/prover-worker-mock',
        },
        readiness_evidence_path: '/run/dogeos/prover-worker-ready-v1.json',
        required_build_class: mode === 'production' ? 'production' as const : 'mock_capable' as const,
        schema_version: 1,
      }
    : undefined
  if (worker) {
    fs.writeFileSync(
      path.join(root, 'prover-worker-v1.json'),
      `${JSON.stringify(worker, null, 2)}\n`,
    )
  }

  return {
    bundleDir: root,
    manifest: {
      compiler_package_version: '0.1.0',
      deployment_context_schema_version: 1,
      eth_da_submitter: 'eth-da-submitter.patch.toml',
      ...(active ? {generated_materials: 'materials'} : {}),
      installable_service_configs: true,
      preflight_only: false,
      ...(active ? {proof_coordinator: 'proof-coordinator.toml'} : {}),
      ...(active ? {prover_worker: 'prover-worker-v1.json'} : {}),
      resolved_sidecar: 'resolved-v1.json',
      rollout_plan: 'rollout-plan-v1.json',
      schema_version: 1,
      source_schema_version: 1,
      withdrawal_processor: 'withdrawal-processor.toml',
    },
    mode,
    plan: {
      deployment_changed: false,
      desired_services: {
        proof_coordinator: active ? 'running' : 'absent',
        prover_worker: active ? mode === 'production' ? 'external' : 'running' : 'absent',
        withdrawal_processor: 'running',
      },
      requires_proof_regeneration: false,
      schema_version: 1,
      submitter_config_changed: false,
      to_deployment_revision: REVISION,
      to_digest: DIGEST,
      to_mode: mode,
    },
    ...(worker ? {worker} : {}),
  }
}

describe('compiled proof topology Kubernetes adapter', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-topology-k8s-adapter-'))
    fs.mkdirSync(path.join(root, 'values'), {recursive: true})
    fs.mkdirSync(path.join(root, 'withdrawal-processor'), {recursive: true})
    fs.mkdirSync(path.join(root, 'proof-coordinator'), {recursive: true})
    fs.mkdirSync(path.join(root, '.data'), {recursive: true})
    fs.mkdirSync(path.join(root, 'proof-artifacts/chunk'), {recursive: true})
    fs.writeFileSync(path.join(root, '.data/protocol_context.json'), '{}\n')
    fs.writeFileSync(path.join(root, 'proof-artifacts/chunk/app.vmexe'), 'app')
    fs.writeFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), '')
    fs.writeFileSync(path.join(root, 'proof-coordinator/ProofCoordinator.toml'), '')
    fs.writeFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), yaml.dump({
      configMaps: {config: {enabled: true}},
      env: [],
      service: {main: {ports: {}}},
    }))
    fs.writeFileSync(path.join(root, 'values/proof-coordinator-production.yaml'), yaml.dump({
      env: [
        {name: 'RUST_LOG', value: 'info'},
        {name: 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__KEY_PREFIX', value: 'stale'},
      ],
      service: {main: {ports: {}}},
    }))
    fs.writeFileSync(path.join(root, 'values/prover-worker-production.yaml'), yaml.dump({
      controller: {replicas: 0},
      image: {pullPolicy: 'IfNotPresent', repository: 'placeholder', tag: 'placeholder'},
      persistence: {},
    }))
    fs.writeFileSync(path.join(root, 'values/eth-da-submitter-production.yaml'), yaml.dump({
      configMaps: {env: {data: {DOGEOS_ETH_DA_SUBMITTER_S3__KEY_PREFIX: 'stale'}}},
    }))
  })

  afterEach(() => {
    fs.rmSync(root, {force: true, recursive: true})
  })

  it('installs compiler-owned configs and material bindings for active mock mode', () => {
    const bundle = fakeBundle(path.join(root, '.data/generated/proof-topology'), 'mock')
    const result = reconcileCompiledProofTopology({
      compile: () => bundle,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      deploymentDir: root,
      deploymentSpec: spec('mock'),
      valuesDir: path.join(root, 'values'),
      withdrawalConfigPath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
    })

    expect(fs.readFileSync(path.join(root, 'proof-coordinator/ProofCoordinator.toml'), 'utf8'))
      .to.equal('coordinator_id = "compiled"\n')
    const coordinator = yaml.load(fs.readFileSync(
      path.join(root, 'values/proof-coordinator-production.yaml'),
      'utf8',
    )) as any
    expect(coordinator.env).to.deep.equal([{name: 'RUST_LOG', value: 'info'}])
    expect(coordinator.service.main.ports.prover.port).to.equal(7788)
    expect(coordinator.persistence['proof-topology-materials'].mountPath)
      .to.equal('/app/data/proof-topology')
    expect(result.helmSetFiles.proofCoordinator).to.have.length(3)
    expect(result.ethDaSubmitterValuesPath)
      .to.equal(path.join(root, 'values/eth-da-submitter-production.yaml'))
    expect(result.worker?.desired_state).to.equal('local_deployment')
    expect(result.proofArtifactBaseUrl)
      .to.equal('http://proof-coordinator:7788/v1/prover/objects')

    const worker = yaml.load(fs.readFileSync(
      path.join(root, 'values/prover-worker-production.yaml'),
      'utf8',
    )) as any
    expect(worker.controller.replicas).to.equal(1)
    expect(worker.image).to.deep.include({
      digest: IMAGE_DIGEST,
      repository: 'dogeos69/prover-worker-mock',
    })
    expect(worker.args).to.deep.equal(result.worker?.argv)
    expect(worker.persistence['prover-worker-token'].mountPath)
      .to.equal('/app/secrets/prover-worker-token')

    const withdrawal = yaml.load(fs.readFileSync(
      path.join(root, 'values/withdrawal-processor-production.yaml'),
      'utf8',
    )) as any
    expect(withdrawal.configMaps.config.data).to.equal(undefined)
    expect(withdrawal.withdrawalProof.mode).to.equal('mock')
    expect(withdrawal.podAnnotations['dogeos.io/proof-topology-digest']).to.equal(DIGEST)

    const submitter = yaml.load(fs.readFileSync(
      path.join(root, 'values/eth-da-submitter-production.yaml'),
      'utf8',
    )) as any
    expect(submitter.configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_S3__KEY_PREFIX)
      .to.equal(`topologies/${DIGEST}`)
    expect(submitter.configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_SEGMENTATION_SIDECAR__ENABLED)
      .to.equal('true')
  })

  it('keeps PC absent and removes stale proof material mounts in disabled mode', () => {
    const withdrawalValues = path.join(root, 'values/withdrawal-processor-production.yaml')
    const seeded = yaml.load(fs.readFileSync(withdrawalValues, 'utf8')) as any
    seeded.configMaps['proof-topology-materials'] = {enabled: true}
    seeded.persistence = {'proof-topology-materials': {enabled: true}}
    fs.writeFileSync(withdrawalValues, yaml.dump(seeded))
    const bundle = fakeBundle(path.join(root, '.data/generated/proof-topology'), 'disabled')
    const result = reconcileCompiledProofTopology({
      compile: () => bundle,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      deploymentDir: root,
      deploymentSpec: spec('disabled'),
      valuesDir: path.join(root, 'values'),
      withdrawalConfigPath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
    })

    expect(result.helmSetFiles.proofCoordinator).to.deep.equal([])
    const withdrawal = yaml.load(fs.readFileSync(withdrawalValues, 'utf8')) as any
    expect(withdrawal.configMaps['proof-topology-materials']).to.equal(undefined)
    expect(withdrawal.persistence['proof-topology-materials']).to.equal(undefined)
    expect(withdrawal.withdrawalProof.mode).to.equal('disabled')
    expect(withdrawal.service.main.ports['proof-work']).to.equal(undefined)
    const worker = yaml.load(fs.readFileSync(
      path.join(root, 'values/prover-worker-production.yaml'),
      'utf8',
    )) as any
    expect(worker.controller.replicas).to.equal(0)
    expect(worker.args).to.deep.equal([])
    const coordinator = yaml.load(fs.readFileSync(
      path.join(root, 'values/proof-coordinator-production.yaml'),
      'utf8',
    )) as any
    expect(coordinator.controller.replicas).to.equal(0)
    expect(coordinator.proofCoordinator.config.required).to.equal(false)
    expect(coordinator.service.main.enabled).to.equal(false)
  })

  it('emits an exact external Worker launch bundle and keeps its local Deployment absent', () => {
    const bundle = fakeBundle(
      path.join(root, '.data/generated/proof-topology'),
      'production',
    )
    const result = reconcileCompiledProofTopology({
      compile: () => bundle,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      deploymentDir: root,
      deploymentSpec: spec('production'),
      valuesDir: path.join(root, 'values'),
      withdrawalConfigPath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
    })

    expect(result.worker?.desired_state).to.equal('external')
    expect(result.workerBundle?.bundleId).to.match(/^[\da-f]{64}$/)
    expect(result.helmSetFiles.proverWorker).to.deep.equal([])
    const workerValues = yaml.load(fs.readFileSync(
      path.join(root, 'values/prover-worker-production.yaml'),
      'utf8',
    )) as any
    expect(workerValues.controller.replicas).to.equal(0)
    const compose = yaml.load(fs.readFileSync(
      path.join(result.workerBundle!.bundleDir, 'docker-compose.yml'),
      'utf8',
    )) as any
    expect(compose.services['prover-worker'].command).to.deep.equal(result.worker?.argv)
    expect(compose.services['prover-worker'].image)
      .to.equal(`dogeos69/prover-worker@${IMAGE_DIGEST}`)
  })
})
