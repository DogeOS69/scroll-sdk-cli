import {Command} from '@oclif/core'

import {preparationStageFlags, runPreparationStage} from '../../utils/preparation-stage-command.js'

export default class Aws extends Command {
  static description = 'Read external AWS resource information before genesis and bind it to production configuration'
  static flags = preparationStageFlags

  async run(): Promise<void> {
    const {flags} = await this.parse(Aws)
    await runPreparationStage('aws', flags.dir, flags.json)
  }
}
