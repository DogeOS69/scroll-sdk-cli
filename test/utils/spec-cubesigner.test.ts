import {expect} from 'chai'
import {SigningKey, Wallet} from 'ethers'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {resolveCubesignerIdentity} from '../../src/utils/spec-cubesigner.js'

describe('spec CubeSigner public identity discovery', () => {
  const fixture = () => {
    const key = new SigningKey(Wallet.createRandom().privateKey)
    const spec = {bridge: {}, dogecoin: {network: 'testnet'}, signing: {cubesigner: {identity: {roleId: 'Role#test'}}}} as DeploymentSpec
    const calls: string[][] = []
    const query = (args: string[]) => {
      calls.push(args)
      return args[0] === 'role' ? {keys: [{key_id: 'Key#test'}], name: 'test', role_id: 'Role#test'}
        : {key_id: 'Key#test', key_type: 'SecpDogeTestAddr', material_id: 'material-test', public_key: key.publicKey}
    }

    return {calls, key, query, spec}
  }

  it('queries a singleton role and freezes a normalized key without private provider fields', () => {
    const f = fixture()
    const resolved = resolveCubesignerIdentity(f.spec, args => ({...f.query(args), session: 'NONFUNCTIONAL_TEST_SESSION'}))
    expect(resolved.bridge.teePubkey).to.equal(f.key.compressedPublicKey.slice(2))
    expect(resolved.signing.cubesigner!.roles![0].keys[0].publicKeyCompressed).to.equal(resolved.bridge.teePubkey)
    expect(resolved.signing.cubesigner).not.to.have.property('identity')
    expect(JSON.stringify(resolved)).not.to.include('NONFUNCTIONAL_TEST_SESSION')
    expect(f.calls[1]).to.deep.equal(['key', 'get', '--key-id=Key#test', '--role-id=Role#test'])
    resolveCubesignerIdentity(resolved, () => {throw new Error('Frozen input must not query again')})
    expect(f.spec.bridge).not.to.have.property('teePubkey')
  })

  it('requires an explicit member key for multiple-key roles', () => {
    const f = fixture()
    const query = (args: string[]) => args[0] === 'role' ? {...f.query(args), keys: [{key_id: 'Key#test'}, {key_id: 'Key#other'}]} : f.query(args)
    expect(() => resolveCubesignerIdentity(f.spec, query)).to.throw('exactly one key')
    f.spec.signing.cubesigner!.identity!.keyId = 'Key#test'
    expect(resolveCubesignerIdentity(f.spec, query).bridge.teePubkey).to.equal(f.key.compressedPublicKey.slice(2))
    f.spec.signing.cubesigner!.identity!.keyId = 'Key#unrelated'
    expect(() => resolveCubesignerIdentity(f.spec, query)).to.throw('belonging')
  })

  it('rejects mismatched identities, invalid curve points and conflicting bridge keys', () => {
    const f = fixture()
    expect(() => resolveCubesignerIdentity(f.spec, args => ({...f.query(args), role_id: 'Role#wrong'}))).to.throw('unexpected role')
    expect(() => resolveCubesignerIdentity(f.spec, args => ({...f.query(args), key_id: 'Key#wrong'}))).to.throw('mismatched key')
    expect(() => resolveCubesignerIdentity(f.spec, args => ({...f.query(args), public_key: '02' + 'ff'.repeat(32)}))).to.throw('curve point')
    expect(() => resolveCubesignerIdentity(f.spec, args => ({...f.query(args), key_type: 'SecpDogeAddr'}))).to.throw('Dogecoin network')
    f.spec.bridge.teePubkey = new SigningKey(Wallet.createRandom().privateKey).compressedPublicKey
    expect(() => resolveCubesignerIdentity(f.spec, f.query)).to.throw('conflicts')
  })
})
