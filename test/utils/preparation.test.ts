/* eslint-disable @typescript-eslint/no-explicit-any -- Workflow and RPC integration fixtures. */
import * as toml from '@iarna/toml'
import {Transaction} from 'bitcoinjs-lib'
import bitcore from 'bitcore-lib-doge'
import {expect} from 'chai'
import {Wallet} from 'ethers'
import * as yaml from 'js-yaml'
import {execFileSync, spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import sinon from 'sinon'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'
import type {Rpc} from '../../src/utils/preparation-funding.js'

import {generateConfigToml, generateSetupDefaultsToml} from '../../src/utils/deployment-spec-generator.js'
import {BRIDGE_FUNDING_MARKER, inspectFunding, prepareEthereumAnchor, publicKeyAddress, verifyDogecoinNetwork} from '../../src/utils/preparation-funding.js'
import {prepareLocalGenesis} from '../../src/utils/preparation-genesis.js'
import {AwaitingInput, loadPreparationEnv} from '../../src/utils/preparation-io.js'
import {type PreparationPlan, applyPreparation, createPreparationPlan, preparationSteps, validatePreparation} from '../../src/utils/preparation-plan.js'
import {POLICY_RECEIPTS_INPUT} from '../../src/utils/preparation-policy-receipts.js'
import {resolvePreparationProofRelease} from '../../src/utils/preparation-release.js'
import {CommandPreparationRunner} from '../../src/utils/preparation-runner.js'
import {PREPARATION_STAGES} from '../../src/utils/preparation-stages.js'
import {buildProofAwsConfig, writeProofAwsConfig} from '../../src/utils/proof-aws-config.js'
import {PROOF_RELEASE_IMAGE_NAMES} from '../../src/utils/proof-software-release.js'
import {policyReceiptFixture} from '../helpers/cubesigner-policy-receipts.js'
import {createSdkFixture} from '../helpers/sdk-templates.js'

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
function fixture(): DeploymentSpec {
  const spec = yaml.load(fs.readFileSync(path.join(cli, 'test/fixtures/deployment-spec/minimal.yaml'), 'utf8').replaceAll('$ENV:OWNER_ADDRESS', Wallet.createRandom().address).replaceAll(/\$ENV:[A-Z_a-z]\w*/g, 'NONFUNCTIONAL_TEST_PLACEHOLDER')) as DeploymentSpec
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
    const revision = createSdkFixture(sdk)
    const spec = fixture(); spec.templates = {sdkRevision: revision}
    fs.writeFileSync(path.join(root, 'intent.yaml'), yaml.dump(spec))
  })
  afterEach(() => {fs.rmSync(root, {force: true, recursive: true})})
  const makePlan = () => createPreparationPlan({output: deployment, sdkDirectory: sdk, spec: path.join(root, 'intent.yaml')})

  it('plans dstack AWS role creation without requiring a prefilled role ARN', async () => {
    const spec = fixture()
    spec.infrastructure = {aws: {accountId: '000000000000', eksClusterName: 'fixture-cluster', region: 'us-east-1'}, bootnodeCount: 1, provider: 'aws', sequencerCount: 1}
    spec.dstackController = {database: {type: 'sqlite'}, enabled: true}
    spec.preparation!.dstack = {aws: {action: 'create', vpcIds: {'us-east-1': 'vpc-00000000000000000'}}, mode: 'import', providers: ['aws']}
    fs.writeFileSync(path.join(root, 'intent.yaml'), yaml.dump(spec))
    const plan = await makePlan()
    expect(plan.steps.find(step => step.id === 'dstack-aws')).include({effect: 'cloud'})
    expect(fs.existsSync(path.join(deployment, '.data/dstack-aws.json'))).false
    spec.preparation!.inputs = [{destination: '.data/dstack-aws.json', source: 'operator-file.json'}]
    expect(() => validatePreparation(spec)).throw('generates its own resource record')
  })

  it('leaves no partial plan after an initial state write fails and allows retry', async () => {
    const rename = fs.renameSync
    const stub = sinon.stub(fs, 'renameSync').callsFake((from, to) => {
      if (path.basename(String(to)) === 'state.json') throw new Error('Injected initial state write failure')
      return rename(from, to)
    })
    try {await rejected(makePlan, 'Injected initial state write failure')} finally {stub.restore()}
    expect(fs.existsSync(path.join(deployment, '.scrollsdk/intent.json'))).false
    expect(fs.existsSync(path.join(deployment, '.scrollsdk/plan.json'))).false
    const plan = await makePlan()
    expect(JSON.parse(fs.readFileSync(path.join(deployment, '.scrollsdk/state.json'), 'utf8'))).to.include({planId: plan.id, status: 'pending'})
    expect(fs.readdirSync(root).filter(name => name.includes('.plan-'))).empty
  })

  it('does not overwrite files added to an empty output directory while saving a plan', async () => {
    fs.mkdirSync(deployment)
    const rename = fs.renameSync
    const stub = sinon.stub(fs, 'renameSync').callsFake((from, to) => {
      if (path.basename(String(to)) === 'state.json') fs.writeFileSync(path.join(deployment, 'operator-note'), 'preserve')
      return rename(from, to)
    })
    let error: unknown
    try {await makePlan()} catch (error_) {error = error_} finally {stub.restore()}
    expect(error).to.be.instanceOf(Error)
    expect(fs.readFileSync(path.join(deployment, 'operator-note'), 'utf8')).eq('preserve')
    expect(fs.existsSync(path.join(deployment, '.scrollsdk'))).false
  })

  it('rejects an SDK without selected ALB support before querying CubeSigner', async () => {
    const spec = fixture()
    const prefix = 'arn:aws:elasticloadbalancing:us-east-1:000000000000:'
    spec.infrastructure = {aws: {
      accountId: '000000000000', alb: {bindings: {frontends: {endpoint: 'public', serviceRef: {name: 'frontends', port: 80}, targetGroupArn: `${prefix}targetgroup/fixture/2222222222222222`}}, endpoints: {public: {
        listenerArn: `${prefix}listener/app/fixture/0000000000000000/1111111111111111`,
        loadBalancerArn: `${prefix}loadbalancer/app/fixture/0000000000000000`,
      }}, mode: 'existing'}, eksClusterName: 'fixture',
      region: 'us-east-1',
    }, bootnodeCount: 1, provider: 'aws', sequencerCount: 1}
    spec.signing.cubesigner = {identity: {roleId: 'NONFUNCTIONAL_TEST_ROLE'}, mode: 'production_verifier_key_policy'}
    execFileSync('git', ['-C', sdk, 'rm', 'charts/frontends/templates/targetgroupbindings.yaml'])
    execFileSync('git', ['-C', sdk, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Remove fixture capability'], {stdio: 'pipe'})
    fs.writeFileSync(path.join(root, 'intent.yaml'), yaml.dump(spec))
    await rejected(makePlan, 'selected SDK revision lacks')
    expect(fs.existsSync(deployment)).false
  })

  it('resumes a frozen staged plan with late governance receipts before invoking prep-charts', async () => {
    const spec = yaml.load(fs.readFileSync(path.join(root, 'intent.yaml'), 'utf8')) as DeploymentSpec
    spec.signing.cubesigner = {mode: 'production_verifier_key_policy'}
    fs.writeFileSync(path.join(root, 'intent.yaml'), yaml.dump(spec))
    const plan = await createPreparationPlan({output: deployment, sdkDirectory: sdk, spec: path.join(root, 'intent.yaml'), staged: true})
    const intentFile = path.join(deployment, '.scrollsdk/intent.json')
    const frozen = fs.readFileSync(intentFile, 'utf8')
    const calls: string[] = []
    const commands: string[][] = []
    const charts = new CommandPreparationRunner(async (_root, _step, args) => {commands.push(args)})
    const runner = {async run(step: typeof plan.steps[number], saved: DeploymentSpec) {
      calls.push(step.id)
      if (step.id === 'bootstrap') {
        fs.mkdirSync(path.join(deployment, '.data'))
        for (const name of ['config.public.toml', 'config-contracts.toml']) fs.writeFileSync(path.join(deployment, name), '[contracts]\n')
        fs.writeFileSync(path.join(deployment, '.data/doge-config.toml'), toml.stringify({bootnodeReth: {instances: [{index: 0}]}, cubesigner: {
          mode: saved.signing.cubesigner!.mode!, roles: [{keys: [{key_id: 'key-1', material_id: 'material-1'}], role_id: 'role-1'}],
        }, network: 'testnet'}))
      }

      if (step.id === 'protocol-context') fs.writeFileSync(path.join(deployment, '.data/protocol_context.json'), JSON.stringify({genesis: {}}))
      if (step.id === 'charts' || step.id === 'render-final') await charts.run(step, saved, deployment, plan)
    }}
    const stage = (selected: typeof PREPARATION_STAGES[number]) => applyPreparation(deployment, runner, undefined, {stage: selected})
    for (const selected of ['genesis', 'aws', 'bridge-funding', 'protocol-context'] as const) await stage(selected)
    await stage('proof-materials')
    await stage('policy-prepare')
    const waiting = await stage('proof-publish')
    expect(waiting.status).eq('waiting')
    expect(waiting.currentStep).eq('charts')
    expect(waiting.waiting?.file).eq(path.join(deployment, POLICY_RECEIPTS_INPUT))
    expect(commands).empty
    const refs = policyReceiptFixture(deployment).selection.policyReceipts
    fs.writeFileSync(path.join(deployment, POLICY_RECEIPTS_INPUT), JSON.stringify(refs))
    expect((await stage('proof-publish')).status).eq('stage-complete')
    expect((await stage('render')).status).eq('stage-complete')
    await stage('signer-session')
    expect(commands.filter(args => args[0] === 'prep-charts')).length(2)
    expect(calls.filter(id => id === 'bootstrap')).length(1)
    expect(calls.filter(id => id === 'helper-setup')).length(1)
    expect(fs.readFileSync(intentFile, 'utf8')).eq(frozen)
    expect(JSON.parse(fs.readFileSync(path.join(deployment, '.scrollsdk/plan.json'), 'utf8')).id).eq(plan.id)
    const configFile = path.join(deployment, '.data/doge-config.toml')
    expect((toml.parse(fs.readFileSync(configFile, 'utf8')).cubesigner as toml.JsonMap).policyReceipts).deep.eq(refs)
    // Subsequent operator edits are advisory, including after an authorized import.
    fs.appendFileSync(configFile, '\n# operator edit\n')
    const uploaded = await stage('upload-secrets')
    expect(uploaded.status).eq('prepared')
    expect(uploaded.warnings?.join('\n')).include('.data/doge-config.toml')
  })

  for (const recipient of [undefined, '', 'REPLACE_WITH_DOGECOIN_P2PKH_ADDRESS', `0x${'1'.repeat(40)}`]) {
    it(`rejects the ${recipient === undefined ? 'missing' : 'invalid ' + recipient} fee-vault recipient before planning external inputs`, async () => {
      const spec = fixture()
      if (recipient === undefined) delete spec.contracts.feeVaultDogeRecipientAddress
      else spec.contracts.feeVaultDogeRecipientAddress = recipient
      fs.writeFileSync(path.join(root, 'intent.yaml'), yaml.dump(spec))
      // A nonexistent SDK path makes the ordering observable: recipient checking
      // must happen before SDK resolution, CubeSigner lookup or release downloads.
      await rejected(() => createPreparationPlan({output: deployment, sdkDirectory: path.join(root, 'missing-sdk'), spec: path.join(root, 'intent.yaml')}), 'contracts.feeVaultDogeRecipientAddress')
      expect(fs.existsSync(deployment)).to.equal(false)
    })
  }

  it('rejects a legacy saved plan without a fee-vault recipient before running any step', async () => {
    const plan = await makePlan()
    const directory = path.join(deployment, '.scrollsdk')
    const spec = JSON.parse(fs.readFileSync(path.join(directory, 'intent.json'), 'utf8'))
    delete spec.contracts.feeVaultDogeRecipientAddress
    const text = JSON.stringify(spec, null, 2) + '\n'
    const {id: previousId, ...body} = plan
    expect(previousId).to.be.a('string')
    body.specHash = createHash('sha256').update(text).digest('hex')
    const id = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    fs.writeFileSync(path.join(directory, 'intent.json'), text)
    fs.writeFileSync(path.join(directory, 'plan.json'), JSON.stringify({...body, id}))
    const stateFile = path.join(directory, 'state.json')
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    state.planId = id
    fs.writeFileSync(stateFile, JSON.stringify(state))
    const before = fs.readFileSync(stateFile, 'utf8')
    let calls = 0
    await rejected(() => applyPreparation(deployment, {async run() {calls++}}), 'contracts.feeVaultDogeRecipientAddress')
    expect(calls).to.equal(0)
    expect(fs.readFileSync(stateFile, 'utf8')).to.equal(before)
    expect(fs.existsSync(path.join(directory, 'apply.lock'))).to.equal(false)
  })

  it('rejects a missing recipient through the actual plan and generation commands without writing output', () => {
    const spec = fixture()
    delete spec.contracts.feeVaultDogeRecipientAddress
    const input = path.join(root, 'intent.yaml')
    fs.writeFileSync(input, yaml.dump(spec))
    for (const command of ['plan', 'generate-from-spec']) {
      const output = path.join(root, command)
      const sdkArgs = command === 'plan' ? ['--sdk-dir', sdk] : []
      const result = spawnSync(process.execPath, [path.join(cli, 'bin/run.js'), 'setup', command, '--spec', input, ...sdkArgs, '--output', output, '--json'], {cwd: root, encoding: 'utf8'})
      expect(result.status).not.to.equal(0)
      expect(result.stdout + result.stderr).to.include('contracts.feeVaultDogeRecipientAddress')
      expect(fs.existsSync(output)).to.equal(false)
    }
  })

  it('runs plan and resumes apply with conventional paths, and supports explicit overrides', async function () {
    this.timeout(60_000)
    fs.renameSync(sdk, path.join(root, 'scroll-sdk'))
    const instance = path.join(root, 'instance')
    fs.mkdirSync(instance)
    const spec = fixture()
    spec.accounts.owner.address = '$ENV:DEPLOYMENT_PATH_TEST_OWNER'
    fs.writeFileSync(path.join(instance, 'deployment-spec.yaml'), yaml.dump(spec))
    const owner = Wallet.createRandom().address
    const envFile = path.join(instance, 'deployment.env')
    fs.writeFileSync(envFile, `DEPLOYMENT_PATH_TEST_OWNER=${owner}\n`)
    const env = {...process.env}
    delete env.DEPLOYMENT_PATH_TEST_OWNER
    const command = (args: string[]) => spawnSync(process.execPath, [path.join(cli, 'bin/run.js'), 'setup', ...args, '--json'], {cwd: instance, encoding: 'utf8', env})
    const planned = command(['plan'])
    expect(planned.status, planned.stderr + planned.stdout).to.equal(0)
    const output = path.join(instance, 'deployment')
    const plan = JSON.parse(fs.readFileSync(path.join(output, '.scrollsdk/plan.json'), 'utf8'))
    expect(plan.envFile).to.equal(envFile)
    expect(plan.sdkDirectory).to.equal(path.join(root, 'scroll-sdk'))
    expect(JSON.parse(fs.readFileSync(path.join(output, '.scrollsdk/intent.json'), 'utf8')).accounts.owner.address).to.equal(owner)

    // Complete synthetic steps in-process; the actual CLI resume must not run
    // any cloud, Docker, chain or Kubernetes operations in this path test.
    try {for (const stage of PREPARATION_STAGES) await applyPreparation(output, {async run() {}}, undefined, {stage})} finally {delete process.env.DEPLOYMENT_PATH_TEST_OWNER}
    for (const args of [['apply'], ['apply', '--deployment-dir', 'deployment'], ...PREPARATION_STAGES.map(stage => [stage]), ['proof-materials', '--dir', 'deployment'], ['proof-materials', '--non-interactive']]) {
      const applied = command(args)
      expect(applied.status, applied.stderr + applied.stdout).to.equal(0)
      expect(JSON.parse(applied.stdout).data.status).to.equal('prepared')
    }

    // Warnings must reach both command adapters' JSON output, not just state.json.
    const intentFile = path.join(output, '.scrollsdk/intent.json')
    fs.appendFileSync(intentFile, '\n')
    for (const name of ['apply', 'render']) {
      const resumed = command([name])
      expect(resumed.status, resumed.stderr + resumed.stdout).eq(0)
      expect(JSON.parse(resumed.stdout).warnings.join('\n')).include('.scrollsdk/intent.json')
    }

    const custom = command(['plan', '--spec', 'deployment-spec.yaml', '--env-file', 'deployment.env', '--sdk-dir', '../scroll-sdk', '--output', 'custom output'])
    expect(custom.status, custom.stderr + custom.stdout).to.equal(0)
    expect(fs.existsSync(path.join(instance, 'custom output/.scrollsdk/plan.json'))).to.equal(true)
    const missing = command(['plan', '--env-file', 'missing.env', '--output', 'must-not-exist'])
    expect(missing.status).not.to.equal(0)
    expect(fs.existsSync(path.join(instance, 'must-not-exist'))).to.equal(false)
    const generated = command(['generate-from-spec', '--dry-run'])
    expect(generated.status, generated.stderr + generated.stdout).to.equal(0)
    expect(fs.existsSync(path.join(instance, 'config.toml'))).to.equal(false)
  })

  it('defaults new production plans to one helper handoff and never replays an ambiguous helper broadcast', async () => {
    const spec = fixture()
    spec.preparation!.bridge.mode = 'production'
    spec.preparation!.bridge.production = {
      ethereumAnchor: {blockTag: 'finalized'},
      recoveryPublicKeys: Array.from({length: spec.bridge.thresholds.recovery}, () => new bitcore.PrivateKey().toPublicKey().toString()),
      sequencerKeyEnv: 'DISPOSABLE_SEQUENCER_KEY', sequencerPublicKey: new bitcore.PrivateKey().toPublicKey().toString(),
    }
    spec.bridge.teePubkey = new bitcore.PrivateKey().toPublicKey().toString()
    spec.bridge.timelock = 10_000_000
    fs.writeFileSync(path.join(root, 'intent.yaml'), yaml.dump(spec))
    const plan = await createPreparationPlan({output: deployment, sdkDirectory: sdk, spec: path.join(root, 'intent.yaml'), staged: true})
    const saved = JSON.parse(fs.readFileSync(path.join(deployment, '.scrollsdk/intent.json'), 'utf8'))
    expect(saved.preparation.bridge.production.funding).to.equal('helper')
    expect(plan.steps.map(step => step.id)).not.to.include.members(['production-wallets', 'production-funding'])
    let funded = false
    let broadcasts = 0
    const runner = {async run(step: {id: string}) {
      if (step.id === 'managed-helper-funding' && !funded) throw new AwaitingInput({message: 'Supply helper.txid and helper.vout'})
      if (step.id === 'managed-helper-setup') {broadcasts++; throw new Error('Connection lost after send')}
    }}
    await applyPreparation(deployment, runner, undefined, {stage: 'genesis'})
    await applyPreparation(deployment, runner, undefined, {stage: 'aws'})
    expect((await applyPreparation(deployment, runner, undefined, {stage: 'bridge-funding'})).currentStep).to.equal('managed-helper-funding')
    funded = true
    expect((await applyPreparation(deployment, runner, undefined, {stage: 'bridge-funding'})).status).to.equal('recovery-required')
    expect((await applyPreparation(deployment, runner, undefined, {stage: 'bridge-funding'})).status).to.equal('recovery-required')
    expect(broadcasts).to.equal(1)
  })

  it('executes only the selected stage and resumes both production funding handoffs without replaying earlier work', async () => {
    const spec = fixture()
    spec.preparation!.bridge.mode = 'production'
    spec.preparation!.bridge.production = {
      ethereumAnchor: {blockTag: 'finalized'},
      funding: 'external',
      recoveryPublicKeys: Array.from({length: spec.bridge.thresholds.recovery}, () => new bitcore.PrivateKey().toPublicKey().toString()),
      sequencerKeyEnv: 'DISPOSABLE_SEQUENCER_KEY', sequencerPublicKey: new bitcore.PrivateKey().toPublicKey().toString(),
    }
    spec.bridge.teePubkey = new bitcore.PrivateKey().toPublicKey().toString()
    spec.bridge.timelock = 10_000_000
    fs.writeFileSync(path.join(root, 'intent.yaml'), yaml.dump(spec))
    const plan = await createPreparationPlan({output: deployment, sdkDirectory: sdk, spec: path.join(root, 'intent.yaml'), staged: true})
    const calls: string[] = []
    let walletsFunded = false
    let bridgeFunded = false
    const runner = {async run(step: {id: string}) {
      calls.push(step.id)
      if (step.id === 'production-wallets' && !walletsFunded) throw new AwaitingInput({message: 'Fund sequencer vout 0 and fee wallet'})
      if (step.id === 'production-funding' && !bridgeFunded) throw new AwaitingInput({message: 'Fund final bridge with OP_RETURN'})
    }}
    const stage = (selected: typeof PREPARATION_STAGES[number]) => applyPreparation(deployment, runner, undefined, {stage: selected})
    expect(plan.schema).to.equal('scrollsdk/preparation/v2')
    await rejected(() => applyPreparation(deployment, runner), 'Select a preparation stage')
    await rejected(() => stage('aws'), 'Prerequisite genesis')
    expect(calls).to.deep.equal([])
    expect((await stage('genesis')).status).to.equal('stage-complete')
    expect(calls).to.deep.equal(['bootstrap', 'genesis-local'])
    expect((await stage('genesis')).nextStage).to.equal('aws')
    expect(calls).to.deep.equal(['bootstrap', 'genesis-local'])
    await rejected(() => stage('bridge-funding'), 'Prerequisite aws')
    await stage('aws')
    const walletWait = await stage('bridge-funding')
    expect(walletWait.status).to.equal('waiting')
    expect(walletWait.nextStage).to.equal('bridge-funding')
    expect(calls).not.to.include('bridge-info')
    walletsFunded = true
    const bridgeWait = await stage('bridge-funding')
    expect(bridgeWait.status).to.equal('waiting')
    expect(bridgeWait.currentStep).to.equal('production-funding')
    expect(calls.filter(id => id === 'bridge-info')).to.have.length(1)
    bridgeFunded = true
    expect((await stage('bridge-funding')).nextStage).to.equal('protocol-context')
    expect(calls.filter(id => id === 'production-wallets')).to.have.length(2)
    expect(calls.filter(id => id === 'genesis-local')).to.have.length(1)
    expect(calls).not.to.include('protocol-context')
    await rejected(() => stage('proof-materials'), 'Prerequisite protocol-context')
    expect((await stage('protocol-context')).nextStage).to.equal('proof-materials')
    expect(calls.filter(id => id === 'protocol-context')).to.have.length(1)
    expect((await stage('proof-materials')).nextStage).to.equal('proof-publish')
    await stage('proof-publish')
    expect(calls).not.to.include('secrets')
    expect(calls).not.to.include('secret-upload')
    expect((await stage('render')).nextStage).to.equal('signer-session')
    expect((await stage('signer-session')).nextStage).to.equal('upload-secrets')
    expect((await stage('upload-secrets')).status).to.equal('prepared')
    expect(calls.filter(id => id === 'secret-upload')).to.have.length(1)
    expect(plan.steps.filter(step => step.stage === 'genesis').every(step => step.effect === 'local')).to.equal(true)
  })

  it('pins the supplied or generated genesis deployer on retry without preparing runtime identities', async () => {
    const spec = fixture()
    fs.mkdirSync(deployment)
    fs.writeFileSync(path.join(deployment, 'config.toml'), generateConfigToml(spec))
    let attempts = 0
    let deployer = ''
    const generator = async (directory: string, step: string, args: string[]) => {
      attempts++
      expect(step).to.equal('genesis-local')
      expect(args[0]).to.equal('gen-l2-artifacts')
      expect(args).to.include('--skip-deployment-salt-update')
      expect(args).to.include('--skip-l1-fee-vault-update')
      expect(directory).to.equal(path.join(deployment, '.scrollsdk/genesis-build'))
      expect(fs.existsSync(path.join(directory, '.data/doge-config.toml'))).to.equal(false)
      const input: any = toml.parse(fs.readFileSync(path.join(directory, 'config.toml'), 'utf8'))
      expect(input.accounts.L2_GAS_ORACLE_SENDER_ADDR).to.equal(input.accounts.DEPLOYER_ADDR)
      expect(input.sequencer.L2GETH_SIGNER_ADDRESS).to.equal('0x' + '0'.repeat(40))
      if (attempts === 1) {deployer = input.accounts.DEPLOYER_ADDR; throw new Error('Disposable generator interruption')}
      expect(input.accounts.DEPLOYER_ADDR).to.equal(deployer)
      fs.mkdirSync(path.join(directory, 'values'), {recursive: true})
      fs.writeFileSync(path.join(directory, 'values/genesis.yaml'), yaml.dump({scrollConfig: JSON.stringify({alloc: {}, config: {chainId: spec.network.l2ChainId}})}))
      fs.writeFileSync(path.join(directory, 'config-contracts.toml'), '[contracts]\n')
      fs.writeFileSync(path.join(directory, 'frontend-config.yaml'), 'generator-only: true\n')
    }

    await rejected(() => prepareLocalGenesis(deployment, spec, generator), 'Disposable generator interruption')
    await prepareLocalGenesis(deployment, spec, generator)
    const saved: any = toml.parse(fs.readFileSync(path.join(deployment, 'config.toml'), 'utf8'))
    expect(saved.accounts.DEPLOYER_ADDR).to.equal(deployer)
    expect(saved.accounts.L2_GAS_ORACLE_SENDER_ADDR).not.to.equal(deployer)
    expect(fs.existsSync(path.join(deployment, 'frontend-config.yaml'))).to.equal(false)
    expect(fs.readFileSync(path.join(deployment, 'genesis.json')).equals(fs.readFileSync(path.join(deployment, '.data/genesis.json')))).to.equal(true)
    const imported = Wallet.createRandom()
    saved.accounts.DEPLOYER_PRIVATE_KEY = imported.privateKey
    saved.accounts.DEPLOYER_ADDR = imported.address
    fs.writeFileSync(path.join(deployment, 'config.toml'), toml.stringify(saved))
    deployer = imported.address
    await prepareLocalGenesis(deployment, spec, generator)
    saved.accounts.DEPLOYER_ADDR = Wallet.createRandom().address
    fs.writeFileSync(path.join(deployment, 'config.toml'), toml.stringify(saved))
    await rejected(() => prepareLocalGenesis(deployment, spec, generator), 'does not match its address')
    expect(attempts).to.equal(3)
  })

  it('warns about edited genesis artifacts and continues the next stage without regeneration', async () => {
    await createPreparationPlan({output: deployment, sdkDirectory: sdk, spec: path.join(root, 'intent.yaml'), staged: true})
    await applyPreparation(deployment, {async run() {fs.writeFileSync(path.join(deployment, 'genesis.json'), '{}')}}, undefined, {stage: 'genesis'})
    fs.writeFileSync(path.join(deployment, 'genesis.json'), '{"modified":true}')
    const calls: string[] = []
    const warnings: string[] = []
    const result = await applyPreparation(deployment, {async run(step) {calls.push(step.id)}}, undefined, {stage: 'aws', warn: message => warnings.push(message)})
    expect(result.status).eq('stage-complete')
    expect(warnings.join('\n')).include('genesis.json')
    expect(result.warnings).deep.eq(warnings)
    expect(calls).include('identities').and.not.include('genesis-local')
    expect(fs.readFileSync(path.join(deployment, 'genesis.json'), 'utf8')).eq('{"modified":true}')
  })

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
        // A published kit is immutable and content-addressed; refresh leaves it in place.
        fs.mkdirSync(path.join(deployment, 'deployment-kit-k-0123456789ab'))
        fs.writeFileSync(path.join(deployment, 'deployment-kit-k-0123456789ab/deployment-kit.json'), '{"kept":true}')
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
    expect(fs.readFileSync(path.join(deployment, 'deployment-kit-k-0123456789ab/deployment-kit.json'), 'utf8')).to.equal('{"kept":true}')
    fs.appendFileSync(path.join(deployment, '.data/genesis.json'), ' ')
    const refreshed = await applyPreparation(deployment, runner, undefined, {refreshRuntime: true})
    expect(refreshed.status).eq('prepared')
    expect(refreshed.warnings?.join('\n')).include('.data/genesis.json')
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
        fs.writeFileSync(path.join(deployment, '.data/doge-config.toml'), 'deployment_name = "pinned-name"\n[kubernetes]\nserviceName = "old-node"\n[attestationSigner.deploymentKit]\nversion = "k-0123456789ab"\n')
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
      expect(config.attestationSigner).not.to.have.property('deploymentKit')
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
    expect(fs.existsSync(path.join(deployment, '.gitignore'))).to.equal(false)
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

  it('allows operator YAML and Makefile edits, including hashes saved by older CLI versions', async () => {
    await makePlan()
    let ready = false
    const runner = {async run(step: {id: string}) {
      if (step.id === 'bootstrap') {
        fs.mkdirSync(path.join(deployment, 'values'), {recursive: true})
        fs.writeFileSync(path.join(deployment, 'values/service-production.yaml'), 'enabled: true\n')
        fs.writeFileSync(path.join(deployment, 'Makefile'), '# generated\n')
      }

      if (step.id === 'helper-funding' && !ready) throw new AwaitingInput({message: 'fund helper'})
    }}
    await applyPreparation(deployment, runner)
    const statePath = path.join(deployment, '.scrollsdk/state.json')
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    for (const file of ['values/service-production.yaml', 'Makefile']) {
      expect(state.files).to.have.property(file)
      state.files[file] = createHash('sha256').update(fs.readFileSync(path.join(deployment, file))).digest('hex')
      fs.appendFileSync(path.join(deployment, file), '# operator edit\n')
    }

    fs.writeFileSync(statePath, JSON.stringify(state))
    ready = true
    expect((await applyPreparation(deployment, runner)).status).to.equal('prepared')
    const updated = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    expect(updated.files).to.have.property('values/service-production.yaml')
    expect(updated.files).to.have.property('Makefile')
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
    // Check the pinned template's policy; generated service alerts may add keys.
    const monitor = yaml.load(fs.readFileSync(path.join(deployment, 'values/scroll-monitor-production.yaml'), 'utf8')) as {grafana: {enabled: boolean}}
    expect(monitor.grafana).to.deep.equal({enabled: false})
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

  for (const change of ['context-stage', 'proof-stage', 'missing-policy', 'missing-session', 'missing-upload', 'retired-step'] as const) it(`rejects an incompatible saved plan (${change}) without changing files or running steps`, async () => {
    const spec = fixture()
    spec.signing = {...spec.signing, cubesigner: {}}
    fs.writeFileSync(path.join(root, 'intent.yaml'), yaml.dump(spec))
    const fresh = await createPreparationPlan({output: deployment, sdkDirectory: sdk, spec: path.join(root, 'intent.yaml'), staged: true})
    const body: {id?: string} & Omit<PreparationPlan, 'id'> = {...fresh}
    delete body.id
    if (change === 'context-stage') body.steps = body.steps.map(step => step.id === 'protocol-context' ? {...step, stage: 'proof-materials'} : step)
    if (change === 'proof-stage') body.steps = body.steps.map(step => step.stage === 'policy-prepare' ? {...step, stage: 'proof-materials'} : step)
    const missing: Record<string, string> = {'missing-policy': 'cubesigner-policy-build', 'missing-session': 'cubesigner-session', 'missing-upload': 'cubesigner-secret-upload'}
    if (missing[change]) body.steps = body.steps.filter(step => step.id !== missing[change])
    if (change === 'retired-step') body.steps.push({effect: 'local', id: 'signer-policy', retry: 'safe', title: 'Retired signer policy'})
    const old = {...body, id: createHash('sha256').update(JSON.stringify(body)).digest('hex')}
    const planPath = path.join(deployment, '.scrollsdk/plan.json')
    const statePath = path.join(deployment, '.scrollsdk/state.json')
    fs.writeFileSync(planPath, JSON.stringify(old))
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    fs.writeFileSync(statePath, JSON.stringify({...state, planId: old.id, status: 'prepared', steps: Object.fromEntries(old.steps.map(step => [step.id, 'completed']))}))
    const files = [planPath, statePath, path.join(deployment, '.scrollsdk/intent.json')]
    const before = files.map(file => fs.readFileSync(file, 'utf8'))
    const calls: string[] = []
    await rejected(() => applyPreparation(deployment, {async run(step) {calls.push(step.id)}}, undefined, {stage: 'render'}), 'CLI workflow changed')
    expect(calls).deep.equal([])
    expect(files.map(file => fs.readFileSync(file, 'utf8'))).deep.equal(before)
  })

  it('never automatically replays a failed broadcast', async () => {
    await makePlan(); let broadcasts = 0
    const runner = {async run(step: any) {if (step.id === 'helper-setup') {broadcasts++; throw new Error('connection lost after sending')}}}
    expect((await applyPreparation(deployment, runner)).status).to.equal('recovery-required')
    expect((await applyPreparation(deployment, runner)).status).to.equal('recovery-required')
    expect(broadcasts).to.equal(1)
  })

  it('reports changed or removed files and saved intent without replaying completed work', async () => {
    await makePlan()
    await applyPreparation(deployment, {async run() {fs.writeFileSync(path.join(deployment, 'config.toml'), 'network = "testnet"')}})
    fs.writeFileSync(path.join(deployment, 'config.toml'), 'network = "mainnet"')
    const runner = {async run() {throw new Error('completed steps must not execute')}}
    const edited = await applyPreparation(deployment, runner)
    expect(edited.status).eq('prepared')
    expect(edited.warnings?.join('\n')).include('config.toml').and.not.include('mainnet')
    expect((await applyPreparation(deployment, runner)).warnings).deep.eq([])
    fs.rmSync(path.join(deployment, 'config.toml'))
    fs.appendFileSync(path.join(deployment, '.scrollsdk/intent.json'), ' ')
    const planFile = path.join(deployment, '.scrollsdk/plan.json')
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
    plan.deploymentName = 'renamed-by-operator'
    fs.writeFileSync(planFile, JSON.stringify(plan))
    const resumed = await applyPreparation(deployment, runner)
    expect(resumed.status).eq('recovery-required')
    expect(resumed.warnings).length(2)
    expect(resumed.waiting?.message).include('config.toml')
    expect(resumed.files).to.have.property('config.toml')
    expect((await applyPreparation(deployment, runner)).status).eq('recovery-required')
    fs.writeFileSync(path.join(deployment, 'config.toml'), 'network = "mainnet"')
    expect((await applyPreparation(deployment, runner)).status).eq('prepared')
  })

  it('preserves an existing CubeSigner session in the explicit session stage instead of rotating it', async () => {
    const spec = fixture()
    spec.signing = {...spec.signing, cubesigner: {}}
    fs.mkdirSync(path.join(deployment, 'secrets'), {recursive: true})
    fs.mkdirSync(path.join(deployment, '.data'), {recursive: true})
    fs.writeFileSync(path.join(deployment, '.data/doge-config.toml'), toml.stringify({cubesigner: {roles: [{keys: [{key_id: 'Key#test'}], role_id: 'Role#test'}]}}))
    fs.writeFileSync(path.join(deployment, 'secrets/cubesigner-signer-session.json'), JSON.stringify({role_id: 'Role#test', session_exp: Date.now() / 1000 + 3600, session_info: {refresh_token_exp: Date.now() / 1000 + 300}}))
    fs.writeFileSync(path.join(deployment, 'secrets/cubesigner-signer.env'), 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID="Key#test"\n')
    const steps = preparationSteps(spec, true)
    const session = steps.find(step => step.id === 'cubesigner-session')!
    expect(session).to.include({effect: 'cloud', retry: 'safe', stage: 'signer-session'})
    expect(steps.indexOf(session)).to.be.greaterThan(steps.findIndex(step => step.id === 'secrets'))
    expect(steps.indexOf(session)).to.be.greaterThan(steps.findIndex(step => step.id === 'proof-check'))
    const calls: {args: string[]; root: string}[] = []
    await new CommandPreparationRunner(async (root, _step, args) => {calls.push({args, root})}).run(session, spec, deployment, {} as PreparationPlan)
    expect(calls).to.deep.equal([])
    delete spec.signing.cubesigner
    expect(preparationSteps(spec, true).map(step => step.id)).not.to.include('cubesigner-session')
  })

  it('stops session creation on failure and retries without replaying completed preparation', async () => {
    const spec = fixture()
    spec.signing = {...spec.signing, cubesigner: {}}
    fs.writeFileSync(path.join(root, 'intent.yaml'), yaml.dump(spec))
    await createPreparationPlan({output: deployment, sdkDirectory: sdk, spec: path.join(root, 'intent.yaml'), staged: true})
    const calls: string[] = []
    let failRefresh = true
    const runner = {async run(step: {id: string}) {
      calls.push(step.id)
      if (step.id === 'cubesigner-session' && failRefresh) throw new Error('CubeSigner login required')
    }}
    for (const stage of PREPARATION_STAGES.slice(0, PREPARATION_STAGES.indexOf('signer-session'))) await applyPreparation(deployment, runner, undefined, {stage})
    calls.length = 0
    expect((await applyPreparation(deployment, runner, undefined, {stage: 'signer-session'})).status).to.equal('failed')
    expect(calls).to.deep.equal(['cubesigner-session'])
    await rejected(() => applyPreparation(deployment, runner, undefined, {stage: 'upload-secrets'}), 'Prerequisite signer-session')
    calls.length = 0
    failRefresh = false
    expect((await applyPreparation(deployment, runner, undefined, {stage: 'signer-session'})).nextStage).to.equal('upload-secrets')
    expect(calls).to.deep.equal(['cubesigner-session'])
    calls.length = 0
    await applyPreparation(deployment, runner, undefined, {stage: 'signer-session'})
    expect(calls).to.deep.equal([])
    expect((await applyPreparation(deployment, runner, undefined, {stage: 'upload-secrets'})).status).to.equal('prepared')
    expect(calls).to.deep.equal(['secret-upload', 'cubesigner-secret-upload'])
  })

  it('defers only signer credentials and resumes without repeating completed uploads or funding', async () => {
    const spec = fixture()
    spec.signing = {...spec.signing, cubesigner: {}}
    fs.writeFileSync(path.join(root, 'intent.yaml'), yaml.dump(spec))
    await createPreparationPlan({output: deployment, sdkDirectory: sdk, spec: path.join(root, 'intent.yaml'), staged: true})
    const calls: string[] = []
    const runner = {async run(step: {id: string}) {calls.push(step.id)}}
    for (const stage of PREPARATION_STAGES) await applyPreparation(deployment, runner, undefined, {deferCubesigner: true, stage})
    expect(calls).not.include('cubesigner-session')
    expect(calls).not.include('cubesigner-secret-upload')
    expect(calls).include('secret-upload')
    const saved = JSON.parse(fs.readFileSync(path.join(deployment, '.scrollsdk/state.json'), 'utf8'))
    expect(saved.deferred).deep.equal(['cubesigner-session', 'cubesigner-secret-upload'])
    expect(saved.steps['cubesigner-session']).not.equal('completed')
    calls.length = 0
    await applyPreparation(deployment, runner, undefined, {stage: 'signer-session'})
    const complete = await applyPreparation(deployment, runner, undefined, {stage: 'upload-secrets'})
    expect(calls).deep.equal(['cubesigner-session', 'cubesigner-secret-upload'])
    expect(complete.deferred).deep.equal([])
    expect(complete.status).equal('prepared')
  })

  it('waits for both CubeSigner Secret inputs before uploading anything', async () => {
    const spec = fixture()
    spec.signing = {...spec.signing, cubesigner: {}}
    spec.infrastructure.aws = {accountId: '123456789012', eksClusterName: 'test-cluster', region: 'us-east-1'}
    spec.preparation!.secretUpload = {awsRegion: 'us-east-1', provider: 'aws'}
    fs.mkdirSync(path.join(deployment, 'secrets'), {recursive: true})
    const calls: string[][] = []
    const runner = new CommandPreparationRunner(async (_root, _step, args) => {calls.push(args)})
    const step = preparationSteps(spec).find(step => step.id === 'secret-upload')!
    const run = () => runner.run(step, spec, deployment, {} as PreparationPlan)
    for (const name of ['cubesigner-signer-session.json', 'cubesigner-signer.env']) {
      let failure: unknown
      try {await run()} catch (error) {failure = error}
      expect(failure).to.be.instanceOf(AwaitingInput)
      expect(calls).to.deep.equal([])
      fs.writeFileSync(path.join(deployment, 'secrets', name), 'NONFUNCTIONAL_TEST_INPUT')
    }

    await run()
    expect(calls[0][0]).to.equal('push-secrets')
    calls.length = 0
    fs.writeFileSync(path.join(deployment, 'secrets/cubesigner-signer-session.json'), '')
    let failure: unknown
    try {await run()} catch (error) {failure = error}
    expect(failure).to.be.instanceOf(AwaitingInput)
    expect(calls).to.deep.equal([])
  })

  it('uploads to the same cluster-scoped prefix used by generated references', async () => {
    const spec = fixture()
    const plan = await makePlan()
    fs.mkdirSync(path.join(deployment, 'secrets'), {recursive: true})
    for (const name of ['cubesigner-signer-session.json', 'cubesigner-signer.env']) fs.writeFileSync(path.join(deployment, 'secrets', name), 'NONFUNCTIONAL_TEST_INPUT')
    spec.infrastructure = {...spec.infrastructure, aws: {accountId: '123456789012', eksClusterName: 'test-cluster', region: 'us-east-1'}, namespace: 'partner', provider: 'aws'}
    spec.preparation!.secretUpload = {provider: 'aws'}
    const calls: string[][] = []
    const runner = new CommandPreparationRunner(async (_root, _step, args) => {calls.push(args)})
    await runner.run(preparationSteps(spec).find(step => step.id === 'secret-upload')!, spec, deployment, plan)
    expect(calls[0][calls[0].indexOf('--aws-prefix') + 1]).to.equal(`dogeos/test-cluster/partner/${spec.metadata.name}`)
    delete spec.preparation!.secretUpload
    await runner.run(preparationSteps(spec, true).find(step => step.id === 'secret-upload')!, spec, deployment, plan)
    expect(calls[1]).to.deep.equal([...calls[0].slice(0, 2), '--exclude-cubesigner', ...calls[0].slice(2)])
    spec.preparation!.secretUpload = {provider: 'aws'}
    spec.preparation!.secretUpload.awsPrefix = 'conflicting'
    spec.infrastructure.aws!.secretsPrefix = 'another'
    expect(() => validatePreparation(spec)).to.throw('must match')
  })

  it('shares the infrastructure target with Secret upload and monitoring Secret apply', async () => {
    const spec = fixture()
    const plan = await makePlan()
    fs.mkdirSync(path.join(deployment, 'secrets'), {recursive: true})
    for (const name of ['cubesigner-signer-session.json', 'cubesigner-signer.env']) fs.writeFileSync(path.join(deployment, 'secrets', name), 'NONFUNCTIONAL_TEST_INPUT')
    spec.infrastructure.aws = {accountId: '123456789012', eksClusterName: 'test-cluster', region: 'us-east-1'}
    spec.infrastructure.kubeContext = 'selected-cluster'
    spec.infrastructure.namespace = 'selected-namespace'
    spec.preparation!.secretUpload = {awsRegion: 'us-east-1', provider: 'aws'}
    const calls: string[][] = []
    const runner = new CommandPreparationRunner(async (_root, _step, args) => {calls.push(args)})
    await runner.run(preparationSteps(spec).find(step => step.id === 'secret-upload')!, spec, deployment, plan)
    expect(calls).to.have.length(2)
    for (const args of calls) {
      expect(args[args.indexOf('--kube-context') + 1]).to.equal('selected-cluster')
      expect(args[args.indexOf('--namespace') + 1]).to.equal('selected-namespace')
    }

    expect(calls[1][0]).to.equal('monitoring-secrets')
  })

  it('rejects incomplete cloud destinations before any resources are created', () => {
    const spec = fixture()
    spec.preparation!.secretUpload = {awsPrefix: 'explicit-local-test', provider: 'aws'}
    expect(() => validatePreparation(spec)).to.throw('explicit region')
    spec.preparation!.secretUpload.awsRegion = 'us-west-2'
    expect(() => validatePreparation(spec)).not.to.throw()
    spec.preparation!.proofMaterials = {mockWorkerImage: 'example.invalid/mock:test', mode: 'mock'}
    expect(() => validatePreparation(spec)).to.throw('S3 proof artifact store')
    spec.proofArtifacts = {s3: {bucket: 'test-proof-bucket', endpointUrl: 'https://s3.example.invalid', keyPrefix: 'proof', region: 'us-west-2'}}
    spec.proofTopology!.active!.artifactStore = {kind: 's3_compatible'}
    expect(() => validatePreparation(spec)).not.to.throw()
  })

  it('marks automatic kit publication as a cloud effect and routes it through the explicit apply command', async () => {
    const spec = fixture()
    spec.proofTopology!.enforcement = 'enforce'
    spec.preparation!.deploymentKitPublication = {awsProfile: 'fixture-profile', mode: 's3'}
    const step = preparationSteps(spec, true).find(step => step.id === 'deployment-kit-published')!
    expect(step).to.include({effect: 'cloud', stage: 'signer-kit-publish'})
    const calls: string[][] = []
    await new CommandPreparationRunner(async (_root, _step, args) => {calls.push(args)}).run(step, spec, deployment, {} as PreparationPlan)
    expect(calls).to.deep.equal([['publish-deployment-kit', '--apply', '--aws-profile', 'fixture-profile']])
    delete spec.preparation!.deploymentKitPublication
    expect(preparationSteps(spec, true).find(step => step.id === 'deployment-kit-published')!.effect).to.equal('local')
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
    expect(steps.map(step => step.id).slice(-4)).to.deep.equal(['secrets', 'deployment-kit', 'deployment-kit-published', 'proof-check'])
    fs.mkdirSync(path.join(deployment, '.data'), {recursive: true})
    fs.writeFileSync(path.join(deployment, '.data/proof-materials-v1.json'), '{}')
    await runner.run(steps.find(step => step.id === 'charts-published')!, spec, deployment, plan)
    expect(calls[1]).to.include.members(['prep-charts', '--proof-materials-receipt', '.data/proof-materials-v1.json', '--proof-publication-receipt', '.data/proof-program-publication-v1.json'])
    expect(calls[1]).not.to.include('--proof-preparation')
    const chartStep = steps.find(step => step.id === 'charts-published')!
    spec.identities!.bootnodes = []
    for (const id of ['charts', 'charts-published']) {
      await runner.run({...chartStep, id, stage: 'proof-materials'}, spec, deployment, plan)
      expect(calls.at(-1)).to.include('--proof-preparation')
    }

    fs.writeFileSync(path.join(deployment, 'config.public.toml'), '[general]\nCHAIN_ID_L2 = 221122\n')
    fs.writeFileSync(path.join(deployment, 'config-contracts.toml'), 'L2_MOAT_PROXY_ADDR = "0x0000000000000000000000000000000000000001"\n')
    await runner.run({...chartStep, id: 'render-final', stage: 'render'}, spec, deployment, plan)
    expect(fs.existsSync(path.join(deployment, 'values/scroll-common-config-contracts.yaml'))).to.equal(true)
    expect(fs.existsSync(path.join(deployment, 'values/scroll-common-config.yaml'))).to.equal(true)
    expect(calls.at(-1)).not.to.include('--proof-preparation')
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

  it('prepares Grafana before proof compilation and keeps the bound config stable through secret generation', async () => {
    const spec = fixture()
    const plan = await makePlan()
    const file = path.join(deployment, '.data/doge-config.toml')
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.mkdirSync(path.join(deployment, 'values'), {recursive: true})
    fs.writeFileSync(file, toml.stringify({bootnodeReth: {instances: [{index: 0}]}}))
    fs.writeFileSync(path.join(deployment, 'values/scroll-monitor-production.yaml'), 'grafana:\n  enabled: true\n  admin:\n    existingSecret: grafana-admin\n')
    let compiled = ''
    const runner = new CommandPreparationRunner(async (_root, _step, args) => {
      if (args[0] === 'prep-charts') {
        compiled = fs.readFileSync(file, 'utf8')
        expect((toml.parse(compiled).grafana as any).adminPassword).to.have.length(32)
      } else if (args[0] === 'gen-secrets') {
        expect(fs.readFileSync(file, 'utf8')).to.equal(compiled)
      }
    })
    const steps = preparationSteps(spec)
    await runner.run(steps.find(step => step.id === 'charts')!, spec, deployment, plan)
    const first = compiled
    await runner.run(steps.find(step => step.id === 'secrets')!, spec, deployment, plan)
    await runner.run(steps.find(step => step.id === 'charts')!, spec, deployment, plan)
    expect(compiled).to.equal(first)
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

  it('runs actual bootstrap and identity commands with signer public keys and Helm tuning from the frozen spec', async () => {
    const input = yaml.load(fs.readFileSync(path.join(root, 'intent.yaml'), 'utf8')) as DeploymentSpec
    input.helmValues = {'l2-reth-rpc-production.yaml': 'resources: {requests: {cpu: 500m, memory: 2Gi}}'}
    fs.writeFileSync(path.join(root, 'intent.yaml'), yaml.dump(input))
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
    const values = yaml.load(fs.readFileSync(path.join(deployment, 'values/l2-reth-rpc-production.yaml'), 'utf8')) as any
    expect(values.resources.requests).deep.eq({cpu: '500m', memory: '2Gi'})
    expect(frozen.helmValues).deep.eq(input.helmValues)
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
  it('normalizes pasted txids and decimal output indices before RPC and persistence', async () => {
    const f = fixtureTx()
    for (const prefix of ['', '0x', '0X']) {
      const result = await inspectFunding({txid: ` ${prefix}${f.point.txid.toUpperCase()} `, vout: ' 0 '}, f.request, async (method, args) => {
        if (method === 'gettxout') expect(args).to.deep.equal([f.point.txid, 0, true])
        if (method === 'getrawtransaction') expect(args).to.deep.equal([f.point.txid, true])
        return f.rpc(method, args)
      })
      expect(result.txid).to.equal(f.point.txid)
      expect(result.vout).to.equal(0)
    }
  })
  it('rejects malformed txids and non-integer or out-of-range indices before RPC', async () => {
    const f = fixtureTx()
    const noRpc: Rpc = async () => {throw new Error('Invalid funding input must not query RPC')}
    for (const txid of [null, 123, '', '0x' + 'a'.repeat(63), 'g'.repeat(64), '0x0x' + 'a'.repeat(64)]) {
      await rejected(() => inspectFunding({txid, vout: 0}, f.request, noRpc), 'Funding txid')
    }

    for (const vout of ['', ' ', '0.0', '1e2', '0x0', '-1', '4294967296', -1, 0.5, 4_294_967_296, null, false, [], {}]) {
      await rejected(() => inspectFunding({txid: f.point.txid, vout}, f.request, noRpc), 'Funding vout')
    }
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
