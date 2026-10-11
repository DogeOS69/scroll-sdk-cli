import {Command, Flags} from '@oclif/core'
import path from 'node:path'

import {rotationPayload} from '../../../utils/bridge-rotation-execution.js'
import {loadRotationPlan, rotationJson, runtimeDirectory} from '../../../utils/bridge-rotation-files.js'
import {BridgeRotationRuntime} from '../../../utils/bridge-rotation-runtime.js'
import {rotationStatus} from '../../../utils/bridge-rotation-status.js'

export default class RotationStatus extends Command {
  static description = 'Read durable rotation status and validated replay state; never submit or retry a transaction'
  static flags = {context: Flags.string(), dir: Flags.string({default: '.'}), json: Flags.boolean(), namespace: Flags.string(), 'rotation-dir': Flags.string({description: 'Directory containing this rotation spec, frozen proposal, receipts and execution records; relative to --dir'}), spec: Flags.string({default: 'rotation-spec.yaml'})}
  async run(): Promise<void> {
    const {flags} = await this.parse(RotationStatus)
    const root = path.resolve(flags.dir); const {dir, envelope} = loadRotationPlan(root, flags.spec, flags['rotation-dir'], false)
    const runtime = new BridgeRotationRuntime({context: flags.context, deploymentDir: runtimeDirectory(root), namespace: flags.namespace})
    const status = rotationStatus(envelope, await runtime.readState(), await runtime.readIntent(rotationPayload(envelope).idempotency_key))
    rotationJson(path.join(dir, 'status.json'), status)
    this.log(JSON.stringify(status, null, 2))
  }
}
