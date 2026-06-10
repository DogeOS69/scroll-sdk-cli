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

  it('rejects missing L2 chain ID for l2reth.env', () => {
    expect(() => buildL2RethEnvVars(
      { general: {} },
      {
        defaults: { dogecoinIndexerStartHeight: '8200000' },
        network: 'testnet',
        wallet: { path: '/tmp/wallet.dat' },
      },
      undefined,
      '0x1234567890123456789012345678901234567890',
    )).to.throw('general.CHAIN_ID_L2')
  })

  it('rejects missing Dogecoin indexer start height for l2reth.env', () => {
    expect(() => buildL2RethEnvVars(
      { general: { CHAIN_ID_L2: 534_351 } },
      {
        defaults: {},
        network: 'testnet',
        wallet: { path: '/tmp/wallet.dat' },
      },
      undefined,
      '0x1234567890123456789012345678901234567890',
    )).to.throw('defaults.dogecoinIndexerStartHeight')
  })
})
