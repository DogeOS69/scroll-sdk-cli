import {Command} from '@oclif/core'

import {preparationStageFlags, runPreparationStage} from '../../utils/preparation-stage-command.js'

export default class Genesis extends Command {
  static description = 'Generate and pin local genesis artifacts after validating existing AWS resources'
  static flags = preparationStageFlags

  async run(): Promise<void> {
    const {flags} = await this.parse(Genesis)
    await runPreparationStage('genesis', flags.dir, flags.json)
  }
}
