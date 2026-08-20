import * as toml from '@iarna/toml'
import { expect } from 'chai'
import * as yaml from 'js-yaml'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  configureDisabledProofValues,
  configureProofValues,
  deriveAllowedProofTriples,
} from '../../src/utils/proof-configurator.js'
import { scaffoldProofCoordinatorConfig } from '../../src/utils/proof-coordinator-scaffold.js'
import {
  hydrateProverWorkerMockBundle,
  verifyProverWorkerMockBundle,
  writeProverWorkerMockBundle,
} from '../../src/utils/prover-worker-mock-bundle.js'

function writeValidProofRelease(root: string): {
  aggVk: Buffer
  artifactPath: string
  families: readonly ['scroll_chunk', 'scroll_batch', 'advance_l2_aggregation', 'bridge_transition']
  manifests: string[]
  raw: Record<string, string>
} {
  const families = ['scroll_chunk', 'scroll_batch', 'advance_l2_aggregation', 'bridge_transition'] as const
  const programHashes: Record<string, string> = {}
  const raw: Record<string, string> = {}
  const verificationKeyHashes: Record<string, string> = {}
  const manifests: string[] = []
  for (const [index, family] of families.entries()) {
    const commitment = Buffer.alloc(64, index + 1)
    raw[family] = `0x${commitment.toString('hex')}`
    programHashes[family] = `0x${createHash('sha256').update(commitment).digest('hex')}`
    verificationKeyHashes[family] = `0x${Buffer.alloc(32, index + 4).toString('hex')}`
    const manifestPath = path.join(root, `${family}.json`)
    fs.writeFileSync(manifestPath, JSON.stringify({
      artifacts: [
        { kind: 'app_vmexe', sha256: `0x${'11'.repeat(32)}`, size_bytes: 1024 },
        { kind: 'openvm_config', sha256: `0x${'22'.repeat(32)}`, size_bytes: 512 },
      ],
      circuit_id: `${family}-v1`,
      circuit_version: '1.0.0',
      hard_fork_name: 'galileo_v2',
      program_commitment_hash: programHashes[family],
      proof_family: family,
      proof_system_id: 'scroll-zkvm-v1',
      schema_version: 1,
      toolchain: { openvm_version: 'v1', rust_toolchain: 'nightly' },
      verification_key_hash: verificationKeyHashes[family],
    }))
    manifests.push(manifestPath)
  }

  const aggVk = Buffer.from('aggregate-verifying-key-fixture')
  const aggVkPath = path.join(root, 'agg-vk.bin')
  fs.writeFileSync(aggVkPath, aggVk)
  const artifactPath = path.join(root, 'release.json')
  fs.writeFileSync(artifactPath, JSON.stringify({
    artifacts: {
      agg_verifying_key: {
        path: aggVkPath,
        sha256: createHash('sha256').update(aggVk).digest('hex'),
      },
    },
    expected_identity: {
      advance_l2_aggregation_app_commit_raw: raw.advance_l2_aggregation,
      advance_l2_aggregation_program_commitment_hash: programHashes.advance_l2_aggregation,
      advance_l2_aggregation_verification_key_hash: verificationKeyHashes.advance_l2_aggregation,
      batch_program_commitment_hash: programHashes.scroll_batch,
      batch_program_commitment_raw: raw.scroll_batch,
      batch_verification_key_hash: verificationKeyHashes.scroll_batch,
      bridge_app_commit_raw: raw.bridge_transition,
      bridge_program_commitment_hash: programHashes.bridge_transition,
      bridge_verification_key_hash: verificationKeyHashes.bridge_transition,
      chunk_program_commitment_hash: programHashes.scroll_chunk,
      chunk_program_commitment_raw: raw.scroll_chunk,
      chunk_verification_key_hash: verificationKeyHashes.scroll_chunk,
    },
  }))

  return { aggVk, artifactPath, families, manifests, raw }
}

describe('proof-configurator', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-configurator-'))
    fs.mkdirSync(path.join(root, 'values'))
    fs.writeFileSync(path.join(root, 'values/proof-coordinator-production.yaml'), yaml.dump({
      configMaps: {
        manifests: {
          data: {
            README: 'operator-owned entry\n',
            'legacy.json': '{"stale":true}\n',
          },
          enabled: true,
        },
      },
      env: [
        { name: 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__BUCKET', value: 'proof-bucket' },
        { name: 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__REGION', value: 'us-west-2' },
        { name: 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__KEY_PREFIX', value: 'releases/v1' },
        { name: 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__FORCE_PATH_STYLE', value: 'false' },
        { name: 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__ENDPOINT_URL', value: 'https://s3.example.com' },
      ],
      externalSecrets: {
        'proof-secrets': {
          data: [
            { remoteRef: { key: 'proof-token' }, secretKey: 'proof-work-token' },
            { remoteRef: { key: 'worker-token' }, secretKey: 'prover-worker-token' },
          ],
          provider: 'aws',
        },
      },
      proofCoordinator: { config: { required: true } },
    }))
    fs.mkdirSync(path.join(root, 'proof-coordinator'), { recursive: true })
fs.writeFileSync(path.join(root, 'proof-coordinator/ProofCoordinator.toml'), `# user comment must survive
poll_interval_ms = 2345
protocol_context_json = "/app/protocol_context.json"

[auth]
bearer_token_file = "/run/secrets/proof-work-token"

[artifact_store]
kind = "s3"
key_prefix = "proof-topology"
force_path_style = false

# BEGIN scrollsdk managed verifier configuration
[verifier]
verifier_import_mode = "dev_dummy"
# END scrollsdk managed verifier configuration

[artifact_write]
max_proof_bytes = 42

[prover_api]
enabled = true
bind_addr = "0.0.0.0:9400"
worker_auth_token_file = "/run/secrets/prover-worker-token"
max_lease_ttl_ms = 300000
transport = "s3"

[materializer]
artifact_store_root = "/app/data/proof-artifacts"

[materializer.scroll_chunk_segmentation]
enabled = true

[materializer.scroll_batch]
enabled = true
dev_sentinel = false
materializer_output_root = "/app/data/scroll-batch-materializer"

[materializer.scroll_batch.subprocess]
binary_path = "/usr/local/bin/scroll-runtime-materializer"
statement_namespace_config_path = "/app/data/manifests/statement-namespace.json"
scratch_root = "/app/data/scroll-batch-scratch"
chunk_program_commitment_hex = "overridden-by-scrollsdk"
l2_rpc_url = "http://l2-rpc:8545"
subprocess_timeout_ms = 3600000

[materializer.scroll_batch.subprocess.ethereum_da]
l1_rpc_url = "https://ethereum.example.com"
artifact_store_root = "/app/data/scroll-batch-eth-da/blobs"
artifact_metadata_sqlite_path = "/app/data/scroll-batch-eth-da/meta.sqlite"

[materializer.scroll_batch.subprocess.ethereum_da.blob_source]
timeout_ms = 10000

[materializer.scroll_batch.subprocess.ethereum_da.blob_source.aws_s3]
url = "https://eth-da.example.com"
key_prefix = "batches"

[materializer.bridge]
enabled = true
advance_l1 = true
advance_l2 = true

[materializer.bridge.dogecoin_rpc]
url = "http://dogecoin:22555"
network = "testnet"

[materializer.bridge.ethereum_da]
l1_rpc_url = "https://ethereum.example.com"
artifact_store_root = "/app/data/eth-da/blobs"
artifact_metadata_sqlite_path = "/app/data/eth-da/meta.sqlite"

[materializer.bridge.ethereum_da.blob_source]
timeout_ms = 10000

[materializer.bridge.ethereum_da.blob_source.aws_s3]
url = "https://eth-da.example.com"
key_prefix = "batches"
`)
    fs.mkdirSync(path.join(root, 'withdrawal-processor'), { recursive: true })
    fs.writeFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), `# withdrawal user comment must survive
[proof_system]
mode = "disabled"
require_scroll_execution = false
require_bridge_state = false

[operator_tuning]
max_items = 42
`)
    fs.writeFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), yaml.dump({
      configMaps: {
        config: {
          enabled: true,
        },
        'proof-manifests': {
          data: {
            README: 'operator-owned entry\n',
            'legacy.json': '{"stale":true}\n',
          },
          enabled: true,
        },
      },
      env: [
        { name: 'DOGEOS_WITHDRAWAL_PROOF_TASK_POLICY__SKIP_SCROLL_EXECUTION_PROOFS', value: 'true' },
        { name: 'DOGEOS_WITHDRAWAL_PROOF_EXECUTION_WORKER__ENABLED', value: 'false' },
        { name: 'DOGEOS_WITHDRAWAL_PROVING_MODE', value: 'dev_simulated' },
        { name: 'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__VERIFIER_IMPORT_MODE', value: 'real_scroll' },
        { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE', value: 'disabled' },
        { name: 'DOGEOS_WITHDRAWAL_CLEANUP_TIMEOUT_SECS', value: '3600' },
      ],
      withdrawalProof: { s3AuthMode: 'ambient' },
    }))
  })

  afterEach(() => fs.rmSync(root, { force: true, recursive: true }))

  it('projects disabled mode without coordinator manifests, proof secrets, or proof-work service', () => {
    const result = configureDisabledProofValues({ valuesDir: path.join(root, 'values') })
    expect(result.helmSetFiles.proofCoordinator).to.deep.equal([])
    expect(result.helmSetFiles.withdrawalProcessor).to.have.length(1)
    const values = yaml.load(fs.readFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), 'utf8')) as any
    expect(values.withdrawalProof).to.deep.include({ enabled: false, mode: 'disabled' })
    expect(values.withdrawalProof.provingMode).to.equal(undefined)
    expect(values.configMaps['proof-manifests']).to.equal(undefined)
    expect(values.persistence['proof-manifests']).to.equal(undefined)
    expect(values.persistence['proof-secrets']).to.equal(undefined)
    expect(values.service?.main?.ports?.['proof-work']).to.equal(undefined)
    const native = toml.parse(fs.readFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), 'utf8')) as any
    expect(native.proof_system.mode).to.equal('disabled')
    expect(native.proof_work_api).to.equal(undefined)
    expect(values.env.some((item: any) => item.name.startsWith('DOGEOS_WITHDRAWAL_PROOF_WORK_API__'))).to.equal(false)
  })

  it('projects and retires the temporary pre-Tsuki direct-sign WP pin atomically', () => {
    const valuesDir = path.join(root, 'values')
    configureDisabledProofValues({
      preTsukiDirectSignMaxEndBatchHeight: 6863,
      valuesDir,
    })
    let native = toml.parse(
      fs.readFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), 'utf8'),
    ) as any
    expect(native.proof_system).to.deep.include({
      mode: 'disabled',
      require_bridge_state: false,
      require_scroll_execution: false,
    })
    expect(native.proof_system.pre_tsuki_direct_sign).to.deep.equal({
      max_end_batch_height: 6863,
    })

    configureDisabledProofValues({valuesDir})
    native = toml.parse(
      fs.readFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), 'utf8'),
    ) as any
    expect(native.proof_system.pre_tsuki_direct_sign).to.equal(undefined)
  })

  it('fails closed when the required native WithdrawalProcessor TOML template is missing', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const withdrawalConfigPath = path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
    const coordinatorConfigPath = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    const coordinatorBefore = fs.readFileSync(coordinatorConfigPath, 'utf8')
    const withdrawalValuesPath = path.join(root, 'values/withdrawal-processor-production.yaml')
    const withdrawalValuesBefore = fs.readFileSync(withdrawalValuesPath, 'utf8')
    fs.rmSync(withdrawalConfigPath)

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath,
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })).to.throw('WithdrawalProcessor TOML template not found')

    expect(fs.existsSync(withdrawalConfigPath)).to.equal(false)
    expect(fs.readFileSync(coordinatorConfigPath, 'utf8')).to.equal(coordinatorBefore)
    expect(fs.readFileSync(withdrawalValuesPath, 'utf8')).to.equal(withdrawalValuesBefore)
  })

  it('validates release identities and updates coordinator and WP values consistently', () => {
    const { aggVk, artifactPath, families, manifests, raw } = writeValidProofRelease(root)

    const result = configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://signer-proofs.example.com/public/proof-topology/',
      valuesDir: path.join(root, 'values'),
    })
    expect(result.families).to.deep.equal(['advance_l2_aggregation', 'bridge_transition', 'scroll_batch', 'scroll_chunk'])

    const firstWithdrawalValues = fs.readFileSync(result.files[1], 'utf8')
    configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://signer-proofs.example.com/public/proof-topology/',
      valuesDir: path.join(root, 'values'),
    })
    expect(fs.readFileSync(result.files[1], 'utf8')).to.equal(firstWithdrawalValues)

    const coordinator = yaml.load(fs.readFileSync(result.files[0], 'utf8')) as any
    const coordinatorToml = fs.readFileSync(result.configFile, 'utf8')
    const parsedCoordinator = toml.parse(coordinatorToml) as any
    expect(parsedCoordinator.verifier.scroll_chunk_verifier_identity.expected_circuit_id).to.equal('scroll_chunk-v1')
    expect(parsedCoordinator.verifier.l2_range_aggregation_verifier_identity.expected_circuit_id)
      .to.equal('advance_l2_aggregation-v1')
    expect(parsedCoordinator.verifier.scroll_real_verifier.l2_range_aggregation_program_commitment_hex)
      .to.equal(raw.advance_l2_aggregation)
    expect(coordinatorToml).to.include('# user comment must survive')
    expect(parsedCoordinator.poll_interval_ms).to.equal(2345)
    expect(parsedCoordinator.artifact_write.max_proof_bytes).to.equal(42)
    expect(parsedCoordinator.auth.bearer_token_file).to.equal('/app/secrets/proof-work-token')
    expect(parsedCoordinator.prover_api.worker_auth_token_file).to.equal('/app/secrets/prover-worker-token')
    expect(coordinator.persistence.secrets.mountPath).to.equal('/app/secrets')
    expect(coordinator.configMaps.manifests.data).to.deep.equal({ README: 'operator-owned entry\n' })
    const statementNamespace = JSON.parse(fs.readFileSync(result.statementNamespaceFile, 'utf8'))
    expect(statementNamespace.chunk).to.deep.include({
      circuit_id: 'scroll_chunk-v1',
      proof_mode: 'Production',
      proof_system_id: 'scroll-zkvm-v1',
    })
    expect(statementNamespace.batch).to.deep.include({
      circuit_id: 'scroll_batch-v1',
      proof_mode: 'Production',
      proof_system_id: 'scroll-zkvm-v1',
    })
    expect(result.files).to.include(result.statementNamespaceFile)
    expect(result.statementNamespaceFile).to.equal(path.join(root, 'proof-artifacts/manifests/statement-namespace.json'))
    expect(result.helmSetFiles.proofCoordinator).to.deep.equal([
      {
        filePath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
        key: 'proofCoordinator.config.content',
      },
      ...families.map((family, index) => ({
        filePath: manifests[index],
        key: `configMaps.manifests.data.${family}\\.json`,
      })),
      {
        filePath: path.join(root, 'proof-artifacts/manifests/statement-namespace.json'),
        key: 'configMaps.manifests.data.statement-namespace\\.json',
      },
    ])
    expect(result.helmSetFiles.withdrawalProcessor).to.deep.equal([
      {
        filePath: path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'),
        key: 'configMaps.config.data.WithdrawalProcessor\\.toml',
      },
      ...families.map((family, index) => ({
        filePath: manifests[index],
        key: `configMaps.proof-manifests.data.${family}\\.json`,
      })),
    ])
    const coordinatorEnv = Object.fromEntries(coordinator.env.map((item: any) => [item.name, item.value]))
    expect(coordinatorEnv.DOGEOS_PROOF_COORDINATOR_MATERIALIZER__SCROLL_BATCH__SUBPROCESS__CHUNK_PROGRAM_COMMITMENT_HEX)
      .to.equal(raw.scroll_chunk)
    expect(coordinator.persistence.manifests.mountPath).to.equal('/app/data/manifests')
    expect(coordinator.persistence.manifests.name).to.equal('{{ include "scroll.common.lib.chart.names.fullname" . }}-manifests')
    expect(coordinator.initContainers['prepare-proof-data-directories']).to.deep.equal({
      args: [
        "mkdir -p '/app/data/eth-da' '/app/data/eth-da/blobs' '/app/data/proof-artifacts' '/app/data/scroll-batch-eth-da' '/app/data/scroll-batch-eth-da/blobs' '/app/data/scroll-batch-materializer' '/app/data/scroll-batch-scratch'",
      ],
      command: ['/bin/sh', '-ec'],
      image: 'busybox:1.36.1',
      volumeMounts: [{ mountPath: '/app/data', name: 'data' }],
    })
    expect(coordinator.configMaps['agg-verifying-key'].data['agg-vk.bin.b64']).to.equal(aggVk.toString('base64'))
    expect(coordinator.service.main.ports.http).to.deep.equal({
      enabled: true,
      port: 9400,
      protocol: 'TCP',
    })

    const withdrawal = yaml.load(fs.readFileSync(result.files[1], 'utf8')) as any
    const env = Object.fromEntries(withdrawal.env.map((item: any) => [item.name, item.value]))
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_PROOF_TASK_POLICY__SKIP_SCROLL_EXECUTION_PROOFS')
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_PROOF_EXECUTION_WORKER__ENABLED')
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_PROVING_MODE')
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__VERIFIER_IMPORT_MODE')
    expect(env.DOGEOS_WITHDRAWAL_CLEANUP_TIMEOUT_SECS).to.equal('3600')
    expect(Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('DOGEOS_WITHDRAWAL_PROOF_')))).to.deep.equal({
      DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE: 'production',
      DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_BRIDGE_STATE: 'true',
      DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_SCROLL_EXECUTION: 'true',
    })
    expect(withdrawal.withdrawalProof.enabled).to.equal(true)
    expect(withdrawal.withdrawalProof.mode).to.equal('production')
    expect(withdrawal.withdrawalProof.provingMode).to.equal('production')
    expect(withdrawal.configMaps.config.data?.['WithdrawalProcessor.toml']).to.equal(undefined)
    expect(withdrawal.configMaps['proof-manifests'].data).to.deep.equal({ README: 'operator-owned entry\n' })

    const withdrawalToml = fs.readFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), 'utf8')
    const parsedWithdrawal = toml.parse(withdrawalToml) as any
    expect(withdrawalToml).to.include('# withdrawal user comment must survive')
    expect(withdrawalToml.match(/# BEGIN scrollsdk managed proof configuration/g)).to.have.length(1)
    expect(parsedWithdrawal.operator_tuning.max_items).to.equal(42)
    expect(parsedWithdrawal.proof_system.mode).to.equal('production')
    expect(parsedWithdrawal.proof_system.require_scroll_execution).to.equal(true)
    expect(parsedWithdrawal.proof_system.require_bridge_state).to.equal(true)
    expect(parsedWithdrawal.proof_system.signer_proof_artifact_base_url).to.equal('https://signer-proofs.example.com/public/proof-topology')
    expect(parsedWithdrawal.proof_control_plane_gate.scroll_chunk_circuit_id).to.equal('scroll_chunk-v1')
    expect(parsedWithdrawal.proof_control_plane_gate.scroll_chunk_verification_key_hash_hex).to.equal(Buffer.alloc(32, 4).toString('hex'))
    expect(parsedWithdrawal.proof_control_plane_gate.scroll_chunk_program_commitment_hash_hex).to.equal(`0x${createHash('sha256').update(Buffer.alloc(64, 1)).digest('hex')}`)
    expect(parsedWithdrawal.proof_control_plane_gate.scroll_chunk_verifier_identity.expected_circuit_id).to.equal('scroll_chunk-v1')
    expect(parsedWithdrawal.proof_control_plane_gate.scroll_real_verifier.batch_program_commitment_hex).to.equal(raw.scroll_batch.slice(2))
    expect(parsedWithdrawal.proof_work_api.materialize.bridge.advance_l2_enabled).to.equal(true)
    expect(parsedWithdrawal.proof_work_api.materialize.bridge.remote_prove_options.backend_profile).to.equal('bridge-prod-zkvm-v1')
    expect(parsedWithdrawal.proof_work_api.materialize.scroll_batch.remote_prove_options.backend_profile).to.equal('scroll-prod-zkvm-batch-v1')
    expect(parsedWithdrawal.proof_work_api.materialize.scroll_chunk_segmentation.enabled).to.equal(true)
    expect(parsedWithdrawal.proof_artifact_transport.force_path_style).to.equal(false)
    expect(parsedWithdrawal.proof_artifact_transport.endpoint_url).to.equal('https://s3.example.com')
    expect(parsedWithdrawal.proof_artifact_transport.signed_url_ttl_ms).to.equal(3_600_000)
    expect(parsedWithdrawal.proof_artifact_transport.max_read_body_bytes).to.equal(512 * 1024 * 1024)
    expect(withdrawal.args).to.deep.equal(['--config', '/app/config/WithdrawalProcessor.toml'])
    expect(withdrawal.persistence['withdrawal-processor-config'].subPath).to.equal('WithdrawalProcessor.toml')
    expect(withdrawal.persistence['proof-manifests'].name).to.equal('{{ include "withdrawal-processor.fullname" . }}-proof-manifests')
    expect(withdrawal.persistence['proof-secrets'].name).to.equal('proof-secrets')
    expect(withdrawal.persistence['proof-secrets'].mountPath).to.equal('/app/secrets')
    expect(withdrawal.service.main.ports['proof-work'].port).to.equal(9300)
    expect(withdrawal.configMaps['agg-verifying-key'].data['agg-vk.bin.b64']).to.equal(aggVk.toString('base64'))
    expect(withdrawal.initContainers['install-agg-verifying-key'].args[0]).to.include('/app/data/verifier/agg-vk.bin')
    expect(withdrawal.externalSecrets['proof-secrets'].data).to.have.length(1)

  })

  it('never reads or mutates retired attestation-signer Helm values', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const signerTemplatePath = path.join(root, 'values/attestation-signer-production.yaml')
    fs.writeFileSync(signerTemplatePath, 'retired: true\n')
    const before = fs.readFileSync(signerTemplatePath, 'utf8')

    const result = configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })
    expect(result.files).not.to.include(signerTemplatePath)
    expect(fs.readFileSync(signerTemplatePath, 'utf8')).to.equal(before)
  })

  it('succeeds without attestation-signer values because signers are partner-operated', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const coordinatorConfigPath = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    const coordinatorBefore = fs.readFileSync(coordinatorConfigPath, 'utf8')

    configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath,
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })
    expect(fs.readFileSync(coordinatorConfigPath, 'utf8')).not.to.equal(coordinatorBefore)
  })

  it('rejects a verifier ID that would corrupt the signer triple CSV', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
      verifierIds: { scroll_batch: 'bad:id' },
    })).to.throw("must not contain ':' or ','")
  })

  it('rejects a manifest that the Rust ProofProgramManifestV1 loader would reject', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const invalid = JSON.parse(fs.readFileSync(manifests[0], 'utf8'))
    invalid.artifacts = []
    fs.writeFileSync(manifests[0], JSON.stringify(invalid))

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })).to.throw('artifacts must contain app_vmexe followed by openvm_config')
  })

  it('writes the managed proof block to a native WithdrawalProcessor.toml when present', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const nativePath = path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
    fs.mkdirSync(path.dirname(nativePath), { recursive: true })
    fs.writeFileSync(nativePath, `# operator comment survives
network_str = "testnet"

[operator_tuning]
max_items = 42
`)

    const result = configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })
    expect(result.files).to.include(nativePath)

    const nativeSource = fs.readFileSync(nativePath, 'utf8')
    expect(nativeSource).to.include('# operator comment survives')
    const parsedNative = toml.parse(nativeSource) as any
    expect(parsedNative.operator_tuning.max_items).to.equal(42)
    expect(parsedNative.proof_system.mode).to.equal('production')
    expect(parsedNative.proof_work_api.bind_addr).to.equal('0.0.0.0:9300')

    const withdrawal = yaml.load(fs.readFileSync(result.files[1], 'utf8')) as any
    // Inline copy dropped: helm --set-file supplies the ConfigMap key.
    expect(withdrawal.configMaps.config.data?.['WithdrawalProcessor.toml']).to.equal(undefined)
    expect(withdrawal.configMaps.config.enabled).to.equal(true)
    expect(withdrawal.args).to.deep.equal(['--config', '/app/config/WithdrawalProcessor.toml'])
    expect(withdrawal.persistence['withdrawal-processor-config'].subPath).to.equal('WithdrawalProcessor.toml')
  })

  it('accepts a scaffolded coordinator config end to end', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    fs.writeFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), `
network_str = "testnet"
dogecoin_rpc_url = "http://dogecoin:22555"

[dogeos_indexer]
rpc_url = "http://l2-rpc:8545"

[ethereum_da]
l1_rpc_url = "https://ethereum.example.com"

[ethereum_da.blob_source.aws_s3]
url = "https://blob-archive.example.com"
`)
    const coordinatorConfigPath = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    fs.rmSync(coordinatorConfigPath)

    const scaffold = scaffoldProofCoordinatorConfig({
      coordinatorConfigPath,
      valuesDir: path.join(root, 'values'),
    })
    expect(scaffold.created).to.equal(true)

    const result = configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath,
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })
    expect(result.families).to.deep.equal(['advance_l2_aggregation', 'bridge_transition', 'scroll_batch', 'scroll_chunk'])
    const coordinatorToml = toml.parse(fs.readFileSync(coordinatorConfigPath, 'utf8')) as any
    expect(coordinatorToml.verifier.scroll_batch_verifier_identity.expected_circuit_id).to.equal('scroll_batch-v1')
    expect(coordinatorToml.verifier.scroll_real_verifier.agg_verifying_key_path).to.equal('/app/data/verifier/agg-vk.bin')
  })

  it('atomically enables the proof runtime for production mode', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const withdrawalValuesPath = path.join(root, 'values/withdrawal-processor-production.yaml')

    configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })
    const withdrawal = yaml.load(fs.readFileSync(withdrawalValuesPath, 'utf8')) as any
    expect(withdrawal.withdrawalProof.enabled).to.equal(true)
    const env = Object.fromEntries(withdrawal.env.map((item: any) => [item.name, item.value]))
    expect(env.DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE).to.equal('production')
    expect(env.DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_SCROLL_EXECUTION).to.equal('true')
    expect(env.DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_BRIDGE_STATE).to.equal('true')
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_PROOF_WORK_API__ENABLED')
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_PROOF_SYSTEM__DEV_DUMMY__SCROLL_INPUT')
  })

  it('fails before writing when the signer public artifact base is absent', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const coordinatorConfigPath = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    const coordinatorBefore = fs.readFileSync(coordinatorConfigPath, 'utf8')
    const coordinatorValuesPath = path.join(root, 'values/proof-coordinator-production.yaml')
    const coordinatorValuesBefore = fs.readFileSync(coordinatorValuesPath, 'utf8')

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath,
      manifestPaths: manifests,
      valuesDir: path.join(root, 'values'),
    })).to.throw('proofSystem.artifactReadBaseUrl is required')
    expect(fs.readFileSync(coordinatorConfigPath, 'utf8')).to.equal(coordinatorBefore)
    expect(fs.readFileSync(coordinatorValuesPath, 'utf8')).to.equal(coordinatorValuesBefore)
  })

  it('rejects a native S3 artifact root that omits the configured key prefix', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proof-bucket.s3.us-west-2.amazonaws.com',
      valuesDir: path.join(root, 'values'),
    })).to.throw('must end at key prefix /releases/v1')
  })

  it('accepts a native S3 artifact root ending at the configured key prefix', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const result = configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proof-bucket.s3.us-west-2.amazonaws.com/releases/v1/',
      valuesDir: path.join(root, 'values'),
    })

    expect(result.signerProofArtifactBaseUrl).to.equal('https://proof-bucket.s3.us-west-2.amazonaws.com/releases/v1')
    expect(result.artifactReadBaseUrlMapping).to.equal('native-s3-prefix')
  })

  it('validates native path-style S3 roots against both bucket and key prefix', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const options = {
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      valuesDir: path.join(root, 'values'),
    }
    expect(() => configureProofValues({
      ...options,
      signerProofArtifactBaseUrl: 'https://s3.us-west-2.amazonaws.com/proof-bucket',
    })).to.throw('must end at /proof-bucket/releases/v1')

    const result = configureProofValues({
      ...options,
      signerProofArtifactBaseUrl: 'https://s3.us-west-2.amazonaws.com/proof-bucket/releases/v1',
    })
    expect(result.artifactReadBaseUrlMapping).to.equal('native-s3-prefix')
  })

  it('classifies a custom gateway root for an operator-visible mapping warning', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const result = configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com',
      valuesDir: path.join(root, 'values'),
    })

    expect(result.artifactReadBaseUrlMapping).to.equal('custom-gateway-root')
  })

  it('overrides a stale disabled switch from the selected production mode', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const withdrawalValuesPath = path.join(root, 'values/withdrawal-processor-production.yaml')
    const withdrawal = yaml.load(fs.readFileSync(withdrawalValuesPath, 'utf8')) as any
    withdrawal.withdrawalProof.enabled = false
    fs.writeFileSync(withdrawalValuesPath, yaml.dump(withdrawal))

    configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })

    const updated = yaml.load(fs.readFileSync(withdrawalValuesPath, 'utf8')) as any
    expect(updated.withdrawalProof.enabled).to.equal(true)
    const env = Object.fromEntries(updated.env.map((item: any) => [item.name, item.value]))
    expect(env.DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE).to.equal('production')
  })

  it('requires an explicit proof S3 authentication mode before writing', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const withdrawalValuesPath = path.join(root, 'values/withdrawal-processor-production.yaml')
    const withdrawal = yaml.load(fs.readFileSync(withdrawalValuesPath, 'utf8')) as any
    delete withdrawal.withdrawalProof.s3AuthMode
    fs.writeFileSync(withdrawalValuesPath, yaml.dump(withdrawal))
    const coordinatorConfigPath = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    const coordinatorBefore = fs.readFileSync(coordinatorConfigPath, 'utf8')

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath,
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })).to.throw('withdrawalProof.s3AuthMode must be explicitly set to ambient or irsa')
    expect(fs.readFileSync(coordinatorConfigPath, 'utf8')).to.equal(coordinatorBefore)
  })

  it('requires IRSA role annotations on both proof workloads', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const withdrawalValuesPath = path.join(root, 'values/withdrawal-processor-production.yaml')
    const withdrawal = yaml.load(fs.readFileSync(withdrawalValuesPath, 'utf8')) as any
    withdrawal.withdrawalProof.s3AuthMode = 'irsa'
    withdrawal.serviceAccount = { annotations: {}, create: true }
    fs.writeFileSync(withdrawalValuesPath, yaml.dump(withdrawal))

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })).to.throw('proof-coordinator values: serviceAccount.create must be true')
  })

  it('requires the external prover gateway before staging topology', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const coordinatorConfigPath = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    const source = fs.readFileSync(coordinatorConfigPath, 'utf8')
    fs.writeFileSync(coordinatorConfigPath, source.replace('[prover_api]\nenabled = true', '[prover_api]\nenabled = false'))

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath,
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })).to.throw('[prover_api].enabled = true is required for external workers')
  })

  it('rejects a verifier-only coordinator before enabling WP materialize claims', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const coordinatorConfigPath = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    const source = fs.readFileSync(coordinatorConfigPath, 'utf8')
    fs.writeFileSync(coordinatorConfigPath, source.replaceAll(/\n\[materializer][\S\s]*$/g, '\n'))

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath,
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })).to.throw('verifier-only proof-coordinator config cannot consume WP materialize claims')
  })

  it('rejects a malformed WP managed marker before writing coordinator files', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const withdrawalConfigPath = path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
    fs.writeFileSync(withdrawalConfigPath, `# BEGIN scrollsdk managed proof configuration
[proof_system]
mode = "disabled"
`)
    const coordinatorConfigPath = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    const coordinatorBefore = fs.readFileSync(coordinatorConfigPath, 'utf8')

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath,
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })).to.throw('must contain either zero or one')
    expect(fs.readFileSync(coordinatorConfigPath, 'utf8')).to.equal(coordinatorBefore)
  })

  it('rejects an artifact transport TTL beyond the Rust contract horizon', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const coordinatorConfigPath = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    const source = fs.readFileSync(coordinatorConfigPath, 'utf8')
    fs.writeFileSync(
      coordinatorConfigPath,
      source.replace('[artifact_write]\n', '[artifact_write]\nsigned_put_expiry_ms = 604800001\n')
    )

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath,
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })).to.throw('proof_artifact_transport.signed_url_ttl_ms must be a positive integer no greater than 604800000')
  })

  it('rejects an unresolved proof artifact bucket placeholder', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const coordinatorValuesPath = path.join(root, 'values/proof-coordinator-production.yaml')
    const coordinator = yaml.load(fs.readFileSync(coordinatorValuesPath, 'utf8')) as any
    coordinator.env.find((item: any) => item.name === 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__BUCKET').value = '<TODO>'
    fs.writeFileSync(coordinatorValuesPath, yaml.dump(coordinator))

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })).to.throw('artifact-store bucket must not contain an unresolved placeholder')
  })

  it('rejects an unresolved materializer path placeholder', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const coordinatorConfigPath = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    const source = fs.readFileSync(coordinatorConfigPath, 'utf8')
    fs.writeFileSync(
      coordinatorConfigPath,
      source.replace(
        'artifact_store_root = "/app/data/proof-artifacts"',
        'artifact_store_root = "<TODO>"'
      )
    )

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath,
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })).to.throw('[materializer].artifact_store_root must not contain an unresolved placeholder')
  })

  it('rejects coordinator writable paths outside the data PVC mount', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const coordinatorConfigPath = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    const source = fs.readFileSync(coordinatorConfigPath, 'utf8')
    fs.writeFileSync(
      coordinatorConfigPath,
      source.replace(
        'materializer_output_root = "/app/data/scroll-batch-materializer"',
        'materializer_output_root = "/tmp/scroll-batch-materializer"'
      )
    )

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath,
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })).to.throw('[materializer.scroll_batch].materializer_output_root must be a normalized path under /app/data')
  })

  it('rejects an unresolved backend profile placeholder', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      bridgeBackendProfile: '<AUTO>',
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })).to.throw('Bridge backend profile must not contain an unresolved placeholder')
  })

  it('projects operator-selected backend profiles into managed TOML', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    configureProofValues({
      artifactManifestPath: artifactPath,
      bridgeBackendProfile: 'bridge-prod-hsm-v2',
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      scrollBatchBackendProfile: 'scroll-prod-gpu-v2',
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })
    const config = toml.parse(fs.readFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), 'utf8')) as any
    expect(config.proof_work_api.materialize.bridge.remote_prove_options.backend_profile).to.equal('bridge-prod-hsm-v2')
    expect(config.proof_work_api.materialize.scroll_batch.remote_prove_options.backend_profile).to.equal('scroll-prod-gpu-v2')
  })

  it('rejects a raw commitment that does not match its program manifest', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
    artifact.expected_identity.chunk_program_commitment_raw = `0x${'ff'.repeat(64)}`
    fs.writeFileSync(artifactPath, JSON.stringify(artifact))

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    }))
      .to.throw('does not match program manifest')
  })

  it('rejects release identity hashes that drift from program manifests', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
    artifact.expected_identity.chunk_verification_key_hash = `0x${'ff'.repeat(32)}`
    fs.writeFileSync(artifactPath, JSON.stringify(artifact))

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })).to.throw('chunk_verification_key_hash')
  })

  it('rejects an aggregate verifying key whose bytes do not match the release digest', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
    fs.writeFileSync(artifact.artifacts.agg_verifying_key.path, 'tampered-aggregate-key')

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })).to.throw('Aggregate verifying key SHA-256 mismatch')
  })

  it('reuses the staged signer proof-artifact base URL when the option is omitted on a re-run', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const options = {
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      valuesDir: path.join(root, 'values'),
    }

    const first = configureProofValues({
      ...options,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public/',
    })
    expect(first.signerProofArtifactBaseUrlSource).to.equal('flag')

    const rerun = configureProofValues(options)
    expect(rerun.signerProofArtifactBaseUrlSource).to.equal('staged')
    expect(rerun.signerProofArtifactBaseUrl).to.equal('https://proofs.example.com/public')

    const parsedWithdrawal = toml.parse(fs.readFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), 'utf8')) as any
    expect(parsedWithdrawal.proof_system.signer_proof_artifact_base_url).to.equal('https://proofs.example.com/public')
  })

  it('derives the proof-triple allowlist from the staged coordinator verifier block, honouring overrides', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const coordinatorConfigPath = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath,
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
      verifierIds: { scroll_batch: 'scroll-production-v1' },
    })

    const derived = deriveAllowedProofTriples(coordinatorConfigPath, [])
    expect(derived?.source).to.equal(coordinatorConfigPath)
    expect(derived?.value).to.equal([
      `openvm_state_transition:scroll-zkvm-v1-bridge_transition-v1-1.0.0:${Buffer.alloc(32, 7).toString('hex')}`,
      `scroll_batch:scroll-production-v1:${Buffer.alloc(32, 5).toString('hex')}`,
    ].join(','))
  })

  it('derives the proof-triple allowlist from release manifests before prep-charts has run', () => {
    const { manifests } = writeValidProofRelease(root)

    // The pristine coordinator fixture still carries the dev_dummy scaffold
    // block (no verifier identities), so derivation must fall back.
    const derived = deriveAllowedProofTriples(path.join(root, 'proof-coordinator/ProofCoordinator.toml'), manifests)
    expect(derived?.value).to.equal([
      `openvm_state_transition:scroll-zkvm-v1-bridge_transition-v1-1.0.0:${Buffer.alloc(32, 7).toString('hex')}`,
      `scroll_batch:scroll-zkvm-v1-scroll_batch-v1-1.0.0:${Buffer.alloc(32, 5).toString('hex')}`,
    ].join(','))
  })

  it('returns no derived proof triples when neither the coordinator block nor the manifests exist', () => {
    expect(deriveAllowedProofTriples(path.join(root, 'missing/ProofCoordinator.toml'), [path.join(root, 'missing/manifest.json')])).to.equal(undefined)
  })

  function writeMockCoordinatorToml(dir: string): string {
    const configPath = path.join(dir, 'proof-coordinator/ProofCoordinator.toml')
    fs.writeFileSync(configPath, `poll_interval_ms = 1000
lease_ttl_ms = 60000
protocol_context_json = "/app/protocol_context.json"

[auth]
bearer_token_file = "/app/secrets/proof-work-token"

[artifact_store]
kind = "s3"
key_prefix = "proof-topology"
force_path_style = false

[materializer]
artifact_store_root = "/app/data/proof-materializer-staging"

[materializer.dev_sentinel_scroll_chunk]
enabled = true

[materializer.scroll_batch]
enabled = true
dev_sentinel = true
proof_mode = "Mock"
materializer_output_root = "/app/data/scroll-batch-materializer"

[materializer.bridge]
enabled = true
advance_l1 = true
advance_l2 = true

[materializer.bridge.dogecoin_rpc]
url = "http://dogecoin:22555"
network = "testnet"

[materializer.bridge.ethereum_da]
l1_rpc_url = "https://ethereum.example.com"
artifact_store_root = "/app/data/eth-da/blobs"
artifact_metadata_sqlite_path = "/app/data/eth-da/meta.sqlite"

[materializer.bridge.ethereum_da.blob_source]
timeout_ms = 10000

[materializer.bridge.ethereum_da.blob_source.aws_s3]
url = "https://eth-da.example.com"
key_prefix = "batches"

# BEGIN scrollsdk managed verifier configuration
[verifier]
verifier_import_mode = "dev_dummy"
# END scrollsdk managed verifier configuration

[prover_api]
enabled = true
bind_addr = "0.0.0.0:9400"
worker_auth_token_file = "/app/secrets/prover-worker-token"
max_lease_ttl_ms = 300000
transport = "s3"
`)
    return configPath
  }

  it('stages the complete mock proving topology without release artifacts', () => {
    const coordinatorConfigPath = writeMockCoordinatorToml(root)
    const result = configureProofValues({
      coordinatorConfigPath,
      coordinatorIngressHost: 'proof-coordinator.bridge.example',
      provingMode: 'mock',
      signerProofArtifactBaseUrl: 'https://proofs.example.com',
      valuesDir: path.join(root, 'values'),
    })
    expect(result.provingMode).to.equal('mock')
    expect(result.families).to.deep.equal(['advance_l2_aggregation', 'bridge_transition', 'scroll_batch', 'scroll_chunk'])
    expect(result.statementNamespaceFile).to.equal(path.join(root, 'proof-artifacts/manifests/statement-namespace.json'))
    expect(result.helmSetFiles.proofCoordinator.slice(1, 5).map(binding => binding.filePath)).to.deep.equal([
      path.join(root, 'proof-artifacts/mock-manifests/scroll-chunk-topology-program.json'),
      path.join(root, 'proof-artifacts/mock-manifests/scroll-batch-topology-program.json'),
      path.join(root, 'proof-artifacts/mock-manifests/l2-range-aggregation-topology-program.json'),
      path.join(root, 'proof-artifacts/mock-manifests/bridge-topology-program.json'),
    ])
    expect([
      ...result.helmSetFiles.proofCoordinator,
      ...result.helmSetFiles.withdrawalProcessor,
    ].some(binding => binding.filePath.includes(`${path.sep}.data${path.sep}`))).to.equal(false)

    const withdrawal = yaml.load(fs.readFileSync(result.files[1], 'utf8')) as any
    const parsedWithdrawal = toml.parse(fs.readFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), 'utf8')) as any
    expect(parsedWithdrawal.proof_system.mode).to.equal('dev_dummy')
    expect(parsedWithdrawal.proof_system.dev_dummy).to.equal(undefined)
    expect(parsedWithdrawal.proof_system.require_bridge_state).to.equal(true)
    expect(parsedWithdrawal.proof_system.signer_proof_artifact_base_url).to.equal('https://proofs.example.com')
    expect(parsedWithdrawal.l2_proof_pipeline.enabled).to.equal(true)
    // The bridge gate is active, so the legacy top-level gate identity must
    // be the bridge identity (dogeos-core e2e strict-withdrawal contract).
    expect(parsedWithdrawal.proof_control_plane_gate.circuit_id).to.equal('bridge-transition-v1')
    expect(parsedWithdrawal.proof_control_plane_gate.verification_key_hash_hex).to.equal('88'.repeat(32))
    expect(parsedWithdrawal.proof_control_plane_gate.scroll_chunk_verification_key_hash_hex).to.equal('44'.repeat(32))
    expect(parsedWithdrawal.proof_control_plane_gate.scroll_chunk_verifier_identity.verifier_id)
      .to.equal('dogeos-prover-worker-dev-mock-chunk-v1')
    expect(parsedWithdrawal.proof_control_plane_gate.scroll_batch_verifier_identity.verifier_id)
      .to.equal('dogeos-prover-worker-dev-mock-batch-v1')
    expect(parsedWithdrawal.proof_control_plane_gate.scroll_bridge_verifier_identity.verifier_id)
      .to.equal('openvm-bridge-topology-verifier-v1')
    expect(parsedWithdrawal.proof_control_plane_gate.scroll_real_verifier).to.equal(undefined)
    expect(parsedWithdrawal.proof_work_api.materialize.scroll_batch.remote_prove_options.backend_profile)
      .to.equal('scroll-batch-topology-prover-v1')
    expect(parsedWithdrawal.proof_work_api.materialize.bridge.remote_prove_options.backend_profile)
      .to.equal('bridge-topology-prover-v1')
    expect(parsedWithdrawal.proof_work_api.materialize.scroll_chunk_segmentation).to.equal(undefined)

    // Mock is a complete proof-enabled posture; the generic chart only renders
    // the explicit projection selected by setup.
    const env = Object.fromEntries(withdrawal.env.map((item: any) => [item.name, item.value]))
    expect(Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('DOGEOS_WITHDRAWAL_PROOF_')))).to.deep.equal({
      DOGEOS_WITHDRAWAL_PROOF_SYSTEM__DEV_DUMMY__SCROLL_INPUT: 'exact_mock',
      DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE: 'dev_dummy',
      DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_BRIDGE_STATE: 'true',
      DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_SCROLL_EXECUTION: 'true',
    })
    expect(withdrawal.withdrawalProof).to.deep.include({ enabled: true, mode: 'mock', provingMode: 'mock' })
    expect(withdrawal.configMaps['agg-verifying-key']).to.equal(undefined)
    expect(withdrawal.initContainers?.['install-agg-verifying-key']).to.equal(undefined)

    const parsedCoordinator = toml.parse(fs.readFileSync(result.configFile, 'utf8')) as any
    expect(parsedCoordinator.verifier.verifier_import_mode).to.equal('dev_dummy')
    expect(parsedCoordinator.verifier.scroll_real_verifier).to.equal(undefined)
    expect(parsedCoordinator.verifier.scroll_chunk_verifier_identity.verifier_id)
      .to.equal('dogeos-prover-worker-dev-mock-chunk-v1')
    expect(parsedCoordinator.verifier.scroll_batch_verifier_identity.verifier_id)
      .to.equal('dogeos-prover-worker-dev-mock-batch-v1')
    expect(parsedCoordinator.verifier.scroll_bridge_verifier_identity.expected_verification_key_hash_hex)
      .to.equal(`0x${'88'.repeat(32)}`)

    // The generated worker must consume the exact aggregation identity staged
    // into WP, proof-coordinator, and the shared program manifest. This is the
    // cross-output contract prep-charts promises operators in mock mode.
    const workerBundle = writeProverWorkerMockBundle({
      aggregationL2ChainId: 6_281_971,
      artifactReadBaseUrl: 'https://proofs.example.com',
      coordinatorUrl: 'https://proof-coordinator.bridge.example',
      dir: path.join(root, 'prover-worker-mock/docker-compose'),
    })
    const workerCompose = fs.readFileSync(
      path.join(workerBundle.bundleDir, 'docker-compose.yml'),
      'utf8',
    )
    const composeLines = workerCompose.split(/\r?\n/).map(line => line.trim())
    const composeArgument = (flag: string): string => {
      const index = composeLines.indexOf(`- ${flag}`)
      expect(index, `${flag} must be present in generated worker compose`).to.be.greaterThan(-1)
      return composeLines[index + 1].replace(/^- /, '')
    }

    const rawCommit = composeArgument('--aggregation-app-commit-raw-hex')
    const workerVkHash = composeArgument('--aggregation-verification-key-hash')
    const derivedProgramHash = `0x${createHash('sha256')
      .update(Buffer.from(rawCommit.slice(2), 'hex'))
      .digest('hex')}`
    // This raw identity is pinned by dogeos-core's bridge circuit. Keeping a
    // literal assertion here prevents the generated topology from becoming
    // internally consistent but incompatible with bridge materialization.
    expect(rawCommit).to.equal(
      '0x005edcdbcd600e6c73c83d8a42e2b253072bef1da096c7affcfcb589a5afeca1'
      + '0050c7d02bc389a6d63e8d4ecb86f5e76094e6900b98a7a37b38818e1817f230',
    )
    expect(derivedProgramHash)
      .to.equal('0xb177ce1c76fc0b5d54ea570aa9912ac9d97bdff601f00e8e458a1ecae26e921c')
    const aggregationManifest = JSON.parse(fs.readFileSync(
      path.join(
        root,
        'proof-artifacts/mock-manifests/l2-range-aggregation-topology-program.json',
      ),
      'utf8',
    ))
    const wpAggregationIdentity = parsedWithdrawal.proof_control_plane_gate
      .l2_range_aggregation_verifier_identity
    const coordinatorAggregationIdentity = parsedCoordinator.verifier
      .l2_range_aggregation_verifier_identity
    expect(aggregationManifest.circuit_version).to.equal('1')
    expect(wpAggregationIdentity.expected_circuit_version).to.equal('1')
    expect(coordinatorAggregationIdentity.expected_circuit_version).to.equal('1')
    expect(derivedProgramHash).to.equal(aggregationManifest.program_commitment_hash)
    expect(derivedProgramHash).to.equal(
      wpAggregationIdentity.expected_program_commitment_hash_hex,
    )
    expect(derivedProgramHash).to.equal(
      coordinatorAggregationIdentity.expected_program_commitment_hash_hex,
    )
    expect(workerVkHash).to.equal(aggregationManifest.verification_key_hash)
    expect(workerVkHash).to.equal(
      wpAggregationIdentity.expected_verification_key_hash_hex,
    )
    expect(workerVkHash).to.equal(
      coordinatorAggregationIdentity.expected_verification_key_hash_hex,
    )
    expect(fs.readFileSync(path.join(workerBundle.bundleDir, '.env'), 'utf8'))
      .to.include('AGGREGATION_L2_CHAIN_ID=6281971')

    const coordinator = yaml.load(fs.readFileSync(result.files[0], 'utf8')) as any
    expect((coordinator.env || []).some((item: any) => String(item?.name || '').includes('CHUNK_PROGRAM_COMMITMENT_HEX'))).to.equal(false)
    expect(coordinator.configMaps['agg-verifying-key']).to.equal(undefined)
    expect(coordinator.initContainers['prepare-proof-data-directories'].args).to.deep.equal([
      "mkdir -p '/app/data/eth-da' '/app/data/eth-da/blobs' '/app/data/proof-materializer-staging' '/app/data/scroll-batch-materializer'",
    ])
    expect(coordinator.configMaps.manifests.data).to.deep.equal({ README: 'operator-owned entry\n' })
    const statementNamespace = JSON.parse(fs.readFileSync(result.statementNamespaceFile, 'utf8'))
    expect(statementNamespace.chunk.proof_mode).to.equal('Mock')
    expect(coordinator.ingress.main.enabled).to.equal(true)
    expect(coordinator.ingress.main.hosts[0].host).to.equal('proof-coordinator.bridge.example')
    expect(coordinator.ingress.main.annotations['cert-manager.io/cluster-issuer']).to.equal('letsencrypt-prod')
    expect(coordinator.ingress.main.tls[0].secretName).to.equal('proof-coordinator-tls')

    // Signer triples pair the mock bridge + batch identities — exactly what
    // export-signer-policy later derives from the staged coordinator TOML.
    const expectedTriples = [
      `openvm_state_transition:openvm-bridge-topology-verifier-v1:${'88'.repeat(32)}`,
      `scroll_batch:dogeos-prover-worker-dev-mock-batch-v1:${'55'.repeat(32)}`,
    ].join(',')
    expect(deriveAllowedProofTriples(result.configFile, [])?.value).to.equal(expectedTriples)
  })

  it('rejects a production materializer topology under mock proving', () => {
    // The beforeEach coordinator fixture carries the production subprocess
    // materializer shape.
    expect(() => configureProofValues({
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      provingMode: 'mock',
      signerProofArtifactBaseUrl: 'https://proofs.example.com',
      valuesDir: path.join(root, 'values'),
    })).to.throw('materializer.dev_sentinel_scroll_chunk')
  })

  it('rejects a mock dev-sentinel topology under production proving', () => {
    const coordinatorConfigPath = writeMockCoordinatorToml(root)
    const { artifactPath, manifests } = writeValidProofRelease(root)
    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath,
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com',
      valuesDir: path.join(root, 'values'),
    })).to.throw('materializer.scroll_chunk_segmentation')
  })

  it('scaffolds the dev-sentinel coordinator shape under mock proving and accepts it end to end', () => {
    const scaffoldPath = path.join(root, 'proof-coordinator/ProofCoordinator.scaffold-mock.toml')
    const withdrawalConfigPath = path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
    fs.mkdirSync(path.dirname(withdrawalConfigPath), { recursive: true })
    fs.writeFileSync(withdrawalConfigPath, `# BEGIN scrollsdk managed deployment configuration
network_str = "testnet"
dogecoin_rpc_url = "http://dogecoin:22555"

[dogeos_indexer]
rpc_url = "http://l2-rpc:8545"

[ethereum_da]
l1_rpc_url = "https://ethereum.example.com"

[ethereum_da.blob_source]
timeout_ms = 10000

[ethereum_da.blob_source.aws_s3]
url = "https://eth-da.example.com"
key_prefix = "batches"
# END scrollsdk managed deployment configuration
`)

    const scaffold = scaffoldProofCoordinatorConfig({
      coordinatorConfigPath: scaffoldPath,
      provingMode: 'mock',
      valuesDir: path.join(root, 'values'),
      withdrawalConfigPath,
    })
    expect(scaffold.created).to.equal(true)
    const parsed = toml.parse(fs.readFileSync(scaffoldPath, 'utf8')) as any
    expect(parsed.materializer.dev_sentinel_scroll_chunk.enabled).to.equal(true)
    expect(parsed.materializer.scroll_batch.dev_sentinel).to.equal(true)
    expect(parsed.materializer.scroll_batch.proof_mode).to.equal('Mock')
    expect(parsed.materializer.scroll_batch.subprocess).to.equal(undefined)
    expect(parsed.verifier.verifier_import_mode).to.equal('dev_dummy')

    // End to end: the mock scaffold passes the mock topology validation.
    const result = configureProofValues({
      coordinatorConfigPath: scaffoldPath,
      provingMode: 'mock',
      signerProofArtifactBaseUrl: 'https://proofs.example.com',
      valuesDir: path.join(root, 'values'),
    })
    expect(result.provingMode).to.equal('mock')
  })

  it('writes the prover-worker-mock bundle with the mock worker contract', () => {
    // A pre-existing world-readable placeholder must not keep its mode once
    // the file holds the real token (writeFileSync only applies mode on create).
    const bundleDir = path.join(root, 'prover-worker-mock/docker-compose')
    fs.mkdirSync(bundleDir, { recursive: true })
    fs.writeFileSync(path.join(bundleDir, 'prover-worker.env'), 'DOGEOS_PROVER_WORKER_TOKEN=PLACEHOLDER\n', { mode: 0o664 })

    const bundle = writeProverWorkerMockBundle({
      aggregationL2ChainId: 6_281_971,
      artifactReadBaseUrl: 'https://proofs.example.com',
      coordinatorUrl: 'https://proof-coordinator.bridge.example',
      dir: bundleDir,
      workerToken: 'a'.repeat(64),
    })
    expect(bundle.files).to.have.length(4)
    expect(bundle.bundleId).to.match(/^[\da-f]{64}$/)

    const compose = fs.readFileSync(path.join(bundle.bundleDir, 'docker-compose.yml'), 'utf8')
    for (const requiredArg of [
      '--mode',
      'mock',
      '--allow-dev-mock-prover',
      '--enable-prove-scroll-chunk',
      '--enable-prove-scroll-batch',
      '--enable-prove-advance-l2-aggregation',
      '--aggregation-app-commit-raw-hex',
      '--aggregation-verification-key-hash',
      '--aggregation-l2-chain-id',
      '--enable-prove-bridge-transition',
    ]) {
      expect(compose).to.include(requiredArg)
    }

    const env = fs.readFileSync(path.join(bundle.bundleDir, '.env'), 'utf8')
    expect(env).to.include('PROOF_COORDINATOR_URL=https://proof-coordinator.bridge.example')
    expect(env).to.include('ARTIFACT_READ_BASE_URL=https://proofs.example.com')
    expect(env).to.include('AGGREGATION_L2_CHAIN_ID=6281971')

    const tokenPath = path.join(bundle.bundleDir, 'prover-worker.env')
    expect(fs.readFileSync(tokenPath, 'utf8')).to.include(`DOGEOS_PROVER_WORKER_TOKEN=${'a'.repeat(64)}`)
    // POSIX permission bits are intentionally expressed in octal.
    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(tokenPath).mode & 0o777).to.equal(0o600)

    const manifest = JSON.parse(fs.readFileSync(path.join(bundle.bundleDir, 'bundle-manifest.json'), 'utf8'))
    expect(manifest.bundleId).to.equal(bundle.bundleId)
    expect(manifest.files['prover-worker.env']).to.deep.equal({ requiredMode: '0600', sensitive: true })
    expect(JSON.stringify(manifest)).not.to.include('a'.repeat(64))
    expect(verifyProverWorkerMockBundle({
      dir: bundle.bundleDir,
      expectedBundleId: bundle.bundleId,
    }).bundleId).to.equal(bundle.bundleId)

    fs.appendFileSync(path.join(bundle.bundleDir, '.env'), 'STALE_CONFIG=true\n')
    expect(() => verifyProverWorkerMockBundle({ dir: bundle.bundleDir }))
      .to.throw('SHA-256 does not match bundle-manifest.json')
  })

  it('renders a deterministic mock worker bundle without reading or retaining credentials', () => {
    const bundleDir = path.join(root, 'prover-worker-mock/docker-compose')
    fs.mkdirSync(bundleDir, { recursive: true })
    fs.writeFileSync(
      path.join(bundleDir, 'prover-worker.env'),
      'DOGEOS_PROVER_WORKER_TOKEN=stale-secret\n',
      { mode: 0o600 },
    )

    const bundle = writeProverWorkerMockBundle({
      aggregationL2ChainId: 6_281_971,
      artifactReadBaseUrl: 'https://proofs.example.com',
      coordinatorUrl: 'https://proof-coordinator.bridge.example',
      dir: bundleDir,
    })
    expect(bundle.files).to.have.length(3)
    expect(fs.existsSync(path.join(bundleDir, 'prover-worker.env'))).to.equal(false)

    const manifest = JSON.parse(fs.readFileSync(bundle.manifestFile, 'utf8'))
    expect(manifest.credentialState).to.equal('pending')
    expect(manifest).not.to.have.property('generatedAt')
    const firstManifest = fs.readFileSync(bundle.manifestFile, 'utf8')
    writeProverWorkerMockBundle({
      aggregationL2ChainId: 6_281_971,
      artifactReadBaseUrl: 'https://proofs.example.com',
      coordinatorUrl: 'https://proof-coordinator.bridge.example',
      dir: bundleDir,
    })
    expect(fs.readFileSync(bundle.manifestFile, 'utf8')).to.equal(firstManifest)
    expect(() => verifyProverWorkerMockBundle({
      dir: bundleDir,
      expectedBundleId: bundle.bundleId,
    })).to.throw('worker credential is pending')

    const hydrated = hydrateProverWorkerMockBundle({
      dir: bundleDir,
      workerToken: 'b'.repeat(64),
    })
    expect(hydrated.bundleId).to.equal(bundle.bundleId)
    expect(verifyProverWorkerMockBundle({
      dir: bundleDir,
      expectedBundleId: bundle.bundleId,
    }).bundleId).to.equal(bundle.bundleId)
    const readyManifest = JSON.parse(fs.readFileSync(hydrated.manifestFile, 'utf8'))
    expect(readyManifest.credentialState).to.equal('ready')
  })
})
