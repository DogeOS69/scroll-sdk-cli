import { expect } from 'chai'

import {
  BRIDGE_TIMELOCK_MARGIN_BLOCKS,
  BRIDGE_TIMELOCK_RELATIVE_BLOCKS,
  buildEthereumDaProtocolSeedConfig,
  resolveBridgeTimelock,
} from '../../../src/commands/setup/bridge-init.js'

describe('setup bridge-init timelock resolution', () => {
  const currentHeight = 50_579_598
  const desiredTimelock = currentHeight + BRIDGE_TIMELOCK_RELATIVE_BLOCKS + BRIDGE_TIMELOCK_MARGIN_BLOCKS

  it('rewrites the template placeholder to a future Dogecoin absolute height', () => {
    const result = resolveBridgeTimelock(100, currentHeight)

    expect(result).to.deep.equal({
      reason: 'placeholder',
      shouldUpdate: true,
      timelock: desiredTimelock,
    })
  })

  it('keeps an existing future Dogecoin absolute height for idempotent reruns', () => {
    const result = resolveBridgeTimelock(50_838_898, currentHeight)

    expect(result).to.deep.equal({
      shouldUpdate: false,
      timelock: 50_838_898,
    })
  })

  it('rewrites an expired timelock', () => {
    const result = resolveBridgeTimelock(currentHeight, currentHeight)

    expect(result).to.deep.equal({
      reason: 'expired',
      shouldUpdate: true,
      timelock: desiredTimelock,
    })
  })

  it('rejects timestamp-semantics timelocks', () => {
    expect(() => resolveBridgeTimelock(500_000_000, currentHeight)).to.throw(
      'Existing timelock 500000000 is not a Dogecoin block-height CLTV value'
    )
  })
})

describe('setup bridge-init protocol seed generation', () => {
  const contractsConfig = {
    L1_SCROLL_MESSENGER_PROXY_ADDR: '0x0000000000000000000000000000000000000001',
    L2_DOGEOS_MESSENGER_PROXY_ADDR: '0x0000000000000000000000000000000000000002',
    L2_MOAT_PROXY_ADDR: '0x0000000000000000000000000000000000000003',
  }
  const configToml = {
    general: {
      CHAIN_ID_L1: 31_337,
      CHAIN_ID_L2: 412_346,
    },
    rollup: {
      MAX_L1_MESSAGE_GAS_LIMIT: 1_000_000,
    },
  }
  type ConfigSection = Record<string, number | string>
  type ContractsConfig = Record<string, string>
  const helpers = {
    getContractAddress: (config: ContractsConfig, key: string) => config[key],
    getNumberValue: (source: ConfigSection, key: string) => Number(source[key]),
    resolveDogecoinChainId: () => 111_111,
  }

  it('writes Ethereum DA protocol seed fields', () => {
    const result = buildEthereumDaProtocolSeedConfig(
      {
        configToml,
        contractsConfig,
        network: 'testnet',
      },
      helpers
    )

    expect(result.protocol).to.deep.equal({
      dogecoin_chain_id: 111_111,
      eth_chain_id: 31_337,
      l2_chain_id: 412_346,
      protocol_version: 2,
    })
    expect(result.chain_anchors.initial_ethereum_block_hash).to.equal(
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    )
    expect(result.chain_anchors.initial_tx_index).to.equal(0)
    expect(result.chain_anchors.initial_tx_blob_index).to.equal(0)
    expect(result.protocol_config_seed.protocol_config).to.deep.equal({
      deposit_queue_transform: {
        l1_scroll_messenger_address: '0x0000000000000000000000000000000000000001',
        l2_messenger_address: '0x0000000000000000000000000000000000000002',
        message_queue_gas_limit: 1_000_000,
        moat_address: '0x0000000000000000000000000000000000000003',
      },
      eth_chain_id: 31_337,
      key_rotation_min_grace_wf_txs: 100,
      l2_chain_id: 412_346,
      min_deposit_sats: 100_000,
    })
    expect(result.protocol).not.to.have.property('celestia_namespace')
    expect(result.chain_anchors).not.to.have.property('initial_celestia_height')
    expect(result.protocol_config_seed.protocol_config).not.to.have.property('celestia_namespace')
  })

  it('removes deprecated Celestia DA fields from an existing protocol seed', () => {
    const result = buildEthereumDaProtocolSeedConfig(
      {
        configToml,
        contractsConfig,
        existingProtocolSeedConfig: {
          chain_anchors: {
            initial_celestia_height: 123,
          },
          protocol: {
            celestia_namespace: '0x1234',
            protocol_version: 1,
          },
          protocol_config_seed: {
            protocol_config: {
              celestia_namespace: '0x1234',
            },
          },
        },
        network: 'testnet',
      },
      helpers
    )

    expect(result.protocol.protocol_version).to.equal(2)
    expect(result.protocol).not.to.have.property('celestia_namespace')
    expect(result.chain_anchors).not.to.have.property('initial_celestia_height')
    expect(result.protocol_config_seed.protocol_config).not.to.have.property('celestia_namespace')
  })

  it('preserves genesis artifacts computed by update_protocol_seed_from_genesis', () => {
    const result = buildEthereumDaProtocolSeedConfig(
      {
        configToml,
        contractsConfig,
        existingProtocolSeedConfig: {
          chain_anchors: {
            genesis_batch_hash: `0x${'11'.repeat(32)}`,
            genesis_state_root: `0x${'22'.repeat(32)}`,
          },
        },
        network: 'testnet',
      },
      helpers
    )

    expect(result.chain_anchors.genesis_batch_hash).to.equal(`0x${'11'.repeat(32)}`)
    expect(result.chain_anchors.genesis_state_root).to.equal(`0x${'22'.repeat(32)}`)
  })

  it('preserves explicit protocol config policy values', () => {
    const result = buildEthereumDaProtocolSeedConfig(
      {
        configToml,
        contractsConfig,
        existingProtocolSeedConfig: {
          protocol_config_seed: {
            protocol_config: {
              key_rotation_min_grace_wf_txs: 12,
              min_deposit_sats: 34_567,
            },
          },
        },
        network: 'testnet',
      },
      helpers
    )

    expect(result.protocol_config_seed.protocol_config.key_rotation_min_grace_wf_txs).to.equal(12)
    expect(result.protocol_config_seed.protocol_config.min_deposit_sats).to.equal(34_567)
  })
})
