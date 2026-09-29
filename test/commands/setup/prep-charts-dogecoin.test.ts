/* eslint-disable @typescript-eslint/no-explicit-any -- Assert generated Helm values. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import PrepCharts from '../../../src/commands/setup/prep-charts.js'

const cli = path.resolve('bin/run.js')

describe('setup prep-charts Dogecoin bootstrap', () => {
  let root: string
  const original = 'dogecoinConf: {}\nservice: {}\nstorage:\n  size: 100Gi\n  storageClass: operator-storage\nimage:\n  tag: keep-version\ningress:\n  hosts:\n    - host: keep.example\n  tls:\n    - hosts: [keep.example]\n'
  function config(network = 'regtest', extra = '', filename = '.data/doge-config.toml') {
    fs.writeFileSync(path.join(root, filename), `network = "${network}"\n[wallet]\npath = "unused-wallet.json"\n[dogecoinClusterRpc]\nusername = "fixture-user"\npassword = "fixture-password"\n${extra}`)
  }

  function run(args: string[] = []) {
    const result = spawnSync(process.execPath, [cli, 'setup', 'prep-charts', '--dogecoin-only', '-N', '--json', ...args], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
    })
    if (result.error) throw result.error
    return result
  }

  function values(directory = 'values'): any {
    return yaml.load(fs.readFileSync(path.join(root, directory, 'dogecoin-production.yaml'), 'utf8'))
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dogecoin-prep-test-'))
    fs.mkdirSync(path.join(root, '.data'))
    fs.mkdirSync(path.join(root, 'values'))
    config()
    fs.writeFileSync(path.join(root, 'values/dogecoin-production.yaml'), original)
    // Invalid unrelated sources must not be read or rewritten at bootstrap.
    fs.writeFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), 'invalid: [')
    fs.writeFileSync(path.join(root, 'config-contracts.toml'), 'invalid = [')
    fs.mkdirSync(path.join(root, 'secrets'))
    fs.writeFileSync(path.join(root, 'secrets/dogecoin-secret.env'), 'keep-secret')
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  for (const [network, service, rpc, p2p] of [
    ['regtest', 'dogecoin', 18_332, 18_444],
    ['testnet', 'dogecoin-testnet', 44_555, 44_556],
    ['mainnet', 'dogecoin', 22_555, 22_556],
  ] as const) {
    it(`prepares ${network} before bridge-init, without Makefile, config.toml, or L2 artifacts`, () => {
      config(network)
      const result = run()
      expect(result.status, result.stderr).to.equal(0)
      const generated = values()
      expect(generated.fullnameOverride).to.equal(service)
      expect(generated.service).to.deep.equal({port: p2p, rpcPort: rpc})
      expect(generated.storage).to.deep.equal({size: '100Gi', storageClass: 'operator-storage'})
      expect(generated.dogecoinConf).to.deep.equal({regtest: network === 'regtest' ? 1 : 0, rpcuser: 'fixture-user', testnet: network === 'testnet' ? 1 : 0})
      expect(generated.image.tag).to.equal('keep-version')
      expect(generated.ingress.hosts[0].host).to.equal('keep.example')
      expect(JSON.parse(result.stdout).data.generation.changedFiles).to.deep.equal([path.join(root, 'values/dogecoin-production.yaml')])
      expect(fs.readFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), 'utf8')).to.equal('invalid: [')
      expect(fs.readFileSync(path.join(root, 'secrets/dogecoin-secret.env'), 'utf8')).to.equal('keep-secret')
      expect(result.stdout + result.stderr).not.to.include('fixture-password')
      expect(fs.readFileSync(path.join(root, 'values/dogecoin-production.yaml'), 'utf8')).not.to.include('fixture-password')
    })
  }

  it('honors explicit config, values directory, Kubernetes endpoints and optional ingress', () => {
    fs.mkdirSync(path.join(root, 'custom-values'))
    fs.writeFileSync(path.join(root, 'custom-values/dogecoin-production.yaml'), original)
    config('regtest', '[kubernetes]\nserviceName="custom-doge"\nrpcPort=19001\np2pPort=19002\n', 'custom.toml')
    fs.writeFileSync(path.join(root, 'config.toml'), '[ingress]\nDOGECOIN_HOST="doge.example:443"\n')
    const result = run(['--doge-config', 'custom.toml', '--values-dir', 'custom-values'])
    expect(result.status, result.stderr).to.equal(0)
    const generated = values('custom-values')
    expect(generated.fullnameOverride).to.equal('custom-doge')
    expect(generated.service).to.deep.equal({port: 19_002, rpcPort: 19_001})
    expect(generated.ingress.hosts[0].host).to.equal('doge.example')
    expect(generated.ingress.tls[0].hosts).to.deep.equal(['doge.example'])
    expect(fs.readFileSync(path.join(root, 'values/dogecoin-production.yaml'), 'utf8')).to.equal(original)
  })

  it('preserves absent, empty and explicit storage in the reconciliation used by both modes', () => {
    const command: any = Object.assign(Object.create(PrepCharts.prototype), {
      dogeConfig: {dogecoinClusterRpc: {username: 'fixture-user'}, network: 'regtest'},
    })
    for (const input of [{}, {storage: {}}, {storage: {size: ''}}, {storage: {size: '1Ti', storageClass: 'custom'}}]) {
      const generated: any = structuredClone(input)
      const before = JSON.stringify(generated.storage)
      const changes = command.reconcileDogecoinValues(generated)
      expect(JSON.stringify(generated.storage)).to.equal(before)
      expect(Object.hasOwn(generated, 'storage')).to.equal(Object.hasOwn(input, 'storage'))
      expect(changes.some((change: {key: string}) => change.key.startsWith('storage'))).to.equal(false)
    }
  })

  it('is idempotent', () => {
    const first = run()
    expect(first.status, first.stderr).to.equal(0)
    const before = fs.readFileSync(path.join(root, 'values/dogecoin-production.yaml'), 'utf8')
    const result = run()
    expect(result.status, result.stderr).to.equal(0)
    expect(JSON.parse(result.stdout).data.generation.changedFiles).to.deep.equal([])
    expect(fs.readFileSync(path.join(root, 'values/dogecoin-production.yaml'), 'utf8')).to.equal(before)
  })

  it('fails clearly when the Dogecoin production template is missing', () => {
    fs.rmSync(path.join(root, 'values/dogecoin-production.yaml'))
    const result = run()
    expect(result.status).not.to.equal(0)
    expect(result.stderr).to.include('Copy the Dogecoin production values template')
    expect(fs.readdirSync(path.join(root, 'values'))).to.deep.equal(['withdrawal-processor-production.yaml'])
  })

  it('rejects invalid Dogecoin YAML without changing the original', () => {
    fs.writeFileSync(path.join(root, 'values/dogecoin-production.yaml'), '- invalid-array\n')
    const result = run()
    expect(result.status).not.to.equal(0)
    expect(result.stderr).to.include('must contain a YAML mapping')
    expect(fs.readFileSync(path.join(root, 'values/dogecoin-production.yaml'), 'utf8')).to.equal('- invalid-array\n')
  })

  it('rejects a values directory outside the deployment root', () => {
    const result = run(['--values-dir', '../outside-values'])
    expect(result.status).not.to.equal(0)
    expect(fs.readFileSync(path.join(root, 'values/dogecoin-production.yaml'), 'utf8')).to.equal(original)
  })

  for (const args of [['--dstack-only'], ['--spec', 'deployment-spec.yaml']]) {
    it(`rejects conflicting ${args[0]}`, () => {
      const result = run(args)
      expect(result.status).not.to.equal(0)
      expect(fs.readFileSync(path.join(root, 'values/dogecoin-production.yaml'), 'utf8')).to.equal(original)
    })
  }
})
