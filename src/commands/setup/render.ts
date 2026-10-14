import {Command} from '@oclif/core'

import {preparationStageFlags, runPreparationStage} from '../../utils/preparation-stage-command.js'

export default class Render extends Command {
  static description = 'Render final deployment values, runtime configuration and private Secrets'
  static flags = preparationStageFlags

  async run(): Promise<void> {
    const {flags} = await this.parse(Render)
    await runPreparationStage('render', flags.dir, flags.json)
  }
}
