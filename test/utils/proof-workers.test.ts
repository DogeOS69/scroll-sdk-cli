import {expect} from 'chai'
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
import {capacityPlan, workerCommand, workerControllerLocation} from '../../src/utils/proof-workers-plan.js'

export function fixturePlan() {
  const image = {digest: `sha256:${'a'.repeat(64)}`, repository: 'example.invalid/worker'}
  const spec = {metadata: {name: 'test-deployment'}, preparation: {dstack: {project: 'test'}}, proofWorkers: {}} as DeploymentSpec
  const paths = ['batch/openvm.toml', 'batch/app.vmexe', 'bridge/openvm.toml', 'bridge/bridge-state.vmexe', 'chunk/openvm.toml', 'chunk/app.vmexe', 'bridge/batch-aggregation-openvm.toml', 'bridge/batch-aggregation.vmexe', 'bridge/l2-range-aggregation-topology-program.json', 'protocol_context.json']
  const publication = {files: Object.fromEntries(paths.map(p => [p, {sha256: 'b'.repeat(64), url: `https://artifacts.example.invalid/${p}`} ])), verification: {anonymousHttpReadback: 'passed', authenticatedS3Readback: 'passed'}} as ProofProgramPublicationV1
  const worker = {argv: ['--worker-id', 'original', '--worker-token-file', '/secret', '--drain-timeout-ms', '720000', '--chunk-app-exe', '/old/chunk', '--enable-prove-scroll-chunk'], image, required_build_class: 'production'} as ProverWorkerContractV1
  const imageCheck = {cudaArchitectures: ['86'], image} as ProofWorkerImageCheckV1
  const target = {authKey: 'token', authSecret: 'dstack-auth', context: 'test-context', deployment: 'dstack-controller', image: `example.invalid/controller@sha256:${'c'.repeat(64)}`, namespace: 'test', port: 3000}
  const input = {generationId: 'd'.repeat(64), imageCheck, publication, session: 'initial', spec, target, tokenFile: 'prover-worker/prover-worker.token', worker}
  return {input, plan: capacityPlan(input)}
}

describe('bounded proof-worker capacity', () => {
  let root: string
  beforeEach(() => {root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-workers-'))})
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  function save() {
    const {plan} = fixturePlan()
    const file = path.join(root, '.scrollsdk/proof-workers/plan.json')
    writeJson(file, plan)
    fs.writeFileSync(path.join(path.dirname(file), 'plan.sha256'), digest(fs.readFileSync(file)))
    fs.mkdirSync(path.join(root, 'prover-worker'))
    fs.writeFileSync(path.join(root, plan.tokenFile), 'disposable-test-only-token', {mode: 0o600})
    return plan
  }

  it('freezes the current context without requiring automatic Secret upload and uses the controller namespace', () => {
    const {input} = fixturePlan()
    expect(workerControllerLocation(input.spec, undefined, () => 'current-context')).to.deep.equal({context: 'current-context', namespace: 'dstack-system'})
    input.spec.dstackController = {monitoring: {namespace: 'gpu-control'}}
    input.spec.preparation!.secretUpload = {kubeContext: 'upload-context', namespace: 'chain', provider: 'aws'}
    expect(workerControllerLocation(input.spec, undefined, () => {throw new Error('must not query')})).to.deep.equal({context: 'upload-context', namespace: 'gpu-control'})
    expect(workerControllerLocation(input.spec, 'override', () => '')).to.deep.equal({context: 'override', namespace: 'gpu-control'})
  })
  it('reserves startup, drain, idle and cleanup polling within the budget', () => {
    expect(rentalEnvelope(resolveProofWorkers({}))).to.equal(2.27)
    expect(() => resolveProofWorkers({rentalBudgetUsd: 2})).to.throw('rental envelope')
    expect(() => resolveProofWorkers({maxDurationHours: 8})).to.throw('rental envelope')
    expect(rentalEnvelope(resolveProofWorkers({maxDurationHours: 8, rentalBudgetUsd: 8}))).to.equal(7.07)
    for (const bad of [{maxDurationHours: 9}, {idleTimeoutMinutes: 0}, {count: 0}, {memoryGb: 8}, {minReliability: 0.5}, {rentalBudgetUsd: Number.NaN}]) expect(() => resolveProofWorkers(bad)).to.throw()
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
      expect(JSON.stringify(worker)).not.to.contain('disposable-test-only-token')
    }

    expect(capacityPlan(input).id).to.equal(plan.id)
    expect(capacityPlan({...input, session: 'next'}).id).not.to.equal(plan.id)
  })
  it('rejects incompatible CUDA image/GPU and credential-bearing artifact URLs', () => {
    const {input} = fixturePlan()
    input.spec.proofWorkers = {gpu: 'RTX4090'}
    expect(() => capacityPlan(input)).to.throw('incompatible')
    input.spec.proofWorkers = {}
    input.publication.files['protocol_context.json'].url += '?token=example'
    expect(() => workerCommand(input.worker, input.publication, 'worker', '86')).to.throw('without credentials')
  })
  it('installs and waits for an independent watchdog before sending a private token', () => {
    const plan = save()
    const calls: Array<{args: string[]; input?: string}> = []
    const run = (args: string[], input?: string) => {calls.push({args, input}); return JSON.stringify({workers: [{fleet: 'active', run: 'running'}]})}
    operateWorkerCapacity(root, 'apply', run, 1000)
    expect(calls[0].args).to.include('apply')
    expect(calls[1].args).to.include('wait')
    expect(calls[2].args).to.include('--for=condition=Ready')
    expect(calls[3].args).to.include('exec')
    expect(calls[0].input).not.to.contain('disposable-test-only-token')
    expect(JSON.parse(calls[3].input!).token).to.equal('disposable-test-only-token')
    const first = JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/proof-workers/state.json'), 'utf8'))
    operateWorkerCapacity(root, 'apply', run, 1100)
    const second = JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/proof-workers/state.json'), 'utf8'))
    expect(second.startedAt).to.equal(first.startedAt)
    expect(JSON.stringify(watchdogManifest(plan, first.startedAt))).to.contain('SCROLLSDK_GUARD_PAYLOAD')
    expect(() => operateWorkerCapacity(root, 'apply', run, 3000)).to.throw('expired')
  })
  it('never allocates if watchdog readiness fails and leaves the original deadline recoverable', () => {
    save()
    let calls = 0
    expect(() => operateWorkerCapacity(root, 'apply', () => {calls++; if (calls === 2) throw new Error('not ready'); return ''}, 1000)).to.throw('not ready')
    expect(calls).to.equal(2)
    expect(JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/proof-workers/state.json'), 'utf8')).startedAt).to.equal(1000)
  })
  it('status sends only read operation and never creates a state file', () => {
    save()
    operateWorkerCapacity(root, 'status', (_args, input) => {if (!input) return ''; expect(JSON.parse(input!).action).to.equal('status'); expect(input).not.to.contain('disposable-test-only-token'); return '{"workers":[]}'})
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
  it('refuses tampered reviewed plans before all operations', () => {
    save()
    fs.appendFileSync(path.join(root, '.scrollsdk/proof-workers/plan.json'), ' ')
    for (const action of ['apply', 'status', 'destroy'] as const) expect(() => operateWorkerCapacity(root, action, () => {throw new Error('should not run')})).to.throw('checksum')
  })
})
