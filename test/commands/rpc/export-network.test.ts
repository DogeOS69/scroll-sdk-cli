import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {DogeConfig} from '../../../src/types/doge-config.js'

import {NetworkConfigExporter, discoverNetworkNlbDomains} from '../../../src/commands/rpc/export-network.js'
import {fixture} from '../../fixtures/existing-nlb.js'

const writeYaml = (file: string, value: unknown) => fs.writeFileSync(file, yaml.dump(value))
const publicPeer = `enode://${'1'.repeat(128)}@bootnode.example.invalid:30303`

describe('rpc export-network', () => {
  let tmp: string
  let root: string
  let values: string
  let exporter: NetworkConfigExporter
  let doge: DogeConfig
  let env: Record<string, string>

  const read = (file: string, network = 'testnet') => fs.readFileSync(path.join(root, network, 'config', file), 'utf8')
  const writeL1 = () => writeYaml(path.join(values, 'l1-interface-production.yaml'), {configMaps: {env: {data: env}}, image: {repository: 'example.invalid/l1', tag: 'v8'}})
  const run = () => exporter.exportNetworkConfig(values, doge, root, {}, 'default')

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-export-network-test-'))
    root = path.join(tmp, 'package')
    values = path.join(tmp, 'values')
    fs.mkdirSync(values, {recursive: true})
    exporter = Object.assign(Object.create(NetworkConfigExporter.prototype), {log() {}, warn() {}})
    for (const network of ['testnet', 'mainnet']) {
      const dir = path.join(root, network)
      fs.mkdirSync(path.join(dir, 'config'), {recursive: true})
      fs.mkdirSync(path.join(dir, 'scripts'), {recursive: true})
      fs.writeFileSync(path.join(dir, 'env.example'), '# operator template\n')
      fs.writeFileSync(path.join(dir, '.env'), 'DATA_ROOT=/operator/data\n')
      for (const script of ['l1-interface_entrypoint.sh', 'l2reth_entrypoint.sh']) fs.writeFileSync(path.join(dir, 'scripts', script), '# package script\n')
      writeYaml(path.join(dir, 'docker-compose.yml'), {services: {'l1-interface': {image: 'example.invalid/l1:test'}, 'l2reth-node': {image: 'example.invalid/l2:test'}}})
      fs.writeFileSync(path.join(dir, 'config', 'dogecoin.conf'), 'server=1\n')
    }

    doge = {
      ethereumDa: {blobArchive: {s3: {enabled: true, keyPrefix: 'batches', publicBaseUrl: 'https://archive.example.invalid'}}},
      network: 'testnet',
    } as DogeConfig
    env = {
      DOGEOS_L1_INTERFACE_DATABASE_URL: 'sqlite:///cluster/old.sqlite',
      DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__BRIDGE_ADDRESS: 'example-bridge-address',
      DOGEOS_L1_INTERFACE_DOGECOIN_RPC__PASS: 'fake-do-not-export',
      DOGEOS_L1_INTERFACE_DOGECOIN_RPC__URL: 'http://private-dogecoin:44555',
      DOGEOS_L1_INTERFACE_ETHEREUM_DA__L1_RPC_URL: 'https://user:fake-password@provider.example.invalid?key=fake',
      DOGEOS_L1_INTERFACE_NETWORK_STR: 'testnet',
      DOGEOS_L1_INTERFACE_REPLAY_READ__ENABLED: 'true',
      DOGEOS_L1_INTERFACE_REPLAY_READ__PROTOCOL_CONTEXT_JSON: '/cluster/context.json',
      DOGEOS_L1_INTERFACE_REPLAY_READ__SQLITE_PATH: '/cluster/replay.sqlite',
      DOGEOS_L1_INTERFACE_SEQUENCER_GENESIS_MODE: 'true',
    }
    writeL1()
    writeYaml(path.join(values, 'l2-reth-rpc-production.yaml'), {image: {repository: 'example.invalid/rollup', tag: 'v2'}, reth: {
      l1Url: 'http://cluster-private-l1:8545', networkId: 6_281_971, trustedPeers: publicPeer,
    }})
    writeYaml(path.join(values, 'genesis.yaml'), {scrollConfig: JSON.stringify({config: {chainId: 6_281_971, scroll: {l1Config: {l1ChainId: 11_155_111, numL1MessagesPerBlock: 10, startL1Block: 0, systemContractAddress: '0x2000000000000000000000000000000000000001'}}}})})
    writeYaml(path.join(values, 'protocol_context.yaml'), {protocolContext: JSON.stringify({chain_id: 6_281_971})})
  })

  afterEach(() => fs.rmSync(tmp, {force: true, recursive: true}))

  it('uses explicit spec NLB selection even when saved Helm values predate activation', () => {
    const f = fixture()
    f.values.reth.p2pExternal.enabled = false
    f.files['l2-reth-bootnode-production-0.yaml'] = yaml.dump(f.values)
    expect(discoverNetworkNlbDomains(f.files, f.spec, f.aws)).to.deep.equal({
      'l2-reth-bootnode-0-p2p': ['198.51.100.10'],
    })
    expect(f.calls.every((args: string[]) => /^(describe-|get-caller-identity)/.test(args[1]))).to.equal(true)
    f.entry.enabled = false
    const reads = f.calls.length
    expect(discoverNetworkNlbDomains(f.files, f.spec, f.aws)).to.deep.equal({})
    expect(f.calls.length).to.equal(reads)
  })

  it('exports chain config and source images with package paths; repeat is identical', () => {
    const compose = fs.readFileSync(path.join(root, 'testnet/docker-compose.yml'), 'utf8')
    const files = run()
    expect(files).to.have.length(5)
    expect(files.slice(0, 4).every(file => file.startsWith(path.join(root, 'testnet/config')))).to.equal(true)
    expect(files[4]).to.equal(path.join(root, 'testnet/docker-compose.yml'))
    expect(read('l1-interface.env')).to.include("DATABASE_URL='sqlite:///data/l1-interface.sqlite'")
    expect(read('l1-interface.env')).to.include("SQLITE_PATH='/data/replay.sqlite'")
    expect(read('l1-interface.env')).to.include("PROTOCOL_CONTEXT_JSON='/app/protocol_context.json'")
    expect(read('l1-interface.env')).to.include("EVENT_PLANE_ARTIFACT_PATH='/data/l1-interface-historical-artifact.sqlite'")
    expect(read('l1-interface.env')).to.include("SEQUENCER_GENESIS_MODE='false'")
    expect(read('l1-interface.env')).not.to.include('fake-password')
    expect(read('l1-interface.env')).not.to.include('fake-do-not-export')
    expect(read('l1-interface.env')).not.to.include('private-dogecoin')
    expect(read('l1-interface.env')).to.include('example-bridge-address')
    expect(read('l2reth.env')).to.include('L2RETH_PEER_LIST=')
    expect(read('l2reth.env')).not.to.include('L2GETH_')
    expect(read('l2reth.env')).to.include("L2RETH_L1_ENDPOINT='http://l1-interface:8545'")
    expect(read('l2reth.env')).to.include("L2RETH_L1_READY_URL='http://l1-interface:9090/api/v1/health/ready'")
    expect(JSON.parse(read('l2reth-genesis.json')).config.chainId).to.equal(6_281_971)
    expect(JSON.parse(read('protocol_context.json')).chain_id).to.equal(6_281_971)
    const before = files.map(file => fs.readFileSync(file, 'utf8'))
    run()
    expect(files.map(file => fs.readFileSync(file, 'utf8'))).to.deep.equal(before)
    const expectedCompose = yaml.load(compose) as {services: Record<string, {image: string}>}
    expectedCompose.services['l1-interface'].image = 'example.invalid/l1:v8'
    expectedCompose.services['l2reth-node'].image = 'example.invalid/rollup:v2'
    expect(yaml.load(fs.readFileSync(path.join(root, 'testnet/docker-compose.yml'), 'utf8'))).to.deep.equal(expectedCompose)
    expect(fs.readFileSync(path.join(root, 'testnet/.env'), 'utf8')).to.equal('DATA_ROOT=/operator/data\n')
    expect(read('dogecoin.conf')).to.equal('server=1\n')
    expect(fs.readdirSync(path.join(root, 'mainnet/config'))).to.deep.equal(['dogecoin.conf'])
    expect(fs.existsSync(path.join(root, 'envs'))).to.equal(false)
    expect(fs.existsSync(path.join(root, 'configs'))).to.equal(false)
  })

  it('fails before overwriting output if protocol context is missing or peers cannot be resolved', () => {
    run()
    const before = read('l2reth.env')
    fs.unlinkSync(path.join(values, 'protocol_context.yaml'))
    expect(run).to.throw('protocol_context.yaml not found')
    expect(read('l2reth.env')).to.equal(before)
    writeYaml(path.join(values, 'l2-reth-rpc-production.yaml'), {reth: {networkId: 6_281_971, trustedPeers: 'enode://example@<LoadBalancer-Domain-For-l2-reth-bootnode-0>:30303'}})
    expect(run).to.throw('Unresolved external bootnode peers')
    expect(read('l2reth.env')).to.equal(before)
  })

  it('pins image digests and preserves Compose comments, anchors, scripts and other services', () => {
    const composePath = path.join(root, 'testnet/docker-compose.yml')
    const original = [
      '# package header',
      'x-logging: &logging',
      '  driver: json-file',
      'services:',
      '  dogecoin-node:',
      '    image: example.invalid/doge:unchanged',
      '  l1-interface:',
      '    image: old/l1:placeholder # replace placeholder',
      '    logging: *logging',
      '    command: |',
      '      echo "$$KEEP_THIS"',
      '  l2reth-node:',
      '    image: old/rollup:placeholder',
      '    logging: *logging',
      '',
    ].join('\n')
    fs.writeFileSync(composePath, original)
    const source = path.join(values, 'l2-reth-rpc-production.yaml')
    const reth = yaml.load(fs.readFileSync(source, 'utf8')) as Record<string, unknown>
    reth.image = {digest: `sha256:${'a'.repeat(64)}`, repository: 'registry.example.invalid:5000/rollup', tag: 'unused-tag'}
    writeYaml(source, reth)
    run()
    const expected = original.replace('old/l1:placeholder # replace placeholder', '"example.invalid/l1:v8"')
      .replace('old/rollup:placeholder', `"registry.example.invalid:5000/rollup@sha256:${'a'.repeat(64)}"`)
    expect(fs.readFileSync(composePath, 'utf8')).to.equal(expected)
  })

  it('rejects missing or invalid source image versions before writing any output', () => {
    const files = run()
    const before = files.map(file => fs.readFileSync(file, 'utf8'))
    const source = path.join(values, 'l1-interface-production.yaml')
    for (const image of [{repository: 'example.invalid/l1'}, {digest: 'invalid', repository: 'example.invalid/l1'}, {repository: 'example.invalid/l1', tag: `\${IMAGE_TAG}`}]) {
      writeYaml(source, {configMaps: {env: {data: env}}, image})
      expect(run).to.throw('l1-interface-production.yaml: image.')
      expect(files.map(file => fs.readFileSync(file, 'utf8'))).to.deep.equal(before)
    }
  })

  it('rejects mismatched networks, unsupported layouts and symlink outputs', () => {
    env.DOGEOS_L1_INTERFACE_NETWORK_STR = 'mainnet'
    writeL1()
    expect(run).to.throw('NETWORK_STR must match')
    expect(fs.existsSync(path.join(root, 'testnet/config/l2reth.env'))).to.equal(false)
    doge.network = 'regtest'
    expect(run).to.throw('testnet/mainnet')
    doge.network = 'testnet'
    fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(root, 'testnet/config/l2reth.env'))
    expect(run).to.throw('symlink')
  })

  it('prepares mainnet artifacts only from mainnet input without copying testnet history', () => {
    doge.network = 'mainnet'
    env.DOGEOS_L1_INTERFACE_NETWORK_STR = 'mainnet'
    env.DOGEOS_L1_INTERFACE_EVENT_PLANE_GENESIS_BOUNDARY = '1234'
    writeL1()
    expect(run).to.throw('historical bootstrap settings')
    delete env.DOGEOS_L1_INTERFACE_EVENT_PLANE_GENESIS_BOUNDARY
    writeL1()
    run()
    expect(read('l1-interface.env', 'mainnet')).to.include("NETWORK_STR='mainnet'")
    expect(read('l1-interface.env', 'mainnet')).not.to.include('EVENT_PLANE_ARTIFACT_PATH')
    expect(fs.readdirSync(path.join(root, 'testnet/config'))).to.deep.equal(['dogecoin.conf'])
  })

  it('rejects empty peers, missing blob archive and credential-bearing exported URLs without exposing values', () => {
    env.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL = 'https://archive.example.invalid?token=fake-private-value'
    writeL1()
    expect(run).to.throw('parameterized URL')
    try { run() } catch (error) { expect(String(error)).not.to.include('fake-private-value') }
    delete env.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL
    writeL1()
    doge.ethereumDa = undefined
    expect(run).to.throw('requires ethereumDa.blobArchive.s3')
  })

  it('accepts the released L1 Interface bitcoin label only for Dogecoin mainnet and preserves it', () => {
    env.DOGEOS_L1_INTERFACE_NETWORK_STR = 'bitcoin'
    writeL1()
    expect(run).to.throw('NETWORK_STR must match')
    doge.network = 'mainnet'
    run()
    expect(read('l1-interface.env', 'mainnet')).to.include("NETWORK_STR='bitcoin'")
    expect(fs.existsSync(path.join(root, 'bitcoin'))).to.equal(false)
  })

  it('rejects an empty public peer set and an old-layout package without writing config', () => {
    writeYaml(path.join(values, 'l2-reth-rpc-production.yaml'), {reth: {networkId: 6_281_971, trustedPeers: ''}})
    expect(run).to.throw('At least one public bootnode')
    expect(fs.existsSync(path.join(root, 'testnet/config/l2reth.env'))).to.equal(false)
    fs.unlinkSync(path.join(root, 'testnet/docker-compose.yml'))
    expect(run).to.throw('use rpc export for the old layout')
  })

  it('rejects placeholder and malformed enodes before changing existing output', () => {
    run()
    const before = read('l2reth.env')
    for (const peer of ['<TODO>', 'enode://example@bootnode.example.invalid:30303', `enode://${'1'.repeat(128)}@localhost:30303`]) {
      writeYaml(path.join(values, 'l2-reth-rpc-production.yaml'), {reth: {networkId: 6_281_971, trustedPeers: peer}})
      expect(run).to.throw('Invalid public enode')
      expect(read('l2reth.env')).to.equal(before)
    }
  })

  it('resolves both real network Compose files using generated config (opt-in local checkout)', function () {
    const source = process.env.RPC_PACKAGE_SOURCE
    if (!source) this.skip()
    const stubBin = path.join(tmp, 'bin')
    fs.mkdirSync(stubBin)
    fs.writeFileSync(path.join(stubBin, 'kubectl'), '#!/bin/sh\nexit 1\n', {mode: 0o700})
    // Only committed package assets are read; never copy the operator .env,
    // secrets, data or ignored files from the real checkout.
    for (const network of ['testnet', 'mainnet'] as const) {
      for (const file of ['docker-compose.yml', 'env.example', 'config/dogecoin.conf', 'scripts/l1-interface_entrypoint.sh', 'scripts/l2reth_entrypoint.sh']) {
        const content = execFileSync('git', ['-C', source!, 'show', `HEAD:${network}/${file}`])
        fs.writeFileSync(path.join(root, network, file), content)
      }

      doge.network = network
      env.DOGEOS_L1_INTERFACE_NETWORK_STR = network
      writeL1()
      run()
      const config = path.join(tmp, 'doge-config.toml')
      fs.writeFileSync(config, `network = "${network}"\n[wallet]\npath = "unused-fixture-wallet"\n[ethereumDa.blobArchive.s3]\nenabled = true\npublicBaseUrl = "https://archive.example.invalid"\nkeyPrefix = "batches"\n`)
      const output = execFileSync(process.execPath, [path.resolve('bin/run.js'), 'rpc', 'export-network', '-d', root,
        '--doge-config', config, '--values-dir', values, '--namespace', 'default', '--kube-context', 'fixture-only'], {
        encoding: 'utf8', env: {...process.env, PATH: `${stubBin}:${process.env.PATH}`},
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(output).to.include(`Generated ${path.join(root, network, 'config', 'l2reth.env')}`)
      expect(output).not.to.include('fake-do-not-export')
      const rendered = JSON.parse(execFileSync('docker', ['compose', '--project-directory', path.join(root, network),
        '-f', path.join(root, network, 'docker-compose.yml'), '--env-file', path.join(root, network, '.env'), 'config', '--format', 'json'], {
        encoding: 'utf8', env: {DOGECOIN_RPC_PASSWORD: 'fake-password', DOGECOIN_RPC_USER: 'fake-user', HOME: tmp, PATH: process.env.PATH},
        stdio: ['ignore', 'pipe', 'pipe'],
      }))
      expect(rendered.services['l1-interface'].image).to.equal('example.invalid/l1:v8')
      expect(rendered.services['l2reth-node'].image).to.equal('example.invalid/rollup:v2')
      const l1 = rendered.services['l1-interface'].environment
      const l2 = rendered.services['l2reth-node'].environment
      expect(l1.DOGEOS_L1_INTERFACE_DATABASE_URL).to.equal('sqlite:///data/l1-interface.sqlite')
      expect(l1.DOGEOS_L1_INTERFACE_NETWORK_STR).to.equal(network)
      expect(l2.L2RETH_L1_ENDPOINT).to.equal('http://l1-interface:8545')
      expect(JSON.parse(l2.L2RETH_PEER_LIST)).to.deep.equal([publicPeer])
      expect(l2.L2GETH_PEER_LIST).to.equal(undefined)
    }
  })
})
