/* eslint-disable @typescript-eslint/no-explicit-any -- Deployment parameters and migration of previously managed Grafana resources. */
import * as yaml from 'js-yaml'
import {isDeepStrictEqual} from 'node:util'

import {buildAlloyProbes, reconcileWebsocketContainer} from './status-page-alloy.js'
import {normalizeHealth, normalizeProbes} from './status-page-health.js'
import {normalizeMaintenance} from './status-page-maintenance.js'
import {normalizeNodeSync} from './status-page-node-sync.js'

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

/** Resolve deployment inputs. Health rules and timing defaults live in scroll-monitor. */
export function reconcileComponentPublication(values: any, config: any, readNodeValues?: (filename: string) => any): void {
  const publication = object(config.publication, 'statusPage.publication')
  fields(publication, ['components', 'delivery', 'health', 'heartbeat', 'incidents', 'maintenanceWindows', 'nodeSync', 'observationContactPointName', 'probes', 'sourceNamespace'], 'statusPage.publication')
  const sourceNamespace = publication.sourceNamespace ?? ''
  if (typeof sourceNamespace !== 'string' || (sourceNamespace !== '' && !/^[\da-z](?:[\da-z-]{0,61}[\da-z])?$/.test(sourceNamespace))) throw new Error('Invalid publication.sourceNamespace')
  const observation = text(publication.observationContactPointName ?? 'grafana-default-email', 'observationContactPointName')
  if (observation.startsWith('instatus-') || observation === config.grafana.contactPointName) throw new Error('Observation notifications must use an internal contact point, not Instatus')
  const components = object(publication.components, 'publication.components')
  fields(components, [...COMPONENT_KEYS], 'publication.components')
  const health = normalizeHealth(publication.health)
  const maintenanceWindows = normalizeMaintenance(publication.maintenanceWindows, COMPONENT_KEYS)
  const delivery = {enabled: true, image: 'python:3.12.11-alpine3.22', storageClassName: '', storageSize: '1Gi', ...object(publication.delivery, 'publication.delivery')}
  fields(delivery, ['enabled', 'image', 'storageClassName', 'storageSize'], 'publication.delivery')
  if (typeof delivery.enabled !== 'boolean') throw new Error('publication.delivery.enabled must be boolean')
  if (maintenanceWindows.length > 0 && !delivery.enabled) throw new Error('Maintenance suppression requires delivery.enabled')
  text(delivery.image, 'publication.delivery.image')
  if (typeof delivery.storageClassName !== 'string' || !/^(?:[\da-z][\d.a-z-]*)?$/.test(delivery.storageClassName)) throw new Error('Invalid delivery storage class')
  if (!/^[1-9]\d*(Mi|Gi)$/.test(delivery.storageSize)) throw new Error('Invalid delivery storage size')
  const heartbeat = {alertIds: [], enabled: false, publicIncident: true, ...object(publication.heartbeat, 'publication.heartbeat')}
  fields(heartbeat, ['enabled', 'alertIds', 'publicIncident'], 'publication.heartbeat')
  if (typeof heartbeat.publicIncident !== 'boolean' || typeof heartbeat.enabled !== 'boolean' || !Array.isArray(heartbeat.alertIds) || heartbeat.alertIds.some((id: unknown) => typeof id !== 'string' || !/^[\w-]+$/.test(id))) throw new Error('Invalid heartbeat configuration')
  if (heartbeat.enabled && heartbeat.alertIds.length === 0) throw new Error('Heartbeat requires Instatus monitor alert IDs for internal notifications')
  const incidents = {manageTemplates: false, notifySubscribers: false, ...object(publication.incidents, 'publication.incidents')}
  if ('affectedStatus' in incidents) throw new Error('Move publication.incidents.affectedStatus to components.<key>.affectedStatus after reviewing each rule; a global severity cannot represent every failure')
  fields(incidents, ['manageTemplates', 'notifySubscribers'], 'publication.incidents')
  if (typeof incidents.manageTemplates !== 'boolean' || typeof incidents.notifySubscribers !== 'boolean') throw new Error('Invalid public incident policy')
  const deliveryComponents: Record<string, any> = {}
  const probes = normalizeProbes(publication.probes, config.catalog, health)
  const alloy = probes.inputs.mode === 'alloy' ? buildAlloyProbes(probes.config, config.catalog) : undefined
  reconcileWebsocketContainer(values, alloy?.config, probes.inputs.websocketImage)
  if (alloy) {
    if (values.alloy?.enabled === false) throw new Error('Alloy probes require the bundled Alloy instance')
    for (const key of ['public-rpc', 'bridge-portal', 'block-explorer', 'sequencing', 'node-sync']) delete probes.missing[key]
    Object.assign(probes.missing, alloy.missing)
    // Do not advertise browser rendering or indexing freshness from basic HTTP checks.
    const descriptions: Record<string, string> = {
      'block-explorer': 'Availability of the Blockscout website and public API endpoints.',
      'bridge-portal': probes.config.bridgeApiRequired === false ? 'Availability of the bridge website over HTTPS.' : 'Availability of the bridge website and public API endpoints.',
      'public-rpc': 'Availability of the official HTTP and WebSocket JSON-RPC endpoints; expected chain ID and block-number responses.',
    }
    for (const component of config.catalog.components) if (descriptions[component.key]) component.description = descriptions[component.key]
  }

  const nodeSync = normalizeNodeSync(publication.nodeSync, config.catalog.chainId, config.environment, health, readNodeValues)
  if (nodeSync.config) {
    delete probes.missing['node-sync']
    if (probes.config.sequencingMode === 'continuous') delete probes.missing.sequencing
    // External sites do not receive private node addresses or emit competing canary evidence.
    probes.config.nodeRpcUrl = ''
    probes.config.nodeDependencyChecks = []
  }

  const normalized: Record<string, any> = {}
  const readiness: Record<string, any> = {}
  const envs: Record<string, any> = {}
  const previous = config.generated?.componentPublication
  const grafana = structuredClone(object(values.grafana, 'grafana'))
  grafana.envValueFrom = object(grafana.envValueFrom, 'grafana.envValueFrom')
  grafana.alerting = object(grafana.alerting, 'grafana.alerting')
  const datasourceUid = text(values.monitoring?.datasources?.prometheus?.uid ?? 'scroll-prometheus', 'Prometheus datasource UID')
  if (previous?.chainId && previous.chainId !== config.catalog.chainId) throw new Error('Component publication chain ID changed; use a separate deployment configuration')
  for (const key of COMPONENT_KEYS) {
    const input = object(components[key], `publication.components.${key}`)
    fields(input, ['affectedStatus', 'mode', 'rule'], `publication.components.${key}`)
    const mode = input.mode ?? 'automatic'
    if (!['automatic', 'manual', 'observe'].includes(mode)) throw new Error(`${key}: mode must be manual, observe or automatic`)
    const rule = object(input.rule, `${key}.rule`)
    fields(rule, ['builtin', 'expr', 'for'], `${key}.rule`)
    if (rule.builtin !== undefined && typeof rule.builtin !== 'boolean') throw new Error('rule.builtin must be boolean')
    if (rule.builtin && rule.expr) throw new Error(`${key}: choose builtin or a custom expression, not both`)
    if (rule.for !== undefined && (typeof rule.for !== 'string' || !/^[1-9]\d*[hms]$/.test(rule.for))) throw new Error(`${key}.rule.for must be a positive duration`)
    const expr = rule.expr ? text(rule.expr, `${key}.rule.expr`) : ''
    const missing = rule.builtin ? probes.missing[key] : expr ? undefined : 'missing-health-expression'
    if (mode === 'automatic' && missing) throw new Error(`${key}: automatic publication requires a component health expression or configured builtin: ${missing}`)
    if (mode === 'automatic' && !delivery.enabled) throw new Error('Automatic publication requires delivery.enabled: scroll-monitor runs the evaluator')
    if (alloy && mode === 'automatic' && !heartbeat.enabled) throw new Error('Alloy automatic publication requires heartbeat.enabled and internal Instatus heartbeat alertIds')
    const affectedStatus = input.affectedStatus || undefined
    if (affectedStatus && !['DEGRADEDPERFORMANCE', 'MAJOROUTAGE', 'PARTIALOUTAGE'].includes(affectedStatus)) throw new Error(`${key}: invalid affectedStatus`)
    if (mode === 'automatic' && incidents.manageTemplates && !affectedStatus) throw new Error(`${key}: automatic publication requires an explicit affectedStatus`)
    const selected = {...(rule.for ? {for: rule.for} : {}), ...(rule.builtin ? {builtin: true} : {builtin: false, ...(expr ? {expr} : {})})}
    normalized[key] = {...(affectedStatus ? {affectedStatus} : {}), mode, rule: selected}
    const identity = componentIdentity(key)
    const componentId = config.instatus.componentIds[key]
    const binding = config.generated?.componentBindings?.[key]
    if (binding && (binding.pageId !== config.instatus.pageId || binding.componentId !== componentId)) throw new Error(`${key}: saved webhook binding targets a different page or component`)
    readiness[key] = {...(affectedStatus ? {affectedStatus} : {}), ...(alloy && ['block-explorer', 'bridge-portal', 'public-rpc'].includes(key) ? {coverage: 'public-entrypoint'} : {}),
      componentId: componentId ?? '', mode, ready: mode === 'manual' || Boolean(!missing && (mode !== 'automatic' || binding)),
      reason: mode === 'manual' ? 'manual' : missing ?? (mode === 'automatic' && !binding ? 'apply-component-webhook' : 'configured'), ...identity}
    deliveryComponents[key] = {componentId: componentId ?? '', mode,
      name: config.catalog.components.find((item: any) => item.key === key).name, rule: selected, ...(missing ? {missing} : {}), pageId: config.instatus.pageId, webhookEnv: identity.envName}
    if (mode === 'automatic') envs[identity.envName] = {secretKeyRef: identity.secret}
  }

  if (heartbeat.enabled) envs.INSTATUS_MONITORING_HEARTBEAT_URL = {secretKeyRef: {key: 'url', name: 'instatus-monitoring-heartbeat'}}

  // Exact, reserved IDs only: remove the old public publisher without changing
  // internal alerts or the user's shared notification-policy tree. This cleanup
  // remains in subsequent generations so an upgrade/restart is idempotent.
  const oldRuleIds = [...COMPONENT_KEYS.flatMap(key => [`status-${key}`, `status-${key}-missing`]), 'status-monitoring-heartbeat', 'status-delivery-health']
  const oldReceiverIds = [...COMPONENT_KEYS.map(key => `instatus-${key}`), 'instatus-monitoring-heartbeat']
  const provisioning = {apiVersion: 1, deleteContactPoints: oldReceiverIds.map(uid => ({orgId: config.grafana.orgId, uid})),
    deleteRules: oldRuleIds.map(uid => ({orgId: config.grafana.orgId, uid}))}
  const actual = grafana.alerting[PUBLICATION_FILE]
  if (actual !== undefined && !isDeepStrictEqual(actual, provisioning) && !isDeepStrictEqual(actual, previous?.provisioning)) throw new Error('Component publication provisioning was configured independently')
  for (const [filename, value] of Object.entries(grafana.alerting)) {
    if (filename === PUBLICATION_FILE) continue
    let parsed: any
    try { parsed = typeof value === 'string' ? yaml.load(value) : value } catch { throw new Error('Invalid Grafana provisioning YAML') }
    for (const point of parsed?.contactPoints ?? []) if (point.receivers?.some((r: any) => oldReceiverIds.includes(r.uid))) throw new Error('Component contact point collides with another provisioning file')
    for (const group of parsed?.groups ?? []) if (group.rules?.some((r: any) => oldRuleIds.includes(r.uid))) throw new Error('Component health rule collides with another provisioning file')
  }

  for (const name of [...COMPONENT_KEYS.map(key => componentIdentity(key).envName), 'INSTATUS_MONITORING_HEARTBEAT_URL']) {
    if (grafana.env?.[name] !== undefined) throw new Error('Remove plaintext component webhook environment values')
    const actualEnv = grafana.envValueFrom[name]
    if (actualEnv && !isDeepStrictEqual(actualEnv, previous?.envs?.[name]) && !isDeepStrictEqual(actualEnv, envs[name])) throw new Error('Component webhook Secret reference was configured independently')
    delete grafana.envValueFrom[name]
  }

  grafana.alerting[PUBLICATION_FILE] = provisioning
  config.publication = {components: normalized, delivery, health, heartbeat, incidents, maintenanceWindows, nodeSync: nodeSync.inputs, observationContactPointName: observation, probes: probes.inputs, sourceNamespace}
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

  const deliveryConfig = {alloyProbes: alloy?.config ?? null, chainId: config.catalog.chainId, components: deliveryComponents, environment: config.environment, groupName: config.catalog.groupName, health,
    heartbeatEnabled: heartbeat.enabled, maintenanceWindows: maintenanceWindows.map(w => ({...w, end: Date.parse(w.end) / 1000, start: Date.parse(w.start) / 1000})), nodeSyncMode: nodeSync.inputs.mode, orgId: config.grafana.orgId, probeMode: probes.inputs.mode,
    prometheusUrl: values.monitoring?.datasources?.prometheus?.url ?? 'http://prometheus-prometheus:9090', schemaVersion: 3,
    sourceNamespace}
  config.generated = {...config.generated, alloyProbes: alloy?.config ?? null, componentPublication: structuredClone({alloyProbes: alloy?.config ?? null, chainId: config.catalog.chainId, datasourceUid, delivery: deliveryConfig, envs, inputs: config.publication, nodeSync: nodeSync.config, orgId: config.grafana.orgId, ...(probeScrape ? {probeScrape} : {}), provisioning, readiness}), delivery: deliveryConfig, environment: config.environment, nodeSync: nodeSync.config, probeConfig: probes.config, version: 3}
  values.grafana = grafana
}
