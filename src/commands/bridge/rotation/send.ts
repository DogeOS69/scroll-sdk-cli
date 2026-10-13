import {Command, Flags} from '@oclif/core'
import fs from 'node:fs'

import {rotationArgs, rotationFlags, rotationSetup, tsoFlag} from '../../../utils/rotation-flags.js'
import {besideExport, sendRotation} from '../../../utils/rotation-operations.js'

export default class RotationSend extends Command {
  static args = rotationArgs
  static description = 'Submit the rotation export to the WP once (POST /propose), or report the intent already stored under its idempotency key; --preview only builds (POST /build) and stores nothing'
  static examples = ['<%= config.bin %> <%= command.id %> ./rotation-export.json --dir ./deployment --preview', '<%= config.bin %> <%= command.id %> ./rotation-export.json --dir ./deployment']
  static flags = {...rotationFlags, ...tsoFlag, preview: Flags.boolean({default: false, description: 'Run every check and POST /build only; never /propose'})}

  async run(): Promise<void> {
    const {args, flags} = await this.parse(RotationSend)
    const {cluster, rotation} = rotationSetup(args.export, flags)
    const outcome = await sendRotation({cluster, preview: flags.preview, rotation})
    if (outcome.kind === 'existing') {
      this.log(JSON.stringify({idempotencyKey: rotation.wp_rotate_key_request.idempotency_key, intent: outcome.intent, note: 'Already stored; the WP drives it. Nothing was resubmitted.'}, null, 2))
      process.exitCode = outcome.exitCode
      return
    }

    const file = besideExport(args.export, outcome.kind === 'preview' ? 'preview' : 'send')
    fs.writeFileSync(file, `${JSON.stringify(outcome.response, null, 2)}\n`, {mode: 0o600})
    this.log(JSON.stringify({response: outcome.response, saved: file, ...(outcome.kind === 'proposed' ? {httpStatus: outcome.status, next: 'Re-run send with the same export to see the stored intent state.'} : {note: 'Preview only; nothing was stored.'})}, null, 2))
  }
}
