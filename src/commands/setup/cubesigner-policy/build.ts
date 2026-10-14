import {Command, Flags} from '@oclif/core'

import {buildCubesignerPolicy} from '../../../utils/cubesigner-policy-build.js'
import {JsonOutputContext} from '../../../utils/json-output.js'

export default class CubesignerPolicyBuild extends Command {
  static description = 'Export the CubeSigner policy Wasm and its sha256 from an immutable compiler image, offline'
  static flags = {
    'compiler-image': Flags.string({description: 'ghcr.io/dogeos69/cubesigner-policy-compiler@sha256:<digest> (private; needs docker login ghcr.io with read:packages)', required: true}),
    'expected-core-revision': Flags.string({required: true}),
    json: Flags.boolean({default: false}),
    output: Flags.string({required: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(CubesignerPolicyBuild)
    const output = new JsonOutputContext('setup cubesigner-policy build', flags.json)
    try {
      output.success(buildCubesignerPolicy({compilerImage: flags['compiler-image'], expectedRevision: flags['expected-core-revision'], output: flags.output}))
    } catch (error) { output.error('E740_POLICY_BUILD_FAILED', String(error), 'CONFIGURATION', true) }
  }
}
