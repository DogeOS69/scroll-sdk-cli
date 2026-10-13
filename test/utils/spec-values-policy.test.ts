/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values integration fixtures. */
import bitcore from 'bitcore-lib-doge'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import sinon from 'sinon'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import Generate from '../../src/commands/setup/generate-from-spec.js'
import {reconcileDeploymentIngresses} from '../../src/utils/public-service-ingress.js'
import {mergeBootstrapValues} from '../../src/utils/spec-bootstrap.js'
import {createSdkFixture} from '../helpers/sdk-templates.js'

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const feeMode = 'DOGEOS_FEE_ORACLE_ETHEREUM_DA__CONTRACT_WRITE_MODE'
const read = (directory: string, name: string): any => yaml.load(fs.readFileSync(path.join(directory, 'values', `${name}-production.yaml`), 'utf8'))

describe('spec values runtime policy across entry points', () => {
  let root: string
  let sdk: string
  let cwd: string
  let revision: string
  let spec: DeploymentSpec
  beforeEach(() => {
    cwd = process.cwd()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-values-policy-'))
    sdk = path.join(root, 'scroll-sdk')
    revision = createSdkFixture(sdk)
    fs.mkdirSync(path.join(root, 'operator'))
    process.chdir(path.join(root, 'operator'))
    spec = yaml.load(fs.readFileSync(path.join(cli, 'test/fixtures/deployment-spec/minimal.yaml'), 'utf8')
      .replaceAll('$ENV:OWNER_ADDRESS', '0x0000000000000000000000000000000000000001')
      .replaceAll(/\$ENV:[A-Z_a-z]\w*/g, 'NONFUNCTIONAL_TEST_PLACEHOLDER')) as DeploymentSpec
    delete spec.feeOracle
    spec.contracts.feeVaultDogeRecipientAddress = new bitcore.PrivateKey(null, bitcore.Networks.testnet).toAddress().toString()
    spec.identities = {bootnodes: [{index: 0, nodekey: {action: 'create'}}], ethDaSubmitter: {action: 'create', backend: 'local'}, feeOracle: {action: 'create', backend: 'local'}, sequencers: [{index: 0, nodekey: {action: 'create'}, signer: {action: 'create', backend: 'local'}}]}
    spec.proofTopology = {active: {artifactStore: {kind: 'local_fs'}, profile: 'withdrawal_mock_prover', realScroll: {} as any, workerLaunch: 'local_cpu'}, compiler: {identityFilePath: '.data/compiler.json', image: {digest: `sha256:${'a'.repeat(64)}`, repository: 'example.invalid/compiler'}}, deployment: {proverPublicUrl: 'https://proof.example.invalid'}, enforcement: 'observe', generation: 'mock', mode: 'disabled', observeRealProofDeadlineMs: 1000}
    spec.images = {services: Object.fromEntries(['l2Rpc', 'l2Sequencer', 'l2Bootnode'].map(key => [key, {tag: 'explicit-test-release'}]))}
    sinon.stub(console, 'log')
  })
  afterEach(() => {
    sinon.restore()
    process.chdir(cwd)
    fs.rmSync(root, {force: true, recursive: true})
  })
  const run = async (mode: string, directory: string, ...args: string[]): Promise<void> => {
    fs.writeFileSync('deployment-spec.yaml', yaml.dump(spec))
    await Generate.run([mode, '--output', directory, '--json', ...args], cli)
  }

  for (const mode of ['--bootstrap', '--with-values', '--values-only']) it(`projects bootnode source restrictions through ${mode} and retains them on regeneration`, async () => {
    spec.infrastructure = {...spec.infrastructure, aws: {accountId: '123456789012', eksClusterName: 'fixture-cluster', region: 'us-east-1'}, bootnodeCount: 2, provider: 'aws'}
    spec.identities!.bootnodes.push({index: 1, nodekey: {action: 'create'}})
    spec.bootnodePublicP2p = [{eipAllocations: ['eipalloc-0123456789abcdef0'], enabled: true, index: 1, sourceRanges: ['203.0.113.10/32'], subnets: ['subnet-0123456789abcdef0']}]
    const directory = path.join(root, 'deployment')
    await run(mode, directory, '--sdk-dir', sdk)
    const file = path.join(directory, 'values/l2-reth-bootnode-production-1.yaml')
    const selected = yaml.load(fs.readFileSync(file, 'utf8')) as any
    expect(selected.reth.p2pExternal.sourceRanges).to.deep.equal(['203.0.113.10/32'])
    expect((yaml.load(fs.readFileSync(path.join(directory, 'values/l2-reth-bootnode-production-0.yaml'), 'utf8')) as any).reth.p2pExternal.enabled).to.equal(false)
    selected.resources = {requests: {cpu: '42m'}}
    fs.writeFileSync(file, yaml.dump(selected))
    await run(mode, directory, '--sdk-dir', sdk, '--force')
    expect((yaml.load(fs.readFileSync(file, 'utf8')) as any).resources).to.deep.equal(selected.resources)
    spec.bootnodePublicP2p = []
    await run(mode, directory, '--sdk-dir', sdk, '--force')
    expect((yaml.load(fs.readFileSync(file, 'utf8')) as any).reth.p2pExternal.enabled).to.equal(false)
  })

  for (const mode of ['--bootstrap', '--with-values', '--values-only']) it(`excludes L1 devnet from external Ethereum deployments through ${mode}`, async () => {
    spec.ethereumDa = {...spec.ethereumDa, chain: 'sepolia'}
    const directory = path.join(root, 'deployment')
    await run(mode, directory, '--sdk-dir', sdk)
    expect(fs.existsSync(path.join(directory, 'values/l1-devnet-production.yaml'))).to.equal(false)
    spec.ethereumDa.chain = 'mainnet'
    await run(mode, directory, '--sdk-dir', sdk, '--force')
    expect(fs.existsSync(path.join(directory, 'values/l1-devnet-production.yaml'))).to.equal(false)
  })

  for (const mode of ['--bootstrap', '--with-values', '--values-only']) it(`generates L1 devnet only on explicit selection through ${mode}`, async () => {
    spec.ethereumDa = {...spec.ethereumDa, chain: 'devnet'}
    const directory = path.join(root, 'deployment')
    await run(mode, directory, '--sdk-dir', sdk)
    const values = read(directory, 'l1-devnet')
    expect(values.ingress.main.enabled).to.equal(false)
    expect(() => reconcileDeploymentIngresses(values, 'l1-devnet')).not.to.throw()

    // An operator can opt in, and regeneration must retain that choice.
    values.ingress.main.enabled = true
    fs.writeFileSync(path.join(directory, 'values/l1-devnet-production.yaml'), yaml.dump(values))
    await run(mode, directory, '--sdk-dir', sdk, '--force')
    const enabled = read(directory, 'l1-devnet')
    expect(enabled.ingress.main.enabled).to.equal(true)
    expect(() => reconcileDeploymentIngresses(enabled, 'l1-devnet')).to.throw('certificate-arn')
  })

  for (const mode of ['--bootstrap', '--with-values', '--values-only']) it(`keeps public edge controller policy in templates and operator values through ${mode}`, async () => {
    spec.proofTopology!.mode = 'active'
    spec.frontend.hosts = {...spec.frontend.hosts, proofCoordinator: 'proof.example.invalid'}
    spec.proofCoordinator = {s3AuthMode: 'ambient'}
    spec.proofArtifacts = {s3: {bucket: 'example-proof-bucket', keyPrefix: 'proofs', region: 'us-east-1'}}
    const directory = path.join(root, 'deployment')
    await run(mode, directory, '--sdk-dir', sdk)
    for (const service of ['tso-service', 'proof-coordinator']) {
      const values = read(directory, service)
      expect(values.ingress.main.ingressClassName).to.equal('alb')
      expect(values.ingress.main.tls).to.equal(undefined)
      expect(values.ingress.main.annotations['alb.ingress.kubernetes.io/certificate-arn']).to.equal('<TODO>')
      values.ingress.main.ingressClassName = 'alb'
      values.ingress.main.annotations['alb.ingress.kubernetes.io/certificate-arn'] = 'operator-certificate'
      values.ingress.main.tls = [{secretName: 'operator-tls'}]
      fs.writeFileSync(path.join(directory, 'values', `${service}-production.yaml`), yaml.dump(values))
    }

    await run(mode, directory, '--sdk-dir', sdk, '--force')
    for (const service of ['tso-service', 'proof-coordinator']) {
      const {main} = read(directory, service).ingress
      expect(main.ingressClassName).to.equal('alb')
      expect(Object.keys(main.annotations).some(key => key.startsWith('nginx.'))).to.equal(false)
      expect(main.annotations['alb.ingress.kubernetes.io/certificate-arn']).to.equal('operator-certificate')
      expect(main.tls).to.equal(undefined)
    }
  })

  for (const mode of ['--bootstrap', '--with-values', '--values-only']) it(`reconciles the environment pending blob cap through ${mode}`, async () => {
    const key = 'DOGEOS_ETH_DA_SUBMITTER_PUBLISH__MAX_PENDING_BLOB_TXS'
    const template = path.join(sdk, 'examples/values/eth-da-submitter-production.yaml')
    const values = yaml.load(fs.readFileSync(template, 'utf8')) as any
    values.configMaps.env.data[key] = '4' // An older SDK must not override spec defaults.
    fs.writeFileSync(template, yaml.dump(values))
    const directory = path.join(root, 'deployment')
    await run(mode, directory, '--sdk-dir', sdk)
    expect(read(directory, 'eth-da-submitter').configMaps.env.data[key]).to.equal('10')
    spec.metadata.environment = 'mainnet'
    await run(mode, directory, '--force')
    expect(read(directory, 'eth-da-submitter').configMaps.env.data[key]).to.equal('8')
    spec.ethereumDa!.publish = {maxPendingBlobTxs: 12}
    await run(mode, directory, '--force')
    expect(read(directory, 'eth-da-submitter').configMaps.env.data[key]).to.equal('12')
  })

  it('uses identical committed policy in bootstrap, with-values and values-only using the conventional SDK path', async () => {
    fs.writeFileSync(path.join(sdk, 'examples/values/l2-reth-rpc-production.yaml'), 'reth: {extraArgs: []}\n')
    const outputs = []
    for (const mode of ['--bootstrap', '--with-values', '--values-only']) {
      const directory = path.join(root, mode.slice(2))
      await run(mode, directory)
      const rpc = read(directory, 'l2-reth-rpc')
      expect(rpc.reth.extraArgs).to.deep.equal(['--gpo.maxprice', '420000000000000', '--network.legacy-geth-header-transform', 'true'])
      expect(rpc.reth.networkId).to.equal(String(spec.network.l2ChainId))
      expect(rpc.image.tag).to.equal('explicit-test-release')
      expect(rpc.resources.requests.cpu).to.equal('3')
      const {sequencer} = read(directory, 'l2-reth-sequencer').reth
      expect(sequencer).to.include({allowEmptyBlocks: false, blockTimeMs: '2000', payloadBuildingDurationMs: '1400'})
      const da = read(directory, 'eth-da-submitter').configMaps.env.data
      expect(da.DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_UNCOMPRESSED_CHUNK_BYTES_SIZE).to.equal('123011')
      expect(da.DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_OPEN_L2_TIME).to.equal('2h')
      expect(da.DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__RPC_URL).to.equal(undefined)
      const fee = read(directory, 'fee-oracle').configMaps.env.data
      expect(fee.DOGEOS_FEE_ORACLE_ETHEREUM_DA__MIN_PRIORITY_FEE_PER_GAS_WEI).to.equal('100000000')
      expect(fee.DOGEOS_FEE_ORACLE_ETHEREUM_DA__ADVANCE_L2_ACCOUNTING__ENABLED).to.equal('false')
      expect(fee.DOGEOS_FEE_ORACLE_PRICE_ORACLE__CACHE_DURATION).to.equal('17')
      expect(fs.existsSync(path.join(directory, 'Makefile'))).to.equal(mode === '--bootstrap')
      expect(fs.existsSync(path.join(directory, 'config.toml'))).to.equal(mode !== '--values-only')
      if (mode === '--bootstrap') expect(JSON.parse(fs.readFileSync(path.join(directory, '.data/spec-bootstrap.json'), 'utf8')).sdkRevision).to.equal(revision)
      outputs.push({da, fee, rpc, sequencer})
    }

    expect(outputs[1]).to.deep.equal(outputs[0])
    expect(outputs[2]).to.deep.equal(outputs[0])
  })

  for (const mode of ['--bootstrap', '--with-values', '--values-only']) it(`preserves operator policy and applies explicit spec changes on repeated ${mode}`, async () => {
    const directory = path.join(root, 'deployment')
    await run(mode, directory, '--sdk-dir', sdk)
    const edit = (service: string, update: (values: any) => void): void => {
      const values = read(directory, service)
      update(values)
      fs.writeFileSync(path.join(directory, 'values', `${service}-production.yaml`), yaml.dump(values))
    }

    edit('l2-reth-sequencer', values => {
      values.reth.extraArgs = ['--gpo.maxprice', '420000000000001']
      Object.assign(values.reth.sequencer, {allowEmptyBlocks: true, blockTimeMs: '3000', payloadBuildingDurationMs: '1800'})
      values.reth.data.size = '2Ti'
      values.resources.requests.cpu = '5'
    })
    edit('l2-reth-rpc', values => {values.reth.extraArgs = []})
    edit('eth-da-submitter', values => {values.configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_OPEN_L2_TIME = '3h'})
    edit('fee-oracle', values => {values.configMaps.env.data[feeMode] = 'dry_run'})
    edit('frontends', values => {
      values.env.L1_INTERFACE_UPSTREAM = 'reviewed-proxy.namespace.svc:9090'
      values.command = ['/operator-reviewed-entrypoint.sh']
    })
    fs.writeFileSync(path.join(directory, 'values/scroll-monitor-production.yaml'), 'grafana: {enabled: true}\n')
    spec.network.l2ChainId = 123_456
    spec.genesis.gasLimit = 40_000_000
    spec.ethereumDa!.minPriorityFeeWei = '123456789'
    spec.ethereumDa!.l1RpcUrl = 'https://operator-selected.example.invalid'
    await run(mode, directory, '--force')
    const values = read(directory, 'l2-reth-sequencer')
    expect(values.reth.extraArgs).to.deep.equal(['--gpo.maxprice', '420000000000001'])
    expect(values.reth.sequencer).to.include({allowEmptyBlocks: true, blockTimeMs: '3000', payloadBuildingDurationMs: '1800'})
    expect(values.reth.data.size).to.equal('2Ti')
    expect(values.resources.requests.cpu).to.equal('5')
    expect(values.reth).to.include({builderGasLimit: '40000000', networkId: '123456'})
    expect(read(directory, 'l2-reth-rpc').reth.extraArgs).to.deep.equal([])
    const da = read(directory, 'eth-da-submitter').configMaps.env.data
    expect(da.DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_OPEN_L2_TIME).to.equal('3h')
    expect(da.DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__MIN_PRIORITY_FEE_WEI).to.equal('123456789')
    expect(da.DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__RPC_URL).to.equal(undefined)
    expect(read(directory, 'fee-oracle').configMaps.env.data[feeMode]).to.equal('dry_run')
    expect(read(directory, 'scroll-monitor').grafana.enabled).to.equal(true)
    expect(read(directory, 'frontends').env.L1_INTERFACE_UPSTREAM).to.equal('reviewed-proxy.namespace.svc:9090')
    expect(read(directory, 'frontends').command).to.deep.equal(['/operator-reviewed-entrypoint.sh'])
    const before = fs.readFileSync(path.join(directory, 'values/l2-reth-sequencer-production.yaml'), 'utf8')
    spec.feeOracle = {contractWriteMode: 'live'}
    await run(mode, directory, '--force')
    expect(fs.readFileSync(path.join(directory, 'values/l2-reth-sequencer-production.yaml'), 'utf8')).to.equal(before)
    expect(read(directory, 'fee-oracle').configMaps.env.data[feeMode]).to.equal('live')
  })

  it('keeps explicit dstack resource intent authoritative on regeneration', async () => {
    const output = path.join(root, 'deployment')
    spec.dstackController = {database: {type: 'sqlite'}, enabled: true, resources: {requests: {cpu: '2'}}}
    await run('--values-only', output)
    expect(read(output, 'dstack-controller').resources.requests.cpu).to.equal('2')
    spec.dstackController.resources = {requests: {cpu: '4'}}
    await run('--values-only', output, '--force')
    expect(read(output, 'dstack-controller').resources.requests.cpu).to.equal('4')
  })

  it('honors the explicit pinned revision even when SDK HEAD changes', async () => {
    const file = path.join(sdk, 'examples/values/l2-reth-rpc-production.yaml')
    fs.writeFileSync(file, 'reth: {extraArgs: []}\n')
    const git = (...args: string[]) => execFileSync('git', ['-C', sdk, ...args], {stdio: 'pipe'})
    git('add', 'examples'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Change fixture policy')
    spec.templates = {sdkRevision: revision}
    const output = path.join(root, 'pinned')
    await run('--values-only', output)
    expect(read(output, 'l2-reth-rpc').reth.extraArgs).to.include('--gpo.maxprice')
  })

  it('rejects unavailable or incomplete SDK policy templates before writing outputs', async () => {
    const output = path.join(root, 'must-not-exist')
    let error: unknown
    try {await run('--with-values', output, '--sdk-dir', path.join(root, 'absent'))} catch (error_) {error = error_}
    expect(String(error)).to.include('Cannot resolve SDK commit')
    expect(fs.existsSync(output)).to.equal(false)
    fs.unlinkSync(path.join(sdk, 'examples/values/fee-oracle-production.yaml'))
    const git = (...args: string[]) => execFileSync('git', ['-C', sdk, ...args], {stdio: 'pipe'})
    git('add', 'examples'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Incomplete fixture')
    try {await run('--values-only', output)} catch (error_) {error = error_}
    expect(String(error)).to.include('Pinned SDK revision lacks required templates')
    expect(String(error)).to.include('values/fee-oracle-production.yaml')
    expect(fs.existsSync(output)).to.equal(false)
  })

  it('preserves named environment entries and allows explicit resource intent to override policy', () => {
    const merged = yaml.load(mergeBootstrapValues('env: [{name: A, value: a}]\nresources: {requests: {cpu: 1}}',
      'env: [{name: B, value: b}]\nresources: {requests: {cpu: 3}}',
      'env: [{name: A, value: edited}]\nresources: {requests: {cpu: 2}}', ['resources'])) as any
    expect(merged.env).to.deep.equal([{name: 'A', value: 'edited'}, {name: 'B', value: 'b'}])
    expect(merged.resources.requests.cpu).to.equal(3)
  })
})
