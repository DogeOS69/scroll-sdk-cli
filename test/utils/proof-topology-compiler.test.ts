/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic TOML projection assertions. */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  computeProofTopologyBundleRevision,
  projectMockGenerationVerifierSelection,
  projectProofCoordinatorEthereumDa,
  proofTopologyEthereumDaBlobSource,
} from '../../src/utils/proof-topology-compiler.js'

describe('proof topology compiler deployment projection', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-topology-compiler-test-'))
    fs.writeFileSync(path.join(root, 'proof-coordinator.toml'), `
[materializer.bridge.ethereum_da.blob_source]
timeout_ms = 10000

[materializer.bridge.ethereum_da.blob_source.anvil]

[materializer.scroll_batch.subprocess.ethereum_da.blob_source]
timeout_ms = 10000

[materializer.scroll_batch.subprocess.ethereum_da.blob_source.anvil]
`)
    fs.writeFileSync(path.join(root, 'resolved-v2.json'), JSON.stringify({
      bundle_revision: '0'.repeat(64),
      resolved: {enforcement: 'observe', generation: 'mock', mode: 'mock'},
      schema_version: 2,
    }))
    fs.writeFileSync(path.join(root, 'bundle-manifest-v1.json'), JSON.stringify({
      bundle_revision: '0'.repeat(64),
      compiler_package_version: '0.3.0',
      deployment_context_schema_version: 1,
      installable_service_configs: true,
      preflight_only: false,
      proof_coordinator: 'proof-coordinator.toml',
      resolved_sidecar: 'resolved-v2.json',
      schema_version: 1,
      source_schema_version: 1,
      withdrawal_processor: 'withdrawal-processor.toml',
    }))
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('replaces compiler-generated Anvil providers with deployment Beacon and S3 providers', () => {
    projectProofCoordinatorEthereumDa(root, {
      awsS3: {
        keyPrefix: 'rehearsal/batches',
        url: 'https://archive.example.com',
      },
      beaconNodeUrl: 'https://beacon.example.com',
    })

    const rendered = fs.readFileSync(path.join(root, 'proof-coordinator.toml'), 'utf8')
    const parsed = toml.parse(rendered) as Record<string, any>
    for (const source of [
      parsed.materializer.bridge.ethereum_da.blob_source,
      parsed.materializer.scroll_batch.subprocess.ethereum_da.blob_source,
    ]) {
      expect(source).not.to.have.property('anvil')
      expect(source.beacon_node.url).to.equal('https://beacon.example.com')
      expect(source.aws_s3).to.deep.equal({
        key_prefix: 'rehearsal/batches',
        url: 'https://archive.example.com',
      })
    }

    const expectedRevision = computeProofTopologyBundleRevision(root)
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'bundle-manifest-v1.json'), 'utf8'))
    const sidecar = JSON.parse(fs.readFileSync(path.join(root, 'resolved-v2.json'), 'utf8'))
    expect(manifest.bundle_revision).to.equal(expectedRevision)
    expect(sidecar.bundle_revision).to.equal(expectedRevision)
  })

  it('derives the provider projection from doge-config deployment facts', () => {
    expect(proofTopologyEthereumDaBlobSource({
      beaconRpcUrl: 'https://beacon.example.com',
      blobArchive: {s3: {
        bucket: 'dogeos-da',
        enabled: true,
        keyPrefix: 'network/batches',
        region: 'us-east-1',
      }},
    })).to.deep.equal({
      awsS3: {
        keyPrefix: 'network/batches',
        url: 'https://dogeos-da.s3.us-east-1.amazonaws.com',
      },
      beaconNodeUrl: 'https://beacon.example.com',
    })
  })

  it('removes executable real verifier material from mock compiler output', () => {
    fs.writeFileSync(path.join(root, 'proof-coordinator.toml'), `
generation = "mock"
[verifier]
enforcement = "observe"
[verifier.scroll_chunk_verifier_identity]
verifier_id = "openvm-scroll-chunk-real-topology-verifier-v1"
[verifier.scroll_real_verifier]
agg_verifying_key_path = "/app/data/proof-materials/verifier/root_verifier_vk"
`)
    fs.writeFileSync(path.join(root, 'withdrawal-processor.toml'), `
[proof_control_plane_gate.scroll_real_verifier]
agg_verifying_key_path = "/app/data/proof-materials/verifier/root_verifier_vk"
[proof_work_api.materialize.scroll_chunk_segmentation]
enabled = true
`)

    projectMockGenerationVerifierSelection(root, 'mock')

    const coordinator = toml.parse(fs.readFileSync(path.join(root, 'proof-coordinator.toml'), 'utf8')) as any
    const withdrawal = toml.parse(fs.readFileSync(path.join(root, 'withdrawal-processor.toml'), 'utf8')) as any
    expect(coordinator.verifier).not.to.have.property('scroll_real_verifier')
    expect(coordinator.verifier.scroll_chunk_verifier_identity.verifier_id)
      .to.equal('openvm-scroll-chunk-real-topology-verifier-v1')
    expect(withdrawal.proof_control_plane_gate).not.to.have.property('scroll_real_verifier')
    expect(withdrawal.proof_work_api.materialize.scroll_chunk_segmentation.enabled).to.equal(true)

    const expectedRevision = computeProofTopologyBundleRevision(root)
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'bundle-manifest-v1.json'), 'utf8'))
    const sidecar = JSON.parse(fs.readFileSync(path.join(root, 'resolved-v2.json'), 'utf8'))
    expect(manifest.bundle_revision).to.equal(expectedRevision)
    expect(sidecar.bundle_revision).to.equal(expectedRevision)
  })
})
