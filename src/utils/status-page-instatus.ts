export interface StatusPageCatalog {
  components: Array<{description: string; endpoints: string[]; key: string; name: string}>
  environment: string
  groupName?: string
  pageName: string
}

export interface InstatusTarget {
  branding?: {faviconUrl?: string; logoUrl?: string; websiteUrl?: string}
  componentIds: Record<string, string>
  email?: string
  groupId?: string
  initialStatus: string
  pageId: string
  showUptime: boolean
  subdomain?: string
  workspaceSlug?: string
}

interface RemoteComponent {
  archived?: boolean
  archivedAt?: null | string
  children?: RemoteComponent[]
  description: string
  group?: {id: string; name?: string} | null | string
  groupId?: null | string
  id: string
  isParent?: boolean
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
  branding?: InstatusTarget['branding']
  components: Array<{action: 'create' | 'unchanged' | 'update'; id?: string; key: string; metadata: Metadata}>
  group?: {action: 'bootstrap' | 'reuse'; id: string; name: string}
  initialStatus: string
  page: {action: 'create' | 'unchanged' | 'update'; email?: string; id: string; name: string; subdomain?: string}
  workspace?: {id: string; slug: string}
}

const componentGroupId = (item: RemoteComponent) => item.groupId ?? (typeof item.group === 'string' ? item.group : item.group?.id)

const STATUSES = new Set(['OPERATIONAL', 'UNDERMAINTENANCE', 'DEGRADEDPERFORMANCE', 'PARTIALOUTAGE', 'MAJOROUTAGE'])

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]+$/.test(value)
}

/** The live component list nests children under isParent records. */
function flattenComponents(items: RemoteComponent[]): RemoteComponent[] {
  const result: RemoteComponent[] = []
  const seen = new Set<string>()
  const visit = (item: RemoteComponent, parent?: RemoteComponent) => {
    if (!item || !validId(item.id) || seen.has(item.id)) throw new Error('Instatus returned invalid or repeated component IDs')
    seen.add(item.id)
    if (parent && componentGroupId(item) && componentGroupId(item) !== parent.id) throw new Error('Instatus returned conflicting component group ownership')
    const normalized = {
      ...item,
      archived: Boolean(item.archived || item.archivedAt || parent?.archived),
      ...(parent ? {group: {id: parent.id, name: parent.name}, groupId: parent.id} : {}),
    }
    result.push(normalized)
    if (item.children !== undefined) {
      if (!Array.isArray(item.children) || (item.children.length > 0 && !item.isParent)) throw new Error('Instatus returned an invalid component tree')
      for (const child of item.children) visit(child, normalized)
    }
  }

  for (const item of items) visit(item)
  return result
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
    if (plan.group?.action === 'bootstrap' && plan.page.action !== 'create') {
      throw new Error(`Initialize the ${plan.group.name} group with a Public RPC component (reuse an existing empty group) in Instatus, then rerun --plan; group creation is not available through the verified public API`)
    }

    if (plan.components.some(component => component.action === 'create') && !STATUSES.has(plan.initialStatus)) {
      throw new Error('Creating components requires an explicit statusPage.instatus.initialStatus after checking service health; inspect --plan first')
    }

    let pageId = plan.page.id
    if (plan.page.action === 'create') {
      const created = await this.request<{id: string}>('/v1/pages', 'POST', {
        ...plan.branding, components: [], email: plan.page.email, name: plan.page.name, subdomain: plan.page.subdomain,
      })
      if (!validId(created?.id)) throw new Error('Instatus create returned no valid page ID; rerun --plan before retrying')
      pageId = created.id
    }

    savePage(pageId)
    if (plan.group?.action === 'bootstrap') return // Page created; initialize its group in the dashboard before continuing.
    for (const component of plan.components) {
      let {id} = component
      if (component.action === 'create') {
        const created = await this.request<{id: string}>(`/v1/${pageId}/components`, 'POST', {
          ...component.metadata, archived: false, grouped: Boolean(plan.group), ...(plan.group ? {group: plan.group.id} : {}), status: plan.initialStatus,
        })
        if (!validId(created?.id)) throw new Error('Instatus create returned no valid component ID; rerun --plan before retrying')
        id = created.id
      } else if (component.action === 'update') {
        // Preserve live status and explicitly retain this network group.
        await this.request(`/v2/${pageId}/components/${id}`, 'PUT', {...component.metadata, ...(plan.group ? {groupId: plan.group.id, grouped: true} : {})})
      }

      if (id) saveId(component.key, id)
    }

    if (plan.page.action === 'update') await this.request(`/v2/${pageId}`, 'PUT', {...plan.branding, name: plan.page.name})
  }

  async bindGrafanaWebhook(integrationId: string, pageId: string, componentId: string, templates?: {createTemplate: object; resolveTemplate: object}): Promise<void> {
    if (!validId(integrationId) || !validId(pageId) || !validId(componentId)) throw new Error('Valid page and component IDs are required to bind a webhook')
    // Idempotent PUT also reconciles dashboard edits before reusing a private binding.
    await this.request(`/v3/integrations/${integrationId}`, 'PUT', {components: [componentId], integrationType: 'GRAFANA', ...templates, pageId})
  }

  async configureCronMonitor(id: string, alerts: string[], enabled = true): Promise<void> {
    if (!validId(id) || alerts.some(alert => !validId(alert))) throw new Error('Invalid heartbeat monitor or alert ID')
    await this.request(`/monitors/cron/${id}`, 'PUT', {alerts, grace: 180, onFail: {createIncident: false, createOutageDuration: false, notifySubscribers: false, publishIncident: false}, onRecover: {notifySubscribers: false, publishIncident: false, resolveIncident: false, resolveOutageDuration: false},
      period: 60,
      state: enabled ? 'ACTIVE' : 'PAUSED',
    })
  }

  async createCronMonitor(pageId: string, name: string, alerts: string[]): Promise<{id: string; url: string}> {
    if (!validId(pageId) || alerts.length === 0 || alerts.some(alert => !validId(alert))) throw new Error('Valid page and internal alert IDs are required for a heartbeat')
    const result = await this.request<{cronMonitor: {componentId: null | string; id: string; siteId: string; slug: string}}>('/monitors/cron', 'POST', {
      alerts, createComponent: false, grace: 180, name, onFail: {createIncident: false, createOutageDuration: false, notifySubscribers: false, publishIncident: false}, onRecover: {notifySubscribers: false, publishIncident: false, resolveIncident: false, resolveOutageDuration: false},
      pageId,
      period: 60,
    })
    const monitor = result.cronMonitor
    if (!monitor || !/^[\w-]+$/.test(monitor.id) || !/^[\w-]+$/.test(monitor.slug) || monitor.siteId !== pageId || monitor.componentId) throw new Error('Invalid heartbeat creation response; do not create a replacement')
    return {id: monitor.id, url: `https://cron.instatus.com/${monitor.slug}`}
  }

  async createGrafanaWebhook(pageId: string, componentId?: string): Promise<{integrationId: string; url: string}> {
    if (!validId(pageId)) throw new Error('A valid Instatus page ID is required before creating a webhook')
    if (componentId !== undefined && !validId(componentId)) throw new Error('A valid component ID is required for a component webhook')
    // Legacy bootstrap stays unbound; component integrations have one explicit target.
    const result = await this.request<{integration: {id: string; monitoringTool: string; siteId: string; uniqueUrl: string}}>(
      '/v3/integrations', 'POST', {components: componentId ? [componentId] : [], integrationType: 'GRAFANA', pageId},
    )
    const integration = result?.integration
    if (!validId(integration?.id) || integration.monitoringTool !== 'GRAFANA' || integration.siteId !== pageId) {
      throw new Error('Instatus returned an unexpected Grafana integration; inspect the dashboard before recovery')
    }

    return {integrationId: integration.id, url: validateGrafanaWebhookUrl(integration.uniqueUrl)}
  }

  async hasCronMonitor(pageId: string, name: string): Promise<boolean> {
    return (await this.listCronMonitors(pageId)).some(item => item.name === name)
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

    let workspace: {id: string; slug: string} | undefined
    if (target.workspaceSlug) {
      if (!/^[\da-z-]+$/.test(target.workspaceSlug)) throw new Error('Invalid statusPage.instatus.workspaceSlug')
      const workspaces = await this.list<{id: string; slug: string}>('/v1/workspaces')
      const matches = workspaces.filter(item => item.slug === target.workspaceSlug)
      if (matches.length !== 1) throw new Error('Selected Instatus workspace is missing or ambiguous')
      workspace = {id: matches[0].id, slug: matches[0].slug}
    }

    const pages = await this.list<{id: string; name: string; subdomain: string; workspaceId?: string} & NonNullable<InstatusTarget['branding']>>('/v2/pages')
    const pagesMatched = pages.filter(item => target.pageId ? item.id === target.pageId : item.subdomain === target.subdomain)
    if (pagesMatched.length > 1) throw new Error('Ambiguous Instatus page target')
    const page = pagesMatched[0]
    if (!page && target.pageId) throw new Error('The configured Instatus page is not accessible with this API key')
    if (workspace && (!page || page.workspaceId !== workspace.id)) throw new Error('Selected page must already exist in the selected Instatus workspace; refusing to create a new workspace or use another project')
    if (page && target.subdomain && page.subdomain !== target.subdomain) throw new Error('Instatus pageId and subdomain select different targets')
    if (!page && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target.email ?? '')) throw new Error('Creating an Instatus page requires statusPage.instatus.email')
    const remote = page ? flattenComponents(await this.list<RemoteComponent>(`/v2/${page.id}/components`)) : []
    let group: InstatusPlan['group']
    if (catalog.groupName) {
      const expected = {devnet: 'Devnet', mainnet: 'Mainnet', testnet: 'Testnet'}[catalog.environment]
      if (catalog.groupName !== expected) throw new Error('Catalog group must match the explicit network environment')
      const groups = new Map<string, {id: string; name?: string}>()
      for (const item of remote) {
        if (item.isParent && item.name === catalog.groupName) {
          if (item.archived) throw new Error('Selected Instatus network group is archived')
          groups.set(item.id, {id: item.id, name: item.name})
        }

        if (item.group && typeof item.group === 'object' && item.group.name === catalog.groupName) groups.set(item.group.id, item.group)
      }

      if (groups.size > 1) throw new Error('Ambiguous network group; merge or rename duplicate groups in Instatus first')
      const existing = [...groups.values()][0]
      if (existing && !validId(existing.id)) throw new Error('Instatus returned an invalid component group ID')
      if (target.groupId && target.groupId !== existing?.id) throw new Error('Configured groupId does not match the network group on the selected page; initialize it with a Public RPC component first')
      group = {action: existing ? 'reuse' : 'bootstrap', id: existing?.id ?? '', name: catalog.groupName}
    }

    const matched = new Set<string>()
    const components = catalog.components.map((component, order) => {
      const id = target.componentIds[component.key]
      const inScope = (item: RemoteComponent) => !item.isParent && (group ? Boolean(group.id) && componentGroupId(item) === group.id : !componentGroupId(item))
      const matches = remote.filter(item => id ? item.id === id : item.name === component.name && (group ? inScope(item) : true))
      if (matches.length > 1) throw new Error(`Ambiguous Instatus component ${component.key}; configure its componentIds entry`)
      const existing = matches[0]
      if (id && !existing) throw new Error(`Configured Instatus component ${component.key} was not found on the selected page`)
      if (existing && (!inScope(existing) || existing.archived)) throw new Error(`Instatus component ${component.key} belongs to another group or is archived; resolve it explicitly before applying`)
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
    return {branding: target.branding, components, group, initialStatus: target.initialStatus, page: {
      action: page ? (page.name === catalog.pageName && Object.entries(target.branding ?? {}).every(([key, value]) => page[key as keyof typeof page] === value) ? 'unchanged' : 'update') : 'create',
      email: page ? undefined : target.email,
      id: page?.id ?? '',
      name: catalog.pageName,
      subdomain: target.subdomain || page?.subdomain,
    }, workspace}
  }

  async verifyCronMonitor(id: string, pageId: string, name: string): Promise<void> {
    const matches = (await this.listCronMonitors(pageId)).filter(item => item.name === name)
    if (matches.length !== 1 || matches[0].id !== id || matches[0].componentId) throw new Error('Heartbeat monitor identity or component binding changed')
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

  private async listCronMonitors(pageId: string): Promise<Array<{componentId: null | string; id: string; name: string; siteId: string}>> {
    const monitors: Array<{componentId: null | string; id: string; name: string; siteId: string}> = []
    for (let page = 1; page <= 1000; page++) {
      const result = await this.request<{cronMonitors: typeof monitors; totalPages: number}>(`/${pageId}/monitors/cron?limit=100&page=${page}`)
      if (!Array.isArray(result.cronMonitors) || !Number.isSafeInteger(result.totalPages) || result.cronMonitors.some(item => !validId(item.id) || item.siteId !== pageId || monitors.some(previous => previous.id === item.id))) throw new Error('Invalid Instatus cron monitor listing')
      monitors.push(...result.cronMonitors)
      if (page >= result.totalPages) return monitors
    }

    throw new Error('Instatus cron monitor pagination limit exceeded')
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
