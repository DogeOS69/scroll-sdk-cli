import * as toml from '@iarna/toml'
import {expect} from 'chai'
import {Wallet} from 'ethers'
import * as yaml from 'js-yaml'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {getRethBootnodeIndices} from '../../../src/commands/setup/bootnode-public-p2p.js'
import {isRetiredGethSecretFile} from '../../../src/commands/setup/push-secrets.js'
import {AWSNodeLBProvider} from '../../../src/providers/aws-node-public-p2p.js'
import {archiveRetiredGethValues} from '../../../src/utils/retired-geth.js'

const cli = path.resolve('bin/run.js')
const key = '0x' + '1'.repeat(64)
const {address} = new Wallet(key)

describe('pure Reth account generation', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reth-accounts-')) })
  afterEach(() => { fs.rmSync(dir, {force: true, recursive: true}) })

  function run(...args: string[]) {
    return spawnSync(process.execPath, [cli, 'setup', 'gen-keystore', '-N', '--json', ...args], {
      cwd: dir, encoding: 'utf8', timeout: 30_000,
    })
  }

  it('generates accounts without legacy node config and reuses them on a second run', () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), `[accounts]\nOWNER_ADDR = "${address}"\nDEPLOYER_PRIVATE_KEY = "${key}"\n`)
    const first = run()
    expect(first.status, first.stderr).to.equal(0)
    const content = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')
    const config = toml.parse(content)
    expect(config).to.have.keys('accounts')
    expect(config.accounts).to.include({DEPLOYER_ADDR: address, DEPLOYER_PRIVATE_KEY: key})
    expect(content).not.to.include('L2GETH')
    expect(first.stdout).not.to.include(key)
    expect(fs.existsSync(path.join(dir, '.data/deployment-state.yaml'))).to.equal(false)
    const second = run()
    expect(second.status, second.stderr).to.equal(0)
    expect(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')).to.equal(content)
  })

  it('preserves archived node keys without acting on them', () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), `[accounts]\nOWNER_ADDR = "${address}"\n[sequencer]\nL2GETH_NODEKEY = "archived"\n[bootnode.bootnode-0]\nL2GETH_NODEKEY = "archived-bootnode"\n`)
    const result = run()
    expect(result.status, result.stderr).to.equal(0)
    const content = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')
    expect(content).to.include('archived-bootnode')
    expect(content).not.to.include('L2GETH_KEYSTORE')
    expect(content).not.to.include('L2_GETH_STATIC_PEERS')
  })

  it('rejects mismatched account identity before writing any file', () => {
    const content = `[accounts]\nOWNER_ADDR = "${address}"\nDEPLOYER_ADDR = "0x2222222222222222222222222222222222222222"\nDEPLOYER_PRIVATE_KEY = "${key}"\n`
    fs.writeFileSync(path.join(dir, 'config.toml'), content)
    const result = run()
    expect(result.status).not.to.equal(0)
    expect(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')).to.equal(content)
  })

  it('does not replace an unresolved private-key reference with a random key', () => {
    const content = `[accounts]\nOWNER_ADDR = "${address}"\nDEPLOYER_PRIVATE_KEY = "$ENV:SCROLLSDK_TEST_MISSING_DEPLOYER_KEY"\n`
    fs.writeFileSync(path.join(dir, 'config.toml'), content)
    const result = run()
    expect(result.status).not.to.equal(0)
    expect(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')).to.equal(content)
  })

  it('runs the complete RPC package command with native Reth inputs and no Geth values', () => {
    const values = path.join(dir, 'values')
    const output = path.join(dir, 'rpc-package')
    const shim = path.join(dir, 'fixture-bin')
    for (const folder of [values, output, shim]) fs.mkdirSync(folder)
    // Explicit local kubectl fixture; this test never connects to a real cluster.
    fs.writeFileSync(path.join(shim, 'kubectl'), `#!/bin/sh\nprintf '{"items":[]}\\n'\n`, {mode: 0o700})
    fs.writeFileSync(path.join(dir, 'doge-config.toml'), toml.stringify({
      bootnodeReth: {instances: [{enodeUrl: 'enode://fixture@public.example:30303', index: 0}]}, network: 'testnet',
      sequencerReth: {instances: [{index: 0, signer: {address}}]},
      wallet: {path: 'unused.json'},
    }))
    fs.writeFileSync(path.join(dir, 'config.toml'), '[sequencer]\nL2GETH_SIGNER_ADDRESS = "0xarchived"\nL2_GETH_STATIC_PEERS = ["enode://old@old:30303"]\n')
    fs.writeFileSync(path.join(values, 'l2-reth-rpc-production.yaml'), yaml.dump({reth: {l1Url: 'http://reth-l1:8545', networkId: '221122'}}))
    fs.writeFileSync(path.join(values, 'l1-interface-production.yaml'), yaml.dump({configMaps: {env: {data: {DOGEOS_L1_INTERFACE_GENESIS_JSON_PATH: '/app/genesis/genesis.json'}}}}))
    fs.writeFileSync(path.join(values, 'protocol_context.yaml'), yaml.dump({protocolContext: JSON.stringify({fixture: true})}))
    fs.writeFileSync(path.join(values, 'genesis.yaml'), yaml.dump({scrollConfig: JSON.stringify({
      alloc: {}, config: {chainId: 221_122, scroll: {l1Config: {
        l1ChainId: 111_111, numL1MessagesPerBlock: 10, startL1Block: 0,
        systemContractAddress: '0x2000369731833cbf00e97146999442adf10a4e59',
      }}},
    })}))
    fs.writeFileSync(path.join(output, 'docker-compose.yml'), yaml.dump({services: {
      'l1-interface': {image: 'fixture/l1-interface'},
      'l2geth-node': {image: 'fixture/retired'},
      'l2reth-node': {image: 'fixture/reth'},
    }}))
    const result = spawnSync(process.execPath, [cli, 'setup', 'gen-rpc-package', '--doge-config', 'doge-config.toml', '-d', output, '-n', 'fixture'], {
      cwd: dir, encoding: 'utf8', env: {...process.env, PATH: `${shim}:${process.env.PATH}`},
      timeout: 30_000,
    })
    expect(result.status, result.stdout + result.stderr).to.equal(0)
    const env = fs.readFileSync(path.join(output, 'envs/testnet/l2reth.env'), 'utf8')
    expect(env).to.include(`L2RETH_VALID_SIGNER=${address}`)
    expect(env).to.include('L2RETH_L1_ENDPOINT=http://reth-l1:8545')
    expect(env).to.include('enode://fixture@public.example:30303')
    expect(env).not.to.include('archived')
    expect(env).not.to.include('enode://old')
    const genesis = JSON.parse(fs.readFileSync(path.join(output, 'configs/testnet/l2reth-genesis.json'), 'utf8'))
    expect(genesis.config.scroll.l1Config.startL1Block).to.equal(0)
    expect(fs.readFileSync(path.join(output, 'docker-compose.yml'), 'utf8')).not.to.include('l2geth-node')
  })

  it('makes --no-accounts a no-op and rejects retired node-generation flags', () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), '[general]\nCHAIN_ID_L2 = 123\n')
    expect(run('--no-accounts').status).to.equal(0)
    expect(run('--sequencer-count', '1').status).not.to.equal(0)
    expect(run('--bootnode-count', '1').status).not.to.equal(0)
    expect(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')).to.equal('[general]\nCHAIN_ID_L2 = 123\n')
  })
})

describe('pure Reth public P2P and secret selection', () => {
  it('uses actual Reth indices, including gaps, and rejects missing or duplicated topology', () => {
    expect(getRethBootnodeIndices({bootnodeReth: {instances: [{index: 3}, {index: 0}]}, network: 'testnet', wallet: {path: '.data/wallet.json'}})).to.deep.equal([0, 3])
    expect(() => getRethBootnodeIndices({network: 'testnet', wallet: {path: '.data/wallet.json'}})).to.throw('Configure unique Reth')
    expect(() => getRethBootnodeIndices({bootnodeReth: {instances: [{index: 0}, {index: 0}]}, network: 'testnet', wallet: {path: '.data/wallet.json'}})).to.throw('Configure unique Reth')
  })

  it('updates only indexed Reth values with chart-native public P2P services', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reth-p2p-'))
    try {
      fs.writeFileSync(path.join(dir, 'l2-bootnode-production-0.yaml'), 'legacy: untouched\n')
      for (const index of [0, 3]) fs.writeFileSync(path.join(dir, `l2-reth-bootnode-production-${index}.yaml`), 'reth:\n  ports:\n    p2p: 30304\n')
      const provider = new AWSNodeLBProvider() as unknown as {
        updateProductionFiles(dir: string, indices: number[], region: string, cluster: string): Promise<void>
      }
      await provider.updateProductionFiles(dir, [0, 3], 'us-east-1', 'test')
      for (const index of [0, 3]) {
        const values = yaml.load(fs.readFileSync(path.join(dir, `l2-reth-bootnode-production-${index}.yaml`), 'utf8')) as {reth: {service: {extra: {p2p: {ports: Record<string, {port: number}>; type: string}}}}}
        expect(values.reth.service.extra.p2p.type).to.equal('LoadBalancer')
        expect(values.reth.service.extra.p2p.ports['p2p-tcp'].port).to.equal(30_304)
      }

      expect(fs.readFileSync(path.join(dir, 'l2-bootnode-production-0.yaml'), 'utf8')).to.equal('legacy: untouched\n')
    } finally {
      fs.rmSync(dir, {force: true, recursive: true})
    }
  })

  it('archives retired deployable values without losing private material or touching Reth values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reth-archive-'))
    try {
      fs.writeFileSync(path.join(dir, 'l2-sequencer-production-0.yaml'), 'private: archived-key')
      fs.writeFileSync(path.join(dir, 'l2-reth-sequencer-production-0.yaml'), 'role: sequencer')
      const archived = archiveRetiredGethValues(dir)
      expect(archived).to.have.length(1)
      expect(archived[0]).to.match(/\.yaml\.bak$/)
      expect(fs.readFileSync(archived[0], 'utf8')).to.equal('private: archived-key')
      expect(fs.existsSync(path.join(dir, 'l2-reth-sequencer-production-0.yaml'))).to.equal(true)
      expect(archiveRetiredGethValues(dir)).to.deep.equal([])
    } finally {
      fs.rmSync(dir, {force: true, recursive: true})
    }
  })

  it('excludes retired node secret files while preserving Reth and application secrets', () => {
    for (const file of ['l2-sequencer-0-secret.env', 'secrets/l2-bootnode-2-secret.env', 'l2-sequencer-secret.env']) {
      expect(isRetiredGethSecretFile(file)).to.equal(true)
    }

    for (const file of ['l2-reth-sequencer-0-secret.env', 'l2-reth-bootnode-2-secret.env', 'contracts-secret.env']) {
      expect(isRetiredGethSecretFile(file)).to.equal(false)
    }
  })
})
