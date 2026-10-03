import {expect} from 'chai'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DogeConfig} from '../../src/types/doge-config.js'

import {writeProofDeploymentContract} from '../../src/utils/proof-deployment-contract.js'
import {
  planProofProgramPublication,
  publishProofProgramBundle,
} from '../../src/utils/proof-program-publication.js'
import {rebindProofTopologyBundleRevision} from '../../src/utils/proof-topology-compiler.js'
import {writeSignerPolicyHandoff} from '../../src/utils/signer-policy-handoff.js'
import {releaseFixture} from '../helpers/proof-software-release.js'

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

  it('publishes from the pinned image with only temporary AWS credentials and no core checkout', async () => {
    const release = releaseFixture(coreRevision)
    const materials = JSON.parse(fs.readFileSync(path.join(root, '.data/proof-materials-v1.json'), 'utf8'))
    for (const name of ['mockWorker', 'productionWorker', 'topologyCompiler'] as const) {
      release.images[name].reference = `${materials.images[name].repository}@${materials.images[name].digest}`
    }

    const names: Record<string, string> = {'batch/app.vmexe': 'batchAppExe', 'batch/openvm.toml': 'batchAppConfig', 'chunk/app.vmexe': 'chunkAppExe', 'chunk/openvm.toml': 'chunkAppConfig', 'verifier/aggregate-vk': 'aggregateVerifyingKey'}
    for (const [file, key] of Object.entries(names)) {
      Object.assign(release.genericBundle.files[file], {sha256: materials.software.artifacts[key].sha256, sizeBytes: materials.software.artifacts[key].sizeBytes})
    }

    const body = JSON.stringify(release)
    fs.writeFileSync(path.join(root, 'release.json'), body)
    let invocation: {args: string[]; env?: NodeJS.ProcessEnv} | undefined
    const result = await publishProofProgramBundle({
      ...common(), anonymousRead: async url => published.get(url)!, coreDir: undefined, output: '.data/publication.json',
      release: 'release.json', releaseSha256: digest(body),
      run(command, args, options) {
        expect(command).not.to.equal('git')
        if (command === 'aws') return JSON.stringify({AccessKeyId: 'temporary-id', Expiration: new Date(Date.now() + 600_000).toISOString(), SecretAccessKey: 'temporary-secret', SessionToken: 'temporary-session'})
        if (args[0] === 'pull') return ''
        if (args[0] === 'image') return args.at(-1)!.includes('proof-bundle.mapping') ? 'v1-11-files' : coreRevision
        invocation = {args, env: options?.env}
        const mount = args[args.indexOf('--mount') + 1]
        const staged = mount.slice('type=bind,src='.length).split(',dst=')[0]
        const scriptArgs = args.slice(args.indexOf('--bundle-dir'))
        scriptArgs[1] = staged
        return run('publisher', scriptArgs, options)
      },
    })
    expect(invocation!.args.filter(x => x === '--mount')).to.have.length(1)
    expect(invocation!.args).to.include('--read-only')
    expect(invocation!.args.join(' ')).not.to.include('temporary-secret')
    expect(invocation!.env?.AWS_SESSION_TOKEN).to.equal('temporary-session')
    expect(result.receipt.publisherImage).to.equal(release.images.publisher.reference)
    expect(result.receipt.releaseSha256).to.equal(digest(body))
    expect(JSON.stringify(result.receipt)).not.to.include('temporary-secret')
  })

  it('exports only the contract-selected receipt and keeps completed signer bundles intact on failure', () => {
    const receiptPath = path.join(root, '.data/selected-materials.json')
    const materials = JSON.parse(fs.readFileSync(path.join(root, '.data/proof-materials-v1.json'), 'utf8'))
    const context = JSON.stringify({genesis: {genesis_bridge_key_hash: '0x' + '1'.repeat(40)}})
    fs.writeFileSync(path.join(root, '.data/protocol_context.json'), context)
    materials.bridge.protocolContextSha256 = digest(context)
    fs.writeFileSync(receiptPath, JSON.stringify(materials))
    fs.writeFileSync(path.join(root, '.data/proof-materials-v1.json'), '{"stale_default":true}')
    const values = path.join(root, 'values.yaml')
    fs.writeFileSync(values, 'env: []\n')
    const component = {enabled: true, valuesFile: values}
    const topology = path.join(root, '.data/generated/proof-topology')
    writeProofDeploymentContract({deploymentDir: root, enforcement: 'observe', ethDaSubmitter: component, generation: 'real', intentSource: {kind: 'doge-config', path: path.join(root, 'config.toml'), sha256: 'c'.repeat(64)}, materialsReceipt: receiptPath, mode: 'active', proofArtifactBaseUrl: 'https://s3.us-east-1.amazonaws.com/dogeos-proof-artifacts/devnet/instance', proofCoordinator: component, proverWorker: {...component, enabled: false}, topology: {bundleDir: topology, bundleManifest: path.join(topology, 'bundle-manifest-v1.json'), bundleRevision: 'd'.repeat(64), resolvedSidecar: path.join(topology, 'resolved-v2.json')}, tsoValuesFile: values, withdrawalProcessor: component, worker: {contractFile: path.join(topology, 'prover-worker-v1.json'), kind: 'compiled-external'}})
    const config = {attestationSigner: {activeSignerIds: ['partner'], external: [{endpoint: 'https://partner.example.com', id: 'partner', publicKey: '02' + '2'.repeat(64)}], mode: 'external'}, network: 'testnet'} as DogeConfig
    const options = {config, deploymentDir: root, output: 'signer-bundle', protocolContext: '.data/protocol_context.json', tsoUrl: 'https://tso.example.com'}
    const result = writeSignerPolicyHandoff(options)
    expect(result.advanceL2Verifier?.batchProgramCommitmentHex).to.equal(materials.software.identities.batch.appCommitRaw)
    const manifest = fs.readFileSync(path.join(result.bundleDir, 'signer-policy-manifest.json'), 'utf8')
    expect(() => writeSignerPolicyHandoff(options)).to.throw('already exists')
    expect(fs.readFileSync(path.join(result.bundleDir, 'signer-policy-manifest.json'), 'utf8')).to.equal(manifest)
    fs.appendFileSync(receiptPath, ' ')
    expect(() => writeSignerPolicyHandoff({...options, output: 'failed-bundle'})).to.throw('checksum mismatch')
    expect(fs.existsSync(path.join(root, 'failed-bundle'))).to.equal(false)
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
