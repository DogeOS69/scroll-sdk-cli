import {Command, Flags} from '@oclif/core'

import {DEFAULT_DEPLOYMENT} from '../../utils/deployment-paths.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {applyPreparation} from '../../utils/preparation-plan.js'
import {CommandPreparationRunner} from '../../utils/preparation-runner.js'

export default class SetupApply extends Command {
  static description = 'Apply or resume a saved preparation plan; waits for external inputs and never automatically repeats ambiguous broadcasts'
  static flags = {
    dir: Flags.string({aliases: ['deployment-dir'], default: DEFAULT_DEPLOYMENT, description: 'Deployment directory created by setup plan, relative to the working directory'}),
    'dogecoin-routing-spec': Flags.string({dependsOn: ['refresh-runtime'], description: 'With refresh-runtime, import only dogecoin.kubernetes from this spec and cluster RPC credentials from the environment'}),
    json: Flags.boolean({default: false}),
    'refresh-runtime': Flags.boolean({default: false, description: 'Archive runtime evidence and regenerate from charts; preserve identities, genesis, funding and baked proof materials'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(SetupApply)
    const output = new JsonOutputContext('setup apply', flags.json)
    try {
      const state = await applyPreparation(flags.dir, new CommandPreparationRunner(), step => output.info(`${step.id}: ${step.title}`), {dogecoinRoutingSpec: flags['dogecoin-routing-spec'], refreshRuntime: flags['refresh-runtime']})
      const report = {completed: Object.keys(state.steps).filter(id => state.steps[id] === 'completed'), currentStep: state.currentStep, status: state.status, waiting: state.waiting}
      if (!flags.json) output.info(JSON.stringify(report, null, 2))
      output.success(report)
      // Waiting is a resumable outcome, not successful preparation.
      process.exitCode = state.status === 'prepared' ? 0 : state.status === 'waiting' ? 2 : 1
    } catch (error) {output.error('E751_PREPARATION_APPLY_FAILED', error instanceof Error ? error.message : 'Unable to apply plan', 'CONFIGURATION', true)}
  }
}
