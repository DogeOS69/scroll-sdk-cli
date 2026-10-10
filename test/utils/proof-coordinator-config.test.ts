import * as toml from '@iarna/toml'
import {expect} from 'chai'

import {removeRetiredBatchWitnessSources} from '../../src/utils/proof-coordinator-config.js'

describe('beta.6 batch materializer input', () => {
  it('removes retired batch inputs while preserving chunk witnesses and Ethereum DA', () => {
    const source = '[materializer.scroll_chunk]\nl2_rpc_url = "https://rpc.example.invalid"\n'
      + '[materializer.scroll_batch.subprocess]\nl2_rpc_url = "https://old.example.invalid"\nblock_witness_dir = "/old/witnesses"\nbinary_path = "/bin/materializer"\n'
      + '[materializer.scroll_batch.subprocess.ethereum_da]\nl1_rpc_url = "https://sepolia.example.invalid"\n'
    const cleaned = removeRetiredBatchWitnessSources(source)
    const expected = toml.parse(source)
    const materializer = expected.materializer as toml.JsonMap
    const subprocess = (materializer.scroll_batch as toml.JsonMap).subprocess as toml.JsonMap
    delete subprocess.l2_rpc_url
    delete subprocess.block_witness_dir
    expect(toml.parse(cleaned)).to.deep.equal(expected)
    expect(removeRetiredBatchWitnessSources(cleaned)).to.equal(cleaned)
  })

  it('preserves first-run base configs and compiler output without retired fields byte for byte', () => {
    for (const source of ['# initial base\ncoordinator_id = "pc"\n', '[materializer.scroll_batch.subprocess]\nbinary_path = "/bin/materializer"\n']) {
      expect(removeRetiredBatchWitnessSources(source)).to.equal(source)
    }
  })
})
