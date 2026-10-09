import {Command, Flags} from '@oclif/core'

import {JsonOutputContext} from '../../utils/json-output.js'
import {applyPreparation} from '../../utils/preparation-plan.js'
import {CommandPreparationRunner} from '../../utils/preparation-runner.js'

export default class SetupApply extends Command {
  static description = 'Apply or resume a saved preparation plan; waits for external inputs and never automatically repeats ambiguous broadcasts'
  static flags = {
    dir: Flags.string({description: 'Deployment directory created by setup plan', required: true}),
    json: Flags.boolean({default: false}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(SetupApply)
    const output = new JsonOutputContext('setup apply', flags.json)
    try {
      const state = await applyPreparation(flags.dir, new CommandPreparationRunner(), step => output.info(`${step.id}: ${step.title}`))
      const report = {completed: Object.keys(state.steps).filter(id => state.steps[id] === 'completed'), currentStep: state.currentStep, status: state.status, waiting: state.waiting}
      if (!flags.json) output.info(JSON.stringify(report, null, 2))
      output.success(report)
      // Waiting is a resumable outcome, not successful preparation.
      process.exitCode = state.status === 'prepared' ? 0 : state.status === 'waiting' ? 2 : 1
    } catch (error) {output.error('E751_PREPARATION_APPLY_FAILED', error instanceof Error ? error.message : 'Unable to apply plan', 'CONFIGURATION', true)}
  }
}
