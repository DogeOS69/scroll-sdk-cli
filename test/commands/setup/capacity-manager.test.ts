import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cli = path.resolve('bin/run.js')

describe('setup capacity-manager credentials', () => {
  it('transfers only referenced credentials through stdin without starting workers or leaking values', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-credentials-'))
    try {
      fs.mkdirSync(path.join(root, '.scrollsdk/capacity-manager'), {recursive: true})
      fs.mkdirSync(path.join(root, 'values'))
      const fleetYaml = 'type: fleet\nname: test-fleet\nnodes: {min: 0, target: 0, max: 2}\n'
      fs.writeFileSync(path.join(root, '.scrollsdk/capacity-manager/fleet.yaml'), fleetYaml)
      const log = path.join(root, 'calls.jsonl')
      fs.writeFileSync(path.join(root, '.scrollsdk/capacity-manager/plan.json'), JSON.stringify({dstack: {auth: {existingSecret: 'dstack-auth', key: 'admin-token'}, deployment: 'dstack-controller', namespace: 'chain'}, fleets: {action: 'create', files: [{path: '.scrollsdk/capacity-manager/fleet.yaml', sha256: createHash('sha256').update(fleetYaml).digest('hex')}]}, kubeContext: 'saved-context', namespace: 'chain', project: 'test-project', proofSecret: 'proof-secrets', schema: 'scrollsdk/capacity-manager/v1', valuesFile: 'values/capacity-manager-production.yaml', workerSecret: 'dedicated-worker-secret', workerTokenSecret: 'cm_worker_test'}))
      fs.writeFileSync(path.join(root, 'values/capacity-manager-production.yaml'), 'dstackAuth:\n  existingSecret: dstack-auth\n  key: admin-token\nmanager:\n  workerTokenSecret: cm_worker_test\n  dstack:\n    project: test-project\n    fleets: [test-fleet]\n')
      fs.writeFileSync(path.join(root, 'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.includes('exec') || args.includes('apply') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.CM_TEST_LOG, JSON.stringify({args, input}) + '\\n');
if (process.env.CM_FAIL_WAIT && args.includes('rollout')) { console.error('NONFUNCTIONAL_PRIVATE_RESPONSE'); process.exit(1); }
if(args.includes('get') && args.includes('dedicated-worker-secret')) console.log(JSON.stringify({data:{'prover-worker-token':Buffer.from('NONFUNCTIONAL_WORKER_TOKEN').toString('base64')}}));
else if(args.includes('get') && args.includes('dstack-auth')) console.log(JSON.stringify({data:{'admin-token':Buffer.from('NONFUNCTIONAL_DSTACK_TOKEN').toString('base64')}}));
else if(args.includes('get')) process.stdout.write('');
else console.log('{"updated":true}');
`, {mode: 0o755})
      const result = spawnSync(process.execPath, [cli, 'setup', 'capacity-manager', 'credentials', '--deployment-dir', root, '--kube-context', 'test-context', '--json'], {encoding: 'utf8', env: {...process.env, CM_TEST_LOG: log, PATH: `${root}:${process.env.PATH}`}})
      expect(result.status, result.stderr + result.stdout).to.equal(0)
      expect(result.stdout + result.stderr).not.to.include('NONFUNCTIONAL_')
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(calls.every(call => call.args.includes('test-context'))).to.equal(true)
      const exec = calls.find(call => call.args.includes('exec'))
      expect(JSON.parse(exec.input)).to.include({secretName: 'cm_worker_test', token: 'NONFUNCTIONAL_WORKER_TOKEN'})
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
