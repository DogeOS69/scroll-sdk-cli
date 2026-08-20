import * as toml from '@iarna/toml'
import { expect } from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  MANAGED_RUNTIME_BEGIN,
  MANAGED_RUNTIME_END,
  scaffoldProofCoordinatorConfig,
} from '../../src/utils/proof-coordinator-scaffold.js'

function writeWithdrawalValues(root: string, overrides: Record<string, string | undefined> = {}): string {
  const env: Record<string, string | undefined> = {
    DOGEOS_WITHDRAWAL_DOGECOIN_RPC_URL: 'http://dogecoin:22555',
    DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__RPC_URL: 'http://l2-rpc:8545',
    DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__KEY_PREFIX: 'blobs',
    DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL: 'https://blob-archive.example.com',
    DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__TIMEOUT_MS: '10000',
    DOGEOS_WITHDRAWAL_ETHEREUM_DA__L1_RPC_URL: 'https://ethereum.example.com',
    DOGEOS_WITHDRAWAL_NETWORK_STR: 'testnet',
    ...overrides,
  }
  const valuesPath = path.join(root, 'values/withdrawal-processor-production.yaml')
  fs.writeFileSync(valuesPath, yaml.dump({
    env: Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => ({ name, value })),
  }))
  return valuesPath
}

describe('proof-coordinator-scaffold', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-coordinator-scaffold-'))
    fs.mkdirSync(path.join(root, 'values'))
  })

  afterEach(() => fs.rmSync(root, { force: true, recursive: true }))

  it('generates a complete coordinator config from prepared withdrawal values', () => {
    writeWithdrawalValues(root)
    const configFile = path.join(root, 'proof-coordinator/ProofCoordinator.toml')

    const result = scaffoldProofCoordinatorConfig({
      coordinatorConfigPath: configFile,
      valuesDir: path.join(root, 'values'),
    })
    expect(result.created).to.equal(true)
    expect(result.updated).to.equal(true)

    const source = fs.readFileSync(configFile, 'utf8')
    expect(source).to.include(MANAGED_RUNTIME_BEGIN)
    expect(source).to.include(MANAGED_RUNTIME_END)
    expect(source).to.include('# BEGIN scrollsdk managed verifier configuration')
    expect(source).to.include('# END scrollsdk managed verifier configuration')
    const parsed = toml.parse(source) as any
    expect(parsed.auth.bearer_token_file).to.equal('/app/secrets/proof-work-token')
    expect(parsed.artifact_store.kind).to.equal('s3')
    expect(parsed.prover_api).to.deep.include({
      bind_addr: '0.0.0.0:9400',
      enabled: true,
      transport: 's3',
      worker_auth_token_file: '/app/secrets/prover-worker-token',
    })
    expect(parsed.verifier.verifier_import_mode).to.equal('production')
    expect(parsed.protocol_context_json).to.equal('/app/protocol_context.json')
    const batchSubprocess = parsed.materializer.scroll_batch.subprocess
    expect(batchSubprocess.l2_rpc_url).to.equal('http://l2-rpc:8545')
    expect(batchSubprocess.binary_path).to.equal('/usr/local/bin/scroll-runtime-materializer')
    expect(batchSubprocess.ethereum_da.l1_rpc_url).to.equal('https://ethereum.example.com')
    expect(batchSubprocess.ethereum_da).not.to.have.property('eth_chain_id')
    expect(batchSubprocess.ethereum_da).not.to.have.property('l2_chain_id')
    expect(batchSubprocess.ethereum_da.blob_source.aws_s3).to.deep.equal({
      key_prefix: 'blobs',
      url: 'https://blob-archive.example.com',
    })
    expect(parsed.materializer.bridge.dogecoin_rpc).to.deep.equal({
      network: 'testnet',
      url: 'http://dogecoin:22555',
    })
    expect(parsed.materializer.bridge.ethereum_da.blob_source.aws_s3.url).to.equal('https://blob-archive.example.com')
    expect(parsed.materializer.bridge.advance_l1).to.equal(true)
    expect(parsed.materializer.bridge.advance_l2).to.equal(true)
  })

  it('prefers the native WithdrawalProcessor.toml over values env', () => {
    writeWithdrawalValues(root, { DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__RPC_URL: 'http://stale-env:8545' })
    const nativePath = path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
    fs.mkdirSync(path.dirname(nativePath), { recursive: true })
    fs.writeFileSync(nativePath, `network_str = "testnet"
dogecoin_rpc_url = "http://dogecoin:22555"

[dogeos_indexer]
rpc_url = "http://l2-rpc-from-toml:8545"

[ethereum_da]
l1_rpc_url = "https://ethereum.example.com"

[ethereum_da.blob_source]
timeout_ms = 10000

[ethereum_da.blob_source.aws_s3]
url = "https://blob-archive.example.com"
key_prefix = "blobs"
`)
    const configFile = path.join(root, 'proof-coordinator/ProofCoordinator.toml')

    scaffoldProofCoordinatorConfig({ coordinatorConfigPath: configFile, valuesDir: path.join(root, 'values') })
    const parsed = toml.parse(fs.readFileSync(configFile, 'utf8')) as any
    expect(parsed.materializer.scroll_batch.subprocess.l2_rpc_url).to.equal('http://l2-rpc-from-toml:8545')
    expect(parsed.materializer.bridge.ethereum_da.blob_source.aws_s3.url).to.equal('https://blob-archive.example.com')
  })

  it('names the offending TOML key when the native config has placeholders', () => {
    const nativePath = path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
    fs.mkdirSync(path.dirname(nativePath), { recursive: true })
    fs.writeFileSync(nativePath, `network_str = "<TODO>"
dogecoin_rpc_url = "http://dogecoin:22555"
`)

    expect(() => scaffoldProofCoordinatorConfig({
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      valuesDir: path.join(root, 'values'),
    })).to.throw('network_str is an unresolved placeholder')
  })

  it('falls back to a beacon node blob source when no S3 archive is configured', () => {
    writeWithdrawalValues(root, {
      DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__KEY_PREFIX: undefined,
      DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL: undefined,
      DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL: 'https://beacon.example.com',
    })
    const configFile = path.join(root, 'proof-coordinator/ProofCoordinator.toml')

    scaffoldProofCoordinatorConfig({ coordinatorConfigPath: configFile, valuesDir: path.join(root, 'values') })
    const parsed = toml.parse(fs.readFileSync(configFile, 'utf8')) as any
    expect(parsed.materializer.bridge.ethereum_da.blob_source.beacon_node.url).to.equal('https://beacon.example.com')
    expect(parsed.materializer.bridge.ethereum_da.blob_source.aws_s3).to.equal(undefined)
  })

  it('fails when no blob source provider is available', () => {
    writeWithdrawalValues(root, {
      DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__KEY_PREFIX: undefined,
      DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL: undefined,
    })

    expect(() => scaffoldProofCoordinatorConfig({
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      valuesDir: path.join(root, 'values'),
    })).to.throw('a blob source is required')
  })

  it('rejects unresolved placeholders and names the offending env', () => {
    writeWithdrawalValues(root, { DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__RPC_URL: '<TODO>' })

    expect(() => scaffoldProofCoordinatorConfig({
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      valuesDir: path.join(root, 'values'),
    })).to.throw('DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__RPC_URL is an unresolved placeholder')
  })

  it('reconciles an existing legacy coordinator runtime and is byte-idempotent', () => {
    writeWithdrawalValues(root)
    const configFile = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    scaffoldProofCoordinatorConfig({
      coordinatorConfigPath: configFile,
      valuesDir: path.join(root, 'values'),
    })

    // Model a pre-runtime-marker scaffold and an operator-owned edit outside
    // the materializer tree.
    const legacy = fs.readFileSync(configFile, 'utf8')
      .replace(`${MANAGED_RUNTIME_BEGIN}\n`, '')
      .replace(`\n${MANAGED_RUNTIME_END}`, '')
      .replace('poll_interval_ms = 1000', 'poll_interval_ms = 4242')
      .replace('# Generated by', '# operator comment must survive\n# Generated by')
    fs.writeFileSync(configFile, legacy)
    writeWithdrawalValues(root, {
      DOGEOS_WITHDRAWAL_DOGECOIN_RPC_URL: 'http://new-dogecoin:22555',
      DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__RPC_URL: 'http://new-l2-rpc:8545',
      DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__KEY_PREFIX: undefined,
      DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL: undefined,
      DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL: 'https://new-beacon.example.com',
      DOGEOS_WITHDRAWAL_ETHEREUM_DA__L1_RPC_URL: 'https://new-ethereum.example.com',
      DOGEOS_WITHDRAWAL_NETWORK_STR: 'regtest',
    })

    const result = scaffoldProofCoordinatorConfig({
      coordinatorConfigPath: configFile,
      valuesDir: path.join(root, 'values'),
    })
    expect(result.created).to.equal(false)
    expect(result.updated).to.equal(true)

    const first = fs.readFileSync(configFile, 'utf8')
    expect(first).to.include('# operator comment must survive')
    expect(first).to.include('poll_interval_ms = 4242')
    expect(first).to.include(MANAGED_RUNTIME_BEGIN)
    expect(first).to.include(MANAGED_RUNTIME_END)
    const parsed = toml.parse(first) as any
    expect(parsed.materializer.scroll_batch.subprocess.l2_rpc_url).to.equal('http://new-l2-rpc:8545')
    expect(parsed.materializer.bridge.dogecoin_rpc).to.deep.equal({
      network: 'regtest',
      url: 'http://new-dogecoin:22555',
    })
    for (const ethereumDa of [
      parsed.materializer.bridge.ethereum_da,
      parsed.materializer.scroll_batch.subprocess.ethereum_da,
    ]) {
      expect(ethereumDa.l1_rpc_url).to.equal('https://new-ethereum.example.com')
      expect(ethereumDa.blob_source.beacon_node.url).to.equal('https://new-beacon.example.com')
      expect(ethereumDa.blob_source.aws_s3).to.equal(undefined)
    }

    const secondResult = scaffoldProofCoordinatorConfig({
      coordinatorConfigPath: configFile,
      valuesDir: path.join(root, 'values'),
    })
    expect(secondResult).to.deep.equal({configFile, created: false, updated: false})
    expect(fs.readFileSync(configFile, 'utf8')).to.equal(first)
  })

  it('removes mutually exclusive materializer topology when proof mode changes', () => {
    writeWithdrawalValues(root)
    const configFile = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    scaffoldProofCoordinatorConfig({
      coordinatorConfigPath: configFile,
      valuesDir: path.join(root, 'values'),
    })

    scaffoldProofCoordinatorConfig({
      coordinatorConfigPath: configFile,
      provingMode: 'mock',
      valuesDir: path.join(root, 'values'),
    })
    const mock = toml.parse(fs.readFileSync(configFile, 'utf8')) as any
    expect(mock.materializer.dev_sentinel_scroll_chunk.enabled).to.equal(true)
    expect(mock.materializer.scroll_chunk_segmentation).to.equal(undefined)
    expect(mock.materializer.scroll_batch.dev_sentinel).to.equal(true)
    expect(mock.materializer.scroll_batch.subprocess).to.equal(undefined)

    scaffoldProofCoordinatorConfig({
      coordinatorConfigPath: configFile,
      provingMode: 'production',
      valuesDir: path.join(root, 'values'),
    })
    const production = toml.parse(fs.readFileSync(configFile, 'utf8')) as any
    expect(production.materializer.dev_sentinel_scroll_chunk).to.equal(undefined)
    expect(production.materializer.scroll_chunk_segmentation.enabled).to.equal(true)
    expect(production.materializer.scroll_batch.dev_sentinel).to.equal(false)
    expect(production.materializer.scroll_batch.proof_mode).to.equal(undefined)
    expect(production.materializer.scroll_batch.subprocess.l2_rpc_url).to.equal('http://l2-rpc:8545')
  })

  it('refuses to rewrite an ambiguous hand-maintained coordinator config', () => {
    writeWithdrawalValues(root)
    const configFile = path.join(root, 'proof-coordinator/ProofCoordinator.toml')
    fs.mkdirSync(path.dirname(configFile), {recursive: true})
    const original = '# hand maintained\npoll_interval_ms = 42\n'
    fs.writeFileSync(configFile, original)

    expect(() => scaffoldProofCoordinatorConfig({
      coordinatorConfigPath: configFile,
      valuesDir: path.join(root, 'values'),
    })).to.throw('cannot safely reconcile an existing coordinator config')
    expect(fs.readFileSync(configFile, 'utf8')).to.equal(original)
  })

  it('requires prepared withdrawal values before scaffolding', () => {
    expect(() => scaffoldProofCoordinatorConfig({
      coordinatorConfigPath: path.join(root, 'proof-coordinator/ProofCoordinator.toml'),
      valuesDir: path.join(root, 'values'),
    })).to.throw('run scrollsdk setup prep-charts before scaffolding')
  })
})
