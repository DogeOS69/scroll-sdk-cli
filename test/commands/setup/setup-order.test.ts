import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFile} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {promisify} from 'node:util'

const execute = promisify(execFile)
const cli = path.resolve('bin/run.js')

describe('setup order configuration regressions', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-order-regression-'))
    fs.mkdirSync(path.join(root, '.data'))
    fs.mkdirSync(path.join(root, 'values'))
    fs.writeFileSync(path.join(root, 'Makefile'), '# isolated configuration test\n')
    fs.writeFileSync(path.join(root, 'config.toml'), `
[general]
L1_RPC_ENDPOINT = "http://l1-interface:8545"
L2_RPC_ENDPOINT = "http://l2-rpc:8545"
[contracts]
L2_BRIDGE_FEE_RECIPIENT_ADDR = "0x1111111111111111111111111111111111111111"
[contracts.overrides]
L2_TX_FEE_VAULT = "0x5300000000000000000000000000000000000005"
`)
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), `
network = "testnet"
[wallet]
path = ".data/wallet.json"
[dogecoinClusterRpc]
username = "fixture"
password = "fixture"
`)
    // Synthetic Bridge transaction fixture: tests configuration consumers only.
    fs.writeFileSync(path.join(root, '.data/output-withdrawal-processor.toml'), `
bridge_address = "fixture"
genesis_sequencer_txid = "f5eedbcaed2b12685bfc046c04ae7827e47ba6b75cb09342a5ec062ee4c4997f"
genesis_sequencer_vout = 0
genesis_sequencer_tx_hex = "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff00ffffffff0101000000000000000000000000"
network_str = "testnet"
`)
    fs.writeFileSync(path.join(root, '.data/bridge.json'), JSON.stringify({redeem_script_hex: '51'}))
    fs.writeFileSync(path.join(root, '.data/output-test-data.json'), JSON.stringify({fee_wallet_address: 'fixture', sequencer_address: 'fixture'}))
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  for (const retired of [false, true]) {
    it(`prepares current metrics values and removes retired rollup settings (legacy input: ${retired})`, async () => {
      const file = path.join(root, 'values/metrics-exporter-production.yaml')
      fs.writeFileSync(file, yaml.dump({metricsConfig: {
        dogecoin: {url: 'old'}, dogeos: {url: 'old'}, l1Network: {url: 'old'},
        ...(retired ? {rollup: {url: 'http://retired-rollup'}} : {}),
      }}))
      await execute(process.execPath, [cli, 'setup', 'prep-charts', '-N', '--json'], {cwd: root})
      const values = yaml.load(fs.readFileSync(file, 'utf8')) as {metricsConfig: Record<string, Record<string, string>>}
      expect(values.metricsConfig).not.to.have.property('rollup')
      expect(values.metricsConfig.dogeos.url).to.equal('http://l2-rpc:8545')
      expect(values.metricsConfig.dogeos.L2_TX_FEE_VAULT_ADDR).to.equal('0x5300000000000000000000000000000000000005')
      expect(values.metricsConfig.l1Network.url).to.equal('http://l1-interface:8545')
    })
  }

  it('explains the missing proof topology before policy export and writes no bundle', async () => {
    try {
      await execute(process.execPath, [cli, 'setup', 'export-signer-policy', '--json'], {cwd: root})
      expect.fail('Expected missing proof topology to fail')
    } catch (error) {
      const output = error as {stderr: string} & Error
      expect(output.stderr).to.include('Proof topology is not configured')
      expect(output.stderr).not.to.include('Cannot read properties of undefined')
    }

    expect(fs.existsSync(path.join(root, 'signer-policy-bundle'))).to.equal(false)
  })
})
