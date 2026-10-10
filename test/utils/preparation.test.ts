/* eslint-disable @typescript-eslint/no-explicit-any -- Workflow and RPC integration fixtures. */
import * as toml from '@iarna/toml'
import {Transaction} from 'bitcoinjs-lib'
import bitcore from 'bitcore-lib-doge'
import {expect} from 'chai'
import {Wallet} from 'ethers'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'
import type {Rpc} from '../../src/utils/preparation-funding.js'

import {generateSetupDefaultsToml} from '../../src/utils/deployment-spec-generator.js'
import {BRIDGE_FUNDING_MARKER, inspectFunding, prepareEthereumAnchor, publicKeyAddress, verifyDogecoinNetwork} from '../../src/utils/preparation-funding.js'
import {AwaitingInput, loadPreparationEnv} from '../../src/utils/preparation-io.js'
import {applyPreparation, createPreparationPlan, preparationSteps, validatePreparation} from '../../src/utils/preparation-plan.js'
import {resolvePreparationProofRelease} from '../../src/utils/preparation-release.js'
import {CommandPreparationRunner} from '../../src/utils/preparation-runner.js'
import {buildProofAwsConfig, writeProofAwsConfig} from '../../src/utils/proof-aws-config.js'
import {PROOF_RELEASE_IMAGE_NAMES} from '../../src/utils/proof-software-release.js'

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
function fixture(): DeploymentSpec {
  const spec = yaml.load(fs.readFileSync(path.join(cli, 'src/config/deployment-spec.minimal.yaml'), 'utf8').replaceAll('$ENV:OWNER_ADDRESS', Wallet.createRandom().address).replaceAll(/\$ENV:[A-Z_a-z]\w*/g, 'NONFUNCTIONAL_TEST_PLACEHOLDER')) as DeploymentSpec
  spec.infrastructure = {bootnodeCount: 1, provider: 'local', sequencerCount: 1}
  spec.contracts.feeVaultDogeRecipientAddress = new bitcore.PrivateKey(null, bitcore.Networks.testnet).toAddress().toString()
  spec.bridge.confirmationsRequired = 2
  spec.images = {services: Object.fromEntries(['l2Rpc', 'l2Sequencer', 'l2Bootnode'].map(key => [key, {tag: 'explicit-test-release'}]))}
  spec.identities = {bootnodes: [{index: 0, nodekey: {action: 'create'}}], ethDaSubmitter: {action: 'create', backend: 'local'}, feeOracle: {action: 'create', backend: 'local'}, sequencers: [{index: 0, nodekey: {action: 'create'}, signer: {action: 'create', backend: 'local'}}]}
  spec.proofTopology = {active: {artifactStore: {kind: 'local_fs'}, profile: 'withdrawal_mock_prover', realScroll: {} as any, workerLaunch: 'local_cpu'}, compiler: {identityFilePath: '.data/compiler.json', image: {digest: `sha256:${'a'.repeat(64)}`, repository: 'example.invalid/compiler'}}, deployment: {proverPublicUrl: 'https://proof.example.invalid'}, enforcement: 'observe', generation: 'mock', mode: 'disabled', observeRealProofDeadlineMs: 1000}
  spec.preparation = {bridge: {image: `dogeos69/bridge-genesis-tools@sha256:${'b'.repeat(64)}`, mode: 'helper'}, proofMaterials: {mode: 'existing'}}
  spec.attestationSigners = Array.from({length: 3}, (_, index) => ({attestationPubkey: new bitcore.PrivateKey().toPublicKey().toString(), name: `partner-${index}`, transportPubkey: new bitcore.PrivateKey().toPublicKey().toString()}))
  spec.bridge.initialAttestationKeyset = {signerIds: spec.attestationSigners.map(signer => signer.name), threshold: 2}
  return spec
}

async function rejected(run: () => Promise<unknown> | unknown, message: string): Promise<void> {
  let error: unknown
  try {await run()} catch (error_) {error = error_}
  expect(error, 'operation must reject').to.be.instanceOf(Error)
  expect((error as Error).message).to.include(message)
}

describe('resumable preparation plan', () => {
  let root: string
  let sdk: string
  let deployment: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'preparation-test-'))
    sdk = path.join(root, 'sdk'); deployment = path.join(root, 'deployment')
    for (const file of ['withdrawal-processor/WithdrawalProcessor.toml', 'proof-coordinator/ProofCoordinator.toml', 'values/scroll-monitor-production.yaml', 'values/metrics-exporter-production.yaml']) {
      const target = path.join(sdk, 'examples', file); fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, '# fixture\n')
    }

    fs.writeFileSync(path.join(sdk, 'examples/Makefile.example'), ['install-l2-reth-sequencer:', '\t@true', 'delete-l2-reth-sequencer:', '\t@true', 'install-l2-reth-bootnode:', '\t@true', 'delete-l2-reth-bootnode:', '\t@true'].join('\n'))
    const git = (...args: string[]) => execFileSync('git', ['-C', sdk, ...args], {stdio: 'pipe'}).toString().trim()
    git('init'); git('add', 'examples'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture')
    const spec = fixture(); spec.templates = {sdkRevision: git('rev-parse', 'HEAD')}
    fs.writeFileSync(path.join(root, 'intent.yaml'), yaml.dump(spec))
  })
  afterEach(() => {fs.rmSync(root, {force: true, recursive: true})})
  const makePlan = () => createPreparationPlan({output: deployment, sdkDirectory: sdk, spec: path.join(root, 'intent.yaml')})

  it('refreshes only the runtime tail, archives previous evidence and preserves pinned deployment artifacts', async () => {
    await makePlan()
    const calls: string[] = []
    const runner = {async run(step: {id: string}) {
      calls.push(step.id)
      if (step.id === 'bootstrap') {
        fs.mkdirSync(path.join(deployment, '.data'), {recursive: true})
        fs.writeFileSync(path.join(deployment, '.data/doge-config.toml'), 'network = "testnet"\n')
        fs.writeFileSync(path.join(deployment, '.data/genesis.json'), '{"pinned":true}')
        fs.writeFileSync(path.join(deployment, '.data/proof-program-publication-v1.json'), '{"testEvidence":true}')
        fs.mkdirSync(path.join(deployment, 'signer-policy-bundle'))
        fs.writeFileSync(path.join(deployment, 'signer-policy-bundle/signer-policy.json'), '{"oldVersion":true}')
      }
    }}
    await applyPreparation(deployment, runner)
    const intent = fs.readFileSync(path.join(deployment, '.scrollsdk/intent.json'))
    calls.length = 0
    await applyPreparation(deployment, runner, undefined, {refreshRuntime: true})
    expect(calls[0]).to.equal('charts')
    expect(calls).not.to.include('identities')
    expect(calls).not.to.include('genesis')
    expect(calls).not.to.include('helper-setup')
    expect(fs.readFileSync(path.join(deployment, '.scrollsdk/intent.json')).equals(intent)).to.equal(true)
    expect(fs.readFileSync(path.join(deployment, '.data/genesis.json'), 'utf8')).to.equal('{"pinned":true}')
    expect(fs.existsSync(path.join(deployment, '.data/proof-program-publication-v1.json'))).to.equal(false)
    const history = path.join(deployment, '.scrollsdk/runtime-refresh')
    const saved = path.join(history, fs.readdirSync(history)[0], 'proof-program-publication-v1.json')
    expect(fs.readFileSync(saved, 'utf8')).to.equal('{"testEvidence":true}')
    expect(fs.existsSync(path.join(deployment, 'signer-policy-bundle'))).to.equal(false)
    expect(fs.readFileSync(path.join(path.dirname(saved), 'signer-policy-bundle/signer-policy.json'), 'utf8')).to.equal('{"oldVersion":true}')
    fs.appendFileSync(path.join(deployment, '.data/genesis.json'), ' ')
    await rejected(() => applyPreparation(deployment, runner, undefined, {refreshRuntime: true}), 'outside the workflow')
  })

  it('refuses runtime refresh before immutable preparation has completed', async () => {
    await makePlan()
    await rejected(() => applyPreparation(deployment, {async run() {throw new Error('must not run')}}, undefined, {refreshRuntime: true}), 'completed preparation')
    await rejected(() => applyPreparation(deployment, {async run() {}}, undefined, {dogecoinRoutingSpec: 'unused.yaml'}), '--refresh-runtime')
  })

  it('imports only validated runtime routing and preserves all unrelated generated configuration', async () => {
    await makePlan()
    const runner = {async run(step: {id: string}) {
      if (step.id === 'bootstrap') {
        fs.mkdirSync(path.join(deployment, '.data'), {recursive: true})
        fs.writeFileSync(path.join(deployment, '.data/doge-config.toml'), 'deployment_name = "pinned-name"\n[kubernetes]\nserviceName = "old-node"\n[attestationSigner.policyValidation]\nstale = true\n')
      }
    }}
    await applyPreparation(deployment, runner)
    const document = JSON.parse(fs.readFileSync(path.join(deployment, '.scrollsdk/intent.json'), 'utf8'))
    document.dogecoin.kubernetes = {p2pPort: 32_003, rpcPort: 32_002, serviceName: 'shadowfork-test'}
    document.metadata.name = 'not-imported'
    const routing = path.join(root, 'routing.yaml')
    fs.writeFileSync(routing, yaml.dump(document))
    const oldUser = process.env.DOGECOIN_CLUSTER_RPC_USERNAME; const oldPassword = process.env.DOGECOIN_CLUSTER_RPC_PASSWORD
    process.env.DOGECOIN_CLUSTER_RPC_USERNAME = 'NONFUNCTIONAL_TEST_USER'
    process.env.DOGECOIN_CLUSTER_RPC_PASSWORD = 'NONFUNCTIONAL_TEST_PASSWORD'
    try {
      await applyPreparation(deployment, runner, undefined, {dogecoinRoutingSpec: routing, refreshRuntime: true})
      const configFile = path.join(deployment, '.data/doge-config.toml')
      const config = toml.parse(fs.readFileSync(configFile, 'utf8')) as any
      expect(config.kubernetes).to.deep.equal(document.dogecoin.kubernetes)
      expect(config.deployment_name).to.equal('pinned-name')
      expect(config.dogecoinClusterRpc.username).to.equal('NONFUNCTIONAL_TEST_USER')
      expect(config.attestationSigner).not.to.have.property('policyValidation')
      const before = fs.readFileSync(configFile)
      document.dogecoin.network = 'unsupported-chain'; fs.writeFileSync(routing, yaml.dump(document))
      await rejected(() => applyPreparation(deployment, runner, undefined, {dogecoinRoutingSpec: routing, refreshRuntime: true}), 'planned Dogecoin network')
      expect(fs.readFileSync(configFile).equals(before)).to.equal(true)
    } finally {
      if (oldUser === undefined) delete process.env.DOGECOIN_CLUSTER_RPC_USERNAME; else process.env.DOGECOIN_CLUSTER_RPC_USERNAME = oldUser
      if (oldPassword === undefined) delete process.env.DOGECOIN_CLUSTER_RPC_PASSWORD; else process.env.DOGECOIN_CLUSTER_RPC_PASSWORD = oldPassword
    }
  })

  it('plans without execution, waits for input, resumes and skips every completed step', async () => {
    fs.mkdirSync(deployment, {mode: 0o755})
    const plan = await makePlan()
    expect(fs.statSync(deployment).mode.toString(8).slice(-3)).to.equal('700')
    expect(fs.existsSync(path.join(deployment, 'config.toml'))).to.equal(false)
    expect(fs.readFileSync(path.join(deployment, '.gitignore'), 'utf8')).to.include('/withdrawal-processor/\n')
    expect(fs.statSync(path.join(deployment, '.scrollsdk/intent.json')).mode.toString(8).slice(-3)).to.equal('600')
    const calls: string[] = []; let ready = false
    const runner = {async run(step: any) {calls.push(step.id); if (step.id === 'helper-funding' && !ready) throw new AwaitingInput({message: 'fund helper'}); fs.mkdirSync(path.join(deployment, 'values'), {recursive: true}); fs.writeFileSync(path.join(deployment, 'values/state.yaml'), step.id)}}
    expect((await applyPreparation(deployment, runner)).status).to.equal('waiting')
    expect(calls).not.to.include('helper-setup')
    ready = true
    expect((await applyPreparation(deployment, runner)).status).to.equal('prepared')
    expect(calls.filter(id => id === 'identities')).to.have.length(1)
    expect(calls.filter(id => id === 'helper-funding')).to.have.length(2)
    const count = calls.length
    expect((await applyPreparation(deployment, runner)).status).to.equal('prepared')
    expect(calls).to.have.length(count)
    expect((await makePlan()).id).to.equal(plan.id)
  })

  it('locks SDK HEAD when omitted and keeps using it after checkout HEAD changes', async () => {
    const file = path.join(root, 'intent.yaml')
    const spec = yaml.load(fs.readFileSync(file, 'utf8')) as DeploymentSpec
    const revision = spec.templates!.sdkRevision
    // This case verifies the unmodified committed template, without overlays.
    delete spec.monitoring
    delete spec.templates
    fs.writeFileSync(file, yaml.dump(spec))
    const plan = await makePlan()
    const frozen = JSON.parse(fs.readFileSync(path.join(deployment, '.scrollsdk/intent.json'), 'utf8'))
    expect(frozen.templates.sdkRevision).to.equal(revision)
    fs.writeFileSync(path.join(sdk, 'examples/values/scroll-monitor-production.yaml'), '# changed commit\n')
    execFileSync('git', ['-C', sdk, 'add', 'examples'], {stdio: 'pipe'})
    execFileSync('git', ['-C', sdk, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Changed'], {stdio: 'pipe'})
    const runner = new CommandPreparationRunner()
    await runner.run(plan.steps[0], frozen, deployment, plan)
    expect(JSON.parse(fs.readFileSync(path.join(deployment, '.data/spec-bootstrap.json'), 'utf8')).sdkRevision).to.equal(revision)
    expect(fs.readFileSync(path.join(deployment, 'values/scroll-monitor-production.yaml'), 'utf8')).to.equal('# fixture\n')
    spec.templates = {sdkRevision: revision}
    fs.writeFileSync(file, yaml.dump(spec))
    expect((await makePlan()).id).to.equal(plan.id)
  })

  it('retains a private environment file reference and reloads it on resume without shell evaluation', async () => {
    const name = 'PREPARATION_TEST_PRIVATE_VALUE'
    const file = path.join(root, 'environment')
    fs.writeFileSync(file, `${name}='$(touch NEVER_EXECUTE)'\n`)
    try {
      const plan = await createPreparationPlan({envFile: file, output: deployment, sdkDirectory: sdk, spec: path.join(root, 'intent.yaml')})
      expect(plan.envFile).to.equal(file)
      expect(process.env[name]).to.equal('$(touch NEVER_EXECUTE)')
      delete process.env[name]
      await applyPreparation(deployment, {async run() {expect(process.env[name]).to.equal('$(touch NEVER_EXECUTE)')}})
      process.env[name] = 'existing process value'
      loadPreparationEnv(file)
      expect(process.env[name]).to.equal('existing process value')
      expect(fs.existsSync(path.join(deployment, 'NEVER_EXECUTE'))).to.equal(false)
    } finally {delete process.env[name]}
  })

  it('requires explicit dstack credentials and an actionable PostgreSQL database plan', async () => {
    const spec = fixture()
    spec.dstackController = {enabled: true}
    expect(() => validatePreparation(spec)).to.throw('explicit import or external')
    spec.preparation!.dstack = {mode: 'external'}
    expect(() => validatePreparation(spec)).to.throw('initializeDatabase or databaseUrlEnv')
    spec.preparation!.dstack.databaseUrlEnv = 'PREPARATION_TEST_DATABASE_URL'
    expect(() => validatePreparation(spec)).not.to.throw()
    const plan = await makePlan()
    fs.writeFileSync(path.join(deployment, 'config.toml'), '[db]\n')
    const runner = new CommandPreparationRunner(async () => {throw new Error('Must not invoke a credential importer')})
    try {
      process.env.PREPARATION_TEST_DATABASE_URL = 'postgresql+asyncpg://NONFUNCTIONAL_TEST_USER:NONFUNCTIONAL_TEST_PASSWORD@database.invalid/dstack?ssl=require'
      await runner.run({effect: 'local', id: 'dstack', retry: 'safe', title: 'dstack'}, spec, deployment, plan)
      expect((toml.parse(fs.readFileSync(path.join(deployment, 'config.toml'), 'utf8')) as any).db.DSTACK_DB_CONNECTION_STRING).to.equal('$ENV:PREPARATION_TEST_DATABASE_URL')
    } finally {delete process.env.PREPARATION_TEST_DATABASE_URL}
  })

  it('waits for a Vast.ai environment key and passes only its name to the importer', async () => {
    const spec = fixture()
    spec.dstackController = {database: {type: 'sqlite'}, enabled: true}
    spec.preparation!.dstack = {mode: 'import', providers: ['vastai'], vastaiApiKeyEnv: 'PREPARATION_TEST_VASTAI_KEY'}
    validatePreparation(spec)
    const plan = await makePlan()
    const calls: string[][] = []
    const runner = new CommandPreparationRunner(async (_root, _step, args) => {calls.push(args)})
    const step = {effect: 'local', id: 'dstack', retry: 'safe', title: 'dstack'} as const
    try {
      delete process.env.PREPARATION_TEST_VASTAI_KEY
      await rejected(() => runner.run(step, spec, deployment, plan), 'Set PREPARATION_TEST_VASTAI_KEY')
      expect(calls).to.have.length(0)
      process.env.PREPARATION_TEST_VASTAI_KEY = 'NONFUNCTIONAL_VASTAI_TEST_KEY'
      await runner.run(step, spec, deployment, plan)
      expect(calls[0]).to.include.members(['--vastai-api-key-env', 'PREPARATION_TEST_VASTAI_KEY'])
      expect(calls[0].join(' ')).not.to.include(process.env.PREPARATION_TEST_VASTAI_KEY)
      spec.preparation!.dstack.vastaiApiKeyFile = 'input-key'
      expect(() => validatePreparation(spec)).to.throw('not both')
    } finally {delete process.env.PREPARATION_TEST_VASTAI_KEY}
  })

  it('derives real images from one pinned release and plans generation after protocol context', async () => {
    const spec = yaml.load(fs.readFileSync(path.join(root, 'intent.yaml'), 'utf8')) as DeploymentSpec
    spec.proofTopology!.generation = 'real'
    spec.proofTopology!.enforcement = 'enforce'
    spec.proofTopology!.mode = 'active'
    spec.proofCoordinator = {enabled: true, s3AuthMode: 'ambient'}
    spec.proofArtifacts = {s3: {bucket: 'test-proof-artifacts', keyPrefix: 'proof', region: 'us-west-2'}}
    spec.proofTopology!.active!.artifactStore = {kind: 's3_compatible'}
    delete (spec.proofTopology as any).compiler
    const release = {images: Object.fromEntries(PROOF_RELEASE_IMAGE_NAMES.map(name => [name, `example.invalid/${name}@sha256:${'b'.repeat(64)}`])), revision: 'a'.repeat(40), schema: 'dogeos/proof-release/v1'}
    const file = path.join(root, 'proof-release.json')
    const text = JSON.stringify(release)
    fs.writeFileSync(file, text)
    spec.preparation!.proofRelease = {manifest: '../proof-release.json', sha256: createHash('sha256').update(text).digest('hex')}
    spec.preparation!.proofMaterials = {mode: 'real'}
    spec.preparation!.proofPublication = {}
    fs.writeFileSync(path.join(root, 'intent.yaml'), yaml.dump(spec))
    const plan = await makePlan()
    const expanded = JSON.parse(fs.readFileSync(path.join(deployment, '.scrollsdk/intent.json'), 'utf8')) as DeploymentSpec
    expect(expanded.proofTopology!.compiler.image.repository).to.equal('example.invalid/dogeos-proof-topology')
    expect(expanded.proofTopology!.deployment.productionWorkerImage!.repository).to.equal('example.invalid/prover-worker-cuda')
    const ids = plan.steps.map(step => step.id)
    expect(ids.indexOf('proof-release-bake')).to.be.greaterThan(ids.indexOf('protocol-context'))
    expect(ids.indexOf('proof-worker-check')).to.be.lessThan(ids.indexOf('proof-materials'))
    const calls: string[][] = []
    const exports: any[] = []
    const runner = new CommandPreparationRunner(async (_root, _step, args) => {calls.push(args)}, options => {exports.push(options); return {batchMaterializer: 'batch', chunkMaterializer: 'chunk'}})
    for (const id of ['proof-release-bake', 'proof-materializer-export', 'proof-worker-check']) await runner.run(plan.steps.find(step => step.id === id)!, expanded, deployment, plan)
    expect(calls[0]).to.include.members(['prepare-real', '.data/protocol_context.json', file])
    expect(exports[0].image).to.equal(release.images['proof-coordinator'])
    expect(calls[1]).to.include(release.images['prover-worker-cuda'])
    expect(calls[1]).to.include('.data/proof-release-preparation/proof-release-preparation-v1.json')
    const conflict = structuredClone(expanded)
    conflict.proofTopology!.deployment.productionWorkerImage!.repository = 'different.invalid/worker'
    await rejected(() => resolvePreparationProofRelease(conflict, deployment), 'conflicts')
    fs.appendFileSync(file, ' ')
    await rejected(() => resolvePreparationProofRelease(spec, deployment), 'digest mismatch')
  })

  it('never automatically replays a failed broadcast', async () => {
    await makePlan(); let broadcasts = 0
    const runner = {async run(step: any) {if (step.id === 'helper-setup') {broadcasts++; throw new Error('connection lost after sending')}}}
    expect((await applyPreparation(deployment, runner)).status).to.equal('recovery-required')
    expect((await applyPreparation(deployment, runner)).status).to.equal('recovery-required')
    expect(broadcasts).to.equal(1)
  })

  it('rejects changed plan input and changed completed artifacts', async () => {
    await makePlan()
    await applyPreparation(deployment, {async run() {fs.writeFileSync(path.join(deployment, 'config.toml'), 'network = "testnet"')}})
    fs.writeFileSync(path.join(deployment, 'config.toml'), 'network = "mainnet"')
    await rejected(() => applyPreparation(deployment, {async run() {throw new Error('must not execute')}}), 'changed outside')
    fs.appendFileSync(path.join(deployment, '.scrollsdk/intent.json'), ' ')
    await rejected(() => applyPreparation(deployment, {async run() {}}), 'frozen intent changed')
  })

  it('rejects incomplete cloud destinations before any resources are created', () => {
    const spec = fixture()
    spec.preparation!.secretUpload = {provider: 'aws'}
    expect(() => validatePreparation(spec)).to.throw('explicit region')
    spec.preparation!.secretUpload.awsRegion = 'us-west-2'
    expect(() => validatePreparation(spec)).not.to.throw()
    spec.preparation!.proofMaterials = {mockWorkerImage: 'example.invalid/mock:test', mode: 'mock'}
    expect(() => validatePreparation(spec)).to.throw('S3 proof artifact store')
    spec.proofArtifacts = {s3: {bucket: 'test-proof-bucket', endpointUrl: 'https://s3.example.invalid', keyPrefix: 'proof', region: 'us-west-2'}}
    spec.proofTopology!.active!.artifactStore = {kind: 's3_compatible'}
    expect(() => validatePreparation(spec)).not.to.throw()
  })

  it('selects explicit proof AWS effects and retains publication during evidence regeneration', async () => {
    const spec = fixture()
    spec.infrastructure.aws = {accountId: '123456789012', eksClusterName: 'test-cluster', region: 'us-west-2'}
    spec.preparation!.proofAws = {action: 'create', publicReadMode: 'direct-s3'}
    validatePreparation(spec)
    expect(preparationSteps(spec).find(step => step.id === 'proof-aws')!.effect).to.equal('cloud')
    const plan = await makePlan()
    const calls: string[][] = []
    const runner = new CommandPreparationRunner(async (_root, _step, args) => {calls.push(args)})
    await runner.run(preparationSteps(spec).find(step => step.id === 'proof-aws')!, spec, deployment, plan)
    expect(calls[0]).to.include.members(['proof-aws-init', '--yes', '--artifact-public-read-mode', 'direct-s3'])
    spec.preparation!.proofAws.action = 'reuse'
    expect(() => validatePreparation(spec)).to.throw('existing-public-s3')
    spec.preparation!.proofAws.publicReadMode = 'existing-public-s3'
    validatePreparation(spec)
    expect(preparationSteps(spec).find(step => step.id === 'proof-aws')!.effect).to.equal('read')
    spec.preparation!.inputs = [{destination: '.data/proof-aws.json', source: '../proof-aws.json'}]
    expect(() => validatePreparation(spec)).to.throw('generates its own receipt')
    delete spec.preparation!.inputs
    spec.proofTopology!.enforcement = 'enforce'
    spec.preparation!.proofPublication = {}
    const steps = preparationSteps(spec)
    expect(steps.map(step => step.id).slice(-4)).to.deep.equal(['signer-policy', 'signer-receipts', 'charts-validated', 'proof-check'])
    fs.mkdirSync(path.join(deployment, '.data'), {recursive: true})
    fs.writeFileSync(path.join(deployment, '.data/proof-materials-v1.json'), '{}')
    await runner.run(steps.find(step => step.id === 'charts-validated')!, spec, deployment, plan)
    expect(calls[1]).to.include.members(['prep-charts', '--proof-materials-receipt', '.data/proof-materials-v1.json', '--proof-publication-receipt', '.data/proof-program-publication-v1.json'])
  })

  it('resolves proof storage before DA permissions and applies only explicit public-read intent', async () => {
    const spec = fixture()
    spec.preparation!.proofAws = {action: 'create', publicReadMode: 'direct-s3'}
    spec.preparation!.archive = {action: 'create', publicRead: true}
    const ids = preparationSteps(spec).map(step => step.id)
    expect(ids.indexOf('proof-aws')).to.be.lessThan(ids.indexOf('archive'))
    expect(ids.indexOf('archive')).to.be.lessThan(ids.indexOf('charts'))
    expect(ids.indexOf('archive')).to.be.lessThan(ids.indexOf('archive-access'))
    const calls: string[][] = []
    const runner = new CommandPreparationRunner(async (_root, _step, args) => {calls.push(args)})
    const plan = await makePlan()
    await runner.run(preparationSteps(spec).find(step => step.id === 'archive-access')!, spec, deployment, plan)
    expect(calls[0]).to.include.members(['artifact-access', '--public-read', '--allow-bucket-public-policy', '--apply'])
    spec.preparation!.archive.publicRead = false
    await runner.run(preparationSteps(spec).find(step => step.id === 'archive-access')!, spec, deployment, plan)
    expect(calls[1]).to.include('--no-public-read').and.not.to.include('--allow-bucket-public-policy')
    delete spec.preparation!.archive.publicRead
    expect(preparationSteps(spec).some(step => step.id === 'archive-access')).to.equal(false)
  })

  it('binds provisioned proof delivery before chart generation without hiding explicit drift', async () => {
    const spec = fixture()
    const plan = await makePlan()
    const configFile = path.join(deployment, '.data/doge-config.toml')
    const aws = buildProofAwsConfig({
      coordinatorServiceAccount: 'proof-coordinator',
      identity: {artifactRegion: 'us-east-1', awsRegion: 'us-east-1', deploymentAlias: 'test', eksCluster: 'test', namespace: 'default'},
      keyPrefix: 'proofs',
      provisioned: {
        artifactReadTransport: {publicEndpointUrl: 'https://objects.example.invalid', publicReadMode: 'existing-gateway', publicStatus: 'operator-managed-unverified'},
        bucket: 'test-proof-artifacts', bucketCreated: false,
        coordinatorRoleArn: 'arn:aws:iam::123456789012:role/proof-coordinator', secretAction: 'reused', secretName: 'test-proof-token',
        withdrawalRoleArn: 'arn:aws:iam::123456789012:role/withdrawal-processor',
      },
      withdrawalServiceAccount: 'withdrawal-processor',
    })
    writeProofAwsConfig(path.join(deployment, '.data/proof-aws.json'), aws)
    const config: any = {bootnodeReth: {instances: [{index: 0}]}, preserved: 'operator-setting', proof_topology: {active: {artifactStore: {bucket: aws.artifactStore.bucket, kind: 's3_compatible', region: aws.artifactStore.region}}, deployment: {artifactKeyPrefix: aws.artifactStore.keyPrefix}}}
    fs.writeFileSync(configFile, toml.stringify(config))
    let calls = 0
    const runner = new CommandPreparationRunner(async () => {
      const prepared: any = toml.parse(fs.readFileSync(configFile, 'utf8'))
      expect(prepared.proof_topology.deployment.publicS3EndpointUrl).to.equal(aws.artifactReadTransport.publicEndpointUrl)
      expect(prepared.preserved).to.equal('operator-setting')
      calls++
    })
    const charts = preparationSteps(spec).find(step => step.id === 'charts')!
    await runner.run(charts, spec, deployment, plan)
    await runner.run(charts, spec, deployment, plan)
    expect(calls).to.equal(2)
    config.proof_topology.deployment.publicS3EndpointUrl = 'https://wrong.example.invalid'
    fs.writeFileSync(configFile, toml.stringify(config))
    await rejected(() => runner.run(charts, spec, deployment, plan), 'publicS3EndpointUrl does not match')
    delete config.proof_topology.deployment.publicS3EndpointUrl
    config.proof_topology.active.artifactStore.bucket = 'wrong-bucket'
    const before = toml.stringify(config)
    fs.writeFileSync(configFile, before)
    await rejected(() => runner.run(charts, spec, deployment, plan), 'artifact bucket')
    expect(fs.readFileSync(configFile, 'utf8')).to.equal(before)
    expect(calls).to.equal(2)
  })

  it('restores missing bootnodes before charts without repeating other identity preparation', async () => {
    const spec = fixture()
    spec.identities!.bootnodes!.push({index: 1, nodekey: {action: 'create'}})
    const plan = await makePlan()
    const file = path.join(deployment, '.data/doge-config.toml')
    fs.mkdirSync(path.dirname(file), {recursive: true})
    const existing = {index: 1, nodekey: {privateKey: 'NONFUNCTIONAL_TEST_KEY'}}
    fs.writeFileSync(file, toml.stringify({bootnodeReth: {instances: [existing]}}))
    const calls: string[][] = []
    const runner = new CommandPreparationRunner(async (_root, _step, args) => {
      calls.push(args)
      if (args[0] === 'gen-keystore') {
        expect(args).to.include.members(['--service', 'bootnode-reth', '--no-accounts'])
        fs.writeFileSync(file, toml.stringify({bootnodeReth: {instances: [{index: 0}, existing]}}))
      }
    })
    const charts = preparationSteps(spec).find(step => step.id === 'charts')!
    await runner.run(charts, spec, deployment, plan)
    await runner.run(charts, spec, deployment, plan)
    expect(calls.map(args => args[0])).to.deep.equal(['gen-keystore', 'prep-charts', 'prep-charts'])
  })

  it('rejects external inputs that replace the canonical protocol context', () => {
    const spec = fixture()
    spec.preparation!.inputs = [{destination: '.data/protocol_context.json', source: '/private/unrelated-context.json'}]
    expect(() => validatePreparation(spec)).to.throw('may not overwrite managed')
  })

  it('excludes concurrent apply and releases the lock while waiting', async () => {
    await makePlan()
    let release!: () => void
    const barrier = new Promise<void>(resolve => {release = resolve})
    const running = applyPreparation(deployment, {async run() {await barrier; throw new AwaitingInput({message: 'waiting'})}})
    await rejected(() => applyPreparation(deployment, {async run() {}}), 'Another apply owns')
    release(); expect((await running).status).to.equal('waiting')
    expect(fs.existsSync(path.join(deployment, '.scrollsdk/apply.lock'))).to.equal(false)
  })

  it('runs actual bootstrap and identity commands with signer public keys from the frozen spec', async () => {
    await makePlan()
    const actual = new CommandPreparationRunner()
    const runner = {async run(step: any, spec: DeploymentSpec, output: string, plan: any) {
      if (step.id === 'genesis') throw new AwaitingInput({message: 'Stop before container execution'})
      await actual.run(step, spec, output, plan)
    }}
    const first = await applyPreparation(deployment, runner)
    expect(first.status).to.equal('waiting')
    expect(first.currentStep).to.equal('genesis')
    const doge = fs.readFileSync(path.join(deployment, '.data/doge-config.toml'), 'utf8')
    expect((toml.parse(doge) as any).sequencerReth.instances).to.have.length(1)
    const frozen = JSON.parse(fs.readFileSync(path.join(deployment, '.scrollsdk/intent.json'), 'utf8'))
    const publicKeys = frozen.attestationSigners.map((signer: any) => signer.attestationPubkey)
    expect((toml.parse(doge) as any).attestationSigner.external.map((signer: any) => signer.publicKey)).to.deep.equal(publicKeys)
    expect(toml.parse(fs.readFileSync(path.join(deployment, '.data/setup_defaults.toml'), 'utf8')).attestation_pubkeys).to.deep.equal(publicKeys)
    expect(fs.existsSync(path.join(deployment, 'descriptors'))).to.equal(false)
    const second = await applyPreparation(deployment, runner)
    expect(second.status).to.equal('waiting')
    expect(fs.readFileSync(path.join(deployment, '.data/doge-config.toml'), 'utf8')).to.equal(doge)
  })

  it('refuses helper broadcast stages in the production command', async () => {
    for (const step of ['all', '2-setup', '4-fund']) {
      let stderr = ''
      try {execFileSync(process.execPath, [path.join(cli, 'bin/run.js'), 'setup', 'bridge-init', '--production', '--step', step, '-N'], {cwd: root, stdio: 'pipe'})} catch (error) {stderr = String((error as any).stderr)}
      expect(stderr).to.include('Production mode permits only artifact stages')
    }
  })

  it('production uses independent keys and no helper broadcasting steps', () => {
    const spec = fixture(); const p = spec.preparation!.bridge
    p.mode = 'production'
    const key = () => new bitcore.PrivateKey(null, bitcore.Networks.testnet).toPublicKey().toString()
    spec.bridge.teePubkey = key(); spec.bridge.timelock = 999_999
    p.production = {ethereumAnchor: {blockNumber: 100, transactionIndex: 0}, recoveryPublicKeys: [key(), key()], sequencerKeyEnv: 'PROD_SEQUENCER_KEY', sequencerPublicKey: key()}
    delete spec.bridge.seedString
    validatePreparation(spec)
    const setup = toml.parse(generateSetupDefaultsToml(spec))
    expect(setup).not.to.have.property('seed_string')
    expect(setup).not.to.have.property('base_funding_utxos')
    expect(preparationSteps(spec).some(step => step.effect === 'chain' || step.id.startsWith('helper'))).to.equal(false)
    expect(preparationSteps(spec).map(step => step.id)).to.include.members(['production-wallets', 'bridge-info', 'production-funding', 'protocol-context'])
    p.production.sequencerKeyEnv = 'inline secret is not accepted'
    expect(() => validatePreparation(spec)).to.throw('environment variables')
  })
})

describe('production funding validation', () => {
  function fixtureTx(marker = false) {
    const key = new bitcore.PrivateKey(null, bitcore.Networks.testnet)
    const address = publicKeyAddress(key.toPublicKey().toString(), 'testnet')
    const tx = new Transaction(); tx.addInput(Buffer.alloc(32), 0)
    const script = bitcore.Script.fromAddress(address).toHex()
    tx.addOutput(Buffer.from(script, 'hex'), 42_069_000n)
    if (marker) tx.addOutput(Buffer.from(BRIDGE_FUNDING_MARKER, 'hex'), 0n)
    const hash = 'c'.repeat(64)
    const rpc: Rpc = async method => ({getblockhash: hash, getblockheader: {confirmations: 6, height: 100}, getrawtransaction: {blockhash: hash, hex: tx.toHex()}, gettxout: {confirmations: 6, scriptPubKey: {hex: script}, value: 0.420_69}})[method as 'getblockhash']
    return {address, point: {txid: tx.getId(), vout: 0}, request: {address, confirmations: 2, exact: true, minimumSats: 42_069_000}, rpc, tx}
  }

  it('rejects funding facts from the wrong Dogecoin network', async () => {
    await verifyDogecoinNetwork('testnet', async () => ({chain: 'test'}))
    await rejected(() => verifyDogecoinNetwork('mainnet', async () => ({chain: 'test'})), 'does not match')
  })

  it('accepts a testnet shadowfork only after verifying its canonical genesis', async () => {
    const genesis = 'bb0a78264637406b6360aad926284d544d7049f45189db5664f3c4d07350559e'
    const rpc: Rpc = async (method, params) => {
      if (method === 'getblockchaininfo') return {chain: 'shadowfork'}
      expect(method).to.equal('getblockhash')
      expect(params).to.deep.equal([0])
      return genesis
    }

    await verifyDogecoinNetwork('testnet', rpc)
    await rejected(() => verifyDogecoinNetwork('mainnet', rpc), 'does not match')
    await rejected(() => verifyDogecoinNetwork('regtest', rpc), 'does not match')
    await rejected(() => verifyDogecoinNetwork('testnet', async method => method === 'getblockchaininfo' ? {chain: 'shadowfork'} : '0'.repeat(64)), 'genesis does not match')
    await rejected(() => verifyDogecoinNetwork('testnet', async method => method === 'getblockchaininfo' ? {chain: 'unknown'} : genesis), 'does not match')
  })

  it('derives confirmed amount and block facts from the actual transaction', async () => {
    const f = fixtureTx()
    const result = await inspectFunding(f.point, f.request, f.rpc)
    expect(result.amountSats).to.equal(42_069_000)
    expect(result.blockHeight).to.equal(100)
    expect(result.rawTransaction).to.equal(f.tx.toHex())
  })
  it('rejects an unrelated address, wrong transaction bytes and spent outputs', async () => {
    const f = fixtureTx(); const other = fixtureTx()
    await rejected(() => inspectFunding(f.point, {...f.request, address: other.address}, f.rpc), 'different address')
    await rejected(() => inspectFunding({...f.point, txid: 'a'.repeat(64)}, f.request, f.rpc), 'does not match')
    await rejected(() => inspectFunding(f.point, f.request, async (method, args) => method === 'gettxout' ? null : f.rpc(method, args)), 'already spent')
  })
  it('requires confirmations and exact genesis amount', async () => {
    const f = fixtureTx()
    await rejected(() => inspectFunding(f.point, {...f.request, confirmations: 7}, f.rpc), 'confirmations')
    await rejected(() => inspectFunding(f.point, {...f.request, minimumSats: 42_069_001}, f.rpc), 'exactly')
    await rejected(() => inspectFunding(f.point, f.request, async (method, args) => method === 'getblockhash' ? 'd'.repeat(64) : f.rpc(method, args)), 'active chain')
  })
  it('accepts the core funding marker and rejects plain payments or multiple markers', async () => {
    const plain = fixtureTx()
    await rejected(() => inspectFunding(plain.point, {...plain.request, marker: true}, plain.rpc), 'OP_RETURN')
    const marked = fixtureTx(true)
    expect((await inspectFunding(marked.point, {...marked.request, marker: true}, marked.rpc)).txid).to.equal(marked.point.txid)
    marked.tx.addOutput(Buffer.from(BRIDGE_FUNDING_MARKER, 'hex'), 0n)
    await rejected(() => inspectFunding({...marked.point, txid: marked.tx.getId()}, {...marked.request, marker: true}, marked.rpc), 'OP_RETURN')
  })
})

describe('Ethereum DA anchor selection', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ethereum-anchor-test-'))
    fs.mkdirSync(path.join(root, '.data'))
    fs.writeFileSync(path.join(root, '.data/protocol_seed.toml'), '[chain_anchors]\n')
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), 'network = "testnet"\n')
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  const specFor = (anchor: any): DeploymentSpec => {
    const spec = fixture()
    spec.ethereumDa!.chainId = 11_155_111
    spec.preparation!.bridge.production = {ethereumAnchor: anchor} as any
    return spec
  }

  it('pins finalized once and reuses it even if finalized advances', async () => {
    const calls: unknown[][] = []
    let latest = 100
    const rpc: Rpc = async (method, params) => {
      if (method === 'eth_chainId') return '0xaa36a7'
      calls.push(params)
      const height = params[0] === 'finalized' ? latest : Number.parseInt(params[0] as string, 16)
      return {hash: '0x' + height.toString(16).padStart(64, '0'), number: '0x' + height.toString(16), transactions: []}
    }

    const spec = specFor({blockTag: 'finalized'})
    await prepareEthereumAnchor(root, spec, rpc)
    latest = 200
    await prepareEthereumAnchor(root, spec, rpc)
    expect(calls.filter(call => call[0] === 'finalized')).to.have.length(1)
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.data/production-ethereum-anchor.json'), 'utf8'))
    expect(saved.blockNumber).to.equal(100)
    expect(saved.transactionIndex).to.equal(0)
    const seed = toml.parse(fs.readFileSync(path.join(root, '.data/protocol_seed.toml'), 'utf8')) as any
    expect(seed.chain_anchors.initial_ethereum_block_hash).to.equal(saved.blockHash)
    expect(seed.chain_anchors.initial_tx_index).to.equal(0)
    const config = toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')) as any
    expect(config.defaults.ethereumDaEmbeddedIndexerStartBlock).to.equal('100')
    const changed: Rpc = async method => method === 'eth_chainId' ? '0xaa36a7' : {hash: '0x' + 'f'.repeat(64), number: '0x64', transactions: []}
    await rejected(() => prepareEthereumAnchor(root, spec, changed), 'no longer canonical')
  })
  it('does not substitute latest for an unavailable finalized block or a wrong chain', async () => {
    const spec = specFor({blockTag: 'finalized'})
    await rejected(() => prepareEthereumAnchor(root, spec, async method => method === 'eth_chainId' ? '0x1' : null), 'chain ID')
    await rejected(() => prepareEthereumAnchor(root, spec, async method => method === 'eth_chainId' ? '0xaa36a7' : null), 'unavailable')
    expect(fs.existsSync(path.join(root, '.data/production-ethereum-anchor.json'))).to.equal(false)
  })
  it('retains explicit historical block and transaction index selection', async () => {
    const spec = specFor({blockNumber: 100, transactionIndex: 1})
    const rpc: Rpc = async (method, params) => {
      if (method === 'eth_chainId') return '0xaa36a7'
      expect(params).to.deep.equal(['0x64', false])
      return {hash: '0x' + 'e'.repeat(64), number: '0x64', transactions: ['first', 'second']}
    }

    await prepareEthereumAnchor(root, spec, rpc)
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.data/production-ethereum-anchor.json'), 'utf8'))
    expect(saved.transactionIndex).to.equal(1)
  })
})
