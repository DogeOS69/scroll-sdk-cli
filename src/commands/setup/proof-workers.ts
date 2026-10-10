import {Args, Command, Flags} from '@oclif/core'
import path from 'node:path'

import {JsonOutputContext} from '../../utils/json-output.js'
import {operateWorkerCapacity, retireCapacitySession} from '../../utils/proof-workers-lifecycle.js'
import {createWorkerCapacityPlan} from '../../utils/proof-workers-plan.js'

export default class ProofWorkers extends Command {
  static args = {action: Args.string({default: 'status', options: ['plan', 'apply', 'status', 'destroy']})}
  static description = 'Plan, submit, inspect or destroy bounded AWS or Vast.ai GPU workers through the deployed dstack controller'
  static flags = {
    'deployment-dir': Flags.string({default: '.', description: 'Generated deployment/runtime directory'}),
    json: Flags.boolean({default: false}),
    'kube-context': Flags.string({description: 'For plan only: override the saved Secret-upload context or current kubectl context'}),
    'new-session': Flags.string({description: 'For plan only: a new session name after the old session is confirmed destroyed'}),
    spec: Flags.string({description: 'For plan only: read updated proofWorkers intent; retain saved deployment/cluster bindings'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(ProofWorkers)
    const out = new JsonOutputContext('setup proof-workers', flags.json)
    try {
      const root = path.resolve(flags['deployment-dir'])
      if (args.action !== 'plan' && (flags.spec || flags['new-session'] || flags['kube-context'])) throw new Error('Spec/session options are only accepted by plan; apply uses the saved plan')
      if (args.action === 'plan') {
        if (flags['new-session']) retireCapacitySession(root, flags['new-session'])
        const plan = createWorkerCapacityPlan(root, flags['new-session'] ?? 'initial', flags.spec, flags['kube-context'])
        out.info(`Target: Kubernetes context ${plan.target.context}, namespace ${plan.target.namespace}, dstack project ${plan.project}`)
        out.info(`${plan.config.count} x ${plan.config.gpu}; ${plan.config.maxDurationHours}h running; USD ${plan.config.maxPricePerHourUsd}/instance-hour ceiling; USD ${plan.rentalEnvelopeUsd} rental envelope including startup, drain, idle and polling.`)
        out.info('No resources allocated. Envelope excludes storage, traffic and tax; provider/API outages can delay deletion. After coordinator and controller are ready, run scrollsdk setup proof-worker, then scrollsdk setup proof-workers apply.')
        out.success({config: plan.config, planId: plan.id, rentalEnvelopeUsd: plan.rentalEnvelopeUsd, session: plan.session, target: plan.target, workers: plan.workers.map(w => w.name)})
      } else {
        const result = operateWorkerCapacity(root, args.action as 'apply' | 'destroy' | 'status')
        if (!flags.json) this.log(JSON.stringify(result, null, 2))
        out.success(result)
      }
    } catch (error) {out.error('E760_PROOF_WORKERS_FAILED', error instanceof Error ? error.message : 'Worker operation failed', 'CONFIGURATION', true)}
  }
}
