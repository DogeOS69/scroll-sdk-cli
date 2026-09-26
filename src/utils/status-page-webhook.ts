import {spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {InstatusClient, validateGrafanaWebhookUrl} from './status-page-instatus.js'

interface Receipt {
  componentId?: string
  componentKey?: string
  environment: string
  integrationId?: string
  pageId: string
  status: 'creating' | 'ready'
  url?: string
  version: 1
}

export interface WebhookPlan {
  action: 'create' | 'import' | 'reuse' | 'unmanaged'
  secretFile: string
}

/** Private creation journal + credential backup. Never serialize this object into CLI output. */
export class StatusPageWebhook {
  readonly secretFile: string
  private readonly directory: string
  private importedIntegrationId?: string
  private importedUrl?: string
  private receipt?: Receipt
  private readonly receiptFile: string

  constructor(private readonly root: string, private readonly environment: string, private readonly componentKey?: string) {
    if (!/^(devnet|mainnet|testnet)$/.test(environment)) throw new Error('Invalid webhook environment')
    if (componentKey !== undefined && !/^[a-z][\da-z-]{0,40}$/.test(componentKey)) throw new Error('Invalid webhook component key')
    this.directory = path.join(root, 'secrets', 'status-page')
    this.receiptFile = path.join(this.directory, componentKey ? `${componentKey}.binding.json` : 'binding.json')
    this.secretFile = path.join(this.directory, componentKey ? `${componentKey}.secret.yaml` : 'grafana.secret.yaml')
    this.checkPaths()
    if (!fs.existsSync(this.receiptFile)) return
    try {
      const receipt = JSON.parse(fs.readFileSync(this.receiptFile, 'utf8')) as Receipt
      if (receipt.version !== 1 || !['devnet', 'mainnet', 'testnet'].includes(receipt.environment) || typeof receipt.pageId !== 'string' || !/^[\w-]+$/.test(receipt.pageId)
        || !['creating', 'ready'].includes(receipt.status)) throw new Error('Invalid receipt')
      if (componentKey && (typeof receipt.componentId !== 'string' || !/^[\w-]+$/.test(receipt.componentId))) throw new Error('Invalid component receipt')
      if (receipt.status === 'ready') {
        validateGrafanaWebhookUrl(receipt.url)
        if (componentKey && (typeof receipt.integrationId !== 'string' || !/^[\w-]+$/.test(receipt.integrationId))) throw new Error('Missing integration ID')
      }

      this.receipt = receipt
    } catch {
      throw new Error('Cannot read the private webhook binding; restore secrets/status-page/ from backup, never recreate blindly')
    }

    if (this.receipt.componentKey !== componentKey) throw new Error('The saved webhook belongs to a different component')
    if (this.receipt.environment !== environment) throw new Error('The saved webhook belongs to a different network; use that network\'s deployment directory')
  }

  async apply(plan: WebhookPlan, client: InstatusClient, pageId: string, secret: {key: string; name: string}, componentId?: string, templates?: {createTemplate: object; resolveTemplate: object}): Promise<void> {
    if (plan.action === 'unmanaged') return
    if (this.componentKey && (!componentId || !/^[\w-]+$/.test(componentId))) throw new Error('Component webhook requires a valid component ID')
    if (this.receipt?.componentId && this.receipt.componentId !== componentId) throw new Error('The saved webhook targets a different component ID')
    const binding = this.componentKey ? {componentId, componentKey: this.componentKey} : {}
    if (plan.action === 'create') {
      // Durable intent precedes POST. A timeout, invalid response or crash cannot cause an automatic second POST.
      this.save({...binding, environment: this.environment, pageId, status: 'creating', version: 1})
      const created = await client.createGrafanaWebhook(pageId, componentId)
      this.save({...binding, environment: this.environment, ...created, pageId, status: 'ready', version: 1})
    } else if (plan.action === 'import') {
      this.save({...binding, environment: this.environment, integrationId: this.importedIntegrationId, pageId, status: 'ready', url: this.importedUrl, version: 1})
    }

    if (this.receipt?.status !== 'ready' || this.receipt.pageId !== pageId) throw new Error('No matching webhook credential is available')
    const url = validateGrafanaWebhookUrl(this.receipt.url)
    if (componentId) await client.bindGrafanaWebhook(this.receipt.integrationId!, pageId, componentId, templates)
    // JSON is valid YAML. No namespace: deployment must explicitly select Grafana's namespace.
    const manifest = {apiVersion: 'v1', data: {[secret.key]: Buffer.from(url).toString('base64')}, kind: 'Secret', metadata: {name: secret.name}, type: 'Opaque'}
    this.write(this.secretFile, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  plan(pageId: string, create: boolean, requested: boolean, importFile?: string, componentId?: string): WebhookPlan {
    if (this.receipt?.componentId && componentId && this.receipt.componentId !== componentId) throw new Error('The saved webhook targets a different component ID')
    if (this.receipt && this.receipt.pageId !== pageId) throw new Error('The saved webhook belongs to a different Instatus page')
    if (importFile) {
      try {
        const contents = fs.readFileSync(path.resolve(this.root, importFile), 'utf8').trim()
        if (this.componentKey) {
          const imported = JSON.parse(contents)
          if (typeof imported.integrationId !== 'string' || !/^[\w-]+$/.test(imported.integrationId)) throw new Error('Missing integration ID')
          this.importedIntegrationId = imported.integrationId
          this.importedUrl = validateGrafanaWebhookUrl(imported.url)
        } else this.importedUrl = validateGrafanaWebhookUrl(contents)
      } catch {
        throw new Error('Cannot import webhook credentials; component imports require private JSON with integrationId and url; legacy imports require a complete Grafana URL (contents omitted)')
      }

      this.assertUniqueUrl(this.importedUrl, this.importedIntegrationId)
      return {action: 'import', secretFile: this.secretFile}
    }

    if (this.receipt?.status === 'ready') {
      this.assertUniqueUrl(this.receipt.url!, this.receipt.integrationId)
      return {action: 'reuse', secretFile: this.secretFile}
    }

    if (this.receipt?.status === 'creating' || requested || fs.existsSync(this.secretFile)) {
      throw new Error('Webhook creation may already have succeeded or its binding is missing. Restore the private binding or use --webhook-url-file to adopt the existing URL; no replacement will be created')
    }

    return {action: create ? 'create' : 'unmanaged', secretFile: this.secretFile}
  }

  /** Run before any remote writes. The folder is never an input to push-secrets' root-file scan. */
  prepare(): void {
    this.checkPaths()
    const tracked = spawnSync('git', ['-C', this.root, 'ls-files', '--', this.directory], {encoding: 'utf8', env: {...process.env, LC_ALL: 'C'}})
    const outsideRepository = tracked.status === 128 && tracked.stderr.includes('not a git repository')
    if (tracked.error || (tracked.status !== 0 && !outsideRepository)) throw new Error('Cannot verify that the webhook credential directory is untracked')
    if (tracked.stdout.trim()) throw new Error('The webhook credential directory contains Git-tracked files; remove them from the index before proceeding')
    fs.mkdirSync(this.directory, {mode: 0o700, recursive: true})
    fs.chmodSync(this.directory, 0o700)
    this.write(path.join(this.directory, '.gitignore'), '*\n')
  }

  private assertUniqueUrl(url: string, integrationId?: string): void {
    if (!fs.existsSync(this.directory)) return
    for (const name of fs.readdirSync(this.directory)) {
      const file = path.join(this.directory, name)
      if (file === this.receiptFile || !(name === 'binding.json' || name.endsWith('.binding.json'))) continue
      let other: Receipt
      try {
        if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Unsafe binding')
        other = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch { throw new Error('Cannot verify other private webhook bindings; restore them before importing or reusing a URL') }

      if (other.url === url || (integrationId && other.integrationId === integrationId)) throw new Error('This webhook is already bound to another component or the legacy bootstrap; use a distinct integration')
    }
  }

  private checkPaths(): void {
    for (const file of [path.join(this.root, 'secrets'), this.directory, this.receiptFile, this.secretFile, path.join(this.directory, '.gitignore')]) {
      try {
        if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Webhook credential paths must not be symbolic links')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  private save(receipt: Receipt): void {
    this.write(this.receiptFile, `${JSON.stringify(receipt, null, 2)}\n`)
    this.receipt = receipt
  }

  private write(file: string, contents: string): void {
    this.checkPaths()
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600)
      try {
        fs.writeFileSync(descriptor, contents)
        fs.fsyncSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
      }

      fs.renameSync(temporary, file)
      const directory = fs.openSync(this.directory, 'r')
      try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
    } catch {
      throw new Error('Cannot persist the private webhook files; restore storage access before retrying')
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
  }
}
