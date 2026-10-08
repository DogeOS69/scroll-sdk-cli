/* eslint-disable @typescript-eslint/no-explicit-any -- Test deployment fixtures */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import {Wallet} from 'ethers'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import sinon from 'sinon'

import Archive from '../../../src/commands/setup/eth-da-submitter.js'
import GenKeystore, {keystorePrompts, planKeystore} from '../../../src/commands/setup/gen-keystore.js'
import {JsonOutputContext} from '../../../src/utils/json-output.js'
import {KmsSignerProvisioner} from '../../../src/utils/kms-signer-provisioner.js'

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const key = '0x' + '11'.repeat(32)
const {address} = new Wallet(key)

describe('unified keystore preparation', () => {
  let originalCwd: string
  let directory: string
  let logs: sinon.SinonStub
  let cloud: sinon.SinonStub
  let archive: sinon.SinonStub
  const read = () => toml.parse(fs.readFileSync('.data/doge-config.toml', 'utf8')) as any
  const save = (extra: any = {}) => fs.writeFileSync('.data/doge-config.toml', toml.stringify({network: 'regtest', wallet: {path: '.data/wallet.json'}, ...extra}))
  const run = (args: string[] = []) => GenKeystore.run([...args, '-N', '--json'], CLI_ROOT)
  beforeEach(() => {
    originalCwd = process.cwd()
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-keystore-'))
    process.chdir(directory)
    fs.mkdirSync('.data')
    save()
    fs.writeFileSync('config.toml', toml.stringify({accounts: {OWNER_ADDR: address}}))
    logs = sinon.stub(console, 'log')
    cloud = sinon.stub(KmsSignerProvisioner.prototype, 'provision').rejects(new Error('Unexpected cloud operation'))
    archive = sinon.stub(KmsSignerProvisioner.prototype, 'provisionArchive').rejects(new Error('Unexpected archive operation'))
  })
  afterEach(() => {
    sinon.restore()
    process.chdir(originalCwd)
    fs.rmSync(directory, {force: true, recursive: true})
  })

  function mockPrompts(services: string[] = ['sequencer-reth', 'bootnode-reth', 'fee-oracle', 'eth-da-submitter']) {
    const checkbox = sinon.stub(keystorePrompts, 'checkbox').resolves(services)
    const input = sinon.stub(keystorePrompts, 'input').callsFake(((options: any) => Promise.resolve(options.default || '1')) as any)
    const select = sinon.stub(keystorePrompts, 'select').callsFake(((options: any) => Promise.resolve(options.choices[0].value)) as any)
    const password = sinon.stub(keystorePrompts, 'password').rejects(new Error('Unexpected private key prompt'))
    return {checkbox, input, password, select}
  }

  it('defaults a fresh empty owner to the generated deployer and preserves it on rerun', async () => {
    fs.writeFileSync('config.toml', toml.stringify({accounts: {OWNER_ADDR: ''}}))
    await run(['--accounts'])
    const first = toml.parse(fs.readFileSync('config.toml', 'utf8')).accounts as any
    expect(first.OWNER_ADDR).to.equal(new Wallet(first.DEPLOYER_PRIVATE_KEY).address)
    expect(toml.parse(fs.readFileSync('config.public.toml', 'utf8')).accounts).not.to.have.property('DEPLOYER_PRIVATE_KEY')
    await run(['--accounts'])
    expect(toml.parse(fs.readFileSync('config.toml', 'utf8')).accounts).to.deep.equal(first)
  })

  it('preserves an explicit external owner and warns that signing access is unverified', async () => {
    await run(['--accounts'])
    expect((toml.parse(fs.readFileSync('config.toml', 'utf8')).accounts as any).OWNER_ADDR).to.equal(address)
    expect(logs.args.flat().join(' ')).to.include('no matching local owner/deployer private key')
  })

  it('rejects the zero owner before preparing any selected service', async () => {
    fs.writeFileSync('config.toml', toml.stringify({accounts: {OWNER_ADDR: '0x' + '0'.repeat(40)}}))
    const before = fs.readFileSync('.data/doge-config.toml', 'utf8')
    let error: any
    try {await run(['--accounts'])} catch (error_) {error = error_}
    expect(error?.message).to.include('nonzero EVM address')
    expect(fs.readFileSync('.data/doge-config.toml', 'utf8')).to.equal(before)
  })

  it('bare execution offers all four services and prompts for fresh node counts and backends', async () => {
    const prompts = mockPrompts()
    await GenKeystore.run([], CLI_ROOT)
    expect(prompts.checkbox.calledOnce).to.equal(true)
    expect(prompts.input.callCount).to.equal(2)
    const config = read()
    expect(config.sequencerReth.instances).to.have.length(1)
    expect(config.bootnodeReth.instances).to.have.length(1)
    expect(config.signers.l2GasOracleSender.backend).to.equal('local')
    expect(config.signers.l1CommitSender.backend).to.equal('local')
    expect(prompts.select.callCount).to.equal(8)
    const before = fs.readFileSync('.data/doge-config.toml', 'utf8')
    prompts.select.resetHistory()
    prompts.input.resetHistory()
    await GenKeystore.run([], CLI_ROOT)
    expect(fs.readFileSync('.data/doge-config.toml', 'utf8')).to.equal(before)
    expect(prompts.select.called || prompts.input.called || prompts.password.called).to.equal(false)
    expect(cloud.called || archive.called).to.equal(false)
  })

  it('prompts to import the key for an existing service address without replacing the address', async () => {
    fs.writeFileSync('config.toml', toml.stringify({accounts: {L2_GAS_ORACLE_SENDER_ADDR: address}}))
    const prompts = mockPrompts(['fee-oracle'])
    prompts.password.resolves(key)
    await GenKeystore.run([], CLI_ROOT)
    expect(prompts.password.calledOnce).to.equal(true)
    expect(prompts.select.called).to.equal(false)
    expect(read().accounts.L2_GAS_ORACLE_SENDER_ADDR).to.equal(address)
    expect(logs.args.flat().join(' ')).not.to.contain(key)
  })

  it('validates an interactively imported key before any selected service is written', async () => {
    save({accounts: {L2_GAS_ORACLE_SENDER_ADDR: address}})
    const before = fs.readFileSync('.data/doge-config.toml', 'utf8')
    const mainBefore = fs.readFileSync('config.toml', 'utf8')
    mockPrompts(['sequencer-reth', 'fee-oracle']).password.resolves('0x' + '22'.repeat(32))
    let error: any
    try {await GenKeystore.run([], CLI_ROOT)} catch (error_) {error = error_}
    expect(error?.message).to.contain('do not match')
    expect(fs.readFileSync('.data/doge-config.toml', 'utf8')).to.equal(before)
    expect(fs.readFileSync('config.toml', 'utf8')).to.equal(mainBefore)
    expect(cloud.called).to.equal(false)
  })

  it('cancels the entire interactive plan before writing when a later prompt is aborted', async () => {
    const prompts = mockPrompts()
    prompts.input.onSecondCall().rejects(new Error('User cancelled'))
    const before = fs.readFileSync('.data/doge-config.toml', 'utf8')
    const mainBefore = fs.readFileSync('config.toml', 'utf8')
    let error: any
    try {await GenKeystore.run([], CLI_ROOT)} catch (error_) {error = error_}
    expect(error?.message).to.contain('User cancelled')
    expect(fs.readFileSync('.data/doge-config.toml', 'utf8')).to.equal(before)
    expect(fs.readFileSync('config.toml', 'utf8')).to.equal(mainBefore)
  })

  it('keeps JSON and noninteractive runs prompt-free and reports accounts-only work explicitly', async () => {
    const prompts = mockPrompts()
    await GenKeystore.run(['--json'], CLI_ROOT)
    expect(JSON.parse(logs.lastCall.args[0]).data.identities).to.deep.equal([])
    await GenKeystore.run(['-N'], CLI_ROOT)
    expect(logs.args.flat().join(' ')).to.contain('0 service identity task(s)')
    expect(Object.values(prompts).some(prompt => prompt.called)).to.equal(false)
  })

  it('collects KMS inputs for a new signer before invoking the provider', async () => {
    const prompts = mockPrompts(['fee-oracle'])
    prompts.select.resolves('aws-kms')
    prompts.input.onCall(0).resolves('us-east-1')
    prompts.input.onCall(1).resolves('dev-cluster')
    prompts.input.onCall(2).resolves('devnet')
    prompts.input.onCall(3).resolves('chain')
    cloud.resolves({address, signerConfig: {backend: 'aws_kms', expectedAddress: address, kmsKeyId: 'key-id', kmsRegion: 'us-east-1'}})
    await GenKeystore.run([], CLI_ROOT)
    expect(cloud.calledOnce).to.equal(true)
    expect(cloud.firstCall.args[1]).to.include({awsRegion: 'us-east-1', eksCluster: 'dev-cluster', namespace: 'chain', networkAlias: 'devnet'})
    expect(archive.called || prompts.password.called).to.equal(false)
  })

  it('prepares all configured local services and reuses their identities without generating legacy Geth material', async () => {
    const archiveConfig = {blobArchive: {s3: {bucket: 'untouched', enabled: false, region: 'us-east-1'}}}
    save({bootnodeReth: {instances: [{index: 2}]}, ethereumDa: archiveConfig, sequencerReth: {instances: [{index: 0}]}, signers: {
      l1CommitSender: {backend: 'local'}, l2GasOracleSender: {backend: 'local'},
    }})
    await run()
    const first = read()
    expect(first.sequencerReth.instances[0].signer.address).to.equal(new Wallet(first.sequencerReth.instances[0].signer.privateKey).address)
    expect(first.bootnodeReth.instances.map((i: any) => i.index)).to.deep.equal([2])
    expect(first.ethereumDa).to.deep.equal(archiveConfig)
    const accounts = toml.parse(fs.readFileSync('config.toml', 'utf8')).accounts as any
    expect(accounts.DEPLOYER_ADDR).to.equal(new Wallet(accounts.DEPLOYER_PRIVATE_KEY).address)
    expect(accounts.L2_GAS_ORACLE_SENDER_ADDR).to.equal(first.accounts.L2_GAS_ORACLE_SENDER_ADDR)
    await run()
    expect(read()).to.deep.equal(first)
    expect((toml.parse(fs.readFileSync('config.toml', 'utf8')).accounts as any).DEPLOYER_ADDR).to.equal(accounts.DEPLOYER_ADDR)
    expect(fs.existsSync('.data/deployment-state.yaml')).to.equal(false)
    expect(fs.readFileSync('config.toml', 'utf8')).not.to.contain('L2GETH_')
    expect(cloud.called || archive.called).to.equal(false)
    expect(fs.statSync('.data/doge-config.toml').mode % 0o1000).to.equal(0o600)
    const output = logs.args.map(args => args.join(' ')).join('\n')
    expect(output).not.to.contain(first.accounts.L1_COMMIT_SENDER_PRIVATE_KEY)
    expect(output).not.to.contain(first.sequencerReth.instances[0].nodekey.privateKey)
    expect(fs.readFileSync('config.public.toml', 'utf8')).not.to.contain(accounts.DEPLOYER_PRIVATE_KEY)
  })

  it('only prepares the selected service and imports an existing local key', async () => {
    await run(['--service', 'fee-oracle', '--signer-private-key', key])
    const config = read()
    expect(config.accounts.L2_GAS_ORACLE_SENDER_ADDR).to.equal(address)
    expect(config.sequencerReth).to.equal(undefined)
    expect(config.signers.l1CommitSender).to.equal(undefined)
    expect((toml.parse(fs.readFileSync('config.toml', 'utf8')).accounts as any).DEPLOYER_PRIVATE_KEY).to.equal(undefined)
  })

  it('repairs a missing address from an existing key without replacing it', async () => {
    save({accounts: {L2_GAS_ORACLE_SENDER_PRIVATE_KEY: key}})
    await run(['--service', 'fee-oracle'])
    expect(read().accounts).to.deep.equal({L2_GAS_ORACLE_SENDER_ADDR: address, L2_GAS_ORACLE_SENDER_PRIVATE_KEY: key})
  })

  it('validates all selected identities before writing or provisioning', async () => {
    save({accounts: {L2_GAS_ORACLE_SENDER_ADDR: new Wallet('0x' + '22'.repeat(32)).address, L2_GAS_ORACLE_SENDER_PRIVATE_KEY: key}, sequencerReth: {instances: [{index: 0}]}})
    const before = fs.readFileSync('.data/doge-config.toml', 'utf8')
    let error: any
    try {await run()} catch (error_) {error = error_}
    expect(error?.message).to.contain('do not match')
    expect(fs.readFileSync('.data/doge-config.toml', 'utf8')).to.equal(before)
    expect(cloud.called).to.equal(false)
  })

  it('creates missing KMS identity without archive changes and reads the same identity on rerun', async () => {
    cloud.resolves({address, keyArn: 'arn:aws:kms:us-east-1:123456789012:key/test', signerConfig: {
      backend: 'aws_kms', expectedAddress: address, kmsKeyId: 'alias/existing', kmsRegion: 'us-east-1',
      role: 'L1_COMMIT_SENDER', service: 'eth-da-submitter', serviceAccountRoleArn: 'arn:aws:iam::123456789012:role/submitter',
    }})
    save({ethereumDa: {blobArchive: {s3: {bucket: 'existing-archive', enabled: true, region: 'us-east-1'}}}})
    await run(['--service', 'eth-da-submitter', '--signer-backend', 'aws-kms', '--aws-region', 'us-east-1', '--eks-cluster', 'devnet', '--network-alias', 'devnet'])
    expect(cloud.callCount).to.equal(1)
    expect(cloud.firstCall.args[2].archive.enabled).to.equal(false)
    const first = read()
    expect(first.accounts.L1_COMMIT_SENDER_PRIVATE_KEY).to.equal(undefined)
    const inspect = sinon.stub(KmsSignerProvisioner.prototype, 'inspectAddress').returns(address)
    await run(['--service', 'eth-da-submitter'])
    expect(inspect.calledOnceWithExactly('us-east-1', 'alias/existing')).to.equal(true)
    expect(cloud.callCount).to.equal(1)
    expect(read()).to.deep.equal(first)
    expect(archive.called).to.equal(false)
  })

  it('keeps previously completed identities when a later provider fails', async () => {
    save({sequencerReth: {instances: [{index: 0}]}, signers: {l1CommitSender: {backend: 'aws_kms', eksCluster: 'devnet', kmsRegion: 'us-east-1', networkAlias: 'devnet'}}})
    try {await run()} catch { /* Expected provider failure after local node preparation. */ }
    const first = read().sequencerReth.instances[0]
    expect(first.signer.privateKey).to.match(/^0x[\da-f]{64}$/)
    await run(['--service', 'sequencer-reth'])
    expect(read().sequencerReth.instances[0]).to.deep.equal(first)
  })

  it('archive setup changes archive settings without touching signer identity', async () => {
    const signer = {backend: 'aws_kms', expectedAddress: address, kmsKeyId: 'alias/existing', kmsRegion: 'us-east-1', role: 'L1_COMMIT_SENDER', service: 'eth-da-submitter', serviceAccountRoleArn: 'arn:aws:iam::123456789012:role/submitter'}
    save({accounts: {L1_COMMIT_SENDER_ADDR: address}, signers: {l1CommitSender: signer}})
    archive.resolves()
    await Archive.run(['--archive-bucket', 'archive', '--archive-key-prefix', 'instance', '-N', '--json'], CLI_ROOT)
    expect(read().signers.l1CommitSender).to.deep.equal(signer)
    expect(read().accounts.L1_COMMIT_SENDER_ADDR).to.equal(address)
    expect(read().ethereumDa.blobArchive.s3.keyPrefix).to.equal('instance')
    expect(cloud.called).to.equal(false)
    expect(archive.firstCall.args[1]).to.deep.equal({createBucket: true, roleArn: signer.serviceAccountRoleArn})
  })

  it('reuses DeploymentSpec service inputs without rewriting unselected service identities', async () => {
    fs.writeFileSync('config.toml', toml.stringify({accounts: {L2_GAS_ORACLE_SENDER_ADDR: address, L2_GAS_ORACLE_SENDER_PRIVATE_KEY: key, OWNER_ADDR: address}, signers: {l1CommitSender: {backend: 'local', role: 'L1_COMMIT_SENDER', service: 'eth-da-submitter'}, l2GasOracleSender: {backend: 'local', role: 'L2_GAS_ORACLE_SENDER', service: 'fee-oracle'}}}))
    await run(['--service', 'fee-oracle'])
    expect(read().accounts.L2_GAS_ORACLE_SENDER_PRIVATE_KEY).to.equal(key)
    expect(read().signers.l1CommitSender).to.equal(undefined)
  })

  it('reuses an existing KMS sequencer and preserves its P2P identity', async () => {
    save({sequencerReth: {instances: [{index: 0, nodekey: {privateKey: key.slice(2), secretMode: 'external-secret'}, signer: {address, kmsKeyId: 'alias/custom', kmsRegion: 'us-east-1', mode: 'aws_kms'}}]}})
    const inspect = sinon.stub(KmsSignerProvisioner.prototype, 'inspectAddress').returns(address)
    await run(['--service', 'sequencer-reth'])
    expect(inspect.calledOnceWithExactly('us-east-1', 'alias/custom')).to.equal(true)
    expect(read().sequencerReth.instances[0].nodekey.privateKey).to.equal(key.slice(2))
    expect(read().sequencerReth.instances[0].signer.privateKey).to.equal(undefined)
    expect(cloud.called).to.equal(false)
  })

  it('honors the separate P2P Secret mode when creating a KMS sequencer', async () => {
    cloud.resolves({address, keyArn: 'arn:aws:kms:us-east-1:123456789012:key/test', roleArn: 'arn:aws:iam::123456789012:role/sequencer', serviceAccount: 'l2-reth-sequencer-0', signerConfig: {kmsKeyId: 'alias/seq', kmsRegion: 'us-east-1'}})
    await run(['--service', 'sequencer-reth', '--signer-backend', 'aws-kms', '--secret-mode', 'plain', '--aws-region', 'us-east-1', '--eks-cluster', 'devnet', '--network-alias', 'devnet'])
    const instance = read().sequencerReth.instances[0]
    expect(instance.signer.mode).to.equal('aws_kms')
    expect(instance.signer.privateKey).to.equal(undefined)
    expect(instance.nodekey.secretMode).to.equal('plain')
    expect(instance.nodekey.privateKey).to.match(/^[\da-f]{64}$/)
    expect(archive.called).to.equal(false)
  })

  it('rejects implicit rotation and unresolved private keys without leaking them', async () => {
    save({accounts: {L2_GAS_ORACLE_SENDER_ADDR: address, L2_GAS_ORACLE_SENDER_PRIVATE_KEY: key}})
    const before = fs.readFileSync('.data/doge-config.toml', 'utf8')
    for (const privateKey of ['0x' + '22'.repeat(32), '$ENV:UNSET_KEYSTORE_TEST_KEY']) {
      let error: any
      try {await run(['--service', 'fee-oracle', '--signer-private-key', privateKey])} catch (error_) {error = error_}
      expect(error).to.be.instanceOf(Error)
      expect(error.message).not.to.contain(privateKey)
      expect(fs.readFileSync('.data/doge-config.toml', 'utf8')).to.equal(before)
    }
  })

  it('disabling archive never invokes AWS or changes signer configuration', async () => {
    save({accounts: {L1_COMMIT_SENDER_ADDR: address, L1_COMMIT_SENDER_PRIVATE_KEY: key}, ethereumDa: {blobArchive: {s3: {bucket: 'archive', enabled: true}}}})
    await Archive.run(['--disable-archive', '-N', '--json'], CLI_ROOT)
    expect(read().ethereumDa.blobArchive.s3.enabled).to.equal(false)
    expect(read().accounts.L1_COMMIT_SENDER_PRIVATE_KEY).to.equal(key)
    expect(archive.called || cloud.called).to.equal(false)
  })

  it('plans configured instances without shrinking or sharing one supplied key across instances', () => {
    expect(() => planKeystore({bootnodeReth: {instances: [{index: 3}]}}, {'bootnode-count': 1})).to.throw('does not remove')
    expect(() => planKeystore({}, {'sequencer-count': 2, service: 'sequencer-reth', 'signer-private-key': key})).to.throw('exactly one')
    expect(() => planKeystore({}, {service: 'bootnode-reth', 'signer-backend': 'aws-kms'})).to.throw('only need a local')
    expect(planKeystore({}, {})).to.deep.equal([])
  })

  it('archive provisioning only calls S3 and its own IAM policy, never KMS or trust updates', async () => {
    archive.restore()
    const provisioner: any = new KmsSignerProvisioner(new JsonOutputContext('test', true))
    sinon.stub(provisioner, 'ensureS3Bucket').returns(false)
    const aws = sinon.stub(provisioner, 'awsJson').returns({})
    await provisioner.provisionArchive({bucket: 'archive', created: false, enabled: true, keyPrefix: 'mainnet/batches', region: 'us-east-1'}, {createBucket: true, roleArn: 'arn:aws:iam::123456789012:role/path/submitter', sidecarStore: {bucket: 'proofs', keyPrefix: 'mainnet/proofs'}})
    expect(aws.callCount).to.equal(1)
    expect(aws.firstCall.args[0].slice(0, 4)).to.deep.equal(['iam', 'put-role-policy', '--role-name', 'submitter'])
    expect(aws.firstCall.args[0]).to.include('eth-da-submitter-s3-archive')
    // Scoped to the DA prefix and the proof sidecar namespace, never the whole bucket.
    const policy = JSON.parse(aws.firstCall.args[0].at(-1))
    expect(policy.Statement.map((statement: {Resource: string}) => statement.Resource)).to.deep.equal([
      'arn:aws:s3:::archive/mainnet/batches/*',
      'arn:aws:s3:::proofs/mainnet/proofs/scroll-chunk-segmentation-sidecars/*',
    ])
  })
})
