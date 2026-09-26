import {spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {InstatusClient, validateGrafanaWebhookUrl} from './status-page-instatus.js'

interface Receipt {
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
  private importedUrl?: string
  private receipt?: Receipt
  private readonly receiptFile: string

  constructor(private readonly root: string, private readonly environment: string) {
    if (!/^(devnet|mainnet|testnet)$/.test(environment)) throw new Error('Invalid webhook environment')
    this.directory = path.join(root, 'secrets', 'status-page')
    this.receiptFile = path.join(this.directory, 'binding.json')
    this.secretFile = path.join(this.directory, 'grafana.secret.yaml')
    this.checkPaths()
    if (!fs.existsSync(this.receiptFile)) return
    try {
      const receipt = JSON.parse(fs.readFileSync(this.receiptFile, 'utf8')) as Receipt
      if (receipt.version !== 1 || !['devnet', 'mainnet', 'testnet'].includes(receipt.environment) || typeof receipt.pageId !== 'string' || !/^[\w-]+$/.test(receipt.pageId)
        || !['creating', 'ready'].includes(receipt.status)) throw new Error('Invalid receipt')
      if (receipt.status === 'ready') validateGrafanaWebhookUrl(receipt.url)
      this.receipt = receipt
    } catch {
      throw new Error('Cannot read the private webhook binding; restore secrets/status-page/ from backup, never recreate blindly')
    }

    if (this.receipt.environment !== environment) throw new Error('The saved webhook belongs to a different network; use that network\'s deployment directory')
  }

  async apply(plan: WebhookPlan, client: InstatusClient, pageId: string, secret: {key: string; name: string}): Promise<void> {
    if (plan.action === 'unmanaged') return
    if (plan.action === 'create') {
      // Durable intent precedes POST. A timeout, invalid response or crash cannot cause an automatic second POST.
      this.save({environment: this.environment, pageId, status: 'creating', version: 1})
      const created = await client.createGrafanaWebhook(pageId)
      this.save({environment: this.environment, ...created, pageId, status: 'ready', version: 1})
    } else if (plan.action === 'import') {
      this.save({environment: this.environment, pageId, status: 'ready', url: this.importedUrl, version: 1})
    }

    if (this.receipt?.status !== 'ready' || this.receipt.pageId !== pageId) throw new Error('No matching webhook credential is available')
    const url = validateGrafanaWebhookUrl(this.receipt.url)
    // JSON is valid YAML. No namespace: deployment must explicitly select Grafana's namespace.
    const manifest = {apiVersion: 'v1', data: {[secret.key]: Buffer.from(url).toString('base64')}, kind: 'Secret', metadata: {name: secret.name}, type: 'Opaque'}
    this.write(this.secretFile, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  plan(pageId: string, create: boolean, requested: boolean, importFile?: string): WebhookPlan {
    if (this.receipt && this.receipt.pageId !== pageId) throw new Error('The saved webhook belongs to a different Instatus page')
    if (importFile) {
      try {
        this.importedUrl = validateGrafanaWebhookUrl(fs.readFileSync(path.resolve(this.root, importFile), 'utf8').trim())
      } catch {
        throw new Error('Cannot import the webhook URL file; provide the selected page\'s complete Instatus Grafana URL (contents omitted)')
      }

      return {action: 'import', secretFile: this.secretFile}
    }

    if (this.receipt?.status === 'ready') return {action: 'reuse', secretFile: this.secretFile}
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
