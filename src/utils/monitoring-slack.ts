import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'

import {writeGrafanaPrivateFile} from './grafana-admin.js'

export interface MonitoringConfig {
  slack?: {enabled: boolean}
}

export const SLACK_SECRET = 'scroll-monitor-slack'
const ENV_NAME = 'DOGEOS_SLACK_WEBHOOK_URL'
const PROVISIONING_FILE = 'dogeos-slack.yaml'

function secretReference(values: Record<string, any>): {key: string; name: string} {
  const am = values.alerting?.alertmanager?.slack
  const reference = values.alerting?.backend === 'prometheus'
    ? {key: am?.secretKey || 'url', name: am?.existingSecret || SLACK_SECRET}
    : values.grafana?.envValueFrom?.[ENV_NAME]?.secretKeyRef ?? {key: 'url', name: SLACK_SECRET}
  if (!/^[\da-z]+(?:[.-][\da-z]+)*$/.test(reference.name) || !/^[\w.-]+$/.test(reference.key)) throw new Error('Invalid monitoring Slack Secret reference in the values template')
  return reference
}

export function validateMonitoring(config?: MonitoringConfig): void {
  if (config?.slack && typeof config.slack.enabled !== 'boolean') throw new Error('monitoring.slack.enabled must be a boolean')
}

/** Project only references. Never resolve the webhook while generating values. */
export function reconcileMonitoringSlack(values: Record<string, any>, config?: MonitoringConfig): Array<{key: string; newValue: string; oldValue: string}> {
  validateMonitoring(config)
  if (!config?.slack) return []
  const next = structuredClone(values)
  const reference = secretReference(next)
  if (next.alerting?.backend === 'prometheus') {
    next.alerting.alertmanager ??= {}
    next.alerting.alertmanager.slack ??= {}
    Object.assign(next.alerting.alertmanager.slack, {existingSecret: config.slack.enabled ? reference.name : '', secretKey: reference.key})
    if (config.slack.enabled) {
      next['kube-prometheus-stack'] ??= {}
      next['kube-prometheus-stack'].alertmanager ??= {}
      const am = next['kube-prometheus-stack'].alertmanager
      am.alertmanagerSpec ??= {}
      am.alertmanagerSpec.secrets = [...new Set([...(am.alertmanagerSpec.secrets ?? []), reference.name])]
    }
  } else {
    next.grafana ??= {}
    next.grafana.envValueFrom ??= {}
    next.grafana.alerting ??= {}
    if (config.slack.enabled) {
      if (next.grafana.enabled === false) throw new Error('monitoring.slack requires bundled Grafana')
      const contactPointName = next.grafanaAlerting?.defaultContactPoint?.name || 'slack-alerts'
      const existing = next.grafana.alerting[PROVISIONING_FILE]?.contactPoints?.flatMap((point: any) => point.receivers ?? []).find((receiver: any) => receiver.uid === 'dogeos-spec-slack')
      next.grafana.envValueFrom[ENV_NAME] = {secretKeyRef: reference}
      next.grafana.alerting[PROVISIONING_FILE] = {
        apiVersion: 1,
        contactPoints: [{name: contactPointName, orgId: 1, receivers: [{
          disableResolveMessage: false,
          ...existing,
          settings: {
            text: '{{ template "scroll-monitor.slack.text" . }}',
            title: '{{ template "scroll-monitor.slack.title" . }}',
            ...existing?.settings,
            url: `$${ENV_NAME}`,
          },
          type: 'slack', uid: 'dogeos-spec-slack',
        }]}],
      }
      next.grafanaAlerting ??= {}
      next.grafanaAlerting.defaultContactPoint = {...next.grafanaAlerting.defaultContactPoint, enabled: true, name: contactPointName}
    } else {
      delete next.grafana.envValueFrom[ENV_NAME]
      // Explicitly remove only the integration owned by this spec on upgrade.
      next.grafana.alerting[PROVISIONING_FILE] = {apiVersion: 1, deleteContactPoints: [{orgId: 1, uid: 'dogeos-spec-slack'}]}
    }
  }

  if (isDeepStrictEqual(values, next)) return []
  Object.assign(values, next)
  return [{key: 'monitoring.slack', newValue: config.slack.enabled ? 'enabled (Secret reference)' : 'disabled', oldValue: '[previous configuration]'}]
}

/** The operator has one fixed private env input, independent of the spec schema. */
export function writeMonitoringSlackSecret(config: MonitoringConfig | undefined, root: string): string | undefined {
  validateMonitoring(config)
  if (!config?.slack?.enabled) return undefined
  const webhook = process.env.SLACK_WEBHOOK_URL?.trim()
  let valid = false
  try {
    const url = new URL(webhook ?? '')
    valid = url.protocol === 'https:' && ['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && !url.port
      && /^\/services(?:\/[\w-]+){3}$/.test(url.pathname)
  } catch { /* Report the field name, never its contents. */ }

  if (!valid || /replace|todo|example/i.test(webhook ?? '')) throw new Error('Set SLACK_WEBHOOK_URL in private deployment.env to a valid Slack incoming webhook URL')
  const valuesFile = path.join(root, 'values/scroll-monitor-production.yaml')
  const values = fs.existsSync(valuesFile) ? yaml.load(fs.readFileSync(valuesFile, 'utf8')) as Record<string, any> : {}
  const reference = secretReference(values ?? {})
  const file = path.join(root, 'secrets', `${reference.name}.yaml`)
  writeGrafanaPrivateFile(file, yaml.dump({apiVersion: 'v1', kind: 'Secret', metadata: {name: reference.name}, stringData: {[reference.key]: webhook}, type: 'Opaque'}))
  return file
}
