import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
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
      const log = path.join(root, 'calls.jsonl')
      fs.writeFileSync(path.join(root, '.scrollsdk/capacity-manager/plan.json'), JSON.stringify({dstack: {auth: {existingSecret: 'dstack-auth', key: 'admin-token'}, deployment: 'dstack-controller', namespace: 'dstack-system'}, namespace: 'chain', project: 'test-project', proofSecret: 'proof-secrets', schema: 'scrollsdk/capacity-manager/v1', valuesFile: 'values/capacity-manager-production.yaml', workerTokenSecret: 'cm_worker_test'}))
      fs.writeFileSync(path.join(root, 'values/capacity-manager-production.yaml'), 'manager:\n  workerTokenSecret: cm_worker_test\n  dstack:\n    project: test-project\n    fleets: [test-fleet]\n')
      fs.writeFileSync(path.join(root, 'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.includes('exec') || args.includes('apply') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.CM_TEST_LOG, JSON.stringify({args, input}) + '\\n');
if(args.includes('get') && args.includes('proof-secrets')) console.log(JSON.stringify({data:{'prover-worker-token':Buffer.from('NONFUNCTIONAL_WORKER_TOKEN').toString('base64')}}));
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
      expect(exec.args.join(' ')).not.to.include('NONFUNCTIONAL_')
      const apply = calls.find(call => call.args.includes('apply'))
      const secret = JSON.parse(apply.input)
      expect(secret.kind).to.equal('Secret')
      expect(secret.metadata.namespace).to.equal('chain')
      expect(secret.stringData.token).to.equal('NONFUNCTIONAL_DSTACK_TOKEN')
      expect(calls.filter(call => call.args.includes('apply'))).to.have.length(1)
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })
})
