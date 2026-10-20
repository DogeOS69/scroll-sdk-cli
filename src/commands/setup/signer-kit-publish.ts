import {Command} from '@oclif/core'

import {preparationStageFlags, runPreparationStage} from '../../utils/preparation-stage-command.js'

export default class SignerKitPublish extends Command {
  static description = 'Resume the saved signer-kit-publish stage; runs only its declared effects'
  static flags = preparationStageFlags
  async run(): Promise<void> {
    const {flags} = await this.parse(SignerKitPublish)
    await runPreparationStage('signer-kit-publish', flags.dir, flags.json)
  }
}
