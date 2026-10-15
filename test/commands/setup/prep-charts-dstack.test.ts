/* eslint-disable @typescript-eslint/no-explicit-any -- Exercise the command's staged generation pass. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import sinon from 'sinon'

import PrepCharts from '../../../src/commands/setup/prep-charts.js'
import {AwsCliRunner} from '../../../src/utils/aws-cli.js'
import {DSTACK_CONTROLLER_VALUES_FILE, generateDstackControllerValues} from '../../../src/utils/dstack-controller-values.js'
import {GenerationTransaction} from '../../../src/utils/generation-transaction.js'
import {internalTls} from '../../utils/dstack-internal-tls.test.js'

describe('setup prep-charts dstack controller', () => {
  let directory: string
  let command: any
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-dstack-'))
    command = Object.assign(Object.create(PrepCharts.prototype), {
      dstackController: {enabled: true},
      flags: {},
      jsonCtx: {logSuccess() {}},
      nonInteractive: true,
    })
  })
  afterEach(() => fs.rmSync(directory, {force: true, recursive: true}))

  it('creates production.yaml, regenerates on source change and is idempotent', async () => {
    const values = path.join(directory, 'values')
    const target = path.join(values, DSTACK_CONTROLLER_VALUES_FILE)
    expect(await command.processDstackControllerValues(values)).to.deep.equal({skipped: 0, updated: 2})
    expect(fs.readFileSync(target, 'utf8')).to.equal(generateDstackControllerValues({enabled: true}))
    expect(await command.processDstackControllerValues(values)).to.deep.equal({skipped: 2, updated: 0})
    command.dstackController.database = {type: 'sqlite'}
    expect(await command.processDstackControllerValues(values)).to.deep.equal({skipped: 1, updated: 1})
    expect(fs.readFileSync(target, 'utf8')).to.equal(generateDstackControllerValues(command.dstackController))
  })

  it('skips unconfigured/disabled controllers without deleting an existing file', async () => {
    const values = path.join(directory, 'values')
    await command.processDstackControllerValues(values)
    const target = path.join(values, DSTACK_CONTROLLER_VALUES_FILE)
    const before = fs.readFileSync(target, 'utf8')
    for (const config of [undefined, {enabled: false}]) {
      command.dstackController = config
      expect(await command.processDstackControllerValues(values)).to.deep.equal({skipped: 0, updated: 0})
      expect(fs.readFileSync(target, 'utf8')).to.equal(before)
    }
  })

  it('keeps generated values inside the prep-charts transaction until commit', async () => {
    const values = path.join(directory, 'values')
    const transaction = GenerationTransaction.begin(directory)
    try {
      await command.processDstackControllerValues(transaction.toStagingPath(values))
      expect(fs.existsSync(path.join(values, DSTACK_CONTROLLER_VALUES_FILE))).to.equal(false)
      transaction.commit()
      expect(fs.readFileSync(path.join(values, DSTACK_CONTROLLER_VALUES_FILE), 'utf8')).to.equal(generateDstackControllerValues(command.dstackController))
    } finally {
      transaction.rollback()
    }
  })

  it('does not replace existing values when configuration is invalid', async () => {
    const values = path.join(directory, 'values')
    await command.processDstackControllerValues(values)
    const target = path.join(values, DSTACK_CONTROLLER_VALUES_FILE)
    const before = fs.readFileSync(target, 'utf8')
    command.dstackController.replicaCount = 2
    try {
      await command.processDstackControllerValues(values)
      expect.fail('invalid config should fail')
    } catch (error) {
      expect(String(error)).to.include('replicaCount')
    }

    expect(fs.readFileSync(target, 'utf8')).to.equal(before)
  })

  it('loads controller-only specs without requiring proofTopology and honors source precedence', async () => {
    const originalDirectory = process.cwd()
    const doge = path.join(directory, 'doge.toml')
    const spec = path.join(directory, 'controller.yaml')
    fs.writeFileSync(doge, 'network = "testnet"\n[wallet]\npath = "test-wallet.json"\n[dstackController]\nenabled = false\n')
    fs.writeFileSync(spec, 'version: "1.0"\ninfrastructure:\n  namespace: chain\ndstackController:\n  enabled: true\n  database:\n    type: sqlite\n')
    Object.assign(command, {
      configData: {}, error(message: string) {throw new Error(message)}, jsonCtx: {info() {}, logSuccess() {}},
      warn() {},
    })
    try {
      process.chdir(directory)
      for (const flags of [{'doge-config': doge, spec}, {'doge-config': doge}]) {
        try {
          await command.loadConfigs(flags)
          expect.fail('fixture intentionally omits bridge-init output')
        } catch (error) {
          // Reaching the existing bridge prerequisite means both controller and
          // optional proof source loading completed without new prerequisites.
          expect(String(error)).to.include('run scrollsdk setup bridge-init first')
        }

        expect(command.dstackController).to.deep.equal('spec' in flags
          ? {database: {type: 'sqlite'}, enabled: true, monitoring: {namespace: 'chain'}} : {enabled: false})
      }
    } finally {
      process.chdir(originalDirectory)
    }
  })
  it('preserves a certificate configured in values across dstack preparation', async () => {
    const values = path.join(directory, 'values')
    const certificate = 'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000'
    command.dstackController.ingress = {annotations: {'alb.ingress.kubernetes.io/certificate-arn': certificate}, className: 'alb', enabled: true, hosts: ['dstack.example.invalid']}
    await command.processDstackControllerValues(values)
    command.dstackController.ingress.annotations['alb.ingress.kubernetes.io/certificate-arn'] = '<TODO>'
    await command.processDstackControllerValues(values)
    expect(fs.readFileSync(path.join(values, DSTACK_CONTROLLER_VALUES_FILE), 'utf8')).to.include(certificate)
    expect(fs.readFileSync(path.join(values, DSTACK_CONTROLLER_VALUES_FILE), 'utf8')).not.to.include('<TODO>')
  })

  it('checks managed certificate renewal and removes stale public ingress overrides before generation', async () => {
    const values = path.join(directory, 'values')
    await command.processDstackControllerValues(values)
    const target = path.join(values, DSTACK_CONTROLLER_VALUES_FILE)
    const existing = yaml.load(fs.readFileSync(target, 'utf8')) as any
    existing.ingress.annotations['alb.ingress.kubernetes.io/scheme'] = 'internet-facing'
    existing.ingress.annotations['alb.ingress.kubernetes.io/group.name'] = 'old-public-group'
    fs.writeFileSync(target, yaml.dump(existing))
    const before = fs.readFileSync(target, 'utf8')
    command.dstackController.internalTls = internalTls
    const read = sinon.stub(AwsCliRunner.prototype, 'json').throws(new Error('FAKE_PROVIDER_DETAIL'))
    try {
      try {await command.processDstackControllerValues(values); expect.fail('must reject')} catch (error) {expect(String(error)).to.include('provider details omitted')}
      expect(fs.readFileSync(target, 'utf8')).to.equal(before)
      read.returns({Certificate: {DomainValidationOptions: [{ValidationMethod: 'DNS', ValidationStatus: 'SUCCESS'}], NotAfter: (Date.now() + 86_400_000) / 1000, Status: 'ISSUED', SubjectAlternativeNames: [internalTls.hostname], Type: 'AMAZON_ISSUED'}})
      await command.processDstackControllerValues(values)
      const generated = yaml.load(fs.readFileSync(target, 'utf8')) as any
      expect(generated.ingress.annotations['alb.ingress.kubernetes.io/scheme']).to.equal('internal')
      expect(generated.ingress.annotations).not.to.have.property('alb.ingress.kubernetes.io/group.name')
      expect(await command.processDstackControllerValues(values)).to.deep.equal({skipped: 2, updated: 0})
    } finally {read.restore()}
  })

})
