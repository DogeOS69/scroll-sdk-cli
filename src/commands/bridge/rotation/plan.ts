import {Command, Flags} from '@oclif/core'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

import {createRotationProposal, validateRotationSpec} from '../../../utils/bridge-rotation.js'
import {loadRotationPlan, rotationDirectory, runtimeDirectory, saveRotationPlan} from '../../../utils/bridge-rotation-files.js'
import {BridgeRotationRuntime} from '../../../utils/bridge-rotation-runtime.js'

export default class RotationPlan extends Command {
  static description = 'Read validated current bridge state and freeze an independently reviewable attestation rotation proposal'
  static flags = {context: Flags.string(), dir: Flags.string({default: '.', description: 'Operator deployment directory'}), json: Flags.boolean(), namespace: Flags.string(), 'rotation-dir': Flags.string({description: 'Directory containing this rotation spec, frozen proposal, receipts and execution records; relative to --dir'}), spec: Flags.string({default: 'rotation-spec.yaml'})}
  async run(): Promise<void> {
    const {flags} = await this.parse(RotationPlan)
    const root = path.resolve(flags.dir)
    const runtime = new BridgeRotationRuntime({context: flags.context, deploymentDir: runtimeDirectory(root), namespace: flags.namespace})
    const state = await runtime.readState()
    const spec = validateRotationSpec(yaml.load(fs.readFileSync(path.resolve(root, flags['rotation-dir'] ?? '.', flags.spec), 'utf8')))
    const existing = path.join(flags['rotation-dir'] ? path.resolve(root, flags['rotation-dir']) : rotationDirectory(root, spec.name), 'proposal.json')
    const envelope = fs.existsSync(existing) ? loadRotationPlan(root, flags.spec, flags['rotation-dir']).envelope : createRotationProposal(spec, state)
    if (envelope.proposal.current.keyHash !== state.currentKeyHash || envelope.proposal.deployment.protocolContextSha256 !== state.protocolContextSha256) throw new Error('Current bridge changed; create and approve a new proposal')
    const directory = saveRotationPlan(root, envelope, flags['rotation-dir'])
    this.log(JSON.stringify({directory, next: `scrollsdk bridge rotation stage --rotation-dir ${JSON.stringify(directory)}`, overlapActive: Boolean(state.deprecating && state.wfTxNumber + 1 < state.deprecating.deprecationWfTxNumber), proposalSha256: envelope.sha256, targetAddress: envelope.proposal.target.address, timelock: envelope.proposal.timelock}, null, 2))
  }
}
