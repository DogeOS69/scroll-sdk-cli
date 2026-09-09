import {expect} from 'chai'
import sinon from 'sinon'

import {applyRethGenesisSigner, resolveGenesisImageTag} from '../../../src/commands/setup/gen-l2-artifacts.js'
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

describe('gen-l2-artifacts Reth genesis signer', () => {
  const address = '0x62154f72A4381dF73904667F20834aeD34e97dcB'
  const oldAddress = '0x6F129071C5395f7430415D1f66369A1779f2c791'

  it('replaces a stale legacy signer with Reth index 0, not the first array item', () => {
    const config = {sequencer: {L2GETH_SIGNER_ADDRESS: oldAddress}}
    const dogeConfig = {sequencerReth: {instances: [
      {index: 1, signer: {address: oldAddress}},
      {index: 0, signer: {address, kmsKeyId: 'do-not-copy', privateKey: 'do-not-copy'}},
    ]}}
    expect(applyRethGenesisSigner(config, dogeConfig)).to.equal(true)
    expect(config).to.deep.equal({sequencer: {L2GETH_SIGNER_ADDRESS: address}})
    expect(applyRethGenesisSigner(config, dogeConfig)).to.equal(false)
  })

  it('creates the contracts input for a fresh Reth deployment without a legacy keystore', () => {
    const config = {}
    expect(applyRethGenesisSigner(config, {sequencerReth: {instances: [{index: 0, signer: {address}}]}})).to.equal(true)
    expect(config).to.deep.equal({sequencer: {L2GETH_SIGNER_ADDRESS: address}})
  })

  it('leaves legacy deployments without Reth configuration unchanged', () => {
    const config = {sequencer: {L2GETH_SIGNER_ADDRESS: oldAddress}}
    expect(applyRethGenesisSigner(config, {})).to.equal(false)
    expect(config.sequencer.L2GETH_SIGNER_ADDRESS).to.equal(oldAddress)
  })

  for (const instances of [undefined, [], [{index: 1, signer: {address}}],
    [{index: 0, signer: {address: 'invalid'}}], [{index: 0}],
    [{index: 0, signer: {address}}, {index: 0, signer: {address}}]]) {
    it(`rejects malformed Reth configuration instead of retaining a stale signer: ${JSON.stringify(instances)}`, () => {
      const config = {sequencer: {L2GETH_SIGNER_ADDRESS: oldAddress}}
      expect(() => applyRethGenesisSigner(config, {sequencerReth: {instances}})).to.throw('refusing to use a stale legacy signer')
      expect(config.sequencer.L2GETH_SIGNER_ADDRESS).to.equal(oldAddress)
    })
  }
})
