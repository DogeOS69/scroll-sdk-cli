import * as toml from '@iarna/toml'
import {Transaction} from 'bitcoinjs-lib'
import {expect} from 'chai'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {ensureOpeningBridgeCustody, validateOpeningBridgeCustody} from '../../src/utils/opening-bridge-custody.js'

const hash160 = (value: Buffer) => createHash('ripemd160').update(createHash('sha256').update(value).digest()).digest('hex')
const REDEEM = `14${'11'.repeat(20)}7551`
const BRIDGE_SCRIPT = Buffer.from(`a914${hash160(Buffer.from(REDEEM, 'hex'))}87`, 'hex')
const MARKER = Buffer.from('6a4901' + '00'.repeat(72), 'hex')
const SEQUENCER = {txid: 'aa'.repeat(32), vout: 0}

function fundingTransaction(script = BRIDGE_SCRIPT, seed = 2): Transaction {
  const transaction = new Transaction()
  transaction.addInput(Buffer.alloc(32, seed), 0)
  transaction.addOutput(script, 1_000_000_000n)
  transaction.addOutput(MARKER, 0n)
  return transaction
}

describe('opening Bridge custody', () => {
  const binding = {bridgeRedeemScriptHex: REDEEM, genesisSequencerOutpoint: SEQUENCER}
  const funding = fundingTransaction()

  it('accepts a marked funding output paying the genesis Bridge script', () => {
    expect(validateOpeningBridgeCustody([{tx_hex: `0x${funding.toHex().toUpperCase()}`, vout: 0}], binding))
      .to.deep.equal([{tx_hex: funding.toHex(), vout: 0}])
  })

  it('rejects an empty list, a foreign script, a missing output and a repeated outpoint', () => {
    expect(() => validateOpeningBridgeCustody([], binding)).to.throw('at least one')
    expect(() => validateOpeningBridgeCustody(undefined, binding)).to.throw('at least one')
    expect(() => validateOpeningBridgeCustody([{tx_hex: funding.toHex(), vout: 1}], binding)).to.throw('does not pay the genesis Bridge script')
    expect(() => validateOpeningBridgeCustody([{tx_hex: funding.toHex(), vout: 2}], binding)).to.throw('no such output')
    expect(() => validateOpeningBridgeCustody([{tx_hex: 'zz', vout: 0}], binding)).to.throw('hexadecimal')
    expect(() => validateOpeningBridgeCustody([{tx_hex: funding.toHex(), vout: 0}, {tx_hex: funding.toHex(), vout: 0}], binding)).to.throw('listed twice')
  })

  it('rejects the genesis sequencer outpoint', () => {
    expect(() => validateOpeningBridgeCustody([{tx_hex: funding.toHex(), vout: 0}], {...binding, genesisSequencerOutpoint: {txid: funding.getId(), vout: 0}}))
      .to.throw('genesis sequencer outpoint')
  })

  describe('deployment manifest', () => {
    let root: string
    let manifest: string
    let bridgeJson: string
    let receipt: string
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'opening-bridge-custody-'))
      manifest = path.join(root, 'output-withdrawal-processor.toml')
      bridgeJson = path.join(root, 'bridge.json')
      receipt = path.join(root, 'production-bridge-funding.json')
      fs.writeFileSync(bridgeJson, JSON.stringify({redeem_script_hex: REDEEM}))
    })
    afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
    const options = () => ({bridgeFundingReceiptPath: receipt, bridgeJsonPath: bridgeJson, withdrawalProcessorOutputPath: manifest})

    it('keeps the recorded list as the authority', () => {
      const other = fundingTransaction(BRIDGE_SCRIPT, 3)
      fs.writeFileSync(manifest, toml.stringify({genesis_sequencer_txid: SEQUENCER.txid, genesis_sequencer_vout: 0, opening_bridge_custody: [{tx_hex: funding.toHex(), vout: 0}]}))
      fs.writeFileSync(receipt, JSON.stringify({rawTransaction: other.toHex(), vout: 0}))
      expect(ensureOpeningBridgeCustody(options())).to.deep.equal([{tx_hex: funding.toHex(), vout: 0}])
    })

    it('backfills an earlier deployment from its Bridge funding receipt', () => {
      fs.writeFileSync(manifest, toml.stringify({genesis_sequencer_txid: SEQUENCER.txid, genesis_sequencer_vout: 0, network_str: 'regtest'}))
      fs.writeFileSync(receipt, JSON.stringify({rawTransaction: funding.toHex(), txid: funding.getId(), vout: 0}))
      expect(ensureOpeningBridgeCustody(options())).to.deep.equal([{tx_hex: funding.toHex(), vout: 0}])
      const saved: any = toml.parse(fs.readFileSync(manifest, 'utf8'))
      expect(saved.opening_bridge_custody).to.deep.equal([{tx_hex: funding.toHex(), vout: 0}])
      expect(saved.network_str).to.equal('regtest')
    })

    it('explains the remedy when no funding output is recorded', () => {
      fs.writeFileSync(manifest, toml.stringify({genesis_sequencer_txid: SEQUENCER.txid, genesis_sequencer_vout: 0}))
      expect(() => ensureOpeningBridgeCustody(options())).to.throw('[[opening_bridge_custody]]')
    })
  })
})
