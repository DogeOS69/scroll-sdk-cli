import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'
import type {ProofProgramPublicationV1} from '../../src/types/proof-program-publication.js'
import type {ProofWorkerImageCheckV1} from '../../src/types/proof-worker-image-check.js'
import type {ProverWorkerContractV1} from '../../src/utils/proof-topology-compiler.js'

import {digest, writeJson} from '../../src/utils/preparation-io.js'
import {rentalEnvelope, resolveProofWorkers} from '../../src/utils/proof-workers-config.js'
import {operateWorkerCapacity, retireCapacitySession, watchdogManifest} from '../../src/utils/proof-workers-lifecycle.js'
import {capacityPlan, workerControllerLocation, workerLaunch} from '../../src/utils/proof-workers-plan.js'
import {mintWorkerCredential} from '../../src/utils/prover-worker-credential.js'

export function fixturePlan() {
  const image = {digest: `sha256:${'a'.repeat(64)}`, repository: 'example.invalid/worker'}
  const spec = {metadata: {name: 'test-deployment'}, preparation: {dstack: {project: 'test'}}, proofWorkers: {}} as DeploymentSpec
  const paths = ['batch/openvm.toml', 'batch/app.vmexe', 'bridge/openvm.toml', 'bridge/bridge-state.vmexe', 'bridge/bridge-artifact-manifest.json', 'chunk/openvm.toml', 'chunk/app.vmexe', 'bridge/batch-aggregation-openvm.toml', 'bridge/batch-aggregation.vmexe', 'bridge/l2-range-aggregation-topology-program.json', 'protocol_context.json']
  const publication = {files: Object.fromEntries(paths.map(p => [p, {sha256: 'b'.repeat(64), url: `https://artifacts.example.invalid/${p}`} ])), verification: {anonymousHttpReadback: 'passed', authenticatedS3Readback: 'passed'}} as ProofProgramPublicationV1
  const worker = {argv: ['--worker-id', 'original', '--worker-token-file', '/secret', '--drain-timeout-ms', '720000', '--chunk-app-exe', '/old/chunk', '--enable-prove-scroll-chunk'], image, required_build_class: 'production'} as ProverWorkerContractV1
  const imageCheck = {cudaArchitectures: ['86'], image} as ProofWorkerImageCheckV1
  const target = {authKey: 'token', authSecret: 'dstack-auth', context: 'test-context', deployment: 'dstack-controller', image: `example.invalid/controller@sha256:${'c'.repeat(64)}`, namespace: 'test', port: 3000}
  const input = {generationId: 'd'.repeat(64), imageCheck, publication, session: 'initial', spec, target, worker}
  return {input, plan: capacityPlan(input)}
}

// Nonfunctional placeholder; only minted per-worker credentials leave apply.
const MASTER = 'disposable-test-only-master-000000000000'
const readMaster = () => MASTER

describe('bounded proof-worker capacity', () => {
  let root: string
  beforeEach(() => {root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-workers-'))})
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  function save() {
    const {plan} = fixturePlan()
    const file = path.join(root, '.scrollsdk/proof-workers/plan.json')
    writeJson(file, plan)
    fs.writeFileSync(path.join(path.dirname(file), 'plan.sha256'), digest(fs.readFileSync(file)))
    return plan
  }

  it('freezes the current context without requiring automatic Secret upload and uses the controller namespace', () => {
    const {input} = fixturePlan()
    expect(workerControllerLocation(input.spec, undefined, () => 'current-context')).to.deep.equal({context: 'current-context', namespace: 'default'})
    input.spec.infrastructure = {...input.spec.infrastructure, namespace: 'chain'}
    input.spec.dstackController = {monitoring: {namespace: 'chain'}}
    input.spec.preparation!.secretUpload = {kubeContext: 'upload-context', namespace: 'chain', provider: 'aws'}
    expect(workerControllerLocation(input.spec, undefined, () => {throw new Error('must not query')})).to.deep.equal({context: 'upload-context', namespace: 'chain'})
    expect(workerControllerLocation(input.spec, 'override', () => '')).to.deep.equal({context: 'override', namespace: 'chain'})
  })
  it('reserves startup, drain, idle and cleanup polling within the budget', () => {
    expect(rentalEnvelope(resolveProofWorkers({}))).to.equal(2.27)
    expect(() => resolveProofWorkers({rentalBudgetUsd: 2})).to.throw('rental envelope')
    expect(() => resolveProofWorkers({maxDurationHours: 8})).to.throw('rental envelope')
    expect(rentalEnvelope(resolveProofWorkers({maxDurationHours: 8, rentalBudgetUsd: 8}))).to.equal(7.07)
    expect(() => resolveProofWorkers({maxDurationHours: 48})).to.throw('rental envelope')
    expect(rentalEnvelope(resolveProofWorkers({maxDurationHours: 48, rentalBudgetUsd: 40}))).to.equal(39.07)
    for (const bad of [{idleTimeoutMinutes: 0}, {count: 0}, {memoryGb: 8}, {minReliability: 0.5}, {rentalBudgetUsd: Number.NaN}]) expect(() => resolveProofWorkers(bad)).to.throw()
  })
  const awsConfig = {backend: 'aws', cpu: 16, gpu: 'L4', maxPricePerHourUsd: 1.5, regions: ['us-east-1'], rentalBudgetUsd: 5} as const
  const aws = () => ({...awsConfig, regions: [...awsConfig.regions]})
  it('requires explicit AWS placement and budgets instead of inheriting Vast defaults', () => {
    for (const field of ['cpu', 'gpu', 'regions', 'maxPricePerHourUsd', 'rentalBudgetUsd'] as const) {
      const config = aws()
      delete (config as Partial<typeof config>)[field]
      expect(() => resolveProofWorkers(config)).to.throw('AWS proofWorkers requires')
    }

    expect(() => resolveProofWorkers({...aws(), cpu: 8})).to.throw('cpu >= 16')
    expect(() => resolveProofWorkers({...aws(), regions: ['us-texas']})).to.throw('AWS region')
    expect(() => resolveProofWorkers({...aws(), rentalBudgetUsd: 3})).to.throw('rental envelope')
    expect(rentalEnvelope(resolveProofWorkers(aws()))).to.equal(4.25)
  })
  it('selects only AWS L4 on-demand capacity with CUDA 89 and distinct worker names', () => {
    const {input, plan: vast} = fixturePlan()
    input.spec.proofWorkers = aws()
    expect(() => capacityPlan(input)).to.throw('incompatible')
    input.imageCheck.cudaArchitectures.push('89')
    const plan = capacityPlan(input)
    const {fleet, name, task} = plan.workers[0]
    for (const config of [fleet, task]) {
      expect(config.backends).to.deep.equal(['aws'])
      expect(config.regions).to.deep.equal(['us-east-1'])
      expect(config.instance_types).to.deep.equal(['g6.4xlarge'])
      expect(config.spot_policy).to.equal('on-demand')
      expect(config.max_price).to.equal(1.5)
      expect(config.resources).to.deep.equal({cpu: 'x86:16..', disk: '200GB..', gpu: {count: 1, memory: '22GB..', name: 'L4'}, memory: '64GB..'})
      expect(config).not.to.have.property('backend_options')
    }

    expect(name).to.match(/^sdk-aws-/)
    expect((task.commands as string[])[0]).to.contain("= '89'").and.contain(`--worker-id' 'test-deployment-initial-aws-`)
    expect(plan.id).not.to.equal(vast.id)
    expect(vast.workers[0].name).to.match(/^sdk-[\da-f]{16}-0$/)
    expect(vast.workers[0].fleet.backend_options).to.deep.equal([{min_reliability: 0.95, offer_order: 'price', type: 'vastai'}])
    expect(vast.workers[0].task.backends).to.deep.equal(['vastai'])
  })
  it('pins the serialized Vast plan including its artifact environment', () => {
    // Captured from PR #78 at a9af2807, including its plan ID and worker names;
    // re-pinned for per-worker credentials (Core #1591), then artifact env.
    // The plan ID seed is unchanged.
    expect(digest(JSON.stringify(fixturePlan().plan))).to.equal('e44c7b4c961989639a8efae02e00b4c88b7eb3b51178a918c256cf64bdf54821')
  })
  it('carries operator durations into the task and watchdog without a CLI policy cap', () => {
    for (const [hours, seconds, envelope] of [[0.1, 360, 0.75], [48, 172_800, 39.07], [49, 176_400, 39.87], [168, 604_800, 135.07], [720, 2_592_000, 576.67]]) {
      const {input} = fixturePlan()
      input.spec.proofWorkers = {maxDurationHours: hours, rentalBudgetUsd: 1000}
      const plan = capacityPlan(input)
      expect(plan.config.maxDurationHours).to.equal(hours)
      expect(plan.workers[0].task.max_duration).to.equal(seconds)
      expect(plan.wallTimeoutSeconds).to.equal(seconds + 3000)
      expect(plan.rentalEnvelopeUsd).to.equal(envelope)
      expect(JSON.stringify(watchdogManifest(plan, 1000))).to.contain(String(seconds + 3000))
    }
  })
  it('rejects invalid durations instead of producing a zero or non-finite task timeout', () => {
    for (const maxDurationHours of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE, 1 / 7200]) {
      expect(() => resolveProofWorkers({maxDurationHours})).to.throw('positive finite duration')
    }
  })
  it('uses unique worker identities, an exact GPU and zero minimum fleet size', () => {
    const {input} = fixturePlan()
    input.spec.proofWorkers = {count: 2, rentalBudgetUsd: 6}
    const plan = capacityPlan(input)
    expect(new Set(plan.workers.map(w => w.name)).size).to.equal(2)
    for (const worker of plan.workers) {
      expect(worker.fleet.nodes).to.equal('0..1')
      expect(worker.task.retry).to.equal(false)
      expect(worker.task.max_duration).to.equal(7200)
      expect(worker.task.stop_duration).to.equal(780)
      expect((worker.task.commands as string[])[0]).to.contain('--enable-prove-scroll-chunk')
      expect(JSON.stringify(worker)).not.to.contain(MASTER)
      expect((worker.task.commands as string[])[0]).to.contain(`'--worker-id' '${worker.workerId}'`)
      expect((worker.task.env as Record<string, string>).DOGEOS_PROVER_WORKER_TOKEN).to.equal(`\${{ secrets.${worker.secretName} }}`)
    }

    expect(new Set(plan.workers.map(w => w.workerId)).size).to.equal(2)
    expect(new Set(plan.workers.map(w => w.secretName)).size).to.equal(2)

    expect(capacityPlan(input).id).to.equal(plan.id)
    expect(capacityPlan({...input, session: 'next'}).id).not.to.equal(plan.id)
  })
  it('rejects incompatible CUDA image/GPU and credential-bearing artifact URLs', () => {
    const {input} = fixturePlan()
    input.spec.proofWorkers = {gpu: 'RTX4090'}
    expect(() => capacityPlan(input)).to.throw('incompatible')
    input.spec.proofWorkers = {}
    input.publication.files['protocol_context.json'].url += '?token=example'
    expect(() => workerLaunch(input.worker, input.publication, 'worker', '86')).to.throw('without credentials')
  })
  it('pairs every artifact with stable Core-compatible variables on both direct workers', () => {
    const {input} = fixturePlan()
    for (const name of ['extra/a-b.json', 'extra/a_b.json', 'extra/A-b.json']) input.publication.files[name] = {...input.publication.files['chunk/app.vmexe']}
    const launch = workerLaunch(input.worker, input.publication, 'worker', '86')
    expect(launch.env.DOGEOS_CHUNK_VMEXE_URL).to.equal(input.publication.files['chunk/app.vmexe'].url)
    expect(launch.env.DOGEOS_BRIDGE_MANIFEST_SHA256).to.equal('b'.repeat(64))
    expect(Object.keys(launch.env)).to.have.length(Object.keys(input.publication.files).length * 2)
    for (const [name, value] of Object.entries(launch.env)) {
      expect(name).to.match(/^[A-Z_][\dA-Z_]*$/)
      expect(launch.command).to.include(`"$${name}"`).and.not.to.include(value)
    }

    const reordered = {...input.publication, files: Object.fromEntries(Object.entries(input.publication.files).reverse())}
    expect(workerLaunch(input.worker, reordered, 'worker', '86')).to.deep.equal(launch)
    input.spec.proofWorkers = {count: 2, rentalBudgetUsd: 5}
    for (const {task} of capacityPlan(input).workers) expect(task.env).to.include(launch.env)
  })
  it('retains publication path, HTTPS, credential and digest validation', () => {
    const {input} = fixturePlan()
    for (const name of ['../escape', '/absolute', 'extra/../../escape', 'bad;path']) {
      const publication = structuredClone(input.publication)
      publication.files[name] = {...publication.files['chunk/app.vmexe']}
      expect(() => workerLaunch(input.worker, publication, 'worker', '86')).to.throw('Unsafe publication path')
    }

    for (const url of ['http://artifacts.example.invalid/file', 'https://user:FAKE@artifacts.example.invalid/file', 'https://artifacts.example.invalid/file?token=FAKE', 'https://artifacts.example.invalid/file#fragment']) {
      const publication = structuredClone(input.publication)
      publication.files['chunk/app.vmexe'].url = url
      expect(() => workerLaunch(input.worker, publication, 'worker', '86')).to.throw('without credentials')
    }

    input.publication.files['chunk/app.vmexe'].sha256 = 'not-a-sha256'
    expect(() => workerLaunch(input.worker, input.publication, 'worker', '86')).to.throw('SHA-256')
    delete input.publication.files['chunk/app.vmexe']
    expect(() => workerLaunch(input.worker, input.publication, 'worker', '86')).to.throw('resource missing')
  })
  it('executes quoted artifact env as data and aborts on missing env, download or hash failure', () => {
    const {input} = fixturePlan()
    const payload = 'disposable artifact bytes\n'
    const unusualUrl = "https://artifacts.example.invalid/$(touch INJECTED);'double\"`touch INJECTED`"
    for (const entry of Object.values(input.publication.files)) Object.assign(entry, {sha256: digest(payload)})
    input.publication.files['batch/app.vmexe'].url = unusualUrl
    const launch = workerLaunch(input.worker, input.publication, 'worker', '86')
    const script = (name: string, content: string) => fs.writeFileSync(path.join(root, name), `#!${process.execPath}\n${content}`, {mode: 0o755})
    script('nvidia-smi', "process.stdout.write('8.6\\n')")
    script('curl', `const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOWNLOAD_LOG, JSON.stringify(args) + '\\n');
if (process.env.FAIL_DOWNLOAD) process.exit(22);
fs.writeFileSync(args[args.indexOf('-o') + 1], process.env.ARTIFACT_BYTES);`)
    script('prover-worker', `const fs = require('node:fs'); const args = process.argv.slice(2);
fs.writeFileSync(process.env.WORKER_LOG, JSON.stringify({args, token: fs.readFileSync(args[args.indexOf('--worker-token-file') + 1], 'utf8'), tokenEnv: process.env.DOGEOS_PROVER_WORKER_TOKEN}));`)
    const command = launch.command.replaceAll('/dogeos/artifacts', `${root}/artifacts`).replaceAll('/tmp/scrollsdk-worker.token', `${root}/token`).replaceAll('/usr/local/bin/prover-worker', `${root}/prover-worker`)
    const log = path.join(root, 'downloads.jsonl')
    const workerLog = path.join(root, 'worker.json')
    const env = {...process.env, ...launch.env, ARTIFACT_BYTES: payload, DOGEOS_PROVER_WORKER_TOKEN: 'disposable-worker-token', DOWNLOAD_LOG: log, PATH: `${root}:${process.env.PATH}`, WORKER_LOG: workerLog}
    const run = (overrides: Record<string, string | undefined> = {}) => spawnSync('sh', ['-c', command], {cwd: root, encoding: 'utf8', env: {...env, ...overrides}})
    const result = run()
    expect(result.status, result.stderr).to.equal(0)
    const downloads = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(downloads).to.have.length(11)
    expect(downloads[0]).to.include(unusualUrl)
    for (const args of downloads) {
      for (const [flag, value] of [['--connect-timeout', '10'], ['--max-time', '600'], ['--speed-time', '30'], ['--proto', '=https'], ['--proto-redir', '=https']]) expect(args[args.indexOf(flag) + 1]).to.equal(value)
    }

    const started = JSON.parse(fs.readFileSync(workerLog, 'utf8'))
    expect(started.token).to.equal('disposable-worker-token')
    expect(started).not.to.have.property('tokenEnv')
    expect(fs.statSync(path.join(root, 'token')).mode.toString(8).slice(-3)).to.equal('600')
    expect(fs.existsSync(path.join(root, 'INJECTED'))).to.equal(false)
    for (const overrides of [{DOGEOS_BATCH_VMEXE_URL: undefined}, {ARTIFACT_BYTES: 'corrupt'}, {FAIL_DOWNLOAD: '1'}]) {
      fs.rmSync(workerLog, {force: true})
      fs.writeFileSync(log, '')
      const failure = run(overrides)
      expect(failure.status).not.to.equal(0)
      expect(fs.existsSync(workerLog)).to.equal(false)
      expect(fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length).to.be.lessThan(2)
    }
  })
  it('installs and waits for an independent watchdog before sending per-worker credentials', () => {
    const plan = save()
    const calls: Array<{args: string[]; input?: string}> = []
    const run = (args: string[], input?: string) => {calls.push({args, input}); return JSON.stringify({workers: [{fleet: 'active', run: 'running'}]})}
    operateWorkerCapacity(root, 'apply', run, 1000, readMaster)
    expect(calls[0].args).to.include('apply')
    expect(calls[1].args).to.include('wait')
    expect(calls[2].args).to.include('--for=condition=Ready')
    expect(calls[3].args).to.include('exec')
    expect(calls[0].input).not.to.contain(MASTER)
    expect(calls[3].input).not.to.contain(MASTER)
    expect(JSON.parse(calls[3].input!).credentials).to.deep.equal(Object.fromEntries(plan.workers.map(w => [w.secretName, mintWorkerCredential(MASTER, w.workerId)])))
    const first = JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/proof-workers/state.json'), 'utf8'))
    operateWorkerCapacity(root, 'apply', run, 1100, readMaster)
    const second = JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/proof-workers/state.json'), 'utf8'))
    expect(second.startedAt).to.equal(first.startedAt)
    expect(JSON.stringify(watchdogManifest(plan, first.startedAt))).to.contain('SCROLLSDK_GUARD_PAYLOAD')
    expect(() => operateWorkerCapacity(root, 'apply', run, 3000, readMaster)).to.throw('expired')
  })
  it('refuses apply without a master before touching the cluster', () => {
    save()
    expect(() => operateWorkerCapacity(root, 'apply', () => {throw new Error('should not run')}, 1000)).to.throw('master')
    expect(fs.existsSync(path.join(root, '.scrollsdk/proof-workers/state.json'))).to.equal(false)
  })
  it('never allocates if watchdog readiness fails and leaves the original deadline recoverable', () => {
    save()
    let calls = 0
    expect(() => operateWorkerCapacity(root, 'apply', () => {calls++; if (calls === 2) throw new Error('not ready'); return ''}, 1000, readMaster)).to.throw('not ready')
    expect(calls).to.equal(2)
    expect(JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/proof-workers/state.json'), 'utf8')).startedAt).to.equal(1000)
  })
  it('status sends only read operation and never creates a state file', () => {
    save()
    operateWorkerCapacity(root, 'status', (_args, input) => {if (!input) return ''; expect(JSON.parse(input!).action).to.equal('status'); expect(input).not.to.contain(MASTER); return '{"workers":[]}'})
    expect(fs.existsSync(path.join(root, '.scrollsdk/proof-workers/state.json'))).to.equal(false)
  })
  it('keeps cleanup pending until the fleet is actually terminated and never reapplies it', () => {
    save()
    const result = operateWorkerCapacity(root, 'destroy', () => '{"workers":[{"run":"terminating","fleet":"terminating"}]}') as {status: string}
    expect(result.status).to.equal('cleanup-requested')
    expect(() => operateWorkerCapacity(root, 'apply', () => '')).to.throw('retired')
    expect(() => retireCapacitySession(root)).to.throw('confirm')
    operateWorkerCapacity(root, 'destroy', () => '{"workers":[{"run":"terminated","fleet":"terminated"}]}')
    retireCapacitySession(root)
    expect(fs.existsSync(path.join(root, '.scrollsdk/proof-workers'))).to.equal(false)
  })
  it('drains without reapplying or changing the existing watchdog deadline', () => {
    const plan = save()
    writeJson(path.join(root, '.scrollsdk/proof-workers/state.json'), {planId: plan.id, startedAt: 1000, status: 'submitted'})
    const result = operateWorkerCapacity(root, 'drain', (_args, input) => {
      expect(JSON.parse(input!).action).to.equal('drain')
      return '{"workers":[{"run":"running","fleet":"active"}]}'
    }, 2000) as {status: string}
    expect(result.status).to.equal('cleanup-requested')
    expect(JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/proof-workers/state.json'), 'utf8')).startedAt).to.equal(1000)
    expect(() => operateWorkerCapacity(root, 'apply', () => '')).to.throw('retired')
    operateWorkerCapacity(root, 'drain', () => '{"workers":[{"run":"done","fleet":"terminated"}]}')
    expect(JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/proof-workers/state.json'), 'utf8')).status).to.equal('destroyed')
  })
  it('refuses tampered reviewed plans before all operations', () => {
    save()
    fs.appendFileSync(path.join(root, '.scrollsdk/proof-workers/plan.json'), ' ')
    for (const action of ['apply', 'status', 'destroy', 'drain'] as const) expect(() => operateWorkerCapacity(root, action, () => {throw new Error('should not run')})).to.throw('checksum')
  })
})
