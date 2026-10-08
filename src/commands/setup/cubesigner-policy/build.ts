import {Command, Flags} from '@oclif/core'

import {buildCubesignerPolicy} from '../../../utils/cubesigner-policy-build.js'
import {JsonOutputContext} from '../../../utils/json-output.js'

export default class CubesignerPolicyBuild extends Command {
  static description = 'Compile a bridge-specific CubeSigner policy Wasm offline using an immutable compiler image'
  static flags = {
    'compiler-image': Flags.string({required: true}),
    'expected-core-revision': Flags.string({required: true}),
    json: Flags.boolean({default: false}),
    output: Flags.string({required: true}),
    'preparation-receipt': Flags.string({required: true}),
    'protocol-context': Flags.string({default: '.data/protocol_context.json'}),
    'resolver-base-url': Flags.string({required: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(CubesignerPolicyBuild)
    const output = new JsonOutputContext('setup cubesigner-policy build', flags.json)
    try {
      output.success(buildCubesignerPolicy({compilerImage: flags['compiler-image'], expectedRevision: flags['expected-core-revision'], output: flags.output, preparationReceipt: flags['preparation-receipt'], protocolContext: flags['protocol-context'], resolverBaseUrl: flags['resolver-base-url']}))
    } catch (error) { output.error('E740_POLICY_BUILD_FAILED', String(error), 'CONFIGURATION', true) }
  }
}
