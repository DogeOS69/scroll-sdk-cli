import {spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {InstatusClient} from './status-page-instatus.js'

export interface HeartbeatPlan {action: 'create' | 'reuse'; name: string; secretFile: string; state: 'ACTIVE' | 'PAUSED'}

/** The cron slug is a credential: never include remote responses in plan output. */
export class StatusPageHeartbeat {
  readonly secretFile: string
  private readonly directory: string
  private receipt?: {chainId: string; environment: string; id?: string; pageId: string; status: 'creating' | 'ready'; url?: string}
  private readonly receiptFile: string

  constructor(private readonly root: string, private readonly environment: string, private readonly chainId: string) {
    this.directory = path.join(root, 'secrets/status-page')
    this.receiptFile = path.join(this.directory, 'heartbeat.json')
    this.secretFile = path.join(this.directory, 'heartbeat.secret.yaml')
    this.checkPaths()
    if (fs.existsSync(this.receiptFile)) {
      try { this.receipt = JSON.parse(fs.readFileSync(this.receiptFile, 'utf8')) } catch { throw new Error('Cannot read private heartbeat receipt') }
      const receipt = this.receipt!
      if (receipt.environment !== environment || receipt.chainId !== chainId || !/^[\w-]+$/.test(receipt.pageId) || !['creating', 'ready'].includes(receipt.status)) throw new Error('Heartbeat receipt belongs to a different deployment or is invalid')
      if (receipt.status === 'ready' && (!/^[\w-]+$/.test(receipt.id ?? '') || !/^https:\/\/cron\.instatus\.com\/[\w-]+$/.test(receipt.url ?? ''))) throw new Error('Invalid private heartbeat receipt')
    }
  }

  async apply(plan: HeartbeatPlan, client: InstatusClient, pageId: string, alertIds: string[], enabled = true): Promise<void> {
    if (plan.action === 'create' && !enabled) throw new Error('Cannot pause a missing heartbeat monitor; restore its receipt')
    if (plan.action === 'create') {
      this.receipt = {chainId: this.chainId, environment: this.environment, pageId, status: 'creating'}
      this.write(this.receiptFile, JSON.stringify(this.receipt))
      const created = await client.createCronMonitor(pageId, plan.name, alertIds)
      this.receipt = {...this.receipt, ...created, status: 'ready'}
      this.write(this.receiptFile, JSON.stringify(this.receipt))
    }

    if (this.receipt?.status !== 'ready') throw new Error('Missing heartbeat receipt')
    await client.configureCronMonitor(this.receipt.id!, alertIds, enabled)
    this.write(this.secretFile, JSON.stringify({apiVersion: 'v1', data: {url: Buffer.from(this.receipt.url!).toString('base64')}, kind: 'Secret', metadata: {name: 'instatus-monitoring-heartbeat'}, type: 'Opaque'}, null, 2) + '\n')
  }

  async plan(client: InstatusClient, pageId: string, groupName: string, requested: boolean, enabled = true): Promise<HeartbeatPlan> {
    const state = enabled ? 'ACTIVE' : 'PAUSED'
    const name = `DogeOS ${groupName} ${this.chainId} monitoring heartbeat`
    if (this.receipt && this.receipt.pageId !== pageId) throw new Error('Heartbeat targets a different page')
    if (this.receipt?.status === 'ready') {
      await client.verifyCronMonitor(this.receipt.id!, pageId, name)
      return {action: 'reuse', name, secretFile: this.secretFile, state}
    }

    if (this.receipt || requested || fs.existsSync(this.secretFile)) throw new Error('Heartbeat creation may already have succeeded; restore heartbeat.json from private backup before retrying')
    if (pageId && await client.hasCronMonitor(pageId, name)) throw new Error('A matching heartbeat already exists; restore its private receipt instead of creating a duplicate')
    return {action: 'create', name, secretFile: this.secretFile, state}
  }

  prepare(): void {
    this.checkPaths()
    const result = spawnSync('git', ['-C', this.root, 'ls-files', '--', this.directory], {encoding: 'utf8', env: {...process.env, LC_ALL: 'C'}})
    if (result.error || (result.status !== 0 && !(result.status === 128 && result.stderr.includes('not a git repository'))) || result.stdout.trim()) throw new Error('Heartbeat credentials must be in an untracked private directory')
    fs.mkdirSync(this.directory, {mode: 0o700, recursive: true})
    fs.chmodSync(this.directory, 0o700)
    this.write(path.join(this.directory, '.gitignore'), '*\n')
  }

  private checkPaths(): void {
    for (const file of [path.join(this.root, 'secrets'), this.directory, this.receiptFile, this.secretFile, path.join(this.directory, '.gitignore')]) {
      try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Heartbeat credential paths must not be symbolic links') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }

  private write(file: string, contents: string): void {
    this.checkPaths()
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600)
      try { fs.writeFileSync(descriptor, contents); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
      fs.renameSync(temporary, file)
      const directory = fs.openSync(this.directory, 'r')
      try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
  }
}
