import {Command} from '@oclif/core'

import {assertDeploymentIdentity} from '../../../utils/rotation-export.js'
import {rotationArgs, rotationFlags, rotationSetup, tsoFlag} from '../../../utils/rotation-flags.js'
import {checkOnline} from '../../../utils/rotation-operations.js'

export default class RotationOnline extends Command {
  static args = rotationArgs
  static description = 'Check that every target signer and at least M live current signers polled the TSO in the last 60 seconds; read-only'
  static examples = ['<%= config.bin %> <%= command.id %> ./rotation-export.json --dir ./deployment']
  static flags = {...rotationFlags, ...tsoFlag}

  async run(): Promise<void> {
    const {args, flags} = await this.parse(RotationOnline)
    const {cluster, rotation} = rotationSetup(args.export, flags)
    const status = await cluster.wpStatus()
    assertDeploymentIdentity(rotation, status)
    const result = await checkOnline(cluster, rotation, status)
    this.log(JSON.stringify({...result, note: 'A fresh poll proves an authenticated transport-key poll only; it does not prove the release, enforce mode, RPC health or that old signers loaded the allowlist entry.'}, null, 2))
    if (!result.passed) process.exitCode = 1
  }
}
