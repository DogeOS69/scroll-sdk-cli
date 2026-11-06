/* eslint-disable @typescript-eslint/no-explicit-any -- Inspect generated YAML values. */
import * as toml from '@iarna/toml'
import bitcore from 'bitcore-lib-doge'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {generateDogeConfigToml, normalizeDeploymentSpec} from '../../src/utils/deployment-spec-generator.js'
import {reconcileEthereumRpcSecrets} from '../../src/utils/ethereum-rpc-secrets.js'
import {reconcileExternalSecretFiles, reconcileExternalSecretReferences} from '../../src/utils/external-secret-references.js'
import {generateValuesFiles, getSecretProviderConfig} from '../../src/utils/values-generator.js'

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PREFIX = 'example-org/example-deployment'
const target = {awsRegion: 'ap-southeast-2', prefix: PREFIX, provider: 'aws'}
const secret = (key: string, secretRegion?: string) => ({data: [{remoteRef: {key, property: 'P'}, secretKey: 'P'}], provider: 'aws', ...(secretRegion && {secretRegion})})
const clone = <T>(value: T): T => structuredClone(value)

describe('reconcileExternalSecretReferences', () => {
  it('rewrites a template default and is idempotent', () => {
    const template = {externalSecrets: {example: secret('scroll/example-secret-env', 'us-west-2')}}
    const values = clone(template)
    expect(reconcileExternalSecretReferences(values, target, template)).to.equal(true)
    expect(values.externalSecrets.example.data[0].remoteRef.key).to.equal(`${PREFIX}/example-secret-env`)
    expect(values.externalSecrets.example.secretRegion).to.equal('ap-southeast-2')
    expect(reconcileExternalSecretReferences(values, target, template)).to.equal(false)
  })

  it('treats the other template key and region forms as defaults', () => {
    const template = {externalSecrets: {da: secret('dogeos/eth-da-submitter-secret-env', '<TODO>')}}
    const values = clone(template)
    reconcileExternalSecretReferences(values, target, template)
    expect(values.externalSecrets.da.data[0].remoteRef.key).to.equal(`${PREFIX}/eth-da-submitter-secret-env`)
    expect(values.externalSecrets.da.secretRegion).to.equal('ap-southeast-2')
    const shortPrefix = {externalSecrets: {a: secret('dogeos/a', 'ap-southeast-2')}}
    expect(reconcileExternalSecretReferences(shortPrefix, {...target, prefix: 'dogeos'}, shortPrefix)).to.equal(false)
  })

  it('prefixes the unprefixed grafana-admin key from the monitor template', () => {
    const template = {externalSecrets: {'grafana-admin': secret('grafana-admin-env')}}
    const values = clone(template)
    reconcileExternalSecretReferences(values, target, template)
    expect(values.externalSecrets['grafana-admin'].data[0].remoteRef.key).to.equal(`${PREFIX}/grafana-admin-env`)
    expect(values.externalSecrets['grafana-admin'].secretRegion).to.equal('ap-southeast-2')
  })

  it('keeps a path and region the operator selected', () => {
    const template = {externalSecrets: {custom: secret('scroll/custom-env', 'us-west-2')}}
    const values = {externalSecrets: {custom: secret('team/shared/custom-env', 'eu-west-1')}}
    expect(reconcileExternalSecretReferences(values, target, template)).to.equal(false)
    expect(values.externalSecrets.custom).to.deep.equal(secret('team/shared/custom-env', 'eu-west-1'))
  })

  it('keeps operator keys that look like template defaults but differ from this file\'s template', () => {
    const template = {externalSecrets: {coordinator: secret('scroll/coordinator-env', 'us-west-2')}}
    const values = {externalSecrets: {coordinator: secret('scroll/shared-coordinator-env', 'us-east-2')}}
    expect(reconcileExternalSecretReferences(values, target, template)).to.equal(false)
    const bare = {externalSecrets: {coordinator: secret('my-managed-secret')}}
    reconcileExternalSecretReferences(bare, {prefix: 'p', provider: 'aws'}, template)
    expect(bare.externalSecrets.coordinator).to.deep.equal(secret('my-managed-secret'))
  })

  it('leaves a Secret the template does not define alone', () => {
    const values = {externalSecrets: {added: secret('scroll/added-env', 'us-west-2')}}
    expect(reconcileExternalSecretReferences(values, target, {externalSecrets: {}})).to.equal(false)
  })

  it('uses the region the upload step writes Secrets to', () => {
    const spec: any = {infrastructure: {aws: {eksClusterName: 'cluster', region: 'ap-southeast-1', secretsPrefix: PREFIX}, provider: 'aws'}, metadata: {name: 'example'}}
    expect(getSecretProviderConfig(spec).awsRegion).to.equal('ap-southeast-1')
    spec.preparation = {secretUpload: {awsRegion: 'ap-southeast-2', provider: 'aws'}}
    expect(getSecretProviderConfig(spec).awsRegion).to.equal('ap-southeast-2')
    spec.preparation = {secretUpload: {provider: 'aws'}}
    expect(getSecretProviderConfig(spec).awsRegion).to.equal('ap-southeast-1')
  })

  const fullSpec = () => {
    const spec: any = normalizeDeploymentSpec(yaml.load(fs.readFileSync(path.join(cliRoot, 'test/fixtures/deployment-spec/minimal.yaml'), 'utf8')
      .replaceAll('$ENV:OWNER_ADDRESS', '0x0000000000000000000000000000000000000001')
      .replaceAll(/\$ENV:[A-Z_a-z]\w*/g, 'NONFUNCTIONAL_TEST_PLACEHOLDER')) as DeploymentSpec)
    spec.contracts.feeVaultDogeRecipientAddress = new bitcore.PrivateKey(null, bitcore.Networks.testnet).toAddress().toString()
    spec.bridge.attestation.signers = [0, 1, 2].map(index => ({attestationPubkey: new bitcore.PrivateKey().toPublicKey().toString(), name: `partner-${index}`, transportPubkey: new bitcore.PrivateKey().toPublicKey().toString()}))
    spec.bridge.attestation.threshold = 2
    spec.infrastructure.aws.region = 'ap-southeast-1'
    spec.preparation = {bridge: {image: 'fixture', mode: 'helper'}, secretUpload: {awsRegion: 'ap-southeast-2', provider: 'aws'}}
    return spec
  }

  it('generates every values file with the upload region', () => {
    const regions = Object.values(generateValuesFiles(fullSpec())).flatMap(content => Object.values((yaml.load(content) as any)?.externalSecrets ?? {}).map((secret: any) => secret.secretRegion))
    expect(regions).to.include('ap-southeast-2')
    expect(regions).to.not.include('ap-southeast-1')
  })

  it('keeps the upload region when render reconciles the Ethereum RPC Secrets', () => {
    const spec = fullSpec()
    const store = (toml.parse(generateDogeConfigToml(spec)) as any).ethereumRpcSecretStore
    expect(store.awsRegion).to.equal('ap-southeast-2')
    const values = yaml.load(generateValuesFiles(spec)['fee-oracle-production.yaml']) as any
    expect(reconcileEthereumRpcSecrets(values, 'fee-oracle', store)).to.equal(false)
    expect(Object.values(values.externalSecrets).map((secret: any) => secret.secretRegion)).to.not.include('ap-southeast-1')
  })

  it('records a region only for a store that reads AWS', () => {
    const spec = fullSpec()
    delete spec.preparation.secretUpload
    expect((toml.parse(generateDogeConfigToml(spec)) as any).ethereumRpcSecretStore.awsRegion).to.equal('ap-southeast-1')
    spec.infrastructure.provider = 'local'
    expect((toml.parse(generateDogeConfigToml(spec)) as any).ethereumRpcSecretStore).to.not.have.property('awsRegion')
  })

  it('leaves other providers alone', () => {
    const vault = {externalSecrets: {other: {data: [{remoteRef: {key: 'scroll/x'}}], provider: 'vault'}}}
    expect(reconcileExternalSecretReferences(vault, target, vault)).to.equal(false)
    expect(vault.externalSecrets.other.data[0].remoteRef.key).to.equal('scroll/x')
    const kubernetes = {externalSecrets: {a: secret('scroll/a')}}
    expect(reconcileExternalSecretReferences(kubernetes, {prefix: 'p', provider: 'kubernetes'}, kubernetes)).to.equal(false)
  })

  it('rewrites keys without inventing a region when the deployment has none', () => {
    const template = {externalSecrets: {a: secret('scroll/a')}}
    const values = clone(template)
    reconcileExternalSecretReferences(values, {prefix: 'p', provider: 'aws'}, template)
    expect(values.externalSecrets.a).to.deep.equal(secret('p/a'))
  })

  it('updates only the rendered values files that change', () => {
    const untouched = '# keep this comment\nexternalSecrets: {}\n'
    const rendered = yaml.dump({externalSecrets: {a: secret('scroll/a')}})
    const noTemplate = yaml.dump({externalSecrets: {z: secret('scroll/z')}})
    const files: Record<string, string> = {'a.yaml': rendered, 'b.yaml': untouched, 'c.txt': 'externalSecrets', 'd.yaml': noTemplate}
    reconcileExternalSecretFiles(files, target, {'values/a.yaml': rendered, 'values/b.yaml': untouched})
    expect(files['d.yaml']).to.equal(noTemplate)
    expect((yaml.load(files['a.yaml']) as any).externalSecrets.a.data[0].remoteRef.key).to.equal(`${PREFIX}/a`)
    expect(files['b.yaml']).to.equal(untouched)
    expect(files['c.txt']).to.equal('externalSecrets')
  })
})
