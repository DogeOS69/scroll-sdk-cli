/* eslint-disable @typescript-eslint/no-explicit-any -- Inspect serialized CLI artifacts and simulated API responses. */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {spawnSync} from 'node:child_process'
import {generateKeyPairSync} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

import {DSTACK_CREDENTIALS_FILE, readDstackCredentials, writePrivateFile} from '../../../src/utils/dstack-credentials.js'
import {readDstackControllerConfig} from '../../../src/utils/dstack-database.js'
import {loadDstackSecretPublication, publishDstackSecrets, runSecretKubectl} from '../../../src/utils/dstack-secret-publisher.js'

const cli = fileURLToPath(new URL('../../../bin/run.js', import.meta.url))
const privateKey = generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey.export({format: 'pem', type: 'pkcs8'}).toString()
const account = JSON.stringify({client_email: 'test@example.iam.gserviceaccount.com', private_key: privateKey, project_id: 'test-project', type: 'service_account'})

describe('dstack provider credential lifecycle', function () {
  this.timeout(60_000)
  let directory: string
  let originalCwd: string
  let originalPath: string | undefined
  const key = 'fake-vastai-private-key'
  const execute = (...args: string[]) => spawnSync(process.execPath, [cli, 'setup', ...args], {cwd: directory, encoding: 'utf8'})
  const run = (...args: string[]) => {
    const result = execute(...args, '--json', '-N')
    expect(result.status, result.stderr + result.stdout).to.equal(0)
    expect(result.stdout + result.stderr).not.to.include(key)
    expect(result.stdout + result.stderr).not.to.include(privateKey)
    return JSON.parse(result.stdout).data
  }

  const importBoth = () => run('dstack-config', '--vastai-api-key-file', 'vast-key', '--gcp-service-account', 'account.json')
  const installUploadStubs = () => {
    fs.mkdirSync('bin', {recursive: true})
    const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const stdin = tool === 'kubectl' && args.includes('apply') ? fs.readFileSync(0, 'utf8') : '';
const names = stdin ? JSON.parse(stdin).items.map(item => item.metadata.name) : [];
fs.appendFileSync('uploads.jsonl', JSON.stringify({tool, args, names}) + '\\n', {mode: 0o600});
if (args.includes('--dry-run=server') && fs.existsSync('reject-admission')) process.exit(1);
if (args.includes('get') && args.includes('secret')) console.log('{"items":[]}');
else if (args.includes('secrets') && args.includes('list')) console.log('{"scroll/":{}}');
else console.log('{}');
`
    for (const name of ['aws', 'kubectl']) fs.writeFileSync(`bin/${name}`, script, {mode: 0o700})
    process.env.PATH = `${path.resolve('bin')}:${originalPath}`
  }

  const uploads = () => fs.existsSync('uploads.jsonl') ? fs.readFileSync('uploads.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  const legacyService = () => {
    fs.mkdirSync('secrets', {recursive: true})
    fs.mkdirSync('values', {recursive: true})
    fs.writeFileSync('secrets/blockscout.env', 'DATABASE_URL="fake-legacy-value"\n')
    fs.writeFileSync('values/blockscout-production.yaml', yaml.dump({externalSecrets: {
      'blockscout-env': {data: [{remoteRef: {key: 'old/blockscout-env', property: 'DATABASE_URL'}, secretKey: 'DATABASE_URL'}], provider: 'aws'},
    }}))
  }

  const generate = () => {
    run('gen-secrets', '--dstack-only')
    run('prep-charts', '--dstack-only')
  }

  const publication = (runner: (args: string[], stdin?: string) => Promise<string>, dryRun = false) => publishDstackSecrets({
    config: readDstackControllerConfig()!, context: 'isolated-e2e', dryRun, namespace: 'dstack-system', runner, valuesFile: 'values/dstack-controller-production.yaml',
  })
  const rejects = async (operation: () => Promise<unknown>, message: string) => {
    try {await operation(); expect.fail('expected rejection')} catch (error) {expect((error as Error).message).to.include(message)}
  }

  beforeEach(() => {
    originalCwd = process.cwd()
    originalPath = process.env.PATH
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dstack-provider-test-'))
    process.chdir(directory)
    fs.mkdirSync('.data')
    fs.writeFileSync('.data/doge-config.toml', toml.stringify({dstackController: {database: {type: 'sqlite'}}, untouched: {value: 'keep'}}))
    fs.writeFileSync('vast-key', key)
    fs.writeFileSync('account.json', account)
  })
  afterEach(() => {
    process.env.PATH = originalPath
    process.chdir(originalCwd)
    fs.rmSync(directory, {force: true, recursive: true})
  })

  it('imports both providers, wires values and generates Secrets without bridge/database initialization', () => {
    importBoth()
    generate()
    const state = readDstackCredentials()!
    const config = readDstackControllerConfig()!
    const publicContent = fs.readFileSync('.data/doge-config.toml', 'utf8')
    expect(publicContent).to.include('keep').and.not.to.include(key).and.not.to.include('private_key')
    expect(state.providers).to.deep.equal(['vastai', 'gcp'])
    expect(config.credentialSecrets).to.deep.equal([{name: 'gcp', secretName: 'dstack-gcp-credentials'}])
    const secrets = loadDstackSecretPublication(config, 'values/dstack-controller-production.yaml', 'dstack-system')
    const server = yaml.load(secrets[0].stringData['config.yml']) as any
    expect(server.projects[0].backends.map((backend: any) => backend.type)).to.deep.equal(['vastai', 'gcp'])
    expect(server.projects[0].backends[1].creds.filename).to.equal('/etc/dstack/credentials/gcp/service-account.json')
    expect(secrets[2].stringData['service-account.json']).to.equal(account)
    for (const file of [DSTACK_CREDENTIALS_FILE, ...secrets.map(secret => `secrets/${secret.metadata.name}.yaml`)]) {
      expect(fs.statSync(file).mode % 0o1000).to.equal(0o600)
    }

    expect(fs.readFileSync('.gitignore', 'utf8')).to.include('/.data/dstack/').and.to.include('/secrets/')
  })

  it('retains admin/AES identity across reruns and key updates, requiring Secret regeneration', async () => {
    importBoth()
    generate()
    const before = readDstackCredentials()!
    run('dstack-config')
    expect(readDstackCredentials()).to.deep.equal(before)
    fs.writeFileSync('vast-key', 'replacement-key')
    run('dstack-config', '--vastai-api-key-file', 'vast-key')
    const after = readDstackCredentials()!
    expect(after.adminToken).to.equal(before.adminToken)
    expect(after.encryptionKey).to.equal(before.encryptionKey)
    expect(after.gcp).to.deep.equal(before.gcp)
    await rejects(() => publication(async () => {throw new Error('must not contact cluster')}), 'Stale dstack Secret file')
    generate()
    run('push-secrets', '--provider', 'kubernetes', '--dstack-only', '--dry-run', '--kube-context', 'isolated-e2e', '--namespace', 'dstack-system')
  })

  it('updates an explicit spec, preserves custom refs and keeps public config free of secrets', () => {
    fs.writeFileSync('spec.yaml', yaml.dump({dstackController: {
      auth: {existingSecret: 'custom-auth', key: 'token'}, credentialSecrets: [{name: 'gcp', secretName: 'custom-gcp'}],
      database: {type: 'sqlite'}, serverConfig: {existingSecret: 'custom-server', key: 'server.yaml'},
    }, name: 'keep'}))
    run('dstack-config', '--spec', 'spec.yaml', '--gcp-service-account', 'account.json')
    run('gen-secrets', '--dstack-only', '--spec', 'spec.yaml')
    expect(fs.readdirSync('secrets').sort()).to.deep.equal(['custom-auth.yaml', 'custom-gcp.yaml', 'custom-server.yaml'])
    expect(fs.readFileSync('spec.yaml', 'utf8')).not.to.include('private_key')
    expect(readDstackControllerConfig()!.enabled).to.equal(undefined)
  })

  it('publishes only current selected providers, ignoring stale and unrelated files', async () => {
    importBoth()
    generate()
    run('dstack-config', '--provider', 'vastai')
    generate()
    fs.writeFileSync('secrets/unrelated.yaml', 'kind: Deployment')
    const calls: Array<{args: string[]; stdin?: string}> = []
    const result = await publication(async (args, stdin) => {
      calls.push({args, stdin})
      return args.includes('get') ? '{"items":[]}' : ''
    })
    expect(result.secrets).to.deep.equal(['dstack-controller-config', 'dstack-controller-auth'])
    expect(calls).to.have.length(3)
    expect(calls[1].args).to.include('--dry-run=server')
    expect(calls[2].args).not.to.include('--dry-run=server')
    const payload = JSON.parse(calls[2].stdin!)
    expect(payload.items).to.have.length(2)
    expect(payload.items[0].data['config.yml']).to.be.a('string')
    expect(payload.items[0]).not.to.have.property('stringData')
    for (const call of calls) {
      expect(call.args).to.include('isolated-e2e').and.to.include('dstack-system')
      expect(call.args.join(' ')).not.to.include(key)
    }
  })

  it('does not contact Kubernetes in local dry-run and rejects missing explicit destination', async () => {
    importBoth()
    generate()
    const result = await publication(async () => {throw new Error('unexpected Kubernetes request')}, true)
    expect(result.dryRun).to.equal(true)
    const missing = execute('push-secrets', '--provider', 'kubernetes', '--dstack-only', '--json', '-N')
    expect(missing.status).not.to.equal(0)
    expect(JSON.parse(missing.stdout).error.message).to.include('--kube-context and --namespace')
  })

  it('uploads all configured services by default: AWS/Vault files plus dstack Kubernetes Secrets', () => {
    importBoth()
    generate()
    legacyService()
    installUploadStubs()
    for (const provider of ['aws', 'vault']) {
      fs.rmSync('uploads.jsonl', {force: true})
      const result = run('push-secrets', '--provider', provider, '--aws-region', 'us-east-1', '--kube-context', 'isolated-e2e', '--namespace', 'dstack-system')
      expect(result.secretsPushed).to.deep.equal(['blockscout-env'])
      expect(result.dstack.secrets).to.have.length(3)
      const calls = uploads()
      const firstMutation = calls.findIndex(call => call.tool === 'aws' ? call.args.includes('put-secret-value') : call.args.includes('put'))
      expect(firstMutation).to.be.greaterThan(1)
      expect(calls.slice(0, firstMutation).some(call => call.args.includes('--dry-run=server'))).to.equal(true)
      const applies = calls.filter(call => call.args.includes('apply') && !call.args.includes('--dry-run=server'))
      expect(applies).to.have.length(1)
      expect(applies[0].names).to.have.length(3)
      expect(applies[0].args).to.include('isolated-e2e').and.to.include('dstack-system')
      const values = yaml.load(fs.readFileSync('values/blockscout-production.yaml', 'utf8')) as any
      expect(values.externalSecrets['blockscout-env'].provider).to.equal(provider)
    }
  })

  it('treats --dstack-only as a scope filter and does not require --provider kubernetes', () => {
    importBoth()
    generate()
    legacyService()
    installUploadStubs()
    const result = run('push-secrets', '--dstack-only', '--kube-context', 'isolated-e2e', '--namespace', 'dstack-system')
    expect(result.secrets).to.have.length(3)
    expect(uploads().every(call => call.tool === 'kubectl')).to.equal(true)
    expect(uploads().some(call => call.args.includes('put'))).to.equal(false)
  })

  it('validates the entire default scope before remote changes, with a fully local dry-run', () => {
    importBoth()
    generate()
    legacyService()
    installUploadStubs()
    const missing = execute('push-secrets', '--aws-region', 'us-east-1', '-N', '--json')
    expect(missing.status).not.to.equal(0)
    expect(uploads()).to.have.length(0)
    const plan = run('push-secrets', '--dry-run', '--kube-context', 'isolated-e2e', '--namespace', 'dstack-system')
    expect(plan.legacyFiles).to.have.length(1)
    expect(plan.secrets).to.have.length(3)
    expect(uploads()).to.have.length(0)
    fs.writeFileSync('reject-admission', '')
    const denied = execute('push-secrets', '--aws-region', 'us-east-1', '--kube-context', 'isolated-e2e', '--namespace', 'dstack-system', '-N', '--json')
    expect(denied.status).not.to.equal(0)
    expect(uploads()).to.have.length(2)
    expect(uploads().every(call => call.tool === 'kubectl' && (!call.args.includes('apply') || call.args.includes('--dry-run=server')))).to.equal(true)
    fs.unlinkSync('reject-admission')
    fs.unlinkSync('uploads.jsonl')
    fs.unlinkSync('secrets/dstack-controller-auth.yaml')
    const incomplete = execute('push-secrets', '--aws-region', 'us-east-1', '--kube-context', 'isolated-e2e', '--namespace', 'dstack-system', '-N', '--json')
    expect(incomplete.status).not.to.equal(0)
    expect(uploads()).to.have.length(0)
  })

  it('preserves --secret-file and --cubesigner-only scopes even with invalid unrelated dstack config', () => {
    legacyService()
    fs.writeFileSync('.data/doge-config.toml', 'invalid TOML')
    fs.writeFileSync('secrets/cubesigner-signer.env', 'KEY_ID=fake-id\n')
    installUploadStubs()
    const single = run('push-secrets', '--secret-file', 'secrets/blockscout.env', '--aws-region', 'us-east-1', '--skip-yaml-update')
    expect(single.secretsPushed).to.deep.equal(['blockscout-env'])
    const cube = run('push-secrets', '--cubesigner-only', '--aws-region', 'us-east-1', '--skip-yaml-update')
    expect(cube.secretsPushed).to.deep.equal(['cubesigner-signer-env'])
    expect(uploads().every(call => call.tool === 'aws')).to.equal(true)
  })

  it('skips disabled/absent dstack and never treats stale generated files as enabled services', () => {
    legacyService()
    installUploadStubs()
    for (const content of ['', '[dstackController]\nenabled = false\n']) {
      fs.writeFileSync('.data/doge-config.toml', content)
      fs.writeFileSync('secrets/dstack-controller-config.yaml', 'invalid stale file')
      const result = run('push-secrets', '--aws-region', 'us-east-1')
      expect(result).not.to.have.property('dstack')
      expect(result.secretsPushed).to.deep.equal(['blockscout-env'])
    }

    expect(uploads().every(call => call.tool === 'aws')).to.equal(true)
  })

  it('does not silently omit legacy services when kubernetes is selected for a mixed scope', () => {
    importBoth()
    generate()
    legacyService()
    installUploadStubs()
    const result = execute('push-secrets', '--provider', 'kubernetes', '--kube-context', 'isolated-e2e', '--namespace', 'dstack-system', '-N', '--json')
    expect(result.status).not.to.equal(0)
    expect(JSON.parse(result.stdout).error.message).to.include('--provider aws or vault')
    expect(uploads()).to.have.length(0)
  })

  it('refuses mismatching deployed encryption keys/admin identity before any apply', async () => {
    importBoth()
    generate()
    for (const entry of [
      {data: {'admin-token': Buffer.from('other-admin').toString('base64')}, metadata: {name: 'dstack-controller-auth'}},
      {data: {'config.yml': Buffer.from('encryption: {}').toString('base64')}, metadata: {name: 'dstack-controller-config'}},
    ]) {
      let count = 0
      await rejects(() => publication(async () => {count++; return JSON.stringify({items: [entry]})}), 'local state')
      expect(count).to.equal(1)
    }
  })

  it('rejects conflicting Secret names and mismatched production values', async () => {
    const config = {auth: {existingSecret: 'same'}, database: {type: 'sqlite'}, serverConfig: {existingSecret: 'same'}}
    fs.writeFileSync('.data/doge-config.toml', toml.stringify({dstackController: config}))
    const bad = execute('dstack-config', '--vastai-api-key-file', 'vast-key', '-N', '--json')
    expect(bad.status).not.to.equal(0)
    expect(fs.existsSync(DSTACK_CREDENTIALS_FILE)).to.equal(false)
    fs.writeFileSync('.data/doge-config.toml', toml.stringify({dstackController: {database: {type: 'sqlite'}}}))
    importBoth()
    generate()
    const values = yaml.load(fs.readFileSync('values/dstack-controller-production.yaml', 'utf8')) as any
    values.auth.existingSecret = 'wrong-auth'
    fs.writeFileSync('values/dstack-controller-production.yaml', yaml.dump(values))
    await rejects(() => publication(async () => {throw new Error('unexpected')}), 'references differ')
  })

  it('fails closed on corrupt state, malformed credentials and lost identity state', () => {
    fs.writeFileSync('bad.json', '{"private_key":"DO-NOT-PRINT-THIS"')
    const malformed = execute('dstack-config', '--gcp-service-account', 'bad.json', '-N', '--json')
    expect(malformed.status).not.to.equal(0)
    expect(malformed.stdout + malformed.stderr).not.to.include('DO-NOT-PRINT-THIS')
    importBoth()
    generate()
    fs.writeFileSync(DSTACK_CREDENTIALS_FILE, '{}')
    expect(execute('dstack-config', '-N').status).not.to.equal(0)
    fs.unlinkSync(DSTACK_CREDENTIALS_FILE)
    const missing = execute('dstack-config', '--vastai-api-key-file', 'vast-key', '-N')
    expect(missing.status).not.to.equal(0)
    expect(missing.stderr).to.include('Restore .data/dstack/credentials.json')
  })

  it('includes the initialized PostgreSQL Secret with custom key and no retired services', () => {
    fs.writeFileSync('.data/doge-config.toml', toml.stringify({dstackController: {database: {existingSecret: 'custom-db', key: 'dsn'}}}))
    fs.writeFileSync('config.toml', toml.stringify({db: {DSTACK_DB_CONNECTION_STRING: 'postgresql+asyncpg://user:fake-password@db:5432/dstack?ssl=require'}}))
    importBoth()
    generate()
    const secrets = loadDstackSecretPublication(readDstackControllerConfig()!, 'values/dstack-controller-production.yaml', 'dstack-system')
    expect(secrets.map(secret => secret.metadata.name)).to.include('custom-db').and.have.length(4)
    expect(secrets.at(-1)!.stringData.dsn).to.include('postgresql+asyncpg:')
  })

  it('refuses private output symlinks and suppresses subprocess errors containing secrets', async () => {
    fs.writeFileSync('untouched', 'keep')
    fs.symlinkSync(path.resolve('untouched'), 'link')
    expect(() => writePrivateFile('link', 'secret')).to.throw('symbolic links')
    expect(fs.readFileSync('untouched', 'utf8')).to.equal('keep')
    fs.mkdirSync('bin')
    fs.writeFileSync('bin/kubectl', '#!/bin/sh\necho DO-NOT-PRINT-THIS >&2\nexit 1\n', {mode: 0o700})
    const previousPath = process.env.PATH
    process.env.PATH = `${path.resolve('bin')}:${previousPath}`
    try {
      await rejects(() => runSecretKubectl(['apply'], 'secret'), 'response suppressed')
    } finally {process.env.PATH = previousPath}
  })
})
