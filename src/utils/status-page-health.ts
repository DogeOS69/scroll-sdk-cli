/* eslint-disable @typescript-eslint/no-explicit-any -- Validated Helm configuration. */
export const HEALTH_DEFAULTS = {
  batchPublicationDeadlineSeconds: 0,
  depositDeadlineSeconds: 0,
  ethDaSubmitterJobRegex: 'eth-da-submitter',
  failureFor: '5m',
  freshnessSeconds: 120,
  maxBlockAgeSeconds: 120,
  maxIndexLagSeconds: 120,
  maxNodeLagSeconds: 120,
  maxRpcLatencySeconds: 2,
  minimumProbeLocations: 2,
  recoveryFor: '10m',
  wfStallSeconds: 3600,
  withdrawalDeadlineSeconds: 0,
  withdrawalProcessorJobRegex: 'withdrawal-processor',
}

export function normalizeHealth(input: any = {}): any {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('statusPage.publication.health must be a mapping')
  if (Object.keys(input).some(key => !(key in HEALTH_DEFAULTS))) throw new Error('Unknown statusPage.publication.health field')
  const health = {...HEALTH_DEFAULTS, ...input}
  for (const [key, value] of Object.entries(health)) {
    if (key.endsWith('JobRegex')) {
      if (typeof value !== 'string' || !value || value.length > 256) throw new Error(`${key} must be a configured Prometheus job regex`)
      continue
    }

    if (key.endsWith('DeadlineSeconds') && value === 0) continue
    if (key.endsWith('For')) {
      if (typeof value !== 'string' || !/^[1-9]\d*[hms]$/.test(value)) throw new Error(`${key} must be a positive duration`)
    } else if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (key !== 'maxRpcLatencySeconds' && !Number.isInteger(value))) throw new Error(`${key} must be a positive number`)
  }

  if (health.minimumProbeLocations < 2) throw new Error('Public health requires at least two independent probe locations')
  return health
}

/** WF evidence is exported by the read-only core observer, not Pod-IP history. */
function workflowHealth(health: any): string {
  const selector = `{job=~${JSON.stringify(health.withdrawalProcessorJobRegex)}}`
  const labels = 'namespace, job, instance'
  const metric = (name: string) => `withdrawal_processor_public_workflow_${name}${selector}`
  const age = `withdrawal_processor_protocol_job_oldest_age_seconds{job=~${JSON.stringify(health.withdrawalProcessorJobRegex)},status=~"queued|building|built|failed_retryable|bug|proposed_to_tso|awaiting_replay"}`
  const current = (stamp: string) => `(time() - ${stamp} >= 0 and time() - ${stamp} <= ${health.freshnessSeconds})`
  const observed = metric('snapshot_timestamp_seconds')
  const unchanged = metric('unchanged_seconds')
  const head = metric('head_observed_timestamp_seconds')
  const validHead = `(${metric('snapshot_valid')} == 1 and on (${labels}) ${current(observed)} and on (${labels}) (${head} > 0 and ${head} <= time()) and on (${labels}) (${unchanged} >= 0 and ${unchanged} < Inf and ${unchanged} <= (${observed} - ${head} + 1)) and on (${labels}) (up${selector} == 1))`
  const jobsSelector = `{job=~${JSON.stringify(health.withdrawalProcessorJobRegex)},source="jobs"}`
  const jobs = `(withdrawal_processor_protocol_snapshot_valid${jobsSelector} == 1 and ${current(`withdrawal_processor_protocol_snapshot_timestamp_seconds${jobsSelector}`)})`
  const validAge = `(${age} >= 0 and ${age} < Inf and ${current(`timestamp(${age})`)})`
  const waiting = `(max by (${labels}) (${validAge}))`
  // Idle/recent work and positive evidence of recent canonical progress need no
  // full history window. Old overdue work is unknown until continuous core
  // observation establishes a stall. A restart never inherits a stalled timer.
  const healthy = `((${waiting} <= bool ${health.wfStallSeconds}) == 1) or on (${labels}) ((${waiting} > bool ${health.wfStallSeconds}) * on (${labels}) (time() - ${head} <= bool ${health.wfStallSeconds}) == 1)`
  const stalled = `((${waiting} > bool ${health.wfStallSeconds}) * on (${labels}) (${unchanged} > bool ${health.wfStallSeconds}) == 1)`
  const verdict = `((${stalled}) or on (${labels}) ((${healthy}) * 0))`
  const evidence = `(${verdict} and on (${labels}) ${validHead} and on (${labels}) ${jobs} and on (${labels}) (count by (${labels}) (${validAge}) == count by (${labels}) (${age})))`
  const complete = `(count(${evidence}) == count(up${selector})) and (min(up${selector}) == 1) and (count(up${selector}) > 0)`
  return `(max(${evidence}) == 1) or ((max(${evidence}) == 0) and (${complete}))`
}

/** Every expression is 0/1 with no dynamic labels, or absent when evidence is incomplete. */
export function builtinHealth(key: string, environment: string, chainId: string, health: any, nodeSyncMode = 'external'): string {
  const identity = `environment=${JSON.stringify(environment)},chain_id=${JSON.stringify(chainId)},component_key=${JSON.stringify(key)}`
  const q = (metric: string) => `${metric}{${identity}}`
  const fresh = (metric: string) => `(time() - ${metric} >= 0 and time() - ${metric} <= ${health.freshnessSeconds})`
  if (['node-sync', 'sequencing'].includes(key) && nodeSyncMode === 'official') {
    const prefix = key === 'sequencing' ? 'scroll_status_sequencing' : 'scroll_status_node_sync'
    const sample = q(`${prefix}_affected`)
    const observed = q(`${prefix}_timestamp_seconds`)
    const valid = `(((${sample} == 0) or (${sample} == 1)) and ${fresh(observed)})`
    // One collector verifies ALL selected Pods; this is not an external probe location.
    return `(max(${valid})) and (count(${valid}) == 1) and (count(${sample}) == 1)`
  }

  if (['block-explorer', 'bridge-portal', 'node-sync', 'public-rpc', 'sequencing'].includes(key)) {
    const sample = q('scroll_status_probe_affected')
    const timestamp = q('scroll_status_probe_timestamp_seconds')
    const valid = `(((${sample} == 0) or (${sample} == 1)) and on (environment, chain_id, component_key, location) ${fresh(timestamp)})`
    // One location represents a genuinely independent observer, not a replica.
    // All configured endpoints at that location are folded by the observer.
    const complete = `(count(${valid}) == ${health.minimumProbeLocations})`
    return `(min(${valid})) and ${complete} and (max(${valid}) == min(${valid})) and (count(count by (location) (${valid})) == ${health.minimumProbeLocations})`
  }

  const prefixes: Record<string, string> = {
    'batch-publication': 'eth_da_publish_public', deposits: 'withdrawal_processor_public_deposit', withdrawals: 'withdrawal_processor_public_withdrawal',
  }
  const prefix = prefixes[key]
  if (!prefix) throw new Error('Unknown built-in public health component')
  const selector = `{job=~${JSON.stringify(key === 'batch-publication' ? health.ethDaSubmitterJobRegex : health.withdrawalProcessorJobRegex)}}`
  const metric = (name: string) => `${prefix}_${name}${selector}`
  const backlog = metric('eligible_backlog')
  const age = metric('oldest_eligible_age_seconds')
  const observed = metric('snapshot_timestamp_seconds')
  const limit = key === 'batch-publication' ? health.batchPublicationDeadlineSeconds : key === 'deposits' ? health.depositDeadlineSeconds : health.withdrawalDeadlineSeconds
  if (limit === 0) return '' // Processing deadlines must be confirmed for this deployment.
  const paired = `((${backlog} > bool 0) * on (namespace, job, instance) (${age} > bool ${limit}))`
  const validSnapshot = key === 'batch-publication' ? '' : ` and on (namespace, job, instance) (${metric('snapshot_valid')} == 1)`
  const valid = `(${paired} and on (namespace, job, instance) (${backlog} >= 0 and ${backlog} < Inf and ${backlog} == floor(${backlog})) and on (namespace, job, instance) (${age} >= 0 and ${age} < Inf) and on (namespace, job, instance) ${fresh(observed)}${validSnapshot} and on (namespace, job, instance) (up${selector} == 1))`
  // Missing age/freshness for ANY scraped writer prevents the aggregate being healthy.
  const targets = `up${selector}`
  const complete = `(count(${valid}) == count(${targets})) and (min(${targets}) == 1) and (count(${targets}) > 0)`
  const business = `(max(${valid})) and (${complete})`
  if (key === 'batch-publication') return business
  const workflow = workflowHealth(health)
  // Known failure wins over unknown. Recovery needs BOTH business and WF evidence.
  return `((${workflow}) == 1) or ((${business}) == 1) or (((${business}) == 0) and ((${workflow}) == 0))`
}

export function normalizeProbes(input: any = {}, catalog: any, health: any): {config: any; inputs: any; missing: Record<string, string>} {
  const defaults = {alloyChecks: [], bridgeChecks: 'auto', explorerApiUrls: catalog.probeSources?.explorerApiUrls ?? [], explorerSelector: '', metricsTargets: [], mode: 'external', nodeDependencyChecks: [], nodeRpcUrl: '', sequencingMode: 'auto', websocketImage: 'node:22.23.3-alpine3.23'}
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !(key in defaults))) throw new Error('Invalid publication.probes configuration')
  const inputs = {...defaults, ...input}
  const probes = structuredClone(inputs)
  if (typeof probes.websocketImage !== 'string' || !probes.websocketImage || /\s/.test(probes.websocketImage)) throw new Error('Invalid probes.websocketImage')
  if (!['alloy', 'external'].includes(probes.mode)) throw new Error('probes.mode must be alloy or external')
  if (!Array.isArray(probes.alloyChecks)) throw new Error('probes.alloyChecks must be a list')
  if (probes.mode === 'external' && probes.alloyChecks.length > 0) throw new Error('alloyChecks requires probes.mode: alloy')
  if (probes.mode === 'alloy' && probes.metricsTargets.length > 0) throw new Error('Alloy uses the existing remote-write path; remove external metricsTargets')
  if (probes.mode === 'alloy' && !['auto', 'disabled'].includes(inputs.bridgeChecks)) throw new Error('Alloy does not execute JSON-path bridgeChecks; use auto for API availability, disabled for page-only checks, and alloyChecks for explicit response patterns')
  if (probes.bridgeChecks === 'disabled') {
    if (probes.mode !== 'alloy') throw new Error('bridgeChecks: disabled requires Alloy page-only monitoring')
    probes.bridgeChecks = []
    probes.bridgeApiRequired = false
  }

  if (probes.bridgeChecks === 'auto') probes.bridgeChecks = catalog.probeSources?.bridgeChecks ?? []
  if (probes.sequencingMode === 'auto') probes.sequencingMode = catalog.probeSources?.sequencingMode ?? 'unconfigured'
  if (Array.isArray(probes.explorerApiUrls) && probes.explorerApiUrls.length === 0) probes.explorerApiUrls = defaults.explorerApiUrls
  if (!['continuous', 'on-demand', 'unconfigured'].includes(probes.sequencingMode)) throw new Error('probes.sequencingMode must be explicitly selected')
  if (typeof probes.explorerSelector !== 'string') throw new Error('probes.explorerSelector must be a CSS selector')
  const url = (value: unknown) => {
    let parsed: URL
    try { parsed = new URL(String(value)) } catch { throw new Error('Probe endpoints must be public HTTP(S) URLs') }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || /(?:token|secret|key|password)=/i.test(parsed.search)) throw new Error('Probe URLs cannot contain credentials')
  }

  if (!Array.isArray(probes.metricsTargets) || probes.metricsTargets.some((target: unknown) => typeof target !== 'string' || !/^(?:\[[\d:a-f]+]|[\da-z][\d.a-z-]*):[1-9]\d{0,4}$/i.test(target) || Number(target.slice(target.lastIndexOf(':') + 1)) > 65_535)) throw new Error('Probe metricsTargets must contain host:port targets without credentials')
  if (probes.nodeRpcUrl) url(probes.nodeRpcUrl)
  if (!Array.isArray(probes.explorerApiUrls)) throw new Error('explorerApiUrls must be a list')
  for (const endpoint of probes.explorerApiUrls) url(endpoint)
  for (const name of ['bridgeChecks', 'nodeDependencyChecks']) {
    if (!Array.isArray(probes[name])) throw new Error(`${name} must be a list`)
    for (const check of probes[name]) {
      if (!check || typeof check !== 'object' || Object.keys(check).some(key => !['equals', 'path', 'type', 'url'].includes(key)) || Object.hasOwn(check, 'equals') === Object.hasOwn(check, 'type') || (Object.hasOwn(check, 'type') && !['array', 'boolean', 'null', 'number', 'object', 'string'].includes(check.type)) || !Array.isArray(check.path) || !check.path.every((part: unknown) => typeof part === 'string' || (Number.isSafeInteger(part) && Number(part) >= 0))) throw new Error(`${name} requires {url, path, equals} or {url, path, type}`)
      url(check.url)
    }
  }

  const endpoints = (key: string) => catalog.components.find((item: any) => item.key === key).endpoints
  const missing: Record<string, string> = {}
  if (probes.sequencingMode !== 'continuous') missing.sequencing = 'requires-continuous-block-production-or-custom-rule'
  if (probes.bridgeChecks.length === 0) missing['bridge-portal'] = 'requires-bridge-api-checks'
  if (probes.explorerApiUrls.length === 0 || !probes.explorerSelector) missing['block-explorer'] = 'requires-explorer-api-and-ui-selector'
  if (!probes.nodeRpcUrl || probes.nodeDependencyChecks.length === 0) missing['node-sync'] = 'requires-independent-canary-node-and-dependency-checks'
  for (const [key, deadline] of [['deposits', 'depositDeadlineSeconds'], ['withdrawals', 'withdrawalDeadlineSeconds'], ['batch-publication', 'batchPublicationDeadlineSeconds']]) if (health[deadline] === 0) missing[key] = 'requires-confirmed-processing-deadline'
  return {config: {...probes, bridgeUrls: endpoints('bridge-portal'), chainId: catalog.chainId, environment: catalog.environment, explorerUrls: endpoints('block-explorer'),
    maxBlockAgeSeconds: health.maxBlockAgeSeconds, maxIndexLagSeconds: health.maxIndexLagSeconds, maxNodeLagSeconds: health.maxNodeLagSeconds,
    maxRpcLatencySeconds: health.maxRpcLatencySeconds, rpcUrls: endpoints('public-rpc')}, inputs, missing}
}
