import * as toml from '@iarna/toml'
import { expect } from 'chai'
import * as yaml from 'js-yaml'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { configureProofValues } from '../../src/utils/proof-configurator.js'

describe('proof-configurator', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-configurator-'))
    fs.mkdirSync(path.join(root, 'values'))
    fs.writeFileSync(path.join(root, 'values/proof-coordinator-production.yaml'), yaml.dump({
      proofCoordinator: { config: { required: true } },
    }))
    fs.mkdirSync(path.join(root, 'config/proof-coordinator'), { recursive: true })
    fs.writeFileSync(path.join(root, 'config/proof-coordinator/ProofCoordinator.toml'), `# user comment must survive
poll_interval_ms = 2345

# BEGIN scrollsdk managed verifier configuration
[verifier]
verifier_import_mode = "dev_dummy"
# END scrollsdk managed verifier configuration

[artifact_write]
max_proof_bytes = 42
`)
    fs.writeFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), yaml.dump({
      env: [{ name: 'DOGEOS_WITHDRAWAL_PROOF_TASK_POLICY__SKIP_SCROLL_EXECUTION_PROOFS', value: 'true' }],
    }))
  })

  afterEach(() => fs.rmSync(root, { force: true, recursive: true }))

  it('validates release identities and updates coordinator and WP values consistently', () => {
    const families = ['scroll_chunk', 'scroll_batch', 'bridge_transition'] as const
    const raw: Record<string, string> = {}
    const manifests: string[] = []
    for (const [index, family] of families.entries()) {
      const commitment = Buffer.alloc(64, index + 1)
      raw[family] = `0x${commitment.toString('hex')}`
      const manifestPath = path.join(root, `${family}.json`)
      fs.writeFileSync(manifestPath, JSON.stringify({
        artifacts: [],
        circuit_id: `${family}-v1`,
        circuit_version: '1.0.0',
        hard_fork_name: 'galileo_v2',
        program_commitment_hash: `0x${createHash('sha256').update(commitment).digest('hex')}`,
        proof_family: family,
        proof_system_id: 'scroll-zkvm-v1',
        schema_version: 1,
        toolchain: { openvm_version: 'v1', rust_toolchain: 'nightly' },
        verification_key_hash: `0x${Buffer.alloc(32, index + 4).toString('hex')}`,
      }))
      manifests.push(manifestPath)
    }

    const artifactPath = path.join(root, 'release.json')
    fs.writeFileSync(artifactPath, JSON.stringify({ expected_identity: {
      batch_program_commitment_raw: raw.scroll_batch,
      bridge_app_commit_raw: raw.bridge_transition,
      chunk_program_commitment_raw: raw.scroll_chunk,
    } }))

    const result = configureProofValues({
      artifactManifestPath: artifactPath,
      coordinatorConfigPath: path.join(root, 'config/proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      valuesDir: path.join(root, 'values'),
    })
    expect(result.families).to.deep.equal(['bridge_transition', 'scroll_batch', 'scroll_chunk'])

    const coordinator = yaml.load(fs.readFileSync(result.files[0], 'utf8')) as any
    const coordinatorToml = fs.readFileSync(result.configFile, 'utf8')
    const parsedCoordinator = toml.parse(coordinatorToml) as any
    expect(parsedCoordinator.verifier.scroll_chunk_verifier_identity.expected_circuit_id).to.equal('scroll_chunk-v1')
    expect(coordinatorToml).to.include('# user comment must survive')
    expect(parsedCoordinator.poll_interval_ms).to.equal(2345)
    expect(parsedCoordinator.artifact_write.max_proof_bytes).to.equal(42)
    expect(coordinator.configMaps.manifests.data).to.have.all.keys(families.map(family => `${family}.json`))
    expect(coordinator.persistence.manifests.mountPath).to.equal('/app/data/manifests')

    const withdrawal = yaml.load(fs.readFileSync(result.files[1], 'utf8')) as any
    const env = Object.fromEntries(withdrawal.env.map((item: any) => [item.name, item.value]))
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_PROOF_TASK_POLICY__SKIP_SCROLL_EXECUTION_PROOFS')
    expect(env.DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE).to.equal('production')
    expect(env.DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__SCROLL_CHUNK_VERIFIER_IDENTITY__EXPECTED_CIRCUIT_ID).to.equal('scroll_chunk-v1')
    expect(env.DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__SCROLL_REAL_VERIFIER__BATCH_PROGRAM_COMMITMENT_HEX).to.equal(raw.scroll_batch)
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
      coordinatorConfigPath: path.join(root, 'config/proof-coordinator/ProofCoordinator.toml'),
      manifestPaths: manifests,
      valuesDir: path.join(root, 'values'),
    }))
      .to.throw('does not match program manifest')
  })
})
