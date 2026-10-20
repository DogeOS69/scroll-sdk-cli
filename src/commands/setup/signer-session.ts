import {Command} from '@oclif/core'

import {preparationStageFlags, runPreparationStage} from '../../utils/preparation-stage-command.js'

export default class SignerSession extends Command {
  static description = 'Create the remote CubeSigner role session and private runtime seed; completed sessions are not recreated on stage retry'
  static flags = preparationStageFlags

  async run(): Promise<void> {
    const {flags} = await this.parse(SignerSession)
    await runPreparationStage('signer-session', flags.dir, flags.json)
  }
}
