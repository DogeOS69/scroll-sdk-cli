import {reconcilePublicServiceIngress} from './public-service-ingress.js'

/** Build the public prover route without overriding the operator's controller. */
export function buildProofCoordinatorIngress(host: string, existing: Record<string, any> = {}, validate = true): Record<string, any> {
  return reconcilePublicServiceIngress({
    ...existing,
    enabled: true,
    hosts: [{
      host,
      paths: [{path: '/v1/prover/tasks', pathType: 'Prefix', service: {port: 7788}}],
    }],
  }, 'proof-coordinator', validate)
}
