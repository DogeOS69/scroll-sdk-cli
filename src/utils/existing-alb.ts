/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values and AWS responses. */
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {reconcileBlockscoutFrontend} from './blockscout-values.js'
import {deploymentIngresses} from './public-service-ingress.js'
import {resolveSdkRevision} from './spec-bootstrap.js'

// Binding keys select an existing SDK ingress, so hosts/paths have one source.
export const ALB_SERVICES: Record<string, {file: string; ingress: string[]}> = {
  'blockscout-api': {file: 'blockscout-production.yaml', ingress: ['blockscout-stack', 'blockscout', 'ingress']},
  'blockscout-frontend': {file: 'blockscout-production.yaml', ingress: ['blockscout-stack', 'frontend', 'ingress']},
  'dogeos-bridge-history': {file: 'dogeos-bridge-history-production.yaml', ingress: ['ingress', 'main']},
  'frontends': {file: 'frontends-production.yaml', ingress: ['ingress', 'main']},
  'l2-reth-rpc-public': {file: 'l2-reth-rpc-public-production.yaml', ingress: ['ingress', 'main']},
  'l2-reth-rpc-public-ws': {file: 'l2-reth-rpc-public-production.yaml', ingress: ['ingress', 'websocket']},
  'proof-coordinator': {file: 'proof-coordinator-production.yaml', ingress: ['ingress', 'main']},
  'tso-service': {file: 'tso-service-production.yaml', ingress: ['ingress', 'main']},
}
const ALB_VALUE_FILES = new Set(Object.values(ALB_SERVICES).map(entry => entry.file))
const label = /^[\da-z](?:[\da-z-]{0,61}[\da-z])?$/
const object = (value: any): boolean => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const fail = (message: string): never => {throw new Error(`Existing ALB: ${message}`)}

export function validateExistingAlb(spec: DeploymentSpec): void {
  validateSharedAlb(spec)
  const aws = spec.infrastructure?.aws
  const config = aws?.alb
  if (config === undefined) return
  if (spec.infrastructure.provider !== 'aws' || !object(config) || config.mode !== 'existing') fail('infrastructure.aws.alb.mode must be existing on AWS')
  if (!object(config.endpoints) || Object.keys(config.endpoints).length === 0 || !object(config.bindings) || Object.keys(config.bindings).length === 0) fail('endpoints and bindings must be nonempty maps')
  if (spec.preparation?.tsoAlbEdge?.enabled) fail('disable preparation.tsoAlbEdge; configure NetworkPolicy for the selected existing ALB subnets')
  const arnPrefix = `arn:aws:elasticloadbalancing:${aws!.region}:${aws!.accountId}:`
  for (const [name, endpoint] of Object.entries(config.endpoints)) {
    if (!label.test(name) || !object(endpoint)) fail('endpoint names must be DNS labels')
    const lb = endpoint.loadBalancerArn?.slice(arnPrefix.length)
    if (!endpoint.loadBalancerArn?.startsWith(arnPrefix) || !/^loadbalancer\/app\/[\w-]+\/[\da-f]{16}$/.test(lb)) fail(`${name}: select an application load balancer ARN in the configured account and region`)
    const listenerPrefix = `${arnPrefix}listener/${lb.slice('loadbalancer/'.length)}/`
    if (!endpoint.listenerArn?.startsWith(listenerPrefix) || !/^[\da-f]{16}$/.test(endpoint.listenerArn.slice(listenerPrefix.length))) fail(`${name}: listener ARN must belong to the selected ALB`)
  }

  const groups = new Set<string>()
  for (const [name, binding] of Object.entries(config.bindings)) {
    if (name === 'dogeos-bridge-history') fail('dogeos-bridge-history currently supports sharedAlb only; its SDK chart has no targetGroupBindings template')
    if (!Object.hasOwn(ALB_SERVICES, name) || !object(binding) || !Object.hasOwn(config.endpoints, binding.endpoint)) fail(`${name}: unknown service or endpoint`)
    if (!object(binding.serviceRef) || !label.test(binding.serviceRef.name) || !Number.isInteger(binding.serviceRef.port) || binding.serviceRef.port < 1 || binding.serviceRef.port > 65_535) fail(`${name}: serviceRef requires an actual Service name and numeric port`)
    if (!binding.targetGroupArn?.startsWith(arnPrefix) || !/^targetgroup\/[\w-]+\/[\da-f]{16}$/.test(binding.targetGroupArn.slice(arnPrefix.length))) fail(`${name}: target group ARN must use the configured account and region`)
    if (groups.has(binding.targetGroupArn)) fail('each service requires its own target group; sharing targets is unsupported')
    groups.add(binding.targetGroupArn)
  }

  const tso = config.bindings['tso-service']
  const proof = config.bindings['proof-coordinator']
  if (tso && proof && config.endpoints[tso.endpoint].loadBalancerArn === config.endpoints[proof.endpoint].loadBalancerArn) fail('TSO and Proof Coordinator require separate ALBs')
}

export function existingAlbIngress(files: Record<string, string>, name: string): any {
  const entry = ALB_SERVICES[name]
  if (!entry || !files[entry.file]) fail(`${name}: missing generated application values`)
  const values: any = yaml.load(files[entry.file])
  const ingress = entry.ingress.reduce((value, key) => value?.[key], values)
  if (!object(ingress)) fail(`${name}: missing ingress configuration for host/path verification`)
  if (name === 'blockscout-api' && ingress.paths === undefined) {
    // blockscout-stack 2.2.0 defaults; verification only, never written to values.
    ingress.paths = [
      ...['/api', '/socket', '/public-metrics'].map(path => ({path, pathType: 'Prefix'})),
      ...['/auth/auth0', '/auth/auth0/callback', '/auth/logout'].map(path => ({path, pathType: 'Exact'})),
    ]
  }

  return ingress
}

export function readExistingAlbSpec(root: string, specFile?: string): DeploymentSpec | undefined {
  const file = specFile ? path.resolve(root, specFile) : [path.join(root, '.scrollsdk/intent.json'), path.join(root, 'deployment-spec.yaml')].find(file => fs.existsSync(file))
  if (!file) return
  return yaml.load(fs.readFileSync(file, 'utf8')) as DeploymentSpec
}

/** Disable the Ingress before legacy certificate checks, including regenerated values. */
export function suppressExistingAlbIngress(values: any, file: string, spec?: DeploymentSpec): void {
  for (const name of Object.keys(spec?.infrastructure.aws?.alb?.bindings ?? {})) {
    const entry = ALB_SERVICES[name]
    if (entry?.file !== file) continue
    const ingress = entry.ingress.reduce((value, key) => value?.[key], values)
    if (object(ingress)) Object.assign(ingress, {enabled: false, existingAlbBinding: name})
  }
}

/** Check the actual chart templates at the same committed SDK revision. */
export function validateExistingAlbSdk(sdkDirectory: string, spec: DeploymentSpec): void {
  if (!spec.infrastructure.aws?.alb && !spec.infrastructure.aws?.sharedAlb) return
  const revision = resolveSdkRevision(sdkDirectory, spec.templates?.sdkRevision)
  if (spec.infrastructure.aws?.sharedAlb?.services.includes('blockscout-api')) {
    let values: any
    try {values = yaml.load(execFileSync('git', ['-C', sdkDirectory, 'show', `${revision}:charts/blockscout/values.yaml`], {encoding: 'utf8', stdio: 'pipe'}))} catch {fail('sharedAlb requires the paired SDK Blockscout chart')}
    const stack = values?.['blockscout-stack']
    if (!stack || stack.frontend?.env?.NEXT_PUBLIC_API_HOST !== undefined || ['blockscout', 'frontend'].some(name => Object.keys(stack[name]?.ingress?.annotations ?? {}).some(key => key.startsWith('nginx.')))) fail('sharedAlb requires SDK Blockscout 0.1.12-dogeos or later with clean ingress/environment defaults')
  }

  for (const name of Object.keys(spec.infrastructure.aws?.alb?.bindings ?? {})) {
    const chart = name.startsWith('l2-reth-') ? 'l2-reth' : name.startsWith('blockscout-') ? 'blockscout' : name
    try {
      execFileSync('git', ['-C', sdkDirectory, 'cat-file', '-e', `${revision}:charts/${chart}/templates/targetgroupbindings.yaml`], {stdio: 'pipe'})
    } catch {fail(`${name}: selected SDK revision lacks application-owned targetGroupBindings; select the paired SDK release`)}
  }
}

/** Pure projection; callers commit all values together. Never creates AWS resources. */
export function projectExistingAlb(files: Record<string, string>, spec: DeploymentSpec): void {
  validateExistingAlb(spec)
  const config = spec.infrastructure.aws?.alb
  const projected = {...files}
  for (const name of spec.infrastructure.aws?.sharedAlb?.services ?? []) existingAlbIngress(projected, name)
  for (const [file, content] of Object.entries(projected)) {
    if (!ALB_VALUE_FILES.has(file)) continue
    const values: any = yaml.load(content) ?? {}
    if (projectSharedAlbValues(values, file, spec)) projected[file] = yaml.dump(values, {lineWidth: -1, noRefs: true})
  }

  if (!config) {
    for (const [file, content] of Object.entries(projected)) {
      if (!ALB_VALUE_FILES.has(file)) continue
      const values = yaml.load(content) as any ?? {}
      if (Object.keys(values.targetGroupBindings ?? {}).length > 0 || deploymentIngresses(values).some(ingress => ingress.existingAlbBinding)) fail('cannot remove alb configuration while values still reference existing ALB bindings')
    }

    Object.assign(files, projected)
    return
  }

  for (const name of Object.keys(config.bindings)) {
    existingAlbIngress(projected, name)
    const entry = ALB_SERVICES[name]
    const values: any = yaml.load(projected[entry.file])
    suppressExistingAlbIngress(values, entry.file, spec)
    const binding = config.bindings[name]
    values.targetGroupBindings ??= {}
    values.targetGroupBindings[name] = {serviceRef: binding.serviceRef, targetGroupARN: binding.targetGroupArn, targetType: 'ip'}
    projected[entry.file] = yaml.dump(values, {lineWidth: -1, noRefs: true})
  }

  for (const [file, content] of Object.entries(projected)) {
    if (!ALB_VALUE_FILES.has(file)) continue
    const values = yaml.load(content) as any ?? {}
    for (const name of Object.keys(values.targetGroupBindings ?? {})) {
      if (!Object.hasOwn(config.bindings, name) || ALB_SERVICES[name].file !== file) fail(`${file}: stale or misplaced targetGroupBindings entry`)
    }

    for (const ingress of deploymentIngresses(values)) {
      const name = ingress.existingAlbBinding
      if (name && (!Object.hasOwn(config.bindings, name) || ALB_SERVICES[name].file !== file)) fail(`${file}: stale or misplaced existing ALB binding`)
      if (ingress.enabled !== false && !isSharedIngress(values, file, ingress, spec)) fail(`${file}: enabled ingress has no existing ALB binding; select a binding or explicitly disable this ingress`)
    }
  }

  Object.assign(files, projected)
}

export function readAlbValues(directory: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(directory).filter(file => /\.ya?ml$/.test(file)).map(file => [file, fs.readFileSync(path.join(directory, file), 'utf8')]))
}

export function projectExistingAlbDirectory(directory: string, spec: DeploymentSpec, requireSelection = false): void {
  const before = readAlbValues(directory)
  const files = {...before}
  projectExistingAlb(files, spec)
  if (requireSelection && spec.infrastructure.provider === 'aws' && !spec.infrastructure.aws?.alb) {
    for (const [file, content] of Object.entries(files)) {
      if (!ALB_VALUE_FILES.has(file)) continue
      const values: any = yaml.load(content) ?? {}
      if (deploymentIngresses(values).some(ingress => ingress.enabled !== false && !isSharedIngress(values, file, ingress, spec))) fail(`${file}: AWS chart preparation requires infrastructure.aws.alb or sharedAlb selection, or explicitly disabled HTTP ingress`)
    }
  }

  for (const [file, content] of Object.entries(files)) if (content !== before[file]) fs.writeFileSync(path.join(directory, file), content)
}

function routes(ingress: any): Array<{host: string; paths: string[]}> {
  const hosts = ingress.hostname ? [{host: ingress.hostname, paths: ingress.paths}] : ingress.hosts
  if (!Array.isArray(hosts) || hosts.length === 0) fail('each binding needs a configured hostname')
  return hosts.map((entry: any) => {
    const host = typeof entry === 'string' ? entry : entry.host
    if (typeof host !== 'string' || !/^(?:[\da-z](?:[\da-z-]*[\da-z])?\.)+[\da-z-]+$/i.test(host)) fail('binding hosts must be explicit DNS names without wildcards')
    const paths = (typeof entry === 'string' ? [{path: ingress.path ?? '/', pathType: ingress.pathType ?? 'Prefix'}] : entry.paths) ?? [{path: '/', pathType: 'Prefix'}]
    return {host, paths: paths.flatMap((item: any) => {
      if (typeof item.path !== 'string' || !item.path.startsWith('/') || /[*?]/.test(item.path) || !['Exact', 'Prefix'].includes(item.pathType ?? 'Prefix')) fail('unsupported ingress path; use Exact or Prefix without wildcards')
      if (item.pathType === 'Exact') return [item.path]
      const prefix = item.path.replace(/\/+$/, '')
      return prefix ? [prefix, `${prefix}/*`] : ['/*']
    })}
  })
}

const SHARED_SERVICES = new Set(['blockscout-api', 'blockscout-frontend', 'dogeos-bridge-history', 'frontends', 'l2-reth-rpc-public', 'l2-reth-rpc-public-ws'])
const ALB_ANNOTATION = 'alb.ingress.kubernetes.io/'

function validateSharedAlb(spec: DeploymentSpec): void {
  const aws = spec.infrastructure?.aws
  const config = aws?.sharedAlb
  if (config === undefined) return
  if (spec.frontend?.protocol === 'http') fail('sharedAlb requires frontend.protocol https for its HTTPS-only listener')
  if (spec.infrastructure.provider !== 'aws' || !object(config)) fail('sharedAlb requires AWS configuration')
  if (typeof config.groupName !== 'string' || config.groupName.length > 63 || !/^[\da-z](?:[\d.a-z-]*[\da-z])?$/.test(config.groupName)) fail('sharedAlb.groupName must be a lowercase ALB IngressGroup name, at most 63 characters')
  const prefix = `arn:aws:acm:${aws!.region}:${aws!.accountId}:certificate/`
  if (typeof config.certificateArn !== 'string' || !config.certificateArn.startsWith(prefix) || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(config.certificateArn.slice(prefix.length))) fail('sharedAlb.certificateArn must be an ACM certificate ARN in the configured account and region')
  if (!Array.isArray(config.services) || config.services.length === 0 || new Set(config.services).size !== config.services.length) fail('sharedAlb.services must be a nonempty list without duplicates')
  for (const name of config.services) {
    if (!SHARED_SERVICES.has(name)) fail(`${name}: sharedAlb supports only public RPC, Portal, history and Blockscout services`)
    if (Object.hasOwn(aws?.alb?.bindings ?? {}, name)) fail(`${name}: cannot select both sharedAlb and an external ALB binding`)
  }

  if (config.services.includes('dogeos-bridge-history') && (!spec.bridgeHistory?.enabled || !config.services.includes('frontends'))) fail('sharedAlb history requires bridgeHistory.enabled and frontends in the same group')

  if (config.services.includes('l2-reth-rpc-public-ws') && config.services.includes('l2-reth-rpc-public') && (!spec.frontend?.hosts.rpcGatewayWs || spec.frontend.hosts.rpcGatewayWs === spec.frontend.hosts.rpcGateway)) fail('sharedAlb RPC WebSocket requires a distinct rpcGatewayWs hostname')
  if (config.services.includes('blockscout-api') !== config.services.includes('blockscout-frontend')) fail('sharedAlb requires both Blockscout API and frontend')
}

function isSharedIngress(values: any, file: string, ingress: any, spec: DeploymentSpec): boolean {
  return (spec.infrastructure.aws?.sharedAlb?.services ?? []).some(name => {
    const entry = ALB_SERVICES[name]
    return entry.file === file && entry.ingress.reduce((value, key) => value?.[key], values) === ingress
  })
}

/** Apply before certificate checks and again after merging operator/SDK values. */
export function projectSharedAlbValues(values: any, file: string, spec?: DeploymentSpec): boolean {
  if (!spec) return false
  validateSharedAlb(spec)
  const config = spec.infrastructure.aws?.sharedAlb
  for (const ingress of deploymentIngresses(values)) {
    if (ingress.sharedAlbGroup && !isSharedIngress(values, file, ingress, spec)) fail(`${file}: stale sharedAlb selection; explicitly disable/remove the previous ingress and its sharedAlbGroup marker`)
  }

  if (!config) return false
  const before = JSON.stringify(values)
  for (const name of config.services) {
    const entry = ALB_SERVICES[name]
    if (entry.file !== file) continue
    const ingress = entry.ingress.reduce((value, key) => value?.[key], values)
    if (!object(ingress)) fail(`${name}: missing ingress configuration for sharedAlb`)
    // HTTP and WebSocket can use different ALB owners in the same values file.
    const conflictingBindings = Object.keys(values.targetGroupBindings ?? {}).some(binding => binding === name
      || !Object.hasOwn(spec.infrastructure.aws?.alb?.bindings ?? {}, binding) || ALB_SERVICES[binding]?.file !== file)
    if (ingress.existingAlbBinding || conflictingBindings) fail(`${name}: remove external targetGroupBindings before selecting sharedAlb`)
    // Validate hosts/paths without replacing chart-owned Blockscout routes.
    routes(ingress)
    ingress.enabled = true
    ingress.sharedAlbGroup = config.groupName
    delete ingress.tls
    delete ingress.ingressClassName
    delete ingress.className
    ingress[name.startsWith('blockscout-') ? 'className' : 'ingressClassName'] = 'alb'
    const annotations = {...ingress.annotations}
    for (const key of Object.keys(annotations)) {
      if (annotations[key] === null || key.startsWith('nginx.ingress.kubernetes.io/') || key.startsWith('cert-manager.io/') || ['kubernetes.io/ingress.class', 'kubernetes.io/tls-acme'].includes(key)) delete annotations[key]
    }

    Object.assign(annotations, {
      [`${ALB_ANNOTATION}certificate-arn`]: config.certificateArn,
      [`${ALB_ANNOTATION}group.name`]: config.groupName,
      [`${ALB_ANNOTATION}group.order`]: ['blockscout-api', 'dogeos-bridge-history'].includes(name) ? '10' : '100',
      [`${ALB_ANNOTATION}healthcheck-path`]: name === 'dogeos-bridge-history' ? '/api/history/v1/live' : name === 'blockscout-api' ? '/api/health/readiness' : name === 'blockscout-frontend' ? '/api/healthz' : '/',
      [`${ALB_ANNOTATION}listen-ports`]: '[{"HTTPS":443}]',
      [`${ALB_ANNOTATION}scheme`]: 'internet-facing',
      [`${ALB_ANNOTATION}ssl-policy`]: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      [`${ALB_ANNOTATION}success-codes`]: name.startsWith('l2-reth-') ? '200-499' : '200',
      [`${ALB_ANNOTATION}target-type`]: 'ip',
    })
    for (const [key, value] of Object.entries(annotations)) if (typeof value !== 'string') fail(`${name}: annotation ${key} must be a string`)
    ingress.annotations = annotations
  }

  if (file === 'blockscout-production.yaml' && config.services.includes('blockscout-api')) {
    const stack = values['blockscout-stack']
    stack.config ??= {}
    stack.config.prometheus ??= {}
    stack.config.prometheus.ingressWhitelist = {enabled: false}
    const network = stack.config.network ?? {}
    reconcileBlockscoutFrontend(stack, stack.blockscout.ingress.hostname, network.name ?? spec.network.l2ChainName, network.id ?? spec.network.l2ChainId)
    Object.assign(stack.frontend.env, {NEXT_PUBLIC_API_PROTOCOL: 'https', NEXT_PUBLIC_API_WEBSOCKET_PROTOCOL: 'wss', NEXT_PUBLIC_APP_PROTOCOL: 'https'})
  }

  return before !== JSON.stringify(values)
}

/** Paths remain release policy even when the spec changes the primary hostname. */
export function preserveSharedAlbPaths(files: Record<string, string>, spec: DeploymentSpec, previous: (file: string) => string | undefined): void {
  for (const name of spec.infrastructure.aws?.sharedAlb?.services ?? []) {
    if (name.startsWith('blockscout-')) continue // No generated path list replaces these.
    const entry = ALB_SERVICES[name]
    const saved = previous(entry.file)
    if (saved === undefined || !files[entry.file]) continue
    const values: any = yaml.load(files[entry.file])
    const oldIngress = entry.ingress.reduce((value, key) => value?.[key], yaml.load(saved) as any)
    const ingress = entry.ingress.reduce((value, key) => value?.[key], values)
    for (const [index, host] of (ingress?.hosts ?? []).entries()) {
      const oldHost = oldIngress?.hosts?.find((old: any) => old.host === host.host) ?? oldIngress?.hosts?.[index]
      if (oldHost?.paths !== undefined) host.paths = structuredClone(oldHost.paths)
    }

    files[entry.file] = yaml.dump(values, {lineWidth: -1, noRefs: true})
  }
}
