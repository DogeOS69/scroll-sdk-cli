/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values are dynamic YAML mappings. */
import * as toml from '@iarna/toml'
import {Command, Flags} from '@oclif/core'
import * as yaml from 'js-yaml'
import {randomUUID} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {YAML_DUMP_OPTIONS} from '../../config/constants.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {InstatusClient} from '../../utils/status-page-instatus.js'
import {StatusPageState, lockStatusPageApply} from '../../utils/status-page-state.js'
import {reconcileScrollMonitorStatusPage} from '../../utils/status-page-values.js'
import {StatusPageWebhook} from '../../utils/status-page-webhook.js'

export default class StatusPage extends Command {
  static description = 'Generate status-page values locally; --plan reads Instatus, --apply creates or reconciles the explicitly selected page'

  static flags = {
    apply: Flags.boolean({default: false, description: 'Apply component metadata and page name to Instatus using INSTATUS_API_KEY', exclusive: ['plan']}),
    config: Flags.string({default: 'config.toml', description: 'Chain config, relative to deployment directory'}),
    'create-webhook': Flags.boolean({default: false, description: 'With --plan/--apply, initialize a Grafana integration if no private binding exists; subsequent applies reuse it', exclusive: ['webhook-url-file']}),
    'deployment-dir': Flags.string({default: '.', description: 'Deployment root'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    plan: Flags.boolean({default: false, description: 'Read-only remote comparison; do not write local files or Instatus', exclusive: ['apply']}),
    values: Flags.string({default: 'values/scroll-monitor-production.yaml', description: 'Monitor values; source filenames resolve beside this file'}),
    'webhook-url-file': Flags.string({description: 'With --plan/--apply, adopt or rotate to the selected page\'s existing Grafana URL from a private text file', exclusive: ['create-webhook']}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(StatusPage)
    const output = new JsonOutputContext('setup status-page', flags.json)
    let releaseLock: (() => void) | undefined
    try {
      if ((flags['create-webhook'] || flags['webhook-url-file']) && !flags.apply && !flags.plan) throw new Error('Webhook initialization/import requires --plan or --apply')
      const root = path.resolve(flags['deployment-dir'])
      if (flags.apply) releaseLock = lockStatusPageApply(root)
      const valuesPath = path.resolve(root, flags.values)
      let values: any
      let config: any
      try {
        values = yaml.load(fs.readFileSync(valuesPath, 'utf8'))
        config = toml.parse(fs.readFileSync(path.resolve(root, flags.config), 'utf8'))
      } catch {
        throw new Error('Cannot read monitor YAML or chain TOML; check --values and --config (parser contents are omitted to protect credentials)')
      }

      if (!values || values.statusPage?.enabled !== true) throw new Error('Enable statusPage in the selected monitor values before generating')
      const changes = reconcileScrollMonitorStatusPage(values, {
        chainId: config.general?.CHAIN_ID_L2,
        environment: values.statusPage.environment,
        networkName: config.general?.CHAIN_NAME_L2,
        valuesDir: path.dirname(valuesPath),
      })
      const persist = () => {
        // Atomic replacement in the same directory; retain restrictive permissions.
        const temporary = `${valuesPath}.${randomUUID()}.tmp`
        try {
          fs.writeFileSync(temporary, yaml.dump(values, YAML_DUMP_OPTIONS), {flag: 'wx', mode: fs.statSync(valuesPath).mode % 0o1000})
          fs.renameSync(temporary, valuesPath)
        } finally {
          if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
        }
      }

      const options = values.statusPage
      const state = new StatusPageState(root, options.catalog.environment)
      const restored = state.restore(options.instatus)
      const boundPage = options.generated.appliedPageId
      if (boundPage && boundPage !== options.instatus.pageId) throw new Error('This monitor configuration was applied to a different Instatus page; use a separate configuration for a new target')
      if (!flags.apply && !flags.plan) {
        if (changes.length > 0 || restored) persist()
        output.logSuccess(`Generated ${options.catalog.components.length} components and native Grafana configuration in ${valuesPath}`)
        output.success({catalog: options.catalog, changed: changes.length > 0 || restored, mode: 'generate', valuesPath})
        return
      }

      const client = new InstatusClient(process.env.INSTATUS_API_KEY ?? '')
      const plan = await client.plan(options.catalog, options.instatus)
      const webhook = new StatusPageWebhook(root, options.catalog.environment)
      const webhookPlan = webhook.plan(plan.page.id, flags['create-webhook'], options.generated.webhookRequested === true, flags['webhook-url-file'])
      if (flags.apply) {
        if (webhookPlan.action !== 'unmanaged') webhook.prepare()
        // Ensure generated values can be saved before starting any remote writes.
        persist()
        state.reserve(plan)
        await client.apply(plan, (key, id) => {
          options.instatus.componentIds[key] = id
          persist()
        }, id => {
          state.bind(id)
          options.instatus.pageId = id
          options.generated.appliedPageId = id
          persist()
        })
        if (webhookPlan.action !== 'unmanaged') {
          // Nonsecret guard survives regeneration and blocks recreation if the private receipt is lost.
          options.generated.webhookRequested = true
          persist()
          await webhook.apply(webhookPlan, client, options.instatus.pageId, options.grafana.webhookSecretRef)
          output.logSuccess(`Webhook ${webhookPlan.action}: private Kubernetes Secret file saved to ${webhookPlan.secretFile}`)
        }

        output.logSuccess(`Applied status-page metadata to Instatus page ${options.instatus.pageId}`)
      } else {
        output.info(JSON.stringify({...plan, webhook: webhookPlan}, null, 2))
      }

      output.success({mode: flags.apply ? 'apply' : 'plan', pageId: options.instatus.pageId, plan, valuesPath, webhook: webhookPlan})
    } catch (error) {
      output.error('E_STATUS_PAGE', error instanceof Error ? error.message : 'Status-page operation failed', 'CONFIGURATION', true)
    } finally {
      releaseLock?.()
    }
  }
}
