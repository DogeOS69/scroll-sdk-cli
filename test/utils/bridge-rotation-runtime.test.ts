import {expect} from 'chai'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {BridgeRotationRuntime, rotationProtocolOpeningId} from '../../src/utils/bridge-rotation-runtime.js'

const repeat = (byte: string, size: number) => `0x${byte.repeat(size)}`
const goldenContext = {
  genesis: {
    genesis_batch_hash: repeat('a1', 32), genesis_bridge_key_hash: repeat('33', 20),
    genesis_sequencer_outpoint: {txid: repeat('22', 32), vout: 0}, genesis_state_root: repeat('a2', 32),
    initial_confirmed_block_hash: repeat('44', 32), initial_confirmed_block_number: 100,
    initial_ethereum_block_hash: repeat('55', 32), initial_system_signer: repeat('a3', 20), initial_tx_index: 200,
  },
  protocol: {dogecoin_chain_id: 0x0D_06_0B_1E, eth_chain_id: 31_337, l2_chain_id: 534_352, protocol_version: 2},
}
const context = {...goldenContext, protocol: {...goldenContext.protocol, dogecoin_chain_id: 111_111}}
const contextText = JSON.stringify(context)
const redeemScriptHex = '51'
const keyHash = createHash('ripemd160').update(createHash('sha256').update(Buffer.from(redeemScriptHex, 'hex')).digest()).digest('hex')
const state = {bridge_keys: {current_key: {key_hash: `0x${keyHash}`}, deprecating_key: null}, deposit_queue: {confirmed_block_number: 100}, protocol_config: {key_rotation_min_grace_wf_txs: 10}, wf_tx_number: 31}
const row = () => ({protocol_id: rotationProtocolOpeningId(context), state_hash: repeat('ab', 32), state_json: JSON.stringify(state), validated_tip_state_hash: repeat('ab', 32), wf_tx_number: 31})
async function rejection(promise: Promise<unknown>, message: string): Promise<void> {
  let error: unknown
  try {await promise} catch (error_) {error = error_}
  expect(error).to.be.instanceOf(Error)
  expect((error as Error).message).to.contain(message)
}

describe('bridge rotation Kubernetes runtime', () => {
  let directory: string
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-runtime-'))
    fs.mkdirSync(path.join(directory, '.data'))
    fs.writeFileSync(path.join(directory, '.data/doge-config.toml'), 'network = "testnet"\n[rpc]\nurl = "https://rpc.example.invalid"\n')
    fs.writeFileSync(path.join(directory, '.data/protocol_context.json'), contextText)
  })
  afterEach(() => fs.rmSync(directory, {force: true, recursive: true}))

  it('matches the core protocol opening golden vector, including numeric byte order', () => {
    expect(rotationProtocolOpeningId(goldenContext)).to.equal('2a9dffc0d2ecbed48f6ccc16f2e9abd11dfbac38fe71d2c0cd6fbb0e8d24a6ce')
  })

  it('encodes an asymmetric Dogecoin block hash in consensus order without reversing txid or Ethereum hashes', () => {
    const hash = `0x${Buffer.from(Array.from({length: 32}, (_, i) => i)).toString('hex')}`
    const input = {
      genesis: {
        genesis_batch_hash: hash, genesis_bridge_key_hash: repeat('00', 20),
        genesis_sequencer_outpoint: {txid: hash, vout: 7}, genesis_state_root: hash,
        initial_confirmed_block_hash: hash, initial_confirmed_block_number: 100,
        initial_ethereum_block_hash: hash, initial_system_signer: repeat('00', 20), initial_tx_index: 3,
      },
      protocol: {dogecoin_chain_id: 111_111, eth_chain_id: 11_155_111, l2_chain_id: 221_122, protocol_version: 2},
    }
    expect(rotationProtocolOpeningId(input)).to.equal('002c468b3d75f59a42be65c68d35c6455e30d3a3105753375caa915fb92161e7')
  })

  function runtime(change?: (value: ReturnType<typeof row>) => void, script = redeemScriptHex) {
    const calls: string[][] = []
    const instance = new BridgeRotationRuntime({
      context: 'test-context', deploymentDir: directory,
      async execute(args) {
        calls.push(args)
        if (args.includes('cat')) return contextText
        expect(args).to.include('-readonly')
        if (args.at(-1)?.includes('wf_bridge_contexts')) return JSON.stringify([{redeem_script_hex: script}])
        const value = row(); change?.(value)
        return JSON.stringify([value])
      },
      fetch: (async () => new Response(JSON.stringify({result: 110}))) as typeof fetch,
    })
    return {calls, instance}
  }

  it('reads only the validated canonical head and verifies current script hash', async () => {
    const {calls, instance} = runtime()
    expect(await instance.readState()).to.include({currentKeyHash: `0x${keyHash}`, liveTipHeight: 110, minGraceWfTxs: 10, redeemScriptHex, wfTxNumber: 31})
    expect(calls.every(args => args.includes('test-context'))).to.equal(true)
    expect(calls[1].at(-1)).to.contain('s.wf_tx_number=m.validated_up_to')
  })

  it('rejects a local network override that conflicts with the bound chain ID', async () => {
    fs.writeFileSync(path.join(directory, '.data/doge-config.toml'), 'network = "mainnet"\n[rpc]\nurl = "https://rpc.example.invalid"\n')
    await rejection(runtime().instance.readState(), 'network differs from the bound protocol context')
  })

  it('accepts equivalent protocol JSON formatted by Helm with a trailing newline', async () => {
    fs.writeFileSync(path.join(directory, '.data/protocol_context.json'), JSON.stringify({genesis: context.genesis, protocol: context.protocol}, null, 2) + '\n')
    expect((await runtime().instance.readState()).wfTxNumber).eq(31)
  })

  it('rejects a replay DB from another protocol instance', async () => {
    await rejection(runtime(value => {value.protocol_id = repeat('bb', 32)}).instance.readState(), 'Replay protocol binding')
  })

  it('rejects a stale or unvalidated replay snapshot', async () => {
    await rejection(runtime(value => {value.validated_tip_state_hash = repeat('bb', 32)}).instance.readState(), 'Replay head state hash')
  })

  it('rejects a registry script that does not match the current bridge key', async () => {
    await rejection(runtime(undefined, '52').instance.readState(), 'does not match validated replay')
  })

  it('rejects mounted protocol context different from the local deployment', async () => {
    const instance = new BridgeRotationRuntime({context: 'test-context', deploymentDir: directory, execute: async () => '{}'})
    await rejection(instance.readState(), 'protocol context differs')
  })

  it('POSTs through a temporary tunnel and closes it without curl in the pod', async () => {
    const payload = {idempotency_key: 'rotation-test', new_key_hash: '0xexample'}
    let closed = false
    const instance = new BridgeRotationRuntime({
      context: 'test-context', deploymentDir: directory,
      async execute() {throw new Error('Must not execute an HTTP client in the pod')},
      fetch: (async (url, options) => {
        expect(url).eq('http://127.0.0.1:12345/protocol-actions/rotate-key/propose')
        expect(options?.body).eq(JSON.stringify(payload))
        return new Response('{"status":"bound"}')
      }) as typeof fetch,
      async forward() {return {close() {closed = true}, url: 'http://127.0.0.1:12345'}},
    })
    expect(await instance.post('/protocol-actions/rotate-key/propose', payload)).to.deep.equal({body: {status: 'bound'}, status: 200})
    expect(closed).eq(true)
    await rejection(instance.post('/arbitrary', {}), 'Unsupported WP')
  })

  it('closes failed requests and keeps transport errors and credentials out of diagnostics', async () => {
    let closed = false
    const instance = new BridgeRotationRuntime({context: 'test-context', deploymentDir: directory,
      fetch: (async () => {throw new Error('FAKE_CREDENTIAL_FOR_TEST')}) as typeof fetch,
      async forward() {return {close() {closed = true}, url: 'http://127.0.0.1:12345'}},
    })
    await rejection(instance.post('/protocol-actions/rotate-key/propose', {}), 'same idempotency key')
    expect(closed).eq(true)
    try {await instance.post('/protocol-actions/rotate-key/propose', {})} catch (error) {expect(String(error)).not.to.contain('FAKE_CREDENTIAL_FOR_TEST')}
  })

  it('restricts explicit HTTP URLs and refuses URL credentials', () => {
    for (const wpUrl of ['http://remote.example.invalid', 'https://user:FAKE@example.invalid', 'https://example.invalid/?token=FAKE']) {
      expect(() => new BridgeRotationRuntime({context: 'test-context', deploymentDir: directory, wpUrl})).to.throw('WP URL must')
    }
  })

  it('rejects SQL injection in the persisted idempotency key before invoking kubectl', async () => {
    const instance = new BridgeRotationRuntime({context: 'test-context', deploymentDir: directory, async execute() {throw new Error('must not invoke')}})
    await rejection(instance.readIntent("x' OR 1=1"), 'Invalid rotation idempotency')
  })

  it('selects only public intent/job fields and retains the complete target for retry comparison', async () => {
    const instance = new BridgeRotationRuntime({context: 'test-context', deploymentDir: directory, async execute(args) {
      const query = args.at(-1)!
      expect(query).to.contain('new_bridge_redeem_script_hex')
      expect(query).not.to.contain('proposed_psbt')
      expect(query).not.to.contain('requested_payload_json')
      return '[]'
    }})
    expect(await instance.readIntent('attestation-rotation-002')).to.equal(null)
  })
  it('normalizes persisted intent evidence without exposing unrelated columns', async () => {
    const instance = new BridgeRotationRuntime({context: 'test-context', deploymentDir: directory, execute: async () => JSON.stringify([{
      bound_deprecation_wf_tx_number: 128, grace_wf_txs: 100, intent_id: 'intent-1', job_id: 'job-1', job_status: 'completed',
      new_bridge_redeem_script_hex: '51', new_key_hash_hex: keyHash, replay_prev_wf_tx_number: 27, signed_txid: repeat('ac', 32),
      status: 'completed', tso_transaction_id: 'transaction-1',
    }])})
    expect(await instance.readIntent('rotation-test')).to.deep.equal({
      activationWfTxNumber: 28, deprecationWfTxNumber: 128, graceWfTxs: 100, intentId: 'intent-1', jobId: 'job-1',
      jobStatus: 'completed', redeemScriptHex: '51', signedTxid: 'ac'.repeat(32), status: 'completed', targetKeyHash: `0x${keyHash}`, tsoTransactionId: 'transaction-1',
    })
  })

  it('loads only the environment referenced by the saved preparation plan', async () => {
    fs.mkdirSync(path.join(directory, '.scrollsdk'))
    const envFile = path.join(directory, 'operator.env')
    fs.writeFileSync(envFile, 'ROTATION_RUNTIME_TEST_ENV=fake-test-value\n')
    fs.writeFileSync(path.join(directory, '.scrollsdk/plan.json'), JSON.stringify({envFile}))
    try {
      const instance = new BridgeRotationRuntime({context: 'test-context', deploymentDir: directory})
      expect(instance.context).to.equal('test-context')
      expect(process.env.ROTATION_RUNTIME_TEST_ENV).to.equal('fake-test-value')
    } finally {delete process.env.ROTATION_RUNTIME_TEST_ENV}
  })

})
