import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  applyConfigMapEnvValues,
  applyEthDaSubmitterInitialBatchSidecar,
  applyFeeOracleCurrentEnv,
  applyL2RethRpcPublicIngressPolicy,
  applyL2RethRpcRuntimeValues,
  applyRethBlobS3Url,
  applyRethNetworkId,
  buildEthDaSubmitterPrepEnv,
  buildFeeOraclePrepEnv,
  buildL1InterfaceBlobSourcePrepEnv,
  buildTsoSigners,
  buildWithdrawalBlobSourcePrepEnv,
  getEthereumDaS3PublicBaseUrl,
  getEthereumDaS3PublicBlobUrl,
  getL2RethRpcIngressConfigKey,
  getProductionChartName,
  isL2RethBlobS3Chart,
  removeConfigMapEnvKeys,
  removeEnvArrayKeys,
  removeL2GethBlobS3ExtraParams,
  removeRetiredAttestationSignerValues,
  scrubFeeOracleLegacyValues,
  scrubL1InterfaceRetiredEnv,
  scrubWithdrawalLegacyProofEnv,
  shouldSkipL2ContractDeploymentBlockUpdate,
  validateDogeConfigEthereumDaForPrep,
} from '../../../src/commands/setup/prep-charts.js'
import { ensureWithdrawalProofActivationSwitch } from '../../../src/utils/withdrawal-config.js'

const VALID_PREP_CUTOVER = {
  lastBatchHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
  lastBatchIndex: 4379,
  nextRelayedDepositIndex: 24_922,
  nextWithdrawIndex: 13_047,
  relayedDepositQueueHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
  stateRoot: '0x3333333333333333333333333333333333333333333333333333333333333333',
  withdrawRoot: '0x4444444444444444444444444444444444444444444444444444444444444444',
}

describe('setup prep-charts withdrawal proof config migration', () => {
  it('removes TOML-owned proof env and source-confirmed retired env', () => {
    const retired = [
      'DOGEOS_WITHDRAWAL_COORDINATOR_POLL_INTERVAL_SECS',
      'DOGEOS_WITHDRAWAL_PROVING_MODE',
      'DOGEOS_WITHDRAWAL_SCROLL_PROOF_INPUT_POLICY',
      'DOGEOS_WITHDRAWAL_PROOF_TASK_POLICY__SKIP_SCROLL_EXECUTION_PROOFS',
      'DOGEOS_WITHDRAWAL_PROOF_EXECUTION_WORKER__ENABLED',
      'DOGEOS_WITHDRAWAL_LOCAL_BRIDGE_PROOF_RUNTIME__ARTIFACT_STORE_ROOT',
      'DOGEOS_WITHDRAWAL_SCROLL_WORKER_API__ENABLED',
      'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__PROOF_MODE',
      'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__VERIFICATION_POLICY',
      'DOGEOS_WITHDRAWAL_PROOF_CONTROL_PLANE_GATE__VERIFIER_IMPORT_MODE',
      'DOGEOS_WITHDRAWAL_PROOF_ARTIFACT_TRANSPORT__KIND',
    ]
    const values: any = {
      env: [
        ...retired.map(name => ({ name, value: 'legacy' })),
        { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE', value: 'legacy' },
        { name: 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__ENABLED', value: 'legacy' },
        { name: 'DOGEOS_WITHDRAWAL_CLEANUP_TIMEOUT_SECS', value: '3600' },
      ],
    }

    const changes = scrubWithdrawalLegacyProofEnv(values)
    ensureWithdrawalProofActivationSwitch(values)

    expect(changes.map(change => change.key)).to.have.members(retired.map(name => `env.${name}`))
    const env = Object.fromEntries(values.env.map((item: any) => [item.name, item.value]))
    expect(env.DOGEOS_WITHDRAWAL_CLEANUP_TIMEOUT_SECS).to.equal('3600')
    expect(env.DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE).to.equal('disabled')
    expect(env.DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_SCROLL_EXECUTION).to.equal('false')
    expect(env.DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_BRIDGE_STATE).to.equal('false')
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_PROOF_WORK_API__ENABLED')
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_PROOF_SYSTEM__DEV_DUMMY__SCROLL_INPUT')
    expect(values.withdrawalProof.enabled).to.equal(false)
    expect(values.withdrawalProof.mode).to.equal('disabled')
    expect(values.withdrawalProof.provingMode).to.equal(undefined)
  })
})

describe('setup prep-charts retired attestation-signer cleanup', () => {
  it('removes only the retired signer values files', () => {
    const valuesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-retired-signer-'))
    try {
      for (const file of [
        'attestation-signer-production.yaml',
        'attestation-signer-production-0.yaml',
        'attestation-signer-production-12.yaml',
        'withdrawal-processor-production.yaml',
      ]) fs.writeFileSync(path.join(valuesDir, file), 'enabled: true\n')

      expect(removeRetiredAttestationSignerValues(valuesDir)).to.deep.equal([
        'attestation-signer-production-0.yaml',
        'attestation-signer-production-12.yaml',
        'attestation-signer-production.yaml',
      ])
      expect(fs.readdirSync(valuesDir)).to.deep.equal(['withdrawal-processor-production.yaml'])
    } finally {
      fs.rmSync(valuesDir, { force: true, recursive: true })
    }
  })
})

describe('setup prep-charts external attestation signer routing', () => {
  it('preserves descriptor IP/domain endpoints in the TSO signer list', () => {
    expect(buildTsoSigners({
      cubesigner: { roles: [
        { keys: [], name: 'tee-0', role_id: 'role-0' },
        { keys: [], name: 'tee-1', role_id: 'role-1' },
      ] },
      network: 'testnet',
      signerUrls: [
        'https://signer.partner-a.example:4040',
        'http://10.20.30.40:4040',
      ],
    })).to.deep.equal([
      { network: 'testnet', role: 'Tee', uri: 'http://cubesigner-signer-0:3000' },
      { network: 'testnet', role: 'Tee', uri: 'http://cubesigner-signer-1:3000' },
      { network: 'testnet', role: 'Attestation', uri: 'https://signer.partner-a.example:4040' },
      { network: 'testnet', role: 'Attestation', uri: 'http://10.20.30.40:4040' },
    ])
  })
})

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
    expect(values.configMaps.env.data.DOGEOS_FEE_ORACLE_ETHEREUM_DA__ETH_RPC_URL).to.equal('https://eth.example')
    expect(values.configMaps.env.data.DOGEOS_FEE_ORACLE_L2__CHAIN_ID).to.equal('6281971')
    expect(values.configMaps.env.data.DOGEOS_FEE_ORACLE_L2__GAS_ORACLE_CONTRACT).to.equal('0x5300000000000000000000000000000000000002')
    expect(values.configMaps.env.data.DOGEOS_FEE_ORACLE_L2__RPC_URL).to.equal('http://l2-rpc:8545')
    expect(values.configMaps.env.data).not.to.have.property('DOGEOS_FEE_ORACLE_ETHEREUM_DA__CONTRACT_WRITE_MODE')
    expect(values.configMaps.env.data).not.to.have.property('DOGEOS_FEE_ORACLE_ETHEREUM_DA__GAS_ORACLE__FORMULA')
    expect(values.configMaps.env.data).not.to.have.property('DOGEOS_FEE_ORACLE_ETHEREUM_DA__UPDATE_POLICY__PRICE_UNAVAILABLE_FALLBACK')
    expect(values.configMaps.env.data).not.to.have.property('DOGEOS_FEE_ORACLE_WALLET__PRIVATE_KEY_ENV')
    expect(values.env).to.deep.equal([{ name: 'RUST_LOG', value: 'info' }])
    expect(values.envFrom).to.deep.equal([
      { secretRef: { name: 'fee-oracle-secret-env' } },
      { configMapRef: { name: 'fee-oracle-env' } },
    ])
    expect(values.externalSecrets).to.have.property('fee-oracle-secret-env')
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
      s3KeyPrefix: 'devnet/eth-da/blobs/v1',
      s3MaxRetries: 5,
      s3Region: 'us-east-1',
    })

    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__ENABLED).to.equal('true')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__BUCKET).to.equal('dogeos-da')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__REGION).to.equal('us-east-1')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__KEY_PREFIX).to.equal('devnet/eth-da/blobs/v1')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__FORCE_PATH_STYLE).to.equal('false')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__MAX_RETRIES).to.equal('5')
  })

  it('writes optional cutover, publish, L2 start, and initial-batch sidecar values', () => {
    const env = buildEthDaSubmitterPrepEnv({
      batch: {
        compression: 'none',
        cutover: {
          lastBatchHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
          lastBatchIndex: 4379,
          nextRelayedDepositIndex: 24_922,
          nextWithdrawIndex: 13_047,
          relayedDepositQueueHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
          stateRoot: '0x3333333333333333333333333333333333333333333333333333333333333333',
          withdrawRoot: '0x4444444444444444444444444444444444444444444444444444444444444444',
        },
        initialBatchSidecarJson: '{"batch":4380}',
        maxL2GasPerChunk: 30_000_000,
      },
      ethereumChainId: 1,
      ethereumRpcUrl: 'https://eth.example',
      l2ChainId: 6_281_971,
      l2RpcUrl: 'http://l2-rpc:8545',
      l2StartBlockNumber: 2_898_792,
      publish: {
        allowLivenessBudgetOverride: true,
        maxBatchWait: '60s',
        targetBlobsPerTx: 2,
      },
    })

    expect(env.DOGEOS_ETH_DA_SUBMITTER_L2__START_BLOCK_NUMBER).to.equal('2898792')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_BATCH__COMPRESSION).to.equal('none')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_BATCH_HASH).to.equal('0x1111111111111111111111111111111111111111111111111111111111111111')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_WITHDRAW_ROOT).to.equal('0x4444444444444444444444444444444444444444444444444444444444444444')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__LAST_BATCH_INDEX).to.equal('4379')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__WITHDRAW_ROOT).to.equal('0x4444444444444444444444444444444444444444444444444444444444444444')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_BATCH__INITIAL_BATCH_SIDECAR_JSON).to.equal('/app/config/initial_batch.json')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_BLOCKS_PER_CHUNK).to.equal('128')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_L2_GAS_PER_CHUNK).to.equal('30000000')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_PUBLISH__ALLOW_LIVENESS_BUDGET_OVERRIDE).to.equal('true')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_PUBLISH__TARGET_BLOBS_PER_TX).to.equal('2')

    const values: any = { configMaps: { env: { data: {} } }, persistence: {} }
    const changes = applyEthDaSubmitterInitialBatchSidecar(values, '  {"batch":4380}  ')

    expect(changes.map(change => change.key)).to.include('configMaps.initial-batch')
    expect(values.configMaps['initial-batch'].data['initial_batch.json']).to.equal('{"batch":4380}')
    expect(values.persistence['initial-batch'].mountPath).to.equal('/app/config')
  })

  it('does not emit an initial-batch sidecar env or mount for whitespace', () => {
    const env = buildEthDaSubmitterPrepEnv({
      batch: { initialBatchSidecarJson: '   ' },
      ethereumChainId: 1,
      ethereumRpcUrl: 'https://eth.example',
      l2ChainId: 6_281_971,
      l2RpcUrl: 'http://l2-rpc:8545',
    })

    expect(env).not.to.have.property('DOGEOS_ETH_DA_SUBMITTER_BATCH__INITIAL_BATCH_SIDECAR_JSON')

    const values: any = { configMaps: { env: { data: {} } }, persistence: {} }
    const changes = applyEthDaSubmitterInitialBatchSidecar(values, '   ')

    expect(changes).to.deep.equal([])
    expect(values.configMaps).not.to.have.property('initial-batch')
    expect(values.persistence).not.to.have.property('initial-batch')
  })

  it('throws on invalid initial-batch sidecar JSON', () => {
    expect(() => buildEthDaSubmitterPrepEnv({
      batch: { initialBatchSidecarJson: '{"batch":' },
      ethereumChainId: 1,
      ethereumRpcUrl: 'https://eth.example',
      l2ChainId: 6_281_971,
      l2RpcUrl: 'http://l2-rpc:8545',
    })).to.throw(/ethereumDa\.batch\.initialBatchSidecarJson/)

    expect(() => applyEthDaSubmitterInitialBatchSidecar({}, '{"batch":')).to.throw(/ethereumDa\.batch\.initialBatchSidecarJson/)
  })

  it('validates doge-config cutover and L2 start block together', () => {
    expect(() => validateDogeConfigEthereumDaForPrep({
      l2StartBlockNumber: 0,
    })).to.throw(/ethereumDa\.batch\.cutover/)

    expect(() => validateDogeConfigEthereumDaForPrep({
      batch: { cutover: VALID_PREP_CUTOVER },
    })).to.throw(/ethereumDa\.l2StartBlockNumber/)

    expect(() => validateDogeConfigEthereumDaForPrep({
      batch: { cutover: VALID_PREP_CUTOVER },
      l2StartBlockNumber: 0,
    })).not.to.throw()
  })

  it('validates doge-config hash, sidecar, and publish fields', () => {
    expect(() => validateDogeConfigEthereumDaForPrep({
      batch: {
        compression: 'gzip' as any,
      },
    })).to.throw(/ethereumDa\.batch\.compression/)

    const cutoverWithMissingIndex = { ...VALID_PREP_CUTOVER }
    delete (cutoverWithMissingIndex as any).nextWithdrawIndex
    expect(() => validateDogeConfigEthereumDaForPrep({
      batch: {
        cutover: cutoverWithMissingIndex,
      },
      l2StartBlockNumber: 0,
    })).to.throw(/ethereumDa\.batch\.cutover\.nextWithdrawIndex/)

    expect(() => validateDogeConfigEthereumDaForPrep({
      batch: {
        genesisStateRoot: '0x1234',
      },
    })).to.throw(/ethereumDa\.batch\.genesisStateRoot/)

    expect(() => validateDogeConfigEthereumDaForPrep({
      batch: {
        initialBatchSidecarJson: '{"batch":',
      },
    })).to.throw(/ethereumDa\.batch\.initialBatchSidecarJson/)

    expect(() => validateDogeConfigEthereumDaForPrep({
      publish: {
        maxBatchWait: '',
        targetBlobsPerTx: 0,
      },
    })).to.throw(/ethereumDa\.publish/)
  })
})

describe('setup prep-charts Ethereum DA blob source updates', () => {
  it('removes the retired initial system signer from l1-interface YAML', () => {
    const values = {
      configMaps: {
        env: {
          data: {
            DOGEOS_L1_INTERFACE_INITIAL_SYSTEM_SIGNER: '0x1234567890123456789012345678901234567890',
            DOGEOS_L1_INTERFACE_NETWORK_STR: 'testnet',
          },
        },
      },
    }

    const changes = scrubL1InterfaceRetiredEnv(values)

    expect(changes.map(change => change.key)).to.deep.equal([
      'configMaps.env.data.DOGEOS_L1_INTERFACE_INITIAL_SYSTEM_SIGNER',
    ])
    expect(values.configMaps.env.data).not.to.have.property('DOGEOS_L1_INTERFACE_INITIAL_SYSTEM_SIGNER')
    expect(values.configMaps.env.data.DOGEOS_L1_INTERFACE_NETWORK_STR).to.equal('testnet')
  })

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
      s3KeyPrefix: 'devnet/eth-da/blobs/v1',
      s3PublicBaseUrl: 'https://dogeos-da.s3.us-east-1.amazonaws.com/',
      s3TimeoutMs: 15_000,
      s3TreatForbiddenAsMissing: false,
    })

    expect(env.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__KEY_PREFIX).to.equal('devnet/eth-da/blobs/v1')
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
      s3KeyPrefix: 'devnet/eth-da/blobs/v1',
      s3PublicBaseUrl: 'https://dogeos-da.s3.us-east-1.amazonaws.com/',
      s3TimeoutMs: '15000',
      s3TreatForbiddenAsMissing: 'false',
    })

    expect(env.DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__KEY_PREFIX).to.equal('devnet/eth-da/blobs/v1')
    expect(env.DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL).to.equal('https://dogeos-da.s3.us-east-1.amazonaws.com/')
    expect(env.DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TIMEOUT_MS).to.equal('15000')
    expect(env.DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TREAT_FORBIDDEN_AS_MISSING).to.equal('false')
  })

  it('derives public S3 read URLs for blob consumers from bucket metadata', () => {
    const s3Archive = {
      bucket: 'dogeos-da',
      enabled: true,
      keyPrefix: 'devnet/eth-da/blobs/v1',
      region: 'us-east-1',
    }

    expect(getEthereumDaS3PublicBaseUrl(s3Archive)).to.equal('https://dogeos-da.s3.us-east-1.amazonaws.com')
    expect(getEthereumDaS3PublicBlobUrl(s3Archive)).to.equal('https://dogeos-da.s3.us-east-1.amazonaws.com/devnet/eth-da/blobs/v1')
  })

  it('writes reth blobS3Url with the public prefix URL', () => {
    const values: any = { reth: { blobS3Url: '' } }
    const changes = applyRethBlobS3Url(values, 'https://dogeos-da.s3.us-east-1.amazonaws.com/devnet/eth-da/blobs/v1')

    expect(values.reth.blobS3Url).to.equal('https://dogeos-da.s3.us-east-1.amazonaws.com/devnet/eth-da/blobs/v1')
    expect(changes.map(change => change.key)).to.deep.equal(['reth.blobS3Url'])
  })

  it('writes the configured L2 chain ID as the normal Reth P2P network ID', () => {
    const values = { reth: { networkId: '4444444' } }
    const changes = applyRethNetworkId(values, '6281971')

    expect(values.reth.networkId).to.equal('6281971')
    expect(changes).to.deep.equal([{
      key: 'reth.networkId',
      newValue: '6281971',
      oldValue: '4444444',
    }])
  })

  it('targets every concrete Reth values file for shared runtime updates', () => {
    const files = [
      'l2-reth-bootnode-production-0.yaml',
      'l2-reth-bootnode-production-1.yaml',
      'l2-reth-rpc-production.yaml',
      'l2-reth-rpc-public-production.yaml',
      'l2-reth-sequencer-production-0.yaml',
      'l2-reth-sequencer-production-1.yaml',
    ]

    expect(files.map(file => isL2RethBlobS3Chart(getProductionChartName(file)))).to.deep.equal([
      true,
      true,
      true,
      true,
      true,
      true,
    ])
    expect(isL2RethBlobS3Chart(getProductionChartName('l2-geth-rpc-production.yaml'))).to.equal(false)
  })

  it('removes legacy l2geth bootnode S3 extra params', () => {
    const values: any = {
      configMaps: {
        env: {
          data: {
            L2GETH_EXTRA_PARAMS: '--da.blob.awss3 https://dogeos-da.s3.us-east-1.amazonaws.com/devnet/eth-da/blobs/v1',
          },
        },
      },
    }
    const removeChanges = removeL2GethBlobS3ExtraParams(values)

    expect(values.configMaps.env.data).not.to.have.property('L2GETH_EXTRA_PARAMS')
    expect(removeChanges.map(change => change.key)).to.deep.equal(['configMaps.env.data.L2GETH_EXTRA_PARAMS'])
  })
})

describe('setup prep-charts split L2 reth RPC updates', () => {
  it('maps public HTTP and websocket ingresses to RPC gateway domains', () => {
    expect(getL2RethRpcIngressConfigKey('l2-reth-rpc-public', 'main')).to.equal('RPC_GATEWAY_HOST')
    expect(getL2RethRpcIngressConfigKey('l2-reth-rpc-public', 'websocket')).to.equal('RPC_GATEWAY_WS_HOST')
  })

  it('enables public ingresses and configures the production cluster issuer', () => {
    const values: any = {
      ingress: {
        main: {
          annotations: {},
          enabled: false,
          hosts: [{ host: 'rpc.example.com' }],
          tls: [{ hosts: ['stale.example.com'] }],
        },
        websocket: {
          enabled: false,
          hosts: [{ host: 'ws.rpc.example.com' }],
          tls: [{ hosts: ['stale-ws.example.com'] }],
        },
      },
    }

    const changes = applyL2RethRpcPublicIngressPolicy(values)

    expect(values.ingress.main.enabled).to.equal(true)
    expect(values.ingress.websocket.enabled).to.equal(true)
    expect(values.ingress.main.annotations['cert-manager.io/cluster-issuer']).to.equal('letsencrypt-prod')
    expect(values.ingress.websocket.annotations['cert-manager.io/cluster-issuer']).to.equal('letsencrypt-prod')
    expect(values.ingress.main.tls[0].hosts).to.deep.equal(['rpc.example.com'])
    expect(values.ingress.websocket.tls[0].hosts).to.deep.equal(['ws.rpc.example.com'])
    expect(changes.map(change => change.key)).to.have.members([
      'ingress.main.enabled',
      'ingress.main.annotations.cert-manager.io/cluster-issuer',
      'ingress.main.tls[0].hosts',
      'ingress.websocket.enabled',
      'ingress.websocket.annotations.cert-manager.io/cluster-issuer',
      'ingress.websocket.tls[0].hosts',
    ])
  })

  it('applies shared runtime values to either RPC values document', () => {
    const values: any = {
      reth: {
        blobS3Url: 'https://old.example/blobs',
        l1Url: 'https://old.example/l1',
        networkId: '1',
        trustedPeers: 'old-peer',
      },
    }

    const changes = applyL2RethRpcRuntimeValues(values, {
      blobS3Url: 'https://dogeos-da.s3.us-east-1.amazonaws.com/devnet/eth-da/blobs/v1',
      l1Url: 'http://l1-interface:8545',
      networkId: '4444444',
      trustedPeers: 'new-peer',
    })

    expect(values.reth).to.deep.equal({
      blobS3Url: 'https://dogeos-da.s3.us-east-1.amazonaws.com/devnet/eth-da/blobs/v1',
      l1Url: 'http://l1-interface:8545',
      networkId: '4444444',
      trustedPeers: 'new-peer',
    })
    expect(changes.map(change => change.key)).to.have.members([
      'reth.blobS3Url',
      'reth.l1Url',
      'reth.networkId',
      'reth.trustedPeers',
    ])
  })
})
