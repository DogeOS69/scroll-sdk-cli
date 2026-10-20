/** CubeSigner aliases contain 3–30 ASCII letters, digits or underscores. */
export function isCubesignerPolicyName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && /^\w{3,30}$/.test(value)
}

/** Keep concrete version checks separate from the provider's alias constraints. */
export function isCubesignerPolicyIdentifier(value: unknown, minimumVersion: 0 | 1 = 0): value is string {
  if (typeof value !== 'string' || value !== value.trim()) return false
  const [name, version, extra] = value.split('/')
  return isCubesignerPolicyName(name) && extra === undefined && /^v(?:0|[1-9]\d{0,8})$/.test(version ?? '')
    && (minimumVersion === 0 || version !== 'v0')
}
