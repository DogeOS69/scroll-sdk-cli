import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {ProofTopologySpec} from '../../src/types/proof-topology.js'
import type {ValidatedProofTopologyBundle} from '../../src/utils/proof-topology-compiler.js'

import {PROVER_WORKER_EXECUTABLE} from '../../src/utils/compiled-prover-worker-bundle.js'
import {configureEagerMaterializerValues, reconcileCompiledProofTopology} from '../../src/utils/proof-topology-kubernetes-adapter.js'

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
        aggVerifyingKeyPath: '.data/proof-materials/software/verifier/root_verifier_vk',
        batchMaterializerBinaryPath: '.data/proof-materials/software/bin/batch-materializer',
        batchProgramCommitmentHashHex: hex32('1'),
        batchProgramCommitmentHex: hex64('2'),
        batchVerificationKeyHashHex: hex32('3'),
        bridgeAppCommitRawHex: hex64('4'),
        bridgeProgramCommitmentHashHex: hex32('5'),
        bridgeVerificationKeyHashHex: hex32('6'),
        chunkMaterializerBinaryPath: '.data/proof-materials/software/bin/chunk-materializer',
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

function fakeBundle(root: string, mode: 'active' | 'disabled', generation: 'mock' | 'real' = 'mock'): ValidatedProofTopologyBundle {
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

  const worker = mode === 'active' && generation === 'real' ? {
    argv: WORKER_ARGV,
    capabilities: ['scroll_chunk'],
    desired_state: 'local_deployment' as const,
    environment: [{name: 'DOGEOS_PROVER_WORKER_READY_FILE', value: '/run/dogeos/ready.json'}],
    image: {digest: IMAGE_DIGEST, repository: 'dogeos69/prover-worker'},
    placement: 'local_cpu' as const,
    readiness_evidence_path: '/run/dogeos/ready.json',
    required_build_class: 'production' as const,
    schema_version: 1,
  } : undefined
  if (worker) fs.writeFileSync(path.join(root, 'prover-worker-v1.json'), `${JSON.stringify(worker)}\n`)

  return {
    bundleDir: root,
    enforcement: 'observe',
    generation,
    manifest: {
      bundle_revision: BUNDLE_REVISION,
      compiler_package_version: '0.3.0',
      deployment_context_schema_version: 1,
      eth_da_submitter: 'eth-da-submitter.patch.toml',
      ...(mode === 'active' ? {generated_materials: 'materials'} : {}),
      installable_service_configs: true,
      preflight_only: false,
      ...(mode === 'active' ? {proof_coordinator: 'proof-coordinator.toml'} : {}),
      ...(worker ? {prover_worker: 'prover-worker-v1.json'} : {}),
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
    fs.mkdirSync(path.join(root, '.data/proof-materials/software/bin'), {recursive: true})
    fs.mkdirSync(path.join(root, '.data/proof-materials/software/verifier'), {recursive: true})
    fs.writeFileSync(path.join(root, '.data/proof-materials/software/bin/batch-materializer'), 'batch materializer')
    fs.writeFileSync(path.join(root, '.data/proof-materials/software/bin/chunk-materializer'), 'chunk materializer')
    fs.writeFileSync(path.join(root, '.data/proof-materials/software/verifier/root_verifier_vk'), Buffer.from([0, 1, 2, 3]))

    fs.writeFileSync(path.join(root, 'proof-coordinator/ProofCoordinator.toml'), '')
    fs.writeFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), '')
    fs.writeFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), yaml.dump({
      configMaps: {config: {data: {}, enabled: true}},
      env: [],
      image: {repository: 'dogeos69/withdrawal-processor', tag: 'test'},
      persistence: {},
      service: {main: {ports: {}}},
    }))
    fs.writeFileSync(path.join(root, 'values/proof-coordinator-production.yaml'), yaml.dump({
      controller: {replicas: 1},
      env: [{name: 'RUST_LOG', value: 'info'}],
      image: {repository: 'dogeos69/proof-coordinator', tag: 'test'},
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

  for (const mode of ['active', 'disabled'] as const) {
    for (const enabled of [undefined, false, true]) {
      it(`preserves operator ingress opt-in (${mode}, ${enabled})`, () => {
        const file = path.join(root, 'values/proof-coordinator-production.yaml')
        const values = yaml.load(fs.readFileSync(file, 'utf8')) as any
        values.ingress = enabled === undefined ? {} : {main: {enabled}}
        fs.writeFileSync(file, yaml.dump(values))
        reconcileCompiledProofTopology({
          compile: () => fakeBundle(path.join(root, '.data/generated/proof-topology'), mode),
          coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
          deploymentDir: root,
          deploymentName: 'test',
          network: 'testnet',
          proofTopology: topology(mode),
          valuesDir: path.join(root, 'values'),
          withdrawalConfigPath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
        })
        const actual = yaml.load(fs.readFileSync(file, 'utf8')) as any
        expect(actual.ingress.main.enabled).to.equal(enabled ?? false)
      })
    }
  }

  it('enables a configured prover ingress with matching worker URL, TLS and numeric ingress port', () => {
    const file = path.join(root, 'values/proof-coordinator-production.yaml')
    const values = yaml.load(fs.readFileSync(file, 'utf8')) as any
    values.ingress.main = {annotations: {keep: 'operator'}, enabled: false, tls: [{hosts: ['old.example'], secretName: 'custom-proof-tls'}]}
    fs.writeFileSync(file, yaml.dump(values))
    reconcileCompiledProofTopology({
      compile(options) {
        expect(options.proofTopology.deployment.proverPublicUrl).to.equal('https://proof-coordinator.example.com')
        return fakeBundle(path.join(root, '.data/generated/proof-topology'), 'active')
      },
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      coordinatorIngressHost: 'proof-coordinator.example.com',
      deploymentDir: root,
      deploymentName: 'test',
      network: 'testnet',
      proofTopology: topology('active'),
      valuesDir: path.join(root, 'values'),
      withdrawalConfigPath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
    })
    const actual = yaml.load(fs.readFileSync(file, 'utf8')) as any
    expect(actual.ingress.main.enabled).to.equal(true)
    expect(actual.ingress.main.hosts[0]).to.deep.equal({host: 'proof-coordinator.example.com', paths: [{path: '/', pathType: 'Prefix', service: {port: 7788}}]})
    expect(actual.ingress.main.tls).to.deep.equal([{hosts: ['proof-coordinator.example.com'], secretName: 'custom-proof-tls'}])
    expect(actual.ingress.main.annotations.keep).to.equal('operator')
    expect(actual.service.main.ports.prover.port).to.equal(7788)
    expect(actual.service.main.ports.http.enabled).to.equal(false)
  })

  it('rejects a worker URL that differs from the configured ingress before compiling or changing files', () => {
    const file = path.join(root, 'values/proof-coordinator-production.yaml')
    const before = fs.readFileSync(file, 'utf8')
    expect(() => reconcileCompiledProofTopology({
      compile() {throw new Error('compiler must not be called')},
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      coordinatorIngressHost: 'different.example.com',
      deploymentDir: root,
      deploymentName: 'test',
      network: 'testnet',
      proofTopology: topology('active'),
      valuesDir: path.join(root, 'values'),
      withdrawalConfigPath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
    })).to.throw('PROOF_COORDINATOR_HOST must match')
    expect(fs.readFileSync(file, 'utf8')).to.equal(before)
  })

  it('keeps real materialization self-contained without deploying a mock Worker', () => {
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
    expect(withdrawal.secrets?.['proof-runtime-seed']).to.equal(undefined)
    expect(withdrawal.persistence['proof-runtime-materials']).to.equal(undefined)
    expect(withdrawal.configMaps['proof-topology-materials'].data).to.deep.include({
      'material-00-chunk.json': '{"kind":"chunk"}\n',
    })
    const coordinator = yaml.load(fs.readFileSync(path.join(root, 'values/proof-coordinator-production.yaml'), 'utf8')) as any
    expect(coordinator.proofCoordinator.config).to.include({
      content: 'coordinator_id = "compiled"\n',
      required: true,
    })
    expect(coordinator.controller.replicas).to.equal(1)
    expect(coordinator.secrets?.['proof-runtime-seed']).to.equal(undefined)
    expect(coordinator.persistence['proof-runtime-materials']).to.deep.include({
      enabled: true,
      mountPath: '/app/data/proof-materials',
      type: 'emptyDir',
    })
    expect(coordinator.initContainers['prepare-proof-runtime-materials'].image)
      .to.equal('dogeos69/proof-coordinator:test')
    expect(coordinator.initContainers['prepare-proof-runtime-materials'].args[0])
      .to.include('/usr/local/bin/materialize-chunk-oneshot')
      .and.to.include('/usr/local/bin/scroll-runtime-materializer')
      .and.to.include('sha256sum -c -')
      .and.not.to.include('root_verifier_vk.b64')
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
    expect(result.workerBundle).to.equal(undefined)
    expect(fs.existsSync(path.join(root, 'prover-worker-active/docker-compose/docker-compose.yml'))).to.equal(false)
    expect(fs.readFileSync(path.join(root, 'values/eth-da-submitter-production.yaml'), 'utf8'))
      .to.include('DOGEOS_ETH_DA_SUBMITTER_L2__START_BLOCK_NUMBER: "2898792"')
  })

  for (const backend of ['docker_compose', 'kubernetes'] as const) {
    it(`supports pure mock without materializer files and removes stale runtime staging (${backend})`, () => {
      const proofTopology = topology('active', backend)
      proofTopology.active!.profile = 'withdrawal_mock_prover'
      delete proofTopology.active!.realScroll.chunkMaterializerBinaryPath
      delete proofTopology.active!.realScroll.batchMaterializerBinaryPath
      delete proofTopology.active!.realScroll.aggVerifyingKeyPath
      fs.rmSync(path.join(root, '.data/proof-materials/software'), {recursive: true})

      for (const component of ['withdrawal-processor', 'proof-coordinator']) {
        const file = path.join(root, `values/${component}-production.yaml`)
        const values = yaml.load(fs.readFileSync(file, 'utf8')) as any
        values.initContainers = {
          'operator-init': {image: 'operator-image'},
          'prepare-proof-runtime-materials': {image: 'old-proof-image'},
        }
        values.persistence ||= {}
        values.persistence['proof-runtime-materials'] = {enabled: true, type: 'emptyDir'}
        values.persistence['proof-runtime-seed'] = {enabled: true, type: 'secret'}
        values.secrets = {'proof-runtime-seed': {enabled: true}}
        fs.writeFileSync(file, yaml.dump(values))
      }

      const result = reconcileCompiledProofTopology({
        compile: () => fakeBundle(path.join(root, '.data/generated/proof-topology'), 'active'),
        coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
        deploymentDir: root,
        deploymentName: 'test',
        network: 'testnet',
        proofTopology,
        valuesDir: path.join(root, 'values'),
        withdrawalConfigPath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
      })

      for (const component of ['withdrawal-processor', 'proof-coordinator']) {
        const values = yaml.load(fs.readFileSync(path.join(root, `values/${component}-production.yaml`), 'utf8')) as any
        expect(values.initContainers).not.to.have.property('prepare-proof-runtime-materials')
        expect(values.initContainers['operator-init']).to.deep.equal({image: 'operator-image'})
        expect(values.persistence).not.to.have.property('proof-runtime-materials')
        expect(values.persistence).not.to.have.property('proof-runtime-seed')
        expect(values.secrets).not.to.have.property('proof-runtime-seed')
        expect(values.configMaps['proof-topology-materials'].data).to.deep.include({
          'material-00-chunk.json': '{"kind":"chunk"}\n',
        })
      }

      const worker = yaml.load(fs.readFileSync(path.join(root, 'values/prover-worker-production.yaml'), 'utf8')) as any
      expect(worker.controller.replicas).to.equal(0)
      expect(result.workerBundle).to.equal(undefined)
    })
  }

  for (const profile of ['withdrawal_mock_prover_real_materialize', 'real_scroll_withdrawal_full_topology'] as const) {
    for (const field of ['chunkMaterializerBinaryPath', 'batchMaterializerBinaryPath'] as const) {
      it(`still requires ${field} for ${profile}`, () => {
        const proofTopology = topology('active')
        proofTopology.active!.profile = profile
        if (profile === 'real_scroll_withdrawal_full_topology') proofTopology.generation = 'real'
        delete proofTopology.active!.realScroll[field]
        expect(() => reconcileCompiledProofTopology({
          compile: () => fakeBundle(path.join(root, '.data/generated/proof-topology'), 'active'),
          coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
          deploymentDir: root,
          deploymentName: 'test',
          network: 'testnet',
          proofTopology,
          valuesDir: path.join(root, 'values'),
          withdrawalConfigPath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
        })).to.throw('real Scroll materialization requires both Chunk and Batch materializer binaries')
      })
    }
  }

  it('stages the aggregate VK only for real proof generation', () => {
    const proofTopology = topology('active')
    proofTopology.generation = 'real'

    reconcileCompiledProofTopology({
      compile: () => fakeBundle(path.join(root, '.data/generated/proof-topology'), 'active'),
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      deploymentDir: root,
      deploymentName: 'test',
      network: 'testnet',
      proofTopology,
      valuesDir: path.join(root, 'values'),
      withdrawalConfigPath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
    })

    for (const component of ['withdrawal-processor', 'proof-coordinator']) {
      const values = yaml.load(fs.readFileSync(
        path.join(root, `values/${component}-production.yaml`),
        'utf8',
      )) as any
      expect(values.secrets['proof-runtime-seed'].stringData['root_verifier_vk.b64'])
        .to.equal('AAECAw==')
      expect(values.initContainers['prepare-proof-runtime-materials'].args[0])
        .to.include('root_verifier_vk.b64')
    }
  })

  it('keeps Kubernetes as an explicit deployment backend for local CPU Workers', () => {
    const proofTopology = topology('active', 'kubernetes')
    proofTopology.generation = 'real'
    reconcileCompiledProofTopology({
      compile: () => fakeBundle(path.join(root, '.data/generated/proof-topology'), 'active', 'real'),
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      deploymentDir: root,
      deploymentName: 'test',
      network: 'testnet',
      proofTopology,
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

  it('projects eager compiler output and identity mounts without overriding operator IAM', () => {
    const bundle = fakeBundle(path.join(root, 'eager-bundle'), 'active')
    bundle.manifest.eager_materializer = 'eager-materializer.toml'
    const content = '[service]\nlisten_port = 3107\nstate_dir = "/app/state"\n[materializer]\nl2_genesis_json = "/app/genesis/genesis.json"\n'
    fs.writeFileSync(path.join(bundle.bundleDir, bundle.manifest.eager_materializer), content)
    const file = path.join(root, 'values/eager-materializer-production.yaml')
    fs.writeFileSync(file, yaml.dump({serviceAccount: {annotations: {'eks.amazonaws.com/role-arn': 'operator-role'}}}))
    configureEagerMaterializerValues(file, bundle, topology('active'))
    const values = yaml.load(fs.readFileSync(file, 'utf8')) as any
    expect(values.eagerMaterializer.config).to.equal(content)
    expect(values.controller.replicas).to.equal(1)
    expect(values.persistence.data.mountPath).to.equal('/app/state')
    expect(values.service.main.ports.http.port).to.equal(3107)
    expect(values.persistence.genesis.name).to.equal('genesis-config')
    expect(values.persistence['proof-topology-materials'].mountPath).to.equal('/app/data/proof-topology')
    expect(values.serviceAccount.annotations['eks.amazonaws.com/role-arn']).to.equal('operator-role')
    delete bundle.manifest.eager_materializer
    configureEagerMaterializerValues(file, bundle, topology('disabled'))
    expect((yaml.load(fs.readFileSync(file, 'utf8')) as any).controller.replicas).to.equal(0)
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
    for (const name of ['liveness', 'readiness', 'startup']) {
      expect(coordinator.probes[name].spec.httpGet).to.equal(null)
      expect(coordinator.probes[name].spec.exec.command).to.deep.equal(['sh', '-ec', 'kill -0 1'])
    }

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

  it('restores HTTP probes across disabled-active-disabled mode changes', () => {
    for (const mode of ['disabled', 'active', 'disabled'] as const) {
      reconcileCompiledProofTopology({
        compile: () => fakeBundle(path.join(root, '.data/generated/proof-topology'), mode),
        coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
        deploymentDir: root,
        deploymentName: 'test',
        network: 'testnet',
        proofTopology: topology(mode),
        valuesDir: path.join(root, 'values'),
        withdrawalConfigPath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
      })
      const coordinator = yaml.load(fs.readFileSync(path.join(root, 'values/proof-coordinator-production.yaml'), 'utf8')) as any
      for (const name of ['liveness', 'readiness', 'startup']) {
        const {spec} = coordinator.probes[name]
        if (mode === 'active') {
          expect(spec.exec).to.equal(null)
          expect(spec.httpGet).to.deep.equal({path: name === 'readiness' ? '/readyz' : '/healthz', port: 'prover'})
        } else {
          expect(spec.httpGet).to.equal(null)
          expect(spec.exec.command).to.deep.equal(['sh', '-ec', 'kill -0 1'])
        }
      }
    }
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
