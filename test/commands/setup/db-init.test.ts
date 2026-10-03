/* eslint-disable @typescript-eslint/no-explicit-any -- Exercise command flags and PostgreSQL mocks. */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import sinon from 'sinon'

import SetupDbInit from '../../../src/commands/setup/db-init.js'
import {buildDatabaseUrl, databasePassword, writeDstackDatabaseSecret} from '../../../src/utils/dstack-database.js'

describe('setup db-init active services', () => {
  let directory: string
  let cwd: string
  let command: any
  let config: any
  let flags: any
  let sandbox: sinon.SinonSandbox
  beforeEach(() => {
    cwd = process.cwd()
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'db-init-test-'))
    process.chdir(directory)
    sandbox = sinon.createSandbox()
    sandbox.stub(console, 'log')
    flags = {'non-interactive': true}
    config = {db: {CREATE_BLOCKSCOUT_DB: false}}
    command = Object.assign(Object.create(SetupDbInit.prototype), {
      createConnection: sandbox.stub().resolves({end: sandbox.stub().resolves()}),
      error(message: string) {throw new Error(message)},
      initializeDatabase: sandbox.stub().resolves(),
      log: sandbox.stub(),
      parse: async () => ({flags}),
      promptForConnectionDetails: async () => ['admin-db', '5432', 'private-db', '5432', 'admin', 'admin-secret', 'postgres'],
      promptForPublicConnectionDetails: async () => ['admin-db', '5432', 'admin', 'admin-secret', 'postgres'],
      updatePermissions: sandbox.stub().resolves(),
    })
  })
  afterEach(() => {
    sandbox.restore()
    process.chdir(cwd)
    fs.rmSync(directory, {force: true, recursive: true})
  })
  const writeController = (value: any) => {
    fs.mkdirSync('.data', {recursive: true})
    fs.writeFileSync('.data/doge-config.toml', toml.stringify({dstackController: value}))
  }

  const run = async () => {
    fs.writeFileSync('config.toml', toml.stringify(config))
    await command.run()
    return toml.parse(fs.readFileSync('config.toml', 'utf8')) as any
  }

  it('only initializes Blockscout and enabled PostgreSQL dstack, ignoring retired service settings', async () => {
    config.db = {...config.db, CREATE_BLOCKSCOUT_DB: true, CREATE_L1_EXPLORER_DB: true, SCROLL_DB_CONNECTION_STRING: 'postgres://old:old@old/old'}
    writeController({enabled: true})
    const saved = await run()
    expect(command.initializeDatabase.args.map((args: any[]) => args[1])).to.deep.equal(['scroll_blockscout', 'dstack'])
    expect(saved.db.DSTACK_DB_CONNECTION_STRING).to.match(/^postgresql\+asyncpg:\/\/dstack:.+@private-db:5432\/dstack\?ssl=require$/)
    expect(saved.db.SCROLL_DB_CONNECTION_STRING).to.equal(config.db.SCROLL_DB_CONNECTION_STRING)
    expect(toml.parse(fs.readFileSync('config.public.toml', 'utf8'))).not.to.have.property('db')
    const secret = yaml.load(fs.readFileSync('secrets/dstack-controller-database.yaml', 'utf8')) as any
    expect(secret.stringData['database-url']).to.equal(saved.db.DSTACK_DB_CONNECTION_STRING)
    expect(fs.statSync('secrets/dstack-controller-database.yaml').mode % 0o1000).to.equal(0o600)
  })

  it('supports selecting only dstack and preserves special-character passwords across reruns', async () => {
    flags.databases = ['dstack']
    config.db.CREATE_BLOCKSCOUT_DB = true
    config.db.DSTACK_PASSWORD = 'p@ss:/?#%"\'\\word'
    writeController({database: {existingSecret: 'custom-db', key: 'url'}})
    config = await run()
    expect(command.initializeDatabase.args.map((args: any[]) => args[1])).to.deep.equal(['dstack'])
    const password = config.db.DSTACK_PASSWORD
    delete config.db.DSTACK_PASSWORD
    await run()
    expect(command.initializeDatabase.lastCall.args[3]).to.equal(password)
    const secret = yaml.load(fs.readFileSync('secrets/custom-db.yaml', 'utf8')) as any
    expect(databasePassword(secret.stringData.url)).to.equal(password)
    expect(command.log.args.flat().join(' ')).not.to.include(password)
  })

  it('skips SQLite/disabled controllers and makes no connection when nothing is selected', async () => {
    for (const value of [{enabled: false}, {database: {type: 'sqlite'}}]) {
      writeController(value)
      await run()
    }

    expect(command.createConnection.called).to.equal(false)
    expect(fs.existsSync('secrets')).to.equal(false)
  })

  it('rejects explicit PostgreSQL initialization for a SQLite controller before connecting', async () => {
    flags.databases = ['dstack']
    writeController({database: {type: 'sqlite'}})
    try {
      await run()
      expect.fail('SQLite must reject PostgreSQL initialization')
    } catch (error) {
      expect(String(error)).to.include('SQLite')
    }

    expect(command.createConnection.called).to.equal(false)
  })

  it('updates only selected service ports, preserving encoded credentials and refreshing the Secret', async () => {
    flags = {...flags, databases: ['dstack'], 'update-port': 25_061}
    config.db.DSTACK_DB_CONNECTION_STRING = buildDatabaseUrl({database: 'dstack', dstack: true, host: '::1', password: 'a@:12/b', port: '5432', user: 'dstack'})
    config.db.BLOCKSCOUT_DB_CONNECTION_STRING = 'postgres://blockscout:pw@host:5432/scroll_blockscout'
    const saved = await run()
    expect(new URL(saved.db.DSTACK_DB_CONNECTION_STRING).port).to.equal('25061')
    expect(databasePassword(saved.db.DSTACK_DB_CONNECTION_STRING)).to.equal('a@:12/b')
    expect(saved.db.BLOCKSCOUT_DB_CONNECTION_STRING).to.equal(config.db.BLOCKSCOUT_DB_CONNECTION_STRING)
    const secret = yaml.load(fs.readFileSync('secrets/dstack-controller-database.yaml', 'utf8')) as any
    expect(secret.stringData['database-url']).to.equal(saved.db.DSTACK_DB_CONNECTION_STRING)
    expect(command.createConnection.called).to.equal(false)
  })

  it('updates dstack permissions without rotating credentials', async () => {
    flags = {...flags, databases: ['dstack'], 'update-permissions': true}
    await run()
    expect(command.updatePermissions.lastCall.args.slice(1, 3)).to.deep.equal(['dstack', 'dstack'])
    expect(command.initializeDatabase.called).to.equal(false)
    expect(fs.existsSync('secrets')).to.equal(false)
  })

  it('rejects incompatible asyncpg URLs and unsafe Secret file names', () => {
    const url = buildDatabaseUrl({database: 'dstack', dstack: true, host: 'host', password: 'pw', port: '5432', user: 'dstack'})
    expect(() => writeDstackDatabaseSecret('secrets', url, {database: {existingSecret: '../escape'}})).to.throw('Secret name')
    expect(() => writeDstackDatabaseSecret('secrets', url.replace('ssl=', 'sslmode='))).to.throw('sslmode')
    expect(fs.existsSync('secrets')).to.equal(false)
  })
})
