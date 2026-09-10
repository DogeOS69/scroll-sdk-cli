import * as toml from '@iarna/toml'
import {expect} from 'chai'
import {execFile} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

import {stripRetiredServiceConfig} from '../../../src/utils/retired-services.js'

const execFileAsync = promisify(execFile)
const cli = path.resolve('bin/run.js')
const pgModule = fileURLToPath(import.meta.resolve('pg'))
const retiredDbs = ['BRIDGE_HISTORY', 'CHAIN_MONITOR', 'L1_EXPLORER', 'ROLLUP_NODE', 'GAS_ORACLE', 'COORDINATOR', 'ROLLUP_EXPLORER', 'ADMIN_SYSTEM_BACKEND', 'SCROLL']

describe('retired database services', () => {
  let dir: string
  beforeEach(() => {dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-databases-'))})
  afterEach(() => {fs.rmSync(dir, {force: true, recursive: true})})

  for (const mode of ['init', 'clean', 'permissions', 'port']) {
    it(`excludes retired databases during ${mode}, even with legacy opt-ins and credentials`, async () => {
      const fixture = path.join(dir, 'pg-fixture.mjs')
      fs.writeFileSync(fixture, `import pg from ${JSON.stringify(pgModule)};
        import fs from 'node:fs';
        pg.Client = class {
          async connect() {}
          async end() {}
          async query(sql, params) {
            fs.appendFileSync('queries.jsonl', JSON.stringify({sql, params}) + '\\n');
            return {rows: []};
          }
        };`)
      const config = {
        db: {
          ...Object.fromEntries(retiredDbs.flatMap(service => [
            [`${service}_DB_CONNECTION_STRING`, `postgres://old:unused@old:5432/${service.toLowerCase()}`],
            [`${service}_PASSWORD`, '$ENV:UNSET_RETIRED_PASSWORD'],
          ])),
          BLOCKSCOUT_DB_CONNECTION_STRING: 'postgres://blockscout:test@db:5432/scroll_blockscout',
          CREATE_L1_EXPLORER_DB: true,
          admin: {PASSWORD: 'test', PUBLIC_HOST: 'fixture.invalid', USERNAME: 'postgres'},
        },
        frontend: {BRIDGE_API_URI: 'https://bridge.example/api', EXTERNAL_EXPLORER_URI_L1: 'https://explorer.example'},
      }
      fs.writeFileSync(path.join(dir, 'config.toml'), toml.stringify(config))
      const flags = mode === 'clean' ? ['--clean'] : mode === 'permissions' ? ['--update-permissions'] : mode === 'port' ? ['--update-port', '6543'] : []
      const result = await execFileAsync(process.execPath, ['--import', fixture, cli, 'setup', 'db-init', '-N', ...flags], {cwd: dir, timeout: 30_000})
      expect(result.stdout + result.stderr).not.to.include('Do you want to create a database for L1 Explorer')
      const queriesPath = path.join(dir, 'queries.jsonl')
      const queries = fs.existsSync(queriesPath) ? fs.readFileSync(queriesPath, 'utf8') : ''
      expect(queries).not.to.match(/chain_monitor|bridge_history|l1explorer|l1_explorer|rollup|gas_oracle|coordinator|admin_system/i)
      if (mode === 'port') expect(queries).to.equal('')
      else {
        expect(queries).to.include('scroll_blockscout')
        if (mode !== 'permissions') expect(queries).to.include('CREATE DATABASE')
      }

      // Permission updates intentionally do not rewrite configuration files.
      if (mode !== 'permissions') {
        const written = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')
        for (const service of retiredDbs) expect(written).not.to.include(`${service}_DB_CONNECTION_STRING`).and.not.to.include(`${service}_PASSWORD`)
        expect(written).not.to.include('CREATE_L1_EXPLORER_DB')
        expect(written).to.include('BLOCKSCOUT_DB_CONNECTION_STRING')
        expect(written).not.to.include('https://bridge.example/api')
        expect(written).to.include('https://explorer.example')
        if (mode === 'port') expect(written).to.include(':6543/scroll_blockscout')
      }
    })
  }

  it('removes retired spec credentials and images and bridge API settings while preserving the external L1 explorer', () => {
    const source = {
      database: {credentials: {blockscoutPassword: 'keep', bridgeHistoryPassword: 'old', chainMonitorPassword: 'old', l1ExplorerPassword: 'old'}, databases: {blockscout: 'keep', bridgeHistory: 'old', chainMonitor: 'old', l1Explorer: 'old'}},
      frontend: {externalUrls: {l1Explorer: 'https://dogecoin-explorer.example'}, hosts: {bridgeHistoryApi: 'bridge.example', l1Explorer: 'explorer.example'}},
      images: {services: {blockscout: {tag: 'keep'}, bridgeHistoryApi: {}, bridgeHistoryFetcher: {}, chainMonitor: {}}},
    }
    const cleaned = stripRetiredServiceConfig(source)
    expect(cleaned.database).to.deep.equal({credentials: {blockscoutPassword: 'keep'}, databases: {blockscout: 'keep'}})
    expect(cleaned.images.services).to.deep.equal({blockscout: {tag: 'keep'}})
    expect(cleaned.frontend).to.deep.equal({externalUrls: {l1Explorer: 'https://dogecoin-explorer.example'}, hosts: {}})
    expect(source.database.credentials.bridgeHistoryPassword).to.equal('old')
  })
})
