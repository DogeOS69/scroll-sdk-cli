import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cli = path.resolve('bin/run.js')

describe('setup gen-secrets Dogecoin bootstrap', () => {
  let root: string
  const password = 'bootstrap-fixture-password'
  function config(credentials = `username = "bootstrap-user"\npassword = "${password}"`, filename = '.data/doge-config.toml') {
    fs.writeFileSync(path.join(root, filename), `network = "regtest"\n[wallet]\npath = ".data/wallet.json"\n[dogecoinClusterRpc]\n${credentials}\n`)
  }

  function run(args = ['--dogecoin-only'], env: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(process.execPath, [cli, 'setup', 'gen-secrets', '-N', '--json', ...args], {
      cwd: root, encoding: 'utf8', env: {...process.env, ...env}, timeout: 30_000,
    })
    if (result.error) throw result.error
    return result
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dogecoin-secret-test-'))
    fs.mkdirSync(path.join(root, '.data'))
    config()
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('generates only the Dogecoin Secret without config.toml, wallet, or bridge outputs', () => {
    const result = run()
    expect(result.status, result.stderr).to.equal(0)
    expect(fs.readdirSync(path.join(root, 'secrets'))).to.deep.equal(['dogecoin-secret.env'])
    const file = path.join(root, 'secrets/dogecoin-secret.env')
    expect(fs.readFileSync(file, 'utf8')).to.equal(`DOGECOIN_RPC_USER="bootstrap-user"\nDOGECOIN_RPC_PASSWORD="${password}"\n`)
    expect(fs.statSync(file).mode % 0o1000).to.equal(0o600)
    expect(JSON.parse(result.stdout).data.files).to.deep.equal([file])
    expect(result.stdout + result.stderr).not.to.include(password)
  })

  it('resolves environment credentials once from an explicitly selected config', () => {
    config('username = "$ENV:DOGE_BOOTSTRAP_USER"\npassword = "$ENV:DOGE_BOOTSTRAP_PASSWORD"', 'custom.toml')
    const literalPassword = 'literal-$ENV:DO_NOT_RESOLVE_AGAIN'
    const result = run(['--dogecoin-only', '--doge-config', 'custom.toml'], {
      DOGE_BOOTSTRAP_PASSWORD: literalPassword, DOGE_BOOTSTRAP_USER: 'custom-user',
    })
    expect(result.status, result.stderr).to.equal(0)
    expect(fs.readFileSync(path.join(root, 'secrets/dogecoin-secret.env'), 'utf8')).to.equal(`DOGECOIN_RPC_USER="custom-user"\nDOGECOIN_RPC_PASSWORD="${literalPassword}"\n`)
    expect(result.stdout + result.stderr).not.to.include(literalPassword)
  })

  it('preserves other Secrets and restricts permissions when regenerating', () => {
    fs.mkdirSync(path.join(root, 'secrets'))
    const other = path.join(root, 'secrets/withdrawal-processor-secret.env')
    fs.writeFileSync(other, 'keep-existing-value')
    const file = path.join(root, 'secrets/dogecoin-secret.env')
    fs.writeFileSync(file, 'stale-value', {mode: 0o644})
    const result = run()
    expect(result.status, result.stderr).to.equal(0)
    expect(fs.readFileSync(other, 'utf8')).to.equal('keep-existing-value')
    expect(fs.readFileSync(file, 'utf8')).to.include(password)
    expect(fs.statSync(file).mode % 0o1000).to.equal(0o600)
  })

  for (const credentials of ['username = "bootstrap-user"', `password = "${password}"`, 'username = "bootstrap-user"\npassword = "  "']) {
    it(`rejects incomplete credentials before writing (${credentials.includes('username') ? 'password' : 'username'})`, () => {
      config(credentials)
      const result = run()
      expect(result.status).not.to.equal(0)
      expect(JSON.parse(result.stdout).error.code).to.equal('E611_REQUIRED_SECRET_VALUE_MISSING')
      expect(fs.existsSync(path.join(root, 'secrets'))).to.equal(false)
      expect(result.stdout + result.stderr).not.to.include(password)
    })
  }

  it('fails on an unavailable environment credential without overwriting an existing Secret', () => {
    config('username = "bootstrap-user"\npassword = "$ENV:DOGE_BOOTSTRAP_MISSING"')
    fs.mkdirSync(path.join(root, 'secrets'))
    const file = path.join(root, 'secrets/dogecoin-secret.env')
    fs.writeFileSync(file, 'existing-value')
    const result = run(['--dogecoin-only'], {DOGE_BOOTSTRAP_MISSING: ''})
    expect(result.status).not.to.equal(0)
    expect(JSON.parse(result.stdout).error.code).to.equal('E601_MISSING_ENV_VAR')
    expect(fs.readFileSync(file, 'utf8')).to.equal('existing-value')
  })

  it('rejects conflicting generation modes', () => {
    const result = run(['--dogecoin-only', '--dstack-only'])
    expect(result.status).not.to.equal(0)
    expect(fs.existsSync(path.join(root, 'secrets'))).to.equal(false)
  })

  it('keeps the bridge prerequisite for full generation and explains the bootstrap option', () => {
    const result = run([])
    expect(result.status).not.to.equal(0)
    expect(JSON.parse(result.stdout).error.code).to.equal('E103_BRIDGE_INIT_OUTPUT_MISSING')
    expect(result.stdout).to.include('--dogecoin-only')
    expect(fs.existsSync(path.join(root, 'secrets'))).to.equal(false)
  })
})
