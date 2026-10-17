import {Command} from '@oclif/core'

import {preparationStageFlags, runPreparationStage} from '../../utils/preparation-stage-command.js'

export default class ProtocolContext extends Command {
  static description = 'Generate canonical protocol context from completed Bridge funding; stop before policy builds and proof preparation'
  static flags = preparationStageFlags

  async run(): Promise<void> {
    const {flags} = await this.parse(ProtocolContext)
    await runPreparationStage('protocol-context', flags.dir, flags.json)
  }
}
