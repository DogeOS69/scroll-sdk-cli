// Opt-in local E2E. Uses only disposable PostgreSQL/dstack containers on an
// internal Docker network. No provider credentials, GPU or Kubernetes access.
import toml from '@iarna/toml'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import yaml from 'js-yaml'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dstack-db-e2e-'))
const prefix = `dstack-db-e2e-${randomBytes(5).toString('hex')}`
const database = `${prefix}-pg`
const controller = `${prefix}-controller`
const network = `${prefix}-network`
const pgImage = process.env.DSTACK_E2E_POSTGRES_IMAGE || 'postgres:17.9'
const dstackImage = 'dstackai/dstack@sha256:a502b38014dc9730ad712f60c067b84a00a4cf091982b81f9982fdc60ac6852b'
const docker = (...args) => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000}).trim()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const secret = randomBytes(32).toString('hex')
const cleanup = []

async function waitFor(check, label) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {return check()} catch {await sleep(1000)}
  }

  throw new Error(`${label} did not become ready`)
}

try {
  // Require pre-pulled images; never silently download arbitrary image tags.
  docker('image', 'inspect', pgImage)
  docker('image', 'inspect', dstackImage)
  fs.writeFileSync(path.join(directory, 'postgres.env'), `POSTGRES_PASSWORD=${secret}\n`, {mode: 0o600})
  docker('network', 'create', '--internal', network)
  cleanup.push(() => docker('network', 'rm', network))
  docker('run', '-d', '--name', database, '--network', network, '--env-file', path.join(directory, 'postgres.env'), pgImage)
  cleanup.push(() => docker('rm', '-fv', database))
  await waitFor(() => docker('exec', database, 'pg_isready', '-U', 'postgres'), 'PostgreSQL')
  const address = JSON.parse(docker('inspect', database))[0].NetworkSettings.Networks[network].IPAddress
  fs.mkdirSync(path.join(directory, '.data'))
  fs.writeFileSync(path.join(directory, '.data/doge-config.toml'), toml.stringify({dstackController: {enabled: true}}))
  const config = {db: {
    CREATE_BLOCKSCOUT_DB: false,
    DSTACK_PASSWORD: 'test @:/?#%"\'\\' + secret,
    DSTACK_SSL_MODE: 'disable',
    admin: {DATABASE: 'postgres', PASSWORD: secret, PUBLIC_HOST: address, PUBLIC_PORT: '5432', USERNAME: 'postgres', VPC_HOST: database, VPC_PORT: '5432'},
  }}
  fs.writeFileSync(path.join(directory, 'config.toml'), toml.stringify(config), {mode: 0o600})
  const run = (...args) => JSON.parse(execFileSync(process.execPath,
    [path.join(root, 'bin/run.js'), 'setup', 'db-init', '--databases', 'dstack', '--non-interactive', '--json', ...args],
    {cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000}))
  assert.equal(run().success, true)
  const saved = toml.parse(fs.readFileSync(path.join(directory, 'config.toml'), 'utf8'))
  const url = saved.db.DSTACK_DB_CONNECTION_STRING
  delete saved.db.DSTACK_PASSWORD
  fs.writeFileSync(path.join(directory, 'config.toml'), toml.stringify(saved))
  assert.equal(run().success, true)
  assert.equal(toml.parse(fs.readFileSync(path.join(directory, 'config.toml'), 'utf8')).db.DSTACK_DB_CONNECTION_STRING, url)
  assert.equal(run('--update-permissions').success, true)
  const manifest = yaml.load(fs.readFileSync(path.join(directory, 'secrets/dstack-controller-database.yaml'), 'utf8'))
  assert.equal(manifest.stringData['database-url'], url)
  assert.equal(fs.statSync(path.join(directory, 'secrets/dstack-controller-database.yaml')).mode & 0o777, 0o600)
  const databases = docker('exec', database, 'psql', '-U', 'postgres', '-Atc', "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname")
  assert.equal(databases, 'dstack\npostgres')
  console.log('PASS: real db-init, rerun password reuse, permissions and Secret output; no retired databases created')

  const serverConfig = path.join(directory, 'server.yml')
  fs.writeFileSync(serverConfig, yaml.dump({projects: [{name: 'main', backends: []}], encryption: {keys: [{type: 'aes', name: 'test', secret: randomBytes(32).toString('base64')}]}}), {mode: 0o444})
  const env = path.join(directory, 'controller.env')
  fs.writeFileSync(env, `DSTACK_DATABASE_URL=${url}\nDSTACK_DEFAULT_CREDS_DISABLED=1\nDSTACK_SERVER_ADMIN_TOKEN=${secret}\n`, {mode: 0o600})
  docker('run', '-d', '--name', controller, '--network', network, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/root/.dstack/server', '--mount', `type=bind,src=${serverConfig},dst=/root/.dstack/server/config.yml,readonly`, '--env-file', env, dstackImage)
  cleanup.push(() => docker('rm', '-fv', controller))
  await waitFor(() => docker('exec', controller, 'python3', '-c', `
import json, os, urllib.request
r = urllib.request.Request('http://127.0.0.1:3000/api/users/get_my_user', data=b'{}', headers={'Content-Type':'application/json', 'Authorization':'Bearer ' + os.environ['DSTACK_SERVER_ADMIN_TOKEN']})
assert json.load(urllib.request.urlopen(r, timeout=3))['username'] == 'admin'
`), 'dstack PostgreSQL migrations and authentication')
  const count = docker('exec', database, 'psql', '-U', 'postgres', '-d', 'dstack', '-Atc', "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
  assert.ok(Number(count) > 10)
  console.log('PASS: pinned dstack image migrated the database and served its authenticated API using the generated asyncpg URL')
} finally {
  let failed = false
  for (const action of cleanup.reverse()) {
    try {action()} catch {failed = true}
  }

  fs.rmSync(directory, {recursive: true, force: true})
  if (failed) throw new Error(`Cleanup failed; inspect Docker resources with prefix ${prefix}`)
}
console.log('PASS: disposable containers, volumes, network and credential files removed')
