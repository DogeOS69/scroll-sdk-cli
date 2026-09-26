/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values are dynamic YAML mappings. */
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {isDeepStrictEqual} from 'node:util'

import {reconcileComponentPublication} from './status-page-publication.js'

const ENV_NAME = 'INSTATUS_GRAFANA_WEBHOOK_URL'
const PROVISIONING_FILE = 'instatus-contact-points.yaml'
const GROUPS: Record<string, string> = {devnet: 'Devnet', mainnet: 'Mainnet', testnet: 'Testnet'}
const BRAND = 'https://raw.githubusercontent.com/DogeOS69/web-images/main'
const CATALOG = [
  ['public-rpc', 'Public RPC', 'Official HTTP JSON-RPC and enabled WebSocket interfaces.'],
  ['sequencing', 'Transaction Sequencing', 'Inclusion of accepted transactions in new blocks.'],
  ['deposits', 'Deposits', 'DOGE deposits after the required confirmations.'],
  ['withdrawals', 'Withdrawals', 'DOGE withdrawal processing and confirmation.'],
  ['batch-publication', 'Batch Publication', 'Publication of batch data to the configured data availability layer.'],
  ['node-sync', 'Node Sync', 'Network data and services needed for supported nodes to synchronize.'],
  ['bridge-portal', 'Bridge Portal', 'The bridge website and its supporting API.'],
  ['block-explorer', 'Block Explorer', 'Availability and indexing freshness of the deployed Blockscout explorer.'],
] as const

interface Inputs {
  chainId: unknown
  environment: unknown
  networkName: unknown
  valuesDir: string
}

function mapping(value: any, field: string): Record<string, any> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be a mapping`)
  return value
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('<TODO>') || /[\n\r]/.test(value)) {
    throw new Error(`${field} must be a nonempty configured string`)
  }

  return value.trim()
}

function readValues(directory: string, filename: unknown, field: string): Record<string, any> {
  const name = requiredString(filename, field)
  const root = fs.realpathSync(directory)
  const requested = path.resolve(root, name)
  const inside = (candidate: string) => {
    const relative = path.relative(root, candidate)
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }

  if (!inside(requested) || !fs.existsSync(requested) || !inside(fs.realpathSync(requested))) {
    throw new Error(`${field} must select an existing values file inside the values directory`)
  }

  try {
    return mapping(yaml.load(fs.readFileSync(requested, 'utf8')), field)
  } catch {
    throw new Error(`${field} must select a valid YAML mapping`)
  }
}

function enabled(value: unknown, field: string): boolean {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`${field} must be a boolean`)
  return value !== false
}

function endpoint(host: unknown, scheme: string, suffix: string, field: string): string {
  const name = requiredString(host, field)
  // These become public metadata. Do not accept credentials, queries or wildcard hosts.
  if (!/^[\da-z](?:[\d.a-z-]*[\da-z])?(?::\d+)?$/i.test(name) || name.includes('..') || name.endsWith('.scrollsdk') || name === 'localhost') {
    throw new Error(`${field} must contain a configured ingress hostname without credentials, wildcards or paths`)
  }

  const url = new URL(`${scheme}://${name}${suffix}`)
  return url.href
}

function ingressUrls(source: any, key: string, scheme: string, suffix: string, field: string, optional = false): string[] {
  const ingress = mapping(source.ingress, `${field}.ingress`)
  const entry = mapping(ingress[key], `${field}.ingress.${key}`)
  // Missing WebSocket configuration does not opt into a nonexistent interface.
  if (optional && ingress[key] === undefined) return []
  if (!enabled(entry.enabled, `${field}.ingress.${key}.enabled`)) {
    if (optional) return []
    throw new Error(`${field} selects a disabled ingress`)
  }

  if (!Array.isArray(entry.hosts) || entry.hosts.length === 0) throw new Error(`${field} requires ingress hosts`)
  return [...new Set(entry.hosts.map((host: any) => {
    if (!Array.isArray(host?.paths) || !host.paths.some((route: any) => route.path === '/' || route.path === suffix)) {
      throw new Error(`${field} requires an explicit external path matching its ingress (rewrite paths need a reviewed override)`)
    }

    return endpoint(host.host, scheme, suffix, field)
  }))].sort()
}

/** Generate native Grafana configuration and a public component catalog from one deployment. */
export function reconcileScrollMonitorStatusPage(values: any, inputs: Inputs): Array<{key: string; newValue: string; oldValue: string}> {
  if (values.statusPage === undefined) return []
  const options = mapping(values.statusPage, 'statusPage')
  if (typeof options.enabled !== 'boolean') throw new Error('statusPage.enabled must be a boolean')
  if (!options.enabled) {
    // Turning generation off must not falsely claim to delete provisioned Grafana resources.
    if (options.generated) throw new Error('statusPage was generated: remove its contact point in Grafana and its generated configuration before disabling')
    return []
  }

  const environment = requiredString(inputs.environment, 'statusPage.environment')
  if (!['devnet', 'mainnet', 'testnet'].includes(environment)) throw new Error('statusPage requires an explicit mainnet, testnet or devnet environment')
  const networkName = requiredString(inputs.networkName, 'general.CHAIN_NAME_L2')
  const chain = String(inputs.chainId ?? '')
  if ((typeof inputs.chainId === 'number' && !Number.isSafeInteger(inputs.chainId)) || !/^(?:\d+|0x[\da-f]+)$/i.test(chain) || BigInt(chain) <= 0n) {
    throw new Error('general.CHAIN_ID_L2 must be a positive chain ID for statusPage')
  }

  const config = structuredClone(options)
  for (const key of Object.keys(config)) {
    if (!['catalog', 'enabled', 'environment', 'generated', 'grafana', 'instatus', 'publication', 'sources'].includes(key)) throw new Error('Unknown statusPage field; credentials belong in Secrets or INSTATUS_API_KEY, not values')
  }

  config.environment = environment
  if (config.generated && config.generated.environment !== environment) throw new Error('statusPage environment changed; use a separate monitoring configuration and Instatus target for each environment')
  config.instatus = {branding: {faviconUrl: `${BRAND}/dogeos_favicon.png`, websiteUrl: 'https://www.dogeos.com/'}, componentIds: {}, email: '', groupId: '', initialStatus: 'OPERATIONAL', pageId: '', pageName: 'DogeOS', showUptime: false, subdomain: 'dogeos', workspaceSlug: '6wxpx', ...mapping(config.instatus, 'statusPage.instatus')}
  for (const key of Object.keys(config.instatus)) {
    if (!['branding', 'componentIds', 'email', 'groupId', 'initialStatus', 'pageId', 'pageName', 'showUptime', 'subdomain', 'workspaceSlug'].includes(key)) throw new Error('Unknown statusPage.instatus field; management API credentials belong in INSTATUS_API_KEY')
  }

  if (!config.instatus.subdomain) config.instatus.subdomain = 'dogeos'
  if (['dogeos-devnet', 'dogeos-testnet'].includes(config.instatus.subdomain)) {
    throw new Error('Separate network pages require migration to the shared dogeos page; see docs/status-page.md before replacing page, component and webhook bindings')
  }

  config.instatus.pageName = requiredString(config.instatus.pageName, 'statusPage.instatus.pageName')
  const branding = mapping(config.instatus.branding, 'statusPage.instatus.branding')
  for (const [key, value] of Object.entries(branding)) {
    if (!['faviconUrl', 'logoUrl', 'websiteUrl'].includes(key)) throw new Error('Unknown statusPage.instatus.branding field')
    let url: URL
    try { url = new URL(value) } catch { throw new Error('Branding must contain public HTTPS URLs') }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Branding must contain public HTTPS URLs without credentials, query or fragment')
  }

  if (typeof config.instatus.showUptime !== 'boolean') throw new Error('statusPage.instatus.showUptime must be a boolean')
  config.sources = {
    blockscout: 'blockscout-production.yaml',
    bridgePath: '/bridge',
    frontends: 'frontends-production.yaml',
    publicRpc: 'l2-reth-rpc-public-production.yaml',
    scheme: 'https',
    ...mapping(config.sources, 'statusPage.sources'),
  }
  const {sources} = config
  for (const key of Object.keys(sources)) {
    if (!['blockscout', 'bridgePath', 'frontends', 'publicRpc', 'scheme'].includes(key)) throw new Error('Unknown statusPage.sources field')
  }

  if (!['http', 'https'].includes(sources.scheme)) throw new Error('statusPage.sources.scheme must be http or https')
  if (typeof sources.bridgePath !== 'string' || !/^\/[\w/-]*$/.test(sources.bridgePath) || sources.bridgePath.startsWith('//')) {
    throw new Error('statusPage.sources.bridgePath must be an absolute path without query or credentials')
  }

  const frontends = readValues(inputs.valuesDir, sources.frontends, 'statusPage.sources.frontends')
  const rpc = readValues(inputs.valuesDir, sources.publicRpc, 'statusPage.sources.publicRpc')
  const explorer = readValues(inputs.valuesDir, sources.blockscout, 'statusPage.sources.blockscout')
  const bridgeUrls = ingressUrls(frontends, 'main', sources.scheme, sources.bridgePath, 'frontends')
  const rpcUrls = ingressUrls(rpc, 'main', sources.scheme, '/', 'publicRpc')
  const wsUrls = ingressUrls(rpc, 'websocket', sources.scheme === 'https' ? 'wss' : 'ws', '/', 'publicRpc', true)
  const explorerIngress = explorer['blockscout-stack']?.frontend?.ingress
  if (!explorerIngress || !enabled(explorerIngress.enabled, 'blockscout frontend ingress.enabled')) throw new Error('statusPage requires an enabled Blockscout frontend ingress')
  const explorerUrl = endpoint(explorerIngress.hostname, sources.scheme, '/', 'Blockscout frontend ingress.hostname')

  config.grafana = {
    contactPointName: 'instatus-public',
    orgId: 1,
    receiverUid: 'instatus-public-webhook',
    ...mapping(config.grafana, 'statusPage.grafana'),
  }
  const target = config.grafana
  for (const key of Object.keys(target)) {
    if (!['contactPointName', 'orgId', 'receiverUid', 'webhookSecretRef'].includes(key)) throw new Error('Unknown statusPage.grafana field; webhook credentials belong in the referenced Secret')
  }

  if (!Number.isSafeInteger(target.orgId) || target.orgId <= 0) throw new Error('statusPage.grafana.orgId must be a positive integer')
  target.contactPointName = requiredString(target.contactPointName, 'statusPage.grafana.contactPointName')
  if (typeof target.receiverUid !== 'string' || !/^[\w-]{1,40}$/.test(target.receiverUid)) throw new Error('statusPage.grafana.receiverUid must be a valid Grafana UID')
  target.webhookSecretRef = {key: 'url', name: 'instatus-grafana-webhook', ...mapping(target.webhookSecretRef, 'statusPage.grafana.webhookSecretRef')}
  const secret = target.webhookSecretRef
  if (Object.keys(secret).some(key => !['key', 'name'].includes(key))) throw new Error('statusPage webhookSecretRef contains only name and key, never the credential value')
  if (typeof secret.name !== 'string' || secret.name.length > 253 || secret.name.split('.').some((label: string) => label.length > 63 || !/^[\da-z](?:[\da-z-]*[\da-z])?$/.test(label))) throw new Error('statusPage webhook Secret name must be a Kubernetes name')
  if (typeof secret.key !== 'string' || secret.key.length > 253 || !/^[\w.-]+$/.test(secret.key)) throw new Error('statusPage webhook Secret key must be a Kubernetes data key')
  if (config.generated?.appliedPageId && config.generated.appliedPageId !== config.instatus.pageId) throw new Error('statusPage was applied to a different Instatus page; use a separate configuration for a new target')
  const oldPoint = config.generated?.provisioning?.contactPoints?.[0]
  if (oldPoint && (oldPoint.name !== target.contactPointName || oldPoint.orgId !== target.orgId || oldPoint.receivers?.[0]?.uid !== target.receiverUid)) {
    throw new Error('Changing an existing statusPage Grafana identity requires explicit removal of the old contact point and generated ownership metadata first')
  }

  const backendIngress = explorer['blockscout-stack']?.blockscout?.ingress
  const explorerApiUrls = backendIngress?.enabled === true && backendIngress.hostname
    ? [endpoint(backendIngress.hostname, sources.scheme, '/', 'Blockscout backend ingress.hostname')] : []
  const endpoints: Record<string, string[]> = {'block-explorer': [explorerUrl], 'bridge-portal': bridgeUrls, 'public-rpc': [...rpcUrls, ...wsUrls]}
  config.catalog = {
    chainId: BigInt(chain).toString(),
    components: CATALOG.map(([key, name, description]) => ({description, endpoints: endpoints[key] ?? [], key, name})),
    environment,
    groupName: GROUPS[environment],
    networkName,
    pageName: config.instatus.pageName,
    probeSources: {explorerApiUrls},
    provider: 'instatus',
  }
  if (config.publication !== undefined || config.generated?.version === 2) {
    const candidate = structuredClone(values)
    reconcileComponentPublication(candidate, config)
    if (isDeepStrictEqual(config, values.statusPage) && isDeepStrictEqual(candidate.grafana, values.grafana) && isDeepStrictEqual(candidate['kube-prometheus-stack'], values['kube-prometheus-stack'])) return []
    values.statusPage = config
    values.grafana = candidate.grafana
    if (candidate['kube-prometheus-stack'] !== undefined) values['kube-prometheus-stack'] = candidate['kube-prometheus-stack']
    return [{key: 'statusPage component publication', newValue: '[component modes, rules and Secret references]', oldValue: '[previous configuration]'}]
  }

  const grafana = structuredClone(mapping(values.grafana, 'grafana'))
  if (grafana.enabled === false) throw new Error('statusPage requires bundled Grafana for native provisioning')
  grafana.envValueFrom = mapping(grafana.envValueFrom, 'grafana.envValueFrom')
  grafana.alerting = mapping(grafana.alerting, 'grafana.alerting')
  const env = {secretKeyRef: structuredClone(secret)}
  const provisioning = {
    apiVersion: 1,
    contactPoints: [{name: target.contactPointName, orgId: target.orgId, receivers: [{
      disableResolveMessage: false,
      settings: {httpMethod: 'POST', url: `$${ENV_NAME}`},
      type: 'webhook',
      uid: target.receiverUid,
    }]}],
  }
  // Only adopt identical existing fields, or replace the previous generated values.
  for (const [actual, desired, previous, field] of [
    [grafana.envValueFrom[ENV_NAME], env, config.generated?.env, 'Grafana Instatus environment reference'],
    [grafana.alerting[PROVISIONING_FILE], provisioning, config.generated?.provisioning, 'Grafana Instatus contact point'],
  ]) {
    if (actual !== undefined && !isDeepStrictEqual(actual, desired) && !isDeepStrictEqual(actual, previous)) {
      throw new Error(`${field} was configured independently; resolve the conflict before generation`)
    }
  }

  if (grafana.env?.[ENV_NAME] !== undefined) throw new Error('Remove the plaintext Instatus environment value before Secret-based generation')
  for (const [filename, file] of Object.entries(grafana.alerting)) {
    if (filename === PROVISIONING_FILE) continue
    let parsed: any
    try {
      parsed = typeof file === 'string' ? yaml.load(file) : file
    } catch {
      throw new Error('Another Grafana provisioning file contains invalid YAML; resolve it before statusPage generation')
    }

    for (const point of parsed?.contactPoints ?? []) {
      if (point.name === target.contactPointName || point.receivers?.some((receiver: any) => receiver.uid === target.receiverUid)) {
        throw new Error('Another Grafana provisioning file uses the selected Instatus contact point name or UID')
      }
    }
  }

  grafana.envValueFrom[ENV_NAME] = env
  grafana.alerting[PROVISIONING_FILE] = provisioning
  config.generated = {...config.generated, env: structuredClone(env), environment, provisioning: structuredClone(provisioning), version: 1}
  if (isDeepStrictEqual(config, values.statusPage) && isDeepStrictEqual(grafana, values.grafana)) return []
  // Commit only after every source and conflict check has passed.
  values.statusPage = config
  values.grafana = grafana
  return [{key: 'statusPage + grafana native contact point', newValue: '[generated from deployment; Secret references only]', oldValue: '[previous configuration]'}]
}
