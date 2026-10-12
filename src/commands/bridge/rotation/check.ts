import {Command, Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import {assertRotationAdmission} from '../../../utils/bridge-rotation.js'
import {rotationPayload} from '../../../utils/bridge-rotation-execution.js'
import {assertRotationReceipts, assertStageUnchanged, loadRotationPlan, rotationJson, runtimeDirectory} from '../../../utils/bridge-rotation-files.js'
import {BridgeRotationRuntime} from '../../../utils/bridge-rotation-runtime.js'

export default class RotationCheck extends Command {
  static description = 'Read-only pre-submission checks: report blockers without WP build/propose requests, rollout, or signer changes'
  static flags = {context: Flags.string(), dir: Flags.string({default: '.'}), json: Flags.boolean(), namespace: Flags.string(), 'rotation-dir': Flags.string({required: true}), spec: Flags.string({default: 'rotation-spec.yaml'})}

  async run(): Promise<void> {
    const {flags} = await this.parse(RotationCheck)
    const root = path.resolve(flags.dir); const deployment = runtimeDirectory(root)
    const {dir, envelope} = loadRotationPlan(root, flags.spec, flags['rotation-dir'])
    const checks: {detail?: string; name: string; passed: boolean}[] = []
    const check = async (name: string, run: () => Promise<void> | void) => {
      try {await run(); checks.push({name, passed: true})} catch (error) {checks.push({detail: error instanceof Error ? error.message : 'Check failed', name, passed: false})}
    }

    await check('stage', () => {
      if (!fs.existsSync(path.join(dir, 'stage.json'))) throw new Error('Run stage before submission; it registers target identities and restarts WP')
      assertStageUnchanged(deployment, dir, envelope.sha256)
    })
    await check('operator-receipts', () => assertRotationReceipts(dir, envelope))
    const runtime = new BridgeRotationRuntime({context: flags.context, deploymentDir: deployment, namespace: flags.namespace})
    await check('live-admission', async () => assertRotationAdmission(envelope, await runtime.readState()))
    await check('not-submitted', async () => {
      if (fs.existsSync(path.join(dir, 'submission.json')) || await runtime.readIntent(rotationPayload(envelope).idempotency_key)) throw new Error('A submission journal or durable intent exists; use status to reconcile it')
    })
    const ready = checks.every(item => item.passed)
    const result = {checks, note: 'No WP build/propose request was sent. Receipt senders must be authenticated outside this tool. Apply will recheck live state and run WP preview; this is not rotation completion.', proposalSha256: envelope.sha256, readyForSubmissionChecks: ready, submissionAttemptedByThisCommand: false, submitted: checks.find(item => item.name === 'not-submitted')?.passed ? false : null,
      wpPreviewPerformed: false}
    rotationJson(path.join(dir, 'check.json'), result)
    this.log(JSON.stringify(result, null, 2))
    if (!ready) process.exitCode = 2
  }
}
