import { expect } from 'chai'

import {
  applyFeeOracleCurrentEnv,
  buildEthDaSubmitterPrepEnv,
  buildFeeOraclePrepEnv,
  scrubFeeOracleLegacyValues,
  shouldSkipL2ContractDeploymentBlockUpdate,
} from '../../../src/commands/setup/prep-charts.js'

describe('setup prep-charts L2 contract deployment block updates', () => {
  it('does not skip L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK by default', () => {
    expect(
      shouldSkipL2ContractDeploymentBlockUpdate(
        'l2-rpc',
        'L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK',
        false
      )
    ).to.equal(false)
  })

  it('skips L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK for L2 charts when requested', () => {
    for (const chartName of ['l2-rpc', 'l2-bootnode', 'l2-sequencer']) {
      expect(
        shouldSkipL2ContractDeploymentBlockUpdate(
          chartName,
          'L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK',
          true
        )
      ).to.equal(true)
    }
  })

  it('does not skip other keys or non-L2 charts', () => {
    expect(
      shouldSkipL2ContractDeploymentBlockUpdate(
        'l2-rpc',
        'L2GETH_PEER_LIST',
        true
      )
    ).to.equal(false)

    expect(
      shouldSkipL2ContractDeploymentBlockUpdate(
        'l1-interface',
        'L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK',
        true
      )
    ).to.equal(false)
  })
})

describe('setup prep-charts fee-oracle updates', () => {
  it('scrubs legacy Dogecoin/Celestia fee-oracle config and writes current Ethereum DA env', () => {
    const values: any = {
      configMaps: {
        env: {
          data: {
            DOGEOS_FEE_ORACLE_CELESTIA__ENABLED: 'false',
            DOGEOS_FEE_ORACLE_DOGECOIN__NETWORK_STR: 'testnet',
            DOGEOS_FEE_ORACLE_DOGECOIN__RPC_URL: 'http://dogecoin:44555',
            DOGEOS_FEE_ORACLE_PRICE_ORACLE__UPDATE_ON_EACH_CYCLE: 'true',
            DOGEOS_FEE_ORACLE_THRESHOLDS__DEFAULT_DOGECOIN_FEE: '1000000',
          },
        },
      },
      env: [
        { name: 'RUST_LOG', value: 'info' },
        { name: 'FEE_ORACLE_DOGE_RPC_URL', value: 'http://dogecoin:44555' },
      ],
      envFrom: [
        { secretRef: { name: 'fee-oracle-secret-env' } },
        { configMapRef: { name: 'fee-oracle-env' } },
      ],
      externalSecrets: {
        'fee-oracle-secret-env': {
          provider: 'aws',
        },
      },
    }

    const currentEnv = buildFeeOraclePrepEnv({
      ethereumDaRpcUrl: 'https://eth.example',
      gasOracleContract: '0x5300000000000000000000000000000000000002',
      l2ChainId: 6_281_971,
      l2RpcUrl: 'http://l2-rpc:8545',
    })

    const changes = [
      ...scrubFeeOracleLegacyValues(values),
      ...applyFeeOracleCurrentEnv(values, currentEnv),
    ]

    expect(changes.map(change => change.key)).to.include('configMaps.env.data.DOGEOS_FEE_ORACLE_DOGECOIN__RPC_URL')
    expect(values.configMaps.env.data).not.to.have.property('DOGEOS_FEE_ORACLE_DOGECOIN__RPC_URL')
    expect(values.configMaps.env.data).not.to.have.property('DOGEOS_FEE_ORACLE_CELESTIA__ENABLED')
    expect(values.configMaps.env.data).not.to.have.property('DOGEOS_FEE_ORACLE_THRESHOLDS__DEFAULT_DOGECOIN_FEE')
    expect(values.configMaps.env.data).not.to.have.property('DOGEOS_FEE_ORACLE_PRICE_ORACLE__UPDATE_ON_EACH_CYCLE')
    expect(values.configMaps.env.data.DOGEOS_FEE_ORACLE_ETHEREUM_DA__CONTRACT_WRITE_MODE).to.equal('dry_run')
    expect(values.configMaps.env.data.DOGEOS_FEE_ORACLE_ETHEREUM_DA__ETH_RPC_URL).to.equal('https://eth.example')
    expect(values.configMaps.env.data.DOGEOS_FEE_ORACLE_ETHEREUM_DA__MIN_PRIORITY_FEE_PER_GAS_WEI).to.equal('"0"')
    expect(values.configMaps.env.data.DOGEOS_FEE_ORACLE_L2__RPC_URL).to.equal('http://l2-rpc:8545')
    expect(values.configMaps.env.data.DOGEOS_FEE_ORACLE_WALLET__PRIVATE_KEY_ENV).to.equal('DOGEOS_FEE_ORACLE_PRIVATE_KEY')
    expect(values.env).to.deep.equal([{ name: 'RUST_LOG', value: 'info' }])
    expect(values.envFrom).to.deep.equal([{ configMapRef: { name: 'fee-oracle-env' } }])
    expect(values).not.to.have.property('externalSecrets')
  })
})

describe('setup prep-charts eth-da-submitter updates', () => {
  it('does not include cutover or genesis frontier env because another script owns cutover', () => {
    const env = buildEthDaSubmitterPrepEnv({
      ethereumChainId: 1,
      ethereumRpcUrl: 'https://eth.example',
      l2ChainId: 6_281_971,
      l2RpcUrl: 'http://l2-rpc:8545',
    })

    expect(env).to.deep.equal({
      DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__ETH_CHAIN_ID: '1',
      DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__L2_CHAIN_ID: '6281971',
      DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__RPC_URL: 'https://eth.example',
      DOGEOS_ETH_DA_SUBMITTER_L2__RPC_URL: 'http://l2-rpc:8545',
    })

    for (const key of Object.keys(env)) {
      expect(key).not.to.include('CUTOVER')
      expect(key).not.to.include('GENESIS')
      expect(key).not.to.include('FRONTIER')
    }
  })
})
