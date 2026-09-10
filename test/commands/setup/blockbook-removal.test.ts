import * as toml from '@iarna/toml'
import * as bitcoin from 'bitcoinjs-lib'
import {expect} from 'chai'
import {execFile} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {promisify} from 'node:util'
import sinon from 'sinon'

import {fetchWalletUtxos} from '../../../src/commands/doge/wallet/sync.js'
import {dogecoinTestnet} from '../../../src/types/dogecoin.js'
import {broadcastTx, getUtxos, resolveElectrsUrl} from '../../../src/utils/dogeos-utils.js'
import {archiveRetiredServiceFiles, isRetiredServiceFile, stripRetiredServiceConfig} from '../../../src/utils/retired-services.js'

const execFileAsync = promisify(execFile)
const cli = path.resolve('bin/run.js')

describe('Blockbook removal', () => {
  let dir: string
  beforeEach(() => {dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexer-removal-'))})
  afterEach(() => {sinon.restore(); fs.rmSync(dir, {force: true, recursive: true})})

  it('completes fresh and existing setup without indexer prompts or projected settings', async () => {
    const fixture = path.join(dir, 'rpc-fixture.mjs')
    fs.writeFileSync(fixture, `import fs from 'node:fs';
      globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        if (options.method !== 'POST' || body.method !== 'getblockcount') throw new Error('Unexpected request');
        fs.appendFileSync('rpc-calls.log', body.method + '\\n');
        return new Response(JSON.stringify({result: 123, error: null}), {status: 200});
      };`)
    for (const existing of [false, true]) {
      fs.writeFileSync(path.join(dir, 'config.toml'), '[general]\nCHAIN_ID_L2 = 123\n[ingress]\nBLOCKBOOK_HOST = "old-indexer"\n')
      fs.mkdirSync(path.join(dir, '.data'), {recursive: true})
      if (existing) {
        fs.writeFileSync(path.join(dir, '.data/doge-config.toml'), toml.stringify({
          ethereumDa: {chain: 'devnet', chainId: 31_337},
          kubernetes: {blockbookPublicPort: 19_139, blockbookServiceName: 'old-indexer', serviceName: 'dogecoin-testnet'}, network: 'testnet',
          rpc: {apiKey: 'retired-key', blockbookAPIUrl: 'https://old-indexer', url: 'https://rpc.example'},
          wallet: {path: '.data/wallet.json'},
        }))
      }

      fs.writeFileSync(path.join(dir, '.data/setup_defaults.toml'), 'seed_string = "preserved"\ndogecoin_blockbook_url = "https://old-indexer"\ndogecoin_blockbook_api_key = "old-key"\n')
      const result = await execFileAsync(process.execPath, ['--import', fixture, cli, 'setup', 'doge-config', '-N', '--json'], {cwd: dir, timeout: 30_000})
      expect(result.stdout + result.stderr).not.to.include('Enter Internal Blockbook')
      expect(JSON.parse(result.stdout).success).to.equal(true)
      for (const file of ['config.toml', '.data/doge-config.toml', '.data/setup_defaults.toml']) {
        const content = fs.readFileSync(path.join(dir, file), 'utf8')
        expect(content.toLowerCase(), file).not.to.include('blockbook')
        expect(content, file).not.to.include('retired-key')
      }

      expect(fs.readFileSync(path.join(dir, '.data/setup_defaults.toml'), 'utf8')).to.include('seed_string = "preserved"')
      if (existing) {
        const saved = toml.parse(fs.readFileSync(path.join(dir, '.data/doge-config.toml'), 'utf8'))
        expect((saved.ethereumDa as toml.JsonMap).chainId).to.equal('31337')
      }
    }

    expect(fs.readFileSync(path.join(dir, 'rpc-calls.log'), 'utf8').trim().split('\n')).to.deep.equal(['getblockcount', 'getblockcount'])
  })

  it('removes runtime env and secret references without dropping unrelated credentials', () => {
    const source = {
      configMaps: {env: {data: {BLOCKBOOK_API_KEY: 'old', RPC_PASSWORD: 'keep'}}},
      env: [{name: 'DOGEOS_L1_INTERFACE_DOGECOIN_RPC__BLOCKBOOK_API_KEY', value: 'old'}, {name: 'KEEP', value: 'yes'}],
      externalSecrets: {env: {data: [{secretKey: 'BLOCKBOOK_API_KEY'}, {secretKey: 'RPC_PASSWORD'}]}},
      rpc: {apiKey: 'old', password: 'keep', url: 'http://rpc'},
    }
    const cleaned = stripRetiredServiceConfig(source)
    expect(JSON.stringify(cleaned)).not.to.include('BLOCKBOOK')
    expect(cleaned.rpc).to.deep.equal({password: 'keep', url: 'http://rpc'})
    expect(cleaned.env).to.have.length(1)
    expect(cleaned.externalSecrets.env.data).to.have.length(1)
    expect(source.rpc.apiKey).to.equal('old')
  })

  it('archives retired chart and secret files, preserving Blockscout and Reth', () => {
    for (const file of ['blockbook-production.yaml', 'blockbook-secret.env', 'bridge-history-api-production.yaml', 'bridge-history-fetcher-secret.env', 'chain-monitor-secret.env', 'l1-explorer-secret.env', 'blockscout-production.yaml', 'l2-reth-rpc-production.yaml']) fs.writeFileSync(path.join(dir, file), file)
    const backups = archiveRetiredServiceFiles(dir)
    expect(backups).to.have.length(6)
    expect(backups.every(file => file.endsWith('.bak'))).to.equal(true)
    expect(fs.existsSync(path.join(dir, 'blockbook-secret.env'))).to.equal(false)
    expect(fs.existsSync(path.join(dir, 'blockscout-production.yaml'))).to.equal(true)
    expect(isRetiredServiceFile('secrets/blockbook-secret.env')).to.equal(true)
    expect(isRetiredServiceFile('blockscout-secret.env')).to.equal(false)
    expect(archiveRetiredServiceFiles(dir)).to.deep.equal([])
  })

  it('uses only the configured Electrs endpoint and never falls back to testnet', async () => {
    const requests: string[] = []
    sinon.stub(globalThis, 'fetch').callsFake(async (url) => {
      requests.push(String(url))
      return new Response(JSON.stringify([{status: {block_height: 9, confirmed: true}, txid: 'tx', value: '100', vout: 0}]))
    })
    // Override the tip response independently to check confirmation arithmetic.
    const stub = globalThis.fetch as sinon.SinonStub
    stub.onSecondCall().resolves(new Response('10'))
    expect(await getUtxos('wallet', 'http://custom-electrs')).to.deep.equal([{confirmations: 2, txid: 'tx', value: '100', vout: 0}])
    expect(requests[0]).to.equal('http://custom-electrs/address/wallet/utxo')
    expect(stub.secondCall.args[0]).to.equal('http://custom-electrs/blocks/tip/height')
    expect(resolveElectrsUrl('http://local/', 'regtest')).to.equal('http://local')
    expect(() => resolveElectrsUrl(undefined, 'mainnet')).to.throw('Electrs URL is required')
    expect(() => resolveElectrsUrl(undefined, 'regtest')).to.throw('Electrs URL is required')
  })

  it('propagates endpoint errors without trying a retired API or broadcasting twice', async () => {
    const stub = sinon.stub(globalThis, 'fetch').resolves(new Response('unavailable', {status: 503}))
    try {await broadcastTx('00', 'http://electrs'); expect.fail('expected failure')} catch (error) {
      expect(String(error)).to.include('HTTP 503')
    }

    expect(stub.calledOnce).to.equal(true)
    expect(stub.firstCall.args[0]).to.equal('http://electrs/tx')
  })

  it('synchronizes only actual unspent wallet outputs and validates transaction bytes', async () => {
    const payment = bitcoin.payments.p2pkh({hash: new Uint8Array(20).fill(1), network: dogecoinTestnet})
    const tx = new bitcoin.Transaction()
    tx.addInput(new Uint8Array(32), 0)
    tx.addOutput(payment.output!, 100n)
    const wallet = {address: payment.address!, network: 'testnet' as const, privateKey: 'preserved', utxos: []}
    const stub = sinon.stub(globalThis, 'fetch').callsFake(async (url) => {
      if (String(url).endsWith('/utxo')) return new Response(JSON.stringify([{status: {confirmed: false}, txid: tx.getId(), value: '100', vout: 0}]))
      if (String(url).endsWith('/hex')) return new Response(tx.toHex())
      return new Response(JSON.stringify({status: {confirmed: false}}))
    })
    expect(await fetchWalletUtxos(wallet, 'testnet', 'http://electrs')).to.deep.equal([
      {satoshis: 100, script: Buffer.from(payment.output!).toString('hex'), txid: tx.getId(), vout: 0},
    ])
    stub.restore()
    sinon.stub(globalThis, 'fetch').resolves(new Response('unavailable', {status: 503}))
    const walletPath = path.join(dir, 'wallet.json')
    const content = JSON.stringify(wallet)
    fs.writeFileSync(walletPath, content)
    const fixture = path.join(dir, 'failed-electrs.mjs')
    fs.writeFileSync(fixture, `globalThis.fetch = async () => new Response('unavailable', {status: 503});`)
    fs.writeFileSync(path.join(dir, 'doge-config.toml'), toml.stringify({network: 'testnet', rpc: {electrsAPIUrl: 'http://fixture'}, wallet: {path: walletPath}}))
    try {
      await execFileAsync(process.execPath, ['--import', fixture, cli, 'doge', 'wallet', 'sync', '--config', 'doge-config.toml'], {cwd: dir, timeout: 30_000})
      expect.fail('expected sync failure')
    } catch (error) {
      expect(String(error)).to.include('HTTP 503')
    }

    expect(fs.readFileSync(walletPath, 'utf8')).to.equal(content)
  })
})
