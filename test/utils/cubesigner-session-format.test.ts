import {expect} from 'chai'

import {cubesignerSessionExpiration} from '../../src/utils/cubesigner-session-format.js'

describe('CubeSigner session expiration formats', () => {
  const expiration = 2_000_000_000
  it('reads cs CLI, SDK and matching dual-field metadata', () => {
    for (const session of [{expiration}, {session_exp: expiration}, {expiration, session_exp: expiration}, {expiration, session_exp: null}]) {
      expect(cubesignerSessionExpiration(session)).equal(expiration)
    }
  })
  it('leaves legacy missing metadata to the caller and provider validation', () => {
    expect(cubesignerSessionExpiration({})).equal(undefined)
    expect(cubesignerSessionExpiration({session_exp: null})).equal(undefined)
  })
  it('rejects conflicting metadata without including its contents in errors', () => {
    expect(() => cubesignerSessionExpiration({expiration, session_exp: expiration + 1})).throw('Conflicting CubeSigner session expiration metadata')
  })
  for (const value of ['NONFUNCTIONAL_TEST', true, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`rejects invalid metadata of type ${typeof value}`, () => {
      for (const field of ['expiration', 'session_exp']) {
        expect(() => cubesignerSessionExpiration({[field]: value})).throw('Invalid CubeSigner session expiration metadata')
      }
    })
  }
})
