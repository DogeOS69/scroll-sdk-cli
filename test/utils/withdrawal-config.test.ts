import * as toml from '@iarna/toml'
import { expect } from 'chai'

import {
  WITHDRAWAL_DEPLOYMENT_BEGIN,
  WITHDRAWAL_DEPLOYMENT_END,
  buildWithdrawalDeploymentFacts,
  ensureWithdrawalProofActivationSwitch,
  mergeWithdrawalManagedDeploymentBlock,
  stripMigratedWithdrawalEnv,
} from '../../src/utils/withdrawal-config.js'

const FACTS_INPUT = {
  bridgeAddress: 'DBRIDGE1',
  dogecoinIndexerStartHeight: 1234,
  dogecoinRpcUrl: 'http://dogecoin:22555',
  ethereumDa: {
    beaconRpcUrl: 'https://beacon.example.com',
    ethChainId: 11_155_111,
    expectedBatcherAddress: '0xbatcher',
    inboxWorkerStartBlock: '777',
    l1RpcUrl: 'https://ethereum.example.com',
    l2ChainId: '12345',
    minFinality: 'finalized',
    s3: {
      enabled: true,
      keyPrefix: 'blobs',
      publicBaseUrl: 'https://blob-archive.example.com',
      timeoutMs: '10000',
      treatForbiddenAsMissing: 'true',
    },
  },
  genesisSequencerTxid: 'ff'.repeat(32),
  genesisSequencerVout: '1',
  initialBridgeRedeemScriptHex: 'aabb',
  l2BootstrapNextStartingBlockHeight: '99',
  l2MessageQueueAddress: '0xqueue',
  l2MessengerAddress: '0xmessenger',
  l2RpcUrl: 'http://l2-rpc:8545',
  networkStr: 'testnet',
}

describe('withdrawal-config deployment block', () => {
  it('builds typed TOML facts from string inputs', () => {
    const { defaults, deletePaths, facts } = buildWithdrawalDeploymentFacts(FACTS_INPUT)
    expect(deletePaths).to.deep.equal([])
    expect((facts as any).genesis_sequencer_vout).to.equal(1)
    expect((facts as any).ethereum_da.eth_chain_id).to.equal(11_155_111)
    expect((facts as any).ethereum_da.l2_chain_id).to.equal(12_345)
    expect((facts as any).ethereum_da.inbox_worker.expected_batchers).to.deep.equal(['0xbatcher'])
    expect((facts as any).ethereum_da.inbox_worker.start_block).to.equal(777)
    expect((facts as any).ethereum_da.blob_source.aws_s3.treat_forbidden_as_missing).to.equal(true)
    expect((facts as any).l2_bootstrap_next_starting_block_height).to.equal(99)
    expect((defaults as any).utxo_manager_intermediate.bridge_strategy.max_inputs).to.equal(60)
  })

  it('requests aws_s3 removal when the blob archive is disabled', () => {
    const { deletePaths, facts } = buildWithdrawalDeploymentFacts({
      ...FACTS_INPUT,
      ethereumDa: { ...FACTS_INPUT.ethereumDa, s3: { enabled: false } },
    })
    expect(deletePaths).to.deep.equal([['ethereum_da', 'blob_source', 'aws_s3']])
    expect((facts as any).ethereum_da.blob_source.aws_s3).to.equal(undefined)
  })

  it('creates the deployment block at the top of a proof-only config', () => {
    const source = `# BEGIN scrollsdk managed proof configuration
[proof_system]
mode = "disabled"
# END scrollsdk managed proof configuration
`
    const { defaults, deletePaths, facts } = buildWithdrawalDeploymentFacts(FACTS_INPUT)
    const merged = mergeWithdrawalManagedDeploymentBlock(source, facts, { defaults, deletePaths })
    expect(merged.startsWith(WITHDRAWAL_DEPLOYMENT_BEGIN)).to.equal(true)
    const parsed = toml.parse(merged) as any
    expect(parsed.network_str).to.equal('testnet')
    expect(parsed.dogeos_indexer.rpc_url).to.equal('http://l2-rpc:8545')
    expect(parsed.utxo_manager_intermediate.bridge_strategy.max_inputs).to.equal(60)
    expect(parsed.proof_system.mode).to.equal('disabled')
  })

  it('preserves operator tuning while facts win on their keys', () => {
    const { defaults, facts } = buildWithdrawalDeploymentFacts(FACTS_INPUT)
    const seeded = mergeWithdrawalManagedDeploymentBlock('', facts, { defaults })
    // Operator tunes curated defaults, a fact key, and adds a new key.
    const tuned = seeded
      .replace('max_inputs = 60', 'max_inputs = 42')
      .replace('fee_rate_sat_per_kvb = 1_000_000', 'fee_rate_sat_per_kvb = 2000000')
      .replace('rpc_url = "http://l2-rpc:8545"', 'rpc_url = "http://operator-edited:8545"')
      .replace(WITHDRAWAL_DEPLOYMENT_BEGIN, `${WITHDRAWAL_DEPLOYMENT_BEGIN}\noperator_custom_flag = true`)

    const remerged = mergeWithdrawalManagedDeploymentBlock(tuned, facts, { defaults })
    const parsed = toml.parse(remerged) as any
    expect(parsed.operator_custom_flag).to.equal(true)
    expect(parsed.fee_rate_sat_per_kvb).to.equal(2_000_000)
    expect(parsed.utxo_manager_intermediate.bridge_strategy.max_inputs).to.equal(42)
    // The fact key is re-asserted by the merge.
    expect(parsed.dogeos_indexer.rpc_url).to.equal('http://l2-rpc:8545')
  })

  it('removes a stale aws_s3 provider via deletePaths', () => {
    const initial = buildWithdrawalDeploymentFacts(FACTS_INPUT)
    const seeded = mergeWithdrawalManagedDeploymentBlock('', initial.facts, { defaults: initial.defaults })
    const disabled = buildWithdrawalDeploymentFacts({
      ...FACTS_INPUT,
      ethereumDa: { ...FACTS_INPUT.ethereumDa, s3: { enabled: false } },
    })
    const remerged = mergeWithdrawalManagedDeploymentBlock(seeded, disabled.facts, {
      defaults: disabled.defaults,
      deletePaths: disabled.deletePaths,
    })
    const parsed = toml.parse(remerged) as any
    expect(parsed.ethereum_da.blob_source.aws_s3).to.equal(undefined)
    expect(parsed.ethereum_da.blob_source.beacon_node.url).to.equal('https://beacon.example.com')
  })

  it('fails closed when the block drifted below a hand-maintained table', () => {
    const drifted = `[operator_table]
key = 1

${WITHDRAWAL_DEPLOYMENT_BEGIN}
network_str = "testnet"
${WITHDRAWAL_DEPLOYMENT_END}
`
    expect(() => mergeWithdrawalManagedDeploymentBlock(drifted, buildWithdrawalDeploymentFacts(FACTS_INPUT).facts))
      .to.throw('must be the first content of the file')
  })

  it('strips migrated env while keeping secrets and activation projections', () => {
    const values: Record<string, any> = {
      env: [
        { name: 'DOGEOS_WITHDRAWAL_NETWORK_STR', value: 'testnet' },
        { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE', value: '{{ ternary "production" "disabled" .Values.withdrawalProof.enabled }}' },
        { name: 'DOGEOS_WITHDRAWAL_DATABASE_URL', valueFrom: { secretKeyRef: { key: 'url', name: 'db' } } },
        { name: 'RUST_LOG', value: 'info' },
        { name: 'DOGEOS_WITHDRAWAL_UTXO_MANAGER_INTERMEDIATE__HIGH_THRESH_SATS', value: '1' },
      ],
    }
    const changes = stripMigratedWithdrawalEnv(values)
    expect(changes.map(change => change.key)).to.deep.equal([
      'env.DOGEOS_WITHDRAWAL_NETWORK_STR',
      'env.DOGEOS_WITHDRAWAL_UTXO_MANAGER_INTERMEDIATE__HIGH_THRESH_SATS',
    ])
    expect(values.env.map((item: any) => item.name)).to.deep.equal([
      'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE',
      'DOGEOS_WITHDRAWAL_DATABASE_URL',
      'RUST_LOG',
    ])
  })

  it('atomically projects active mock env while preserving ordinary and secret env', () => {
    const values: Record<string, any> = {
      env: [
        { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE', value: 'dev_dummy' },
        { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_SCROLL_EXECUTION', value: 'true' },
        { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_BRIDGE_STATE', value: 'true' },
        { name: 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__ENABLED', value: 'true' },
        { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__DEV_DUMMY__SCROLL_INPUT', value: 'exact_mock' },
        { name: 'RUST_LOG', value: 'info' },
        {
          name: 'DOGEOS_WITHDRAWAL_DATABASE_URL',
          valueFrom: { secretKeyRef: { key: 'url', name: 'withdrawal-db' } },
        },
      ],
      withdrawalProof: { enabled: true, provingMode: 'production' },
    }

    expect(ensureWithdrawalProofActivationSwitch(values, 'mock')).to.equal(true)
    expect(values.withdrawalProof).to.deep.equal({ enabled: true, provingMode: 'mock' })
    expect(values.env).to.deep.equal([
      { name: 'RUST_LOG', value: 'info' },
      {
        name: 'DOGEOS_WITHDRAWAL_DATABASE_URL',
        valueFrom: { secretKeyRef: { key: 'url', name: 'withdrawal-db' } },
      },
      { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE', value: 'dev_dummy' },
      { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_SCROLL_EXECUTION', value: 'true' },
      { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_BRIDGE_STATE', value: 'true' },
      { name: 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__ENABLED', value: 'true' },
      { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__DEV_DUMMY__SCROLL_INPUT', value: 'exact_mock' },
    ])
    expect(ensureWithdrawalProofActivationSwitch(values, 'mock')).to.equal(false)
  })
})
