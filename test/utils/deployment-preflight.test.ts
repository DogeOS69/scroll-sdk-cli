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

})
