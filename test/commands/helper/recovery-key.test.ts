/* eslint-disable no-bitwise -- Assert POSIX file permissions. */
import bitcore from 'bitcore-lib-doge'
import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import {createECDH} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cli = path.resolve('bin/run.js')
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))

describe('helper recovery-key offline CLI', () => {
  let root: string
  let directory: string
  const run = (args: string[] = [], network = 'testnet') => spawnSync(process.execPath, [cli, 'helper', 'recovery-key', '--output', directory, '--network', network, ...args], {cwd: root, encoding: 'utf8'})
  const privatePath = () => path.join(directory, 'recovery-key.private.json')
  const publicPath = () => path.join(directory, 'recovery-key.public.json')
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-key-test-'))
    directory = path.join(root, 'custodian')
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  for (const network of ['mainnet', 'testnet', 'regtest']) {
    it(`creates a ${network} key without deployment files and shares only public metadata`, () => {
      const generated = run(['--json'], network)
      expect(generated.status, generated.stderr).to.equal(0)
      const output = JSON.parse(generated.stdout)
      const secret = read(privatePath())
      const shared = read(publicPath())
      expect(shared).to.have.keys('schema', 'network', 'publicKey')
      expect(shared.network).to.equal(network)
      expect(shared.publicKey).to.match(/^(02|03)[\da-f]{64}$/)
      expect(output.data.publicKey).to.equal(shared.publicKey)
      expect(output.data).not.to.have.property('privateKeyWif')
      // Independent OpenSSL derivation confirms the public key matches the saved WIF.
      const key = bitcore.PrivateKey.fromWIF(secret.privateKeyWif)
      const ecdh = createECDH('secp256k1')
      ecdh.setPrivateKey(Buffer.from(key.toString().padStart(64, '0'), 'hex'))
      expect(ecdh.getPublicKey('hex', 'compressed')).to.equal(shared.publicKey)
      const selected = network === 'mainnet' ? bitcore.Networks.livenet : network === 'regtest' ? bitcore.Networks.regtest : bitcore.Networks.testnet
      expect(new bitcore.PrivateKey(key.toString(), selected).toWIF() === secret.privateKeyWif).to.equal(true)
      expect((generated.stdout + generated.stderr).includes(secret.privateKeyWif)).to.equal(false)
      expect(fs.statSync(directory).mode & 0o777).to.equal(0o700)
      expect(fs.statSync(privatePath()).mode & 0o777).to.equal(0o600)
      const original = fs.readFileSync(privatePath(), 'utf8')
      const inspected = run(['--action', 'inspect', '--json'], network)
      expect(inspected.status, inspected.stderr).to.equal(0)
      expect(JSON.parse(inspected.stdout).data.publicKey).to.equal(shared.publicKey)
      expect((inspected.stdout + inspected.stderr).includes(secret.privateKeyWif)).to.equal(false)
      expect(fs.readFileSync(privatePath(), 'utf8') === original).to.equal(true)
    })
  }

  it('never rotates an existing key, and verifies a restored backup', () => {
    expect(run().status).to.equal(0)
    const original = fs.readFileSync(privatePath(), 'utf8')
    const {publicKey} = read(publicPath())
    const repeated = run(['--json'])
    expect(repeated.status).not.to.equal(0)
    expect(fs.readFileSync(privatePath(), 'utf8') === original).to.equal(true)
    const backup = path.join(root, 'restored')
    fs.mkdirSync(backup, {mode: 0o700})
    fs.cpSync(directory, backup, {recursive: true})
    directory = backup
    const inspected = run(['--action', 'inspect', '--json'])
    expect(inspected.status, inspected.stderr).to.equal(0)
    expect(JSON.parse(inspected.stdout).data.publicKey).to.equal(publicKey)
  })

  it('does not print secrets in human output, network errors or malformed-file errors', () => {
    const generated = run()
    expect(generated.status).to.equal(0)
    const secret = read(privatePath()).privateKeyWif
    const wrongNetwork = run(['--action', 'inspect'], 'regtest')
    expect(wrongNetwork.status).not.to.equal(0)
    fs.writeFileSync(privatePath(), `{"broken": "${secret}`)
    const invalid = run(['--action', 'inspect', '--json'])
    expect(invalid.status).not.to.equal(0)
    for (const response of [generated, wrongNetwork, invalid]) expect((response.stdout + response.stderr).includes(secret)).to.equal(false)
  })

  it('rejects a mismatched public handoff and exposed private-file permissions', () => {
    expect(run().status).to.equal(0)
    const saved = fs.readFileSync(publicPath(), 'utf8')
    fs.writeFileSync(publicPath(), JSON.stringify({...JSON.parse(saved), publicKey: new bitcore.PrivateKey().toPublicKey().toString()}))
    expect(run(['--action', 'inspect']).status).not.to.equal(0)
    fs.writeFileSync(publicPath(), saved)
    fs.chmodSync(privatePath(), 0o644)
    expect(run(['--action', 'inspect']).status).not.to.equal(0)
  })

  it('refuses symlink directories and private files without altering their targets', () => {
    expect(run().status).to.equal(0)
    const original = fs.readFileSync(privatePath(), 'utf8')
    const target = directory
    directory = path.join(root, 'linked')
    fs.symlinkSync(target, directory)
    expect(run().status).not.to.equal(0)
    expect(run(['--action', 'inspect']).status).not.to.equal(0)
    directory = target
    fs.renameSync(privatePath(), path.join(root, 'saved-private.json'))
    fs.symlinkSync(path.join(root, 'saved-private.json'), privatePath())
    expect(run(['--action', 'inspect']).status).not.to.equal(0)
    expect(fs.readFileSync(path.join(root, 'saved-private.json'), 'utf8') === original).to.equal(true)
  })
})
