// Local credential handoff E2E: fake cloud keys, simulated kubectl, and the
// pinned dstack image's actual configuration parser under --network none.
// No real Kubernetes requests, provider calls, controller startup or GPU rental.
import toml from '@iarna/toml'
import yaml from 'js-yaml'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {generateKeyPairSync} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dstack-credentials-e2e-'))
const image = 'dstackai/dstack@sha256:a502b38014dc9730ad712f60c067b84a00a4cf091982b81f9982fdc60ac6852b'
const run = (program, args, extra = {}) => execFileSync(program, args, {cwd: directory, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000, ...extra})
const cli = (...args) => JSON.parse(run(process.execPath, [path.join(root, 'bin/run.js'), 'setup', ...args, '-N', '--json']))
const readYaml = file => yaml.load(fs.readFileSync(path.join(directory, file), 'utf8'))
try {
  run('docker', ['image', 'inspect', image]) // Require the reviewed image to be pre-pulled.
  fs.mkdirSync(path.join(directory, '.data'))
  fs.mkdirSync(path.join(directory, 'values'))
  fs.writeFileSync(path.join(directory, '.data/doge-config.toml'), toml.stringify({dstackController: {database: {type: 'sqlite'}}}))
  const privateKey = generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey.export({format: 'pem', type: 'pkcs8'}).toString()
  fs.writeFileSync(path.join(directory, 'account.json'), JSON.stringify({
    client_email: 'offline@test-project.iam.gserviceaccount.com', private_key: privateKey,
    private_key_id: 'offline-test-key', project_id: 'test-project', token_uri: 'https://oauth2.googleapis.com/token', type: 'service_account',
  }), {mode: 0o600})
  fs.writeFileSync(path.join(directory, 'vast-key'), 'offline-vast-key', {mode: 0o600})
  assert.equal(cli('dstack-config', '--vastai-api-key-file', 'vast-key', '--gcp-service-account', 'account.json').success, true)
  assert.equal(cli('gen-secrets', '--dstack-only').success, true)
  assert.equal(cli('prep-charts', '--dstack-only').success, true)
  const config = readYaml('secrets/dstack-controller-config.yaml').stringData['config.yml']
  const gcp = readYaml('secrets/dstack-gcp-credentials.yaml').stringData['service-account.json']
  const validated = run('docker', ['run', '--rm', '-i', '--network', 'none', '--read-only',
    '--tmpfs', '/root/.dstack/server', '--tmpfs', '/etc/dstack/credentials', '--tmpfs', '/tmp',
    '--entrypoint', '/root/.local/share/uv/tools/dstack/bin/python', image, '-c', `
import json, os, sys, yaml
from dstack._internal.server.services.config import ServerConfig, file_config_to_config
payload = json.load(sys.stdin)
os.makedirs('/etc/dstack/credentials/gcp', exist_ok=True)
with open('/etc/dstack/credentials/gcp/service-account.json', 'w') as f:
    f.write(payload['gcp'])
config = ServerConfig.model_validate(yaml.safe_load(payload['config']))
assert config.projects[0].name == 'main'
assert len(config.encryption.keys) == 1
backends = [file_config_to_config(b) for b in config.projects[0].backends]
assert {b.type for b in backends} == {'vastai', 'gcp'}
assert json.loads(next(b for b in backends if b.type == 'gcp').creds.data)['project_id'] == 'test-project'
print('PASS: pinned dstack parser loaded generated Vast.ai and GCP credentials')
`], {input: JSON.stringify({config, gcp})})
  assert.ok(validated.includes('PASS:'))
  console.log('PASS: pinned dstack 0.21.5 parsed both backends and resolved the mounted GCP JSON offline')

  const chart = process.env.DSTACK_E2E_CHART || path.resolve(root, '../scroll-sdk/charts/dstack-controller')
  run('helm', ['lint', '--strict', chart, '-f', 'values/dstack-controller-production.yaml'])
  const rendered = run('helm', ['template', 'dstack-controller', chart, '--namespace', 'dstack-e2e', '-f', 'values/dstack-controller-production.yaml'])
  const deployment = yaml.loadAll(rendered).find(resource => resource?.kind === 'Deployment')
  assert.ok(deployment.spec.template.spec.volumes.some(volume => volume.secret?.secretName === 'dstack-gcp-credentials'))
  assert.ok(rendered.includes('/etc/dstack/credentials/gcp'))
  assert.ok(!rendered.includes('offline-vast-key') && !rendered.includes('PRIVATE KEY'))
  console.log('PASS: generated production values lint/render against the controller chart without embedded credentials')

  // Exercise the real publisher subprocess/stdin path without a live cluster.
  fs.mkdirSync(path.join(directory, 'bin'))
  fs.writeFileSync(path.join(directory, 'bin/kubectl'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[args.indexOf('--context') + 1] !== 'isolated-e2e' || args[args.indexOf('--namespace') + 1] !== 'dstack-e2e') process.exit(2);
if (args.includes('get')) {
  console.log(fs.existsSync('applied.json') ? fs.readFileSync('applied.json', 'utf8') : '{"items":[]}');
} else if (args.includes('apply')) {
  const input = fs.readFileSync(0, 'utf8');
  const payload = JSON.parse(input);
  if (payload.items.length !== 3 || payload.items.some(s => s.kind !== 'Secret')) process.exit(3);
  if (!args.includes('--dry-run=server')) fs.writeFileSync('applied.json', input, {mode: 0o600});
  console.log('secret/dstack-test');
} else process.exit(4);
`, {mode: 0o700})
  const environment = {...process.env, PATH: `${path.join(directory, 'bin')}:${process.env.PATH}`}
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = JSON.parse(run(process.execPath, [path.join(root, 'bin/run.js'), 'setup', 'push-secrets',
      '--provider', 'kubernetes', '--dstack-only', '--kube-context', 'isolated-e2e', '--namespace', 'dstack-e2e', '-N', '--json'], {env: environment}))
    assert.equal(result.success, true)
    assert.equal(result.data.secrets.length, 3)
  }

  const applied = JSON.parse(fs.readFileSync(path.join(directory, 'applied.json'), 'utf8'))
  assert.equal(Buffer.from(applied.items[0].data['config.yml'], 'base64').toString(), config)
  assert.equal(Buffer.from(applied.items[2].data['service-account.json'], 'base64').toString(), gcp)
  console.log('PASS: CLI uploaded/re-uploaded only the intended Secrets through simulated kubectl using explicit destination and stdin payloads')
} catch {
  // Child-process exceptions may contain a config parser's credential values.
  console.error('FAIL: offline credential handoff E2E; subprocess output suppressed to avoid printing key material')
  process.exitCode = 1
} finally {
  fs.rmSync(directory, {force: true, recursive: true})
}
