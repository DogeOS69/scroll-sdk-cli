export interface StatusPageCatalog {
  components: Array<{description: string; endpoints: string[]; key: string; name: string}>
  environment: string
  pageName: string
}

export interface InstatusTarget {
  componentIds: Record<string, string>
  email?: string
  initialStatus: string
  pageId: string
  showUptime: boolean
  subdomain?: string
}

interface RemoteComponent {
  archived?: boolean
  description: string
  group?: {id: string} | null | string
  id: string
  name: string
  order: number
  showUptime: boolean
}

interface Metadata {
  description: string
  name: string
  order: number
  showUptime: boolean
}

export interface InstatusPlan {
  components: Array<{action: 'create' | 'unchanged' | 'update'; id?: string; key: string; metadata: Metadata}>
  initialStatus: string
  page: {action: 'create' | 'unchanged' | 'update'; email?: string; id: string; name: string; subdomain?: string}
}

const STATUSES = new Set(['OPERATIONAL', 'UNDERMAINTENANCE', 'DEGRADEDPERFORMANCE', 'PARTIALOUTAGE', 'MAJOROUTAGE'])

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]+$/.test(value)
}

/** Treat the complete URL (and the integration ID embedded in it) as credentials. */
export function validateGrafanaWebhookUrl(value: unknown): string {
  if (typeof value !== 'string' || !/^https:\/\/api\.instatus\.com\/v\d+\/integrations\/grafana\/[\w-]+$/.test(value)) {
    throw new Error('Expected a complete HTTPS Instatus Grafana webhook URL; credential contents are omitted')
  }

  return value
}

/** Management client is only instantiated for explicit --plan / --apply. */
export class InstatusClient {
  constructor(private readonly apiKey: string, private readonly transport: typeof fetch = fetch) {
    if (!apiKey || /\s/.test(apiKey)) throw new Error('Set INSTATUS_API_KEY for --plan or --apply')
  }

  async apply(plan: InstatusPlan, saveId: (key: string, id: string) => void, savePage: (id: string) => void): Promise<void> {
    // Validate the whole plan before the first remote mutation.
    if (plan.components.some(component => component.action === 'create') && !STATUSES.has(plan.initialStatus)) {
      throw new Error('Creating components requires an explicit statusPage.instatus.initialStatus after checking service health; inspect --plan first')
    }

    let pageId = plan.page.id
    if (plan.page.action === 'create') {
      const created = await this.request<{id: string}>('/v1/pages', 'POST', {
        components: [], email: plan.page.email, name: plan.page.name, subdomain: plan.page.subdomain,
      })
      if (!validId(created?.id)) throw new Error('Instatus create returned no valid page ID; rerun --plan before retrying')
      pageId = created.id
    }

    savePage(pageId)
    for (const component of plan.components) {
      let {id} = component
      if (component.action === 'create') {
        const created = await this.request<{id: string}>(`/v1/${pageId}/components`, 'POST', {
          ...component.metadata, archived: false, grouped: false, status: plan.initialStatus,
        })
        if (!validId(created?.id)) throw new Error('Instatus create returned no valid component ID; rerun --plan before retrying')
        id = created.id
      } else if (component.action === 'update') {
        // Never send status, archived, group, incidents or maintenance fields.
        await this.request(`/v2/${pageId}/components/${id}`, 'PUT', component.metadata)
      }

      if (id) saveId(component.key, id)
    }

    if (plan.page.action === 'update') await this.request(`/v2/${pageId}`, 'PUT', {name: plan.page.name})
  }

  async createGrafanaWebhook(pageId: string): Promise<{integrationId: string; url: string}> {
    if (!validId(pageId)) throw new Error('A valid Instatus page ID is required before creating a webhook')
    // No public component mappings or alerts are enabled during bootstrap.
    const result = await this.request<{integration: {id: string; monitoringTool: string; siteId: string; uniqueUrl: string}}>(
      '/v3/integrations', 'POST', {components: [], integrationType: 'GRAFANA', pageId},
    )
    const integration = result?.integration
    if (!validId(integration?.id) || integration.monitoringTool !== 'GRAFANA' || integration.siteId !== pageId) {
      throw new Error('Instatus returned an unexpected Grafana integration; inspect the dashboard before recovery')
    }

    return {integrationId: integration.id, url: validateGrafanaWebhookUrl(integration.uniqueUrl)}
  }

  async plan(catalog: StatusPageCatalog, target: InstatusTarget): Promise<InstatusPlan> {
    if (target.pageId ? !validId(target.pageId) : !/^[\da-z](?:[\da-z-]*[\da-z])?$/.test(target.subdomain ?? '')) {
      throw new Error('Set statusPage.instatus.pageId for an existing page, or subdomain for an explicitly named new page')
    }

    if (typeof target.showUptime !== 'boolean') throw new Error('statusPage.instatus.showUptime must be a boolean')
    if (target.initialStatus && !STATUSES.has(target.initialStatus)) throw new Error('Invalid statusPage.instatus.initialStatus')
    if (!target.componentIds || typeof target.componentIds !== 'object' || Array.isArray(target.componentIds)) throw new Error('statusPage.instatus.componentIds must be a mapping')
    const keys = new Set(catalog.components.map(component => component.key))
    const ids = Object.values(target.componentIds)
    if (Object.keys(target.componentIds).some(key => !keys.has(key)) || ids.some(id => !validId(id)) || new Set(ids).size !== ids.length) {
      throw new Error('statusPage.instatus.componentIds contains unknown keys, invalid IDs or duplicate IDs')
    }

    const pages = await this.list<{id: string; name: string; subdomain: string}>('/v2/pages')
    const pagesMatched = pages.filter(item => target.pageId ? item.id === target.pageId : item.subdomain === target.subdomain)
    if (pagesMatched.length > 1) throw new Error('Ambiguous Instatus page target')
    const page = pagesMatched[0]
    if (!page && target.pageId) throw new Error('The configured Instatus page is not accessible with this API key')
    if (page && target.subdomain && page.subdomain !== target.subdomain) throw new Error('Instatus pageId and subdomain select different targets')
    if (!page && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target.email ?? '')) throw new Error('Creating an Instatus page requires statusPage.instatus.email')
    const remote = page ? await this.list<RemoteComponent>(`/v2/${page.id}/components`) : []
    const matched = new Set<string>()
    const components = catalog.components.map((component, order) => {
      const id = target.componentIds[component.key]
      const matches = remote.filter(item => id ? item.id === id : item.name === component.name)
      if (matches.length > 1) throw new Error(`Ambiguous Instatus component ${component.key}; configure its componentIds entry`)
      const existing = matches[0]
      if (id && !existing) throw new Error(`Configured Instatus component ${component.key} was not found on the selected page`)
      if (existing?.group || existing?.archived) throw new Error(`Instatus component ${component.key} is grouped or archived; resolve it explicitly before applying`)
      if (existing && matched.has(existing.id)) throw new Error('Multiple catalog components resolve to the same Instatus component')
      if (existing) matched.add(existing.id)
      const metadata: Metadata = {
        description: [component.description, ...component.endpoints].join('\n'),
        name: component.name,
        order,
        showUptime: target.showUptime,
      }
      const changed = existing && Object.entries(metadata).some(([key, value]) => existing[key as keyof Metadata] !== value)
      return {action: existing ? (changed ? 'update' as const : 'unchanged' as const) : 'create' as const, id: existing?.id, key: component.key, metadata}
    })
    return {components, initialStatus: target.initialStatus, page: {
      action: page ? (page.name === catalog.pageName ? 'unchanged' : 'update') : 'create',
      email: page ? undefined : target.email,
      id: page?.id ?? '',
      name: catalog.pageName,
      subdomain: target.subdomain || page?.subdomain,
    }}
  }

  private async list<T extends {id: string}>(route: string): Promise<T[]> {
    const result: T[] = []
    const seen = new Set<string>()
    for (let page = 1; page <= 1000; page++) {
      const items = await this.request<T[]>(`${route}?page=${page}&per_page=100`)
      if (!Array.isArray(items)) throw new Error('Instatus returned an invalid list')
      for (const item of items) {
        if (!item || !validId(item.id) || seen.has(item.id)) throw new Error('Instatus returned invalid or repeated IDs during pagination')
        seen.add(item.id)
        result.push(item)
      }

      if (items.length < 100) return result
    }

    throw new Error('Instatus pagination limit exceeded')
  }

  private async request<T>(route: string, method = 'GET', body?: object): Promise<T> {
    let response: Response
    try {
      response = await this.transport(`https://api.instatus.com${route}`, {
        body: body ? JSON.stringify(body) : undefined,
        headers: {Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'scroll-sdk-cli/status-page'},
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      // Do not include provider bodies, transport errors or request headers in logs.
      throw new Error(`Instatus ${method} request failed; rerun --plan before retrying (a write may already have succeeded)`)
    }

    if (!response.ok) throw new Error(`Instatus ${method} returned HTTP ${response.status}; rerun --plan before retrying`)
    try {
      return await response.json() as T
    } catch {
      throw new Error('Instatus returned an invalid JSON response; rerun --plan before retrying')
    }
  }
}
