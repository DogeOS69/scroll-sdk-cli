/* eslint-disable @typescript-eslint/no-explicit-any -- Core/RPC integration fixtures. */
import * as toml from '@iarna/toml'
import {Transaction} from 'bitcoinjs-lib'
import bitcore from 'bitcore-lib-doge'
import {expect} from 'chai'
import {execFile} from 'node:child_process'
import {createHash, randomBytes} from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {promisify} from 'node:util'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {FEE_WALLET_KEY_ENV, productionFeeWallet} from '../../src/utils/preparation-fee-wallet.js'
import {assertHelperFundingImage, bindManagedHelperWallets, checkHelperRecoveryTimelock, helperFundingAmount, prepareManagedHelper, prepareManagedHelperFunding, verifyManagedHelperFunding} from '../../src/utils/preparation-helper.js'
import {helperFeeWalletWif, helperSeed} from '../../src/utils/preparation-helper-identity.js'
import {AwaitingInput, digest, privateWrite, writeJson} from '../../src/utils/preparation-io.js'
import {preparationSteps} from '../../src/utils/preparation-plan.js'

const exec = promisify(execFile)
const image = 'dogeos69/bridge-genesis-tools@sha256:27e646fd5d9c340926df82f47f7d352fd5333de4e6178c5a8c56aa9637769262'
const publicKey = () => new bitcore.PrivateKey().toPublicKey().toString()
function fixture(root: string): DeploymentSpec {
  const spec = {
    attestationSigners: [{attestationPubkey: publicKey(), name: 'a', transportPubkey: publicKey()}], bridge: {confirmationsRequired: 2, teePubkey: publicKey(), thresholds: {attestation: 1, recovery: 1}, timelock: 500_000},
    dogecoin: {network: 'regtest'}, infrastructure: {aws: {eksClusterName: 'test', region: 'us-east-1'}, namespace: 'test', provider: 'aws'},
    metadata: {name: 'helper-test'},
    preparation: {bridge: {image, mode: 'production', production: {ethereumAnchor: {blockTag: 'finalized'}, funding: 'helper', recoveryPublicKeys: [publicKey()], sequencerKms: {action: 'reuse', keyId: 'nonfunctional-test-key', roleArn: 'arn:aws:iam::111111111111:role/test'}}}, proofMaterials: {mode: 'existing'}},
  } as DeploymentSpec
  const key = publicKey()
  writeJson(path.join(root, '.data/bridge-sequencer-kms.json'), {
    intentHash: digest(JSON.stringify({aws: spec.infrastructure.aws, kms: spec.preparation!.bridge.production!.sequencerKms, name: spec.metadata.name, namespace: 'test', serviceAccount: 'withdrawal-processor'})), keyArn: 'arn:aws:kms:us-east-1:111111111111:key/nonfunctional-test-key', publicKey: key, ready: true, region: 'us-east-1', roleArn: 'arn:aws:iam::111111111111:role/test', schema: 'dogeos/bridge-sequencer-kms/v1',
    serviceAccount: 'withdrawal-processor',
  })
  privateWrite(path.join(root, '.data/setup_defaults.toml'), toml.stringify({bridge_target_amount: 1_000_000_000, fee_rate_sat_per_kvb: 1_000_000, fee_wallet_target_amount: 100_000_000}))
  return spec
}

describe('managed helper funding', () => {
  let root: string
  let previous: string | undefined
  let spec: DeploymentSpec
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-helper-test-'))
    previous = process.env[FEE_WALLET_KEY_ENV]; delete process.env[FEE_WALLET_KEY_ENV]
    spec = fixture(root)
  })
  afterEach(() => {
    if (previous === undefined) delete process.env[FEE_WALLET_KEY_ENV]; else process.env[FEE_WALLET_KEY_ENV] = previous
    fs.rmSync(root, {force: true, recursive: true})
  })

  for (const network of ['mainnet', 'testnet', 'regtest'] as const) it(`serializes ${network} for the Core helper`, () => {
    spec.dogecoin.network = network
    prepareManagedHelper(root, spec)
    const config = toml.parse(fs.readFileSync(path.join(root, '.data/setup_defaults.toml'), 'utf8'))
    expect(config.network).to.equal(network === 'mainnet' ? 'dogecoin' : network)
  })

  it('blocks the known incompatible image before helper funding or broadcast', () => {
    expect(() => assertHelperFundingImage(image)).to.throw('invalid 71-byte')
  })

  it('rejects a future timelock below the Core recovery delay before requesting helper funding', async () => {
    prepareManagedHelper(root, spec)
    spec.bridge.timelock = 300_000
    let failure: unknown
    try {await prepareManagedHelperFunding(root, spec, async method => {
      if (method === 'getblockchaininfo') return {chain: 'regtest'}
      if (method === 'getblockcount') return 207_496
      throw new Error('Funding must not be inspected before timelock validation')
    })} catch (error) {failure = error}

    expect(failure).to.be.instanceOf(AwaitingInput)
    expect((failure as Error).message).to.include('466697')
  })

  it('rechecks the earliest possible anchor at the exact recovery-delay boundary', async () => {
    spec.bridge.timelock = 466_697
    await checkHelperRecoveryTimelock(spec, async () => 207_496)
    let failure: unknown
    try {await checkHelperRecoveryTimelock(spec, async () => 207_497)} catch (error) {failure = error}
    expect(failure).to.be.instanceOf(AwaitingInput)
    expect((failure as Error).message).to.include('466698')
  })

  it('prepares external KMS identity and a deterministic fee wallet without deriving bridge roles', () => {
    prepareManagedHelper(root, spec)
    const config: any = toml.parse(fs.readFileSync(path.join(root, '.data/setup_defaults.toml'), 'utf8'))
    const first = productionFeeWallet(root, spec)
    expect(first).to.deep.equal(productionFeeWallet(root, spec))
    expect(helperSeed(root)).to.equal(config.seed_string)
    expect(fs.statSync(path.join(root, '.data/bridge-helper-seed')).mode % 0o1000).to.equal(0o600)
    expect(config.sequencer_pubkey).to.equal(JSON.parse(fs.readFileSync(path.join(root, '.data/bridge-sequencer-kms.json'), 'utf8')).publicKey)
    expect(config).not.to.have.property('fee_wallet_pubkey')
    expect(config.tee_pubkey).to.equal(spec.bridge.teePubkey)
    expect(config.recovery_pubkeys).to.deep.equal(spec.preparation!.bridge.production!.recoveryPublicKeys)
    expect(config.enable_deposit_seed_txs).to.equal(false)
    expect(config.bridge_funding_target_amount).to.equal(1_000_000_000)
    expect(helperFundingAmount(config)).to.equal(1_142_925_000)
    const steps = preparationSteps(spec, true)
    expect(steps.map(step => step.id)).not.to.include.members(['production-wallets', 'production-funding'])
    expect(steps.filter(step => step.effect === 'chain').map(step => [step.id, step.retry])).to.deep.equal([['managed-helper-setup', 'reconcile'], ['managed-helper-fund', 'reconcile']])
  })

  it('preserves an explicitly supplied fee-wallet identity and rejects changing it', () => {
    process.env[FEE_WALLET_KEY_ENV] = new bitcore.PrivateKey(null, bitcore.Networks.regtest).toWIF()
    prepareManagedHelper(root, spec)
    const config: any = toml.parse(fs.readFileSync(path.join(root, '.data/setup_defaults.toml'), 'utf8'))
    expect(config.fee_wallet_pubkey).to.equal(productionFeeWallet(root, spec).publicKey)
    delete process.env[FEE_WALLET_KEY_ENV]
    expect(() => productionFeeWallet(root, spec)).to.throw('Fee-wallet identity differs')
  })

  it('asks for only a helper outpoint and displays the complete funding budget', async () => {
    prepareManagedHelper(root, spec)
    let waiting: any
    try {await prepareManagedHelperFunding(root, spec, async method => {
      if (method === 'getblockchaininfo') return {chain: 'regtest'}
      if (method === 'getblockcount') return 1000
      throw new Error('No transaction RPC expected without an input')
    })} catch (error) {waiting = error}

    expect(waiting).to.be.instanceOf(AwaitingInput)
    expect(waiting.details.amountSats).to.equal(1_142_925_000)
    expect(Object.keys(waiting.details.inputTemplate)).to.deep.equal(['helper'])
    expect(JSON.parse(fs.readFileSync(waiting.details.file, 'utf8'))).to.deep.equal(waiting.details.inputTemplate)
  })

  it('preserves partially filled helper input on retry', async () => {
    prepareManagedHelper(root, spec)
    const file = path.join(root, '.scrollsdk/inputs/bridge-funding.json')
    const partial = {helper: {txid: 'a'.repeat(64), vout: 'REPLACE_WITH_OUTPUT_INDEX'}}
    writeJson(file, partial)
    let waiting: unknown
    try {await prepareManagedHelperFunding(root, spec, async method => {
      if (method === 'getblockchaininfo') return {chain: 'regtest'}
      if (method === 'getblockcount') return 1000
      throw new Error('Invalid output index must not reach transaction RPC')
    })} catch (error) {waiting = error}

    expect(waiting).to.be.instanceOf(AwaitingInput)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).to.deep.equal(partial)
  })

  it('accepts correctly marked funding, validates all child outputs and keeps the Ethereum anchor', async () => {
    prepareManagedHelper(root, spec)
    const key = JSON.parse(fs.readFileSync(path.join(root, '.data/bridge-sequencer-kms.json'), 'utf8')).publicKey
    const sequencerAddress = new bitcore.PublicKey(key).toAddress(bitcore.Networks.regtest).toString()
    const fee = productionFeeWallet(root, spec)
    const setup = new Transaction()
    setup.addInput(Buffer.alloc(32, 1), 0)
    setup.addOutput(Buffer.from(bitcore.Script.fromAddress(sequencerAddress).toHex(), 'hex'), 42_069_000n)
    for (let i = 0; i < 10; i++) setup.addOutput(Buffer.from(bitcore.Script.fromAddress(fee.address).toHex(), 'hex'), 10_000_000n)
    const txid = setup.getId()
    const hash160 = (value: Buffer) => createHash('ripemd160').update(createHash('sha256').update(value).digest()).digest('hex')
    const namespace = hash160(Buffer.concat([Buffer.from('dogeos-bridge-namespace-v1'), Buffer.from(txid, 'hex'), Buffer.alloc(4)]))
    const redeem = `14${namespace}7551`
    const script = `a914${hash160(Buffer.from(redeem, 'hex'))}87`
    const address = new bitcore.Address(Buffer.from(hash160(Buffer.from(redeem, 'hex')), 'hex'), bitcore.Networks.regtest, 'scripthash').toString()
    const funding = new Transaction()
    funding.addInput(Buffer.alloc(32, 2), 0)
    funding.addOutput(Buffer.from(script, 'hex'), 1_000_000_000n)
    funding.addOutput(Buffer.from('6a4901' + '00'.repeat(72), 'hex'), 0n)
    const blockHash = 'b'.repeat(64)
    writeJson(path.join(root, '.data/output-test-data.json'), {
      confirmed_block_hash: blockHash, confirmed_block_height: 100, fee_wallet_utxos: Array.from({length: 10}, (_, i) => ({txid, vout: i + 1})), initial_bridge_funding_utxos: [{txid: funding.getId(), vout: 0}],
      sequencer_utxo_txid: txid,
      sequencer_utxo_vout: 0,
    })
    writeJson(path.join(root, '.data/bridge.json'), {p2sh_address: address, redeem_script_hex: redeem, script_pubkey_hex: script})
    writeJson(path.join(root, '.data/production-ethereum-anchor.json'), {blockNumber: 42})
    privateWrite(path.join(root, '.data/doge-config.toml'), toml.stringify({defaults: {ethereumDaEmbeddedIndexerStartBlock: '999'}}))
    await verifyManagedHelperFunding(root, spec, async (method, params) => {
      const tx = params[0] === txid ? setup : funding
      switch (method) {
        case 'getblockchaininfo': {return {chain: 'regtest'}}
        case 'getblockcount': {return 1000}
        case 'gettxout': {const out = tx.outs[Number(params[1])]; return {confirmations: 6, scriptPubKey: {hex: Buffer.from(out.script).toString('hex')}, value: Number(out.value) / 100_000_000}}
        case 'getrawtransaction': {return {blockhash: blockHash, hex: tx.toHex()}}
        case 'getblockhash': {return blockHash}
        case 'getblockheader': {return {confirmations: 6, height: 100}}
        default: {throw new Error(`Unexpected RPC ${method}`)}
      }
    })
    const facts = JSON.parse(fs.readFileSync(path.join(root, '.data/production-wallet-funding.json'), 'utf8'))
    expect(facts.feeWalletOutputs).to.have.length(10)
    expect(facts.sequencer.vout).to.equal(0)
    expect(fs.existsSync(path.join(root, '.data/production-bridge-funding.json'))).to.equal(true)
    const config: any = toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8'))
    expect(config.defaults.ethereumDaEmbeddedIndexerStartBlock).to.equal('42')
    expect(config.defaults.dogecoinIndexerStartHeight).to.equal('99')
  })

  it('restores KMS after Core rewrites the construction manifest and refuses mismatched identities', () => {
    prepareManagedHelper(root, spec)
    const key = JSON.parse(fs.readFileSync(path.join(root, '.data/bridge-sequencer-kms.json'), 'utf8')).publicKey
    const data = {fee_wallet_address: productionFeeWallet(root, spec).address, sequencer_address: new bitcore.PublicKey(key).toAddress(bitcore.Networks.regtest).toString(), sequencer_utxo_txid: 'a'.repeat(64), sequencer_utxo_vout: 0}
    writeJson(path.join(root, '.data/output-test-data.json'), data)
    const output = path.join(root, '.data/output-withdrawal-processor.toml')
    privateWrite(output, toml.stringify({fee_signer_key: helperFeeWalletWif(root, spec), genesis_sequencer_txid: data.sequencer_utxo_txid, genesis_sequencer_vout: 0}))
    bindManagedHelperWallets(root, spec)
    const bound: any = toml.parse(fs.readFileSync(output, 'utf8'))
    expect(bound.sequencer_signer_kms.expected_pubkey).to.equal(key)
    expect(bound).not.to.have.property('sequencer_signer_key')
    expect(bound.fee_signer_key).to.equal('$ENV:DOGECOIN_FEE_WALLET_KEY')
    writeJson(path.join(root, '.data/output-test-data.json'), {...data, sequencer_utxo_vout: 1})
    expect(() => bindManagedHelperWallets(root, spec)).to.throw('identities')
  })
})

// Explicit opt-in: disposable node, actual pinned Core binary and CLI adapters;
// no AWS calls or existing chain/wallet configuration is used.
;(process.env.RUN_HELPER_DOCKER_TESTS === '1' ? describe : describe.skip)('managed helper Docker integration', function () {
  this.timeout(180_000)
  it('checks helper distribution with external sequencer identity and a derived fee wallet', async () => {
    const selectedImage = process.env.HELPER_DOCKER_IMAGE ?? image
    const legacyImage = selectedImage === image
    if (!legacyImage) assertHelperFundingImage(selectedImage)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-docker-test-'))
    const name = `scrollsdk-helper-test-${randomBytes(6).toString('hex')}`
    const password = randomBytes(24).toString('hex')
    const previous = process.env[FEE_WALLET_KEY_ENV]
    delete process.env[FEE_WALLET_KEY_ENV]
    let timer: NodeJS.Timeout | undefined
    const ethereum = http.createServer((_request, response) => {response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({id: 1, jsonrpc: '2.0', result: '0x1234'}))})
    try {
      await new Promise<void>(resolve => ethereum.listen(0, '127.0.0.1', resolve))
      privateWrite(path.join(root, 'node.conf'), `regtest=1\nserver=1\ntxindex=1\nrpcuser=test\nrpcpassword=${password}\nrpcallowip=0.0.0.0/0\nrpcport=18443\n`)
      await exec('docker', ['run', '-d', '--name', name, '-v', `${root}/node.conf:/tmp/node.conf:ro`, 'dogeos69/dogecoin:1.14.9', '/dogecoin/bin/dogecoind', '-conf=/tmp/node.conf', '-printtoconsole'])
      const {stdout} = await exec('docker', ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name])
      const url = `http://${stdout.trim()}:18443`
      const rpc = async (method: string, params: unknown[] = []): Promise<any> => {
        const response = await fetch(url, {body: JSON.stringify({id: 1, jsonrpc: '1.0', method, params}), headers: {authorization: `Basic ${Buffer.from(`test:${password}`).toString('base64')}`, 'content-type': 'application/json'}, method: 'POST', signal: AbortSignal.timeout(5000)})
        const result: any = await response.json()
        if (result.error) throw new Error(`Disposable node RPC ${method} failed: ${result.error.code}`)
        return result.result
      }

      for (let i = 0; ; i++) {
        try {await rpc('getblockcount'); break} catch {if (i === 60) throw new Error('Disposable node did not start'); await new Promise(resolve => setTimeout(resolve, 250))}
      }

      await rpc('generate', [250])
      const spec = fixture(root)
      spec.preparation!.bridge.image = selectedImage
      spec.bridge.confirmationsRequired = 6
      const configFile = path.join(root, '.data/setup_defaults.toml')
      const base = toml.parse(fs.readFileSync(configFile, 'utf8'))
      privateWrite(configFile, toml.stringify({...base, dogecoin_rpc_pass: password, dogecoin_rpc_url: url, dogecoin_rpc_user: 'test'}))
      const ethPort = (ethereum.address() as any).port
      privateWrite(path.join(root, '.data/doge-config.toml'), toml.stringify({ethereumDa: {chain: 'sepolia', l1RpcUrl: `http://127.0.0.1:${ethPort}`}, network: 'regtest'}))
      writeJson(path.join(root, '.scrollsdk/intent.json'), spec)
      writeJson(path.join(root, '.data/production-ethereum-anchor.json'), {blockNumber: 42})
      prepareManagedHelper(root, spec)
      let waiting: any
      try {await prepareManagedHelperFunding(root, spec, rpc)} catch (error) {waiting = error}
      expect(waiting).to.be.instanceOf(AwaitingInput)
      const txid = await rpc('sendtoaddress', [waiting.details.address, waiting.details.amountSats / 100_000_000])
      const tx = await rpc('getrawtransaction', [txid, true])
      const vout = tx.vout.find((out: any) => out.scriptPubKey.addresses?.includes(waiting.details.address)).n
      writeJson(path.join(root, '.scrollsdk/inputs/bridge-funding.json'), {helper: {txid, vout}})
      await rpc('generate', [5])
      let unconfirmed: any
      try {await prepareManagedHelperFunding(root, spec, rpc)} catch (error) {unconfirmed = error}
      expect(unconfirmed).to.be.instanceOf(AwaitingInput)
      expect(unconfirmed.message).to.include('at least 6 confirmations')
      await rpc('generate', [1])
      await prepareManagedHelperFunding(root, spec, rpc)
      let mining = false
      timer = setInterval(() => {
        if (mining) return
        mining = true
        rpc('generate', [1]).catch(() => {}).finally(() => {mining = false})
      }, 400)
      // HELPER_DOCKER_IMAGE exercises a fixed release. The default reproduces
      // the blocked legacy image's bug only on this disposable chain.
      const core = async (args: string[]) => {
        try {await exec('docker', ['run', '--rm', '-v', `${root}:/app`, '-w', '/app', selectedImage, ...args], {maxBuffer: 4 * 1024 * 1024})}
        catch (error) {privateWrite(path.join(root, 'core-error.log'), String(error)); throw new Error('Core tool failed; see private core-error.log')}
      }

      await core(['generate_test_keys', 'setup', '--config', '.data/setup_defaults.toml', '--output-dir', '.data'])
      // Verify the real Core-derived key before replacing it with its runtime reference.
      const generated: any = toml.parse(fs.readFileSync(path.join(root, '.data/output-withdrawal-processor.toml'), 'utf8'))
      expect(generated.fee_signer_key === helperFeeWalletWif(root, spec)).to.equal(true)
      bindManagedHelperWallets(root, spec)
      await core(['compute-bridge-namespace-cli', '--withdrawal-processor-toml', '.data/output-withdrawal-processor.toml', '--write-back', '.data/GenerateBridgeInfo.toml', '--format', 'hex'])
      await core(['generate-bridge-info-cli', '--config-file', '.data/GenerateBridgeInfo.toml', '--output-file', '.data/bridge.json'])
      await core(['generate_test_keys', 'fund-bridge', '--config', '.data/setup_defaults.toml', '--output-dir', '.data', '--bridge-json', '.data/bridge.json'])
      bindManagedHelperWallets(root, spec)
      const output: any = toml.parse(fs.readFileSync(path.join(root, '.data/output-withdrawal-processor.toml'), 'utf8'))
      expect(output.genesis_sequencer_vout).to.equal(0)
      expect(output.sequencer_signer_kms).to.have.property('key_id')
      expect(output).not.to.have.property('sequencer_signer_key')
      const data = JSON.parse(fs.readFileSync(path.join(root, '.data/output-test-data.json'), 'utf8'))
      expect(data.fee_wallet_address).to.equal(productionFeeWallet(root, spec).address)
      expect(data.fee_wallet_utxos).to.have.length(10)
      expect(data.initial_bridge_funding_utxos).to.have.length(1)
      expect(data.deposit_seed_utxos).to.have.length(0)
      if (legacyImage) {
        expect(data.initial_bridge_funding_utxos[0].op_return_data).to.equal('6a4701' + '00'.repeat(70))
        let rejected: any
        try {await verifyManagedHelperFunding(root, spec, rpc)} catch (error) {rejected = error}
        expect(rejected).to.be.instanceOf(AwaitingInput)
        expect(rejected.message).to.include('Bridge funding requires exactly one zero-value OP_RETURN')
        expect(fs.existsSync(path.join(root, '.data/production-bridge-funding.json'))).to.equal(false)
      } else {
        expect(data.initial_bridge_funding_utxos[0].op_return_data).to.equal('6a4901' + '00'.repeat(72))
        await verifyManagedHelperFunding(root, spec, rpc)
        expect(fs.existsSync(path.join(root, '.data/production-bridge-funding.json'))).to.equal(true)
        const config: any = toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8'))
        expect(config.defaults.ethereumDaEmbeddedIndexerStartBlock).to.equal('42')
      }
    } catch (error) {
      privateWrite(path.join(root, 'failure.log'), error instanceof Error ? error.stack ?? error.message : 'Unknown failure')
      // Keep private logs for local diagnosis; never dump keys or RPC credentials.
      throw new Error(`Helper Docker integration failed; inspect private artifacts in ${root}`)
    } finally {
      if (timer) clearInterval(timer)
      ethereum.close()
      await exec('docker', ['rm', '-f', name]).catch(() => {})
      if (previous === undefined) delete process.env[FEE_WALLET_KEY_ENV]; else process.env[FEE_WALLET_KEY_ENV] = previous
    }
  })
})
