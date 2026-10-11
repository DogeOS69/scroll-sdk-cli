import {Command, Flags} from '@oclif/core'

import type {RecoveryNetwork} from '../../utils/recovery-key.js'

import {JsonOutputContext} from '../../utils/json-output.js'
import {createRecoveryKey, inspectRecoveryKey} from '../../utils/recovery-key.js'

export default class HelperRecoveryKey extends Command {
  static description = 'Create or inspect a custodian recovery key offline; no Dogecoin node, RPC, AWS or deployment spec required'
  static flags = {
    action: Flags.string({default: 'create', description: 'Create a new key or verify an existing key/backup without changing it', options: ['create', 'inspect']}),
    json: Flags.boolean({default: false, description: 'Output public metadata only; never print the private key'}),
    network: Flags.string({description: 'Deployment Dogecoin network', options: ['mainnet', 'testnet', 'regtest'], required: true}),
    output: Flags.string({description: 'Custodian-owned directory outside source control; parent must exist, create refuses an existing directory', required: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(HelperRecoveryKey)
    const output = new JsonOutputContext('helper recovery-key', flags.json)
    try {
      const run = flags.action === 'inspect' ? inspectRecoveryKey : createRecoveryKey
      const result = run(flags.output, flags.network as RecoveryNetwork)
      output.info(`Recovery public key: ${result.publicKey}`)
      output.info(`Share only: ${result.publicFile}`)
      output.info(`Keep private and back up: ${result.privateFile}`)
      output.success(result)
    } catch (error) {
      output.error('E760_RECOVERY_KEY_FAILED', error instanceof Error ? error.message : 'Recovery key operation failed; private contents omitted', 'CONFIGURATION', true)
    }
  }
}
