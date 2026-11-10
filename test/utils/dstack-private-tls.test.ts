/* eslint-disable @typescript-eslint/no-explicit-any -- Rendered values and deployment fixtures. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {DstackCaPending, prepareCapacityManager, prepareCapacityManagerIfSelected} from '../../src/utils/capacity-manager.js'
import {generateDstackControllerValues} from '../../src/utils/dstack-controller-values.js'
import {type DstackCaTarget, DstackCaUnavailable, assertDstackPrivateTlsValues, dstackCaBundle, dstackPrivateTlsUrl, readDstackClusterCa, validateDstackPrivateTls} from '../../src/utils/dstack-private-tls.js'
import {validateFinalValues} from '../../src/utils/final-values-validation.js'
import {AwaitingInput, writeJson} from '../../src/utils/preparation-io.js'
import {assertCapacityChartVersions} from '../../src/utils/spec-bootstrap.js'
import {capacityWorkerFixture} from '../helpers/capacity-manager-worker.js'
import {internalTls} from './dstack-internal-tls.test.js'

/** Disposable certificates; nothing is committed and the keys are discarded with the directory. */
function certificates(): {ca: string; leaf: string} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dstack-ca-'))
  try {
    const run = (...args: string[]) => execFileSync('openssl', args, {cwd: directory, stdio: 'pipe'})
    run('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=fixture-ca', '-addext', 'basicConstraints=critical,CA:TRUE')
    run('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.crt', '-days', '1', '-subj', '/CN=fixture-leaf', '-addext', 'basicConstraints=critical,CA:FALSE')
    return {ca: fs.readFileSync(path.join(directory, 'ca.crt'), 'utf8'), leaf: fs.readFileSync(path.join(directory, 'leaf.crt'), 'utf8')}
  } finally {fs.rmSync(directory, {force: true, recursive: true})}
}

describe('dstack in-cluster HTTPS with a private CA', () => {
  // In a hook, so a missing openssl fails only this suite instead of loading the whole run.
  let ca: string
  let leaf: string
  before(() => {({ca, leaf} = certificates())})

  it('generates chart TLS values that keep dstack off ingress', () => {
    const values = yaml.load(generateDstackControllerValues({privateTls: {}})!) as any
    expect(values).not.to.have.property('privateTls')
    expect(values.tls).to.deep.equal({clusterDomain: 'cluster.local', enabled: true, port: 8443})
    expect(values.ingress.enabled).to.equal(false)
    assertDstackPrivateTlsValues(values, {})
    const custom = yaml.load(generateDstackControllerValues({privateTls: {clusterDomain: 'cluster.example', port: 9443}})!) as any
    expect(custom.tls).to.deep.equal({clusterDomain: 'cluster.example', enabled: true, port: 9443})
    expect(dstackPrivateTlsUrl('dstack-controller', 'chain', {port: 9443})).to.equal('https://dstack-controller.chain.svc:9443')
  })

  it('rejects invalid inputs, other TLS owners and stale controller values', () => {
    for (const input of [{port: 3000}, {port: 443}, {port: 70_000}, {clusterDomain: 'Bad_Domain'}, {unknown: true}, []]) expect(() => validateDstackPrivateTls(input)).to.throw()
    expect(() => generateDstackControllerValues({ingress: {enabled: false}, privateTls: {}})).to.throw('not more than one')
    expect(() => generateDstackControllerValues({internalTls, privateTls: {}})).to.throw('not more than one')
    const values = yaml.load(generateDstackControllerValues({privateTls: {}})!) as any
    for (const stale of [{tls: {enabled: false}}, {tls: {enabled: true, port: 9443}}, {ingress: {enabled: true}}, {targetGroupBinding: {targetGroupARN: 'arn'}}]) {
      expect(() => assertDstackPrivateTlsValues({...values, ...stale}, {})).to.throw('differ from privateTls')
    }
  })

  it('accepts only parseable CA certificates and normalizes the bundle', () => {
    expect(dstackCaBundle(ca)).to.equal(ca.trim() + '\n')
    expect(dstackCaBundle(`${ca}\n${ca.replaceAll('\n', '\r\n')}`)).to.equal(`${ca.trim()}\n${ca.trim()}\n`)
    expect(() => dstackCaBundle(leaf)).to.throw('must contain CA certificates')
    expect(() => dstackCaBundle(`${ca}-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n`)).to.throw('only PEM CA certificates')
    expect(() => dstackCaBundle('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n')).to.throw('unparseable')
    expect(() => dstackCaBundle('')).to.throw('only PEM CA certificates')
  })

  it('reads only ca.crt through kubectl and reports a missing Secret as pending', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-kubectl-'))
    const log = path.join(bin, 'args')
    const originalPath = process.env.PATH
    const install = (body: string) => {
      fs.writeFileSync(path.join(bin, 'kubectl'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n${body}\n`)
      fs.chmodSync(path.join(bin, 'kubectl'), 0o755)
    }

    process.env.PATH = `${bin}${path.delimiter}${originalPath}`
    try {
      const target = {kubeContext: 'saved-cluster-context', namespace: 'chain', secret: 'dstack-controller-tls'}
      install(`printf '%s' '${Buffer.from(ca).toString('base64')}'`)
      expect(readDstackClusterCa(target)).to.equal(ca)
      expect(fs.readFileSync(log, 'utf8').trim().split('\n')).to.deep.equal(['--context', 'saved-cluster-context', '--namespace', 'chain', '--request-timeout', '30s', 'get', 'secret', 'dstack-controller-tls', '--ignore-not-found', '--output', String.raw`jsonpath={.data.ca\.crt}`])
      install('exit 0')
      expect(readDstackClusterCa(target)).to.equal(undefined)
      install("echo 'remote detail NONFUNCTIONAL_MARKER' >&2; exit 1")
      expect(() => readDstackClusterCa(target)).to.throw(DstackCaUnavailable, 'remote details omitted').with.property('message').that.does.not.include('NONFUNCTIONAL_MARKER')
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(bin, {force: true, recursive: true})
    }
  })

  it('requires private TLS chart versions for both releases', () => {
    const spec: any = {capacityManager: {}, dstackController: {privateTls: {}}}
    const pins = (manager: string, controller: string) => `CAPACITY_MANAGER_CHART_VERSION ?= ${manager}\nDSTACK_CONTROLLER_CHART_VERSION ?= ${controller}\n`
    expect(() => assertCapacityChartVersions(pins('0.1.7', '0.1.7'), spec)).to.throw('capacity-manager chart >= 0.1.8')
    expect(() => assertCapacityChartVersions(pins('0.1.8', '0.1.6'), spec)).to.throw('dstack-controller chart >= 0.1.7')
    expect(() => assertCapacityChartVersions(pins('0.1.8', '0.1.7'), spec)).not.to.throw()
    expect(() => assertCapacityChartVersions(pins('0.1.6', '0.1.0'), {capacityManager: {}} as any)).not.to.throw()
  })

  it('binds capacity-manager to the Service URL and the CA read from the cluster', () => {
    const input = capacityWorkerFixture()
    input.spec.dstackController = {enabled: true, privateTls: {}}
    input.spec.preparation!.dstack = {mode: 'external'}
    input.spec.proofTopology = {deployment: {}, generation: 'real', mode: 'active'} as any
    input.spec.capacityManager = {fleets: ['aws-l4'], gpu: 'L4', image: {digest: `sha256:${'c'.repeat(64)}`, repository: 'example.invalid/capacity-manager'}, project: 'isolated-aws', provider: 'aws', regions: ['us-east-1']}
    input.spec.infrastructure = {kubeContext: 'saved-cluster-context', namespace: 'chain'} as any
    input.imageCheck.cudaArchitectures = ['89']
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-private-tls-'))
    try {
      writeJson(path.join(root, '.scrollsdk/intent.json'), input.spec)
      fs.writeFileSync(path.join(root, '.scrollsdkignore'), '.scrollsdk/\n')
      writeJson(path.join(root, '.data/worker.json'), input.worker)
      writeJson(path.join(root, '.data/publication.json'), input.publication)
      writeJson(path.join(root, '.data/proof-worker-image-check-v1.json'), input.imageCheck)
      fs.mkdirSync(path.join(root, 'values'))
      const save = (service: string, value: any) => fs.writeFileSync(path.join(root, `values/${service}-production.yaml`), yaml.dump(value))
      save('capacity-manager', {fullnameOverride: 'capacity-manager', manager: {dstack: {serverUrl: 'https://dstack.example.invalid'}}})
      save('proof-coordinator', {persistence: {secrets: {name: 'deployment-proof-secrets'}}})
      save('dstack-controller', yaml.load(generateDstackControllerValues({auth: {existingSecret: 'controller-auth', key: 'admin-token'}, privateTls: {}})!))
      // As in the SDK template, which leaves the manager peer empty until capacity-manager preparation binds it.
      const peer = (name: string) => [{podSelector: {matchLabels: {'app.kubernetes.io/name': name}}}]
      save('withdrawal-processor', {networkPolicy: {allowFrom: {capacityManager: [], proofCoordinator: peer('proof-coordinator'), tso: peer('tso-service')}, enabled: true}, service: {main: {ports: {'proof-work': {enabled: true}}}}})
      const wpPath = path.join(root, 'values/withdrawal-processor-production.yaml')
      const finalWp = () => validateFinalValues({'withdrawal-processor-production.yaml': fs.readFileSync(wpPath, 'utf8')}, input.spec)
      expect(finalWp).to.throw('networkPolicy.allowFrom.capacityManager')
      const contract: any = {components: {proofCoordinator: {valuesFile: 'values/proof-coordinator-production.yaml'}, withdrawalProcessor: {valuesFile: 'values/withdrawal-processor-production.yaml'}}, generation: 'real', generationId: 'test-generation', inputs: {publication: {path: '.data/publication.json'}}, mode: 'active', worker: {contractFile: '.data/worker.json'}}
      const managerPath = path.join(root, 'values/capacity-manager-production.yaml')
      const original = fs.readFileSync(managerPath, 'utf8')
      const reads: DstackCaTarget[] = []

      // Before cert-manager issues the certificate, nothing is written.
      let pending: unknown
      try {prepareCapacityManager(root, () => contract, (target): string | undefined => {reads.push(target); return undefined})} catch (error) {pending = error}
      expect(pending).to.be.instanceOf(DstackCaPending).and.instanceOf(AwaitingInput)
      expect((pending as Error).message).to.include('make install-dstack-controller').and.include('in namespace chain')
      expect(fs.readFileSync(managerPath, 'utf8')).to.equal(original)
      expect(finalWp).to.throw('networkPolicy.allowFrom.capacityManager')
      expect(fs.existsSync(path.join(root, '.scrollsdk/capacity-manager/plan.json'))).to.equal(false)
      expect(reads).to.deep.equal([{kubeContext: 'saved-cluster-context', namespace: 'chain', secret: 'dstack-controller-tls'}])

      // Inside prep-charts, a pending or unreadable CA keeps the manager's files but still admits it in WP,
      // so the final values validate and the controller values can be installed.
      writeJson(path.join(root, '.data/proof-deployment.json'), {inputs: {publication: {path: '.data/publication.json'}}, schemaVersion: 8})
      expect(prepareCapacityManagerIfSelected(root, (): string | undefined => undefined, () => contract)).to.include('make install-dstack-controller')
      expect(fs.readFileSync(managerPath, 'utf8')).to.equal(original)
      expect(finalWp).not.to.throw()
      const unreachable = () => {throw new DstackCaUnavailable('Cannot read the dstack controller CA from Kubernetes')}
      expect(prepareCapacityManagerIfSelected(root, unreachable, () => contract)).to.include('Cannot read the dstack controller CA')
      expect(() => prepareCapacityManager(root, () => contract, unreachable)).to.throw(DstackCaUnavailable)
      expect(fs.readFileSync(managerPath, 'utf8')).to.equal(original)

      const result = prepareCapacityManager(root, () => contract, () => ca)
      const values = yaml.load(fs.readFileSync(result.valuesFile, 'utf8')) as any
      expect(values.manager.dstack.serverUrl).to.equal('https://dstack-controller.chain.svc:8443')
      expect(values.manager.dstack.caBundle).to.equal(ca.trim() + '\n')
      expect(values.initialization.privateDns).to.equal(true)
      const plan = JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/capacity-manager/plan.json'), 'utf8'))
      expect(plan.dstack.serverUrl).to.equal('https://dstack-controller.chain.svc:8443')
      expect(plan.privateDns).to.equal(true)

      // Once a CA is recorded, prep-charts keeps it when the cluster cannot confirm it, and still regenerates
      // everything else. The capacity-manager step itself keeps requiring a fresh read.
      const stale = yaml.load(fs.readFileSync(managerPath, 'utf8')) as any
      const {workerImage} = stale.manager
      fs.writeFileSync(managerPath, yaml.dump({...stale, manager: {...stale.manager, workerImage: 'example.invalid/stale@sha256:0'}}))
      expect(prepareCapacityManagerIfSelected(root, unreachable, () => contract)).to.include('regenerated').and.include('kept the dstack CA already recorded')
      const regenerated = yaml.load(fs.readFileSync(managerPath, 'utf8')) as any
      expect(regenerated.manager.workerImage).to.equal(workerImage)
      expect(regenerated.manager.dstack.caBundle).to.equal(ca.trim() + '\n')
      expect(prepareCapacityManagerIfSelected(root, (): string | undefined => undefined, () => contract)).to.include('was not found in namespace chain')
      expect(() => prepareCapacityManager(root, () => contract, unreachable)).to.throw(DstackCaUnavailable)
      // A recorded CA belongs to its server URL; another port defers instead of reusing it.
      writeJson(path.join(root, '.scrollsdk/intent.json'), {...input.spec, dstackController: {enabled: true, privateTls: {port: 9443}}})
      save('dstack-controller', yaml.load(generateDstackControllerValues({auth: {existingSecret: 'controller-auth', key: 'admin-token'}, privateTls: {port: 9443}})!))
      expect(prepareCapacityManagerIfSelected(root, unreachable, () => contract)).to.include('were not updated')
      writeJson(path.join(root, '.scrollsdk/intent.json'), input.spec)
      save('dstack-controller', yaml.load(generateDstackControllerValues({auth: {existingSecret: 'controller-auth', key: 'admin-token'}, privateTls: {}})!))

      expect(() => prepareCapacityManager(root, () => contract, () => leaf)).to.throw('must contain CA certificates')
      save('dstack-controller', yaml.load(generateDstackControllerValues({auth: {existingSecret: 'controller-auth', key: 'admin-token'}})!))
      expect(() => prepareCapacityManager(root, () => contract, () => ca)).to.throw('differ from privateTls')

      // Without a new endpoint owner, the saved Service URL would point at a closed port.
      writeJson(path.join(root, '.scrollsdk/intent.json'), {...input.spec, dstackController: {enabled: true}})
      expect(() => prepareCapacityManager(root, () => contract, () => ca)).to.throw('privateTls was removed')

      const connection = {mode: 'existing-https', serverUrl: 'https://dstack.example.invalid'} as const
      writeJson(path.join(root, '.scrollsdk/intent.json'), {...input.spec, capacityManager: {...input.spec.capacityManager, connection}})
      expect(() => prepareCapacityManager(root, () => contract, () => ca)).to.throw('Select one dstack TLS owner')

      // Leaving private TLS clears the stale CA instead of carrying it into the public endpoint.
      writeJson(path.join(root, '.scrollsdk/intent.json'), {...input.spec, capacityManager: {...input.spec.capacityManager, connection}, dstackController: {enabled: true}})
      const publicValues = yaml.load(fs.readFileSync(prepareCapacityManager(root, () => contract, () => ca).valuesFile, 'utf8')) as any
      expect(publicValues.manager.dstack.serverUrl).to.equal('https://dstack.example.invalid')
      expect(publicValues.manager.dstack.caBundle).to.equal('')

      writeJson(path.join(root, '.scrollsdk/intent.json'), {...input.spec, infrastructure: {namespace: 'chain'}})
      save('dstack-controller', yaml.load(generateDstackControllerValues({auth: {existingSecret: 'controller-auth', key: 'admin-token'}, privateTls: {}})!))
      expect(() => prepareCapacityManager(root, () => contract, () => ca)).to.throw('requires infrastructure.kubeContext')
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })
})
