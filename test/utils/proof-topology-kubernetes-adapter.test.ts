import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {ProofTopologySpec} from '../../src/types/proof-topology.js'
import type {ValidatedProofTopologyBundle} from '../../src/utils/proof-topology-compiler.js'

import {PROVER_WORKER_EXECUTABLE} from '../../src/utils/compiled-prover-worker-bundle.js'
import {reconcileCompiledProofTopology} from '../../src/utils/proof-topology-kubernetes-adapter.js'

const BUNDLE_REVISION = 'b'.repeat(64)
const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`
const WORKER_ARGV = [
  '--proof-coordinator-url', 'https://proof-coordinator.example.com',
  '--worker-token-file', '/app/secrets/prover-worker-token',
  '--artifact-read-base-url', 'https://proof.example.com/objects',
]

function topology(
  mode: 'active' | 'disabled',
  workerDeploymentBackend: 'docker_compose' | 'kubernetes' = 'docker_compose',
): ProofTopologySpec {
  const hex32 = (character: string) => `0x${character.repeat(64)}`
  const hex64 = (character: string) => `0x${character.repeat(128)}`
  return {
    active: {
      artifactStore: {kind: 'local_fs'},
      profile: 'withdrawal_mock_prover_real_materialize',
      realScroll: {
        batchProgramCommitmentHashHex: hex32('1'),
        batchProgramCommitmentHex: hex64('2'),
        batchVerificationKeyHashHex: hex32('3'),
        bridgeAppCommitRawHex: hex64('4'),
        bridgeProgramCommitmentHashHex: hex32('5'),
        bridgeVerificationKeyHashHex: hex32('6'),
        chunkProgramCommitmentHashHex: hex32('7'),
        chunkProgramCommitmentHex: hex64('8'),
        chunkVerificationKeyHashHex: hex32('9'),
        l2RangeAggregationAppCommitRawHex: hex64('a'),
        l2RangeAggregationProgramCommitmentHashHex: hex32('b'),
        l2RangeAggregationVerificationKeyHashHex: hex32('c'),
        resourcesRoot: '.data/proof-materials',
      },
      workerLaunch: 'local_cpu',
    },
    compiler: {image: {digest: IMAGE_DIGEST, repository: 'dogeos69/dogeos-proof-topology'}},
    deployment: {
      artifactKeyPrefix: 'proof-topology',
      mockWorkerImage: {digest: IMAGE_DIGEST, repository: 'dogeos69/prover-worker-mock'},
      proverPublicUrl: 'https://proof-coordinator.example.com',
      workerDeploymentBackend,
    },
    enforcement: 'observe',
    generation: 'mock',
    mode,
  }
}

function fakeBundle(root: string, mode: 'active' | 'disabled'): ValidatedProofTopologyBundle {
  fs.mkdirSync(root, {recursive: true})
  fs.writeFileSync(path.join(root, 'withdrawal-processor.toml'), `[proof_system]\nmode = "${mode}"\n`)
  fs.writeFileSync(
    path.join(root, 'eth-da-submitter.patch.toml'),
    mode === 'active'
      ? '[s3]\nenabled = true\nbucket = "dogeos-da-archive"\nregion = "us-west-2"\nkey_prefix = "testnet/batches"\n\n[segmentation_sidecar]\nenabled = true\ns3 = true\n'
      : '[s3]\nenabled = false\n\n[segmentation_sidecar]\nenabled = false\ns3 = false\n',
  )
  if (mode === 'active') {
    fs.writeFileSync(path.join(root, 'proof-coordinator.toml'), 'coordinator_id = "compiled"\n')
    fs.mkdirSync(path.join(root, 'materials/program-manifests'), {recursive: true})
    fs.writeFileSync(path.join(root, 'materials/program-manifests/chunk.json'), '{"kind":"chunk"}\n')
  }

  const worker = mode === 'active' ? {
    argv: WORKER_ARGV,
    capabilities: ['scroll_chunk'],
    desired_state: 'local_deployment' as const,
    environment: [{name: 'DOGEOS_PROVER_WORKER_READY_FILE', value: '/run/dogeos/ready.json'}],
    image: {digest: IMAGE_DIGEST, repository: 'dogeos69/prover-worker-mock'},
    placement: 'local_cpu' as const,
    readiness_evidence_path: '/run/dogeos/ready.json',
    required_build_class: 'mock_capable' as const,
    schema_version: 1,
  } : undefined
  if (worker) fs.writeFileSync(path.join(root, 'prover-worker-v1.json'), `${JSON.stringify(worker)}\n`)

  return {
    bundleDir: root,
    enforcement: 'observe',
    generation: 'mock',
    manifest: {
      bundle_revision: BUNDLE_REVISION,
      compiler_package_version: '0.3.0',
      deployment_context_schema_version: 1,
      eth_da_submitter: 'eth-da-submitter.patch.toml',
      ...(mode === 'active' ? {generated_materials: 'materials'} : {}),
      installable_service_configs: true,
      preflight_only: false,
      ...(mode === 'active' ? {proof_coordinator: 'proof-coordinator.toml'} : {}),
      ...(mode === 'active' ? {prover_worker: 'prover-worker-v1.json'} : {}),
      resolved_sidecar: 'resolved-v2.json',
      schema_version: 1,
      source_schema_version: 1,
      withdrawal_processor: 'withdrawal-processor.toml',
    },
    mode,
    sidecar: {
      bundle_revision: BUNDLE_REVISION,
      resolved: {enforcement: 'observe', generation: 'mock', mode: mode === 'active' ? 'mock' : 'disabled'},
      schema_version: 2,
    },
    ...(worker ? {worker} : {}),
  }
}

describe('self-contained proof topology Kubernetes adapter', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-k8s-adapter-'))
    for (const directory of ['.data/proof-materials', 'proof-coordinator', 'values', 'withdrawal-processor']) {
      fs.mkdirSync(path.join(root, directory), {recursive: true})
    }

    fs.writeFileSync(path.join(root, '.data/protocol_context.json'), '{"network":"testnet"}\n')

    fs.writeFileSync(path.join(root, 'proof-coordinator/ProofCoordinator.toml'), '')
    fs.writeFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), '')
    fs.writeFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), yaml.dump({
      configMaps: {config: {data: {}, enabled: true}},
      env: [],
      persistence: {},
      service: {main: {ports: {}}},
    }))
    fs.writeFileSync(path.join(root, 'values/proof-coordinator-production.yaml'), yaml.dump({
      controller: {replicas: 1},
      env: [{name: 'RUST_LOG', value: 'info'}],
      ingress: {main: {enabled: true}},
      persistence: {},
      service: {main: {enabled: true, ports: {}}},
    }))
    fs.writeFileSync(path.join(root, 'values/prover-worker-production.yaml'), yaml.dump({
      controller: {replicas: 0},
      image: {repository: 'placeholder', tag: 'latest'},
      persistence: {},
    }))
    fs.writeFileSync(path.join(root, 'values/eth-da-submitter-production.yaml'), yaml.dump({
      configMaps: {
        env: {
          data: {
            DOGEOS_ETH_DA_SUBMITTER_L2__START_BLOCK_NUMBER: '2898792',
            DOGEOS_ETH_DA_SUBMITTER_S3__BUCKET: 'dogeos-da-archive',
            DOGEOS_ETH_DA_SUBMITTER_S3__ENABLED: 'true',
            DOGEOS_ETH_DA_SUBMITTER_S3__KEY_PREFIX: 'testnet/batches',
            DOGEOS_ETH_DA_SUBMITTER_S3__REGION: 'us-west-2',
            DOGEOS_ETH_DA_SUBMITTER_SEGMENTATION_SIDECAR__ENABLED: 'true',
          },
        },
      },
    }))
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('renders a Compose bundle for adapter-managed mock CPU Workers', () => {
    const result = reconcileCompiledProofTopology({
      compile: () => fakeBundle(path.join(root, '.data/generated/proof-topology'), 'active'),
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      deploymentDir: root,
      deploymentName: 'test',
      network: 'testnet',
      proofTopology: topology('active'),
      valuesDir: path.join(root, 'values'),
      withdrawalConfigPath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
    })

    expect(result).not.to.have.property('helmSetFiles')
    const withdrawal = yaml.load(fs.readFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), 'utf8')) as any
    expect(withdrawal.configMaps.config.data['WithdrawalProcessor.toml']).to.include('mode = "active"')
    expect(withdrawal.configMaps['proof-topology-materials'].data).to.deep.include({
      'material-00-chunk.json': '{"kind":"chunk"}\n',
    })
    const coordinator = yaml.load(fs.readFileSync(path.join(root, 'values/proof-coordinator-production.yaml'), 'utf8')) as any
    expect(coordinator.proofCoordinator.config).to.include({
      content: 'coordinator_id = "compiled"\n',
      required: true,
    })
    expect(coordinator.controller.replicas).to.equal(1)
    expect(coordinator.persistence.genesis).to.deep.equal({
      enabled: true,
      mountPath: '/app/genesis/genesis.json',
      name: 'genesis-config',
      readOnly: true,
      subPath: 'genesis.json',
      type: 'configMap',
    })
    const worker = yaml.load(fs.readFileSync(path.join(root, 'values/prover-worker-production.yaml'), 'utf8')) as any
    expect(worker.controller.replicas).to.equal(0)
    expect(result.workerBundle?.bundleId).to.match(/^[\da-f]{64}$/)
    const compose = yaml.load(fs.readFileSync(
      path.join(root, 'prover-worker-active/docker-compose/docker-compose.yml'),
      'utf8',
    )) as any
    expect(compose.services['prover-worker'].image)
      .to.equal(`dogeos69/prover-worker-mock@${IMAGE_DIGEST}`)
    expect(compose.services['prover-worker']).not.to.have.property('gpus')
    expect(fs.readFileSync(path.join(root, 'values/eth-da-submitter-production.yaml'), 'utf8'))
      .to.include('DOGEOS_ETH_DA_SUBMITTER_L2__START_BLOCK_NUMBER: "2898792"')
  })

  it('keeps Kubernetes as an explicit deployment backend for local CPU Workers', () => {
    reconcileCompiledProofTopology({
      compile: () => fakeBundle(path.join(root, '.data/generated/proof-topology'), 'active'),
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      deploymentDir: root,
      deploymentName: 'test',
      network: 'testnet',
      proofTopology: topology('active', 'kubernetes'),
      valuesDir: path.join(root, 'values'),
      withdrawalConfigPath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
    })

    const worker = yaml.load(fs.readFileSync(path.join(root, 'values/prover-worker-production.yaml'), 'utf8')) as any
    expect(worker.controller.replicas).to.equal(1)
    expect(worker.command).to.deep.equal([PROVER_WORKER_EXECUTABLE])
    expect(worker.args).to.deep.equal(WORKER_ARGV)
    expect(worker.configMaps['proof-topology-materials'].data['material-00-chunk.json'])
      .to.equal('{"kind":"chunk"}\n')
    expect(fs.existsSync(path.join(root, 'prover-worker-active/docker-compose'))).to.equal(false)
  })

  it('keeps PC running with a minimal beta.1-compatible idle config when disabled', () => {
    reconcileCompiledProofTopology({
      compile: () => fakeBundle(path.join(root, '.data/generated/proof-topology'), 'disabled'),
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      deploymentDir: root,
      deploymentName: 'test',
      network: 'testnet',
      proofTopology: topology('disabled'),
      valuesDir: path.join(root, 'values'),
      withdrawalConfigPath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
    })

    const coordinator = yaml.load(fs.readFileSync(path.join(root, 'values/proof-coordinator-production.yaml'), 'utf8')) as any
    expect(coordinator.controller.replicas).to.equal(1)
    expect(coordinator.service.main.enabled).to.equal(true)
    expect(coordinator.proofCoordinator.config.required).to.equal(true)
    expect(coordinator.proofCoordinator.config.content).to.include('generation = "mock"')
    expect(coordinator.proofCoordinator.config.content).to.include('enforcement = "observe"')
    expect(coordinator.proofCoordinator.config.content).not.to.include('verifier_import_mode')
    expect(coordinator.persistence.genesis.name).to.equal('genesis-config')
    expect(coordinator.persistence.genesis.mountPath).to.equal('/app/genesis/genesis.json')
    const worker = yaml.load(fs.readFileSync(path.join(root, 'values/prover-worker-production.yaml'), 'utf8')) as any
    expect(worker.controller.replicas).to.equal(0)
    expect(worker.command).to.deep.equal([])
  })

  it('preserves the raw DA S3 archive when proof topology disables its sidecar', () => {
    reconcileCompiledProofTopology({
      compile: () => fakeBundle(path.join(root, '.data/generated/proof-topology'), 'disabled'),
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      deploymentDir: root,
      deploymentName: 'test',
      network: 'testnet',
      proofTopology: topology('disabled'),
      valuesDir: path.join(root, 'values'),
      withdrawalConfigPath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
    })

    const submitter = yaml.load(fs.readFileSync(
      path.join(root, 'values/eth-da-submitter-production.yaml'),
      'utf8',
    )) as any
    const env = submitter.configMaps.env.data
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__ENABLED).to.equal('true')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__BUCKET).to.equal('dogeos-da-archive')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__REGION).to.equal('us-west-2')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__KEY_PREFIX).to.equal('testnet/batches')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_SEGMENTATION_SIDECAR__ENABLED).to.equal('false')
  })

  it('rejects an active compiler patch that retargets the shared raw-DA/proof store', () => {
    expect(() => reconcileCompiledProofTopology({
      compile() {
        const bundle = fakeBundle(path.join(root, '.data/generated/proof-topology'), 'active')
        fs.writeFileSync(
          path.join(bundle.bundleDir, 'eth-da-submitter.patch.toml'),
          '[s3]\nenabled = true\nbucket = "different-proof-bucket"\nregion = "us-west-2"\nkey_prefix = "testnet/batches"\n\n[segmentation_sidecar]\nenabled = true\ns3 = true\n',
        )
        return bundle
      },
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      deploymentDir: root,
      deploymentName: 'test',
      network: 'testnet',
      proofTopology: topology('active'),
      valuesDir: path.join(root, 'values'),
      withdrawalConfigPath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
    })).to.throw('does not match canonical eth-da-submitter')
  })
})
