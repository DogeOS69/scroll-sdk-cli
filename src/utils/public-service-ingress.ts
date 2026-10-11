/* eslint-disable @typescript-eslint/no-explicit-any -- Shared Helm ingress values. */
const ALB = 'alb.ingress.kubernetes.io/'
const NGINX = 'nginx.ingress.kubernetes.io/'
export type PublicIngressService = 'proof-coordinator' | 'tso-service'

/** Controller, certificates and edge policy belong to operator values, not spec. */
export function reconcilePublicServiceIngress(existing: Record<string, any>, service: PublicIngressService, validate = true): Record<string, any> {
  const ingress = structuredClone(existing)
  const annotations = {...ingress.annotations}
  const controller = ingress.ingressClassName || annotations['kubernetes.io/ingress.class'] || 'alb'
  ingress.ingressClassName = controller
  delete annotations['kubernetes.io/ingress.class']
  if (controller === 'alb') {
    for (const key of Object.keys(annotations)) {
      if (key.startsWith(NGINX) || key.startsWith('cert-manager.io/') || key === 'kubernetes.io/tls-acme') delete annotations[key]
    }

    delete ingress.tls
    Object.assign(ingress, {annotations: {
      [`${ALB}healthcheck-path`]: service === 'tso-service' ? '/health' : '/healthz',
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
      if (Object.hasOwn(ingress.annotations, `${ALB}group.name`)) fail('remove alb.ingress.kubernetes.io/group.name; TSO and Proof Coordinator require independent ALBs')
      for (const [key, value] of Object.entries(ingress.annotations)) {
        if (typeof value === 'string' && /<[^>]+>|\btodo\b|replace_with|\$env:/i.test(value)) fail(`resolve or remove placeholder annotation ${key}`)
      }

      if (service === 'proof-coordinator') {
        const attributes = String(ingress.annotations[`${ALB}load-balancer-attributes`]).split(',')
        const timeout = attributes.find(value => value.trim().startsWith('idle_timeout.timeout_seconds='))?.split('=')[1]
        if (!timeout || !/^\d+$/.test(timeout.trim()) || Number(timeout) < 120) fail('set idle_timeout.timeout_seconds to at least 120 in alb.ingress.kubernetes.io/load-balancer-attributes')
      }
    }
  } else {
    // Switching controllers must not keep ALB-only configuration from the SDK template.
    for (const key of Object.keys(annotations)) if (key.startsWith(ALB)) delete annotations[key]
    ingress.annotations = annotations
    if (controller === 'nginx' && ingress.enabled !== false) {
      if (service === 'tso-service' && !Object.hasOwn(annotations, `${NGINX}proxy-body-size`)) annotations[`${NGINX}proxy-body-size`] = '16m'
      annotations['cert-manager.io/cluster-issuer'] ??= 'letsencrypt-prod'
      const hosts = (ingress.hosts ?? []).map((entry: any) => entry.host).filter(Boolean)
      if (hosts.length > 0) ingress.tls = [{...(ingress.tls?.[0] ?? {secretName: `${service}-tls`}), hosts}, ...(ingress.tls?.slice(1) ?? [])]
    }
  }

  return ingress
}

/** Reconcile the two public service edges after merging SDK and operator values. */
export function reconcilePublicServiceValues(values: Record<string, any>, service: PublicIngressService, validate = true): void {
  for (const [key, ingress] of Object.entries(values.ingress ?? {})) {
    if (ingress && typeof ingress === 'object') values.ingress[key] = reconcilePublicServiceIngress(ingress, service, validate)
  }
}
