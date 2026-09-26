import {randomUUID} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {InstatusPlan, InstatusTarget} from './status-page-instatus.js'

interface Binding {
  pageId: string
  subdomain: string
}

interface State {
  bindings: Record<string, Binding>
  version: 1
}

const validId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]+$/.test(value)
const validSubdomain = (value: unknown): value is string => typeof value === 'string' && /^[\da-z](?:[\da-z-]*[\da-z])?$/.test(value)

/** Deployment-owned identifiers, kept outside regenerated Helm values. No credentials. */
export class StatusPageState {
  private readonly file: string
  private readonly network: string
  private readonly state: State

  constructor(root: string, environment: string) {
    this.file = path.join(root, '.data/status-page-state.json')
    this.network = environment
    this.state = {bindings: {}, version: 1}
    if (!fs.existsSync(this.file)) return
    try {
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8')) as State
      if (state.version !== 1 || !state.bindings || typeof state.bindings !== 'object' || Array.isArray(state.bindings)) throw new Error('Invalid status-page binding state')
      for (const [key, binding] of Object.entries(state.bindings)) {
        if (!/^(devnet|mainnet|testnet)$/.test(key) || !binding
          || (binding.pageId !== '' && !validId(binding.pageId))
          || (binding.subdomain !== '' && !validSubdomain(binding.subdomain))
          || (!binding.pageId && !binding.subdomain)) throw new Error('Invalid status-page binding state')
      }

      this.state = state
    } catch {
      throw new Error('Cannot read .data/status-page-state.json; restore the deployment binding instead of creating a replacement project')
    }

    if (Object.keys(this.state.bindings).some(network => network !== environment)) {
      throw new Error('This deployment directory is already bound to another network; use a separate deployment directory')
    }
  }

  bind(pageId: string): void {
    this.save({pageId, subdomain: this.state.bindings[this.network]?.subdomain ?? ''})
  }

  /** Record the chosen subdomain before POST, so interrupted creation cannot drift to a new name. */
  reserve(plan: InstatusPlan): void {
    this.save({pageId: plan.page.id, subdomain: plan.page.subdomain ?? ''})
  }

  restore(target: InstatusTarget): boolean {
    const binding = this.state.bindings[this.network]
    if (!binding) return false
    if ((binding.pageId && target.pageId && binding.pageId !== target.pageId)
      || (binding.subdomain && target.subdomain && binding.subdomain !== target.subdomain)) {
      throw new Error('This network already has an Instatus project binding; pageId/subdomain changes require an explicit migration')
    }

    const changed = Boolean((binding.pageId && target.pageId !== binding.pageId) || (binding.subdomain && target.subdomain !== binding.subdomain))
    if (binding.pageId) target.pageId = binding.pageId
    if (binding.subdomain) target.subdomain = binding.subdomain
    return changed
  }

  private save(binding: Binding): void {
    const restored = {...binding, componentIds: {}, initialStatus: '', showUptime: false}
    this.restore(restored)
    binding = {pageId: restored.pageId, subdomain: restored.subdomain ?? ''}
    this.state.bindings[this.network] = binding
    fs.mkdirSync(path.dirname(this.file), {recursive: true})
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {flag: 'wx', mode: 0o600})
      fs.renameSync(temporary, this.file)
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
  }
}

/** Serialize apply processes sharing a deployment root; never silently remove another process's lock. */
export function lockStatusPageApply(root: string): () => void {
  const directory = path.join(root, '.data')
  fs.mkdirSync(directory, {recursive: true})
  const lock = path.join(directory, 'status-page-apply.lock')
  let descriptor: number
  try {
    descriptor = fs.openSync(lock, 'wx', 0o600)
  } catch {
    throw new Error('Cannot acquire .data/status-page-apply.lock; another apply may be running. Remove a stale lock only after confirming that process has stopped')
  }

  fs.closeSync(descriptor)
  return () => fs.unlinkSync(lock)
}
