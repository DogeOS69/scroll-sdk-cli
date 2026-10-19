import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cli = path.resolve('bin/run.js')

describe('setup capacity-manager prepare private inputs', () => {
  for (const input of ['explicit spec', 'saved config', 'frozen intent']) {
    for (const json of [false, true]) it(`omits malformed ${input} contents from ${json ? 'JSON' : 'text'} diagnostics`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-private-input-'))
      try {
        const state = path.join(root, '.scrollsdk')
        fs.mkdirSync(path.join(state, 'capacity-manager'), {recursive: true})
        const intent = path.join(state, 'intent.json')
        fs.writeFileSync(intent, '{}')
        const file = input === 'explicit spec' ? path.join(root, 'spec.yaml') : input === 'saved config' ? path.join(state, 'capacity-manager/config.json') : intent
        const content = input === 'explicit spec' ? 'capacityManager: [\npassword: NONFUNCTIONAL_PRIVATE_MARKER\n' : '{"password": NONFUNCTIONAL_PRIVATE_MARKER}'
        fs.writeFileSync(file, content)
        const args = [cli, 'setup', 'capacity-manager', 'prepare', '--dir', root, ...(input === 'explicit spec' ? ['--spec', file] : []), ...(json ? ['--json'] : [])]
        const result = spawnSync(process.execPath, args, {encoding: 'utf8'})
        const output = result.stdout + result.stderr
        expect(result.status).not.to.equal(0)
        expect(output).not.to.include('NONFUNCTIONAL_PRIVATE_MARKER')
        expect(output).to.include('Invalid').and.to.include(input)
        expect(fs.readFileSync(file, 'utf8')).to.equal(content)
        expect(fs.existsSync(path.join(state, 'capacity-manager/plan.json'))).to.equal(false)
      } finally {fs.rmSync(root, {force: true, recursive: true})}
    })
  }
})

describe('setup capacity-manager credentials', () => {
  it('explains absent plans and bounded-worker mode before any cluster call', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-no-plan-'))
    try {
      const result = spawnSync(process.execPath, [cli, 'setup', 'capacity-manager', 'credentials', '--dir', root, '--json'], {encoding: 'utf8'})
      expect(result.status).not.to.equal(0)
      expect(result.stdout + result.stderr).to.include('bounded proofWorkers')
      expect(result.stdout + result.stderr).to.include('setup capacity-manager prepare')
      expect(result.stdout + result.stderr).not.to.include('ENOENT')
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  it('transfers only referenced credentials through stdin without starting workers or leaking values', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-credentials-'))
    try {
      fs.mkdirSync(path.join(root, '.scrollsdk/capacity-manager'), {recursive: true})
      fs.mkdirSync(path.join(root, 'values'))
      const fleetYaml = 'type: fleet\nname: test-fleet\nnodes: {min: 0, target: 0, max: 2}\n'
      fs.writeFileSync(path.join(root, '.scrollsdk/capacity-manager/fleet.yaml'), fleetYaml)
      const log = path.join(root, 'calls.jsonl')
      fs.writeFileSync(path.join(root, '.scrollsdk/capacity-manager/plan.json'), JSON.stringify({dstack: {auth: {existingSecret: 'dstack-auth', key: 'admin-token'}, deployment: 'dstack-controller', namespace: 'chain'}, fleets: {action: 'create', files: [{path: '.scrollsdk/capacity-manager/fleet.yaml', sha256: createHash('sha256').update(fleetYaml).digest('hex')}]}, kubeContext: 'saved-context', namespace: 'chain', project: 'test-project', proofSecret: 'proof-secrets', schema: 'scrollsdk/capacity-manager/v1', valuesFile: 'values/capacity-manager-production.yaml', workerCredentialMaster: {existingSecret: 'proof-secrets', key: 'prover-worker-token'}}))
      fs.writeFileSync(path.join(root, 'values/capacity-manager-production.yaml'), 'dstackAuth:\n  existingSecret: dstack-auth\n  key: admin-token\nworkerCredentialMaster:\n  existingSecret: proof-secrets\n  key: prover-worker-token\nmanager:\n  dstack:\n    project: test-project\n    fleets: [test-fleet]\n')
      fs.writeFileSync(path.join(root, 'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.includes('exec') || args.includes('apply') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.CM_TEST_LOG, JSON.stringify({args, input}) + '\\n');
if (process.env.CM_FAIL_WAIT && args.includes('rollout')) { console.error('NONFUNCTIONAL_PRIVATE_RESPONSE'); process.exit(1); }
if(args.includes('get') && args.includes('dstack-auth')) console.log(JSON.stringify({data:{'admin-token':Buffer.from('NONFUNCTIONAL_DSTACK_TOKEN').toString('base64')}}));
else if(args.includes('get')) process.stdout.write('');
else console.log('{"updated":true}');
`, {mode: 0o755})
      const result = spawnSync(process.execPath, [cli, 'setup', 'capacity-manager', 'credentials', '--deployment-dir', root, '--kube-context', 'test-context', '--json'], {encoding: 'utf8', env: {...process.env, CM_TEST_LOG: log, PATH: `${root}:${process.env.PATH}`}})
      expect(result.status, result.stderr + result.stdout).to.equal(0)
      expect(result.stdout + result.stderr).not.to.include('NONFUNCTIONAL_')
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(calls.every(call => call.args.includes('test-context'))).to.equal(true)
      const exec = calls.find(call => call.args.includes('exec'))
      // The manager mints per-run credentials from its mounted master; no
      // worker secret is read back or sent to dstack.
      expect(JSON.parse(exec.input)).not.to.have.any.keys('secretName', 'token')
      expect(calls.some(call => call.args.includes('secret'))).to.equal(false)
      expect(JSON.parse(exec.input)).to.include({fleetAction: 'create'})
      expect(JSON.parse(exec.input).fleets[0]).to.deep.include({name: 'test-fleet', nodes: {max: 2, min: 0, target: 0}})
      expect(exec.args.join(' ')).not.to.include('NONFUNCTIONAL_')
      expect(calls.filter(call => call.args.includes('apply'))).to.have.length(0)
      expect(calls.some(call => call.args.includes('dstack-auth'))).to.equal(false)
      const wait = calls.findIndex(call => call.args.includes('rollout'))
      expect(wait).to.be.greaterThan(-1)
      expect(wait).to.be.lessThan(calls.indexOf(exec))
      fs.writeFileSync(log, '')
      const failed = spawnSync(process.execPath, [cli, 'setup', 'capacity-manager', 'credentials', '--dir', root, '--json'], {encoding: 'utf8', env: {...process.env, CM_FAIL_WAIT: '1', CM_TEST_LOG: log, PATH: `${root}:${process.env.PATH}`}})
      expect(failed.status).not.to.equal(0)
      expect(failed.stdout + failed.stderr).not.to.include('NONFUNCTIONAL_PRIVATE_RESPONSE')
      expect(failed.stdout + failed.stderr).to.include('retry make install-capacity-manager')
      expect(fs.readFileSync(log, 'utf8').trim().split('\n')).to.have.length(1)
      fs.writeFileSync(log, '')
      const status = spawnSync(process.execPath, [cli, 'setup', 'capacity-manager', 'status', '--dir', root, '--json'], {encoding: 'utf8', env: {...process.env, CM_TEST_LOG: log, PATH: `${root}:${process.env.PATH}`}})
      expect(status.status, status.stderr + status.stdout).to.equal(0)
      const statusCall = JSON.parse(fs.readFileSync(log, 'utf8').trim())
      expect(statusCall.args).to.include.members(['--context', 'saved-context', '--namespace', 'chain', 'get'])
      fs.writeFileSync(log, '')
      fs.appendFileSync(path.join(root, '.scrollsdk/capacity-manager/fleet.yaml'), 'max_price: 999\n')
      const changed = spawnSync(process.execPath, [cli, 'setup', 'capacity-manager', 'credentials', '--dir', root, '--json'], {encoding: 'utf8', env: {...process.env, CM_TEST_LOG: log, PATH: `${root}:${process.env.PATH}`}})
      expect(changed.status).not.to.equal(0)
      expect(changed.stdout + changed.stderr).to.include('fleet YAML changed')
      expect(fs.readFileSync(log, 'utf8')).to.equal('')

    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })
})
