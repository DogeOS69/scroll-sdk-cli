/* eslint-disable @typescript-eslint/no-explicit-any -- Generated Helm/Blackbox configuration. */
import {createHash} from 'node:crypto'
import {isIP} from 'node:net'

const KEYS = ['public-rpc', 'bridge-portal', 'block-explorer']

/** Public-entrypoint availability, deliberately distinct from browser/indexing checks. */
export function buildAlloyProbes(probes: any, catalog: any): any {
  const modules: Record<string, any> = {}
  const targets: any[] = []
  const missing: Record<string, string> = {
    'node-sync': 'requires-official-node-sync-or-custom-rule',
    sequencing: 'requires-sequencing-metrics-or-custom-rule',
  }
  const endpoints = (key: string): string[] => catalog.components.find((c: any) => c.key === key).endpoints
  const publicUrl = (url: string) => {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || isIP(parsed.hostname.replaceAll(/^\[|]$/g, '')) || !parsed.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|svc|cluster\.local)$/.test(parsed.hostname) || parsed.username || parsed.password || parsed.hash || /(?:token|secret|key|password)=/i.test(parsed.search)) throw new Error('Alloy probes require public HTTP(S) domain URLs without credentials')
  }

  const add = (key: string, url: string, name: string, http: any = {}) => {
    publicUrl(url)
    const id = `${key}-${name}-${targets.filter(t => t.component_key === key).length}`
    modules[id] = {http: {follow_redirects: false, method: 'GET', preferred_ip_protocol: 'ip4', tls_config: {insecure_skip_verify: false}, valid_status_codes: [200], ...http}, prober: 'http', timeout: '5s'}
    targets.push({address: url, chain_id: catalog.chainId, check_id: id, component_key: key, environment: catalog.environment, module: id, name: id})
  }

  const jsonHeaders = [{header: 'Content-Type', regexp: '(?i)^application/(json|[^;]+\\+json)(;.*)?$'}]
  const rpc = (method: string, result: string) => {
    // These responses have three scalar fields. Anchor the complete object and
    // allow all field orders; duplicate keys, batches and embedded error text fail.
    const fields = ['"jsonrpc"\\s*:\\s*"2\\.0"', '"id"\\s*:\\s*1', `"result"\\s*:\\s*"${result}"`]
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
    const response = `^\\s*\\{\\s*(?:${orders.map(order => order.map(i => fields[i]).join('\\s*,\\s*')).join('|')})\\s*\\}\\s*$`
    return {body: JSON.stringify({id: 1, jsonrpc: '2.0', method, params: []}),
      fail_if_body_not_matches_regexp: [response], fail_if_header_not_matches: jsonHeaders,
      headers: {'Content-Type': 'application/json'}, method: 'POST'}
  }

  for (const url of endpoints('public-rpc')) {
    if (/^wss?:/.test(url)) {
      missing['public-rpc'] = 'alloy-does-not-cover-configured-websocket-rpc'
      continue
    }

    add('public-rpc', url, 'chain-id', rpc('eth_chainId', `(?i:0x${BigInt(catalog.chainId).toString(16)})`))
    add('public-rpc', url, 'block-number', rpc('eth_blockNumber', '0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)'))
  }

  for (const key of ['bridge-portal', 'block-explorer']) {
    for (const url of endpoints(key)) add(key, url, 'page', {fail_if_header_not_matches: [{header: 'Content-Type', regexp: '(?i)^text/html(;.*)?$'}]})
    const apis: string[] = key === 'bridge-portal' ? probes.bridgeChecks.map((check: any) => check.url) : probes.explorerApiUrls
    if (apis.length === 0) missing[key] = 'requires-public-api-endpoint'
    for (const url of [...new Set(apis)].sort()) {
      // The backend ingress catalog contains a base URL, whose root is HTML.
      // Explicit API paths remain available for custom endpoints.
      const target = key === 'block-explorer' && new URL(url).pathname === '/' ? new URL('/api/v2/stats', url).toString() : url
      add(key, target, 'api', {fail_if_header_not_matches: jsonHeaders})
    }
  }

  for (const check of probes.alloyChecks) {
    if (!check || typeof check !== 'object' || Object.keys(check).some(k => !['bodyRegex', 'component', 'url'].includes(k)) || !KEYS.includes(check.component) || typeof check.url !== 'string' || !Array.isArray(check.bodyRegex) || check.bodyRegex.length === 0 || check.bodyRegex.some((v: unknown) => typeof v !== 'string' || !v || v.length > 2048)) throw new Error('alloyChecks requires {component, url, bodyRegex: [RE2 expressions]}')
    add(check.component, check.url, 'body', {fail_if_body_not_matches_regexp: check.bodyRegex})
  }

  if (targets.length > 64) throw new Error('Alloy status probes support at most 64 checks per chain')
  for (const key of KEYS) if (!targets.some(t => t.component_key === key)) missing[key] = 'requires-public-endpoint'
  const revision = createHash('sha256').update(JSON.stringify({modules, targets})).digest('hex').slice(0, 16)
  for (const target of targets) target.status_probe_config = revision
  const config = {coverage: 'public-entrypoint', modules, revision, targets}
  return {config, missing}
}

function evidence(target: any, health: any): {sample: string; selector: string; valid: string} {
  const selector = `{job="status-page-alloy",environment=${JSON.stringify(target.environment)},chain_id=${JSON.stringify(target.chain_id)},component_key=${JSON.stringify(target.component_key)},check_id=${JSON.stringify(target.check_id)},status_probe_config=${JSON.stringify(target.status_probe_config)}}`
  const sample = `probe_success${selector}`
  const fresh = (metric: string) => `(time() - timestamp(${metric}) >= 0 and time() - timestamp(${metric}) <= ${health.freshnessSeconds})`
  const valid = `((${sample} == 0 or ${sample} == 1) and ${fresh(sample)} and (up${selector} == 1) and ${fresh(`up${selector}`)})`
  return {sample, selector, valid}
}

export function alloyHealth(key: string, config: any, health: any): string {
  const targets = config.targets.filter((t: any) => t.component_key === key)
  if (targets.length === 0) return ''
  const terms = targets.map((target: any) => {
    const {sample, selector, valid} = evidence(target, health)
    let value = `(1 - ${valid})`
    let guard = `(count(${sample}) == 1) and (count(up${selector}) == 1)`
    if (key === 'public-rpc') {
      const duration = `probe_duration_seconds${selector}`
      value = `clamp_max(${value} + (quantile_over_time(0.95, ${duration}[5m]) > bool ${health.maxRpcLatencySeconds}), 1)`
      guard += ` and (count(${duration}) == 1) and (min(count_over_time(${duration}[5m])) >= 10) and (min(${duration}) >= 0) and (max(${duration}) < Inf) and (time() - min(timestamp(${duration})) <= ${health.freshnessSeconds})`
    }

    return `(max(${value}) and ${guard})`
  })
  // Every configured check must be present; never recover from a partial set.
  return `clamp_max(${terms.join(' + ')}, 1)`
}

/** Failed HTTP probes still send heartbeats; missing/duplicate/stale telemetry does not. */
export function alloyHeartbeat(config: any, health: any): string {
  return config.targets.map((t: any) => {
    const {sample, selector, valid} = evidence(t, health)
    return `(count(${valid}) == 1 and count(${sample}) == 1 and count(up${selector}) == 1)`
  }).join(' and ')
}
