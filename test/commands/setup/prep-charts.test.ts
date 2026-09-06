import { runCommand } from '@oclif/test'
import { expect } from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  applyConfigMapEnvValues,
  applyCubesignerPrepEnv,
  applyEthDaSubmitterInitialBatchSidecar,
  applyFeeOracleCurrentEnv,
  applyFrontendEnvFileValues,
  applyL2RethRpcPublicIngressPolicy,
  applyL2RethRpcRuntimeValues,
  applyRethBlobS3Url,
  applyRethNetworkId,
  buildCubesignerPrepEnv,
  buildEthDaSubmitterPrepEnv,
  buildFeeOraclePrepEnv,
  buildL1InterfaceBlobSourcePrepEnv,
  buildL2GethInitialPeerList,
  buildRethInitialTrustedPeers,
  buildTsoSigners,
  buildWithdrawalBlobSourcePrepEnv,
  ensureConfigMapFileMount,
  ensureCubesignerPolicyKeyBinding,
  getEthereumDaS3PublicBaseUrl,
  getEthereumDaS3PublicBlobUrl,
  getL2RethRpcIngressConfigKey,
  getProductionChartName,
  isL2RethBlobS3Chart,
  migrateCubesignerPolicySdkVersion,
  migrateCubesignerRequestContract,
  removeConfigMapEnvKeys,
  removeEnvArrayKeys,
  removeL2GethBlobS3ExtraParams,
  removeRetiredAttestationSignerValues,
  removeRetiredCubesignerInstanceValues,
  resolveRethP2PNetworkId,
  restoreRethExtraArgs,
  scrubFeeOracleLegacyValues,
  scrubL1InterfaceRetiredEnv,
  scrubWithdrawalLegacyProofEnv,
  shouldSkipL2ContractDeploymentBlockUpdate,
  snapshotRethExtraArgs,
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

describe('setup prep-charts generated frontend config', () => {
  it('updates DeploymentSpec env-file values without serializing undefined', () => {
    const first = applyFrontendEnvFileValues(
      '# Frontend Configuration\nREACT_APP_ROLLUP = Old Name\n',
      {
        REACT_APP_CONNECT_WALLET_PROJECT_ID: undefined,
        REACT_APP_DOGE_NETWORK: 'testnet',
        REACT_APP_ROLLUP: 'DogeOS Devnet',
      },
    )
    expect(first.changed).to.equal(true)
    expect(first.content).to.equal([
      '# Frontend Configuration',
      'REACT_APP_ROLLUP = DogeOS Devnet',
      'REACT_APP_DOGE_NETWORK = testnet',
      '',
    ].join('\n'))
    expect(first.content).not.to.include('undefined')

    expect(applyFrontendEnvFileValues(first.content, {
      REACT_APP_DOGE_NETWORK: 'testnet',
      REACT_APP_ROLLUP: 'DogeOS Devnet',
    })).to.deep.equal({changed: false, content: first.content})
  })
})

describe('setup prep-charts ConfigMap file mounts', () => {
  it('uses the ConfigMap key as subPath so the mount target remains a file', () => {
    const values: any = {}

    expect(ensureConfigMapFileMount(
      values,
      'protocol-context',
      '/app/protocol_context.json',
      'protocol-context-config',
    )).to.have.length(1)
    expect(values.persistence['protocol-context']).to.deep.equal({
      enabled: true,
      mountPath: '/app/protocol_context.json',
      name: 'protocol-context-config',
      readOnly: true,
      subPath: 'protocol_context.json',
      type: 'configMap',
    })
  })
})

describe('setup prep-charts Reth initial peer topology', () => {
  const gethSequencers = [
    'enode://geth0@l2-sequencer-0:30303',
    'enode://geth1@l2-sequencer-1:30303',
  ]
  const rethSequencers = [
    'enode://reth0@l2-reth-sequencer-0:30303',
    'enode://reth1@l2-reth-sequencer-1:30303',
    'enode://geth1@l2-sequencer-1:30303',
  ]
  const combinedSequencers = [
    'enode://geth0@l2-sequencer-0:30303',
    'enode://geth1@l2-sequencer-1:30303',
    'enode://reth0@l2-reth-sequencer-0:30303',
    'enode://reth1@l2-reth-sequencer-1:30303',
  ]

  it('renders geth and Reth sequencers as Reth trusted-peers CSV', () => {
    expect(buildRethInitialTrustedPeers(gethSequencers, rethSequencers)).to.equal(
      combinedSequencers.join(',')
    )
  })

  it('renders the same deduplicated sequencers as a geth peer-list JSON array', () => {
    expect(buildL2GethInitialPeerList(gethSequencers, rethSequencers)).to.equal(
      JSON.stringify(combinedSequencers)
    )
  })

  it('ignores blank peer entries for both client formats', () => {
    const gethSequencers = [
      'enode://geth0@l2-sequencer-0:30303',
      ' ',
    ]
    const rethSequencers = [
      'enode://reth0@l2-reth-sequencer-0:30303',
      '',
    ]

    expect(buildRethInitialTrustedPeers(gethSequencers, rethSequencers)).to.equal([
      'enode://geth0@l2-sequencer-0:30303',
      'enode://reth0@l2-reth-sequencer-0:30303',
    ].join(','))
    expect(buildL2GethInitialPeerList(gethSequencers, rethSequencers)).to.equal(JSON.stringify([
      'enode://geth0@l2-sequencer-0:30303',
      'enode://reth0@l2-reth-sequencer-0:30303',
    ]))
  })
})

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
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE')
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_SCROLL_EXECUTION')
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_BRIDGE_STATE')
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_PROOF_WORK_API__ENABLED')
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_PROOF_SYSTEM__DEV_DUMMY__SCROLL_INPUT')
    expect(values.withdrawalProof.enabled).to.equal(false)
    expect(values.withdrawalProof.mode).to.equal(undefined)
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

describe('setup prep-charts retired CubeSigner instance cleanup', () => {
  it('removes numbered CubeSigner values and preserves the singleton values file', () => {
    const valuesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-retired-cubesigner-'))
    try {
      for (const file of [
        'cubesigner-signer-production.yaml',
        'cubesigner-signer-production-0.yaml',
        'cubesigner-signer-production-12.yaml',
        'withdrawal-processor-production.yaml',
      ]) fs.writeFileSync(path.join(valuesDir, file), 'enabled: true\n')

      expect(removeRetiredCubesignerInstanceValues(valuesDir)).to.deep.equal([
        'cubesigner-signer-production-0.yaml',
        'cubesigner-signer-production-12.yaml',
      ])
      expect(fs.readdirSync(valuesDir)).to.deep.equal([
        'cubesigner-signer-production.yaml',
        'withdrawal-processor-production.yaml',
      ])
    } finally {
      fs.rmSync(valuesDir, { force: true, recursive: true })
    }
  })
})

describe('setup prep-charts external attestation signer routing', () => {
  it('preserves descriptor IP/domain endpoints in the TSO signer list', () => {
    expect(buildTsoSigners({
      cubesigner: { roles: [
        {
          keys: [{
            key_id: 'Key#tee',
            key_type: 'Secp256k1',
            material_id: 'material-0',
            public_key: 'uncompressed-key',
            public_key_compressed: `02${'11'.repeat(32)}`,
            purpose: 'BridgeCorrectness',
          }],
          name: 'tee-0',
          role_id: 'role-0',
        },
      ] },
      network: 'testnet',
      signerUrls: [
        'https://signer.partner-a.example:4040',
        'http://10.20.30.40:4040',
      ],
    })).to.deep.equal([
      {
        network: 'testnet',
        publicKeyOverride: `02${'11'.repeat(32)}`,
        role: 'Correctness',
        signatureMode: 'ecdsa',
        uri: 'http://cubesigner-signer:3000',
      },
      { network: 'testnet', role: 'Attestation', signatureMode: 'ecdsa', uri: 'https://signer.partner-a.example:4040' },
      { network: 'testnet', role: 'Attestation', signatureMode: 'ecdsa', uri: 'http://10.20.30.40:4040' },
    ])
  })

  it('rejects a stale multi-role CubeSigner configuration', () => {
    expect(() => buildTsoSigners({
      cubesigner: {roles: [
        {keys: [], name: 'tee-0', role_id: 'role-0'},
        {keys: [], name: 'tee-1', role_id: 'role-1'},
      ]},
      network: 'testnet',
    })).to.throw('exactly one TEE role and one in-cluster deployment')
  })
})

describe('setup prep-charts CubeSigner production config', () => {
  it('projects dynamic network and reviewed policy evidence without replacing template policy', () => {
    const env = buildCubesignerPrepEnv({
      cubesigner: {
        productionPolicy: {
          policyArtifactDigest: `sha256:${'aa'.repeat(32)}`,
          policyIdentifier: 'dogeos-bridge/v1',
          programIdentityDigest: `sha256:${'cc'.repeat(32)}`,
          proofResolverAuthority: 'https://proof-policy.example.com',
          verifierIdentityDigest: `sha256:${'bb'.repeat(32)}`,
        },
        roles: [],
      },
      network: 'testnet',
    })

    expect(env).to.include({
      DOGEOS_CUBESIGNER_SIGNER_NETWORK: 'testnet',
      DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_IDENTIFIER: 'dogeos-bridge/v1',
      DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_PROOF_RESOLVER_AUTHORITY:
        'https://proof-policy.example.com',
      NETWORK: 'testnet',
    })
    expect(env).not.to.have.property('DOGEOS_CUBESIGNER_SIGNER_MAX_PSBT_BASE64_LEN')
    expect(env).not.to.have.property('DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_MODE')
    expect(env).not.to.have.property('DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_REQUEST_CONTRACT')
    expect(env).not.to.have.property('DOGEOS_CUBESIGNER_SIGNER_PROTOCOL_CONTEXT_JSON')
    expect(env).not.to.have.property('DOGEOS_CUBESIGNER_SIGNER_SIGNATURE_MODE')
  })

  it('upserts scalar config and binds policy evidence to the CS key Secret', () => {
    const values: any = {
      env: [
        {name: 'KEEP_ME', value: 'yes'},
        {name: 'DOGEOS_CUBESIGNER_SIGNER_BRIDGE_NAMESPACE_ID', value: ''},
        {name: 'DOGEOS_CUBESIGNER_SIGNER_MAX_PSBT_BASE64_LEN', value: '130048'},
      ],
    }
    const changes = [
      ...applyCubesignerPrepEnv(values, buildCubesignerPrepEnv({
        cubesigner: {roles: []},
        network: 'testnet',
      })),
      ...ensureCubesignerPolicyKeyBinding(values),
    ]
    const env = Object.fromEntries(values.env.map((item: any) => [item.name, item]))

    expect(changes.map(change => change.key)).to.include('env.DOGEOS_CUBESIGNER_SIGNER_NETWORK')
    expect(env.KEEP_ME.value).to.equal('yes')
    expect(env.DOGEOS_CUBESIGNER_SIGNER_MAX_PSBT_BASE64_LEN.value).to.equal('130048')
    expect(env.DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_KEY_IDENTIFIER.valueFrom)
      .to.deep.equal({
        secretKeyRef: {
          key: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID',
          name: 'cubesigner-signer-env',
        },
      })
  })

  it('migrates only the retired CubeSigner request contract', () => {
    const values: any = {
      env: [
        {
          name: 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_REQUEST_CONTRACT',
          value: 'dogeos-cubesigner-psbt-no-metadata-sign-all-scripts-false-unprefixed-hex-v1',
        },
        {name: 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_MODE', value: 'operator-owned'},
      ],
    }

    expect(migrateCubesignerRequestContract(values)).to.deep.equal([{
      key: 'env.DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_REQUEST_CONTRACT',
      newValue: 'dogeos-cubesigner-compact-psbt-bridge-proof-ref-v1-sign-all-scripts-false-unprefixed-hex-explain-v3',
      oldValue: 'dogeos-cubesigner-psbt-no-metadata-sign-all-scripts-false-unprefixed-hex-v1',
    }])
    expect(values.env[1].value).to.equal('operator-owned')

    values.env[0].value = 'dogeos-cubesigner-compact-psbt-no-metadata-sign-all-scripts-false-unprefixed-hex-v1'
    expect(migrateCubesignerRequestContract(values)).to.have.length(1)
    expect(values.env[0].value)
      .to.equal('dogeos-cubesigner-compact-psbt-bridge-proof-ref-v1-sign-all-scripts-false-unprefixed-hex-explain-v3')

    values.env[0].value = 'dogeos-cubesigner-compact-psbt-bridge-proof-ref-v1-sign-all-scripts-false-unprefixed-hex-v2'
    expect(migrateCubesignerRequestContract(values)).to.have.length(1)
    expect(values.env[0].value)
      .to.equal('dogeos-cubesigner-compact-psbt-bridge-proof-ref-v1-sign-all-scripts-false-unprefixed-hex-explain-v3')
  })

  it('migrates only the known pre-beta.2 CubeSigner SDK evidence', () => {
    const values: any = {
      env: [{
        name: 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_SDK_VERSION',
        value: '0.4.152-0',
      }],
    }

    expect(migrateCubesignerPolicySdkVersion(values)).to.deep.equal([{
      key: 'env.DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_SDK_VERSION',
      newValue: '0.4.281',
      oldValue: '0.4.152-0',
    }])
    expect(values.env[0].value).to.equal('0.4.281')

    values.env[0].value = 'operator-owned'
    expect(migrateCubesignerPolicySdkVersion(values)).to.deep.equal([])
    expect(values.env[0].value).to.equal('operator-owned')
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
            DOGEOS_FEE_ORACLE__ETHEREUM_DA__CONTRACT_WRITE_MODE: 'live',
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
    expect(values.configMaps.env.data).not.to.have.property('DOGEOS_FEE_ORACLE__ETHEREUM_DA__CONTRACT_WRITE_MODE')
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
      ethereumRpcUrl: 'https://eth.example',
      l2RpcUrl: 'http://l2-rpc:8545',
    })

    expect(env).to.deep.equal({
      DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_JSON_PATH: '/app/genesis/genesis.json',
      DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__RPC_URL: 'https://eth.example',
      DOGEOS_ETH_DA_SUBMITTER_L2__RPC_URL: 'http://l2-rpc:8545',
      DOGEOS_ETH_DA_SUBMITTER_PROTOCOL_CONTEXT_JSON: '/app/protocol_context.json',
    })

    for (const key of Object.keys(env)) {
      expect(key).not.to.include('CUTOVER')
      if (key !== 'DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_JSON_PATH') expect(key).not.to.include('GENESIS')
      expect(key).not.to.include('FRONTIER')
    }
  })

  it('writes S3 upload env when S3 archive is enabled', () => {
    const env = buildEthDaSubmitterPrepEnv({
      ethereumRpcUrl: 'https://eth.example',
      l2RpcUrl: 'http://l2-rpc:8545',
      s3Bucket: 'dogeos-da',
      s3Enabled: true,
      s3ForcePathStyle: false,
      s3KeyPrefix: 'devnet/eth-da/blobs/v1',
      s3Region: 'us-east-1',
    })

    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__ENABLED).to.equal('true')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__BUCKET).to.equal('dogeos-da')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__REGION).to.equal('us-east-1')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__KEY_PREFIX).to.equal('devnet/eth-da/blobs/v1')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_S3__FORCE_PATH_STYLE).to.equal('false')
    expect(env).not.to.have.property('DOGEOS_ETH_DA_SUBMITTER_S3__MAX_RETRIES')
  })

  it('preserves the template-owned uncompressed chunk byte limit', () => {
    const values: any = {
      configMaps: {
        env: {
          data: {
            DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_UNCOMPRESSED_CHUNK_BYTES_SIZE: '122880',
          },
        },
      },
    }
    const changes = applyConfigMapEnvValues(values, buildEthDaSubmitterPrepEnv({
      batch: {maxL2GasPerChunk: 30_000_000} as any,
      ethereumRpcUrl: 'https://eth.example',
      l2RpcUrl: 'http://l2-rpc:8545',
    }))

    expect(values.configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_UNCOMPRESSED_CHUNK_BYTES_SIZE).to.equal('122880')
    expect(changes.map(change => change.key)).not.to.include(
      'configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_UNCOMPRESSED_CHUNK_BYTES_SIZE',
    )
  })

  it('writes optional cutover and L2 start without replacing template policy', () => {
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
        maxL2GasPerChunk: 30_000_000,
      } as any,
      ethereumRpcUrl: 'https://eth.example',
      l2RpcUrl: 'http://l2-rpc:8545',
      l2StartBlockNumber: 2_898_792,
    })

    expect(env.DOGEOS_ETH_DA_SUBMITTER_L2__START_BLOCK_NUMBER).to.equal('2898792')
    expect(env).not.to.have.property('DOGEOS_ETH_DA_SUBMITTER_BATCH__COMPRESSION')
    expect(env).not.to.have.property('DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_BATCH_HASH')
    expect(env).not.to.have.property('DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_WITHDRAW_ROOT')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__LAST_BATCH_INDEX).to.equal('4379')
    expect(env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__WITHDRAW_ROOT).to.equal('0x4444444444444444444444444444444444444444444444444444444444444444')
    expect(env).not.to.have.property('DOGEOS_ETH_DA_SUBMITTER_BATCH__INITIAL_BATCH_SIDECAR_JSON')
    expect(env).not.to.have.property('DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_BLOCKS_PER_CHUNK')
    expect(env).not.to.have.property('DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_L2_GAS_PER_CHUNK')
    expect(env).not.to.have.property('DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_UNCOMPRESSED_CHUNK_BYTES_SIZE')
    expect(env).not.to.have.property('DOGEOS_ETH_DA_SUBMITTER_PUBLISH__ALLOW_LIVENESS_BUDGET_OVERRIDE')
    expect(env).not.to.have.property('DOGEOS_ETH_DA_SUBMITTER_PUBLISH__TARGET_BLOBS_PER_TX')

    const values: any = {
      configMaps: {
        env: { data: { DOGEOS_ETH_DA_SUBMITTER_BATCH__INITIAL_BATCH_SIDECAR_JSON: '/app/config/initial_batch.json' } },
        'initial-batch': { data: { 'initial_batch.json': '{"batch":4380}' }, enabled: true },
      },
      persistence: { 'initial-batch': { enabled: true, mountPath: '/app/config' } },
    }
    const changes = applyEthDaSubmitterInitialBatchSidecar(values)

    expect(changes.map(change => change.key)).to.include('configMaps.initial-batch')
    expect(changes.map(change => change.key)).to.include('persistence.initial-batch')
    expect(values.configMaps.env.data).not.to.have.property('DOGEOS_ETH_DA_SUBMITTER_BATCH__INITIAL_BATCH_SIDECAR_JSON')
    expect(values.configMaps).not.to.have.property('initial-batch')
    expect(values.persistence).not.to.have.property('initial-batch')
  })

  it('does not emit an initial-batch sidecar env or mount for whitespace', () => {
    const env = buildEthDaSubmitterPrepEnv({
      batch: { initialBatchSidecarJson: '   ' } as any,
      ethereumRpcUrl: 'https://eth.example',
      l2RpcUrl: 'http://l2-rpc:8545',
    })

    expect(env).not.to.have.property('DOGEOS_ETH_DA_SUBMITTER_BATCH__INITIAL_BATCH_SIDECAR_JSON')

    const values: any = { configMaps: { env: { data: {} } }, persistence: {} }
    const changes = applyEthDaSubmitterInitialBatchSidecar(values, '   ')

    expect(changes).to.deep.equal([])
    expect(values.configMaps).not.to.have.property('initial-batch')
    expect(values.persistence).not.to.have.property('initial-batch')
  })

  it('does not recreate the retired initial-batch sidecar from stale intent', () => {
    const values: any = { configMaps: { env: { data: {} } }, persistence: {} }
    const changes = applyEthDaSubmitterInitialBatchSidecar(values, '{"batch":4380}')

    expect(changes).to.deep.equal([])
    expect(values.configMaps).not.to.have.property('initial-batch')
    expect(values.persistence).not.to.have.property('initial-batch')
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

  it('validates removed batch fields, sidecar, and publish fields', () => {
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
    })).to.throw(/ethereumDa\.batch\.genesisStateRoot.*removed/)

    expect(() => validateDogeConfigEthereumDaForPrep({
      batch: {
        minCodecVersion: 5,
      },
    })).to.throw(/ethereumDa\.batch\.minCodecVersion.*removed/)

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
    expect(values.configMaps.env.data.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__TIMEOUT_MS).to.equal('5000')
  })

  it('writes S3 blob source env for l1-interface', () => {
    const env = buildL1InterfaceBlobSourcePrepEnv({
      beaconRpcUrl: 'https://beacon.example',
      s3KeyPrefix: 'devnet/eth-da/blobs/v1',
      s3PublicBaseUrl: 'https://dogeos-da.s3.us-east-1.amazonaws.com/',
    })

    expect(env.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__KEY_PREFIX).to.equal('devnet/eth-da/blobs/v1')
    expect(env.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL).to.equal('https://dogeos-da.s3.us-east-1.amazonaws.com/')
    expect(env).not.to.have.property('DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TIMEOUT_MS')
    expect(env).not.to.have.property('DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TREAT_FORBIDDEN_AS_MISSING')
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
    expect(values.env.find(item => item.name === 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__TIMEOUT_MS')).to.equal(undefined)
  })

  it('writes S3 blob source env for withdrawal-processor', () => {
    const env = buildWithdrawalBlobSourcePrepEnv({
      beaconRpcUrl: 'https://beacon.example',
      s3KeyPrefix: 'devnet/eth-da/blobs/v1',
      s3PublicBaseUrl: 'https://dogeos-da.s3.us-east-1.amazonaws.com/',
    })

    expect(env.DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__KEY_PREFIX).to.equal('devnet/eth-da/blobs/v1')
    expect(env.DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL).to.equal('https://dogeos-da.s3.us-east-1.amazonaws.com/')
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TIMEOUT_MS')
    expect(env).not.to.have.property('DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__TREAT_FORBIDDEN_AS_MISSING')
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

  it('writes an explicitly isolated Reth P2P network ID', () => {
    const values = { reth: { networkId: '4444444' } }
    const networkId = resolveRethP2PNetworkId({ reth: { networkId: '5555555' } }, '6281971')
    const changes = applyRethNetworkId(values, networkId)

    expect(values.reth.networkId).to.equal('5555555')
    expect(changes).to.deep.equal([{
      key: 'reth.networkId',
      newValue: '5555555',
      oldValue: '4444444',
    }])
  })

  it('falls back to the EVM chain ID when no explicit Reth P2P network ID exists', () => {
    expect(resolveRethP2PNetworkId({}, 6_281_971)).to.equal('6281971')
  })

  it('rejects a non-decimal Reth P2P network ID', () => {
    expect(() => resolveRethP2PNetworkId({ reth: { networkId: 'devnet' } }, '6281971'))
      .to.throw('reth.networkId must be a decimal integer')
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
        extraArgs: [
          '--network.legacy-geth-header-transform',
          'true',
          '--consensus.exit-on-signer-rotation',
        ],
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
      extraArgs: [
        '--network.legacy-geth-header-transform',
        'true',
        '--consensus.exit-on-signer-rotation',
      ],
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

  it('restores operator-owned reth extraArgs after runtime reconciliation', () => {
    const values: any = {
      reth: {
        extraArgs: [
          '--network.legacy-geth-header-transform',
          'true',
          '--l1.query-range',
          '100',
          '--consensus.exit-on-signer-rotation',
        ],
      },
    }
    const snapshot = snapshotRethExtraArgs(values)

    values.reth.extraArgs = ['--unexpected-generated-value']
    restoreRethExtraArgs(values, snapshot)

    expect(values.reth.extraArgs).to.deep.equal([
      '--network.legacy-geth-header-transform',
      'true',
      '--l1.query-range',
      '100',
      '--consensus.exit-on-signer-rotation',
    ])
  })

  it('removes extraArgs introduced by reconciliation when the operator did not define it', () => {
    const values: any = {reth: {networkId: '4444444'}}
    const snapshot = snapshotRethExtraArgs(values)

    values.reth.extraArgs = ['--unexpected-generated-value']
    restoreRethExtraArgs(values, snapshot)

    expect(values.reth).not.to.have.property('extraArgs')
  })
})

describe.skip('setup prep-charts legacy generation transaction fixture', () => {
  it('rolls back earlier ordinary-chart changes when a later generation step fails', async () => {
    const originalCwd = process.cwd()
    const originalEnvironment = {...process.env}
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-generation-rollback-'))
    try {
      process.chdir(root)
      Object.assign(process.env, {
        DB_ADMIN_PASSWORD: 'test-password',
        DOGECOIN_CLUSTER_RPC_PASSWORD: 'test-password',
        DOGECOIN_CLUSTER_RPC_USERNAME: 'test-user',
        DOGECOIN_EXTERNAL_RPC_PASSWORD: 'test-password',
        DOGECOIN_EXTERNAL_RPC_USERNAME: 'test-user',
        OWNER_ADDRESS: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      })
      fs.mkdirSync('.data', {recursive: true})
      fs.mkdirSync('values', {recursive: true})
      fs.writeFileSync('Makefile', '# no helm commands in transaction fixture\n')
      fs.writeFileSync('config.toml', '')
      fs.writeFileSync('.data/doge-config.toml', [
        'network = "testnet"',
        '',
        '[wallet]',
        'path = ".data/wallet.json"',
        '',
      ].join('\n'))
      fs.writeFileSync('.data/output-withdrawal-processor.toml', [
        'bridge_address = "fixture"',
        'genesis_sequencer_txid = "f5eedbcaed2b12685bfc046c04ae7827e47ba6b75cb09342a5ec062ee4c4997f"',
        'genesis_sequencer_vout = 0',
        'genesis_sequencer_tx_hex = "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff00ffffffff0101000000000000000000000000"',
        'network_str = "testnet"',
        '',
      ].join('\n'))
      fs.writeFileSync('.data/bridge.json', JSON.stringify({
        redeem_script_hex: '51',
      }))
      fs.writeFileSync('.data/output-test-data.json', JSON.stringify({
        fee_wallet_address: 'fixture-fee-wallet',
        sequencer_address: 'fixture-sequencer',
      }))
      const spec = yaml.load(fs.readFileSync(
        path.join(originalCwd, 'src/config/deployment-spec.example.yaml'),
        'utf8',
      )) as any
      spec.proofTopology = {
        compiler: {
          image: {
            digest: `sha256:${'a'.repeat(64)}`,
            repository: 'dogeos69/dogeos-proof-topology',
          },
        },
        mode: 'disabled',
      }
      fs.writeFileSync('deployment-spec.yaml', yaml.dump(spec))
      const tsoPath = path.join(root, 'values/tso-service-production.yaml')
      const retiredPath = path.join(root, 'values/attestation-signer-production.yaml')
      const tsoBefore = 'env: []\noperatorOwned: keep\n'
      fs.writeFileSync(tsoPath, tsoBefore)
      fs.writeFileSync(retiredPath, 'enabled: true\n')

      const {stderr, stdout} = await runCommand([
        'setup',
        'prep-charts',
        '--non-interactive',
        '--skip-auth-check',
        '--json',
      ])
      const output = `${stdout}\n${stderr}`
      expect(output).to.include('Processing tso-service-production.yaml')
      expect(output).not.to.include("Cannot read properties of undefined (reading 'proof-topology-compiler-binary')")
      expect(fs.readFileSync(tsoPath, 'utf8')).to.equal(tsoBefore)
      expect(fs.readFileSync(retiredPath, 'utf8')).to.equal('enabled: true\n')
      expect(fs.existsSync(path.join(root, '.data/proof-deployment.json'))).to.equal(false)
    } finally {
      process.chdir(originalCwd)
      process.env = originalEnvironment
      fs.rmSync(root, {force: true, recursive: true})
    }
  })
})
