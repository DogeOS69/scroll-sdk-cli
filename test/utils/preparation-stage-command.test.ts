import {expect} from 'chai'
import sinon from 'sinon'

import type {PreparationState} from '../../src/utils/preparation-plan.js'

import {CliExitError, JsonOutputContext} from '../../src/utils/json-output.js'
import {reportPreparationStage} from '../../src/utils/preparation-stage-command.js'

describe('preparation stage command reporting', () => {
  let exitCode: typeof process.exitCode
  beforeEach(() => {exitCode = process.exitCode})
  afterEach(() => {sinon.restore(); process.exitCode = exitCode})

  for (const status of ['failed', 'recovery-required'] as const) {
    it(`reports ${status} as one JSON error while preserving the recovery checkpoint`, () => {
      const log = sinon.stub(console, 'log')
      const output = new JsonOutputContext('setup aws', true)
      const state: PreparationState = {currentStep: 'blockscout-db', files: {}, nextStage: 'aws', planId: 'test-plan', status, steps: {'blockscout-db': status, identities: 'completed'}, waiting: {message: 'Database preparation requires operator input'}}
      expect(() => reportPreparationStage(output, 'aws', 'deployment', state)).to.throw(CliExitError)
      expect(log.callCount).to.equal(1)
      const response = JSON.parse(log.firstCall.args[0])
      expect(response.success).to.equal(false)
      expect(response.error.context).to.include({currentStep: 'blockscout-db', nextCommand: 'scrollsdk setup aws', status})
      expect(response.error.context.completed).to.deep.equal(['identities'])
      expect(response.error.recoverable).to.equal(status === 'failed')
    })
  }

  it('keeps a completed stage successful and points to its successor', () => {
    const log = sinon.stub(console, 'log')
    reportPreparationStage(new JsonOutputContext('setup genesis', true), 'genesis', 'deployment', {files: {}, nextStage: 'bridge-funding', planId: 'test-plan', status: 'stage-complete', steps: {'genesis-local': 'completed'}})
    const response = JSON.parse(log.firstCall.args[0])
    expect(response.success).to.equal(true)
    expect(response.data.nextCommand).to.equal('scrollsdk setup bridge-funding')
    expect(process.exitCode).to.equal(0)
  })

  it('does not announce preparation completion while awaiting external inputs', () => {
    const output = new JsonOutputContext('setup bridge-funding', false)
    const info = sinon.stub(output, 'info')
    sinon.stub(output, 'success')
    reportPreparationStage(output, 'bridge-funding', 'deployment', {files: {}, planId: 'test-plan', status: 'waiting', steps: {}, waiting: {message: 'Funding required'}})
    expect(info.args.flat().join('\n')).not.to.include('Preparation complete')
    expect(process.exitCode).to.equal(2)
  })

  it('carries explicit credential deferral from render to the separate session stage', () => {
    const log = sinon.stub(console, 'log')
    reportPreparationStage(new JsonOutputContext('setup render', true), 'render', 'deployment', {files: {}, nextStage: 'signer-session', planId: 'test-plan', status: 'stage-complete', steps: {'render-final': 'completed'}}, true, true)
    const report = JSON.parse(log.firstCall.args[0]).data
    expect(report.nextCommand).equal('scrollsdk setup signer-session --defer-cubesigner')
    expect(report.activation.status).equal('pending')
    expect(report.activation.nextCommand).include('--kube-context')
  })

  it('resumes deferred credentials without adding a policy approval prerequisite', () => {
    const log = sinon.stub(console, 'log')
    reportPreparationStage(new JsonOutputContext('setup upload-secrets', true), 'upload-secrets', 'deployment', {deferred: ['cubesigner-session', 'cubesigner-secret-upload'], files: {}, planId: 'test-plan', status: 'stage-complete', steps: {'secret-upload': 'completed'}}, true, true)
    const report = JSON.parse(log.firstCall.args[0]).data
    expect(report.nextCommand).equal('scrollsdk setup signer-session')
    expect(report.deferred).deep.equal(['cubesigner-session', 'cubesigner-secret-upload'])
    expect(report.activation.status).equal('pending')
  })
})
