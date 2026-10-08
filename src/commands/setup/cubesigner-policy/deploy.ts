import {Command, Flags} from '@oclif/core'

import {deployCubesignerPolicy} from '../../../utils/cubesigner-policy-deploy.js'
import {JsonOutputContext} from '../../../utils/json-output.js'

export default class CubesignerPolicyDeploy extends Command {
  static description = 'Upload a compiled policy, verify its remote digest, attach its exact version to a key, and read it back'
  static flags = {
    'build-receipt': Flags.string({required: true}),
    'build-receipt-sha256': Flags.string({required: true}),
    json: Flags.boolean({default: false}),
    'key-id': Flags.string({required: true}),
    name: Flags.string({required: true}),
    organization: Flags.string({required: true}),
    output: Flags.string({required: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(CubesignerPolicyDeploy)
    const output = new JsonOutputContext('setup cubesigner-policy deploy', flags.json)
    try {
      output.success(deployCubesignerPolicy({buildReceipt: flags['build-receipt'], buildReceiptSha256: flags['build-receipt-sha256'], keyId: flags['key-id'], name: flags.name, organization: flags.organization, output: flags.output}))
    } catch (error) { output.error('E741_POLICY_DEPLOY_FAILED', String(error), 'CONFIGURATION', true) }
  }
}
