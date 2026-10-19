import {Command} from '@oclif/core'

import {preparationStageFlags, runPreparationStage} from '../../utils/preparation-stage-command.js'

export default class PolicyPrepare extends Command {
  static description = 'Resume the saved policy-prepare stage; runs only its declared effects'
  static flags = preparationStageFlags
  async run(): Promise<void> {
    const {flags} = await this.parse(PolicyPrepare)
    await runPreparationStage('policy-prepare', flags.dir, flags.json)
  }
}
