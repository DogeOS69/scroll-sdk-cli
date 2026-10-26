import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {capacitySpec} from '../../src/utils/capacity-manager.js'
import {inspectCapacityManager} from '../../src/utils/capacity-manager-diagnostics.js'
import {writeJson} from '../../src/utils/preparation-io.js'

const options = {kubeContext: 'selected-context', namespace: 'chain', status: true}

describe('Capacity Manager runtime diagnostics', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-diagnostics-'))
    writeJson(path.join(root, '.scrollsdk/capacity-manager/plan.json'), {dstack: {namespace: 'chain'}, namespace: 'chain', schema: 'scrollsdk/capacity-manager/v1', valuesFile: 'values/capacity-manager-production.yaml'})
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('reads status only in the explicit context/namespace and never exposes logs or implies proof acceptance', () => {
    const calls: string[][] = []
    const result = inspectCapacityManager(root, options, args => {
      calls.push(args)
      return args.includes('get') ? JSON.stringify({spec: {replicas: 1}, status: {readyReplicas: 1}}) : 'capacity-manager reconcile decision NONFUNCTIONAL_PRIVATE_MARKER\ncapacity-manager reconcile decision\n'
    })
    expect(result).deep.equal({status: {controlLoop: 'recent-decisions-observed', decisionSamples: 2, errorSamples: 0, gpuAllocation: 'not-verified', present: true, proofAcceptance: 'not-verified', readyReplicas: 1, replicas: 1, windowSeconds: 60}})
    expect(calls.map(args => args.slice(0, 5))).deep.equal([['--context', 'selected-context', '--namespace', 'chain', 'get'], ['--context', 'selected-context', '--namespace', 'chain', 'logs']])
    expect(JSON.stringify(result)).not.include('NONFUNCTIONAL_PRIVATE_MARKER')
  })

  it('reports an absent deployment without logs and rejects a different namespace before cluster access', () => {
    let calls = 0
    const exec = () => {calls++; return ''}
    expect(inspectCapacityManager(root, options, exec).status).include({present: false, proofAcceptance: 'not-verified'})
    expect(calls).equal(1)
    expect(() => inspectCapacityManager(root, {...options, namespace: 'wrong'}, exec)).throw('Namespace differs')
    expect(calls).equal(1)
  })

  it('rejects a different recorded Kubernetes context before any cluster access', () => {
    const file = path.join(root, '.scrollsdk/capacity-manager/plan.json')
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'))
    writeJson(file, {...plan, kubeContext: 'prepared-context'})
    let calls = 0
    expect(() => inspectCapacityManager(root, options, () => {calls++; return ''})).throw('Kubernetes context differs')
    expect(calls).equal(0)
  })

  for (const source of ['plan', 'values', 'status', 'provider', 'intent']) it(`redacts malformed ${source} diagnostics`, () => {
    const invalid = '{"password": NONFUNCTIONAL_PRIVATE_MARKER}'
    if (source === 'plan') fs.writeFileSync(path.join(root, '.scrollsdk/capacity-manager/plan.json'), invalid)
    if (source === 'values') {
      fs.mkdirSync(path.join(root, 'values'))
      fs.writeFileSync(path.join(root, 'values/capacity-manager-production.yaml'), 'manager: [\npassword: NONFUNCTIONAL_PRIVATE_MARKER\n')
    }

    if (source === 'intent') fs.writeFileSync(path.join(root, '.scrollsdk/intent.json'), invalid)
    const action = () => source === 'intent' ? capacitySpec(root) : inspectCapacityManager(root, {...options, probe: source === 'values', status: source !== 'values'}, () => {
      if (source === 'provider') throw new Error(invalid)
      return invalid
    })
    expect(action).throw('omitted')
    try {action()} catch (error) {expect((error as Error).message).not.include('NONFUNCTIONAL_PRIVATE_MARKER')}
  })
})
