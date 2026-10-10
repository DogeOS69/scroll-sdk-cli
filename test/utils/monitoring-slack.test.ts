import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync, spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {reconcileMonitoringSlack, writeMonitoringSlackSecret} from '../../src/utils/monitoring-slack.js'

describe('spec Slack notification wiring', () => {
  let root: string
  beforeEach(() => {root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitoring-slack-'))})
  afterEach(() => {delete process.env.SLACK_WEBHOOK_URL; fs.rmSync(root, {force: true, recursive: true})})

  it('projects only Secret references and preserves unrelated provisioning', () => {
    process.env.SLACK_WEBHOOK_URL = 'must-never-appear-in-generated-values'
    const values: any = {grafana: {alerting: {'other.yaml': {apiVersion: 1}}, envValueFrom: {UNRELATED: {secretKeyRef: {key: 'value', name: 'other'}}}}}
    const changes = reconcileMonitoringSlack(values, {slack: {enabled: true}})
    expect(JSON.stringify({changes, values})).not.to.include(process.env.SLACK_WEBHOOK_URL)
    expect(values.grafana.alerting['other.yaml']).to.deep.equal({apiVersion: 1})
    expect(values.grafana.envValueFrom.DOGEOS_SLACK_WEBHOOK_URL.secretKeyRef).to.deep.equal({key: 'url', name: 'scroll-monitor-slack'})
    expect(values.grafana.alerting['dogeos-slack.yaml'].contactPoints[0].receivers[0].settings.url).to.equal('$DOGEOS_SLACK_WEBHOOK_URL')
    expect(reconcileMonitoringSlack(values, {slack: {enabled: true}})).to.deep.equal([])
    reconcileMonitoringSlack(values, {slack: {enabled: false}})
    expect(values.grafana.envValueFrom).not.to.have.property('DOGEOS_SLACK_WEBHOOK_URL')
    expect(values.grafana.envValueFrom).to.have.property('UNRELATED')
    expect(values.grafana.alerting['dogeos-slack.yaml'].deleteContactPoints).to.deep.equal([{orgId: 1, uid: 'dogeos-spec-slack'}])
  })

  it('preserves Grafana notification expressions through Helm tpl, including existing generated values', function () {
    if (spawnSync('helm', ['version', '--short']).status !== 0) this.skip()
    const values: any = {grafana: {alerting: {'dogeos-slack.yaml': {contactPoints: [{receivers: [{settings: {text: '{{ template "scroll-monitor.slack.text" . }}', title: 'Operator title'}, uid: 'dogeos-spec-slack'}]}]}}}}
    reconcileMonitoringSlack(values, {slack: {enabled: true}})
    fs.mkdirSync(path.join(root, 'templates'))
    fs.writeFileSync(path.join(root, 'Chart.yaml'), 'apiVersion: v2\nname: notification-test\nversion: 0.1.0\n')
    fs.writeFileSync(path.join(root, 'values.yaml'), yaml.dump(values))
    fs.writeFileSync(path.join(root, 'templates/config.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: notification-test\ndata:\n  provisioning: |\n{{ tpl (toYaml .Values.grafana.alerting) . | indent 4 }}\n')
    const rendered = yaml.load(execFileSync('helm', ['template', 'notification-test', root], {encoding: 'utf8'})) as any
    const provisioning = yaml.load(rendered.data.provisioning) as any
    const {settings} = provisioning['dogeos-slack.yaml'].contactPoints[0].receivers[0]
    expect(settings.text).to.equal('{{ template "scroll-monitor.slack.text" . }}')
    expect(settings.title).to.equal('Operator title')
    expect(settings.url).to.equal('$DOGEOS_SLACK_WEBHOOK_URL')
    expect(reconcileMonitoringSlack(values, {slack: {enabled: true}})).to.deep.equal([])
  })

  it('rejects missing, placeholder and untrusted webhook inputs without echoing them', () => {
    for (const value of ['', 'REPLACE_WITH_SLACK_WEBHOOK_URL', 'https://attacker.invalid/private-secret', 'https://hooks.slack.com.evil.invalid/services/a/b/private-secret']) {
      process.env.SLACK_WEBHOOK_URL = value
      let error: unknown
      try {writeMonitoringSlackSecret({slack: {enabled: true}}, root)} catch (error_) {error = error_}
      expect(String(error)).to.include('Set SLACK_WEBHOOK_URL')
      if (value) expect(String(error)).not.to.include(value)
      expect(fs.existsSync(path.join(root, 'secrets/scroll-monitor-slack.yaml'))).to.equal(false)
    }
  })

  it('writes a private Secret with a deliberately nonfunctional test webhook', () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T_FAKE_TEST/B_FAKE_TEST/nonfunctional-test-fixture'
    const file = writeMonitoringSlackSecret({slack: {enabled: true}}, root)!
    const secret = yaml.load(fs.readFileSync(file, 'utf8')) as any
    expect(secret.stringData.url).to.equal(process.env.SLACK_WEBHOOK_URL)
    expect(fs.statSync(file).mode % 0o1000).to.equal(0o600)
    expect(writeMonitoringSlackSecret({slack: {enabled: false}}, root)).to.equal(undefined)
  })

  it('does not silently configure a disabled Grafana', () => {
    expect(() => reconcileMonitoringSlack({grafana: {enabled: false}}, {slack: {enabled: true}})).to.throw('bundled Grafana')
  })

  it('follows the template Alertmanager backend, reference and channel without replacing policies', () => {
    const values: any = {
      alerting: {alertmanager: {slack: {channel: '#operator-channel', existingSecret: 'operator-slack', secretKey: 'webhook'}}, backend: 'prometheus'},
      'kube-prometheus-stack': {alertmanager: {alertmanagerSpec: {secrets: ['other-secret']}}},
      resourceAlerts: {memoryWarningPercent: 79},
    }
    reconcileMonitoringSlack(values, {slack: {enabled: true}})
    expect(values).not.to.have.property('grafana')
    expect(values.alerting.alertmanager.slack).to.deep.equal({channel: '#operator-channel', existingSecret: 'operator-slack', secretKey: 'webhook'})
    expect(values['kube-prometheus-stack'].alertmanager.alertmanagerSpec.secrets).to.deep.equal(['other-secret', 'operator-slack'])
    expect(values.resourceAlerts).to.deep.equal({memoryWarningPercent: 79})
    fs.mkdirSync(path.join(root, 'values'))
    fs.writeFileSync(path.join(root, 'values/scroll-monitor-production.yaml'), yaml.dump(values))
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T_FAKE_TEST/B_FAKE_TEST/nonfunctional-test-fixture'
    const file = writeMonitoringSlackSecret({slack: {enabled: true}}, root)!
    expect(path.basename(file)).to.equal('operator-slack.yaml')
    expect((yaml.load(fs.readFileSync(file, 'utf8')) as any).stringData.webhook).to.equal(process.env.SLACK_WEBHOOK_URL)
    reconcileMonitoringSlack(values, {slack: {enabled: false}})
    expect(values.alerting.alertmanager.slack.existingSecret).to.equal('')
  })
})
