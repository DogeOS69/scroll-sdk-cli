import {Command, Flags} from '@oclif/core'

import {JsonOutputContext} from '../../../utils/json-output.js'
import {publishProofConfig} from '../../../utils/proof-config-transaction.js'

export default class ProofConfigPublish extends Command {
  static description = 'Review or apply the immutable prepared S3 program publication plan, verify readback and finalize its deployment contract'
  static flags = {
    apply: Flags.boolean({default: false, description: 'Perform S3 writes; omission only validates and displays the frozen plan'}),
    'aws-profile': Flags.string({description: 'AWS profile yielding temporary publication credentials'}),
    json: Flags.boolean({default: false}),
    receipt: Flags.string({description: 'proof-config-prepared.json returned by prepare', required: true}),
    'receipt-sha256': Flags.string({description: 'Expected immutable prepared receipt SHA-256', required: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ProofConfigPublish)
    const output = new JsonOutputContext('setup proof-config publish', flags.json)
    try {
      const result = await publishProofConfig({apply: flags.apply, awsProfile: flags['aws-profile'], receipt: flags.receipt, receiptSha256: flags['receipt-sha256']})
      output.success(result)
    } catch (error) { output.error('E731_PROOF_CONFIG_PUBLISH_FAILED', String(error), 'CONFIGURATION', true) }
  }
}
