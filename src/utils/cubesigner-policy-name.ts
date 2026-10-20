/** Use the intersection of CubeSigner alias rules and the supported native signer contract. */
export function isCubesignerPolicyName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && /^[\da-z][\d_a-z]{2,29}$/.test(value) && !value.includes('latest')
}

/** Keep concrete version checks separate from the provider's alias constraints. */
export function isCubesignerPolicyIdentifier(value: unknown, minimumVersion: 0 | 1 = 0): value is string {
  if (typeof value !== 'string' || value !== value.trim()) return false
  const [name, version, extra] = value.split('/')
  return isCubesignerPolicyName(name) && extra === undefined && /^v(?:0|[1-9]\d{0,8})$/.test(version ?? '')
    && (minimumVersion === 0 || version !== 'v0')
}
