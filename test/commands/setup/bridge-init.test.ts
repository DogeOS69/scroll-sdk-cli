import { expect } from 'chai'

import BridgeInitCommand, {
  BRIDGE_TIMELOCK_MARGIN_BLOCKS,
  BRIDGE_TIMELOCK_RELATIVE_BLOCKS,
  buildEthereumDaProtocolSeedConfig,
  buildInitialSystemSignerChoices,
  resolveBridgeTimelock,
  resolveInitialSystemSignerFromDogeConfig,
} from '../../../src/commands/setup/bridge-init.js'

describe('setup bridge-init explicit Kubernetes context', () => {
  it('offers a context flag with KUBE_CONTEXT environment fallback', () => {
    expect(BridgeInitCommand.flags['kube-context'].env).to.equal('KUBE_CONTEXT')
    expect(BridgeInitCommand.flags['kube-context'].description).to.contain('Ethereum DA RPC probe')
  })

  it('describes funding according to configured transaction kinds, not a fixed count', () => {
    expect(BridgeInitCommand.flags.step.description).to.contain('bridge-funding and/or deposit-seed')
    expect(BridgeInitCommand.flags.step.description).not.to.contain('10 initial bridge funding')
  })
})

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
    ethereumDa: {
      chainId: 32_382,
    },
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
        initialSystemSigner: '0x11ef0dA913139F4EDa64792e2EaC011DD9B8D1B3',
        network: 'testnet',
      },
      helpers
    )

    expect(result.protocol).to.deep.equal({
      dogecoin_chain_id: 111_111,
      eth_chain_id: 32_382,
      l2_chain_id: 412_346,
      protocol_version: 2,
    })
    expect(result.chain_anchors.initial_ethereum_block_hash).to.equal(
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    )
    expect(result.chain_anchors.initial_tx_index).to.equal(0)
    expect(result.chain_anchors.initial_tx_blob_index).to.equal(0)
    expect(result.chain_anchors.initial_system_signer).to.equal('0x11ef0dA913139F4EDa64792e2EaC011DD9B8D1B3')
    expect(result.protocol_config_seed.protocol_config).to.deep.equal({
      deposit_queue_transform: {
        l1_scroll_messenger_address: '0x0000000000000000000000000000000000000001',
        l2_messenger_address: '0x0000000000000000000000000000000000000002',
        message_queue_gas_limit: 200_000,
        moat_address: '0x0000000000000000000000000000000000000003',
      },
      eth_chain_id: 32_382,
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

  it('overwrites initial_system_signer from doge-config input', () => {
    const result = buildEthereumDaProtocolSeedConfig(
      {
        configToml,
        contractsConfig,
        existingProtocolSeedConfig: {
          chain_anchors: {
            initial_system_signer: '0x0000000000000000000000000000000000000001',
          },
        },
        initialSystemSigner: '0xEE8dE6f473019dF6b8777252178D3cE1517694bB',
        network: 'testnet',
      },
      helpers
    )

    expect(result.chain_anchors.initial_system_signer).to.equal('0xEE8dE6f473019dF6b8777252178D3cE1517694bB')
  })

  it('preserves explicit protocol config policy values', () => {
    const result = buildEthereumDaProtocolSeedConfig(
      {
        configToml,
        contractsConfig,
        existingProtocolSeedConfig: {
          protocol_config_seed: {
            protocol_config: {
              deposit_queue_transform: {
                message_queue_gas_limit: 250_000,
              },
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
    expect(
      result.protocol_config_seed.protocol_config.deposit_queue_transform.message_queue_gas_limit
    ).to.equal(250_000)
  })
})

describe('setup bridge-init doge-config sequencer signer resolution', () => {
  it('uses the sequencerReth instance with index 0 as initial_system_signer', () => {
    const result = resolveInitialSystemSignerFromDogeConfig({
      sequencerReth: {
        instances: [
          {
            index: 1,
            signer: { address: '0xEE8dE6f473019dF6b8777252178D3cE1517694bB' },
          },
          {
            index: 0,
            signer: { address: '0x11ef0dA913139F4EDa64792e2EaC011DD9B8D1B3' },
          },
        ],
      },
    })

    expect(result).to.equal('0x11ef0dA913139F4EDa64792e2EaC011DD9B8D1B3')
  })

  it('falls back to the lowest-index sequencer when index 0 is absent', () => {
    const result = resolveInitialSystemSignerFromDogeConfig({
      sequencerReth: {
        instances: [
          {
            index: 5,
            signer: { address: '0x5555555555555555555555555555555555555555' },
          },
          {
            index: 3,
            signer: { address: '0x3333333333333333333333333333333333333333' },
          },
        ],
      },
    })

    expect(result).to.equal('0x3333333333333333333333333333333333333333')
  })
})

describe('setup bridge-init protocol seed sequencer signer selection', () => {
  const existingSigner = '0x1111111111111111111111111111111111111111'
  const primarySequencerSigner = '0x2222222222222222222222222222222222222222'

  it('shows both signer addresses and a custom-address option', () => {
    expect(buildInitialSystemSignerChoices(existingSigner, primarySequencerSigner)).to.deep.equal([
      {
        name: `Keep existing Protocol Seed value: ${existingSigner}`,
        value: 'existing',
      },
      {
        name: `Use primary Sequencer signer: ${primarySequencerSigner}`,
        value: 'primary-sequencer',
      },
      {
        name: 'Enter a different EVM address',
        value: 'custom',
      },
    ])
  })

  it('allows a custom address even when the existing and primary values are the same', () => {
    const choices = buildInitialSystemSignerChoices(existingSigner, existingSigner)

    expect(choices).to.deep.include({
      name: 'Enter a different EVM address',
      value: 'custom',
    })
  })

  it('offers the primary and custom choices when no existing value is available', () => {
    expect(buildInitialSystemSignerChoices(undefined, primarySequencerSigner)).to.deep.equal([
      {
        name: `Use primary Sequencer signer: ${primarySequencerSigner}`,
        value: 'primary-sequencer',
      },
      {
        name: 'Enter a different EVM address',
        value: 'custom',
      },
    ])
  })
})
