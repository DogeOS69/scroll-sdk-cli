import { expect } from 'chai'

import {
  applyConfigMapEnvValues,
  applyFeeOracleCurrentEnv,
  buildEthDaSubmitterPrepEnv,
  buildFeeOraclePrepEnv,
  buildL1InterfaceBlobSourcePrepEnv,
  buildWithdrawalBlobSourcePrepEnv,
  removeConfigMapEnvKeys,
  removeEnvArrayKeys,
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

  it('writes S3 upload env when S3 archive is enabled', () => {
    const env = buildEthDaSubmitterPrepEnv({
      ethereumChainId: 1,
      ethereumRpcUrl: 'https://eth.example',
      l2ChainId: 6_281_971,
      l2RpcUrl: 'http://l2-rpc:8545',
      s3Bucket: 'dogeos-da',
      s3Enabled: true,
      s3ForcePathStyle: false,
      s3MaxRetries: 5,
      s3Region: 'us-east-1',
    })

    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__ENABLED).to.equal('true')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__BUCKET).to.equal('dogeos-da')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__REGION).to.equal('us-east-1')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__FORCE_PATH_STYLE).to.equal('false')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__MAX_RETRIES).to.equal('5')
  })
})

describe('setup prep-charts Ethereum DA blob source updates', () => {
  it('writes beacon_node provider env for l1-interface and removes legacy kind', () => {
    const values: { configMaps: { env: { data: Record<string, string> } } } = {
      configMaps: {
        env: {
          data: {
            DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__KIND: 'anvil',
            DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__TIMEOUT_MS: '5000',
          },
        },
      },
    }

    const env = buildL1InterfaceBlobSourcePrepEnv({
      beaconRpcUrl: 'https://beacon.example',
    })
    const changes = [
      ...removeConfigMapEnvKeys(values, [
        'DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__KIND',
      ]),
      ...applyConfigMapEnvValues(values, env),
    ]

    expect(changes.map(change => change.key)).to.include('configMaps.env.data.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__KIND')
    expect(values.configMaps.env.data).not.to.have.property('DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__KIND')
    expect(values.configMaps.env.data.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL).to.equal('https://beacon.example')
    expect(values.configMaps.env.data.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__TIMEOUT_MS).to.equal('10000')
  })

  it('writes S3 blob source env for l1-interface', () => {
    const env = buildL1InterfaceBlobSourcePrepEnv({
      beaconRpcUrl: 'https://beacon.example',
      s3PublicBaseUrl: 'https://dogeos-da.s3.us-east-1.amazonaws.com/',
      s3TimeoutMs: 15_000,
      s3TreatForbiddenAsMissing: false,
    })

    expect(env.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL).to.equal('https://dogeos-da.s3.us-east-1.amazonaws.com/')
    expect(env.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TIMEOUT_MS).to.equal('15000')
    expect(env.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TREAT_FORBIDDEN_AS_MISSING).to.equal('false')
  })

  it('writes beacon_node provider env for withdrawal-processor and removes legacy kind', () => {
    const values: { env: Array<{ name: string; value?: string }> } = {
      env: [
        { name: 'DOGEOS_WITHDRAWAL_NETWORK_STR', value: 'testnet' },
        { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__KIND', value: 'anvil' },
      ],
    }

    const env = buildWithdrawalBlobSourcePrepEnv({
      beaconRpcUrl: 'https://beacon.example',
    })
    const changes = removeEnvArrayKeys(values, [
      'DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__KIND',
    ])

    for (const [name, value] of Object.entries(env)) {
      values.env.push({ name, value })
    }

    expect(changes.map(change => change.key)).to.deep.equal([
      'env.DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__KIND',
    ])
    expect(values.env.map(item => item.name)).not.to.include('DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__KIND')
    expect(values.env.find(item => item.name === 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL')?.value).to.equal('https://beacon.example')
    expect(values.env.find(item => item.name === 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__TIMEOUT_MS')?.value).to.equal('10000')
  })

  it('writes S3 blob source env for withdrawal-processor', () => {
    const env = buildWithdrawalBlobSourcePrepEnv({
      beaconRpcUrl: 'https://beacon.example',
      s3PublicBaseUrl: 'https://dogeos-da.s3.us-east-1.amazonaws.com/',
      s3TimeoutMs: '15000',
      s3TreatForbiddenAsMissing: 'false',
    })

    expect(env.DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL).to.equal('https://dogeos-da.s3.us-east-1.amazonaws.com/')
    expect(env.DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TIMEOUT_MS).to.equal('15000')
    expect(env.DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TREAT_FORBIDDEN_AS_MISSING).to.equal('false')
  })
})
