import {expect} from 'chai'

import {configurePolicyResolver} from '../../src/utils/cubesigner-policy-resolver.js'

describe('CubeSigner policy resolver', () => {
  function fixture() {
    let value = {allowed_http_authorities: ['existing.example.com'], futureSetting: {preserve: true}}
    const writes: unknown[] = []
    const org = {id: 'Org#fixture', async policyEngineConfiguration() {return structuredClone(value)}, async setPolicyEngineConfiguration(next: {allowed_http_authorities: string[]}) {writes.push(next); value = next as typeof value}}
    return {options: {apply: false, baseUrl: 'https://proof.example.com/artifacts/', org, organization: org.id}, writes}
  }

  it('previews without mutation, preserves unrelated fields when applying, and is idempotent', async () => {
    const {options, writes} = fixture()
    expect((await configurePolicyResolver(options)).proposed).to.deep.equal(['existing.example.com', 'proof.example.com'])
    expect(writes).to.have.length(0)
    expect((await configurePolicyResolver({...options, apply: true})).readback).to.equal('verified')
    expect(writes[0]).to.deep.equal({allowed_http_authorities: ['existing.example.com', 'proof.example.com'], futureSetting: {preserve: true}})
    expect((await configurePolicyResolver({...options, apply: true})).changed).to.equal(false)
    expect(writes).to.have.length(1)
  })

  it('refuses an organization mismatch or credential-bearing URL before any provider read', async () => {
    for (const change of [{organization: 'Org#other'}, {baseUrl: 'https://proof.example.com/?token=fake-placeholder'}]) {
      const {options, writes} = fixture()
      options.org.policyEngineConfiguration = async () => {throw new Error('unexpected provider read')}
      let error: unknown
      try {await configurePolicyResolver({...options, ...change, apply: true})} catch (error_) {error = error_}
      expect(String(error)).not.to.contain('unexpected provider read')
      expect(error).to.be.instanceOf(Error)
      expect(writes).to.have.length(0)
    }
  })

  it('does not overwrite a configuration that changes between review and mutation', async () => {
    const {options, writes} = fixture()
    let reads = 0
    options.org.policyEngineConfiguration = async () => ({allowed_http_authorities: [String(++reads)], futureSetting: {preserve: true}})
    let error: unknown
    try {await configurePolicyResolver({...options, apply: true})} catch (error_) {error = error_}
    expect(String(error)).to.contain('changed during review')
    expect(writes).to.have.length(0)
  })

  it('reports a provider that did not retain the new authority', async () => {
    const {options} = fixture()
    options.org.setPolicyEngineConfiguration = async () => {}
    let error: unknown
    try {await configurePolicyResolver({...options, apply: true})} catch (error_) {error = error_}
    expect(String(error)).to.contain('readback mismatch')
  })
})
