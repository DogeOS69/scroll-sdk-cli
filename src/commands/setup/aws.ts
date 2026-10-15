import {Command} from '@oclif/core'

import {preparationStageFlags, runPreparationStage} from '../../utils/preparation-stage-command.js'

export default class Aws extends Command {
  static description = 'Prepare declared service identities, AWS resources and database inputs; never allocate GPU capacity'
  static flags = preparationStageFlags

  async run(): Promise<void> {
    const {flags} = await this.parse(Aws)
    await runPreparationStage('aws', flags.dir, flags.json)
  }
}
