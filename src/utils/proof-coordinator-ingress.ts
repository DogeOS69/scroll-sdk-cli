/** Build the public prover route while retaining operator annotations and TLS secret. */
export function buildProofCoordinatorIngress(host: string, existing: Record<string, any> = {}): Record<string, any> {
  return {
    ...existing,
    enabled: true,
    hosts: [{
      host,
      paths: [{path: '/', pathType: 'Prefix', service: {port: 7788}}],
    }],
    ingressClassName: existing.ingressClassName || 'nginx',
    tls: [{hosts: [host], secretName: existing.tls?.[0]?.secretName || 'proof-coordinator-tls'}],
  }
}
