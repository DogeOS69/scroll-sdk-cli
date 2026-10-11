/* eslint-disable @typescript-eslint/no-explicit-any -- Shared Helm ingress values. */
const ALB = 'alb.ingress.kubernetes.io/'
const NGINX = 'nginx.ingress.kubernetes.io/'
export type PublicIngressService = string

/** Controller, certificates and edge policy belong to operator values, not spec. */
export function reconcilePublicServiceIngress(existing: Record<string, any>, service: PublicIngressService, validate = true): Record<string, any> {
  const ingress = structuredClone(existing)
  const annotations = {...ingress.annotations}
  const controller = ingress.ingressClassName || annotations['kubernetes.io/ingress.class'] || 'alb'
  if (controller !== 'alb') throw new Error(`${service}: ingress controller ${controller} is unsupported; select alb and configure ACM/subnet annotations in values before regeneration`)
  ingress.ingressClassName = controller
  delete annotations['kubernetes.io/ingress.class']
  if (controller === 'alb') {
    for (const key of Object.keys(annotations)) {
      if (key.startsWith(NGINX) || key.startsWith('cert-manager.io/') || key === 'kubernetes.io/tls-acme') delete annotations[key]
    }

    delete ingress.tls
    Object.assign(ingress, {annotations: {
      [`${ALB}healthcheck-path`]: service === 'tso-service' ? '/health' : service === 'proof-coordinator' ? '/healthz' : service === 'dstack-controller' ? '/healthcheck' : service === 'scroll-monitor' ? '/api/health' : '/',
      ...(['dogecoin', 'l1-devnet', 'l1-interface', 'l2-reth-rpc-public'].includes(service) ? {[`${ALB}success-codes`]: '200-499'} : {}),
      [`${ALB}listen-ports`]: '[{"HTTPS":443}]',
      [`${ALB}scheme`]: 'internet-facing',
      [`${ALB}ssl-policy`]: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      [`${ALB}target-type`]: 'ip',
      ...(service === 'proof-coordinator' ? {[`${ALB}load-balancer-attributes`]: 'idle_timeout.timeout_seconds=120'} : {}),
      ...annotations,
    }})
    if (validate && ingress.enabled !== false) {
      const fail = (message: string): never => {throw new Error(`${service}: values/${service}-production.yaml ingress: ${message}`)}
      const cert = ingress.annotations[`${ALB}certificate-arn`]
      const certificateArn = /^arn:aws(?:-us-gov|-cn)?:acm:[\da-z-]+:\d{12}:certificate\/[\da-f-]+$/i
      if (typeof cert !== 'string' || !cert.split(',').every(value => certificateArn.test(value.trim()))) fail('set alb.ingress.kubernetes.io/certificate-arn to an issued ACM certificate ARN covering this host before prep-charts')
      if (['proof-coordinator', 'tso-service'].includes(service) && Object.hasOwn(ingress.annotations, `${ALB}group.name`)) fail('remove alb.ingress.kubernetes.io/group.name; TSO and Proof Coordinator require independent ALBs')
      for (const [key, value] of Object.entries(ingress.annotations)) {
        if (typeof value === 'string' && /<[^>]+>|\btodo\b|replace_with|\$env:/i.test(value)) fail(`resolve or remove placeholder annotation ${key}`)
      }

      if (service === 'proof-coordinator') {
        const attributes = String(ingress.annotations[`${ALB}load-balancer-attributes`]).split(',')
        const timeout = attributes.find(value => value.trim().startsWith('idle_timeout.timeout_seconds='))?.split('=')[1]
        if (!timeout || !/^\d+$/.test(timeout.trim()) || Number(timeout) < 120) fail('set idle_timeout.timeout_seconds to at least 120 in alb.ingress.kubernetes.io/load-balancer-attributes')
      }
    }
  }

  // Helm recursively merges chart defaults: explicit tombstones prevent old
  // packaged defaults from reintroducing nginx annotations/TLS at render time.
  if (service === 'dogecoin') {
    ingress.annotations[`${NGINX}backend-protocol`] = null
    ingress.tls = []
  }

  if (service === 'blockscout') for (const key of ['enable-cors', 'cors-allow-origin', 'cors-allow-headers', 'cors-allow-methods', 'cors-max-age']) ingress.annotations[`${NGINX}${key}`] = null
  return ingress
}

/** Reconcile the two public service edges after merging SDK and operator values. */
export function reconcilePublicServiceValues(values: Record<string, any>, service: PublicIngressService, validate = true): void {
  for (const [key, ingress] of Object.entries(values.ingress ?? {})) {
    if (ingress && typeof ingress === 'object') values.ingress[key] = reconcilePublicServiceIngress(ingress, service, validate)
  }
}

/** The values shapes used by common, Grafana, Dogecoin, dstack and Blockscout. */
export function deploymentIngresses(values: Record<string, any>): Record<string, any>[] {
  const result: Record<string, any>[] = []
  const add = (ingress: any): void => {
    if (!ingress || typeof ingress !== 'object' || Array.isArray(ingress)) return
    if (['enabled', 'hosts', 'hostname', 'className', 'ingressClassName'].some(key => key in ingress)) result.push(ingress)
    else for (const entry of Object.values(ingress)) add(entry)
  }

  add(values.ingress)
  add(values.grafana?.ingress)
  for (const component of Object.values(values['blockscout-stack'] ?? {})) add((component as any)?.ingress)
  return result
}

/** Normalize only edge settings; leave operator enable switches and routes intact. */
export function reconcileDeploymentIngresses(values: Record<string, any>, service: string, validate = true): void {
  for (const ingress of deploymentIngresses(values)) {
    if (['dogecoin', 'dstack-controller', 'l1-devnet', 'scroll-monitor'].includes(service) && ingress.enabled === undefined) ingress.enabled = false
    const standard = Object.hasOwn(ingress, 'className') || ['blockscout', 'dogecoin', 'dstack-controller'].includes(service)
    const normalized = reconcilePublicServiceIngress({...ingress, ingressClassName: ingress.ingressClassName ?? ingress.className}, service, validate)
    if (standard) {
      delete normalized.className
      normalized.className = normalized.ingressClassName
      delete normalized.ingressClassName
    }

    for (const key of Object.keys(ingress)) delete ingress[key]
    Object.assign(ingress, normalized)
  }
}
