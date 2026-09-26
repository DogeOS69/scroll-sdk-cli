/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values are dynamic YAML mappings. */
import * as toml from '@iarna/toml'
import {Command, Flags} from '@oclif/core'
import * as yaml from 'js-yaml'
import {randomUUID} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {YAML_DUMP_OPTIONS} from '../../config/constants.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {StatusPageHeartbeat} from '../../utils/status-page-heartbeat.js'
import {InstatusClient} from '../../utils/status-page-instatus.js'
import {ComponentKey, componentIdentity} from '../../utils/status-page-publication.js'
import {StatusPageState, lockStatusPageApply} from '../../utils/status-page-state.js'
import {reconcileScrollMonitorStatusPage} from '../../utils/status-page-values.js'
import {StatusPageWebhook} from '../../utils/status-page-webhook.js'

export default class StatusPage extends Command {
  static description = 'Generate status-page values locally; --plan reads Instatus, --apply creates or reconciles the explicitly selected page'

  static flags = {
    apply: Flags.boolean({default: false, description: "Apply this network group's component metadata and shared page branding to Instatus using INSTATUS_API_KEY", exclusive: ['plan']}),
    config: Flags.string({default: 'config.toml', description: 'Chain config, relative to deployment directory'}),
    'create-webhook': Flags.boolean({default: false, description: 'With --plan/--apply, initialize a Grafana integration if no private binding exists; subsequent applies reuse it', exclusive: ['webhook-url-file']}),
    'deployment-dir': Flags.string({default: '.', description: 'Deployment root'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    plan: Flags.boolean({default: false, description: 'Read-only remote comparison; do not write local files or Instatus', exclusive: ['apply']}),
    'probe-values': Flags.string({description: 'Write values for the independent status-page-probe chart; --plan never writes'}),
    values: Flags.string({default: 'values/scroll-monitor-production.yaml', description: 'Monitor values; source filenames resolve beside this file'}),
    'webhook-component': Flags.string({dependsOn: ['webhook-url-file'], description: 'Component key for --webhook-url-file when using component publication'}),
    'webhook-url-file': Flags.string({description: 'With --plan/--apply, import private component JSON {integrationId,url}, or a legacy Grafana URL text file', exclusive: ['create-webhook']}),
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
      const inputs = {
        chainId: config.general?.CHAIN_ID_L2,
        environment: values.statusPage.environment,
        networkName: config.general?.CHAIN_NAME_L2,
        valuesDir: path.dirname(valuesPath),
      }
      const changes = reconcileScrollMonitorStatusPage(values, inputs)
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

      let options = values.statusPage
      const state = new StatusPageState(root, options.catalog.environment)
      const restored = state.restore(options.instatus)
      if (restored) {
        reconcileScrollMonitorStatusPage(values, inputs)
        options = values.statusPage
      }

      const persistProbes = () => {
        if (!flags['probe-values']) return
        if (!options.generated.probeConfig) throw new Error('--probe-values requires component publication')
        const file = path.resolve(root, flags['probe-values'])
        if (file === valuesPath || (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())) throw new Error('Probe values must use a separate regular output file')
        let existing: any = {}
        if (fs.existsSync(file)) existing = yaml.load(fs.readFileSync(file, 'utf8'))
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('Probe values must be a mapping')
        const temporary = `${file}.${randomUUID()}.tmp`
        try {
          fs.writeFileSync(temporary, yaml.dump({enabled: true, image: '', location: '', ...existing, config: options.generated.probeConfig}, YAML_DUMP_OPTIONS), {flag: 'wx', mode: 0o644})
          fs.renameSync(temporary, file)
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
      }

      const reportReadiness = () => {
        for (const [key, state] of Object.entries(options.generated.componentPublication?.readiness ?? {}) as Array<[string, any]>) {
          output.info(`${key.padEnd(18)} ${state.mode.padEnd(10)} ${state.reason}`)
        }
      }

      const boundPage = options.generated.appliedPageId
      if (boundPage && boundPage !== options.instatus.pageId) throw new Error('This monitor configuration was applied to a different Instatus page; use a separate configuration for a new target')
      if (!flags.apply && !flags.plan) {
        if (changes.length > 0 || restored) persist()
        persistProbes()
        reportReadiness()
        output.logSuccess(`Generated ${options.catalog.components.length} components and native Grafana configuration in ${valuesPath}`)
        output.success({catalog: options.catalog, changed: changes.length > 0 || restored, mode: 'generate', publication: options.generated.componentPublication?.readiness, valuesPath})
        return
      }

      const client = new InstatusClient(process.env.INSTATUS_API_KEY ?? '')
      const plan = await client.plan(options.catalog, options.instatus)
      if (plan.group?.action === 'reuse') options.instatus.groupId = plan.group.id
      const componentPublication = options.generated.version === 2
      const selected: Array<string | undefined> = componentPublication
        ? Object.entries(options.publication.components).filter(([, value]: [string, any]) => value.mode === 'automatic').map(([key]) => key)
        : [undefined]
      if (componentPublication && flags['webhook-url-file'] && !selected.includes(flags['webhook-component'])) throw new Error('--webhook-url-file requires --webhook-component selecting an automatic component')
      if (!componentPublication && flags['webhook-component']) throw new Error('--webhook-component requires statusPage.publication')
      const webhooks = selected.map(key => {
        const webhook = new StatusPageWebhook(root, options.catalog.environment, key)
        const id = key ? plan.components.find(component => component.key === key)?.id : undefined
        const imported = !key || key === flags['webhook-component'] ? flags['webhook-url-file'] : undefined
        const requested = key ? options.generated.componentWebhookRequested?.[key] === true : options.generated.webhookRequested === true
        const webhookPlan = webhook.plan(plan.page.id, flags['create-webhook'], requested, imported, id)
        if (key && webhookPlan.action === 'unmanaged') throw new Error(`${key}: initialize its integration with --create-webhook or import it with --webhook-component and --webhook-url-file`)
        return {key, plan: webhookPlan, webhook}
      })
      const heartbeat = (options.publication?.heartbeat?.enabled || options.generated.heartbeatBoundPageId) ? new StatusPageHeartbeat(root, options.environment, options.catalog.chainId) : undefined
      const heartbeatPlan = await heartbeat?.plan(client, plan.page.id, options.catalog.groupName, options.generated.heartbeatRequested === true, options.publication.heartbeat.enabled)
      const webhookPlans = webhooks.map(({key, plan: webhookPlan}) => ({component: key ?? 'legacy-bootstrap', ...webhookPlan}))
      if (flags.apply) {
        for (const item of webhooks) if (item.plan.action !== 'unmanaged') item.webhook.prepare()
        heartbeat?.prepare()
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
        if (plan.group?.action === 'bootstrap') throw new Error(`Page created; initialize the ${plan.group.name} group with a Public RPC component in Instatus, then rerun --plan before creating a webhook`)
        for (const item of webhooks) {
          if (item.plan.action === 'unmanaged') continue
          const {key} = item
          // Persist intent before POST; missing private state must never create a duplicate.
          if (key) {
            options.generated.componentWebhookRequested ??= {}
            options.generated.componentWebhookRequested[key] = true
          } else options.generated.webhookRequested = true
          persist()
          const id = key ? options.instatus.componentIds[key] : undefined
          const secret = key ? componentIdentity(key as ComponentKey).secret : options.grafana.webhookSecretRef
          const policy = options.publication?.incidents
          const name = key ? `${options.catalog.groupName} / ${options.catalog.components.find((component: any) => component.key === key).name}` : ''
          const templates = key && policy?.manageTemplates ? {
            createTemplate: {components: [{id, status: policy.affectedStatus}], message: 'We are investigating a service disruption.', name: `${name}: service disruption`, notify: policy.notifySubscribers, status: 'INVESTIGATING'},
            resolveTemplate: {components: [{id, status: 'OPERATIONAL'}], message: 'Service has recovered after a period of continuous health verification.', name: `${name}: recovered`, notify: policy.notifySubscribers, status: 'RESOLVED'},
          } : undefined
          await item.webhook.apply(item.plan, client, options.instatus.pageId, secret, id, templates)
          if (key) {
            options.generated.componentBindings ??= {}
            options.generated.componentBindings[key] = {componentId: id, pageId: options.instatus.pageId}
            persist()
          }

          output.logSuccess(`Webhook ${item.plan.action}: private Kubernetes Secret file saved to ${item.plan.secretFile}`)
        }

        if (heartbeat && heartbeatPlan) {
          options.generated.heartbeatRequested = true
          persist()
          await heartbeat.apply(heartbeatPlan, client, options.instatus.pageId, options.publication.heartbeat.alertIds, options.publication.heartbeat.enabled)
          options.generated.heartbeatBoundPageId = options.instatus.pageId
        }

        reconcileScrollMonitorStatusPage(values, inputs)
        options = values.statusPage
        persist()
        persistProbes()

        reportReadiness()
        output.logSuccess(`Applied status-page metadata to Instatus page ${options.instatus.pageId}`)
      } else {
        output.info(JSON.stringify({...plan, heartbeat: heartbeatPlan, incidentPolicy: options.publication?.incidents, publication: options.generated.componentPublication?.readiness, webhooks: webhookPlans}, null, 2))
      }

      output.success({heartbeat: heartbeatPlan, incidentPolicy: options.publication?.incidents, mode: flags.apply ? 'apply' : 'plan', pageId: options.instatus.pageId, plan, publication: options.generated.componentPublication?.readiness, valuesPath, webhook: webhooks[0]?.plan, webhooks: webhookPlans})
    } catch (error) {
      output.error('E_STATUS_PAGE', error instanceof Error ? error.message : 'Status-page operation failed', 'CONFIGURATION', true)
    } finally {
      releaseLock?.()
    }
  }
}
