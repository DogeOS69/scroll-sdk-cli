/* eslint-disable @typescript-eslint/no-explicit-any -- Inspect generated Helm/Secret fixtures. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {DSTACK_CONTROLLER_VALUES_FILE, DSTACK_MONITORING_VALUES_FILE, generateDstackControllerValues, generateDstackMonitoringValues} from '../../src/utils/dstack-controller-values.js'
import {DSTACK_CREDENTIALS_FILE, newDstackCredentials, readDstackCredentials, writeDstackCredentialSecrets, writePrivateFile} from '../../src/utils/dstack-credentials.js'
import {loadDstackSecretPublication, publishDstackSecrets} from '../../src/utils/dstack-secret-publisher.js'
import {generateValuesFiles} from '../../src/utils/values-generator.js'
import {dstackSpec} from './dstack-controller-values.test.js'

describe('dstack monitoring generation and credential handoff', () => {
  let directory: string
  let previous: string
  const config = {database: {type: 'sqlite' as const}, enabled: true, monitoring: {enabled: true}}
  beforeEach(() => {
    previous = process.cwd()
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dstack-monitoring-'))
    process.chdir(directory)
    const state = {...newDstackCredentials(), providers: ['vastai' as const], vastaiApiKey: 'disposable-test-key'}
    writePrivateFile(DSTACK_CREDENTIALS_FILE, JSON.stringify(state))
    fs.mkdirSync('values')
  })
  afterEach(() => {
    process.chdir(previous)
    fs.rmSync(directory, {force: true, recursive: true})
  })

  it('generates matching controller and explicitly scoped monitor overlay without credentials', () => {
    const files = generateValuesFiles(dstackSpec({...config, fullnameOverride: 'gpu-control', monitoring: {enabled: true, interval: '60s', namespace: 'gpu-system'}}))
    const controller = yaml.load(files[DSTACK_CONTROLLER_VALUES_FILE]) as any
    const monitor = yaml.load(files[DSTACK_MONITORING_VALUES_FILE]) as any
    expect(controller.fullnameOverride).to.equal('gpu-control')
    expect(controller.monitoring.interval).to.equal('60s')
    expect(controller.monitoring).not.to.have.property('namespace')
    expect(monitor.dstack).to.include({controllerName: 'gpu-control', enabled: true, namespace: 'gpu-system'})
    expect(monitor['kube-prometheus-stack'].prometheus.prometheusSpec.serviceMonitorNamespaceSelector).to.deep.equal({
      matchExpressions: [{key: 'kubernetes.io/metadata.name', operator: 'In', values: ['{{ .Release.Namespace }}', 'gpu-system']}],
    })
    for (const value of Object.values(files)) expect(value).not.to.include(readDstackCredentials()!.monitoringToken!)
    expect(generateDstackMonitoringValues({monitoring: {enabled: false}})).to.include('enabled: false')
    expect(generateDstackMonitoringValues({enabled: false, monitoring: {enabled: true}})).to.equal(undefined)
  })

  it('generates a separate monitoring token once, including migration of legacy private state', () => {
    const old = readDstackCredentials()!
    delete old.monitoringToken
    writePrivateFile(DSTACK_CREDENTIALS_FILE, JSON.stringify(old))
    const first = writeDstackCredentialSecrets(config)
    const state = readDstackCredentials()!
    expect(state.adminToken).to.equal(old.adminToken)
    expect(state.encryptionKey).to.equal(old.encryptionKey)
    expect(state.monitoringToken).to.match(/^[\da-f]{64}$/)
    expect(state.monitoringToken).not.to.equal(state.adminToken)
    expect(first.map(file => path.basename(file))).to.include('dstack-controller-monitoring.yaml')
    const token = fs.readFileSync('secrets/dstack-controller-monitoring.yaml', 'utf8')
    writeDstackCredentialSecrets(config)
    expect(readDstackCredentials()).to.deep.equal(state)
    expect(fs.readFileSync('secrets/dstack-controller-monitoring.yaml', 'utf8')).to.equal(token)
    expect(fs.statSync('secrets/dstack-controller-monitoring.yaml').mode % 0o1000).to.equal(0o600)
    const controller = yaml.load(generateDstackControllerValues(config)!) as any
    expect(controller.monitoring.auth).to.deep.equal({existingSecret: 'dstack-controller-monitoring', key: 'token'})
  })

  it('publishes only matching namespace/values, refuses stale tokens and protects live token identity', async () => {
    const valuesFile = path.join('values', DSTACK_CONTROLLER_VALUES_FILE)
    fs.writeFileSync(valuesFile, generateDstackControllerValues(config)!)
    writeDstackCredentialSecrets(config)
    const secrets = loadDstackSecretPublication(config, valuesFile, 'dstack-system')
    expect(secrets.map(s => s.metadata.name)).to.include('dstack-controller-monitoring')
    expect(() => loadDstackSecretPublication(config, valuesFile, 'wrong')).to.throw('namespace')
    const calls: string[][] = []
    try {
      await publishDstackSecrets({config, context: 'test', namespace: 'dstack-system', async runner(args) {
        calls.push(args)
        return JSON.stringify({items: [{data: {token: Buffer.from('different').toString('base64')}, metadata: {name: 'dstack-controller-monitoring'}}]})
      }, valuesFile})
      expect.fail('must reject live token mismatch')
    } catch (error) {
      expect(String(error)).to.include('Existing monitoring token differs')
    }

    expect(calls).to.have.length(1)
    fs.writeFileSync('secrets/dstack-controller-monitoring.yaml', yaml.dump({...secrets.find(s => s.metadata.name === 'dstack-controller-monitoring'), stringData: {token: 'stale'}}))
    expect(() => loadDstackSecretPublication(config, valuesFile, 'dstack-system')).to.throw('Stale')
  })

  it('does not silently recreate missing private monitoring state when a Secret output exists', () => {
    writeDstackCredentialSecrets(config)
    const state = readDstackCredentials()!
    delete state.monitoringToken
    writePrivateFile(DSTACK_CREDENTIALS_FILE, JSON.stringify(state))
    expect(() => writeDstackCredentialSecrets(config)).to.throw('restore credentials.json')
  })

  it('rejects unbounded/malformed settings and plaintext credentials', () => {
    for (const monitoring of [
      {enabled: 'false'}, {namespace: 'all"namespaces'}, {interval: '0s'},
      {interval: '5s', scrapeTimeout: '10s'}, {sampleLimit: 0},
      {auth: {token: 'do-not-print'}}, {alerts: {failedRunsThreshold: 0}},
      {gpuHosts: {expectedHosts: ['a', 'a']}}, {gpuHosts: {expectedHosts: ['invalid"host']}},
      {gpuHosts: {staleAfterSeconds: 1}}, {gpuHosts: {diskAvailableRatio: 1}},
    ]) expect(() => generateDstackControllerValues({monitoring} as any)).to.throw('dstackController.monitoring')
  })
})
