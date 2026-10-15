import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'
import type {PreparationPlan} from '../../src/utils/preparation-plan.js'

import {POLICY_BUILD_RECEIPT_SCHEMA} from '../../src/utils/cubesigner-policy-build.js'
import {POLICY_COMPILER_INPUT, POLICY_OUTPUT, prepareCubesignerPolicy} from '../../src/utils/preparation-cubesigner-policy.js'
import {AwaitingInput, digest, writeJson} from '../../src/utils/preparation-io.js'
import {migratePolicyBuildStep, preparationSteps} from '../../src/utils/preparation-plan.js'
import {CommandPreparationRunner} from '../../src/utils/preparation-runner.js'

const image = `ghcr.io/dogeos69/cubesigner-policy-compiler@sha256:${'a'.repeat(64)}`
const revision = 'b'.repeat(40)
const component = Buffer.from([0, 97, 115, 109, 13, 0, 1, 0, 0, 1, 0])
const spec = {preparation: {bridge: {mode: 'helper'}, proofMaterials: {mode: 'existing'}}, proofTopology: {enforcement: 'observe'}, signing: {cubesigner: {}}} as DeploymentSpec

describe('staged CubeSigner policy preparation', () => {
  let root: string
  let calls: string[][]
  const command = async (args: string[]) => {
    calls.push(args)
    const dir = args[args.indexOf('--output') + 1]
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(path.join(dir, 'cubesigner_verifier_policy.wasm'), component)
    fs.writeFileSync(path.join(dir, 'cubesigner_verifier_policy.wasm.sha256'), `${digest(component)}  cubesigner_verifier_policy.wasm\n`)
    writeJson(path.join(dir, 'build-receipt.json'), {compilerImage: image, coreRevision: revision, schema: POLICY_BUILD_RECEIPT_SCHEMA, wasm: {path: 'cubesigner_verifier_policy.wasm', sha256: digest(component), sizeBytes: component.length}})
  }

  const select = () => writeJson(path.join(root, POLICY_COMPILER_INPUT), {compilerImage: image, expectedCoreRevision: revision})
  beforeEach(() => {root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-preparation-')); calls = []})
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('creates a usable input template and waits without invoking Docker or governance', async () => {
    let error: unknown
    try {await prepareCubesignerPolicy(root, command)} catch (error_) {error = error_}
    expect(error).instanceOf(AwaitingInput)
    expect((error as AwaitingInput).details.file).eq(path.join(root, POLICY_COMPILER_INPUT))
    expect(JSON.parse(fs.readFileSync(path.join(root, POLICY_COMPILER_INPUT), 'utf8'))).has.keys('compilerImage', 'expectedCoreRevision')
    expect(calls).empty
  })

  it('uses the existing build command and reconciles a completed export on retry', async () => {
    select()
    const runner = new CommandPreparationRunner(async (_root, _step, args) => command(args))
    await runner.run({effect: 'local', id: 'cubesigner-policy-build', retry: 'safe', stage: 'proof-materials', title: 'test'}, spec, root, {} as PreparationPlan)
    expect(calls[0]).deep.eq(['cubesigner-policy', 'build', '--compiler-image', image, '--expected-core-revision', revision, '--output', path.join(root, POLICY_OUTPUT)])
    await prepareCubesignerPolicy(root, command)
    expect(calls).length(1)
    const handoff = JSON.parse(fs.readFileSync(path.join(root, '.data/cubesigner-policy-governance-handoff.json'), 'utf8'))
    expect(handoff.status).eq('built-not-published-or-attached')
    expect(handoff.wasm.sha256).eq(digest(component))
  })

  it('rejects altered artifacts or a changed compiler pin without rebuilding', async () => {
    select(); await prepareCubesignerPolicy(root, command)
    writeJson(path.join(root, POLICY_COMPILER_INPUT), {compilerImage: image, expectedCoreRevision: 'c'.repeat(40)})
    try {await prepareCubesignerPolicy(root, command); expect.fail('must reject')} catch (error) {expect(String(error)).contains('does not match')}
    select()
    fs.appendFileSync(path.join(root, POLICY_OUTPUT, 'cubesigner_verifier_policy.wasm'), 'changed')
    try {await prepareCubesignerPolicy(root, command); expect.fail('must reject')} catch (error) {expect(String(error)).contains('does not match')}
    expect(calls).length(1)
  })

  it('refuses public Docker Hub, mutable tags and invalid commit selections before execution', async () => {
    for (const selection of [
      {compilerImage: `dogeos69/cubesigner-policy-compiler@sha256:${'a'.repeat(64)}`, expectedCoreRevision: revision},
      {compilerImage: 'ghcr.io/dogeos69/cubesigner-policy-compiler:latest', expectedCoreRevision: revision},
      {compilerImage: image, expectedCoreRevision: 'main'},
    ]) {
      writeJson(path.join(root, POLICY_COMPILER_INPUT), selection)
      try {await prepareCubesignerPolicy(root, command); expect.fail('must wait')} catch (error) {expect(error).instanceOf(AwaitingInput)}
    }

    expect(calls).empty
  })

  it('adds only the policy step when migrating a saved staged plan', () => {
    const steps = preparationSteps(spec, true)
    const old = steps.filter(step => step.id !== 'cubesigner-policy-build')
    const plan = {deploymentName: 'test', id: 'old', schema: 'scrollsdk/preparation/v2', sdkDirectory: root, specHash: 'unchanged', steps: old} as PreparationPlan
    const migrated = migratePolicyBuildStep(plan, spec)
    expect(migrated.steps).deep.eq(steps)
    expect(migrated.specHash).eq(plan.specHash)
    expect(plan.steps).deep.eq(old)
    expect(migratePolicyBuildStep(migrated, spec)).eq(migrated)
    const unknown = {...plan, steps: old.slice(1)}
    expect(migratePolicyBuildStep(unknown, spec)).eq(unknown)
    expect(steps.find(step => step.id === 'cubesigner-policy-build')?.stage).eq('proof-materials')
  })

  it('leaves legacy workflows, non-CubeSigner and transport-only deployments unchanged', () => {
    expect(preparationSteps(spec).some(step => step.id === 'cubesigner-policy-build')).false
    for (const signing of [{}, {cubesigner: {mode: 'transport_only' as const}}]) {
      expect(preparationSteps({...spec, signing}, true).some(step => step.id === 'cubesigner-policy-build')).false
    }
  })
})
