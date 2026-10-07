/* eslint-disable @typescript-eslint/no-explicit-any -- Inspect generated YAML and invalid input fixtures. */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'
import type {DstackControllerConfig} from '../../src/types/dstack-controller.js'

import {generateDogeConfigToml, validateDeploymentSpec} from '../../src/utils/deployment-spec-generator.js'
import {DSTACK_CONTROLLER_IMAGE, DSTACK_CONTROLLER_VALUES_FILE, generateDstackControllerValues} from '../../src/utils/dstack-controller-values.js'
import {generateValuesFiles} from '../../src/utils/values-generator.js'

export function dstackSpec(controller?: DstackControllerConfig): DeploymentSpec {
  const fixture = fs.readFileSync(new URL('../../src/config/deployment-spec.minimal.yaml', import.meta.url), 'utf8')
    .replaceAll('$ENV:OWNER_ADDRESS', `0x${'e'.repeat(40)}`)
    .replaceAll(/\$ENV:\w+/g, 'test-only')
  return {...yaml.load(fixture) as DeploymentSpec, dstackController: controller}
}

describe('dstack controller production values', () => {
  it('is opt-in and does not change the existing output set while disabled', () => {
    expect(generateDstackControllerValues()).to.equal(undefined)
    expect(generateDstackControllerValues({enabled: false})).to.equal(undefined)
    expect(generateValuesFiles(dstackSpec())).not.to.have.property(DSTACK_CONTROLLER_VALUES_FILE)
    expect(generateValuesFiles(dstackSpec({enabled: false}))).to.deep.equal(generateValuesFiles(dstackSpec()))
  })

  it('generates standalone PostgreSQL production values with immutable image and Secret references', () => {
    const source = generateValuesFiles(dstackSpec({enabled: true}))[DSTACK_CONTROLLER_VALUES_FILE]
    const values = yaml.load(source) as any
    expect(values.image).to.deep.equal(DSTACK_CONTROLLER_IMAGE)
    expect(values.database).to.deep.equal({existingSecret: 'dstack-controller-database', key: 'database-url', type: 'postgresql'})
    expect(values.serverConfig).to.deep.equal({existingSecret: 'dstack-controller-config', key: 'config.yml'})
    expect(values.auth).to.deep.equal({existingSecret: 'dstack-controller-auth', key: 'admin-token'})
    expect(values.persistence).to.deep.equal({retain: true, size: '20Gi'})
    expect(values.ingress.enabled).to.equal(false)
    expect(values.serviceAccount.automountServiceAccountToken).to.equal(false)
    expect(values).not.to.have.property('enabled')
    expect(values).not.to.have.property('externalSecrets')
    expect(values).not.to.have.property('env')
  })

  it('carries public inputs through doge-config TOML and is independent of cluster provider', () => {
    const controller: DstackControllerConfig = {
      credentialSecrets: [{name: 'gcp', secretName: 'gcp-key'}, {name: 'aws', secretName: 'aws-key'}],
      database: {type: 'sqlite'}, enabled: true,
      ingress: {enabled: true, hosts: ['dstack.example.com'], tls: [{hosts: ['dstack.example.com'], secretName: 'tls'}]},
      persistence: {existingClaim: 'restored', storageClass: ''},
      resources: {requests: {cpu: '2'}},
    }
    const spec = dstackSpec(controller)
    const original = structuredClone(spec)
    const dogeConfig = toml.parse(generateDogeConfigToml(spec))
    expect(dogeConfig.dstackController).to.deep.equal(controller)
    expect(generateDstackControllerValues(dogeConfig.dstackController as DstackControllerConfig)).to.equal(generateDstackControllerValues(controller))
    const source = generateValuesFiles(spec)[DSTACK_CONTROLLER_VALUES_FILE]
    for (const provider of ['aws', 'gcp', 'local'] as const) {
      spec.infrastructure.provider = provider
      expect(generateValuesFiles(spec)[DSTACK_CONTROLLER_VALUES_FILE]).to.equal(source)
    }

    const values = yaml.load(source) as any
    expect(values.database.existingSecret).to.equal('')
    expect(values.resources.requests).to.deep.equal({cpu: '2', memory: '1Gi'})
    expect(controller).to.deep.equal(original.dstackController)
  })

  it('does not retain the default digest when a custom immutable image is selected', () => {
    const image = {digest: `sha256:${'b'.repeat(64)}`, repository: 'example/dstack', tag: 'custom'}
    const values = yaml.load(generateDstackControllerValues({image})!) as any
    expect(values.image).to.deep.equal({...image, pullPolicy: 'IfNotPresent'})
  })

  it('rejects invalid settings and plaintext credential fields before generation', () => {
    for (const config of [
      {enabled: 'false'}, {replicaCount: 2}, {auth: {existingSecret: ''}},
      {auth: {token: 'test-secret-do-not-print'}}, {database: {url: 'postgres://secret'}},
      {image: {tag: 'latest'}}, {ingress: {enabled: true}},
      {credentialSecrets: [{name: 'gcp', secretName: 'a'}, {name: 'gcp', secretName: 'b'}]},
      {persistence: {retain: 'false'}}, {serviceAccount: {automountServiceAccountToken: 'false'}},
      {resources: {requests: {memory: 1}}}, {tolerations: [{effect: 'wrong'}]},
      {backends: [{api_key: 'test-secret-do-not-print', type: 'vastai'}]},
    ]) {
      const spec = dstackSpec(config as any)
      expect(() => generateValuesFiles(spec)).to.throw('dstackController')
      const error = validateDeploymentSpec(spec).errors.find(error => error.code === 'E015_INVALID_DSTACK_CONTROLLER_CONFIG')
      expect(error, JSON.stringify(config)).not.to.equal(undefined)
      expect(error!.message).not.to.include('test-secret-do-not-print')
    }
  })
})
