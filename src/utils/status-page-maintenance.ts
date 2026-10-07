/* eslint-disable @typescript-eslint/no-explicit-any -- Validated Helm inputs. */
export function normalizeMaintenance(input: any = [], keys: readonly string[]): any[] {
  if (!Array.isArray(input) || input.length > 100) throw new Error('maintenanceWindows must be a list of at most 100 windows')
  const seen = new Set<string>()
  return input.map(window => {
    if (!window || typeof window !== 'object' || Object.keys(window).some(k => !['components', 'end', 'id', 'start'].includes(k)) ||
        typeof window.id !== 'string' || !/^[\da-z][\da-z-]{0,62}$/.test(window.id) || seen.has(window.id)) throw new Error('Maintenance windows require unique stable ids')
    seen.add(window.id)
    for (const key of ['start', 'end']) if (typeof window[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(window[key]) || !Number.isFinite(Date.parse(window[key])) || new Date(window[key]).toISOString().replace('.000Z', 'Z') !== window[key]) throw new Error('Maintenance times must be valid UTC timestamps YYYY-MM-DDTHH:mm:ssZ')
    if (Date.parse(window.end) <= Date.parse(window.start)) throw new Error('Maintenance end must follow start')
    if (!Array.isArray(window.components) || window.components.length === 0 || window.components.some((k: any) => !keys.includes(k)) || new Set(window.components).size !== window.components.length) throw new Error('Maintenance requires distinct component keys from this network')
    return {components: [...window.components], end: window.end, id: window.id, start: window.start}
  })
}
