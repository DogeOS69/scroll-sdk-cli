/* eslint-disable @typescript-eslint/no-explicit-any -- Integration fixtures exercise dynamic deployment TOML and provider boundaries. */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import {Wallet} from 'ethers'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import sinon from 'sinon'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import GenKeystore from '../../src/commands/setup/gen-keystore.js'
import Generate from '../../src/commands/setup/generate-from-spec.js'
import {generateAllConfigs, validateDeploymentSpec} from '../../src/utils/deployment-spec-generator.js'
import {KmsSignerProvisioner} from '../../src/utils/kms-signer-provisioner.js'
import {mergeBootstrapValues, planSpecBootstrap} from '../../src/utils/spec-bootstrap.js'
import {resolveSpecIdentities} from '../../src/utils/spec-identities.js'

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
function fixture(): DeploymentSpec {
  const spec = yaml.load(fs.readFileSync(path.join(cliRoot, 'src/config/deployment-spec.minimal.yaml'), 'utf8')
    .replaceAll('$ENV:OWNER_ADDRESS', '0x0000000000000000000000000000000000000001')
    .replaceAll(/\$ENV:[A-Z_a-z]\w*/g, 'NONFUNCTIONAL_TEST_PLACEHOLDER')) as DeploymentSpec
  spec.infrastructure = {aws: {accountId: '123456789012', eksClusterName: 'test-cluster', region: 'us-west-2'}, bootnodeCount: 1, provider: 'aws', sequencerCount: 2}
  spec.identities = {
    bootnodes: [{index: 0, nodekey: {action: 'create'}}],
    ethDaSubmitter: {action: 'create', backend: 'local'},
    feeOracle: {action: 'create', backend: 'local'},
    sequencers: [0, 1].map(index => ({index, nodekey: {action: 'create'}, signer: {action: 'create', backend: 'local'}})),
  }
  return spec
}

describe('spec identity and template workflow', () => {
  let directory: string
  let originalCwd: string
  let logs: sinon.SinonStub
  let cloud: sinon.SinonStub
  const read = (): any => toml.parse(fs.readFileSync('.data/doge-config.toml', 'utf8'))
  const run = (...args: string[]) => GenKeystore.run(['--no-accounts', '-N', '--json', ...args], cliRoot)
  beforeEach(() => {
    originalCwd = process.cwd()
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-workflow-'))
    process.chdir(directory)
    logs = sinon.stub(console, 'log')
    cloud = sinon.stub(KmsSignerProvisioner.prototype, 'provision').rejects(new Error('Unexpected AWS operation'))
    sinon.stub(KmsSignerProvisioner.prototype, 'provisionArchive').rejects(new Error('Unexpected archive operation'))
  })
  afterEach(() => {
    sinon.restore()
    delete process.env.SPEC_WORKFLOW_IMPORT_KEY
    process.chdir(originalCwd)
    fs.rmSync(directory, {force: true, recursive: true})
  })
  async function generate(spec: DeploymentSpec): Promise<void> {
    fs.writeFileSync('intent.yaml', yaml.dump(spec))
    await Generate.run(['--spec', 'intent.yaml', '--with-values', '--json'], cliRoot)
  }

  it('generates without resources, plans without keys, applies mixed local identities and preserves them on rerun', async () => {
    const spec = fixture()
    const imported = Wallet.createRandom()
    process.env.SPEC_WORKFLOW_IMPORT_KEY = imported.privateKey
    spec.identities!.sequencers[1].signer = {action: 'import', backend: 'local', expectedAddress: imported.address, privateKeyEnv: 'SPEC_WORKFLOW_IMPORT_KEY'}
    await generate(spec)
    expect(cloud.called).to.equal(false)
    const before = fs.readFileSync('.data/doge-config.toml', 'utf8')
    expect(before).not.to.include(imported.privateKey)
    await run('--plan')
    logs.resetHistory()
    await GenKeystore.run(['--plan', '--no-accounts'], cliRoot)
    expect(JSON.stringify(logs.args)).to.include('identityIntent')
    expect(fs.readFileSync('.data/doge-config.toml', 'utf8')).to.equal(before)
    await run()
    const prepared = read()
    expect(prepared.sequencerReth.instances).to.have.length(2)
    expect(prepared.bootnodeReth.instances).to.have.length(1)
    expect(prepared.sequencerReth.instances[1].signer.address).to.equal(imported.address)
    expect(prepared.accounts.L1_COMMIT_SENDER_ADDR).to.match(/^0x[\dA-Fa-f]{40}$/)
    await run('--from-spec', 'intent.yaml')
    expect(read()).to.deep.equal(prepared)
    expect(JSON.stringify(logs.args)).not.to.include(imported.privateKey)
    expect(cloud.called).to.equal(false)
    expect(fs.statSync('.data/doge-config.toml').mode.toString(8).slice(-3)).to.equal('600')
  })

  it('keeps explicit account-only preparation separate from saved service identity intent', async () => {
    const spec = fixture()
    spec.identities!.feeOracle = {action: 'create', backend: 'aws_kms'}
    await generate(spec)
    await GenKeystore.run(['--accounts', '-N', '--json'], cliRoot)
    expect(cloud.called).to.equal(false)
    expect(read().sequencerReth?.instances ?? []).to.have.length(0)
    const main = toml.parse(fs.readFileSync('config.toml', 'utf8')) as any
    expect(main.accounts.DEPLOYER_ADDR).to.match(/^0x[\dA-Fa-f]{40}$/)
  })

  it('rejects undeclared node indices and conflicting flags before creating identities', async () => {
    await generate(fixture())
    const before = fs.readFileSync('.data/doge-config.toml', 'utf8')
    for (const args of [['--service', 'sequencer-reth', '--index', '3'], ['--service', 'fee-oracle', '--signer-backend', 'aws-kms'], ['--service', 'sequencer-reth', '--index', '0', '--signer-mode', 'aws-kms'], ['--service', 'fee-oracle', '--kms-key-id', 'unexpected-key']]) {
      let failed = false
      try {await run(...args)} catch {failed = true}
      expect(failed).to.equal(true)
      expect(fs.readFileSync('.data/doge-config.toml', 'utf8')).to.equal(before)
    }

    expect(cloud.called).to.equal(false)
  })

  it('applies new KMS intent once and passes recorded key/role references on retry', async () => {
    const spec = fixture()
    spec.identities!.feeOracle = {action: 'create', backend: 'aws_kms'}
    const {address} = Wallet.createRandom()
    cloud.callsFake(async (role: any, identity: any, input: any) => {
      const kmsKeyId = input.kmsKeyId ?? 'alias/dogeos/test/fee-oracle'
      const roleArn = input.roleArn ?? 'arn:aws:iam::123456789012:role/test-fee-oracle'
      return {address, keyArn: 'arn:aws:kms:us-west-2:123456789012:key/test', roleArn,
        signerConfig: {backend: 'aws_kms', eksCluster: identity.eksCluster, expectedAddress: address, kmsKeyId, kmsRegion: identity.awsRegion, namespace: identity.namespace, networkAlias: identity.networkAlias, role: role.role, service: role.service, serviceAccountName: input.serviceAccount, serviceAccountRoleArn: roleArn}}
    })
    await generate(spec)
    expect(cloud.called).to.equal(false)
    await run('--service', 'fee-oracle')
    const first = read()
    expect(first.accounts.L2_GAS_ORACLE_SENDER_ADDR).to.equal(address)
    expect(first.accounts).not.to.have.property('L2_GAS_ORACLE_SENDER_PRIVATE_KEY')
    await run('--service', 'fee-oracle')
    expect(read()).to.deep.equal(first)
    expect(cloud.secondCall.args[2].kmsKeyId).to.equal(first.signers.l2GasOracleSender.kmsKeyId)
    expect(cloud.secondCall.args[2].roleArn).to.equal(first.signers.l2GasOracleSender.serviceAccountRoleArn)
  })

  it('requires complete KMS reuse and node declarations, and refuses unknown expected addresses', async () => {
    const spec = fixture()
    spec.identities!.feeOracle = {action: 'reuse', backend: 'aws_kms'}
    expect(validateDeploymentSpec(spec).valid).to.equal(false)
    spec.identities!.feeOracle.kms = {keyId: 'existing-key', roleArn: 'arn:aws:iam::123456789012:role/existing-role'}
    const {address} = Wallet.createRandom()
    spec.identities!.feeOracle.expectedAddress = address
    expect(resolveSpecIdentities(spec)!.feeOracle.kms!.region).to.equal('us-west-2')
    await generate(spec)
    cloud.callsFake(async () => ({address: Wallet.createRandom().address, signerConfig: {backend: 'aws_kms'}} as any))
    const before = read()
    let failed = false
    try {await run('--service', 'fee-oracle')} catch {failed = true}
    expect(failed).to.equal(true)
    expect(read().accounts).to.deep.equal(before.accounts)
    expect(read().signers).to.deep.equal(before.signers)
    spec.identities!.sequencers.pop()
    expect(validateDeploymentSpec(spec).valid).to.equal(false)
  })

  it('lists all missing bootstrap inputs without generating outputs', () => {
    const spec = fixture()
    delete spec.identities
    expect(() => planSpecBootstrap(spec)).to.throw('--sdk-dir')
    let message = ''
    try {planSpecBootstrap(spec)} catch (error) {message = (error as Error).message}
    for (const input of ['--sdk-dir', 'identities', 'proofTopology', 'images.services.l2Rpc.tag', 'images.services.l2Sequencer.tag', 'images.services.l2Bootnode.tag']) expect(message).to.include(input)
    expect(fs.readdirSync(directory)).to.deep.equal([])
  })

  it('preserves template policy defaults while applying generated deployment inputs', () => {
    const content = mergeBootstrapValues(yaml.dump({configMaps: {env: {data: {POLICY: 'hold', RPC: 'template'}}}, env: [{name: 'EXTRA', value: 'retained'}]}),
      yaml.dump({configMaps: {env: {data: {RPC: 'selected'}}}, env: [{name: 'RUST_LOG', value: 'info'}]}))
    const parsed = yaml.load(content) as any
    expect(parsed.configMaps.env.data).to.deep.equal({POLICY: 'hold', RPC: 'selected'})
    expect(parsed.env).to.have.length(2)
  })

  it('reads pinned templates instead of dirty files and adapts the Makefile to node counts', () => {
    const sdk = path.join(directory, 'sdk')
    fs.mkdirSync(sdk)
    const files = ['withdrawal-processor/WithdrawalProcessor.toml', 'proof-coordinator/ProofCoordinator.toml', 'values/scroll-monitor-production.yaml', 'values/metrics-exporter-production.yaml']
    for (const file of files) {fs.mkdirSync(path.dirname(path.join(sdk, 'examples', file)), {recursive: true}); fs.writeFileSync(path.join(sdk, 'examples', file), '# pinned fixture\n')}
    fs.writeFileSync(path.join(sdk, 'examples/Makefile.example'), 'REQUIRED = \\\n\tvalues/l2-reth-sequencer-production-0.yaml \\\n\tvalues/l2-reth-sequencer-production-1.yaml \\\n\tvalues/l2-reth-bootnode-production-0.yaml \\\n\tvalues/l2-reth-bootnode-production-1.yaml \\\n\tvalues/genesis.yaml\ninstall-l2-reth-sequencer:\n\t@true\ninstall-l2-reth-bootnode:\n\t@true\ndelete-l2-reth-sequencer:\n\t@true\ndelete-l2-reth-bootnode:\n\t@true\n')
    const git = (...args: string[]) => execFileSync('git', ['-C', sdk, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()
    git('init'); git('add', 'examples'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture')
    const spec = fixture()
    spec.templates = {sdkRevision: git('rev-parse', 'HEAD')}
    spec.proofTopology = {mode: 'disabled'} as any
    spec.images = {services: Object.fromEntries(['l2Rpc', 'l2Sequencer', 'l2Bootnode'].map(key => [key, {tag: 'explicit-test-release'}]))}
    fs.writeFileSync(path.join(sdk, 'examples/values/scroll-monitor-production.yaml'), '# dirty file must not be used\n')
    const explicit = planSpecBootstrap(spec, sdk)
    const revision = spec.templates.sdkRevision
    delete spec.templates
    const plan = planSpecBootstrap(spec, sdk)
    expect(plan).to.deep.equal(explicit)
    expect(plan['values/scroll-monitor-production.yaml']).to.equal('# pinned fixture\n')
    expect(plan.Makefile).to.include('for index in 0 1; do')
    expect(plan.Makefile).not.to.include('values/l2-reth-bootnode-production-1.yaml')
    expect(plan).not.to.have.property('values/genesis.yaml')
    expect(JSON.parse(plan['.data/spec-bootstrap.json']).sdkRevision).to.equal(revision)
    const main = generateAllConfigs(fixture())
    expect(main['doge-config.toml']).to.include('[identityIntent.feeOracle]')
  })
})
