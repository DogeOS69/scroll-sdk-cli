import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {DeploymentSpec, ProofTopologySpec} from '../../src/types/deployment-spec.js'

import {
  renderProofTopologySource,
  validateProofTopologyBundle,
} from '../../src/utils/proof-topology-compiler.js'

const DIGEST = 'a'.repeat(64)
const IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`

function topology(mode: 'disabled' | 'mock' | 'production' = 'disabled'): ProofTopologySpec {
  return {
    compiler: {
      image: {digest: IMAGE_DIGEST, repository: 'dogeos69/dogeos-proof-topology'},
    },
    mock: {
      artifactStore: {kind: 'local_fs'},
      profile: 'cheap_scroll_chunk',
      workerImage: {digest: IMAGE_DIGEST, repository: 'dogeos69/prover-worker-mock'},
    },
    mode,
    production: {
      artifactStore: {
        bucket: 'proofs',
        endpointUrl: 'https://s3.example.com',
        keyPrefix: 'testnet/proofs',
        kind: 's3_compatible',
        region: 'us-west-2',
      },
      profile: 'real_scroll_withdrawal_full_topology',
      realScroll: {
        aggVerifyingKeyPath: 'keys/agg-vk.bin',
        batchAppConfig: 'batch/openvm.toml',
        batchAppExe: 'batch/app.vmexe',
        batchMaterializerBinaryPath: 'bin/scroll-runtime-materializer',
        batchProgramCommitmentHashHex: `0x${'1'.repeat(64)}`,
        batchProgramCommitmentHex: `0x${'2'.repeat(128)}`,
        batchVerificationKeyHashHex: `0x${'3'.repeat(64)}`,
        bridgeAppCommitRawHex: `0x${'4'.repeat(128)}`,
        bridgeProgramCommitmentHashHex: `0x${'5'.repeat(64)}`,
        bridgeVerificationKeyHashHex: `0x${'6'.repeat(64)}`,
        chunkAppConfig: 'chunk/openvm.toml',
        chunkAppExe: 'chunk/app.vmexe',
        chunkMaterializerBinaryPath: 'bin/scroll-runtime-materializer',
        chunkProgramCommitmentHashHex: `0x${'7'.repeat(64)}`,
        chunkProgramCommitmentHex: `0x${'8'.repeat(128)}`,
        chunkVerificationKeyHashHex: `0x${'9'.repeat(64)}`,
        l2RangeAggregationAppCommitRawHex: `0x${'a'.repeat(128)}`,
        l2RangeAggregationProgramCommitmentHashHex: `0x${'b'.repeat(64)}`,
        l2RangeAggregationVerificationKeyHashHex: `0x${'6'.repeat(64)}`,
        resourcesRoot: 'proof-artifacts',
      },
      workerImage: {digest: IMAGE_DIGEST, repository: 'dogeos69/prover-worker'},
      workerLaunch: 'external',
    },
  }
}

function writeBundle(
  root: string,
  mode: 'disabled' | 'mock' | 'production',
  preflightOnly = false,
): void {
  const active = mode !== 'disabled'
  fs.mkdirSync(root, {recursive: true})
  fs.writeFileSync(path.join(root, 'withdrawal-processor.toml'), '')
  fs.writeFileSync(path.join(root, 'resolved-v1.json'), `${JSON.stringify({
    deployment_revision: 'c'.repeat(64),
    digest: DIGEST,
    schema_version: 1,
    selected: {schema_version: 1, selected_mode: mode},
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(root, 'eth-da-submitter.patch.toml'), '')
  if (active) {
    fs.writeFileSync(path.join(root, 'proof-coordinator.toml'), '')
    fs.writeFileSync(path.join(root, 'prover-worker-v1.json'), `${JSON.stringify({
      argv: ['--mode', mode === 'mock' ? 'mock' : 'real'],
      capabilities: ['scroll_chunk'],
      desired_state: mode === 'production' ? 'external' : 'local_deployment',
      environment: [{name: 'DOGEOS_PROOF_TOPOLOGY_DIGEST', value: DIGEST}],
      expected_topology_digest: DIGEST,
      image: {digest: IMAGE_DIGEST, repository: 'dogeos69/prover-worker'},
      readiness_evidence_path: '/run/dogeos/prover-worker-ready-v1.json',
      required_build_class: mode === 'mock' ? 'mock_capable' : 'production',
      schema_version: 1,
    }, null, 2)}\n`)
  }

  fs.writeFileSync(path.join(root, 'rollout-plan-v1.json'), `${JSON.stringify({
    deployment_changed: false,
    desired_services: {
      proof_coordinator: active ? 'running' : 'absent',
      prover_worker: active ? mode === 'production' ? 'external' : 'running' : 'absent',
      withdrawal_processor: 'running',
    },
    from_deployment_revision: null,
    from_digest: null,
    from_mode: null,
    regeneration: null,
    requires_proof_regeneration: false,
    schema_version: 1,
    submitter_config_changed: false,
    to_deployment_revision: 'c'.repeat(64),
    to_digest: DIGEST,
    to_mode: mode,
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(root, 'bundle-manifest-v1.json'), `${JSON.stringify({
    compiler_package_version: '0.1.0',
    deployment_context_schema_version: 1,
    eth_da_submitter: 'eth-da-submitter.patch.toml',
    generated_materials: null,
    installable_service_configs: true,
    preflight_only: preflightOnly,
    proof_coordinator: active ? 'proof-coordinator.toml' : null,
    prover_worker: active ? 'prover-worker-v1.json' : null,
    resolved_sidecar: 'resolved-v1.json',
    rollout_plan: 'rollout-plan-v1.json',
    schema_version: 1,
    source_schema_version: 1,
    withdrawal_processor: 'withdrawal-processor.toml',
  }, null, 2)}\n`)
}

describe('proof topology compiler adapter', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-topology-compiler-'))
  })

  afterEach(() => {
    fs.rmSync(root, {force: true, recursive: true})
  })

  it('renders both dormant profiles while mode remains the only selection field', () => {
    const disabled = toml.parse(renderProofTopologySource(topology('disabled'))) as any
    const mock = toml.parse(renderProofTopologySource(topology('mock'))) as any
    const production = toml.parse(renderProofTopologySource(topology('production'))) as any

    expect(disabled.proof_topology.mock).to.deep.equal(mock.proof_topology.mock)
    expect(disabled.proof_topology.production).to.deep.equal(production.proof_topology.production)
    mock.proof_topology.mode = '<mode>'
    production.proof_topology.mode = '<mode>'
    disabled.proof_topology.mode = '<mode>'
    expect(mock).to.deep.equal(disabled)
    expect(production).to.deep.equal(disabled)
    expect(disabled.proof_topology.production.real_scroll.chunk_app_exe)
      .to.equal('/app/data/proof-release/chunk/app.vmexe')
    expect(disabled.proof_topology.production).not.to.have.property('worker_image')
  })

  it('keeps an incomplete dormant profile unopened until preflight selects it', () => {
    const source = topology('disabled')
    source.production = {} as ProofTopologySpec['production']
    const rendered = toml.parse(renderProofTopologySource(source)) as any
    expect(rendered.proof_topology.mode).to.equal('disabled')
    expect(rendered.proof_topology.production).to.deep.equal({})
  })

  it('rejects non-portable release paths before invoking the compiler', () => {
    const source = topology()
    source.production!.realScroll.chunkAppExe = '/tmp/chunk.vmexe'
    expect(() => renderProofTopologySource(source))
      .to.throw('chunkAppExe must be relative to resourcesRoot')
  })

  for (const mode of ['disabled', 'mock', 'production'] as const) {
    it(`validates a complete ${mode} compiler bundle`, () => {
      writeBundle(root, mode)
      const result = validateProofTopologyBundle(root, {mode, preflightOnly: false})
      expect(result.mode).to.equal(mode)
      expect(Boolean(result.worker)).to.equal(mode !== 'disabled')
    })
  }

  it('keeps a preflight bundle explicitly non-applyable', () => {
    writeBundle(root, 'production', true)
    expect(validateProofTopologyBundle(root, {mode: 'production', preflightOnly: true}).manifest.preflight_only)
      .to.equal(true)
    expect(() => validateProofTopologyBundle(root, {mode: 'production', preflightOnly: false}))
      .to.throw('preflight_only=true does not match invocation')
  })

  it('rejects manifest paths that escape the compiler bundle', () => {
    writeBundle(root, 'disabled')
    const manifestFile = path.join(root, 'bundle-manifest-v1.json')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    manifest.withdrawal_processor = '../outside.toml'
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest)}\n`)
    expect(() => validateProofTopologyBundle(root, {mode: 'disabled', preflightOnly: false}))
      .to.throw('withdrawal_processor escapes compiler bundle')
  })

  it('is structurally compatible with DeploymentSpec typing', () => {
    const spec = {proofTopology: topology()} as DeploymentSpec
    expect(spec.proofTopology?.mode).to.equal('disabled')
  })
})
