import {Command, Flags} from '@oclif/core'
import fs from 'node:fs'

import {parseLivenessOutpoint} from '../../../utils/rotation-export.js'
import {rotationArgs, rotationFlags, rotationSetup, tsoFlag} from '../../../utils/rotation-flags.js'
import {ONLINE_CHECK_LIMITS, besideExport, existingIntentReport, sendRotation} from '../../../utils/rotation-operations.js'

export default class RotationSend extends Command {
  static args = rotationArgs
  static description = 'Submit the rotation export to the WP once (POST /propose), or report the intent already stored under its idempotency key; --preview only builds (POST /build) and stores nothing'
  static examples = [
    '<%= config.bin %> <%= command.id %> ./rotation-export.json --dir ./deployment --liveness-outpoint <txid>:<vout> --preview',
    '<%= config.bin %> <%= command.id %> ./rotation-export.json --dir ./deployment --liveness-outpoint <txid>:<vout>',
  ]

  static flags = {
    ...rotationFlags, ...tsoFlag,
    'liveness-outpoint': Flags.string({description: 'Required for a new intent: <txid>:<vout> of a confirmed output of at least 1 DOGE paying the target P2SH address, from a transaction carrying the bridge-funding marker OP_RETURN'}),
    preview: Flags.boolean({default: false, description: 'Run every check and POST /build only; never /propose'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(RotationSend)
    const livenessOutpoint = flags['liveness-outpoint'] === undefined ? undefined : parseLivenessOutpoint(flags['liveness-outpoint'])
    const {cluster, rotation} = rotationSetup(args.export, flags)
    const outcome = await sendRotation({cluster, livenessOutpoint, preview: flags.preview, rotation})
    if (outcome.kind === 'existing') {
      this.log(JSON.stringify(existingIntentReport(rotation, outcome.intent), null, 2))
      process.exitCode = outcome.exitCode
      return
    }

    const file = besideExport(args.export, outcome.kind === 'preview' ? 'preview' : 'send')
    fs.writeFileSync(file, `${JSON.stringify(outcome.response, null, 2)}\n`, {mode: 0o600})
    const preview = {liveness: 'The WP validated the liveness outpoint over Dogecoin RPC; see liveness_outpoint and liveness_value_sats.', note: 'Preview only; nothing was stored.'}
    this.log(JSON.stringify({onlineCheck: ONLINE_CHECK_LIMITS, response: outcome.response, saved: file, ...(outcome.kind === 'proposed' ? {httpStatus: outcome.status, next: 'Re-run send with the same export to see the stored intent state.'} : preview)}, null, 2))
  }
}
