import {Command, Flags} from '@oclif/core'

import {rotationArgs, rotationFlags, rotationSetup} from '../../../utils/rotation-flags.js'
import {registerRotation} from '../../../utils/rotation-operations.js'

export default class RotationRegister extends Command {
  static args = rotationArgs
  static description = 'Register every current and target signer of a rotation export with the WP/TSO (merge only, rendered with helm template before any write); never submits a rotation'
  static examples = ['<%= config.bin %> <%= command.id %> ./rotation-export.json --dir ./deployment']
  static flags = {...rotationFlags, 'wait-seconds': Flags.integer({default: 300, description: 'How long to wait for the WP to report every key as registered', min: 0})}

  async run(): Promise<void> {
    const {args, flags} = await this.parse(RotationRegister)
    const {cluster, rotation} = rotationSetup(args.export, flags)
    const result = await registerRotation({cluster, rotation, waitSeconds: flags['wait-seconds']})
    this.log(JSON.stringify({...result, next: result.installed ? 'Registered and rolled out. Run bridge rotation online once the target signers are up.' : 'Every key was already registered; nothing changed.', proposal: rotation.proposal}, null, 2))
  }
}
