import {Command, Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import {assertRotationAdmission} from '../../../utils/bridge-rotation.js'
import {rotationPayload, submitFrozenRotation} from '../../../utils/bridge-rotation-execution.js'
import {assertRotationReceipts, assertStageUnchanged, loadRotationPlan, rotationJson, runtimeDirectory} from '../../../utils/bridge-rotation-files.js'
import {BridgeRotationRuntime} from '../../../utils/bridge-rotation-runtime.js'
import {rotationStatus} from '../../../utils/bridge-rotation-status.js'

export default class RotationApply extends Command {
  static description = 'Submit the frozen approved RotateKey intent once, or resume it with the same idempotency key'
  static flags = {
    context: Flags.string(), dir: Flags.string({default: '.'}), json: Flags.boolean(), namespace: Flags.string(),
    'rotation-dir': Flags.string({description: 'Directory containing this rotation spec, frozen proposal, receipts and execution records; relative to --dir'}), spec: Flags.string({default: 'rotation-spec.yaml'}),
    'wait-seconds': Flags.integer({default: 600, description: 'Track activation for this duration; zero returns after submission. Timeouts retain durable ownership.', min: 0}),
    'wp-url': Flags.string({description: 'Optional HTTPS or loopback WP endpoint; default: temporary loopback kubectl port-forward'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(RotationApply)
    const root = path.resolve(flags.dir); const deployment = runtimeDirectory(root)
    const {dir, envelope} = loadRotationPlan(root, flags.spec, flags['rotation-dir'])
    const runtime = new BridgeRotationRuntime({context: flags.context, deploymentDir: deployment, namespace: flags.namespace, wpUrl: flags['wp-url']})
    const payload = rotationPayload(envelope)
    let intent = await runtime.readIntent(payload.idempotency_key)
    const before = rotationStatus(envelope, await runtime.readState(), intent)
    if (before.targetActive && !intent) throw new Error('Target is already active but its durable intent was not found; investigate before any submission')
    const started = fs.existsSync(path.join(dir, 'submission.json'))
    if (!started && !intent) {
      assertStageUnchanged(deployment, dir, envelope.sha256)
      assertRotationReceipts(dir, envelope)
      assertRotationAdmission(envelope, await runtime.readState())
      const preview = await runtime.post('/protocol-actions/rotate-key/build', payload)
      if (preview.status !== 200) {
        // This exact core limitation occurs after script/CLTV admission, for a preview containing withdrawals.
        const limited = preview.status === 422 && JSON.stringify(preview.body).includes('fulfilled withdrawal public value required when withdrawal_output_count > 0')
        if (!limited) throw new Error(`WP preview rejected with HTTP ${preview.status}; no durable submission attempted`)
      }
    }

    // Resume must first reconcile durable ownership, even if the chain has already moved to the target.
    if (intent && ['failed_terminal', 'superseded'].includes(intent.status)) throw new Error(`Existing intent is ${intent.status}; inspect it before preparing a different proposal. It will not be automatically replaced`)
    if (!intent) {
      // A previous lost response does not authorize rotating an unrelated new baseline.
      // Recheck admission whenever the authoritative DB has no durable intent.
      assertRotationAdmission(envelope, await runtime.readState())
      const result = await submitFrozenRotation(dir, envelope, body => runtime.post('/protocol-actions/rotate-key/propose', body))
      if (result.disposition !== 'accepted') this.log(`Submission ${result.disposition}; the WP may already own this intent. Retain all signers and use status/apply to reconcile the same request.`)
    }

    const deadline = Date.now() + flags['wait-seconds'] * 1000
    for (;;) {
      intent = await runtime.readIntent(payload.idempotency_key)
      const status = rotationStatus(envelope, await runtime.readState(), intent)
      rotationJson(path.join(dir, 'status.json'), status)
      this.log(JSON.stringify(status))
      if (status.outcome === 'failed') {process.exitCode = 1; return}
      if ((status.outcome === 'activated' && status.subsequentWfObserved) || Date.now() >= deadline) {
        // Activation is automated; operator-side signature evidence remains unverified.
        // Never report full workflow success solely from a subsequent replay head.
        process.exitCode = 2
        return
      }

      await new Promise(resolve => {setTimeout(resolve, Math.min(10_000, deadline - Date.now()))})
    }
  }
}
