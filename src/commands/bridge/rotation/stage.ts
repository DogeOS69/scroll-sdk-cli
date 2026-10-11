import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {loadRotationPlan, prepareRotationStage, rotationJson, runtimeDirectory} from '../../../utils/bridge-rotation-files.js'
import {BridgeRotationRuntime} from '../../../utils/bridge-rotation-runtime.js'

export default class RotationStage extends Command {
  static description = 'Register target signers alongside current signers, export handoff materials and enable the WP rotation route; never submit RotateKey'
  static flags = {context: Flags.string(), dir: Flags.string({default: '.'}), json: Flags.boolean(), namespace: Flags.string(), 'rotation-dir': Flags.string({description: 'Directory containing this rotation spec, frozen proposal, receipts and execution records; relative to --dir'}), spec: Flags.string({default: 'rotation-spec.yaml'})}
  async run(): Promise<void> {
    const {flags} = await this.parse(RotationStage)
    const root = path.resolve(flags.dir); const deployment = runtimeDirectory(root)
    const {dir, envelope} = loadRotationPlan(root, flags.spec, flags['rotation-dir'])
    const runtime = new BridgeRotationRuntime({context: flags.context, deploymentDir: deployment, namespace: flags.namespace})
    const state = await runtime.readState()
    if (state.currentKeyHash !== envelope.proposal.current.keyHash || state.protocolContextSha256 !== envelope.proposal.deployment.protocolContextSha256) throw new Error('Current bridge changed; create a new plan')
    const receipt = prepareRotationStage(deployment, dir, envelope)
    const log = fs.openSync(path.join(dir, 'stage-private.log'), 'a', 0o600)
    try {
      execFileSync('make', ['install-withdrawal-processor', `KUBE_CONTEXT=${runtime.context}`, `NAMESPACE=${runtime.namespace}`], {cwd: deployment, stdio: ['ignore', log, log], timeout: 600_000})
      execFileSync('kubectl', ['--context', runtime.context, '-n', runtime.namespace, 'rollout', 'status', 'statefulset/withdrawal-processor', '--timeout=300s'], {stdio: ['ignore', log, log], timeout: 330_000})
    } catch {throw new Error('WP staging did not finish; inspect the private stage log and rerun stage. No rotation was submitted')} finally {fs.closeSync(log)}

    receipt.status = 'applied'; rotationJson(path.join(dir, 'stage.json'), receipt)
    this.log(JSON.stringify({directory: dir, next: 'Distribute the public proposal and signer-deployment package. Collect authenticated approvals and readiness receipts before apply. Never distribute private-backup or stage-private.log.', proposalSha256: envelope.sha256, status: 'staged'}, null, 2))
  }
}
