import {expect} from 'chai'
import sinon from 'sinon'

import {resolveGenesisImageTag} from '../../../src/commands/setup/gen-l2-artifacts.js'
import {CONTRACTS_DOCKER_DEFAULT_TAG, DOCKER_TAGS_URL} from '../../../src/constants/docker.js'

describe('gen-l2-artifacts explicit image selection', () => {
  afterEach(() => sinon.restore())

  it('uses the default only when no tag was supplied', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch')
    expect(await resolveGenesisImageTag()).to.equal(`gen-configs-${CONTRACTS_DOCKER_DEFAULT_TAG}`)
    expect(fetchStub.called).to.equal(false)
  })

  it('checks the exact release without depending on a paginated tag listing', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response('{}', {status: 200}))
    for (const supplied of ['v0.3.0-beta.3e', 'gen-configs-v0.3.0-beta.3e']) {
      expect(await resolveGenesisImageTag(supplied)).to.equal('gen-configs-v0.3.0-beta.3e')
    }

    expect(fetchStub.alwaysCalledWithExactly(`${DOCKER_TAGS_URL}/gen-configs-v0.3.0-beta.3e`)).to.equal(true)
    expect(await resolveGenesisImageTag('0.3.0')).to.equal('gen-configs-v0.3.0')
  })

  for (const status of [404, 429, 500]) {
    it(`rejects HTTP ${status} without silently substituting an older image`, async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response('{}', {status}))
      let error: unknown
      try {
        await resolveGenesisImageTag('v0.3.0-beta.3e')
      } catch (error_) {
        error = error_
      }

      expect(error).to.be.instanceOf(Error)
      expect((error as Error).message).to.include(`HTTP ${status}`)
      expect((error as Error).message).to.include('refusing to substitute')
      expect(fetchStub.calledOnce).to.equal(true)
    })
  }
})
