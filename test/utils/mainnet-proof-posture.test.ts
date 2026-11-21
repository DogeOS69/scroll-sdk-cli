import {expect} from 'chai'

import {MAINNET_PROOF_POSTURE, assertMainnetProofPosture, isDogecoinMainnet, mainnetProofPostureProblem} from '../../src/utils/mainnet-proof-posture.js'

describe('mainnet proof posture', () => {
  const postures = (['active', 'disabled'] as const).flatMap(mode => (['mock', 'real'] as const).flatMap(generation =>
    (['enforce', 'observe'] as const).map(enforcement => ({enforcement, generation, mode}))))

  it('accepts only active/real/enforce on mainnet, under either network name', () => {
    for (const network of ['mainnet', 'dogecoin']) {
      expect(isDogecoinMainnet(network)).to.equal(true)
      for (const posture of postures) {
        const valid = posture.mode === 'active' && posture.generation === 'real' && posture.enforcement === 'enforce'
        const problem = mainnetProofPostureProblem(network, posture)
        expect(problem === undefined, `${network} ${JSON.stringify(posture)}`).to.equal(valid)
        if (!valid) expect(problem).to.include(`configured ${posture.mode}/${posture.generation}/${posture.enforcement}`)
      }
    }

    expect(MAINNET_PROOF_POSTURE).to.deep.equal({enforcement: 'enforce', generation: 'real', mode: 'active'})
  })

  it('leaves testnet and regtest postures to the general validation', () => {
    for (const network of ['testnet', 'regtest', undefined]) {
      expect(isDogecoinMainnet(network)).to.equal(false)
      for (const posture of postures) expect(mainnetProofPostureProblem(network, posture)).to.equal(undefined)
    }
  })

  it('names the source in the thrown error', () => {
    expect(() => assertMainnetProofPosture('mainnet', {enforcement: 'observe', generation: 'mock', mode: 'disabled'}, '.data/doge-config.toml'))
      .to.throw(/^\.data\/doge-config\.toml: Dogecoin mainnet requires proof mode=active/)
    expect(() => assertMainnetProofPosture('mainnet', MAINNET_PROOF_POSTURE)).not.to.throw()
  })
})
