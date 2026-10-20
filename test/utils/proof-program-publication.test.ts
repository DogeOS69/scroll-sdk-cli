import * as toml from '@iarna/toml'
import {expect} from 'chai'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sinon from 'sinon'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'
import type {DogeConfig} from '../../src/types/doge-config.js'
import type {PreparationPlan} from '../../src/utils/preparation-plan.js'

import {ExportDeploymentKitCommand} from '../../src/commands/setup/export-deployment-kit.js'
import {writeDeploymentKit} from '../../src/utils/deployment-kit.js'
import {deploymentKitBlockers, recordDeploymentKitPublication, withoutPendingDeploymentKit} from '../../src/utils/deployment-kit-record.js'
import {awaitDeploymentKitPublication, exportPreparationDeploymentKit, publishPreparationDeploymentKit} from '../../src/utils/preparation-deployment-kit.js'
import {AwaitingInput} from '../../src/utils/preparation-io.js'
import {CommandPreparationRunner} from '../../src/utils/preparation-runner.js'
import {writeProofDeploymentContract} from '../../src/utils/proof-deployment-contract.js'
import {proofEnforcementReadiness} from '../../src/utils/proof-enforcement-readiness.js'
import {readProofMaterials} from '../../src/utils/proof-materials.js'
import {
  assertProofPublicationContent,
  planProofProgramPublication,
  publishProofProgramBundle,
} from '../../src/utils/proof-program-publication.js'
import {rebindProofTopologyBundleRevision} from '../../src/utils/proof-topology-compiler.js'
import {protocolOpeningId} from '../../src/utils/protocol-opening-id.js'
import {protocolIdSidecarPath} from '../../src/utils/signer-policy-derivation.js'
import {releaseFixture} from '../helpers/proof-software-release.js'

const coreRevision = 'a'.repeat(40)
const imageDigest = `sha256:${'b'.repeat(64)}`
const raw = (character: string) => `0x${character.repeat(128)}`
const hash = (byte: string, size: number) => `0x${byte.repeat(size)}`
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

const kitFiles = ['advance-l2-agg-verifying-key.bin', 'deployment-kit-manifest.json', 'deployment-kit.env', 'deployment-kit.json', 'protocol_context.json']

async function exportKit(args: string[]): Promise<string> {
  try {await ExportDeploymentKitCommand.run([...args, '--json']); return ''} catch (error) {return String((error as {response?: {error?: {message?: string}}}).response?.error?.message ?? error)}
}

describe('real-proof program bundle publication', () => {
  let root: string
  let core: string
  let published: Map<string, {sha256: string; sizeBytes: number}>
  let publisherInvocation: {args: string[]; env?: NodeJS.ProcessEnv} | undefined

  beforeEach(() => {
    publisherInvocation = undefined
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
        sourceRevisions: {dogeosCore: coreRevision},
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

  it('accepts unchanged published content across a valid runtime topology revision and rejects changed program material', async () => {
    const result = await publishProofProgramBundle({...common(), anonymousRead: async url => published.get(url)!, output: '.data/publication.json'})
    const contract = {
      generation: 'real', inputs: {materials: {path: common().materialsReceipt}, protocolContext: {sha256: '0'.repeat(64)}, publication: {path: '.data/publication.json', sha256: digest(fs.readFileSync(result.receiptPath))}},
      mode: 'active', topology: {bundleDir: common().topologyBundle, bundleRevision: 'different-runtime-revision'}, worker: {enabled: true},
    } as any
    const config = {cubesigner: {mode: 'transport_only', roles: []}, network: 'testnet'} as unknown as DogeConfig
    const check = () => proofEnforcementReadiness(root, contract, config).blockers.filter(item => /Publication|topology bundle/.test(item))
    expect(check()).to.deep.equal([])
    fs.appendFileSync(path.join(root, common().topologyBundle, 'withdrawal-processor.toml'), '\n# changed runtime endpoint\n')
    rebindProofTopologyBundleRevision(path.join(root, common().topologyBundle))
    expect(check()).to.deep.equal([])
    const tag5 = path.join(root, common().topologyBundle, 'materials/program-manifests/l2-range-aggregation-topology-program.json')
    fs.appendFileSync(tag5, '\nchanged program identity\n')
    rebindProofTopologyBundleRevision(path.join(root, common().topologyBundle))
    expect(check().join(' ')).to.include('Publication content differs from selected material: bridge/l2-range-aggregation-topology-program.json')
  })

  it('checks every canonical program/protocol file and the receipt object mapping and bundle ID', async () => {
    const plan = planProofProgramPublication(common())
    const result = await publishProofProgramBundle({...common(), anonymousRead: async url => published.get(url)!, output: '.data/publication.json'})
    const materials = readProofMaterials(path.join(root, common().materialsReceipt), root)
    const contract = {topology: {bundleDir: common().topologyBundle}} as any
    const check = () => assertProofPublicationContent(root, contract, materials, result.receipt)
    expect(check).not.to.throw()
    for (const file of plan.files) {
      const original = fs.readFileSync(file.source)
      fs.appendFileSync(file.source, '\nchanged\n')
      rebindProofTopologyBundleRevision(path.join(root, common().topologyBundle))
      expect(check, file.relativePath).to.throw()
      fs.writeFileSync(file.source, original)
      rebindProofTopologyBundleRevision(path.join(root, common().topologyBundle))
      expect(check, file.relativePath).not.to.throw()
    }

    const key = 'chunk/app.vmexe'
    const entry = structuredClone(result.receipt.files[key])
    result.receipt.files[key].key = 'wrong/object'
    expect(check).to.throw('Publication content differs')
    result.receipt.files[key] = entry
    result.receipt.bundleId = '0'.repeat(64)
    expect(check).to.throw('Publication content bundle ID')
    result.receipt.bundleId = plan.bundleId
    delete result.receipt.files[key]
    expect(check).to.throw('exactly the eleven')
  })

  it('refuses publication source paths through a symlinked material directory', async () => {
    const result = await publishProofProgramBundle({...common(), anonymousRead: async url => published.get(url)!, output: '.data/publication.json'})
    const materials = readProofMaterials(path.join(root, common().materialsReceipt), root)
    const directory = path.dirname(path.join(root, materials.software.artifacts!.chunkAppExe.path))
    fs.renameSync(directory, `${directory}-original`)
    fs.symlinkSync(`${directory}-original`, directory, 'dir')
    expect(() => assertProofPublicationContent(root, {topology: {bundleDir: common().topologyBundle}} as any, materials, result.receipt)).to.throw('symlink')
  })

  it('plans a content-addressed 11-file release without calling the publisher', () => {
    const plan = planProofProgramPublication(common())
    expect(plan.files).to.have.length(11)
    expect(plan.bundleId).to.match(/^[\da-f]{64}$/)
    expect(plan.artifactStore.keyPrefix).to.equal(`devnet/instance/proof-programs/${plan.bundleId}`)
    expect(publisherInvocation).to.equal(undefined)
  })

  it('uses the same canonical S3 publication plan without provisioning workload IAM resources', () => {
    const expected = planProofProgramPublication(common())
    fs.rmSync(path.join(root, '.data/proof-aws.json'))
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), '[proofArtifacts.s3]\nbucket = "dogeos-proof-artifacts"\nkeyPrefix = "devnet/instance"\nregion = "us-east-1"\nendpointUrl = "https://s3.us-east-1.amazonaws.com"\n')
    const actual = planProofProgramPublication({...common(), artifactSource: 'doge-config'})
    expect(actual).to.deep.equal(expected)
    expect(publisherInvocation).to.equal(undefined)
  })

  it('does not silently redirect an explicitly non-AWS store to AWS', () => {
    fs.rmSync(path.join(root, '.data/proof-aws.json'))
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), '[proofArtifacts.s3]\nbucket = "dogeos-proof-artifacts"\nkeyPrefix = "devnet/instance"\nregion = "us-east-1"\nendpointUrl = "https://storage.example.com"\n')
    expect(() => planProofProgramPublication({...common(), artifactSource: 'doge-config'})).to.throw('regional AWS S3 endpoint')
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

  for (const iamUserProfile of [false, true]) it(`publishes from the pinned image with temporary credentials (${iamUserProfile ? 'STS exchange' : 'existing session'}) and no core checkout`, async () => {
    const release = releaseFixture(coreRevision)
    const materials = JSON.parse(fs.readFileSync(path.join(root, '.data/proof-materials-v1.json'), 'utf8'))
    for (const [key, name] of [['productionWorker', 'prover-worker-cuda'], ['topologyCompiler', 'dogeos-proof-topology']] as const) {
      release.images[name] = `${materials.images[key].repository}@${materials.images[key].digest}`
    }

    const body = JSON.stringify(release)
    fs.writeFileSync(path.join(root, 'release.json'), body)
    let invocation: {args: string[]; env?: NodeJS.ProcessEnv} | undefined
    let sessionRequests = 0
    const result = await publishProofProgramBundle({
      ...common(), anonymousRead: async url => published.get(url)!, coreDir: undefined, output: '.data/publication.json',
      release: 'release.json', releaseSha256: digest(body),
      run(command, args, options) {
        expect(command).not.to.equal('git')
        if (command === 'aws') {
          const temporary = {AccessKeyId: 'temporary-id', Expiration: new Date(Date.now() + 600_000).toISOString(), SecretAccessKey: 'temporary-secret', SessionToken: 'temporary-session'}
          if (args[0] === 'configure') return JSON.stringify(iamUserProfile ? {AccessKeyId: 'NONFUNCTIONAL_LONG_TERM_ID', SecretAccessKey: 'NONFUNCTIONAL_LONG_TERM_SECRET'} : temporary)
          expect(args).to.deep.equal(['sts', 'get-session-token', '--duration-seconds', '3600', '--output', 'json'])
          sessionRequests++
          return JSON.stringify({Credentials: temporary})
        }

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
    expect(invocation!.env?.AWS_SECRET_ACCESS_KEY).to.equal('temporary-secret')
    expect(sessionRequests).to.equal(iamUserProfile ? 1 : 0)
    expect(result.receipt.publisherImage).to.equal(release.images['proof-bundle-publisher'])
    expect(result.receipt.releaseSha256).to.equal(digest(body))
    expect(JSON.stringify(result.receipt)).not.to.include('temporary-secret')
  })

  const TSO_URL = 'https://tso.example.com'

  /** An active/real deployment with a bound contract, a doge-config proof intent and a TSO ingress host. */
  function deploymentKitFixture(enforcement: 'enforce' | 'observe' = 'enforce') {
    const context = JSON.stringify({
      genesis: {
        genesis_batch_hash: hash('a1', 32), genesis_bridge_key_hash: hash('33', 20),
        genesis_sequencer_outpoint: {txid: hash('22', 32), vout: 0}, genesis_state_root: hash('a2', 32),
        initial_confirmed_block_hash: hash('44', 32), initial_confirmed_block_number: 100,
        initial_ethereum_block_hash: hash('55', 32), initial_system_signer: hash('a3', 20), initial_tx_index: 200,
      },
      // Dogecoin testnet, matching the fixture's doge-config network.
      protocol: {dogecoin_chain_id: 111_111, eth_chain_id: 31_337, l2_chain_id: 534_352, protocol_version: 2},
    })
    const receiptPath = path.join(root, '.data/proof-materials-v1.json')
    const materials = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    fs.writeFileSync(path.join(root, '.data/protocol_context.json'), context)
    materials.bridge.protocolContextSha256 = digest(context)
    fs.writeFileSync(receiptPath, JSON.stringify(materials))
    const values = path.join(root, 'values.yaml')
    fs.writeFileSync(values, 'env: []\n')
    const component = {enabled: true, valuesFile: values}
    const topology = path.join(root, '.data/generated/proof-topology')
    writeProofDeploymentContract({deploymentDir: root, enforcement, ethDaSubmitter: component, generation: 'real', intentSource: {kind: 'doge-config', path: path.join(root, '.data/doge-config.toml'), sha256: 'c'.repeat(64)}, materialsReceipt: receiptPath, mode: 'active', proofArtifactBaseUrl: 'https://s3.us-east-1.amazonaws.com/dogeos-proof-artifacts/devnet/instance', proofCoordinator: component, proverWorker: {...component, enabled: false}, topology: {bundleDir: topology, bundleManifest: path.join(topology, 'bundle-manifest-v1.json'), bundleRevision: 'd'.repeat(64), resolvedSidecar: path.join(topology, 'resolved-v2.json')}, tsoValuesFile: values, withdrawalProcessor: component, worker: {contractFile: path.join(topology, 'prover-worker-v1.json'), kind: 'compiled-external'}})
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), [
      'network = "testnet"', '[wallet]', 'path = ".data/wallet.json"',
      '[attestationSigner]', 'mode = "external"', 'activeSignerIds = []', 'threshold = 1',
      '[proof_topology]', 'mode = "active"', 'generation = "real"', `enforcement = "${enforcement}"`, 'observeRealProofDeadlineMs = 60000',
      '[proof_topology.compiler]', 'identityFilePath = "compiler-identity.json"', `image = {repository = "example/compiler", digest = "${imageDigest}"}`,
      '[proof_topology.deployment]', 'artifactKeyPrefix = "devnet/instance"', `productionWorkerImage = {repository = "example/production", digest = "${imageDigest}"}`,
      '[proof_topology.active]', 'profile = "real_scroll_default"',
      '[proof_topology.active.artifactStore]', 'kind = "s3_compatible"', 'bucket = "dogeos-proof-artifacts"', 'region = "us-east-1"',
      '[proof_topology.active.realScroll]',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(root, 'config.toml'), '[ingress]\nTSO_HOST = "tso.example.com"\n')
    // No external signer roster: the kit must not depend on one.
    const config = {network: 'testnet'} as DogeConfig
    return {context, materials, options: {config, deploymentDir: root, protocolContext: '.data/protocol_context.json', tsoUrl: TSO_URL}}
  }

  const readConfig = () => toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')) as unknown as DogeConfig
  const contractFor = () => JSON.parse(fs.readFileSync(path.join(root, '.data/proof-deployment.json'), 'utf8'))

  it('exports a kit whose version is derived from the signer-relevant fields and whose identity is the manifest digest', () => {
    const {context, materials, options} = deploymentKitFixture()
    const record = writeDeploymentKit(options)
    expect(record.kitVersion).to.match(/^k-[\da-f]{12}$/)
    const kitDir = path.join(root, `deployment-kit-${record.kitVersion}`)
    expect(record.kitDir).to.equal(kitDir)
    expect(fs.readdirSync(kitDir).sort()).to.deep.equal(kitFiles)
    const manifestBytes = fs.readFileSync(path.join(kitDir, 'deployment-kit-manifest.json'))
    expect(record.manifestSha256).to.equal(digest(manifestBytes))
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    expect(manifest.schema).to.equal('dogeos/deployment-kit-manifest/v1')
    expect(manifest.files.map((entry: {file: string}) => entry.file)).to.deep.equal(kitFiles.filter(file => file !== 'deployment-kit-manifest.json'))
    for (const entry of manifest.files) {
      const body = fs.readFileSync(path.join(kitDir, entry.file))
      expect(entry).to.deep.equal({file: entry.file, sha256: `sha256:${digest(body)}`, sizeBytes: body.length})
    }

    const kit = JSON.parse(fs.readFileSync(path.join(kitDir, 'deployment-kit.json'), 'utf8'))
    const vk = fs.readFileSync(path.join(root, materials.software.artifacts.aggregateVerifyingKey.path))
    expect(kit).to.deep.equal({
      advance_l2_verifier: {agg_verifying_key_file: 'advance-l2-agg-verifying-key.bin', agg_verifying_key_sha256: `sha256:${digest(vk)}`, batch_program_commitment_hex: materials.software.identities.batch.appCommitRaw, l2_range_aggregation_program_commitment_hex: materials.software.identities.l2Range.appCommitRaw},
      artifact_origins: ['https://s3.us-east-1.amazonaws.com'],
      kit_version: record.kitVersion,
      network: 'testnet',
      policy_mode: 'enforce',
      protocol_context: {file: 'protocol_context.json', sha256: `sha256:${digest(context)}`},
      protocol_instance_id: `0x${protocolOpeningId(JSON.parse(context))}`,
      schema: 'dogeos/deployment-kit/v1',
      tso_url: TSO_URL,
    })
    // The version rule, independently: canonical JSON (sorted keys, no whitespace) of the signer-relevant fields.
    const signerFields = {advance_l2_verifier: kit.advance_l2_verifier, artifact_origins: kit.artifact_origins, network: kit.network, policy_mode: kit.policy_mode, protocol_context_sha256: kit.protocol_context.sha256, protocol_instance_id: kit.protocol_instance_id, tso_url: kit.tso_url}
    expect(record.kitVersion).to.equal(`k-${digest(JSON.stringify(signerFields)).slice(0, 12)}`)
    expect(record).to.include({network: 'testnet', protocolInstanceId: kit.protocol_instance_id})
    const env = Object.fromEntries(fs.readFileSync(path.join(kitDir, 'deployment-kit.env'), 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(/=(.*)/s).slice(0, 2)))
    expect(env).to.deep.equal({
      ATTESTATION_SIGNER_ADVANCE_L2_AGG_VERIFYING_KEY_PATH: '/etc/dogeos/advance-l2-agg-verifying-key.bin',
      ATTESTATION_SIGNER_ADVANCE_L2_BATCH_PROGRAM_COMMITMENT_HEX: kit.advance_l2_verifier.batch_program_commitment_hex,
      ATTESTATION_SIGNER_ARTIFACT_ALLOWED_ORIGINS: kit.artifact_origins[0],
      ATTESTATION_SIGNER_L2_RANGE_AGGREGATION_PROGRAM_COMMITMENT_HEX: kit.advance_l2_verifier.l2_range_aggregation_program_commitment_hex,
      ATTESTATION_SIGNER_NETWORK: 'testnet',
      ATTESTATION_SIGNER_POLICY_MODE: 'enforce',
      ATTESTATION_SIGNER_PROTOCOL_CONTEXT_JSON: '/etc/dogeos/protocol_context.json',
      ATTESTATION_SIGNER_TSO_URL: TSO_URL,
    })
    expect(fs.readFileSync(path.join(kitDir, 'protocol_context.json'), 'utf8')).to.equal(context)
    expect(fs.readFileSync(path.join(kitDir, 'advance-l2-agg-verifying-key.bin'))).to.deep.equal(vk)
  })

  it('reruns as a no-op, gives changed inputs a new version, and never overwrites a different kit', () => {
    const {options} = deploymentKitFixture()
    const first = writeDeploymentKit(options)
    const manifest = path.join(first.kitDir, 'deployment-kit-manifest.json')
    const before = fs.readFileSync(manifest, 'utf8')
    // Same inputs: same version and bytes; nothing is rewritten.
    expect(writeDeploymentKit(options)).to.deep.equal(first)
    expect(fs.readFileSync(manifest, 'utf8')).to.equal(before)
    // A changed endpoint is a new version in a new directory; the old kit stays.
    const second = writeDeploymentKit({...options, tsoUrl: 'https://tso-2.example.com'})
    expect(second.kitVersion).to.not.equal(first.kitVersion)
    expect(fs.readdirSync(root).filter(name => name.startsWith('deployment-kit-')).sort()).to.deep.equal([path.basename(first.kitDir), path.basename(second.kitDir)].sort())
    // An existing directory that is not exactly this kit is refused and left as it is.
    fs.appendFileSync(path.join(first.kitDir, 'deployment-kit.env'), '# edited\n')
    expect(() => writeDeploymentKit(options)).to.throw('never overwritten')
    fs.writeFileSync(path.join(second.kitDir, 'extra.txt'), 'x')
    expect(() => writeDeploymentKit({...options, tsoUrl: 'https://tso-2.example.com'})).to.throw('never overwritten')
    fs.mkdirSync(path.join(root, 'empty-target'))
    expect(() => writeDeploymentKit({...options, output: 'empty-target'})).to.throw('never overwritten')
    expect(fs.readdirSync(path.join(root, 'empty-target'))).to.deep.equal([])
  })

  it('re-validates the selected inputs on a no-op rerun too', () => {
    const {options} = deploymentKitFixture()
    const first = writeDeploymentKit(options)
    const receipt = path.join(root, '.data/proof-materials-v1.json')
    const readdir = fs.readdirSync
    let changed = false
    // The materials receipt changes while the existing kit is being verified.
    sinon.stub(fs, 'readdirSync').callsFake(((directory: fs.PathLike, ...rest: unknown[]) => {
      if (directory === first.kitDir && !changed) {changed = true; fs.appendFileSync(receipt, ' ')}
      return (readdir as (...args: unknown[]) => unknown)(directory, ...rest)
    }) as typeof fs.readdirSync)
    try {
      expect(() => writeDeploymentKit(options)).to.throw()
    } finally {sinon.restore()}

    expect(changed).to.equal(true)
  })

  it('cross-checks the protocol id sidecar written by bridge-init', () => {
    const {context, options} = deploymentKitFixture()
    const id = protocolOpeningId(JSON.parse(context))
    const sidecar = protocolIdSidecarPath(path.join(root, '.data/protocol_context.json'))
    fs.writeFileSync(sidecar, `0x${'0'.repeat(63)}1\n`)
    expect(() => writeDeploymentKit(options)).to.throw('sidecar differs')
    expect(fs.readdirSync(root).filter(name => name.startsWith('deployment-kit-'))).to.deep.equal([])
    fs.writeFileSync(sidecar, `${id.toUpperCase()}\n`)
    expect(writeDeploymentKit(options).protocolInstanceId).to.equal(`0x${id}`)
  })

  it('publishes the verifying key bytes it hashed even if the source changes during export', () => {
    const {materials, options} = deploymentKitFixture()
    const vkPath = path.join(root, materials.software.artifacts.aggregateVerifyingKey.path)
    const original = fs.readFileSync(vkPath)
    const read = fs.readFileSync
    let reads = 0
    let tampered = false
    // The selected materials are hashed twice before the export reads the key itself (contract
    // validation, then the materials receipt). Change the source right after that third read and
    // restore it before the final contract check re-hashes it.
    sinon.stub(fs, 'readFileSync').callsFake(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (file === vkPath && ++reads === 4) fs.writeFileSync(vkPath, original)
      const result = (read as (...args: unknown[]) => unknown)(file, ...rest)
      if (file === vkPath && reads === 3) {
        tampered = true
        fs.writeFileSync(vkPath, Buffer.concat([original, Buffer.from('tampered')]))
      }

      return result
    }) as typeof fs.readFileSync)
    let record
    try {
      record = writeDeploymentKit(options)
    } finally {sinon.restore()}

    expect(tampered).to.equal(true)
    const kit = JSON.parse(fs.readFileSync(path.join(record.kitDir, 'deployment-kit.json'), 'utf8'))
    const vk = fs.readFileSync(path.join(record.kitDir, 'advance-l2-agg-verifying-key.bin'))
    expect(vk).to.deep.equal(original)
    expect(kit.advance_l2_verifier.agg_verifying_key_sha256).to.equal(`sha256:${digest(vk)}`)
  })

  it('claims the output directory before writing, so a concurrently created directory is never replaced', () => {
    const {options} = deploymentKitFixture()
    const kitDir = path.join(root, 'claimed-kit')
    const write = fs.writeFileSync
    let concurrent: unknown
    sinon.stub(fs, 'writeFileSync').callsFake(((...args: unknown[]) => {
      if (concurrent === undefined) {
        try {
          fs.mkdirSync(kitDir)
          concurrent = 'created'
        } catch (error) {
          concurrent = (error as NodeJS.ErrnoException).code
        }
      }

      return (write as (...values: unknown[]) => unknown)(...args)
    }) as typeof fs.writeFileSync)
    try {
      writeDeploymentKit({...options, output: 'claimed-kit'})
    } finally {sinon.restore()}

    expect(concurrent).to.equal('EEXIST')
  })

  it('refuses a kit whose configured network differs from the protocol context chain, and a non-enforcing contract', () => {
    const {options} = deploymentKitFixture()
    for (const network of ['mainnet', 'regtest']) {
      expect(() => writeDeploymentKit({...options, config: {network} as DogeConfig})).to.throw(`configured network ${network}`)
    }

    const observe = deploymentKitFixture('observe')
    expect(() => writeDeploymentKit(observe.options)).to.throw('active/real/enforce')
    expect(fs.readdirSync(root).filter(name => name.startsWith('deployment-kit-'))).to.deep.equal([])
  })

  it('setup apply writes the same kit as the CLI writer, from any working directory', async () => {
    const {options} = deploymentKitFixture()
    const cwd = process.cwd()
    process.chdir(os.tmpdir())
    let applied
    try {applied = (await exportPreparationDeploymentKit(root)).kit} finally {process.chdir(cwd)}
    const direct = writeDeploymentKit({...options, output: 'direct-kit'})
    expect(direct.manifestSha256).to.equal(applied.manifestSha256)
    for (const file of kitFiles) {
      expect(fs.readFileSync(path.join(applied.kitDir, file)).equals(fs.readFileSync(path.join(direct.kitDir, file))), file).to.equal(true)
    }
  })

  for (const staged of [false, true]) it(`runs kit steps through the ${staged ? 'signer-kit stages' : 'legacy apply'} runner: wait, record, then resume as a no-op`, async () => {
    deploymentKitFixture()
    const runner = new CommandPreparationRunner(async () => {throw new Error('no CLI subprocess for kit steps')})
    const step = (id: string) => ({effect: 'local' as const, id, retry: 'safe' as const, ...(staged ? {stage: id === 'deployment-kit' ? 'signer-kit' as const : 'signer-kit-publish' as const} : {}), title: id})
    const run = async (id: string) => {try {await runner.run(step(id), {preparation: {bridge: {image: 'unused', mode: 'helper'}}} as unknown as DeploymentSpec, root, {} as PreparationPlan); return ''} catch (error) {return error instanceof AwaitingInput ? `waiting: ${error.message}` : String(error)}}
    expect(await run('deployment-kit')).to.equal('')
    expect(await run('deployment-kit-published')).to.match(/^waiting: Waiting for the deployment kit/)
    const request = JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/inputs/deployment-kit/request.json'), 'utf8'))
    expect(request.instructions).to.include(staged ? 'rerun scrollsdk setup signer-kit-publish' : 'rerun scrollsdk setup apply')
    fs.writeFileSync(path.join(root, '.scrollsdk/inputs/deployment-kit/published.json'), JSON.stringify({manifest_sha256: request.manifestSha256, url: 'https://kits.example.com/k.tgz'}))
    expect(await run('deployment-kit-published')).to.equal('')
    const recorded = fs.readFileSync(path.join(root, '.data/doge-config.toml'))
    // Resume: both steps are no-ops and the record is unchanged.
    expect(await run('deployment-kit')).to.equal('')
    expect(await run('deployment-kit-published')).to.equal('')
    expect(fs.readFileSync(path.join(root, '.data/doge-config.toml')).equals(recorded)).to.equal(true)
    expect(deploymentKitBlockers(root, contractFor(), readConfig())).to.deep.equal([])
  })

  it('automatically records only an anonymously verified S3 kit and preserves deployment configuration', async () => {
    deploymentKitFixture()
    fs.appendFileSync(path.join(root, '.data/doge-config.toml'), '\n[proofArtifacts.s3]\nbucket = "dogeos-proof-artifacts"\nregion = "us-east-1"\nkeyPrefix = "devnet/instance"\n')
    const objects = new Map<string, Buffer>()
    const aws = {json(args: string[]) {
      const arg = (name: string) => args[args.indexOf(name) + 1]
      if (args[1] === 'get-bucket-policy') return {Policy: '{"Statement":[]}'}
      if (args[1] === 'get-object') {
        const bytes = objects.get(arg('--key'))
        if (!bytes) throw new Error('(NoSuchKey) missing')
        fs.writeFileSync(args.at(-1)!, bytes)
      } else if (args[1] === 'put-object') objects.set(arg('--key'), fs.readFileSync(arg('--body')))
      else expect(args[1]).to.equal('put-bucket-policy')
      return {}
    }}
    const file = path.join(root, '.data/doge-config.toml')
    const before = fs.readFileSync(file, 'utf8')
    let failure = ''
    try {await publishPreparationDeploymentKit(root, undefined, {anonymousRead: async () => Buffer.from('wrong'), aws})} catch (error) {failure = String(error)}
    expect(failure).to.include('Anonymous kit readback differs')
    expect(fs.readFileSync(file, 'utf8')).to.equal(before)
    expect(fs.existsSync(path.join(root, '.scrollsdk/inputs/deployment-kit/published.json'))).to.equal(false)
    const publication = await publishPreparationDeploymentKit(root, undefined, {anonymousRead: async url => objects.get(new URL(url).pathname.split('/').slice(2).join('/'))!, aws})
    expect(readConfig().attestationSigner!.deploymentKit!.url).to.equal(publication.url)
    expect(readConfig().proof_topology?.enforcement).to.equal('enforce')
    expect(JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/inputs/deployment-kit/published.json'), 'utf8')).manifest_sha256).to.equal(publication.manifest_sha256)
    expect(deploymentKitBlockers(root, contractFor(), readConfig())).to.deep.equal([])
  })

  it('waits for the publication record, then records it and passes offline kit readiness', async () => {
    deploymentKitFixture()
    const attempt = async () => {try {await awaitDeploymentKitPublication(root); return ''} catch (error) {return (error as Error).message}}
    expect(await attempt()).to.include('Waiting for the deployment kit')
    const request = JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/inputs/deployment-kit/request.json'), 'utf8'))
    expect(request).to.include({kitDirectory: `deployment-kit-${request.kitVersion}`, schema: 'scrollsdk/deployment-kit-publication-request/v1'})
    const published = path.join(root, '.scrollsdk/inputs/deployment-kit/published.json')
    const before = fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')
    for (const [value, message] of [[{manifest_sha256: 'f'.repeat(64), url: 'https://kits.example.com/k.tgz'}, 'names another kit'], [{manifest_sha256: request.manifestSha256, url: 'http://kits.example.com/k.tgz'}, 'https'], [{manifest_sha256: request.manifestSha256, url: 'https://user:secret@kits.example.com/k.tgz'}, 'credentials']] as const) {
      fs.writeFileSync(published, JSON.stringify(value))
      expect(await attempt()).to.include(message)
      expect(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')).to.equal(before)
    }

    const contract = contractFor()
    expect(deploymentKitBlockers(root, contract, readConfig())[0]).to.include('no published kit is recorded')
    fs.writeFileSync(published, JSON.stringify({manifest_sha256: request.manifestSha256, url: 'https://kits.example.com/k.tgz'}))
    expect(await attempt()).to.equal('')
    const config = readConfig()
    expect(config.attestationSigner!.deploymentKit).to.deep.equal({manifestSha256: request.manifestSha256, path: request.kitDirectory, url: 'https://kits.example.com/k.tgz', version: request.kitVersion})
    expect(readConfig().proof_topology?.enforcement).to.equal('enforce')
    expect(deploymentKitBlockers(root, contract, config)).to.deep.equal([])
    // A rerun records the same kit again.
    expect(await attempt()).to.equal('')
    // Runtime refresh drops the record; unchanged inputs give the same kit, so the saved
    // publication is accepted again. Changed inputs give a new kit and a new request.
    const refreshed = toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8'))
    delete (refreshed.attestationSigner as toml.JsonMap).deploymentKit
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), toml.stringify(refreshed))
    expect(await attempt()).to.equal('')
    expect(readConfig().attestationSigner!.deploymentKit!.version).to.equal(request.kitVersion)
    fs.writeFileSync(path.join(root, 'config.toml'), '[ingress]\nTSO_HOST = "tso-2.example.com"\n')
    expect(await attempt()).to.include('names another kit')
    expect(JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/inputs/deployment-kit/request.json'), 'utf8')).kitVersion).to.not.equal(request.kitVersion)
    fs.writeFileSync(path.join(root, 'config.toml'), '[ingress]\nTSO_HOST = "tso.example.com"\n')
    expect(deploymentKitBlockers(root, {...contract, enforcement: 'observe'}, readConfig())).to.deep.equal([])
  })

  it('reports a tampered, stale or malformed kit record as a readiness blocker', async () => {
    const {options} = deploymentKitFixture()
    const record = writeDeploymentKit(options)
    const contract = contractFor()
    recordDeploymentKitPublication(root, path.join(root, '.data/doge-config.toml'), record, 'https://kits.example.com/k.tgz')
    expect(deploymentKitBlockers(root, contract, readConfig())).to.deep.equal([])
    const kitEnv = path.join(record.kitDir, 'deployment-kit.env')
    const env = fs.readFileSync(kitEnv)
    fs.appendFileSync(kitEnv, '# edited\n')
    expect(deploymentKitBlockers(root, contract, readConfig())[0]).to.include('differs from the deployment inputs')
    fs.writeFileSync(kitEnv, env)
    fs.writeFileSync(path.join(root, 'config.toml'), '[ingress]\nTSO_HOST = "tso-2.example.com"\n')
    expect(deploymentKitBlockers(root, contract, readConfig())[0]).to.include('is not the kit for the current inputs')
    fs.writeFileSync(path.join(root, 'config.toml'), '[ingress]\nTSO_HOST = "tso.example.com"\n')
    const config = readConfig()
    for (const change of [{url: 'http://kits.example.com/k.tgz'}, {url: ''}, {manifestSha256: 'f'.repeat(64)}, {version: 'k-000000000000'}, {path: '../elsewhere'}]) {
      expect(deploymentKitBlockers(root, contract, {...config, attestationSigner: {...config.attestationSigner!, deploymentKit: {...config.attestationSigner!.deploymentKit!, ...change}}})).to.have.length(1)
    }

    expect(() => recordDeploymentKitPublication(root, path.join(root, '.data/doge-config.toml'), writeDeploymentKit({...options, output: 'custom-kit'}), 'https://kits.example.com/k.tgz')).to.throw('canonical')
  })

  it('lets proof-config publish complete with only the kit pending, never other evidence', () => {
    deploymentKitFixture()
    const blockers = ['Program-publication receipt is not bound to the deployment contract', ...deploymentKitBlockers(root, contractFor(), readConfig()), 'Production Worker image and Worker contract are required']
    expect(blockers[1]).to.include('Deployment kit:')
    expect(withoutPendingDeploymentKit(blockers)).to.deep.equal([blockers[0], blockers[2]])
  })

  it('export-deployment-kit --published-url records only the canonical kit from the deployment inputs', async () => {
    deploymentKitFixture()
    const cwd = process.cwd()
    const log = sinon.stub(console, 'log')
    const error = sinon.stub(console, 'error')
    process.chdir(root)
    try {
      for (const extra of [['--out', 'elsewhere'], ['--tso-url', 'https://tso-2.example.com'], ['--signer-proof-artifact-base-url', 'https://proofs.example.com/x']]) {
        expect(await exportKit(['--published-url', 'https://kits.example.com/k.tgz', ...extra])).to.include('canonical kit')
      }

      expect(fs.readdirSync(root).filter(name => name.startsWith('deployment-kit-') || name === 'elsewhere')).to.deep.equal([])
      expect(await exportKit(['--published-url', 'https://kits.example.com/k.tgz'])).to.equal('')
    } finally {
      process.chdir(cwd)
      log.restore(); error.restore()
    }

    expect(deploymentKitBlockers(root, contractFor(), readConfig())).to.deep.equal([])
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
