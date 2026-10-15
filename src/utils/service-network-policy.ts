import {isIP} from 'node:net'

/** Validate explicit deployment peers before producing installable bridge values. */
export function validateServiceNetworkPolicy(values: Record<string, any>, service: string, deferIngressValidation = false): void {
  if (!['tso-service', 'withdrawal-processor'].includes(service)) return
  const fail = (reason: string): never => {throw new Error(`${service}: networkPolicy ${reason}; edit values/${service}-production.yaml`)}
  const policy = values.networkPolicy
  if (policy?.enabled !== true) fail('must be enabled')
  const groups = policy.allowFrom
  if (!groups || typeof groups !== 'object') fail('allowFrom is required')
  const required = service === 'tso-service' ? ['withdrawalProcessor', 'signers'] : ['tso']
  if (service === 'tso-service' && values.ingress?.main?.enabled !== false && !deferIngressValidation) required.push('edge')
  if (service === 'withdrawal-processor' && values.service?.main?.ports?.['proof-work']?.enabled) required.push('proofCoordinator')
  for (const group of required) if (!Array.isArray(groups[group]) || groups[group].length === 0) fail(`allowFrom.${group} must identify the required callers`)
  for (const [group, peers] of Object.entries(groups)) {
    // ALB subnet inputs are operator-owned and may be unknown while baking
    // proofs. Internal service peers and isolation remain mandatory.
    if (service === 'tso-service' && group === 'edge' && deferIngressValidation) continue
    if (!Array.isArray(peers)) fail(`allowFrom.${group} must be a list`)
    for (const peer of peers as any[]) {
      if (peer?.ipBlock) {
        const cidr = String(peer.ipBlock.cidr ?? '')
        const [address, bits, extra] = cidr.split('/')
        const family = isIP(address)
        if (!family || extra !== undefined || !/^\d+$/.test(bits ?? '') || Number(bits) < 1 || Number(bits) > (family === 4 ? 32 : 128)) fail(`allowFrom.${group} requires explicit restricted CIDRs, not placeholders or all-address ranges`)
      } else if (!peer?.podSelector || !(Object.keys(peer.podSelector.matchLabels ?? {}).length > 0 || peer.podSelector.matchExpressions?.length)) {
        fail(`allowFrom.${group} requires a nonempty podSelector; add namespaceSelector for cross-namespace callers`)
      }
    }
  }
}
