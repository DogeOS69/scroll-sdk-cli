import {Command} from '@oclif/core'

import {preparationStageFlags, runPreparationStage} from '../../utils/preparation-stage-command.js'

export default class SignerSession extends Command {
  static description = 'Validate/reuse or explicitly create the CubeSigner runtime session; completed steps are skipped on retry'
  static flags = preparationStageFlags

  async run(): Promise<void> {
    const {flags} = await this.parse(SignerSession)
    await runPreparationStage('signer-session', flags.dir, flags.json, flags['defer-cubesigner'])
  }
}
