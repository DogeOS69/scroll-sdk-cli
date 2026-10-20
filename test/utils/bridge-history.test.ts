/* eslint-disable @typescript-eslint/no-explicit-any -- Inspect generated Helm and private command state. */
import * as toml from '@iarna/toml'
import {Config} from '@oclif/core'
import bitcore from 'bitcore-lib-doge'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync, spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import GenSecrets from '../../src/commands/setup/gen-secrets.js'
import PrepCharts from '../../src/commands/setup/prep-charts.js'
import {HISTORY_SERVICE, HISTORY_VALUES, validateBridgeHistory} from '../../src/utils/bridge-history.js'
import {generateAllConfigs, normalizeDeploymentSpec} from '../../src/utils/deployment-spec-generator.js'
import {projectSharedAlbValues} from '../../src/utils/existing-alb.js'
import {mergeFrontendConfigDocuments} from '../../src/utils/frontend-deposit-config.js'
import {isRetiredServiceFile} from '../../src/utils/retired-services.js'
import {mergeBootstrapValues} from '../../src/utils/spec-bootstrap.js'
import {generateValuesFiles} from '../../src/utils/values-generator.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const certificateArn = 'arn:aws:acm:us-west-2:123456789012:certificate/00000000-0000-0000-0000-000000000000'
function fixture(): DeploymentSpec {
  const source = fs.readFileSync(path.join(root, 'test/fixtures/deployment-spec/minimal.yaml'), 'utf8')
    .replaceAll('$ENV:OWNER_ADDRESS', '0x0000000000000000000000000000000000000001')
    .replaceAll(/\$ENV:[A-Z_a-z]\w*/g, 'NONFUNCTIONAL_TEST_PLACEHOLDER')
  const spec = normalizeDeploymentSpec(yaml.load(source) as DeploymentSpec)
  spec.contracts.feeVaultDogeRecipientAddress = new bitcore.PrivateKey(null, bitcore.Networks.testnet).toAddress().toString()
  spec.bridgeHistory = {enabled: true}
  spec.images = {services: {dogeosBridgeHistory: {tag: 'test-history-release'}, frontends: {tag: 'test-activity-release'}}}
  spec.infrastructure.aws!.sharedAlb = {certificateArn, groupName: 'history-test', services: [HISTORY_SERVICE, 'frontends']}
  spec.dogecoin.indexerStartHeight = 123
  return spec
}

describe('DogeOS bridge history integration', () => {
  it('is opt-in and requires explicit images and a shared Portal edge', () => {
    const spec = fixture()
    delete spec.bridgeHistory
    expect(generateValuesFiles(spec)).not.to.have.property(HISTORY_VALUES)
    spec.bridgeHistory = {enabled: true}
    delete spec.images!.services!.dogeosBridgeHistory
    expect(() => validateBridgeHistory(spec)).to.throw('dogeosBridgeHistory.tag')
    spec.images!.services!.dogeosBridgeHistory = {tag: 'TODO_TAG_TO_REPLACE'}
    expect(() => validateBridgeHistory(spec)).to.throw('published release')
    spec.images!.services!.dogeosBridgeHistory.tag = 'test-history-release'
    spec.images!.services!.frontends!.tag = '0.3.0-test.20261011.4'
    expect(() => validateBridgeHistory(spec)).to.throw('Activity-enabled')
    spec.images!.services!.frontends!.tag = 'test-activity-release'
    spec.infrastructure.aws!.sharedAlb!.services = [HISTORY_SERVICE]
    expect(() => validateBridgeHistory(spec)).to.throw('same-origin')
  })

  it('projects network, indexer boundary, provider Secrets and the same-origin frontend URL', () => {
    const spec = fixture()
    const files = generateValuesFiles(spec)
    const values: any = yaml.load(files[HISTORY_VALUES])
    expect(values.config).to.deep.equal({dogecoin_indexer: {start_height: 123}, network: 'testnet'})
    const secret = values.externalSecrets[`${HISTORY_SERVICE}-secret-env`]
    expect(secret.provider).to.equal('aws')
    expect(secret.data.map((entry: any) => entry.secretKey)).to.deep.equal(['URL', 'USER', 'PASS'].map(key => `DOGEOS_BRIDGE_HISTORY_DOGECOIN_RPC__${key}`))
    expect(secret.data.every((entry: any) => entry.remoteRef.key.endsWith(`/${HISTORY_SERVICE}-secret-env`))).to.equal(true)
    const config = toml.parse((yaml.load(files['frontends-config.yaml']) as any).scrollConfig)
    expect(config.REACT_APP_HISTORY_API_URI).to.equal('/api/history/v1')
    expect(config).not.to.have.property('REACT_APP_BRIDGE_API_URI')
    const operator = {scrollConfig: 'REACT_APP_HISTORY_EXPECT_INCLUDED = "Custom words with spaces"\nREACT_APP_DEPOSIT_PITFALLS_URI = ""'}
    const merged: any = mergeFrontendConfigDocuments(operator, yaml.load(files['frontends-config.yaml']))
    expect(toml.parse(merged.scrollConfig).REACT_APP_HISTORY_EXPECT_INCLUDED).to.equal('Custom words with spaces')
    expect(toml.parse(generateAllConfigs(spec)['doge-config.toml']).bridgeHistory).to.deep.equal({enabled: true})
    spec.infrastructure = {bootnodeCount: 1, provider: 'local', sequencerCount: 1}
    const local: any = yaml.load(generateValuesFiles(spec)[HISTORY_VALUES])
    expect(local.externalSecrets).to.equal(null)
    expect((yaml.load(mergeBootstrapValues(yaml.dump(values), yaml.dump(local))) as any).externalSecrets).to.equal(null)
  })

  it('generates the real Secret key names from existing RPC credentials without reviving retired files', () => {
    const command = Object.assign(Object.create(GenSecrets.prototype), {
      dogeConfig: {bridgeHistory: {enabled: true}, dogecoinClusterRpc: {password: 'fake-password', username: 'fake-user'}, network: 'regtest'},
    })
    const files = command.generateEnvContent(HISTORY_SERVICE, {})
    expect(files[`${HISTORY_SERVICE}-secret.env`]).to.equal(
      'DOGEOS_BRIDGE_HISTORY_DOGECOIN_RPC__URL="http://dogecoin:18332"\nDOGEOS_BRIDGE_HISTORY_DOGECOIN_RPC__USER="fake-user"\nDOGEOS_BRIDGE_HISTORY_DOGECOIN_RPC__PASS="fake-password"\n')
    expect(isRetiredServiceFile(`${HISTORY_SERVICE}-secret.env`)).to.equal(false)
    command.dogeConfig.bridgeHistory.enabled = false
    expect(command.generateEnvContent(HISTORY_SERVICE, {})).to.deep.equal({})
  })

  it('preserves runtime policy and renders history ahead of Portal on the same ALB', () => {
    const spec = fixture()
    const files = generateValuesFiles(spec)
    const history: any = yaml.load(mergeBootstrapValues(
      yaml.dump({config: {dogecoin_indexer: {poll_interval_ms: 15_000}}, resources: {requests: {memory: '3Gi'}}}), files[HISTORY_VALUES]))
    projectSharedAlbValues(history, HISTORY_VALUES, spec)
    const portal: any = yaml.load(files['frontends-production.yaml'])
    projectSharedAlbValues(portal, 'frontends-production.yaml', spec)
    expect(history.config.dogecoin_indexer.poll_interval_ms).to.equal(15_000)
    expect(history.resources.requests.memory).to.equal('3Gi')
    const {annotations} = history.ingress.main
    expect(annotations['alb.ingress.kubernetes.io/group.name']).to.equal(portal.ingress.main.annotations['alb.ingress.kubernetes.io/group.name'])
    expect(annotations['alb.ingress.kubernetes.io/group.order']).to.equal('10')
    expect(portal.ingress.main.annotations['alb.ingress.kubernetes.io/group.order']).to.equal('100')
    expect(annotations['alb.ingress.kubernetes.io/healthcheck-path']).to.equal('/api/history/v1/live')
    expect(history.ingress.main.hosts[0]).to.deep.equal({host: spec.frontend.hosts.frontend, paths: [{path: '/api/history/v1', pathType: 'Prefix'}]})
    const before = structuredClone(history)
    projectSharedAlbValues(history, HISTORY_VALUES, spec)
    expect(history).to.deep.equal(before)
  })

  it('reconciles the indexer boundary twice without changing polling or storage', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-prep-'))
    try {
      const spec = fixture()
      const configs = generateAllConfigs(spec)
      const doge: any = toml.parse(configs['doge-config.toml'])
      doge.defaults.dogecoinIndexerStartHeight = 456
      const values: any = yaml.load(generateValuesFiles(spec)[HISTORY_VALUES])
      values.ingress.main.enabled = false
      values.config.dogecoin_indexer.poll_interval_ms = 15_000
      values.volumeClaimTemplates = [{name: 'data', size: '20Gi'}]
      const file = path.join(directory, HISTORY_VALUES)
      fs.writeFileSync(file, yaml.dump(values))
      const command: any = new PrepCharts([], await Config.load({root}))
      Object.assign(command, {configData: toml.parse(configs['config.toml']), dogeConfig: doge, flags: {},
        jsonCtx: {addWarning() {}, info() {}, logSuccess() {}}, jsonMode: true, log() {}, nonInteractive: true})
      await command.processProductionYaml(directory)
      const first = fs.readFileSync(file, 'utf8')
      const current: any = yaml.load(first)
      expect(current.config.dogecoin_indexer).to.deep.equal({poll_interval_ms: 15_000, start_height: 456})
      expect(current.volumeClaimTemplates[0].size).to.equal('20Gi')
      await command.processProductionYaml(directory)
      expect(fs.readFileSync(file, 'utf8')).to.equal(first)
    } finally {fs.rmSync(directory, {force: true, recursive: true})}
  })

  const charts = process.env.SDK_HISTORY_CHARTS
  ;(charts ? it : it.skip)('generates complete values from the pinned SDK through the CLI and preserves edits on rerun', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-generate-'))
    try {
      const spec = fixture()
      const sdk = path.resolve(charts!, '..')
      spec.templates = {sdkRevision: execFileSync('git', ['-C', sdk, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim()}
      const input = path.join(directory, 'intent.yaml')
      fs.writeFileSync(input, yaml.dump(spec))
      const run = () => {
        const result = spawnSync(process.execPath, [path.join(root, 'bin/run.js'), 'setup', 'generate-from-spec',
          '--spec', input, '--values-only', '--sdk-dir', sdk, '--output', directory, '--force', '--json'], {cwd: directory, encoding: 'utf8'})
        expect(result.status, result.stderr + result.stdout).to.equal(0)
      }

      run()
      const file = path.join(directory, 'values', HISTORY_VALUES)
      const values: any = yaml.load(fs.readFileSync(file, 'utf8'))
      expect(values.persistence.genesis.name).to.equal('genesis-config')
      expect(values.config.dogecoin_indexer.start_height).to.equal(123)
      expect(values.image.tag).to.equal('test-history-release')
      expect(values.ingress.main.annotations['alb.ingress.kubernetes.io/group.name']).to.equal('history-test')
      values.config.dogecoin_indexer.poll_interval_ms = 17_000
      fs.writeFileSync(file, yaml.dump(values))
      run()
      expect((yaml.load(fs.readFileSync(file, 'utf8')) as any).config.dogecoin_indexer.poll_interval_ms).to.equal(17_000)
    } finally {fs.rmSync(directory, {force: true, recursive: true})}
  })
  ;(charts ? it : it.skip)('renders the paired SDK StatefulSet and integer TOML', () => {
    const spec = fixture()
    const chart = path.join(charts!, HISTORY_SERVICE)
    const values: any = yaml.load(generateValuesFiles(spec)[HISTORY_VALUES])
    projectSharedAlbValues(values, HISTORY_VALUES, spec)
    const rendered = execFileSync('helm', ['template', 'history', chart, '-f', path.join(chart, 'values/production.yaml'), '-f', '-'], {encoding: 'utf8', input: yaml.dump(values)})
    const docs = yaml.loadAll(rendered) as any[]
    const pod = docs.find(doc => doc?.kind === 'StatefulSet').spec.template.spec
    expect(pod.enableServiceLinks).to.equal(false)
    const config = toml.parse(docs.find(doc => doc?.kind === 'ConfigMap').data['config.toml'])
    expect((config.dogecoin_indexer as any).start_height).to.equal(123)
    expect(pod.containers[0].readinessProbe.httpGet.path).to.equal('/api/history/v1/health')
    spec.infrastructure = {bootnodeCount: 1, provider: 'local', sequencerCount: 1}
    const local = execFileSync('helm', ['template', 'history', chart, '-f', path.join(chart, 'values/production.yaml'), '-f', '-'], {encoding: 'utf8', input: generateValuesFiles(spec)[HISTORY_VALUES]})
    expect((yaml.loadAll(local) as any[]).some(doc => doc?.kind === 'ExternalSecret')).to.equal(false)
  })
})
