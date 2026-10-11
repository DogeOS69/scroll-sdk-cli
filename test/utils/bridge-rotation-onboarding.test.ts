import {expect} from 'chai'
import {createECDH} from 'node:crypto'

import {rotationSpecFromIdentities} from '../../src/utils/bridge-rotation-onboarding.js'

const key = () => {const e = createECDH('secp256k1'); e.generateKeys(); return e.getPublicKey('hex', 'compressed')}
const identity = () => ({network: 'testnet', publicKey: key(), schema: 'dogeos/attestation-signer-descriptor/v1', transportPubkey: key()})

describe('rotation core identity import', () => {
  it('maps core public pairs without manual copy and preserves inherited quorum/recovery intent', () => {
    const a = identity(); const b = identity(); const c = identity()
    const spec = rotationSpecFromIdentities('rotation-3', 'testnet', [{identity: a, name: 'a-3'}, {identity: b, name: 'b-3'}, {identity: c, name: 'c-3'}])
    expect(spec.attestation).not.have.property('threshold')
    expect(spec.timelock?.policy).eq('preserve')
    expect(spec.attestation.signers[0]).deep.eq({attestationPubkey: a.publicKey, name: 'a-3', transportPubkey: a.transportPubkey})
  })
  it('rejects mixed networks, repeated pairs, repeated names and invalid quorum', () => {
    const a = identity(); const b = identity()
    expect(() => rotationSpecFromIdentities('r3', 'mainnet', [{identity: a, name: 'a'}])).throw('network differs')
    expect(() => rotationSpecFromIdentities('r3', 'testnet', [{identity: a, name: 'a'}, {identity: a, name: 'b'}])).throw('distinct')
    expect(() => rotationSpecFromIdentities('r3', 'testnet', [{identity: a, name: 'a'}, {identity: b, name: 'a'}])).throw('unique')
    expect(() => rotationSpecFromIdentities('r3', 'testnet', [{identity: a, name: 'a'}], 2)).throw('threshold')
  })
  it('does not leak unexpected private input fields or accept helper JSON as core output', () => {
    const invalidRecord = {schema: 'FAKE_PRIVATE_SENTINEL'}
    const invalid = () => rotationSpecFromIdentities('r3', 'testnet', [{identity: invalidRecord, name: 'a'}])
    expect(invalid).throw('core identity')
    expect(invalid).not.throw('FAKE_PRIVATE_SENTINEL')
    const raw = identity()
    expect(() => rotationSpecFromIdentities('r3', 'testnet', [{identity: {attestationPubkey: raw.publicKey, network: 'testnet', transportPubkey: raw.transportPubkey}, name: 'a'}])).throw('core identity')
  })
  it('records only an explicit recovery refresh and threshold change', () => {
    const spec = rotationSpecFromIdentities('r3', 'testnet', [{identity: identity(), name: 'a'}], 1, 'refresh')
    expect(spec.timelock).deep.eq({policy: 'refresh'})
    expect(spec.attestation.threshold).eq(1)
  })
})
