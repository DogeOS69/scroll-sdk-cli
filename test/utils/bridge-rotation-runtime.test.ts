import {expect} from 'chai'

import {rotationProtocolOpeningId} from '../../src/utils/bridge-rotation-runtime.js'

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
describe('protocol opening id', () => {
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
})
