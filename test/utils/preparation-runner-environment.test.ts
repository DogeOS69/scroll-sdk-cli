import {expect} from 'chai'
import path from 'node:path'

import {preparationChildEnvironment} from '../../src/utils/preparation-runner.js'

describe('preparation child environment', () => {
  it('resolves a relative NODE_EXTRA_CA_CERTS against the parent working directory', () => {
    const env = preparationChildEnvironment('blockscout-db', {}, {NODE_EXTRA_CA_CERTS: 'infrastructure/rds/bundle.pem'}, '/private/deploy')
    expect(env.NODE_EXTRA_CA_CERTS).to.equal(path.resolve('/private/deploy', 'infrastructure/rds/bundle.pem'))
    expect(env.SCROLLSDK_PREPARATION_STEP).to.equal('blockscout-db')
  })

  it('keeps an absolute NODE_EXTRA_CA_CERTS and step overrides untouched', () => {
    const env = preparationChildEnvironment('aws', {EXTRA: '1'}, {EXTRA: '0', NODE_EXTRA_CA_CERTS: '/etc/ssl/bundle.pem'}, '/private/deploy')
    expect(env.NODE_EXTRA_CA_CERTS).to.equal('/etc/ssl/bundle.pem')
    expect(env.EXTRA).to.equal('1')
  })

  it('does not add NODE_EXTRA_CA_CERTS when the parent has none', () => {
    const env = preparationChildEnvironment('genesis', {}, {PATH: '/usr/bin'}, '/private/deploy')
    expect(env).to.not.have.property('NODE_EXTRA_CA_CERTS')
  })
})
