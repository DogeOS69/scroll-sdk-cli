import {Command} from '@oclif/core'

import {preparationStageFlags, runPreparationStage} from '../../utils/preparation-stage-command.js'

export default class SignerKit extends Command {
  static description = 'Resume the saved signer-kit stage; runs only its declared effects'
  static flags = preparationStageFlags
  async run(): Promise<void> {
    const {flags} = await this.parse(SignerKit)
    await runPreparationStage('signer-kit', flags.dir, flags.json)
  }
}
