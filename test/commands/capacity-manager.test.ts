import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cli = path.resolve('bin/run.js')
describe('capacity-manager runtime command', () => {
  let root: string
  beforeEach(() => {root = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-command-')); fs.mkdirSync(path.join(root, 'bin'))})
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  function run(args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], {cwd: root, encoding: 'utf8', env: {...process.env, PATH: `${root}/bin:${process.env.PATH}`}, timeout: 30_000})
  }

  it('reports capacity status outside setup without mutation or raw logs', () => {
    fs.mkdirSync(path.join(root, '.scrollsdk/capacity-manager'), {recursive: true})
    fs.writeFileSync(path.join(root, '.scrollsdk/capacity-manager/plan.json'), JSON.stringify({dstack: {namespace: 'chain'}, namespace: 'chain', schema: 'scrollsdk/capacity-manager/v1'}))
    fs.writeFileSync(path.join(root, 'bin/kubectl'), `#!${process.execPath}
const args = process.argv.slice(2);
require('node:fs').appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
if (args.includes('get')) process.stdout.write(JSON.stringify({spec:{replicas:1},status:{readyReplicas:1}}));
else if (args.includes('logs')) process.stdout.write('capacity-manager reconcile decision NONFUNCTIONAL_PRIVATE_MARKER\\ncapacity-manager reconcile decision\\n');
else process.exit(1);
`, {mode: 0o700})
    const result = run(['capacity-manager', 'status', '--json', '--kube-context', 'selected', '--namespace', 'chain'])
    expect(result.status, result.stdout + result.stderr).equal(0)
    const report = JSON.parse(result.stdout).data.status
    expect(report).include({controlLoop: 'recent-decisions-observed', present: true, proofAcceptance: 'not-verified'})
    expect(result.stdout + result.stderr).not.include('NONFUNCTIONAL_PRIVATE_MARKER')
    const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(calls.map(args => args.slice(0, 5))).deep.equal([['--context', 'selected', '--namespace', 'chain', 'get'], ['--context', 'selected', '--namespace', 'chain', 'logs']])
  })

  for (const action of ['status', 'probe']) it(`requires an explicit context for ${action}`, () => {
    const result = run(['capacity-manager', action])
    expect(result.status).not.equal(0)
    expect(result.stdout + result.stderr).include('kube-context')
  })

})
