/* eslint-disable @typescript-eslint/no-explicit-any -- Native Grafana provisioning and Helm values. */
import * as yaml from 'js-yaml'
import {isDeepStrictEqual} from 'node:util'

import {builtinHealth, normalizeHealth, normalizeProbes} from './status-page-health.js'

export const PUBLICATION_FILE = 'instatus-component-publication.yaml'
export const COMPONENT_KEYS = ['public-rpc', 'sequencing', 'deposits', 'withdrawals', 'batch-publication', 'node-sync', 'bridge-portal', 'block-explorer'] as const
export type ComponentKey = typeof COMPONENT_KEYS[number]

function object(value: any, name: string): Record<string, any> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a mapping`)
  return value
}

function fields(value: any, allowed: string[], name: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Unknown ${name} field; credentials must not be stored in values`)
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\n\r]/.test(value) || /<[A-Z_]+>/.test(value)) throw new Error(`${name} must be a configured string`)
  return value.trim()
}

export function componentIdentity(key: ComponentKey) {
  return {
    contactPointName: `instatus-${key}`,
    envName: `INSTATUS_${key.replaceAll('-', '_').toUpperCase()}_WEBHOOK_URL`,
    receiverUid: `instatus-${key}`,
    ruleUid: `status-${key}`,
    secret: {key: 'url', name: `instatus-${key}-webhook`},
  }
}

/** Component publication owns one provisioning file, never the shared notification-policy tree. */
export function reconcileComponentPublication(values: any, config: any): void {
  const publication = object(config.publication, 'statusPage.publication')
  fields(publication, ['components', 'delivery', 'health', 'heartbeat', 'incidents', 'observationContactPointName', 'probes'], 'statusPage.publication')
  const observation = text(publication.observationContactPointName ?? 'grafana-default-email', 'observationContactPointName')
  if (observation.startsWith('instatus-') || observation === config.grafana.contactPointName) throw new Error('Observation notifications must use an internal contact point, not Instatus')
  const components = object(publication.components, 'publication.components')
  fields(components, [...COMPONENT_KEYS], 'publication.components')
  const health = normalizeHealth(publication.health)
  const delivery = {enabled: false, image: 'python:3.12.11-alpine3.22', storageClassName: '', storageSize: '1Gi', ...object(publication.delivery, 'publication.delivery')}
  fields(delivery, ['enabled', 'image', 'storageClassName', 'storageSize'], 'publication.delivery')
  if (typeof delivery.enabled !== 'boolean') throw new Error('publication.delivery.enabled must be boolean')
  text(delivery.image, 'publication.delivery.image')
  if (typeof delivery.storageClassName !== 'string' || !/^(?:[\da-z][\d.a-z-]*)?$/.test(delivery.storageClassName)) throw new Error('Invalid delivery storage class')
  if (!/^[1-9]\d*(Mi|Gi)$/.test(delivery.storageSize)) throw new Error('Invalid delivery storage size')
  const heartbeat = {alertIds: [], enabled: false, ...object(publication.heartbeat, 'publication.heartbeat')}
  fields(heartbeat, ['enabled', 'alertIds'], 'publication.heartbeat')
  if (typeof heartbeat.enabled !== 'boolean' || !Array.isArray(heartbeat.alertIds) || heartbeat.alertIds.some((id: unknown) => typeof id !== 'string' || !/^[\w-]+$/.test(id))) throw new Error('Invalid heartbeat configuration')
  if (heartbeat.enabled && heartbeat.alertIds.length === 0) throw new Error('Heartbeat requires Instatus monitor alert IDs for internal notifications')
  const incidents = {affectedStatus: 'DEGRADEDPERFORMANCE', manageTemplates: false, notifySubscribers: false, ...object(publication.incidents, 'publication.incidents')}
  fields(incidents, ['affectedStatus', 'manageTemplates', 'notifySubscribers'], 'publication.incidents')
  if (!['DEGRADEDPERFORMANCE', 'MAJOROUTAGE', 'PARTIALOUTAGE'].includes(incidents.affectedStatus) || typeof incidents.manageTemplates !== 'boolean' || typeof incidents.notifySubscribers !== 'boolean') throw new Error('Invalid public incident policy')
  const deliveryComponents: Record<string, any> = {}
  const seconds = (duration: string) => Number(duration.slice(0, -1)) * ({h: 3600, m: 60, s: 1}[duration.slice(-1)] ?? 0)
  const probes = normalizeProbes(publication.probes, config.catalog, health)
  const normalized: Record<string, any> = {}
  const readiness: Record<string, any> = {}
  const envs: Record<string, any> = {}
  const points: any[] = []
  const rules: any[] = []
  const previous = config.generated?.componentPublication
  const grafana = structuredClone(object(values.grafana, 'grafana'))
  if (grafana.enabled === false) throw new Error('statusPage requires bundled Grafana')
  grafana.envValueFrom = object(grafana.envValueFrom, 'grafana.envValueFrom')
  grafana.alerting = object(grafana.alerting, 'grafana.alerting')
  const datasourceUid = text(values.monitoring?.datasources?.prometheus?.uid ?? 'scroll-prometheus', 'Prometheus datasource UID')
  if (previous?.chainId && previous.chainId !== config.catalog.chainId) throw new Error('Component publication chain ID changed; use a separate deployment configuration')
  for (const key of COMPONENT_KEYS) {
    const input = object(components[key], `publication.components.${key}`)
    fields(input, ['mode', 'rule'], `publication.components.${key}`)
    const mode = input.mode ?? 'observe'
    if (!['automatic', 'manual', 'observe'].includes(mode)) throw new Error(`${key}: mode must be manual, observe or automatic`)
    const rule = object(input.rule, `${key}.rule`)
    fields(rule, ['builtin', 'expr', 'for'], `${key}.rule`)
    if (rule.builtin !== undefined && typeof rule.builtin !== 'boolean') throw new Error(`${key}.rule.builtin must be boolean`)
    const builtin = rule.builtin === true
    if (builtin && rule.expr) throw new Error(`${key}: choose builtin or a custom expression, not both`)
    const expr = builtin ? probes.missing[key] ? '' : builtinHealth(key, config.environment, config.catalog.chainId, health) : rule.expr === undefined || rule.expr === '' ? '' : text(rule.expr, `${key}.rule.expr`)
    const pending = rule.for ?? health.failureFor
    if (typeof pending !== 'string' || !/^[1-9]\d*[hms]$/.test(pending)) throw new Error(`${key}.rule.for must be a positive duration`)
    if (mode === 'automatic' && !expr) throw new Error(`${key}: automatic publication requires a component health expression; missing observations cannot be published as healthy`)
    normalized[key] = {mode, rule: builtin ? {builtin: true, for: pending} : {builtin: false, expr, for: pending}}
    const identity = componentIdentity(key)
    const componentId = config.instatus.componentIds[key]
    const binding = config.generated?.componentBindings?.[key]
    if (binding && (binding.pageId !== config.instatus.pageId || binding.componentId !== componentId)) throw new Error(`${key}: saved webhook binding targets a different page or component; restore the original binding`)
    const bound = Boolean(binding && binding.componentId)
    readiness[key] = {componentId: componentId ?? '', mode, ready: mode === 'manual' || Boolean(expr && (mode !== 'automatic' || bound)),
      reason: mode === 'manual' ? 'manual' : expr ? mode === 'automatic' && !bound ? 'apply-component-webhook' : 'configured' : (builtin ? probes.missing[key] ?? 'missing-health-input' : 'missing-health-expression'),
      ...identity}
    // Preserve a previously managed receiver when disabling publication. The rule's
    // direct receiver switches to the internal point; no provisioned resource is deleted.
    if (mode === 'automatic' || previous?.envs?.[identity.envName]) {
      envs[identity.envName] = {secretKeyRef: identity.secret}
      points.push({name: identity.contactPointName, orgId: config.grafana.orgId, receivers: [{
        // Native resolved also occurs on rule lifecycle changes. The delivery
        // verifier confirms recovery independently; direct mode retains manual recovery.
        disableResolveMessage: true,
        settings: {httpMethod: 'POST', message: `${config.catalog.groupName}: service disruption detected.`, title: `${config.catalog.groupName} — ${config.catalog.components.find((item: any) => item.key === key).name} affected`,
          url: delivery.enabled ? `http://{{ printf "%s-status-delivery" .Release.Name | trunc 63 | trimSuffix "-" }}:9110/notify/${key}` : `$${identity.envName}`},
        type: 'webhook', uid: identity.receiverUid,
      }]})
    }

    const oldRule = previous?.provisioning?.groups?.[0]?.rules?.find((item: any) => item.uid === identity.ruleUid)
    if (!expr && !oldRule) continue
    // A single, label-free value is the contract: 0 healthy, 1 affected, absent
    // unknown. Reject non-binary/multiple results instead of hiding partial loss.
    const source = expr || 'vector(0)'
    const valid = `(count(${source}) == 1) and (count((${source}) == 0) == 1 or count((${source}) == 1) == 1)`
    const query = `(max(${source})) and (${valid})`
    const automatic = mode === 'automatic'
    if (automatic && delivery.enabled) deliveryComponents[key] = {
      componentId: componentId ?? '', expr: query, failureSeconds: seconds(pending),
      name: config.catalog.components.find((item: any) => item.key === key).name,
      pageId: config.instatus.pageId, recoverySeconds: seconds(health.recoveryFor), webhookEnv: identity.envName,
    }
    const common = {annotations: {summary: `${config.catalog.groupName} — ${key}: component health`},
      execErrState: 'KeepLast', for: pending, isPaused: mode === 'manual' || !expr,
      labels: {audience: automatic ? 'public-status' : 'status-observation', chain_id: config.catalog.chainId, component_key: key, environment: config.environment, managed_by: 'scroll-sdk-status-page'},
      noDataState: 'KeepLast',
      notification_settings: {group_by: ['alertname', 'grafana_folder'], group_interval: '1m', group_wait: '30s', receiver: automatic ? identity.contactPointName : observation, repeat_interval: '4h'},
    }
    const data = (expression: string) => [{datasourceUid, model: {datasource: {type: 'prometheus', uid: datasourceUid}, expr: expression, instant: true, range: false, refId: 'A'}, refId: 'A',
      relativeTimeRange: {from: 600, to: 0}},
    {datasourceUid: '__expr__', model: {expression: '$A > 0', refId: 'B', type: 'math'}, refId: 'B', relativeTimeRange: {from: 0, to: 0}}]
    rules.push({...common, condition: 'B', data: data(query), title: `${config.catalog.groupName} / ${key}`, uid: identity.ruleUid},
    {...common, condition: 'B', data: data(`absent(${query})`), execErrState: 'Alerting', labels: {...common.labels, audience: 'status-observation'},
      noDataState: 'OK', notification_settings: {...common.notification_settings, receiver: observation},
      title: `${config.catalog.groupName} / ${key} observation missing`, uid: `${identity.ruleUid}-missing`})
  }

  const deliveryActive = delivery.enabled && Object.keys(deliveryComponents).length > 0
  const heartbeatQuery = 'time() - max(timestamp(up)) < bool 120' + (deliveryActive ? ' and (time() - max(scroll_status_delivery_last_tick_seconds) < 120) and (max(scroll_status_delivery_error) == 0)' : '')
  if (heartbeat.enabled || previous?.provisioning?.groups?.[0]?.rules?.some((item: any) => item.uid === 'status-monitoring-heartbeat')) {
    envs.INSTATUS_MONITORING_HEARTBEAT_URL = {secretKeyRef: {key: 'url', name: 'instatus-monitoring-heartbeat'}}
    points.push({name: 'instatus-monitoring-heartbeat', orgId: config.grafana.orgId, receivers: [{disableResolveMessage: true, settings: {httpMethod: 'POST', url: '$INSTATUS_MONITORING_HEARTBEAT_URL'}, type: 'webhook', uid: 'instatus-monitoring-heartbeat'}]})
    rules.push({condition: 'B', data: [{datasourceUid, model: {expr: heartbeatQuery, instant: true, refId: 'A'}, refId: 'A', relativeTimeRange: {from: 600, to: 0}},
        {datasourceUid: '__expr__', model: {expression: '$A > 0', refId: 'B', type: 'math'}, refId: 'B', relativeTimeRange: {from: 0, to: 0}}], execErrState: 'OK', for: '0s', isPaused: !heartbeat.enabled,
      labels: {audience: 'monitoring-heartbeat'}, noDataState: 'OK', notification_settings: {group_by: ['alertname'], group_interval: '1m', group_wait: '0s', receiver: 'instatus-monitoring-heartbeat', repeat_interval: '1m'},
      title: `${config.catalog.groupName} / monitoring heartbeat`,
      uid: 'status-monitoring-heartbeat',
    })
  }

  if (deliveryActive || previous?.provisioning?.groups?.[0]?.rules?.some((item: any) => item.uid === 'status-delivery-health')) rules.push({
    annotations: {summary: 'Public status delivery needs operator attention'}, condition: 'B', data: [{datasourceUid, model: {expr: 'max(scroll_status_delivery_error) + max(scroll_status_delivery_pending) + (time() - max(scroll_status_delivery_last_tick_seconds) > bool 120) or absent(scroll_status_delivery_last_tick_seconds)', instant: true, refId: 'A'}, refId: 'A', relativeTimeRange: {from: 600, to: 0}},
      {datasourceUid: '__expr__', model: {expression: '$A > 0', refId: 'B', type: 'math'}, refId: 'B', relativeTimeRange: {from: 0, to: 0}}], execErrState: 'Alerting', for: '5m',
    isPaused: !deliveryActive, labels: {audience: 'status-observation', environment: config.environment, managed_by: 'scroll-sdk-status-page'},
    noDataState: 'Alerting',
    notification_settings: {group_by: ['alertname'], group_interval: '1m', group_wait: '30s', receiver: observation, repeat_interval: '1h'},
    title: `${config.catalog.groupName} / status delivery`, uid: 'status-delivery-health',
  })
  const provisioning = {apiVersion: 1, contactPoints: points, groups: [{folder: 'Public status', interval: '1m', name: 'component-health', orgId: config.grafana.orgId, rules}]}
  if (previous && previous.orgId !== config.grafana.orgId) throw new Error('Component publication Grafana orgId cannot change without explicit resource migration')
  const previousFile = previous?.provisioning
  const actual = grafana.alerting[PUBLICATION_FILE]
  if (actual !== undefined && !isDeepStrictEqual(actual, provisioning) && !isDeepStrictEqual(actual, previousFile)) throw new Error('Component publication provisioning was configured independently')
  for (const [name, env] of Object.entries(envs)) {
    if (grafana.env?.[name] !== undefined) throw new Error('Remove plaintext component webhook environment values')
    const actualEnv = grafana.envValueFrom[name]
    if (actualEnv !== undefined && !isDeepStrictEqual(actualEnv, env) && !isDeepStrictEqual(actualEnv, previous?.envs?.[name])) throw new Error('Component webhook Secret reference was configured independently')
    if (delivery.enabled && name !== 'INSTATUS_MONITORING_HEARTBEAT_URL') delete grafana.envValueFrom[name]
    else grafana.envValueFrom[name] = env
  }

  for (const [filename, value] of Object.entries(grafana.alerting)) {
    if (filename === PUBLICATION_FILE) continue
    let parsed: any
    try { parsed = typeof value === 'string' ? yaml.load(value) : value } catch { throw new Error('Invalid Grafana provisioning YAML') }
    for (const point of parsed?.contactPoints ?? []) {
      if (points.some(p => p.name === point.name || point.receivers?.some((r: any) => r.uid === p.receivers[0].uid))) throw new Error('Component contact point collides with another provisioning file')
    }

    for (const group of parsed?.groups ?? []) {
      if (group.rules?.some((r: any) => rules.some(rule => rule.uid === r.uid))) throw new Error('Component health rule collides with another provisioning file')
    }
  }

  grafana.alerting[PUBLICATION_FILE] = provisioning
  config.publication = {components: normalized, delivery, health, heartbeat, incidents, observationContactPointName: observation, probes: probes.inputs}
  const scrapeName = 'status-page-external-probes'
  const stack = structuredClone(values['kube-prometheus-stack'] ?? {})
  const rawJobs = stack.prometheus?.prometheusSpec?.additionalScrapeConfigs ?? []
  const jobs = Array.isArray(rawJobs) ? rawJobs : []
  if ((probes.inputs.metricsTargets.length > 0 || previous?.probeScrape) && !Array.isArray(rawJobs)) throw new Error('Status-page probe scrape generation requires array additionalScrapeConfigs; use existing federation with metricsTargets: []')
  const managedJobs = jobs.filter((job: any) => job.job_name === scrapeName)
  const probeScrape = probes.inputs.metricsTargets.length > 0 ? {job_name: scrapeName, scrape_interval: '30s', scrape_timeout: '10s', static_configs: [{targets: [...new Set(probes.inputs.metricsTargets)].sort()}]} : undefined
  if (managedJobs.length > 1 || (managedJobs.length > 0 && !isDeepStrictEqual(managedJobs[0], previous?.probeScrape) && !isDeepStrictEqual(managedJobs[0], probeScrape))) throw new Error('External probe scrape job was configured independently')
  if (probeScrape || previous?.probeScrape) {
    stack.prometheus ??= {}
    stack.prometheus.prometheusSpec ??= {}
    stack.prometheus.prometheusSpec.additionalScrapeConfigs = [...jobs.filter((job: any) => job.job_name !== scrapeName), ...(probeScrape ? [probeScrape] : [])]
    values['kube-prometheus-stack'] = stack
  }

  const deliveryConfig = {chainId: config.catalog.chainId, components: deliveryComponents, environment: config.environment,
    groupName: config.catalog.groupName, intervalSeconds: 30, orgId: config.grafana.orgId,
    prometheusUrl: values.monitoring?.datasources?.prometheus?.url ?? 'http://prometheus-prometheus:9090'}
  config.generated = {...config.generated, componentPublication: structuredClone({chainId: config.catalog.chainId, datasourceUid, delivery: deliveryConfig, envs, inputs: config.publication, orgId: config.grafana.orgId, ...(probeScrape ? {probeScrape} : {}), provisioning, readiness}), delivery: deliveryConfig, environment: config.environment, probeConfig: probes.config, version: 2}
  values.grafana = grafana
}
