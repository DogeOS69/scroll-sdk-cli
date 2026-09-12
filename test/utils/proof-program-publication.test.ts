import {expect} from 'chai'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  planProofProgramPublication,
  publishProofProgramBundle,
} from '../../src/utils/proof-program-publication.js'
import {rebindProofTopologyBundleRevision} from '../../src/utils/proof-topology-compiler.js'

const coreRevision = 'a'.repeat(40)
const imageDigest = `sha256:${'b'.repeat(64)}`
const raw = (character: string) => `0x${character.repeat(128)}`
const digest = (body: Buffer | string) => crypto.createHash('sha256').update(body).digest('hex')
const commitment = (value: string) => `0x${digest(Buffer.from(value.slice(2), 'hex'))}`

const publisherFiles = [
  ['DOGEOS_CHUNK_VMEXE', 'chunk/app.vmexe'],
  ['DOGEOS_CHUNK_CONFIG', 'chunk/openvm.toml'],
  ['DOGEOS_BATCH_VMEXE', 'batch/app.vmexe'],
  ['DOGEOS_BATCH_CONFIG', 'batch/openvm.toml'],
  ['DOGEOS_BRIDGE_VMEXE', 'bridge/bridge-state.vmexe'],
  ['DOGEOS_BRIDGE_CONFIG', 'bridge/openvm.toml'],
  ['DOGEOS_BRIDGE_MANIFEST', 'bridge/bridge-artifact-manifest.json'],
  ['DOGEOS_AGGREGATION_VMEXE', 'bridge/batch-aggregation.vmexe'],
  ['DOGEOS_AGGREGATION_CONFIG', 'bridge/batch-aggregation-openvm.toml'],
  ['DOGEOS_TAG5_MANIFEST', 'bridge/l2-range-aggregation-topology-program.json'],
  ['DOGEOS_PROTOCOL_CONTEXT', 'protocol_context.json'],
] as const

describe('real-proof program bundle publication', () => {
  let root: string
  let core: string
  let published: Map<string, {sha256: string; sizeBytes: number}>
  let publisherInvocation: {args: string[]; env?: NodeJS.ProcessEnv} | undefined

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-program-publication-'))
    core = path.join(root, 'core')
    published = new Map()
    const write = (relative: string, body = relative) => {
      const file = path.join(root, relative)
      fs.mkdirSync(path.dirname(file), {recursive: true})
      fs.writeFileSync(file, body)
      return file
    }

    const material = (relative: string) => {
      const file = write(relative)
      return {path: relative, sha256: digest(fs.readFileSync(file)), sizeBytes: fs.statSync(file).size}
    }

    const software = {
      aggregateVerifyingKey: material('.data/proof-materials/software/verifier/root_verifier_vk'),
      batchAppConfig: material('.data/proof-materials/software/batch/openvm.toml'),
      batchAppExe: material('.data/proof-materials/software/batch/app.vmexe'),
      batchMaterializer: material('.data/proof-materials/software/bin/batch-materializer'),
      chunkAppConfig: material('.data/proof-materials/software/chunk/openvm.toml'),
      chunkAppExe: material('.data/proof-materials/software/chunk/app.vmexe'),
      chunkMaterializer: material('.data/proof-materials/software/bin/chunk-materializer'),
    }
    const bridgeArtifacts = {
      appConfig: material('.data/proof-materials/bridge/openvm.toml'),
      appExe: material('.data/proof-materials/bridge/bridge-state.vmexe'),
      l2RangeAppConfig: material('.data/proof-materials/bridge/batch-aggregation-openvm.toml'),
      l2RangeAppExe: material('.data/proof-materials/bridge/batch-aggregation.vmexe'),
      nativeManifest: material('.data/proof-materials/bridge/bridge-artifact-manifest.json'),
      workerIdentityBundle: material('.data/proof-materials/bridge/worker-identity-bundle.json'),
    }
    const protocol = material('.data/protocol_context.json')
    const identity = (character: string, vk: string) => ({
      appCommitRaw: raw(character),
      programCommitmentHash: commitment(raw(character)),
      verificationKeyHash: `0x${vk.repeat(64)}`,
    })
    write('.data/proof-materials-v1.json', `${JSON.stringify({
      bridge: {
        artifacts: bridgeArtifacts,
        genesisSequencerOutpointIndex: 0,
        genesisStateHash: `0x${'1'.repeat(64)}`,
        identity: identity('4', '5'),
        protocolContextPath: protocol.path,
        protocolContextSha256: protocol.sha256,
      },
      generatedAt: new Date().toISOString(),
      images: {
        mockWorker: {digest: imageDigest, repository: 'example/mock'},
        productionWorker: {digest: imageDigest, repository: 'example/production'},
        topologyCompiler: {digest: imageDigest, repository: 'example/compiler'},
      },
      schema: 'scrollsdk/proof-materials/v1',
      schemaVersion: 1,
      software: {
        artifacts: software,
        identities: {
          batch: identity('2', '3'),
          bridge: identity('4', '5'),
          chunk: identity('1', '2'),
          l2Range: identity('3', '5'),
        },
        identitySource: 'real_identity_probe',
        openvmVersion: 'v1.7.0',
        rustToolchain: 'nightly-2026-03-17',
        sourceRevisions: {dogeosCore: coreRevision, scrollZkvmProver: 'producer'},
      },
    }, null, 2)}\n`)

    write('.data/proof-aws.json', `${JSON.stringify({
      artifactReadTransport: {
        publicEndpointUrl: 'https://s3.us-east-1.amazonaws.com',
        publicReadMode: 'existing-public-s3',
        publicStatus: 'operator-managed-unverified',
      },
      artifactStore: {bucket: 'dogeos-proof-artifacts', keyPrefix: 'devnet/instance', region: 'us-east-1'},
      kubernetes: {awsRegion: 'us-east-1', deploymentAlias: 'devnet', eksCluster: 'cluster', namespace: 'default'},
      schema: 'dogeos/proof-aws/v4',
      secret: {name: 'scroll/devnet/proof', region: 'us-east-1'},
      serviceAccounts: {
        proofCoordinator: {name: 'proof-coordinator', roleArn: 'arn:aws:iam::123456789012:role/proof-coordinator'},
        withdrawalProcessor: {name: 'withdrawal-processor', roleArn: 'arn:aws:iam::123456789012:role/withdrawal-processor'},
      },
    }, null, 2)}\n`)

    const topology = path.join(root, '.data/generated/proof-topology')
    write('.data/generated/proof-topology/withdrawal-processor.toml')
    write('.data/generated/proof-topology/proof-coordinator.toml')
    write('.data/generated/proof-topology/materials/program-manifests/l2-range-aggregation-topology-program.json')
    write('.data/generated/proof-topology/prover-worker-v1.json', JSON.stringify({
      argv: ['prover-worker'],
      capabilities: ['prove_scroll_chunk'],
      desired_state: 'external',
      environment: [],
      image: {digest: imageDigest, repository: 'example/production'},
      placement: 'external',
      readiness_evidence_path: '/tmp/ready',
      required_build_class: 'production',
      schema_version: 1,
    }))
    write('.data/generated/proof-topology/resolved-v2.json', JSON.stringify({
      bundle_revision: '0'.repeat(64),
      resolved: {enforcement: 'observe', mode: 'production'},
      schema_version: 2,
    }))
    write('.data/generated/proof-topology/bundle-manifest-v1.json', JSON.stringify({
      bundle_revision: '0'.repeat(64),
      compiler_package_version: '0.3.0',
      deployment_context_schema_version: 1,
      generated_materials: 'materials',
      installable_service_configs: true,
      preflight_only: false,
      proof_coordinator: 'proof-coordinator.toml',
      prover_worker: 'prover-worker-v1.json',
      resolved_sidecar: 'resolved-v2.json',
      schema_version: 1,
      source_schema_version: 1,
      withdrawal_processor: 'withdrawal-processor.toml',
    }))
    rebindProofTopologyBundleRevision(topology)

    fs.mkdirSync(path.join(core, 'tools/real-proving'), {recursive: true})
    fs.writeFileSync(
      path.join(core, 'tools/real-proving/publish-real-proving-bundle.sh'),
      `readonly BUNDLE_FILES=(\n${publisherFiles.map(([prefix, relative]) => `  "${prefix}:${relative}"`).join('\n')}\n)\n`,
    )
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  function run(command: string, args: string[], options?: {env?: NodeJS.ProcessEnv}): string {
    if (command === 'git') return args.includes('--porcelain') ? '' : coreRevision
    publisherInvocation = {args, env: options?.env}
    const value = (flag: string) => args[args.indexOf(flag) + 1]
    const staged = value('--bundle-dir')
    const endpoint = value('--public-endpoint-url')
    const bucket = value('--bucket')
    const keyPrefix = value('--key-prefix')
    const lines: string[] = []
    for (const [prefix, relative] of publisherFiles) {
      const body = fs.readFileSync(path.join(staged, relative))
      const url = `${endpoint}/${bucket}/${keyPrefix}/${relative}`
      const sha256 = digest(body)
      published.set(url, {sha256, sizeBytes: body.length})
      lines.push(`${prefix}_URL=${url}`, `${prefix}_SHA256=${sha256}`)
    }

    return `${lines.join('\n')}\n`
  }

  const common = () => ({
    coreDir: core,
    deploymentDir: root,
    materialsReceipt: '.data/proof-materials-v1.json',
    proofAwsConfig: '.data/proof-aws.json',
    run,
    topologyBundle: '.data/generated/proof-topology',
  })

  it('plans a content-addressed 11-file release without calling the publisher', () => {
    const plan = planProofProgramPublication(common())
    expect(plan.files).to.have.length(11)
    expect(plan.bundleId).to.match(/^[\da-f]{64}$/)
    expect(plan.artifactStore.keyPrefix).to.equal(`devnet/instance/proof-programs/${plan.bundleId}`)
    expect(publisherInvocation).to.equal(undefined)
  })

  it('publishes through the core script, preserves bucket policy and anonymously verifies every object', async () => {
    const result = await publishProofProgramBundle({
      ...common(),
      anonymousRead: async url => published.get(url)!,
      awsProfile: 'devnet',
      output: '.data/publication.json',
    })
    expect(Object.keys(result.receipt.files)).to.have.length(11)
    expect(result.receipt.verification).to.deep.equal({
      anonymousHttpReadback: 'passed',
      authenticatedS3Readback: 'passed',
    })
    expect(publisherInvocation!.args).to.include('--skip-bucket-setup')
    expect(publisherInvocation!.args).not.to.include('--emit-env')
    expect(publisherInvocation!.env?.AWS_PROFILE).to.equal('devnet')
    expect(publisherInvocation!.env).not.to.have.property('DOGEOS_PROVER_WORKER_TOKEN')
  })

  it('does not write a receipt when anonymous readback differs', async () => {
    let first = true
    try {
      await publishProofProgramBundle({
        ...common(),
        async anonymousRead(url) {
          const result = published.get(url)!
          if (first) {
            first = false
            return {...result, sha256: '0'.repeat(64)}
          }

          return result
        },
        output: '.data/publication.json',
      })
      expect.fail('publication should fail')
    } catch (error) {
      expect(String(error)).to.include('Anonymous artifact readback mismatch')
    }

    expect(fs.existsSync(path.join(root, '.data/publication.json'))).to.equal(false)
  })
})
