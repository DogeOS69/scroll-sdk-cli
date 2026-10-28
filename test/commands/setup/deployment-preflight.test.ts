import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'


const cli = path.resolve('bin/run.js')
describe('deployment preflight CLI', () => {
  let root: string
  function run(args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], {cwd: root, encoding: 'utf8', env: {...process.env, PATH: `${root}/bin:${process.env.PATH}`}, timeout: 30_000})
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-command-'))
    for (const dir of ['.data', 'values', 'withdrawal-processor', 'bin']) fs.mkdirSync(path.join(root, dir))
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), 'network="testnet"\n[cubesigner]\nmode="transport_only"\n')
    fs.writeFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), 'fee_rate_sat_per_kvb=1000000\n')
    fs.writeFileSync(path.join(root, 'config.toml'), '[accounts]\nOWNER_ADDR="0x1111111111111111111111111111111111111111"\n')
    fs.writeFileSync(path.join(root, '.data/setup_defaults.toml'), 'sequencer_target_amount=42069000\n')
    fs.writeFileSync(path.join(root, '.data/genesis.json'), '{"gasLimit":"0x989680"}')
    fs.writeFileSync(path.join(root, 'values/eth-da-submitter-production.yaml'), 'configMaps: {}\n')
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  for (const source of ['config', 'saved-intent', 'contract', 'explicit']) it(`requires proof validation for ${source} even when the contract is missing or invalid`, () => {
    if (source === 'config') fs.appendFileSync(path.join(root, '.data/doge-config.toml'), '[proof_topology]\nmode="active"\n')
    if (source === 'saved-intent') {
      fs.mkdirSync(path.join(root, '.scrollsdk'))
      fs.writeFileSync(path.join(root, '.scrollsdk/intent.json'), JSON.stringify({proofTopology: {mode: 'active'}}))
    }

    if (source === 'contract') fs.writeFileSync(path.join(root, '.data/proof-deployment.json'), '{}')
    const result = run(['setup', 'deployment-preflight', '--json', ...(source === 'explicit' ? ['--proof'] : [])])
    expect(result.status).equal(1)
    expect(JSON.parse(result.stdout).error.context.runtimeChecks).include({proof: 'failed', proofLive: 'not-checked'})
  })

  it('requires explicit context and activation scope for post-rollout proof checks', () => {
    expect(run(['setup', 'deployment-preflight', '--proof-live']).status).not.equal(0)
    const result = run(['setup', 'deployment-preflight', '--proof-live', '--kube-context', 'selected', '--proof-scope', 'preparation', '--json'])
    expect(result.status).equal(1)
    expect(result.stdout).include('--proof-live requires activation scope')
  })

  it('checks the current configuration without changing files or requiring a release selector', () => {
    const file = path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
    const before = fs.readFileSync(file, 'utf8')
    const result = run(['setup', 'deployment-preflight', '--json'])
    expect(result.status, result.stderr).to.equal(0)
    expect(JSON.parse(result.stdout).data.dstackRuntime).to.equal('not-checked')
    expect(fs.readFileSync(file, 'utf8')).to.equal(before)
  })

  it('does not require an installed dstack Deployment for pre-install cluster checks', () => {
    fs.appendFileSync(path.join(root, '.data/doge-config.toml'), '[dstackController]\nenabled=true\n')
    fs.writeFileSync(path.join(root, 'values/dstack-controller-production.yaml'), 'replicaCount: 1\n')
    fs.writeFileSync(path.join(root, 'bin/kubectl'), `#!${process.execPath}\nrequire('node:fs').writeFileSync('unexpected-kube', 'called');process.exit(1);`, {mode: 0o700})
    const result = run(['setup', 'deployment-preflight', '--kube-context', 'selected', '--json'])
    expect(result.status, result.stdout + result.stderr).equal(0)
    expect(JSON.parse(result.stdout).data.dstackRuntime).equal('not-checked')
    expect(fs.existsSync(path.join(root, 'unexpected-kube'))).false
  })

  for (const flag of ['--alb', '--nlb', '--artifact-access', '--alb-require-services', '--nlb-require-targets']) it(`rejects retired AWS audit flag ${flag}`, () => {
    const result = run(['setup', 'deployment-preflight', flag])
    expect(result.status).not.equal(0)
    expect(result.stderr).include('Nonexistent flag')
  })

  it('reports missing dstack and passes the exact selected context to a read-only runtime check', () => {
    const args = ['setup', 'deployment-preflight', '--json', '--require-dstack']
    const missing = run(args)
    expect(missing.status).to.equal(1)
    expect(JSON.parse(missing.stdout).error.message).to.include('dstack')
    fs.appendFileSync(path.join(root, '.data/doge-config.toml'), '[dstackController]\nenabled=true\n')
    fs.writeFileSync(path.join(root, 'values/dstack-controller-production.yaml'), 'replicaCount: 1\n')
    fs.writeFileSync(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml'), 'fee_rate_sat_per_kvb=1000000\n')
    const runtime = {metadata: {generation: 2}, spec: {replicas: 1}, status: {availableReplicas: 1, observedGeneration: 2, updatedReplicas: 1}}
    fs.writeFileSync(path.join(root, 'bin/kubectl'), `#!${process.execPath}\nrequire('node:fs').writeFileSync('kubectl-args.json',JSON.stringify(process.argv.slice(2)));process.stdout.write(${JSON.stringify(JSON.stringify(runtime))});\n`, {mode: 0o700})
    const checked = run([...args, '--kube-context', 'explicit-devnet', '--namespace', 'proofs'])
    expect(checked.status, checked.stderr).to.equal(0)
    expect(JSON.parse(checked.stdout).data.dstackRuntime).to.equal('available')
    expect(JSON.parse(fs.readFileSync(path.join(root, 'kubectl-args.json'), 'utf8'))).to.deep.equal(['--context', 'explicit-devnet', '-n', 'proofs', 'get', 'deployment', 'dstack-controller', '-o', 'json'])
  })

})
