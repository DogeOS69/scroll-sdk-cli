import * as toml from '@iarna/toml'
import { expect } from 'chai'
import * as yaml from 'js-yaml'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { configureProofValues } from '../../src/utils/proof-configurator.js'
import { scaffoldProofCoordinatorConfig } from '../../src/utils/proof-coordinator-scaffold.js'

function writeValidProofRelease(root: string): {
  aggVk: Buffer
  artifactPath: string
  families: readonly ['scroll_chunk', 'scroll_batch', 'bridge_transition']
  manifests: string[]
  raw: Record<string, string>
} {
  const families = ['scroll_chunk', 'scroll_batch', 'bridge_transition'] as const
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
      artifacts: [],
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
eth_chain_id = 11155111
l2_chain_id = 12345
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
eth_chain_id = 11155111
l2_chain_id = 12345
artifact_store_root = "/app/data/eth-da/blobs"
artifact_metadata_sqlite_path = "/app/data/eth-da/meta.sqlite"

[materializer.bridge.ethereum_da.blob_source]
timeout_ms = 10000

[materializer.bridge.ethereum_da.blob_source.aws_s3]
url = "https://eth-da.example.com"
key_prefix = "batches"
`)
    fs.writeFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), yaml.dump({
      configMaps: {
        config: {
          data: {
            'WithdrawalProcessor.toml': `# withdrawal user comment must survive
[proof_system]
mode = "disabled"
require_scroll_execution = false
require_bridge_state = false

[operator_tuning]
max_items = 42
`,
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
    fs.writeFileSync(path.join(root, 'values/attestation-signer-production.yaml'), yaml.dump({
      attestationSigner: {
        envelopePolicy: { allowedProofTriples: '', maxProofArtifacts: 0 },
        network: 'testnet',
        profile: 'staging-local',
        proofArtifact: { fetchMode: 'disabled' },
      },
    }))
    fs.writeFileSync(path.join(root, 'values/attestation-signer-production-0.yaml'), yaml.dump({
      attestationSigner: {
        envelopePolicy: { allowedProofTriples: '', maxProofArtifacts: 0 },
        network: 'testnet',
        profile: 'staging-local',
        proofArtifact: { fetchMode: 'disabled' },
      },
    }))
  })

  afterEach(() => fs.rmSync(root, { force: true, recursive: true }))

  it('validates release identities and updates coordinator and WP values consistently', () => {
    const { aggVk, artifactPath, families, manifests, raw } = writeValidProofRelease(root)

    const result = configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://signer-proofs.example.com/public/proof-topology/',
      valuesDir: path.join(root, 'values'),
    })
    expect(result.families).to.deep.equal(['bridge_transition', 'scroll_batch', 'scroll_chunk'])

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
    expect(coordinatorToml).to.include('# user comment must survive')
    expect(parsedCoordinator.poll_interval_ms).to.equal(2345)
    expect(parsedCoordinator.artifact_write.max_proof_bytes).to.equal(42)
    expect(coordinator.configMaps.manifests.data).to.have.all.keys([
      ...families.map(family => `${family}.json`),
      'statement-namespace.json',
    ])
    const statementNamespace = JSON.parse(coordinator.configMaps.manifests.data['statement-namespace.json'])
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
    const coordinatorEnv = Object.fromEntries(coordinator.env.map((item: any) => [item.name, item.value]))
    expect(coordinatorEnv.DOGEOS_PROOF_COORDINATOR_MATERIALIZER__SCROLL_BATCH__SUBPROCESS__CHUNK_PROGRAM_COMMITMENT_HEX)
      .to.equal(raw.scroll_chunk)
    expect(coordinator.persistence.manifests.mountPath).to.equal('/app/data/manifests')
    expect(coordinator.persistence.manifests.name).to.equal('{{ include "scroll.common.lib.chart.names.fullname" . }}-manifests')
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
      DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE: '{{ ternary "production" "disabled" .Values.withdrawalProof.enabled }}',
      DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_BRIDGE_STATE: '{{ ternary "true" "false" .Values.withdrawalProof.enabled }}',
      DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_SCROLL_EXECUTION: '{{ ternary "true" "false" .Values.withdrawalProof.enabled }}',
      DOGEOS_WITHDRAWAL_PROOF_WORK_API__ENABLED: '{{ ternary "true" "false" .Values.withdrawalProof.enabled }}',
    })
    expect(withdrawal.withdrawalProof.enabled).to.equal(false)

    const withdrawalToml = withdrawal.configMaps.config.data['WithdrawalProcessor.toml'] as string
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
    expect(parsedWithdrawal.proof_artifact_transport.force_path_style).to.equal(false)
    expect(parsedWithdrawal.proof_artifact_transport.endpoint_url).to.equal('https://s3.example.com')
    expect(parsedWithdrawal.proof_artifact_transport.signed_url_ttl_ms).to.equal(3_600_000)
    expect(parsedWithdrawal.proof_artifact_transport.max_read_body_bytes).to.equal(512 * 1024 * 1024)
    expect(withdrawal.args).to.deep.equal(['--config', '/app/config/WithdrawalProcessor.toml'])
    expect(withdrawal.persistence['withdrawal-processor-config'].subPath).to.equal('WithdrawalProcessor.toml')
    expect(withdrawal.persistence['proof-manifests'].name).to.equal('{{ include "withdrawal-processor.fullname" . }}-proof-manifests')
    expect(withdrawal.persistence['proof-secrets'].name).to.equal('proof-secrets')
    expect(withdrawal.service.main.ports['proof-work'].port).to.equal(9300)
    expect(withdrawal.configMaps['agg-verifying-key'].data['agg-vk.bin.b64']).to.equal(aggVk.toString('base64'))
    expect(withdrawal.initContainers['install-agg-verifying-key'].args[0]).to.include('/app/data/verifier/agg-vk.bin')
    expect(withdrawal.externalSecrets['proof-secrets'].data).to.have.length(1)

    const signerTemplatePath = path.join(root, 'values/attestation-signer-production.yaml')
    const signerInstancePath = path.join(root, 'values/attestation-signer-production-0.yaml')
    expect(result.files).to.include.members([signerTemplatePath, signerInstancePath])
    const expectedTriples = [
      `openvm_state_transition:scroll-zkvm-v1-bridge_transition-v1-1.0.0:${Buffer.alloc(32, 6).toString('hex')}`,
      `scroll_batch:scroll-zkvm-v1-scroll_batch-v1-1.0.0:${Buffer.alloc(32, 5).toString('hex')}`,
    ].join(',')
    for (const signerPath of [signerTemplatePath, signerInstancePath]) {
      const signer = (yaml.load(fs.readFileSync(signerPath, 'utf8')) as any).attestationSigner
      expect(signer.envelopePolicy.allowedProofTriples).to.equal(expectedTriples)
      expect(signer.envelopePolicy.maxProofArtifacts).to.equal(4)
      expect(signer.proofArtifact.fetchMode).to.equal('http')
      expect(signer.profile).to.equal('staging-local')
    }
  })

  it('skips attestation-signer values when explicitly requested', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const signerTemplatePath = path.join(root, 'values/attestation-signer-production.yaml')
    const before = fs.readFileSync(signerTemplatePath, 'utf8')

    const result = configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      skipAttestationSigners: true,
      valuesDir: path.join(root, 'values'),
    })
    expect(result.files).not.to.include(signerTemplatePath)
    expect(fs.readFileSync(signerTemplatePath, 'utf8')).to.equal(before)
  })

  it('fails before writing when no attestation-signer values exist', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    fs.rmSync(path.join(root, 'values/attestation-signer-production.yaml'))
    fs.rmSync(path.join(root, 'values/attestation-signer-production-0.yaml'))
    const coordinatorConfigPath = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    const coordinatorBefore = fs.readFileSync(coordinatorConfigPath, 'utf8')

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath,
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })).to.throw('No attestation-signer values found')
    expect(fs.readFileSync(coordinatorConfigPath, 'utf8')).to.equal(coordinatorBefore)
  })

  it('preserves an operator-raised proof artifact cap', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const signerTemplatePath = path.join(root, 'values/attestation-signer-production.yaml')
    const signer = yaml.load(fs.readFileSync(signerTemplatePath, 'utf8')) as any
    signer.attestationSigner.envelopePolicy.maxProofArtifacts = 8
    fs.writeFileSync(signerTemplatePath, yaml.dump(signer))

    configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })
    const updated = yaml.load(fs.readFileSync(signerTemplatePath, 'utf8')) as any
    expect(updated.attestationSigner.envelopePolicy.maxProofArtifacts).to.equal(8)
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

  it('accepts a scaffolded coordinator config end to end', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const withdrawalValuesPath = path.join(root, 'values/withdrawal-processor-production.yaml')
    const withdrawal = yaml.load(fs.readFileSync(withdrawalValuesPath, 'utf8')) as any
    withdrawal.env.push(
      { name: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_URL', value: 'http://dogecoin:22555' },
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__RPC_URL', value: 'http://l2-rpc:8545' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL', value: 'https://blob-archive.example.com' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__ETH_CHAIN_ID', value: '11155111' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__L1_RPC_URL', value: 'https://ethereum.example.com' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__L2_CHAIN_ID', value: '12345' },
      { name: 'DOGEOS_WITHDRAWAL_NETWORK_STR', value: 'testnet' },
    )
    fs.writeFileSync(withdrawalValuesPath, yaml.dump(withdrawal))
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
    expect(result.families).to.deep.equal(['bridge_transition', 'scroll_batch', 'scroll_chunk'])
    const coordinatorToml = toml.parse(fs.readFileSync(coordinatorConfigPath, 'utf8')) as any
    expect(coordinatorToml.verifier.scroll_batch_verifier_identity.expected_circuit_id).to.equal('scroll_batch-v1')
    expect(coordinatorToml.verifier.scroll_real_verifier.agg_verifying_key_path).to.equal('/app/data/verifier/agg-vk.bin')
  })

  it('enables the activation switch only with the explicit option', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const withdrawalValuesPath = path.join(root, 'values/withdrawal-processor-production.yaml')

    configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      enableWithdrawalProof: true,
      manifestPaths: manifests,
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })
    const withdrawal = yaml.load(fs.readFileSync(withdrawalValuesPath, 'utf8')) as any
    expect(withdrawal.withdrawalProof.enabled).to.equal(true)
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
    })).to.throw('--signer-proof-artifact-base-url is required')
    expect(fs.readFileSync(coordinatorConfigPath, 'utf8')).to.equal(coordinatorBefore)
    expect(fs.readFileSync(coordinatorValuesPath, 'utf8')).to.equal(coordinatorValuesBefore)
  })

  it('preserves an explicitly enabled activation switch while staging topology', () => {
    const { artifactPath, manifests } = writeValidProofRelease(root)
    const withdrawalValuesPath = path.join(root, 'values/withdrawal-processor-production.yaml')
    const withdrawal = yaml.load(fs.readFileSync(withdrawalValuesPath, 'utf8')) as any
    withdrawal.withdrawalProof.enabled = true
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
    const withdrawalValuesPath = path.join(root, 'values/withdrawal-processor-production.yaml')
    const withdrawal = yaml.load(fs.readFileSync(withdrawalValuesPath, 'utf8')) as any
    withdrawal.configMaps.config.data['WithdrawalProcessor.toml'] = `# BEGIN scrollsdk managed proof configuration
[proof_system]
mode = "disabled"
`
    fs.writeFileSync(withdrawalValuesPath, yaml.dump(withdrawal))
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
    const result = configureProofValues({
      artifactManifestPath: artifactPath,
      bridgeBackendProfile: 'bridge-prod-hsm-v2',
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      scrollBatchBackendProfile: 'scroll-prod-gpu-v2',
      signerProofArtifactBaseUrl: 'https://proofs.example.com/public',
      valuesDir: path.join(root, 'values'),
    })
    const withdrawal = yaml.load(fs.readFileSync(result.files[1], 'utf8')) as any
    const config = toml.parse(withdrawal.configMaps.config.data['WithdrawalProcessor.toml']) as any
    expect(config.proof_work_api.materialize.bridge.remote_prove_options.backend_profile).to.equal('bridge-prod-hsm-v2')
    expect(config.proof_work_api.materialize.scroll_batch.remote_prove_options.backend_profile).to.equal('scroll-prod-gpu-v2')
  })

  it('rejects a raw commitment that does not match its program manifest', () => {
    const families = ['scroll_chunk', 'scroll_batch', 'bridge_transition'] as const
    const manifests = families.map((family, index) => {
      const manifestPath = path.join(root, `${family}.json`)
      fs.writeFileSync(manifestPath, JSON.stringify({
        circuit_id: family,
        circuit_version: '1',
        program_commitment_hash: `0x${Buffer.alloc(32, index + 1).toString('hex')}`,
        proof_family: family,
        proof_system_id: 'openvm',
        schema_version: 1,
        verification_key_hash: `0x${Buffer.alloc(32, 9).toString('hex')}`,
      }))
      return manifestPath
    })
    const artifactPath = path.join(root, 'release.json')
    fs.writeFileSync(artifactPath, JSON.stringify({ expected_identity: {
      batch_program_commitment_raw: `0x${Buffer.alloc(64, 2).toString('hex')}`,
      bridge_app_commit_raw: `0x${Buffer.alloc(64, 3).toString('hex')}`,
      chunk_program_commitment_raw: `0x${Buffer.alloc(64, 1).toString('hex')}`,
    } }))

    expect(() => configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
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
})
