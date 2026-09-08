import {expect} from 'chai'

import {resolvePushedSecretName} from '../../src/commands/setup/push-secrets.js'

const ref = (key: string) => ({remoteRef: {key}})

describe('push-secrets chart-local aliases', () => {
  const name = 'l2-reth-sequencer-0-secret-env'
  const names = new Set([name])

  it('preserves existing exact-name matching', () => {
    expect(resolvePushedSecretName(name, {}, names)).to.equal(name)
  })

  it('matches Reth aliases by their complete remote basename', () => {
    const secret = {data: [ref(`dogeos/${name}`), ref(`dogeos/${name}`)]}
    expect(resolvePushedSecretName('secret-env', secret, names)).to.equal(name)
    secret.data = [ref(`dogeos/devnet-20260908/${name}`)]
    expect(resolvePushedSecretName('secret-env', secret, names)).to.equal(name)
  })

  it('does not rewrite another Reth instance or a mixed-source secret', () => {
    expect(resolvePushedSecretName('secret-env', {data: [ref('dogeos/l2-reth-sequencer-1-secret-env')]}, names)).to.equal(undefined)
    expect(resolvePushedSecretName('secret-env', {data: [ref(`dogeos/${name}`), ref('dogeos/other')]}, names)).to.equal(undefined)
  })

  it('ignores empty or incomplete remote references', () => {
    for (const secret of [{}, {data: []}, {data: [{}]}, {data: [ref(`dogeos/${name}`), {}]}]) {
      expect(resolvePushedSecretName('secret-env', secret, names)).to.equal(undefined)
    }
  })
})
