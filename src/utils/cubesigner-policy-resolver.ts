import {isDeepStrictEqual} from 'node:util'

interface ResolverConfiguration {allowed_http_authorities: string[]}
export interface ResolverOrganization {
  id: string
  policyEngineConfiguration(): Promise<ResolverConfiguration | undefined>
  setPolicyEngineConfiguration(value: ResolverConfiguration): Promise<void>
}

/** The provider replaces the whole configuration; preserve every existing field. */
export async function configurePolicyResolver(options: {
  apply: boolean; baseUrl: string; org: ResolverOrganization; organization: string
}): Promise<{applied: boolean; authority: string; changed: boolean; current: string[]; organization: string; proposed: string[]; readback: string}> {
  const url = new URL(options.baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) throw new Error('Resolver requires a public HTTPS base URL ending in /')
  if (options.org.id !== options.organization) throw new Error('Management session belongs to a different CubeSigner organization')
  const authority = url.host
  const before = await options.org.policyEngineConfiguration()
  const current = before?.allowed_http_authorities ?? []
  if (!Array.isArray(current) || current.some(value => typeof value !== 'string')) throw new Error('Unexpected CubeSigner HTTP authority configuration')
  const changed = !current.some(value => value.toLowerCase() === authority)
  const proposed = changed ? [...current, authority] : [...current]
  let readback = 'not-applied'
  if (options.apply) {
    if (changed) {
      const latest = await options.org.policyEngineConfiguration()
      if (!isDeepStrictEqual(latest, before)) throw new Error('CubeSigner resolver configuration changed during review; retry with the current configuration')
      await options.org.setPolicyEngineConfiguration({...before, allowed_http_authorities: proposed})
    }

    const observed = await options.org.policyEngineConfiguration()
    const expected = {...before, allowed_http_authorities: proposed}
    if (!isDeepStrictEqual(observed, expected)) throw new Error('CubeSigner resolver readback mismatch; inspect the organization before retrying')
    readback = 'verified'
  }

  return {applied: options.apply, authority, changed, current, organization: options.organization, proposed, readback}
}
