import {expect} from 'chai'

import {mintWorkerCredential, validateWorkerName, workerCredentialName} from '../../src/utils/prover-worker-credential.js'

// Nonfunctional placeholder. Expected MACs were computed independently with
// Python's hmac module over b"dogeos-prover-worker-v1\0" + name.
const MASTER = 'nonfunctional-test-master-0000000000000000'

describe('prover-worker-credential', () => {
  it('matches the core HMAC derivation', () => {
    expect(mintWorkerCredential(MASTER, 'gpu-1')).to.equal('gpu-1.fb66fe597417f7921963bb953411d21532a5a4f3634958ab1f8ec80c06334adc')
    expect(mintWorkerCredential(MASTER, 'rack.gpu.1')).to.equal('rack.gpu.1.46adfb14725d70257b371da88fc46ef831d118846c100ee96dcb3b8a90a6dc14')
  })

  it('trims the master like the coordinator does', () => {
    expect(mintWorkerCredential(`${MASTER}\n`, 'gpu-1')).to.equal(mintWorkerCredential(MASTER, 'gpu-1'))
  })

  it('extracts the worker name and rejects a raw master', () => {
    expect(workerCredentialName(mintWorkerCredential(MASTER, 'rack.gpu.1'))).to.equal('rack.gpu.1')
    expect(() => workerCredentialName(MASTER)).to.throw(/never give a worker the master/)
    expect(() => workerCredentialName('gpu-1.ABC')).to.throw(/MAC/)
  })

  it('applies core worker-name rules', () => {
    expect(() => validateWorkerName('')).to.throw()
    expect(() => validateWorkerName('a'.repeat(257))).to.throw()
    expect(() => validateWorkerName('gpu 1')).to.throw()
    expect(() => validateWorkerName('x-local-mock-1')).to.throw(/denied/)
    expect(() => validateWorkerName('a'.repeat(256))).not.to.throw()
    expect(() => mintWorkerCredential('short', 'gpu-1')).to.throw(/at least 32/)
  })
})
