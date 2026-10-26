import {Command, Flags} from '@oclif/core'

import {JsonOutputContext} from '../../utils/json-output.js'

export default class SetupApply extends Command {
  static description = 'Retired: use setup plan and staged preparation commands'
  static flags = {dir: Flags.string({aliases: ['deployment-dir']}), json: Flags.boolean({default: false})}
  static hidden = true

  async run(): Promise<void> {
    const {flags} = await this.parse(SetupApply)
    new JsonOutputContext('setup apply', flags.json).error('E751_PREPARATION_APPLY_RETIRED', 'setup apply is no longer supported. Use setup plan, setup genesis, setup aws and the subsequent stages. Old plans are not migrated; preserve existing deployment files.', 'CONFIGURATION', false)
  }
}
