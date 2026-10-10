import * as toml from '@iarna/toml'
import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {writeGrafanaAdminSecret} from '../../src/utils/grafana-admin.js'
import {prepareGrafanaAdmin} from '../../src/utils/preparation-grafana.js'

describe('spec preparation Grafana admin', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'preparation-grafana-'))
    fs.mkdirSync(path.join(root, 'values'))
    fs.mkdirSync(path.join(root, '.data'))
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), '[dogecoin]\nnetwork = "testnet"\n')
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  const read = (root: string) => toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')) as any

  it('prepares a private stable credential using the generated monitor Secret reference', async () => {
    fs.writeFileSync(path.join(root, 'values/scroll-monitor-production.yaml'), 'grafana:\n  admin:\n    existingSecret: custom-admin\n    userKey: username\n    passwordKey: password\n')
    await prepareGrafanaAdmin(root)
    const config = read(root)
    expect(config.grafana.adminPassword).to.have.length(32)
    expect(config.grafana.existingSecret).to.equal('custom-admin')
    expect(config.dogecoin.network).to.equal('testnet')
    expect(fs.statSync(path.join(root, '.data/doge-config.toml')).mode % 0o1000).to.equal(0o600)
    expect(writeGrafanaAdminSecret(config.grafana, root)).to.equal(path.join(root, 'secrets/custom-admin.env'))
    await prepareGrafanaAdmin(root)
    expect(read(root)).to.deep.equal(config)
  })

  it('does not create credentials without an enabled bundled Grafana', async () => {
    await prepareGrafanaAdmin(root)
    expect(read(root)).not.to.have.property('grafana')
    fs.writeFileSync(path.join(root, 'values/scroll-monitor-production.yaml'), 'grafana:\n  enabled: false\n')
    await prepareGrafanaAdmin(root)
    expect(read(root)).not.to.have.property('grafana')
  })

  it('does not silently replace a previously generated Secret when identity state is missing', async () => {
    fs.writeFileSync(path.join(root, 'values/scroll-monitor-production.yaml'), 'grafana:\n  admin:\n    existingSecret: grafana-admin\n')
    fs.mkdirSync(path.join(root, 'secrets'))
    fs.writeFileSync(path.join(root, 'secrets/grafana-admin.env'), 'nonfunctional-existing-fixture')
    let failure: unknown
    try {await prepareGrafanaAdmin(root)} catch (error) {failure = error}
    expect(String(failure)).to.include('restore grafana credentials')
    expect(read(root)).not.to.have.property('grafana')
  })
})
