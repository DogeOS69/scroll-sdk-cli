import {Command} from '@oclif/core'

import {preparationStageFlags, runPreparationStage} from '../../utils/preparation-stage-command.js'

export default class ProofPublish extends Command {
  static description = 'Resume the saved proof-publish stage; runs only its declared effects'
  static flags = preparationStageFlags
  async run(): Promise<void> {
    const {flags} = await this.parse(ProofPublish)
    await runPreparationStage('proof-publish', flags.dir, flags.json)
  }
}
