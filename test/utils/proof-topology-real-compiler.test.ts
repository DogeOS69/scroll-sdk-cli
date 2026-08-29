import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {ProofTopologySpec} from '../../src/types/proof-topology.js'

import {compileProofTopology} from '../../src/utils/proof-topology-compiler.js'

const compilerBinary = process.env.DOGEOS_PROOF_TOPOLOGY_COMPILER
const integrationDescribe = compilerBinary ? describe : describe.skip
const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`

integrationDescribe('proof topology adapter against dogeos-core compiler', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollsdk-real-proof-compiler-'))
    fs.mkdirSync(path.join(root, 'withdrawal-processor'), {recursive: true})
    fs.mkdirSync(path.join(root, 'proof-coordinator'), {recursive: true})
    fs.writeFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), '')
    fs.writeFileSync(
      path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      'proof_work_base_url = "http://127.0.0.1:9300"\n'
      + 'protocol_context_json = "/app/protocol_context.json"\n'
      + 'coordinator_id = "proof-coordinator"\n'
      + 'poll_interval_ms = 500\n'
      + 'lease_ttl_ms = 60000\n'
      + 'allow_insecure_http = true\n',
    )
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  function topology(mode: 'disabled' | 'mock'): ProofTopologySpec {
    return {
      compiler: {
        image: {digest: IMAGE_DIGEST, repository: 'dogeos69/dogeos-proof-topology'},
      },
      deployment: {proverPublicUrl: 'https://proof.example.test'},
      mock: {
        artifactStore: {kind: 'local_fs'},
        profile: 'withdrawal_mock_prover',
        workerImage: {digest: IMAGE_DIGEST, repository: 'dogeos69/prover-worker-mock'},
      },
      mode,
    }
  }

  function compile(proofTopology: ProofTopologySpec, outputDir?: string) {
    return compileProofTopology({
      bridge: {
        dogecoinNetwork: 'regtest',
        dogecoinRpcPassword: 'integration-secret',
        dogecoinRpcUrl: 'http://dogecoin:22555',
        dogecoinRpcUser: 'doge',
      },
      compilerBinary: compilerBinary!,
      deploymentDir: root,
      deploymentName: 'integration-test',
      durableProofRows: 'no',
      ethereumL1RpcUrl: 'http://ethereum:8545',
      network: 'regtest',
      ...(outputDir ? {outputDir} : {}),
      proofTopology,
    })
  }

  it('compiles v2 evidence, carries paired prior revisions, and accepts non-installable preflight', () => {
    const legacyBundle = path.join(root, '.data/generated/proof-topology')
    fs.mkdirSync(legacyBundle, {recursive: true})
    fs.writeFileSync(path.join(legacyBundle, 'resolved-v1.json'), '{}\n')
    fs.writeFileSync(path.join(legacyBundle, 'bundle-manifest-v1.json'), `${JSON.stringify({
      resolved_sidecar: 'resolved-v1.json',
    })}\n`)
    const disabled = compile(topology('disabled'))
    expect(disabled.manifest.resolved_sidecar).to.equal('resolved-v2.json')
    expect(disabled.manifest.installable_service_configs).to.equal(true)

    const mock = compile(topology('mock'))
    expect(mock.plan.from_mode).to.equal('disabled')
    expect(mock.plan.from_bundle_revision).to.equal(disabled.manifest.bundle_revision)
    expect(mock.plan.to_bundle_revision).to.equal(mock.manifest.bundle_revision)
    expect(mock.worker?.placement).to.equal('local_cpu')
    expect(mock.worker?.environment).to.deep.include({
      name: 'DOGEOS_PROVER_WORKER_READY_FILE',
      value: '/run/dogeos/prover-worker-ready-v1.json',
    })

    fs.appendFileSync(
      path.join(mock.bundleDir, mock.manifest.withdrawal_processor),
      'tampered = true\n',
    )
    expect(() => compile(topology('mock')))
      .to.throw('bundle_revision does not match the rendered bundle payload')

    const preflight = compileProofTopology({
      bridge: {
        dogecoinNetwork: 'regtest',
        dogecoinRpcPassword: 'integration-secret',
        dogecoinRpcUrl: 'http://dogecoin:22555',
        dogecoinRpcUser: 'doge',
      },
      compilerBinary: compilerBinary!,
      deploymentDir: root,
      deploymentName: 'integration-test',
      ethereumL1RpcUrl: 'http://ethereum:8545',
      network: 'regtest',
      outputDir: '.data/generated/proof-topology-preflight-mock',
      preflightMode: 'mock',
      proofTopology: topology('disabled'),
    })
    expect(preflight.manifest.preflight_only).to.equal(true)
    expect(preflight.manifest.installable_service_configs).to.equal(false)
  })
})
