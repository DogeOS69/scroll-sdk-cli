/* eslint-disable @typescript-eslint/no-explicit-any -- Exercise local Secret generation only. */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import SetupGenSecrets from '../../../src/commands/setup/gen-secrets.js'
import {generateDstackControllerValues} from '../../../src/utils/dstack-controller-values.js'

describe('setup gen-secrets dstack database handoff', () => {
  let cwd: string
  let directory: string
  let command: any
  beforeEach(() => {
    cwd = process.cwd()
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dstack-secret-test-'))
    process.chdir(directory)
    command = Object.assign(Object.create(SetupGenSecrets.prototype), {
      dogeConfig: {dstackController: {database: {existingSecret: 'my-dstack-db', key: 'connection'}}},
      generateEnvContent: () => ({}),
      generateRethEnvFiles: () => ({}),
      jsonCtx: {error(_code: string, message: string) {throw new Error(message)}, log() {}, logSuccess() {}},
    })
  })
  afterEach(() => {
    process.chdir(cwd)
    fs.rmSync(directory, {force: true, recursive: true})
  })

  it('regenerates the private local Secret using the exact chart reference', async () => {
    const url = 'postgresql+asyncpg://dstack:test%40password@db:5432/dstack?ssl=require'
    fs.writeFileSync('config.toml', toml.stringify({db: {DSTACK_DB_CONNECTION_STRING: url}}))
    await command.createEnvFiles()
    const values = yaml.load(generateDstackControllerValues(command.dogeConfig.dstackController)!) as any
    const secret = yaml.load(fs.readFileSync(`secrets/${values.database.existingSecret}.yaml`, 'utf8')) as any
    expect(secret.metadata.name).to.equal(values.database.existingSecret)
    expect(secret.stringData[values.database.key]).to.equal(url)
    expect(secret.metadata).not.to.have.property('namespace')
    expect(fs.statSync('secrets/my-dstack-db.yaml').mode % 0o1000).to.equal(0o600)
  })

  it('skips disabled/SQLite controllers even when an old DSN remains', async () => {
    fs.writeFileSync('config.toml', toml.stringify({db: {DSTACK_DB_CONNECTION_STRING: 'old-url'}}))
    for (const config of [{enabled: false}, {database: {type: 'sqlite'}}]) {
      command.dogeConfig.dstackController = config
      await command.createEnvFiles()
      expect(fs.existsSync('secrets')).to.equal(false)
    }
  })

  it('requires db-init before exporting an enabled PostgreSQL controller Secret', async () => {
    fs.writeFileSync('config.toml', '[db]\n')
    try {
      await command.createEnvFiles()
      expect.fail('missing dstack connection string must fail')
    } catch (error) {
      expect(String(error)).to.include('run setup db-init --databases dstack first')
    }
  })
})
