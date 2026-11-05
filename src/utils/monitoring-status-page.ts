import {isDeepStrictEqual} from 'node:util'

import type {MonitoringRuntimeConfig} from './monitoring-slack.js'

/** Project the saved intent. Spec bindings and deadlines win when set; every other value stays with the values file. */
export function reconcileMonitoringStatusPage(values: Record<string, any>, config?: MonitoringRuntimeConfig): Array<{key: string; newValue: string; oldValue: string}> {
  if (!config?.statusPage) return []
  const {enabled} = config.statusPage
  if (typeof enabled !== 'boolean') throw new Error('monitoring.statusPage.enabled must be a boolean')
  if (!config.environment || !['devnet', 'mainnet', 'testnet'].includes(config.environment)) throw new Error('Status-page monitoring requires the environment projected from deployment metadata')
  const previous = values.statusPage
  if (previous?.generated && !enabled) throw new Error('statusPage was generated: remove its managed publication configuration before disabling')
  if (previous?.generated && previous.generated.environment !== config.environment) throw new Error('statusPage environment changed; use a separate monitoring configuration and Instatus target for each environment')
  const next = {...previous, enabled, environment: config.environment}
  const {health, instatus} = config.statusPage
  if (instatus) {
    next.instatus = {...previous?.instatus, ...instatus}
    if (instatus.componentIds) next.instatus.componentIds = {...previous?.instatus?.componentIds, ...instatus.componentIds}
  }

  if (health) next.publication = {...previous?.publication, health: {...previous?.publication?.health, ...health}}
  if (isDeepStrictEqual(previous, next)) return []
  values.statusPage = next
  return [{key: 'statusPage intent', newValue: `[enabled=${enabled}, environment=${config.environment}]`, oldValue: '[previous intent]'}]
}
