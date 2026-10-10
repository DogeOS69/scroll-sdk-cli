import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Disposable committed SDK: deliberately distinctive policies catch lost merges. */
export function createSdkFixture(directory: string): string {
  const templates: Record<string, unknown> = {
    'eth-da-submitter-production.yaml': {configMaps: {env: {data: {
      DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_OPEN_L2_TIME: '2h',
      DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_UNCOMPRESSED_CHUNK_BYTES_SIZE: '123011',
      DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__MIN_PRIORITY_FEE_WEI: '100000000',
      DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__RPC_URL: 'https://template.example.invalid',
      DOGEOS_ETH_DA_SUBMITTER_PUBLISH__TARGET_BLOBS_PER_TX: '6',
    }}}},
    'fee-oracle-production.yaml': {configMaps: {env: {data: {
      DOGEOS_FEE_ORACLE_ETHEREUM_DA__ADVANCE_L2_ACCOUNTING__ENABLED: 'false',
      DOGEOS_FEE_ORACLE_ETHEREUM_DA__CONTRACT_WRITE_MODE: 'live',
      DOGEOS_FEE_ORACLE_ETHEREUM_DA__MIN_PRIORITY_FEE_PER_GAS_WEI: '100000000',
      DOGEOS_FEE_ORACLE_PRICE_ORACLE__CACHE_DURATION: '17',
    }}}},
    'metrics-exporter-production.yaml': {},
    'scroll-monitor-production.yaml': {grafana: {enabled: false}},
  }
  for (const role of ['sequencer', 'bootnode', 'rpc', 'rpc-public']) {
    templates[`l2-reth-${role}-production.yaml`] = {
      resources: {requests: {cpu: '3'}},
      reth: {
        extraArgs: ['--gpo.maxprice', '420000000000000', '--network.legacy-geth-header-transform', 'true'],
        networkId: '<TODO>',
        sequencer: {allowEmptyBlocks: false, blockTimeMs: '2000', payloadBuildingDurationMs: '1400'},
      },
    }
  }

  for (const [file, contents] of Object.entries(templates)) {
    const target = path.join(directory, 'examples/values', file)
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, yaml.dump(contents))
  }

  for (const file of ['withdrawal-processor/WithdrawalProcessor.toml', 'proof-coordinator/ProofCoordinator.toml']) {
    const target = path.join(directory, 'examples', file)
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, '# nonfunctional fixture\n')
  }

  fs.writeFileSync(path.join(directory, 'examples/Makefile.example'), ['install-l2-reth-sequencer:', '\t@true', 'delete-l2-reth-sequencer:', '\t@true', 'install-l2-reth-bootnode:', '\t@true', 'delete-l2-reth-bootnode:', '\t@true'].join('\n'))
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], {encoding: 'utf8', stdio: 'pipe'}).trim()
  git('init'); git('add', 'examples'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Nonfunctional SDK templates')
  return git('rev-parse', 'HEAD')
}
