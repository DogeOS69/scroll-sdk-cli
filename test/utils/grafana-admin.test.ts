import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import sinon from 'sinon'

import SetupGenSecrets from '../../src/commands/setup/gen-secrets.js'
import {configureGrafanaAdmin, writeGrafanaAdminSecret, writeGrafanaPrivateFile} from '../../src/utils/grafana-admin.js'
import {JsonOutputContext} from '../../src/utils/json-output.js'
import {reconcileScrollMonitorGrafana} from '../../src/utils/scroll-monitor-values.js'

describe('Grafana admin configuration', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'grafana-admin-test-')) })
  afterEach(() => {
    delete process.env.GRAFANA_TEST_PASSWORD
    sinon.restore()
    fs.rmSync(root, {force: true, recursive: true})
  })

  it('generates once in non-interactive mode and preserves credentials on rerun', async () => {
    const config = await configureGrafanaAdmin(undefined, true)
    expect(config.adminUser).to.equal('admin')
    expect(config.adminPassword).to.have.length(32)
    expect(await configureGrafanaAdmin(config, true)).to.deep.equal(config)
  })

  it('preserves environment references without materializing credentials in config', async () => {
    process.env.GRAFANA_TEST_PASSWORD = 'nonfunctional-env-fixture'
    const config = await configureGrafanaAdmin({adminPassword: '$ENV:GRAFANA_TEST_PASSWORD'}, true)
    expect(config.adminPassword).to.equal('$ENV:GRAFANA_TEST_PASSWORD')
    const file = writeGrafanaAdminSecret(config, root)
    expect(yaml.load(fs.readFileSync(file, 'utf8'))).to.deep.equal({
      apiVersion: 'v1', kind: 'Secret', metadata: {name: 'grafana-admin'},
      stringData: {'admin-password': process.env.GRAFANA_TEST_PASSWORD, 'admin-user': 'admin'}, type: 'Opaque',
    })
    expect(fs.statSync(file).mode % 0o1000).to.equal(0o600)
  })

  it('keeps the existing password by default without displaying it in prompts', async () => {
    const prompts = {
      confirm: sinon.stub().resolves(false), input: sinon.stub().resolves('admin'), password: sinon.stub(),
    }
    const config = {adminPassword: 'nonfunctional-existing-fixture'}
    expect(await configureGrafanaAdmin(config, false, prompts)).to.deep.equal({...config, adminUser: 'admin'})
    expect(prompts.password.called).to.equal(false)
    expect(prompts.confirm.firstCall.args[0].default).to.equal(false)
    expect(JSON.stringify(prompts.confirm.args) + JSON.stringify(prompts.input.args)).not.to.include(config.adminPassword)
  })

  it('accepts manual passwords through a masked prompt without a secret default', async () => {
    const prompts = {
      confirm: sinon.stub().resolves(false), input: sinon.stub().resolves('operator'),
      password: sinon.stub().resolves('$ENV:GRAFANA_TEST_PASSWORD'),
    }
    expect(await configureGrafanaAdmin({}, false, prompts)).to.deep.equal({
      adminPassword: '$ENV:GRAFANA_TEST_PASSWORD', adminUser: 'operator',
    })
    expect(prompts.password.firstCall.args[0].mask).to.equal('*')
    expect(prompts.password.firstCall.args[0]).not.to.have.property('default')
  })

  it('rejects missing environment passwords without overwriting a previous Secret', () => {
    const file = writeGrafanaAdminSecret({adminPassword: 'nonfunctional-existing-fixture'}, root)
    const before = fs.readFileSync(file, 'utf8')
    expect(() => writeGrafanaAdminSecret({adminPassword: '$ENV:GRAFANA_TEST_PASSWORD'}, root)).to.throw('grafana.adminPassword')
    expect(fs.readFileSync(file, 'utf8')).to.equal(before)
  })

  it('uses the same custom Secret reference and keys in values and the generated Secret', () => {
    const config = {
      adminPassword: 'nonfunctional-custom-fixture', adminUser: 'operator',
      existingSecret: 'custom-grafana', passwordKey: 'password', userKey: 'user',
    }
    const values = {grafana: {adminPassword: 'nonfunctional-legacy-fixture', ingress: {enabled: true}}}
    const changes = reconcileScrollMonitorGrafana(values, config)
    const file = writeGrafanaAdminSecret(config, root)
    expect(yaml.load(fs.readFileSync(file, 'utf8'))).to.deep.include({
      metadata: {name: 'custom-grafana'}, stringData: {password: config.adminPassword, user: 'operator'},
    })
    expect(values.grafana).to.deep.equal({
      admin: {existingSecret: 'custom-grafana', passwordKey: 'password', userKey: 'user'}, ingress: {enabled: true},
    })
    expect(JSON.stringify(changes)).not.to.include('nonfunctional-')
    expect(JSON.stringify(values)).not.to.include(config.adminPassword)
    expect(reconcileScrollMonitorGrafana(values, config)).to.deep.equal([])
  })

  it('leaves older configurations without Grafana credentials unchanged', () => {
    const values = {grafana: {admin: {existingSecret: 'external-owner'}}}
    expect(reconcileScrollMonitorGrafana(values)).to.deep.equal([])
    expect(values.grafana.admin.existingSecret).to.equal('external-owner')
  })

  it('excludes credentials before writing and refuses tracked destinations', () => {
    execFileSync('git', ['init', '-q', root])
    const file = path.join(root, '.data/doge-config.toml')
    writeGrafanaPrivateFile(file, 'nonfunctional-private-fixture')
    execFileSync('git', ['-C', root, 'check-ignore', '--quiet', file])
    execFileSync('git', ['-C', root, 'check-ignore', '--quiet', `${file}.123456.tmp`])
    expect(fs.statSync(file).mode % 0o1000).to.equal(0o600)
    const tracked = path.join(root, 'tracked.toml')
    fs.writeFileSync(tracked, 'public placeholder')
    execFileSync('git', ['-C', root, 'add', 'tracked.toml'])
    expect(() => writeGrafanaPrivateFile(tracked, 'nonfunctional-secret-fixture')).to.throw('Git-tracked')
    expect(fs.readFileSync(tracked, 'utf8')).to.equal('public placeholder')
  })

  it('rejects symlink destinations and invalid Secret references', () => {
    const file = path.join(root, 'linked')
    fs.symlinkSync(path.join(root, 'missing'), file)
    expect(() => writeGrafanaPrivateFile(file, 'nonfunctional-fixture')).to.throw('symbolic links')
    expect(() => writeGrafanaAdminSecret({existingSecret: '../escape'}, root)).to.throw('Secret name')
    expect(() => writeGrafanaAdminSecret({passwordKey: 'same', userKey: 'same'}, root)).to.throw('must differ')
  })

  it('connects full secret generation to Grafana without logging password contents', async () => {
    const previous = process.cwd()
    process.chdir(root)
    try {
      fs.writeFileSync('config.toml', '')
      fs.mkdirSync('secrets')
      const command = new SetupGenSecrets([], {} as never)
      const internals = command as unknown as {
        createEnvFiles: () => Promise<void>
        dogeConfig: {grafana: {adminPassword: string}}
        generateEnvContent: () => Record<string, string>
        generateRethEnvFiles: () => Record<string, string>
        jsonCtx: JsonOutputContext
      }
      internals.dogeConfig = {grafana: {adminPassword: 'nonfunctional-generation-fixture'}}
      internals.jsonCtx = new JsonOutputContext('setup gen-secrets', false)
      const log = sinon.stub(internals.jsonCtx, 'logSuccess')
      sinon.stub(internals, 'generateEnvContent').returns({})
      sinon.stub(internals, 'generateRethEnvFiles').returns({})
      await internals.createEnvFiles()
      expect(fs.existsSync('secrets/grafana-admin.yaml')).to.equal(true)
      expect(JSON.stringify(log.args)).not.to.include(internals.dogeConfig.grafana.adminPassword)
    } finally {
      process.chdir(previous)
    }
  })
})
