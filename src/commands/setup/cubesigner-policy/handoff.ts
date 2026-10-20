import {Command, Flags} from '@oclif/core'

import {createGovernanceHandoff} from '../../../utils/cubesigner-governance-handoff.js'
import {DEFAULT_DEPLOYMENT} from '../../../utils/deployment-paths.js'
import {JsonOutputContext} from '../../../utils/json-output.js'

export default class GovernanceHandoff extends Command {
  static description = 'Archive reviewed Core governance config, state, exact operation log and approval snapshots; never approves or executes an attachment'
  static flags = {
    approval: Flags.string({default: [], description: 'JSON captured by the pinned Core mfa command, one per pending operation', multiple: true}),
    config: Flags.string({description: 'Reviewed Core governance config JSON', required: true}),
    dir: Flags.string({default: DEFAULT_DEPLOYMENT}),
    'initial-seal-last-reviewed': Flags.boolean({description: 'Explicitly declare reviewed unregistered/unfunded setup and sealing before Bridge registration; not an on-chain check'}),
    json: Flags.boolean({default: false}),
    kind: Flags.string({options: ['initial-provisioning', 'sealed-upgrade'], required: true}),
    operations: Flags.string({description: 'Pinned Core governance-log.jsonl; preserve proposal and executed request records', required: true}),
    provisioning: Flags.string({description: 'Reviewed seal-last, unregistered/unfunded initial provisioning evidence'}),
    'session-lifetime': Flags.integer({description: 'Reviewed maximum runtime session lifetime, seconds', min: 300, required: true}),
    state: Flags.string({description: 'Core governance state JSON', required: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(GovernanceHandoff)
    const output = new JsonOutputContext('setup cubesigner-policy handoff', flags.json)
    try {output.success(createGovernanceHandoff({...flags, directory: flags.dir, initialSealLastReviewed: flags['initial-seal-last-reviewed'], sessionLifetime: flags['session-lifetime']}))}
    catch {output.error('E745_GOVERNANCE_HANDOFF_INVALID', 'Unable to archive governance handoff. Check the reviewed Core config/state, exact request and private evidence files; existing request identity cannot be replaced.', 'VALIDATION', true)}
  }
}
