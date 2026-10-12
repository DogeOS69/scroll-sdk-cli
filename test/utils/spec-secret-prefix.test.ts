import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {remoteSecretPrefix, resolveAwsSecretPrefix, specAwsSecretPrefix} from '../../src/utils/spec-secret-prefix.js'
import {getSecretProviderConfig} from '../../src/utils/values-generator.js'

const spec = (cluster = 'cluster-a', namespace = 'default', name = 'bridge') => ({infrastructure: {aws: {eksClusterName: cluster, region: 'us-east-1'}, namespace, provider: 'aws'}, metadata: {name}} as DeploymentSpec)

describe('AWS Secret deployment namespace', () => {
  let root: string
  beforeEach(() => {root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-prefix-'))})
  afterEach(() => {fs.rmSync(root, {force: true, recursive: true})})

  it('isolates clusters, Kubernetes namespaces and deployment names by default', () => {
    const destinations = [spec(), spec('cluster-b'), spec('cluster-a', 'partner'), spec('cluster-a', 'default', 'other')].map(input => specAwsSecretPrefix(input))
    expect(new Set(destinations).size).to.equal(4)
    expect(destinations[0]).to.equal('dogeos/cluster-a/default/bridge')
    expect(getSecretProviderConfig(spec()).prefix).to.equal(destinations[0])
  })

  it('preserves explicit destinations and rejects conflicting spec fields', () => {
    const input = spec()
    input.infrastructure.aws!.secretsPrefix = 'existing/devnet/nested'
    expect(specAwsSecretPrefix(input)).to.equal('existing/devnet/nested')
    input.preparation = {secretUpload: {awsPrefix: 'another', provider: 'aws'}} as DeploymentSpec['preparation']
    expect(() => specAwsSecretPrefix(input)).to.throw('must match')
    input.preparation!.secretUpload!.awsPrefix = 'existing/devnet/nested'
    expect(specAwsSecretPrefix(input)).to.equal('existing/devnet/nested')
    delete input.infrastructure.aws!.secretsPrefix
    expect(getSecretProviderConfig(input).prefix).to.equal('existing/devnet/nested')
  })

  it('refuses incomplete AWS intent or an unscoped standalone upload', () => {
    const input = spec()
    input.infrastructure.aws!.eksClusterName = ''
    expect(() => specAwsSecretPrefix(input)).to.throw('eksClusterName')
    expect(() => resolveAwsSecretPrefix(undefined, root)).to.throw('refusing a shared default')
    expect(resolveAwsSecretPrefix('explicit/private', root)).to.equal('explicit/private')
  })

  it('reads the persisted destination before a changed local spec', () => {
    fs.mkdirSync(path.join(root, '.data'))
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), '[ethereumRpcSecretStore]\nprovider="aws"\nprefix="frozen/cluster/default/bridge"\n')
    fs.writeFileSync(path.join(root, 'deployment-spec.yaml'), JSON.stringify(spec('another-cluster')))
    expect(resolveAwsSecretPrefix(undefined, root)).to.equal('frozen/cluster/default/bridge')
    fs.unlinkSync(path.join(root, '.data/doge-config.toml'))
    expect(resolveAwsSecretPrefix(undefined, root)).to.equal('dogeos/another-cluster/default/bridge')
  })

  it('requires an isolated destination for local clusters using AWS Secrets', () => {
    const input = spec()
    input.infrastructure.provider = 'local'
    input.infrastructure.local = {useK8sSecrets: false}
    expect(getSecretProviderConfig(input).prefix).to.equal('dogeos/cluster-a/default/bridge')
    fs.writeFileSync(path.join(root, 'deployment-spec.yaml'), JSON.stringify(input))
    expect(resolveAwsSecretPrefix(undefined, root)).to.equal('dogeos/cluster-a/default/bridge')
    delete input.infrastructure.aws
    expect(() => getSecretProviderConfig(input)).to.throw('eksClusterName')
  })

  it('keeps the full CubeSigner remote prefix', () => {
    expect(remoteSecretPrefix('dogeos/cluster/namespace/bridge/cubesigner-signer-session')).to.equal('dogeos/cluster/namespace/bridge')
    expect(remoteSecretPrefix('session')).to.equal(undefined)
  })

  it('rejects unsafe prefix segments instead of normalizing into another destination', () => {
    for (const prefix of ['', '/root', 'root/', 'a//b', 'a/../b', 'a/./b', 'a b']) {
      expect(() => resolveAwsSecretPrefix(prefix, root)).to.throw()
    }
  })
})
