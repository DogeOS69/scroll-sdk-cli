import {Command, Flags} from '@oclif/core'

import {JsonOutputContext} from '../../utils/json-output.js'
import {createPreparationPlan} from '../../utils/preparation-plan.js'

export default class SetupPlan extends Command {
  static description = 'Plan a fresh spec deployment preparation; write a private immutable plan without cloud or chain mutations'
  static flags = {
    'env-file': Flags.string({description: 'Private NAME=value file; referenced again by apply, never executed as shell'}),
    json: Flags.boolean({default: false}),
    output: Flags.string({description: 'New private deployment directory', required: true}),
    'sdk-dir': Flags.string({description: 'SDK checkout; plan locks committed HEAD unless templates.sdkRevision overrides it', required: true}),
    spec: Flags.string({description: 'DeploymentSpec YAML; environment references must resolve in this process', required: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(SetupPlan)
    const output = new JsonOutputContext('setup plan', flags.json)
    try {
      const plan = await createPreparationPlan({envFile: flags['env-file'], output: flags.output, sdkDirectory: flags['sdk-dir'], spec: flags.spec})
      if (!flags.json) {
        output.info(`Preparation plan: ${plan.deploymentName}`)
        for (const step of plan.steps) output.info(`  [${step.effect}] ${step.id}: ${step.title}`)
        output.info(`Plan saved. Continue with: scrollsdk setup apply --dir ${flags.output}`)
      }

      output.success(plan)
    } catch (error) {output.error('E750_PREPARATION_PLAN_FAILED', error instanceof Error ? error.message : 'Unable to create plan', 'CONFIGURATION', true)}
  }
}
