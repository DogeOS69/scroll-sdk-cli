import { expect } from 'chai'

import {
  buildL2RethEnvContent,
  buildL2RethEnvVars,
} from '../../../src/commands/setup/gen-rpc-package.js'

describe('setup gen-rpc-package l2reth env generation', () => {
  it('emits reth-specific env keys without L2GETH dependencies', () => {
    const vars = buildL2RethEnvVars(
      { general: { CHAIN_ID_L2: 534_351 } },
      {
        defaults: { dogecoinIndexerStartHeight: '8200000' },
        network: 'testnet',
        wallet: { path: '/tmp/wallet.dat' },
      },
      '["enode://bootnode@example.com:30303"]',
      '0x1234567890123456789012345678901234567890',
    )
    const content = buildL2RethEnvContent('Testnet', vars)

    expect(content).to.include('CHAIN_ID=534351')
    expect(content).to.include('L2RETH_L1_CONTRACT_DEPLOYMENT_BLOCK=8200000')
    expect(content).to.include('L2RETH_PEER_LIST=["enode://bootnode@example.com:30303"]')
    expect(content).to.include('L2RETH_VALID_SIGNER=0x1234567890123456789012345678901234567890')
    expect(content).to.include('L2RETH_L1_ENDPOINT=http://l1-interface:8545')
    expect(content).to.include('L2RETH_BEACON_ENDPOINT=http://l1-interface:5052')
    expect(content).not.to.include('L2GETH_')
  })
})
