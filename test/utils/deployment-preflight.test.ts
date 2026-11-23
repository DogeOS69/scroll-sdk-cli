import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {inspectDeployment} from '../../src/utils/deployment-preflight.js'

describe('current deployment preflight', () => {
  let root: string
  const wp = () => path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
  const configFile = () => path.join(root, '.data/doge-config.toml')
  const options = () => ({deploymentDir: root})
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-preflight-'))
    for (const dir of ['.data', 'values', 'withdrawal-processor']) fs.mkdirSync(path.join(root, dir))
    fs.writeFileSync(configFile(), 'network="testnet"\n[cubesigner]\nmode="transport_only"\n[proof_topology]\nenforcement="observe"\n')
    fs.writeFileSync(wp(), 'fee_rate_sat_per_kvb=1000000\n[custom]\npreserve="yes"\n')
    fs.writeFileSync(path.join(root, 'config.toml'), '[accounts]\nOWNER_ADDR="0x1111111111111111111111111111111111111111"\n')
    fs.writeFileSync(path.join(root, '.data/setup_defaults.toml'), 'sequencer_target_amount=42069000\n')
    fs.writeFileSync(path.join(root, '.data/genesis.json'), JSON.stringify({gasLimit: '0x989680'}))
    fs.writeFileSync(path.join(root, 'values/eth-da-submitter-production.yaml'), yaml.dump({configMaps: {env: {data: {DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_L2_GAS_PER_CHUNK: '15000000'}}}}))
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('validates current inputs without changing source configuration', () => {
    const before = fs.readFileSync(wp(), 'utf8')
    expect(inspectDeployment(options()).blockers).to.deep.equal([])
    expect(fs.readFileSync(wp(), 'utf8')).to.equal(before)
  })

  it('rejects the old Bridge amount and a zero owner before any rollout', () => {
    fs.writeFileSync(path.join(root, '.data/setup_defaults.toml'), 'sequencer_target_amount=420690000\n')
    fs.writeFileSync(path.join(root, 'config.toml'), '[accounts]\nOWNER_ADDR="0x0000000000000000000000000000000000000000"\n')
    const report = inspectDeployment(options())
    expect(report.blockers.join(' ')).to.include('42069000').and.to.include('nonzero EVM address')
  })

  it('requires an explicit policy mode and rejects transport_only on mainnet', () => {
    fs.writeFileSync(configFile(), 'network="testnet"\n[cubesigner]\n')
    expect(inspectDeployment(options()).blockers.join(' ')).to.include('mode explicitly')
    fs.writeFileSync(configFile(), 'network="mainnet"\n[cubesigner]\nmode="transport_only"\n')
    expect(inspectDeployment(options()).blockers.join(' ')).to.include('forbidden on mainnet')
  })

  it('allows testnet transport_only with real enforcement without changing either setting', () => {
    const source = 'network="testnet"\n[cubesigner]\nmode="transport_only"\n[proof_topology]\nmode="active"\ngeneration="real"\nenforcement="enforce"\n'
    fs.writeFileSync(configFile(), source)
    const report = inspectDeployment(options())
    expect(report.blockers).to.deep.equal([])
    expect(report.warnings.join(' ')).to.include('WP proof enforcement is configured separately')
    expect(fs.readFileSync(configFile(), 'utf8')).to.equal(source)
    fs.writeFileSync(configFile(), source.replace('network="testnet"', 'network="mainnet"'))
    expect(inspectDeployment(options()).blockers.join(' ')).to.include('forbidden on mainnet')
  })

  it('refuses low fees and empty batcher allowlists without changing source', () => {
    const source = 'fee_rate_sat_per_kvb=1000\n[ethereum_da.inbox_worker]\nenabled=false\nexpected_batchers=[]\n'
    fs.writeFileSync(wp(), source)
    const report = inspectDeployment(options())
    expect(report.blockers).to.have.length(2)
    expect(fs.readFileSync(wp(), 'utf8')).to.equal(source)
  })

  it('rejects a gas cap equal to block gas and can require dstack without claiming it is installed', () => {
    fs.writeFileSync(path.join(root, '.data/genesis.json'), '{"gasLimit":15000000}')
    const report = inspectDeployment({...options(), requireDstack: true})
    expect(report.blockers.join(' ')).to.include('strictly greater')
    expect(report.blockers.join(' ')).to.include('dstack')
    expect(report.dstack).to.deep.equal({configured: false, valuesPresent: false})
  })

  const mismatch = () => inspectDeployment(options()).warnings.filter(warning => warning.includes('withdrawalBoundAlerts'))
  const submitterLimit = (limit: unknown) => fs.writeFileSync(path.join(root, 'values/eth-da-submitter-production.yaml'), yaml.dump({configMaps: {env: {data: {DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_L2_GAS_PER_CHUNK: '15000000', DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_WITHDRAWALS_PER_DA_TX: limit}}}}))
  const submitterWithEnv = (env: unknown) => fs.writeFileSync(path.join(root, 'values/eth-da-submitter-production.yaml'), yaml.dump({configMaps: {env: {data: {DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_L2_GAS_PER_CHUNK: '15000000', DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_WITHDRAWALS_PER_DA_TX: '4500'}}}, env}))
  const limits = () => inspectDeployment(options()).warnings.filter(warning => warning.includes('max_withdrawals_per_da_tx ('))
  const reth = (file: string, http: string, ws: string, wsEnabled = true) =>
    fs.writeFileSync(path.join(root, 'values', file), yaml.dump({reth: {http: {api: http, enabled: true}, ws: {api: ws, enabled: wsEnabled}}}))

  it('accepts the namespaces each Reth role serves and a values file without lists', () => {
    reth('l2-reth-sequencer-production.yaml', 'eth,net,web3,rpc', 'eth,net,web3,rpc')
    reth('l2-reth-bootnode-production-0.yaml', 'eth,net,web3,rpc', 'net,web3,rpc,admin,eth', false)
    reth('l2-reth-rpc-production.yaml', 'eth, net, web3, rpc, debug', 'eth,net,web3,rpc')
    reth('l2-reth-rpc-public-production.yaml', 'eth,net,web3', 'eth,net,web3')
    fs.writeFileSync(path.join(root, 'values/l2-reth-sequencer-production-0.yaml'), yaml.dump({reth: {networkId: 1}}))
    const report = inspectDeployment(options())
    expect(report.blockers).to.deep.equal([])
    expect(report.warnings.join(' ')).not.to.include('reth.')
  })

  it('refuses privileged namespaces on the public RPC and warns about them on internal nodes', () => {
    reth('l2-reth-rpc-public-production.yaml', 'eth,net,web3', 'eth,net,web3,debug')
    reth('l2-reth-sequencer-production-1.yaml', 'net,web3,rpc,admin,debug,trace,txpool,eth,ots', 'eth,net,web3,rpc')
    reth('l2-reth-rpc-production.yaml', 'eth,net,web3,rpc,debug,txpool', 'eth,net,web3,rpc')
    const report = inspectDeployment(options())
    expect(report.blockers).to.deep.equal(['values/l2-reth-rpc-public-production.yaml reth.ws.api enables debug on the public RPC node; the public endpoint must serve only eth, net, rpc, web3'])
    const warnings = report.warnings.filter(warning => warning.includes('reth.'))
    expect(warnings).to.have.length(2)
    expect(warnings[0]).to.include('l2-reth-rpc-production.yaml reth.http.api enables txpool on the internal RPC node')
    expect(warnings[1]).to.include('l2-reth-sequencer-production-1.yaml reth.http.api enables admin, debug, ots, trace, txpool on the sequencer node')
  })

  it('warns when the backlog alert limit differs from the submitter limit', () => {
    const monitor = (values: unknown) => fs.writeFileSync(path.join(root, 'values/scroll-monitor-production.yaml'), yaml.dump(values))
    monitor({grafana: {enabled: true}})
    expect(mismatch()).to.deep.equal([])
    monitor({withdrawalBoundAlerts: {maxWithdrawalsPerDaTx: 6000}})
    expect(mismatch()).to.have.length(1)
    expect(mismatch()[0]).to.include('(6000)').and.to.include('(4500)')
    fs.writeFileSync(path.join(root, 'values/eth-da-submitter-production.yaml'), yaml.dump({configMaps: {env: {data: {DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_L2_GAS_PER_CHUNK: '15000000', DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_WITHDRAWALS_PER_DA_TX: '6000'}}}}))
    expect(mismatch()).to.deep.equal([])
    monitor({grafana: {enabled: true}})
    expect(mismatch()).to.have.length(1)
  })

  it('warns when the WP pending-withdrawal alert level differs from the submitter limit', () => {
    const warnCount = () => inspectDeployment(options()).warnings.filter(warning => warning.includes('pending_withdrawal_warn_count'))
    expect(warnCount()).to.deep.equal([])
    submitterLimit('6000')
    expect(warnCount()).to.have.length(1)
    expect(warnCount()[0]).to.include('(unset, default 4500)').and.to.include('(6000)')
    fs.writeFileSync(wp(), 'fee_rate_sat_per_kvb=1000000\npending_withdrawal_warn_count=6000\n')
    expect(warnCount()).to.deep.equal([])
    submitterLimit('4500')
    expect(warnCount()).to.have.length(1)
    expect(warnCount()[0]).to.include('(6000)').and.to.include('(4500)')
    fs.writeFileSync(wp(), 'fee_rate_sat_per_kvb=1000000\npending_withdrawal_warn_count="6000"\n')
    const report = inspectDeployment(options())
    expect(report.blockers).to.deep.equal(['WP pending_withdrawal_warn_count must be a non-negative integer'])
    expect(warnCount()).to.deep.equal([])
  })

  it('refuses a submitter limit that is not a positive integer instead of comparing it', () => {
    for (const limit of ['0', 'many', '-1', '', '6_000', '6000.0', '-0']) {
      submitterLimit(limit)
      const report = inspectDeployment(options())
      expect(report.blockers, limit).to.deep.equal(['eth-da-submitter DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_WITHDRAWALS_PER_DA_TX must be a positive integer'])
      expect(report.warnings.join(' '), limit).not.to.include('max_withdrawals_per_da_tx (')
    }

    for (const limit of [' 6000 ', '+6000']) {
      submitterLimit(limit)
      expect(inspectDeployment(options()).blockers, limit).to.deep.equal([])
      expect(limits(), limit).to.have.length(1)
      expect(limits()[0], limit).to.include('max_withdrawals_per_da_tx (6000)')
    }

    submitterLimit(6000)
    expect(inspectDeployment(options()).blockers).to.deep.equal([])
    expect(limits()).to.have.length(1)
    submitterLimit('{{ .Values.limit }}')
    expect(inspectDeployment(options()).blockers).to.deep.equal([])
    expect(limits()).to.deep.equal([])
    expect(inspectDeployment(options()).warnings.join(' ')).to.include('has no literal value')
  })

  it('takes the submitter limit from the last container env entry before its env ConfigMap', () => {
    submitterWithEnv([{name: 'DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_WITHDRAWALS_PER_DA_TX', value: '4500'}, {name: 'RUST_LOG', value: 'info'}, {name: 'DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_WITHDRAWALS_PER_DA_TX', value: '6000'}])
    expect(limits()).to.have.length(1)
    expect(limits()[0]).to.include('(unset, default 4500)').and.to.include('(6000)')
    submitterWithEnv([{name: 'DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_WITHDRAWALS_PER_DA_TX', valueFrom: {configMapKeyRef: {key: 'limit', name: 'other'}}}])
    const report = inspectDeployment(options())
    expect(report.blockers).to.deep.equal([])
    expect(limits()).to.deep.equal([])
    expect(report.warnings.join(' ')).to.include('has no literal value')
  })

  it('reads the map form of the submitter container env', () => {
    for (const env of [{DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_WITHDRAWALS_PER_DA_TX: '6000'}, {DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_WITHDRAWALS_PER_DA_TX: 6000}, {DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_WITHDRAWALS_PER_DA_TX: {value: '6000'}}]) {
      submitterWithEnv(env)
      expect(limits(), JSON.stringify(env)).to.have.length(1)
      expect(limits()[0], JSON.stringify(env)).to.include('max_withdrawals_per_da_tx (6000)')
    }

    for (const env of [{DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_WITHDRAWALS_PER_DA_TX: {secretKeyRef: {key: 'limit', name: 'other'}}}, {DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_WITHDRAWALS_PER_DA_TX: '{{ .Values.limit }}'}, [{name: 'DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_WITHDRAWALS_PER_DA_TX', value: '{{ .Values.limit }}'}]]) {
      submitterWithEnv(env)
      const report = inspectDeployment(options())
      expect(report.blockers, JSON.stringify(env)).to.deep.equal([])
      expect(limits(), JSON.stringify(env)).to.deep.equal([])
      expect(report.warnings.join(' '), JSON.stringify(env)).to.include('has no literal value')
    }

    submitterWithEnv({RUST_LOG: 'info'})
    expect(limits()).to.deep.equal([])
  })

  it('compares a WP alert level above 2^53 exactly', () => {
    fs.writeFileSync(wp(), 'fee_rate_sat_per_kvb=1000000\npending_withdrawal_warn_count=9007199254740993\n')
    const report = inspectDeployment(options())
    expect(report.blockers).to.deep.equal([])
    expect(report.warnings.join(' ')).to.include('pending_withdrawal_warn_count (9007199254740993)')
  })

})
