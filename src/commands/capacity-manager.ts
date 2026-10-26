import {Args, Command, Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import {CAPACITY_MANAGER_PLAN, parseCapacityInput} from '../utils/capacity-manager.js'
import {inspectCapacityManager} from '../utils/capacity-manager-diagnostics.js'
import {JsonOutputContext} from '../utils/json-output.js'

export default class CapacityManager extends Command {
  static args = {action: Args.string({default: 'status', description: 'status reads runtime evidence; probe creates and removes a temporary dependency-check Pod', options: ['status', 'probe']})}
  static description = 'Inspect the installed Capacity Manager or probe its dependencies; GPU worker lifecycle is owned by the Core controller'
  static examples = [
    '<%= config.bin %> capacity-manager status --kube-context my-cluster',
    '<%= config.bin %> capacity-manager probe --deployment-dir deployment --kube-context my-cluster',
  ]

  static flags = {
    'deployment-dir': Flags.string({default: '.', description: 'Prepared deployment directory'}),
    json: Flags.boolean({default: false}),
    'kube-context': Flags.string({description: 'Explicit Kubernetes context; must match the prepared target when recorded', required: true}),
    namespace: Flags.string({description: 'Namespace; defaults to the prepared target and must match it'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(CapacityManager)
    const output = new JsonOutputContext('capacity-manager', flags.json)
    try {
      const root = path.resolve(flags['deployment-dir'])
      const file = path.join(root, CAPACITY_MANAGER_PLAN)
      if (!fs.existsSync(file)) throw new Error('Capacity Manager is not prepared; select capacityManager in the deployment spec and run setup render')
      const plan = parseCapacityInput(fs.readFileSync(file, 'utf8'), 'capacity-manager plan JSON', JSON.parse)
      const namespace = flags.namespace ?? plan.namespace
      const result = inspectCapacityManager(root, {kubeContext: flags['kube-context'], namespace, probe: args.action === 'probe', status: args.action === 'status'})
      output.success(result)
    } catch (error) {output.error('E818_CAPACITY_MANAGER_DIAGNOSTICS', error instanceof Error ? error.message : 'Capacity Manager diagnostics failed', 'CONFIGURATION', true)}
  }
}
