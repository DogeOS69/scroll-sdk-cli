/* eslint-disable @typescript-eslint/no-explicit-any -- Kubernetes fixtures. */
import {expect} from 'chai'

import {capacityPreflight, capacityReconcileEvidence} from '../../src/utils/capacity-manager-preflight.js'

const ref = {existingSecret: 'nonfunctional-secret', key: 'nonfunctional-key'}
const values = {dstackAuth: ref, manager: {dstack: {serverUrl: 'https://controller.example.invalid'}, proofWorkBaseUrl: 'http://wp:9300'}, workerCredentialMaster: ref, wpAuth: ref}
const plan = {dstack: {deployment: 'controller'}, namespace: 'chain', privateDns: true, project: 'example', provider: 'vastai'}

describe('capacity-manager activation preflight', () => {
  it('uses the manager source selectors and Secret refs; removes only its probe', () => {
    const calls: string[][] = []
    let pod: any
    const result = capacityPreflight({...plan, fallbackProvider: 'vastai'}, {...values, image: {digest: `sha256:${'a'.repeat(64)}`, repository: 'example.invalid/manager'}, manager: {...values.manager, dstack: {...values.manager.dstack, fallbackFleet: 'vast-fallback'}}}, (args, input) => {
      calls.push(args)
      if (args[0] === 'get') return JSON.stringify({metadata: {uid: '00000000-0000-0000-0000-000000000000'}, spec: {template: {spec: {containers: [{image: 'example.invalid/controller:nonfunctional', name: 'controller'}]}}}})
      if (args[0] === 'create') pod = JSON.parse(input!)
      if (args[0] === 'logs') return JSON.stringify({dns: 'passed', dstackTlsAuthProjectBackend: 'passed', privateDns: true, secretReferences: 'passed', wpCapacityApi: 'passed'})
      return ''
    })
    expect(result.proofAcceptance).to.equal('not-tested')
    expect(pod.spec.initContainers[0].args).deep.equal(['--dstack-fallback-fleet', 'vast-fallback', '--help'])
    expect(JSON.parse(pod.spec.containers[0].env.find((e: any) => e.name === 'PROBE_INPUT').value).fallbackProvider).equal('vastai')
    expect(pod.metadata.labels['app.kubernetes.io/name']).to.equal('capacity-manager')
    expect(pod.metadata.namespace).to.equal('chain')
    expect(pod.metadata.ownerReferences[0]).to.include({controller: true, name: 'controller', uid: '00000000-0000-0000-0000-000000000000'})
    expect(pod.spec.containers[0].readinessProbe.exec.command.at(-1)).to.equal('raise SystemExit(1)')
    expect(pod.spec.automountServiceAccountToken).to.equal(false)
    expect(pod.spec.activeDeadlineSeconds).to.equal(120)
    expect(pod.spec.containers[0].env.filter((e: any) => e.valueFrom)).to.have.length(3)
    expect(calls.at(-1)).to.include.members(['delete', pod.metadata.name])
    expect(calls.some(c => c.includes('secret') || c.includes('exec') || c.includes('apply'))).to.equal(false)
  })

  it('cleans up on probe failure and does not interpret malformed/private output as success', () => {
    for (const fail of ['wait', 'logs']) {
      const calls: string[][] = []
      expect(() => capacityPreflight(plan, values, args => {
        calls.push(args)
        if (args[0] === 'get') return JSON.stringify({metadata: {uid: '00000000-0000-0000-0000-000000000000'}, spec: {template: {spec: {containers: [{image: 'nonfunctional', name: 'controller'}]}}}})
        if (args[0] === 'wait' && fail === 'wait') throw new Error('probe failed')
        if (args[0] === 'logs') return 'FAKE_PRIVATE_BODY'
        return ''
      })).to.throw()
      expect(calls.at(-1)?.[0]).to.equal('delete')
    }
  })

  it('reports a bounded failure category without exposing response bodies', () => {
    expect(() => capacityPreflight(plan, values, args => {
      if (args[0] === 'get') return JSON.stringify({metadata: {uid: '00000000-0000-0000-0000-000000000000'}, spec: {template: {spec: {containers: [{image: 'nonfunctional', name: 'controller'}]}}}})
      if (args[0] === 'wait') throw new Error('wait failed')
      if (args[0] === 'logs') return JSON.stringify({check: 'wp-capacity-api', privateBody: 'FAKE_PRIVATE_BODY', status: 'failed'})
      return ''
    })).to.throw('failed at wp-capacity-api').and.not.to.have.property('message', 'FAKE_PRIVATE_BODY')
  })

  it('does not delete an existing Pod when create fails', () => {
    const calls: string[][] = []
    expect(() => capacityPreflight(plan, values, args => {
      calls.push(args)
      if (args[0] === 'get') return JSON.stringify({metadata: {uid: '00000000-0000-0000-0000-000000000000'}, spec: {template: {spec: {containers: [{image: 'nonfunctional', name: 'controller'}]}}}})
      throw new Error('create conflict')
    })).to.throw('create conflict')
    expect(calls.some(c => c[0] === 'delete')).to.equal(false)
  })

  it('separates Pod readiness, recent reconcile evidence, allocation and proof acceptance', () => {
    expect(capacityReconcileEvidence('')).to.include({controlLoop: 'not-established', gpuAllocation: 'not-verified', proofAcceptance: 'not-verified'})
    const successful = 'capacity-manager reconcile decision reconcile_errors=0\ncapacity-manager reconcile decision reconcile_errors=0'
    expect(capacityReconcileEvidence(successful).controlLoop).to.equal('recent-decisions-observed')
    expect(capacityReconcileEvidence(successful + '\ncapacity-manager failed to reconcile capacity FAKE_PRIVATE_DETAILS').controlLoop).to.equal('errors-observed')
    expect(JSON.stringify(capacityReconcileEvidence(successful + '\nFAKE_PRIVATE_DETAILS'))).not.to.include('FAKE_PRIVATE_DETAILS')
    expect(capacityReconcileEvidence(successful + '\nrollout_blocked=true').controlLoop).to.equal('errors-observed')
  })
})
