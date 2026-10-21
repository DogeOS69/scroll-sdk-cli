/* eslint-disable @typescript-eslint/no-explicit-any -- Local plan/values and Kubernetes API documents. */
import {Args, Command, Flags} from '@oclif/core'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {CAPACITY_MANAGER_PLAN, assertSdkWorkersRetired, capacitySpec, parseCapacityInput, prepareCapacityManager} from '../../utils/capacity-manager.js'
import {prepareCapacityNetwork} from '../../utils/capacity-manager-network.js'
import {capacityPreflight, capacityReconcileEvidence} from '../../utils/capacity-manager-preflight.js'
import {DEFAULT_DEPLOYMENT} from '../../utils/deployment-paths.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {localPath} from '../../utils/preparation-io.js'
import {capacityExec} from '../../utils/proof-workers-lifecycle.js'
import {specKubernetesTarget} from '../../utils/spec-kubernetes-target.js'

export default class CapacityManager extends Command {
  static args = {action: Args.string({default: 'prepare', options: ['network', 'prepare', 'preflight', 'credentials', 'status']})}
  static description = 'Prepare Core capacity-manager configuration and credentials; install separately with Helm to start renting workers'
  static flags = {
    apply: Flags.boolean({default: false, description: 'Network only: explicitly create/read back the private AWS stack (incurs ALB/DNS charges)'}),
    'deployment-dir': Flags.string({aliases: ['dir'], default: DEFAULT_DEPLOYMENT}),
    'dstack-url': Flags.string({description: 'Prepare only: verified controller HTTPS endpoint; does not provision TLS'}),
    json: Flags.boolean({default: false}),
    'kube-context': Flags.string({description: 'Explicit Kubernetes context; otherwise uses the saved spec target'}),
    live: Flags.boolean({default: false, description: 'Status only: summarize recent reconcile logs without printing raw logs'}),
    namespace: Flags.string({description: 'Must match the namespace saved during rendering'}),
    'sdk-dir': Flags.string({description: 'Prepare only: SDK checkout containing the frozen template revision, for missing values'}),
    spec: Flags.string({description: 'Prepare/network: read capacityManager from this spec; preserve frozen deployment intent and proof materials'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(CapacityManager)
    const out = new JsonOutputContext('setup capacity-manager', flags.json)
    try {
      const root = path.resolve(flags['deployment-dir'])
      if (flags.apply && args.action !== 'network') throw new Error('--apply is only valid for network')
      if (flags.live && args.action !== 'status') throw new Error('--live is only valid for status')
      if (args.action === 'network') {
        if (flags['dstack-url'] || flags['sdk-dir']) throw new Error('network uses the explicit connection spec')
        const spec = capacitySpec(root, flags.spec && path.resolve(flags.spec))
        if (!spec.capacityManager?.connection) throw new Error('Select capacityManager.connection in the spec')
        const target = specKubernetesTarget(spec)
        if (flags.namespace && flags.namespace !== target.namespace) throw new Error('Network namespace differs from saved spec')
        const controller = parseCapacityInput(fs.readFileSync(localPath(root, 'values/dstack-controller-production.yaml'), 'utf8'), 'controller values', yaml.load) as any
        if (spec.dstackController?.internalTls || controller.ingress?.enabled) throw new Error('Disable controller Ingress/internalTls before selecting the separate network owner')
        out.success(prepareCapacityNetwork(root, spec.capacityManager.connection, spec.metadata.name, target.namespace, controller.fullnameOverride ?? 'dstack-controller', flags.apply))
        return
      }

      if (args.action !== 'prepare' && (flags.spec || flags['sdk-dir'] || flags['dstack-url'])) throw new Error('--spec, --sdk-dir and --dstack-url are only valid for prepare')
      if (args.action === 'prepare') {
        if (flags['kube-context'] || flags.namespace) throw new Error('Prepare uses the frozen Kubernetes target; context/namespace flags are for activation and status')
        const result = prepareCapacityManager(root, undefined, {dstackUrl: flags['dstack-url'], sdkDirectory: flags['sdk-dir'], specFile: flags.spec && path.resolve(flags.spec)})
        out.info('No GPU allocation. Install WP with the generated network policy, then explicitly run make install-capacity-manager.')
        out.success(result)
        return
      }

      const planFile = localPath(root, CAPACITY_MANAGER_PLAN)
      if (!fs.existsSync(planFile)) throw new Error('Capacity Manager has no prepared plan. If this deployment selects bounded proofWorkers, use setup proof-workers plan/apply instead. For continuous capacity, explicitly enable capacityManager and run setup capacity-manager prepare; retire bounded workers before activation; do not copy another deployment\'s plan.')
      const plan = parseCapacityInput(fs.readFileSync(planFile, 'utf8'), 'capacity-manager plan JSON', JSON.parse)
      if (plan.schema !== 'scrollsdk/capacity-manager/v1') throw new Error('Unsupported capacity-manager plan')
      if (flags.namespace && flags.namespace !== plan.namespace) throw new Error('Namespace differs from prepared capacity-manager values; regenerate for the intended namespace')
      if (plan.dstack.namespace !== plan.namespace) throw new Error('Dstack and capacity-manager must use the same namespace; rerun setup render')
      const selectedContext = flags['kube-context'] || plan.kubeContext
      const context = selectedContext ? ['--context', selectedContext] : []
      const run = (namespace: string, args: string[], input?: string) => {
        try {return capacityExec([...context, '--namespace', namespace, ...args], input)} catch {
          throw new Error('Capacity-manager Kubernetes/dstack operation failed (private response omitted). Check the saved context, dstack rollout, synchronized proof Secrets, and configured project/fleets; retry make install-capacity-manager after fixing the cause.')
        }
      }

      if (args.action === 'status') {
        const result = run(plan.namespace, ['get', 'deployment', 'capacity-manager', '--ignore-not-found', '-o', 'json'])
        const deployment = result.trim() ? parseCapacityInput(result, 'Kubernetes status JSON', JSON.parse) : undefined
        const evidence = flags.live && deployment ? capacityReconcileEvidence(run(plan.namespace, ['logs', 'deployment/capacity-manager', '--all-containers=false', '--since=60s', '--tail=200'])) : {controlLoop: 'not-checked', gpuAllocation: 'not-verified', proofAcceptance: 'not-verified'}
        out.success({...evidence, present: Boolean(deployment), readyReplicas: deployment?.status?.readyReplicas ?? 0, replicas: deployment?.spec?.replicas ?? 0})
        return
      }

      if (args.action === 'credentials') assertSdkWorkersRetired(root)
      const valuesContent = fs.readFileSync(localPath(root, plan.valuesFile), 'utf8')
      const values = parseCapacityInput(valuesContent, 'capacity-manager values YAML', yaml.load) as any
      if (!plan.provider) throw new Error('Regenerate the legacy capacity-manager plan with prepare before activation/preflight')
      if (!selectedContext) throw new Error('Select --kube-context or save infrastructure.kubeContext before activation/preflight')
      if (!plan.workerCredentialMaster) throw new Error('This capacity-manager plan predates per-worker credentials; drain the old manager, archive its plan and rerun setup render')
      if (values.manager.dstack.project !== plan.project || values.workerCredentialMaster?.existingSecret !== plan.workerCredentialMaster.existingSecret || values.workerCredentialMaster?.key !== plan.workerCredentialMaster.key) throw new Error('Regenerate the capacity-manager plan after changing its credential bindings')
      if (!plan.fleets?.files?.length || !['create', 'reuse'].includes(plan.fleets.action)) throw new Error('Fleet preparation is missing; rerun setup render before installing capacity-manager')
      const fleets = plan.fleets.files.map((file: {path: string}) => {
        const content = fs.readFileSync(localPath(root, file.path), 'utf8')
        return parseCapacityInput(content, 'prepared fleet YAML', yaml.load) as any
      })
      const selectedFleets = new Set([...values.manager.dstack.fleets, ...(values.manager.dstack.fallbackFleet ? [values.manager.dstack.fallbackFleet] : [])])
      if (fleets.length !== selectedFleets.size || fleets.some((fleet: any) => !selectedFleets.delete(fleet.name))) throw new Error('Fleet bindings changed; rerun setup render')
      run(plan.namespace, ['rollout', 'status', `deployment/${plan.dstack.deployment}`, '--timeout=120s'])
      if (values.dstackAuth?.existingSecret !== plan.dstack.auth.existingSecret || values.dstackAuth?.key !== plan.dstack.auth.key) throw new Error('Dstack credential bindings changed; rerun setup render')
      // The manager mounts the coordinator's master and mints per-run
      // credentials itself (core #1598); nothing secret is copied to dstack.
      // TODO(per-worker credentials): delete a legacy cm_worker_* project secret.
      const checks = capacityPreflight(plan, values, (args, input) => run(plan.namespace, args, input))
      if (args.action === 'preflight') {out.success(checks); return}
      const adapter = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config/capacity-manager-credentials.py'), 'utf8')
      run(plan.dstack.namespace, ['exec', '-i', `deployment/${plan.dstack.deployment}`, '-c', 'controller', '--', '/root/.local/share/uv/tools/dstack/bin/python', '-c', adapter], JSON.stringify({fleetAction: plan.fleets.action, fleets, project: plan.project}))
      out.info('Prepared empty fleets. No workers started; explicitly install the capacity-manager release after reviewing the generated policy.')
      out.success({namespace: plan.namespace, project: plan.project, updated: true})
    } catch (error) {out.error('E761_CAPACITY_MANAGER_FAILED', error instanceof Error ? error.message : 'Capacity manager preparation failed', 'CONFIGURATION', true)}
  }
}
