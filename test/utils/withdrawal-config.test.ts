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
  dogecoinIndexerStartHeight: 1234,
  dogecoinRpcUrl: 'http://dogecoin:22555',
  ethereumDa: {
    beaconRpcUrl: 'https://beacon.example.com',
    expectedBatcherAddress: '0xbatcher',
    inboxWorkerStartBlock: '777',
    l1RpcUrl: 'https://ethereum.example.com',
    s3: {
      enabled: true,
      keyPrefix: 'blobs',
      publicBaseUrl: 'https://blob-archive.example.com',
    },
  },
  genesisSequencerTxHex: '01000000',
  initialBridgeRedeemScriptHex: 'aabb',
  l2BootstrapNextStartingBlockHeight: '99',
  l2MessageQueueAddress: '0xqueue',
  l2MessengerAddress: '0xmessenger',
  l2RpcUrl: 'http://l2-rpc:8545',
  networkStr: 'testnet',
}

describe('withdrawal-config deployment block', () => {
  it('builds typed TOML facts from string inputs', () => {
    const { deletePaths, facts } = buildWithdrawalDeploymentFacts(FACTS_INPUT)
    expect(deletePaths).to.include.deep.members([
      ['bridge_address'],
      ['genesis_sequencer_txid'],
      ['genesis_sequencer_vout'],
      ['ethereum_da', 'eth_chain_id'],
      ['ethereum_da', 'l2_chain_id'],
    ])
    expect((facts as any).bridge_address).to.equal(undefined)
    expect((facts as any).genesis_sequencer_vout).to.equal(undefined)
    expect((facts as any).genesis_sequencer_tx_hex).to.equal('01000000')
    expect((facts as any).ethereum_da.eth_chain_id).to.equal(undefined)
    expect((facts as any).ethereum_da.l2_chain_id).to.equal(undefined)
    expect((facts as any).ethereum_da.inbox_worker.expected_batchers).to.deep.equal(['0xbatcher'])
    expect((facts as any).ethereum_da.inbox_worker.start_block).to.equal(777)
    expect((facts as any).ethereum_da.blob_source.aws_s3.timeout_ms).to.equal(undefined)
    expect((facts as any).ethereum_da.blob_source.aws_s3.treat_forbidden_as_missing).to.equal(undefined)
    expect((facts as any).l2_bootstrap_next_starting_block_height).to.equal(99)
    expect((facts as any).rotate_sequencer_signer_v2).to.equal(undefined)
    expect((facts as any).wf_withdrawal_parity_v1).to.equal(undefined)
  })

  it('does not emit an open sender allowlist when the canonical batcher is provided', () => {
    const {facts} = buildWithdrawalDeploymentFacts({
      ...FACTS_INPUT,
      ethereumDa: {
        ...FACTS_INPUT.ethereumDa,
        expectedBatcherAddress: '0x809cb1378Cb2775816dD14d1a3754a536b066889',
      },
    })

    expect((facts as any).ethereum_da.inbox_worker.expected_batchers).to.deep.equal([
      '0x809cb1378Cb2775816dD14d1a3754a536b066889',
    ])
  })

  it('requests aws_s3 removal when the blob archive is disabled', () => {
    const { deletePaths, facts } = buildWithdrawalDeploymentFacts({
      ...FACTS_INPUT,
      ethereumDa: { ...FACTS_INPUT.ethereumDa, s3: { enabled: false } },
    })
    expect(deletePaths).to.deep.include(['ethereum_da', 'blob_source', 'aws_s3'])
    expect((facts as any).ethereum_da.blob_source.aws_s3).to.equal(undefined)
  })

  it('creates the deployment block at the top of a proof-only config', () => {
    const source = `[proof_system]
mode = "disabled"
`
    const { deletePaths, facts } = buildWithdrawalDeploymentFacts(FACTS_INPUT)
    const merged = mergeWithdrawalManagedDeploymentBlock(source, facts, {deletePaths})
    expect(merged.startsWith(WITHDRAWAL_DEPLOYMENT_BEGIN)).to.equal(true)
    const parsed = toml.parse(merged) as any
    expect(parsed.network_str).to.equal('testnet')
    expect(parsed.dogeos_indexer.rpc_url).to.equal('http://l2-rpc:8545')
    expect(parsed.utxo_manager_intermediate).to.equal(undefined)
    expect(parsed.proof_system.mode).to.equal('disabled')
  })

  it('reconstructs a managed block from a compiler-rendered markerless config', () => {
    const source = `api_port = 3000
fee_rate_sat_per_kvb = 2000000

[dogecoin_indexer]
confirmations = 120
poll_interval_ms = 9000
start_height = 1

[proof_system]
mode = "active"
`
    const {deletePaths, facts} = buildWithdrawalDeploymentFacts(FACTS_INPUT)
    const merged = mergeWithdrawalManagedDeploymentBlock(source, facts, {deletePaths})
    const parsed = toml.parse(merged) as any

    expect(merged.startsWith(WITHDRAWAL_DEPLOYMENT_BEGIN)).to.equal(true)
    expect(parsed.api_port).to.equal(3000)
    expect(parsed.fee_rate_sat_per_kvb).to.equal(2_000_000)
    expect(parsed.dogecoin_indexer.confirmations).to.equal(120)
    expect(parsed.dogecoin_indexer.poll_interval_ms).to.equal(9000)
    expect(parsed.dogecoin_indexer.start_height).to.equal(1234)
    expect(parsed.proof_system.mode).to.equal('active')
    expect((merged.match(/^\[dogecoin_indexer]$/gm) || [])).to.have.length(1)
  })

  it('preserves operator tuning while facts win on their keys', () => {
    const { facts } = buildWithdrawalDeploymentFacts(FACTS_INPUT)
    const tuned = `${WITHDRAWAL_DEPLOYMENT_BEGIN}
operator_custom_flag = true
fee_rate_sat_per_kvb = 2000000
rotate_sequencer_signer_v2 = false
wf_withdrawal_parity_v1 = false

[dogeos_indexer]
rpc_url = "http://operator-edited:8545"

[utxo_manager_intermediate.bridge_strategy]
max_inputs = 42
${WITHDRAWAL_DEPLOYMENT_END}
`

    const remerged = mergeWithdrawalManagedDeploymentBlock(tuned, facts)
    const parsed = toml.parse(remerged) as any
    expect(parsed.operator_custom_flag).to.equal(true)
    expect(parsed.fee_rate_sat_per_kvb).to.equal(2_000_000)
    expect(parsed.rotate_sequencer_signer_v2).to.equal(false)
    expect(parsed.wf_withdrawal_parity_v1).to.equal(false)
    expect(parsed.utxo_manager_intermediate.bridge_strategy.max_inputs).to.equal(42)
    // The fact key is re-asserted by the merge.
    expect(parsed.dogeos_indexer.rpc_url).to.equal('http://l2-rpc:8545')
  })

  it('removes a stale aws_s3 provider via deletePaths', () => {
    const initial = buildWithdrawalDeploymentFacts(FACTS_INPUT)
    const seeded = mergeWithdrawalManagedDeploymentBlock('', initial.facts)
    const disabled = buildWithdrawalDeploymentFacts({
      ...FACTS_INPUT,
      ethereumDa: { ...FACTS_INPUT.ethereumDa, s3: { enabled: false } },
    })
    const remerged = mergeWithdrawalManagedDeploymentBlock(seeded, disabled.facts, {
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

  it('strips migrated env while leaving final proof-override cleanup to the lifecycle projector', () => {
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

  it('projects active lifecycle without any native proof-system environment overrides', () => {
    const values: Record<string, any> = {
      env: [
        { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE', value: 'dev_dummy' },
        { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_SCROLL_EXECUTION', value: 'true' },
        { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__REQUIRE_BRIDGE_STATE', value: 'true' },
        {
          name: 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__ENABLED',
          valueFrom: { secretKeyRef: { key: 'enabled', name: 'legacy-proof-work' } },
        },
        { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__DEV_DUMMY__SCROLL_INPUT', value: 'exact_mock' },
        { name: 'RUST_LOG', value: 'info' },
        {
          name: 'DOGEOS_WITHDRAWAL_DATABASE_URL',
          valueFrom: { secretKeyRef: { key: 'url', name: 'withdrawal-db' } },
        },
      ],
      withdrawalProof: { enabled: true, provingMode: 'production' },
    }

    expect(ensureWithdrawalProofActivationSwitch(values, 'active')).to.equal(true)
    expect(values.withdrawalProof).to.deep.equal({ enabled: true })
    expect(values.env).to.deep.equal([
      { name: 'RUST_LOG', value: 'info' },
      {
        name: 'DOGEOS_WITHDRAWAL_DATABASE_URL',
        valueFrom: { secretKeyRef: { key: 'url', name: 'withdrawal-db' } },
      },
    ])
    expect(ensureWithdrawalProofActivationSwitch(values, 'active')).to.equal(false)
  })
})
