/* eslint-disable @typescript-eslint/no-explicit-any -- Validated Helm configuration. */
// Validate explicit operator overrides; defaults and rule implementation belong to scroll-monitor.
const HEALTH_FIELDS = new Set(['batchPublicationDeadlineSeconds', 'depositDeadlineSeconds', 'ethDaSubmitterJobRegex',
  'failureFor', 'freshnessSeconds', 'maxBlockAgeSeconds', 'maxIndexLagSeconds', 'maxNodeLagSeconds',
  'maxRpcLatencySeconds', 'minimumProbeLocations', 'recoveryFor', 'wfStallSeconds', 'withdrawalDeadlineSeconds',
  'withdrawalProcessorJobRegex', 'withdrawalProcessorExpectedTargets', 'ethDaSubmitterExpectedTargets',
  'withdrawalProcessorStatefulSet', 'kubeStateMetricsJobRegex', 'tsoJobRegex', 'tsoExpectedTargets'])

export function normalizeHealth(input: any = {}): any {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('statusPage.publication.health must be a mapping')
  if (Object.keys(input).some(key => !HEALTH_FIELDS.has(key))) throw new Error('Unknown statusPage.publication.health field')
  const health = {...input}
  for (const [key, value] of Object.entries(health)) {
    if (key.endsWith('JobRegex') || key.endsWith('StatefulSet')) {
      if (typeof value !== 'string' || !value || value.length > 256) throw new Error(`${key} must be a configured Prometheus job regex`)
      continue
    }

    if (key.endsWith('DeadlineSeconds') && value === 0) continue
    if (key.endsWith('For')) {
      if (typeof value !== 'string' || !/^[1-9]\d*[hms]$/.test(value)) throw new Error(`${key} must be a positive duration`)
    } else if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (key !== 'maxRpcLatencySeconds' && !Number.isInteger(value))) throw new Error(`${key} must be a positive number`)
  }

  if (health.withdrawalProcessorExpectedTargets > 32 || health.ethDaSubmitterExpectedTargets > 32 || health.tsoExpectedTargets > 32) throw new Error('At most 32 expected service targets')
  if (health.minimumProbeLocations < 2) throw new Error('Public health requires at least two independent probe locations')
  return health
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
  for (const [key, deadline] of [['deposits', 'depositDeadlineSeconds'], ['withdrawals', 'withdrawalDeadlineSeconds'], ['batch-publication', 'batchPublicationDeadlineSeconds']]) if (!(health[deadline] > 0)) missing[key] = 'requires-confirmed-processing-deadline'
  return {config: {...probes, bridgeUrls: endpoints('bridge-portal'), chainId: catalog.chainId, environment: catalog.environment, explorerUrls: endpoints('block-explorer'),
    ...Object.fromEntries(['maxBlockAgeSeconds', 'maxIndexLagSeconds', 'maxNodeLagSeconds', 'maxRpcLatencySeconds'].filter(key => health[key] !== undefined).map(key => [key, health[key]])), rpcUrls: endpoints('public-rpc')}, inputs, missing}
}
