/* eslint-disable @typescript-eslint/no-explicit-any -- Workflow and RPC integration fixtures. */
import * as toml from '@iarna/toml'
import {Transaction} from 'bitcoinjs-lib'
import bitcore from 'bitcore-lib-doge'
import {expect} from 'chai'
import {Wallet} from 'ethers'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'
import type {Rpc} from '../../src/utils/preparation-funding.js'

import {generateSetupDefaultsToml} from '../../src/utils/deployment-spec-generator.js'
import {BRIDGE_FUNDING_MARKER, inspectFunding, publicKeyAddress, verifyDogecoinNetwork} from '../../src/utils/preparation-funding.js'
import {AwaitingInput, loadPreparationEnv} from '../../src/utils/preparation-io.js'
import {applyPreparation, createPreparationPlan, preparationSteps, validatePreparation} from '../../src/utils/preparation-plan.js'
import {CommandPreparationRunner} from '../../src/utils/preparation-runner.js'

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
function fixture(): DeploymentSpec {
  const spec = yaml.load(fs.readFileSync(path.join(cli, 'src/config/deployment-spec.minimal.yaml'), 'utf8').replaceAll('$ENV:OWNER_ADDRESS', Wallet.createRandom().address).replaceAll(/\$ENV:[A-Z_a-z]\w*/g, 'NONFUNCTIONAL_TEST_PLACEHOLDER')) as DeploymentSpec
  spec.infrastructure = {bootnodeCount: 1, provider: 'local', sequencerCount: 1}
  spec.bridge.confirmationsRequired = 2
  spec.images = {services: Object.fromEntries(['l2Rpc', 'l2Sequencer', 'l2Bootnode'].map(key => [key, {tag: 'explicit-test-release'}]))}
  spec.identities = {bootnodes: [{index: 0, nodekey: {action: 'create'}}], ethDaSubmitter: {action: 'create', backend: 'local'}, feeOracle: {action: 'create', backend: 'local'}, sequencers: [{index: 0, nodekey: {action: 'create'}, signer: {action: 'create', backend: 'local'}}]}
  spec.proofTopology = {active: {artifactStore: {kind: 'local_fs'}, profile: 'withdrawal_mock_prover', realScroll: {} as any, workerLaunch: 'local_cpu'}, compiler: {identityFilePath: '.data/compiler.json', image: {digest: `sha256:${'a'.repeat(64)}`, repository: 'example.invalid/compiler'}}, deployment: {artifactKeyPrefix: 'proof', proverPublicUrl: 'https://proof.example.invalid'}, enforcement: 'observe', generation: 'mock', mode: 'disabled', observeRealProofDeadlineMs: 1000}
  spec.preparation = {attestationDescriptors: ['descriptors/partner.json'], bridge: {image: `dogeos69/bridge-genesis-tools@sha256:${'b'.repeat(64)}`, mode: 'helper'}, proofMaterials: {mode: 'existing'}}
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

  it('plans without execution, waits for input, resumes and skips every completed step', async () => {
    fs.mkdirSync(deployment, {mode: 0o755})
    const plan = makePlan()
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
    expect(makePlan().id).to.equal(plan.id)
  })

  it('retains a private environment file reference and reloads it on resume without shell evaluation', async () => {
    const name = 'PREPARATION_TEST_PRIVATE_VALUE'
    const file = path.join(root, 'environment')
    fs.writeFileSync(file, `${name}='$(touch NEVER_EXECUTE)'\n`)
    try {
      const plan = createPreparationPlan({envFile: file, output: deployment, sdkDirectory: sdk, spec: path.join(root, 'intent.yaml')})
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
    const plan = makePlan()
    fs.writeFileSync(path.join(deployment, 'config.toml'), '[db]\n')
    const runner = new CommandPreparationRunner(async () => {throw new Error('Must not invoke a credential importer')})
    try {
      process.env.PREPARATION_TEST_DATABASE_URL = 'postgresql+asyncpg://NONFUNCTIONAL_TEST_USER:NONFUNCTIONAL_TEST_PASSWORD@database.invalid/dstack?ssl=require'
      await runner.run({effect: 'local', id: 'dstack', retry: 'safe', title: 'dstack'}, spec, deployment, plan)
      expect((toml.parse(fs.readFileSync(path.join(deployment, 'config.toml'), 'utf8')) as any).db.DSTACK_DB_CONNECTION_STRING).to.equal('$ENV:PREPARATION_TEST_DATABASE_URL')
    } finally {delete process.env.PREPARATION_TEST_DATABASE_URL}
  })

  it('never automatically replays a failed broadcast', async () => {
    makePlan(); let broadcasts = 0
    const runner = {async run(step: any) {if (step.id === 'helper-setup') {broadcasts++; throw new Error('connection lost after sending')}}}
    expect((await applyPreparation(deployment, runner)).status).to.equal('recovery-required')
    expect((await applyPreparation(deployment, runner)).status).to.equal('recovery-required')
    expect(broadcasts).to.equal(1)
  })

  it('rejects changed plan input and changed completed artifacts', async () => {
    makePlan()
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
    spec.proofTopology!.active!.artifactStore = {bucket: 'test-proof-bucket', endpointUrl: 'https://s3.example.invalid', kind: 's3_compatible', region: 'us-west-2'}
    expect(() => validatePreparation(spec)).not.to.throw()
  })

  it('rejects external inputs that replace the canonical protocol context', () => {
    const spec = fixture()
    spec.preparation!.inputs = [{destination: '.data/protocol_context.json', source: '/private/unrelated-context.json'}]
    expect(() => validatePreparation(spec)).to.throw('may not overwrite managed')
  })

  it('excludes concurrent apply and releases the lock while waiting', async () => {
    makePlan()
    let release!: () => void
    const barrier = new Promise<void>(resolve => {release = resolve})
    const running = applyPreparation(deployment, {async run() {await barrier; throw new AwaitingInput({message: 'waiting'})}})
    await rejected(() => applyPreparation(deployment, {async run() {}}), 'Another apply owns')
    release(); expect((await running).status).to.equal('waiting')
    expect(fs.existsSync(path.join(deployment, '.scrollsdk/apply.lock'))).to.equal(false)
  })

  it('runs actual bootstrap and identity commands before waiting for a partner descriptor', async () => {
    makePlan()
    const first = await applyPreparation(deployment, new CommandPreparationRunner())
    expect(first.status).to.equal('waiting')
    expect(first.currentStep).to.equal('descriptors')
    const doge = fs.readFileSync(path.join(deployment, '.data/doge-config.toml'), 'utf8')
    expect((toml.parse(doge) as any).sequencerReth.instances).to.have.length(1)
    const second = await applyPreparation(deployment, new CommandPreparationRunner())
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
    p.production = {ethereumAnchor: {blockNumber: 100, transactionIndex: 0}, feeWalletKeyEnv: 'PROD_FEE_KEY', feeWalletPublicKey: key(), recoveryPublicKeys: [key(), key()], sequencerKeyEnv: 'PROD_SEQUENCER_KEY', sequencerPublicKey: key()}
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
