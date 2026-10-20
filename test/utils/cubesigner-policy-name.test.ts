import {expect} from 'chai'

import {isCubesignerPolicyIdentifier, isCubesignerPolicyName} from '../../src/utils/cubesigner-policy-name.js'

describe('CubeSigner policy names and concrete versions', () => {
  for (const name of ['abc', 'policy_123', '123_policy', 'a'.repeat(30)]) it(`accepts provider and signer compatible alias ${name}`, () => {
    expect(isCubesignerPolicyName(name)).equal(true)
    expect(isCubesignerPolicyIdentifier(`${name}/v1`, 1)).equal(true)
  })
  for (const name of ['', 'ab', 'a'.repeat(31), 'Policy_123', '_policy', 'latest_policy', 'policy_latest', 'old-policy', 'policy.name', 'pol icy', '策略名', 'abc\n', ' abc']) {
    it(`rejects unsupported alias ${JSON.stringify(name)}`, () => {
      expect(isCubesignerPolicyName(name)).equal(false)
      expect(isCubesignerPolicyIdentifier(`${name}/v1`)).equal(false)
    })
  }

  it('preserves v0 support only for workflows that allow the initial version', () => {
    expect(isCubesignerPolicyIdentifier('policy_1/v0')).equal(true)
    expect(isCubesignerPolicyIdentifier('policy_1/v0', 1)).equal(false)
    expect(isCubesignerPolicyIdentifier('policy_1/v999999999', 1)).equal(true)
  })
  for (const version of ['latest', 'v01', 'v-1', 'v1000000000', 'v1/extra', 'v1\n', '']) {
    it(`rejects nonconcrete or malformed version ${JSON.stringify(version)}`, () => {
      expect(isCubesignerPolicyIdentifier(`policy_1/${version}`)).equal(false)
    })
  }
})
