import {expect} from 'chai'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

import {protocolOpeningId} from '../../src/utils/protocol-opening-id.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const repeat = (byte: string, size: number) => `0x${byte.repeat(size)}`
const goldenContext = {
  genesis: {
    genesis_batch_hash: repeat('a1', 32), genesis_block_hash: repeat('a2', 32), genesis_bridge_key_hash: repeat('33', 20),
    genesis_sequencer_outpoint: {txid: repeat('22', 32), vout: 0},
    initial_confirmed_block_hash: repeat('44', 32), initial_confirmed_block_number: 100,
    initial_ethereum_block_hash: repeat('55', 32), initial_system_signer: repeat('a3', 20), initial_tx_index: 200,
  },
  protocol: {dogecoin_chain_id: 0x0D_06_0B_1E, eth_chain_id: 31_337, l2_chain_id: 534_352, protocol_version: 1},
}

describe('protocol opening id', () => {
  it('matches the core protocol opening golden vector, including numeric byte order', () => {
    // dogeos_protocol::constants::protocol_opening_hash_golden_vector (sample_params).
    expect(protocolOpeningId(goldenContext)).to.equal('1a09c212496c6f05dbfcc276ee1f53f2b6123223ae918c92a75e8db308468524')
  })

  it('matches core for its canonical protocol context corpus fixture', () => {
    // dogeos-core crates/dogeos_protocol/test-data/protocol-context-corpus/valid-canonical.json
    const context = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/protocol-context/valid-canonical.json'), 'utf8'))
    expect(protocolOpeningId(context)).to.equal('3cf6c61c9b2855bccbfa4f743312941c992b21ba7dafdbdb39a9ca535c112986')
  })

  it('rejects a protocol context that still uses genesis_state_root', () => {
    const {genesis_block_hash: hash, ...genesis} = goldenContext.genesis
    expect(() => protocolOpeningId({...goldenContext, genesis: {...genesis, genesis_state_root: hash}})).to.throw(/genesis_state_root/)
  })

  it('encodes an asymmetric Dogecoin block hash in consensus order without reversing txid or Ethereum hashes', () => {
    const hash = `0x${Buffer.from(Array.from({length: 32}, (_, i) => i)).toString('hex')}`
    const input = {
      genesis: {
        genesis_batch_hash: hash, genesis_block_hash: hash, genesis_bridge_key_hash: repeat('00', 20),
        genesis_sequencer_outpoint: {txid: hash, vout: 7},
        initial_confirmed_block_hash: hash, initial_confirmed_block_number: 100,
        initial_ethereum_block_hash: hash, initial_system_signer: repeat('00', 20), initial_tx_index: 3,
      },
      protocol: {dogecoin_chain_id: 111_111, eth_chain_id: 11_155_111, l2_chain_id: 221_122, protocol_version: 2},
    }
    // The preimage commits protocol_version as bytes; 2 keeps this byte-order vector unchanged.
    expect(protocolOpeningId(input)).to.equal('002c468b3d75f59a42be65c68d35c6455e30d3a3105753375caa915fb92161e7')
  })
})
