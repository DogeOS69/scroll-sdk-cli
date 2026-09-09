import {Transaction} from 'bitcoinjs-lib'
import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import sinon from 'sinon'

import {
  ensureGenesisSequencerTransaction,
  validateGenesisSequencerTransaction,
} from '../../src/utils/genesis-sequencer-transaction.js'

const RAW_TRANSACTION = [
  '01000000',
  '01',
  '00'.repeat(32),
  'ffffffff',
  '00',
  'ffffffff',
  '01',
  '0100000000000000',
  '00',
  '00000000',
].join('')

describe('genesis sequencer transaction', () => {
  const txid = Transaction.fromHex(RAW_TRANSACTION).getId()

  it('binds raw bytes to the expected txid and output', () => {
    expect(validateGenesisSequencerTransaction(RAW_TRANSACTION, `0x${txid}`, 0)).to.deep.equal({
      txHex: RAW_TRANSACTION,
      txid,
      vout: 0,
    })
  })

  it('rejects a mismatched transaction id', () => {
    expect(() => validateGenesisSequencerTransaction(RAW_TRANSACTION, '11'.repeat(32), 0))
      .to.throw('txid mismatch')
  })

  it('rejects an output index absent from the transaction', () => {
    expect(() => validateGenesisSequencerTransaction(RAW_TRANSACTION, txid, 1))
      .to.throw('does not exist')
  })

  it('backfills a legacy bridge output from RPC and persists validated bytes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-sequencer-transaction-'))
    const withdrawalOutputPath = path.join(root, 'output-withdrawal-processor.toml')
    const setupDefaultsPath = path.join(root, 'setup_defaults.toml')
    const protocolContextPath = path.join(root, 'protocol_context.json')
    fs.writeFileSync(withdrawalOutputPath, [
      `genesis_sequencer_txid = "${txid}"`,
      'genesis_sequencer_vout = 0',
      '',
    ].join('\n'))
    fs.writeFileSync(setupDefaultsPath, 'dogecoin_rpc_url = "http://dogecoin.example"\n')
    fs.writeFileSync(protocolContextPath, JSON.stringify({
      genesis: {genesis_sequencer_outpoint: {txid: `0x${txid}`, vout: 0}},
    }))
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response(JSON.stringify({
      error: null,
      result: RAW_TRANSACTION,
    }), {status: 200}))

    try {
      expect(await ensureGenesisSequencerTransaction({
        protocolContextPath,
        setupDefaultsPath,
        withdrawalProcessorOutputPath: withdrawalOutputPath,
      })).to.deep.equal({txHex: RAW_TRANSACTION, txid, vout: 0})
      expect(fs.readFileSync(withdrawalOutputPath, 'utf8'))
        .to.include(`genesis_sequencer_tx_hex = "${RAW_TRANSACTION}"`)
      expect(fetchStub.calledOnce).to.equal(true)
    } finally {
      fetchStub.restore()
      fs.rmSync(root, {force: true, recursive: true})
    }
  })
})
