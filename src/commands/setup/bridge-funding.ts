import {Command} from '@oclif/core'

import {preparationStageFlags, runPreparationStage} from '../../utils/preparation-stage-command.js'

export default class BridgeFunding extends Command {
  static description = 'Resume Bridge preparation through wallet and marked Bridge funding handoffs'
  static flags = preparationStageFlags

  async run(): Promise<void> {
    const {flags} = await this.parse(BridgeFunding)
    await runPreparationStage('bridge-funding', flags.dir, flags.json)
  }
}
