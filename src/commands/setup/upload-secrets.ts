import {Command} from '@oclif/core'

import {preparationStageFlags, runPreparationStage} from '../../utils/preparation-stage-command.js'

export default class UploadSecrets extends Command {
  static description = 'Upload prepared runtime Secrets to the saved deployment destination'
  static flags = preparationStageFlags

  async run(): Promise<void> {
    const {flags} = await this.parse(UploadSecrets)
    await runPreparationStage('upload-secrets', flags.dir, flags.json)
  }
}
