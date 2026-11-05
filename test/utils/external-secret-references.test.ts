import {expect} from 'chai'
import * as yaml from 'js-yaml'

import {reconcileExternalSecretFiles, reconcileExternalSecretReferences} from '../../src/utils/external-secret-references.js'

const PREFIX = 'example-org/example-deployment'
const target = {awsRegion: 'ap-southeast-2', prefix: PREFIX, provider: 'aws'}
const secret = (key: string, secretRegion?: string) => ({data: [{remoteRef: {key, property: 'P'}, secretKey: 'P'}], provider: 'aws', ...(secretRegion && {secretRegion})})

describe('reconcileExternalSecretReferences', () => {
  it('rewrites a template default and is idempotent', () => {
    const values = {externalSecrets: {example: secret('scroll/example-secret-env', 'us-west-2')}}
    expect(reconcileExternalSecretReferences(values, target)).to.equal(true)
    expect(values.externalSecrets.example.data[0].remoteRef.key).to.equal(`${PREFIX}/example-secret-env`)
    expect(values.externalSecrets.example.secretRegion).to.equal('ap-southeast-2')
    expect(reconcileExternalSecretReferences(values, target)).to.equal(false)
  })

  it('treats the other template key and region forms as defaults', () => {
    const values = {externalSecrets: {da: secret('dogeos/eth-da-submitter-secret-env', '<TODO>')}}
    reconcileExternalSecretReferences(values, target)
    expect(values.externalSecrets.da.data[0].remoteRef.key).to.equal(`${PREFIX}/eth-da-submitter-secret-env`)
    expect(values.externalSecrets.da.secretRegion).to.equal('ap-southeast-2')
    const shortPrefix = {externalSecrets: {a: secret('dogeos/a', 'ap-southeast-2')}}
    expect(reconcileExternalSecretReferences(shortPrefix, {...target, prefix: 'dogeos'})).to.equal(false)
  })

  it('prefixes the unprefixed grafana-admin key from the monitor template', () => {
    const values = {externalSecrets: {'grafana-admin': secret('grafana-admin-env')}}
    reconcileExternalSecretReferences(values, target)
    expect(values.externalSecrets['grafana-admin'].data[0].remoteRef.key).to.equal(`${PREFIX}/grafana-admin-env`)
    expect(values.externalSecrets['grafana-admin'].secretRegion).to.equal('ap-southeast-2')
  })

  it('keeps a path and region the operator selected', () => {
    const values = {externalSecrets: {custom: secret('team/shared/custom-env', 'eu-west-1')}}
    expect(reconcileExternalSecretReferences(values, target)).to.equal(false)
    expect(values.externalSecrets.custom).to.deep.equal(secret('team/shared/custom-env', 'eu-west-1'))
  })

  it('leaves other providers alone', () => {
    const vault = {externalSecrets: {other: {data: [{remoteRef: {key: 'scroll/x'}}], provider: 'vault'}}}
    expect(reconcileExternalSecretReferences(vault, target)).to.equal(false)
    expect(vault.externalSecrets.other.data[0].remoteRef.key).to.equal('scroll/x')
    expect(reconcileExternalSecretReferences({externalSecrets: {a: secret('scroll/a')}}, {prefix: 'p', provider: 'kubernetes'})).to.equal(false)
  })

  it('rewrites keys without inventing a region when the deployment has none', () => {
    const values = {externalSecrets: {a: secret('scroll/a')}}
    reconcileExternalSecretReferences(values, {prefix: 'p', provider: 'aws'})
    expect(values.externalSecrets.a).to.deep.equal(secret('p/a'))
  })

  it('updates only the rendered values files that change', () => {
    const untouched = '# keep this comment\nexternalSecrets: {}\n'
    const files = {'a.yaml': yaml.dump({externalSecrets: {a: secret('scroll/a')}}), 'b.yaml': untouched, 'c.txt': 'externalSecrets'}
    reconcileExternalSecretFiles(files, target)
    expect((yaml.load(files['a.yaml']) as any).externalSecrets.a.data[0].remoteRef.key).to.equal(`${PREFIX}/a`)
    expect(files['b.yaml']).to.equal(untouched)
    expect(files['c.txt']).to.equal('externalSecrets')
  })
})
