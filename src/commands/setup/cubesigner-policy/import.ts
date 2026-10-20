import {Command, Flags} from '@oclif/core'

import {importCubesignerPolicy} from '../../../utils/cubesigner-policy-import.js'
import {DEFAULT_DEPLOYMENT} from '../../../utils/deployment-paths.js'
import {JsonOutputContext} from '../../../utils/json-output.js'

export default class CubesignerPolicyImport extends Command {
  static description = 'Import an external policy Wasm for staged preparation; verify hashes and record operator-declared build provenance without publishing or attaching'
  static flags = {
    'build-script-revision': Flags.string({description: 'Full Core commit containing tools/cubesigner/build-verifier.sh', required: true}),
    'core-revision': Flags.string({description: 'Full policy source commit used for the external build', required: true}),
    dir: Flags.string({default: DEFAULT_DEPLOYMENT, description: 'Saved deployment directory'}),
    'expected-protocol-context-sha256': Flags.string({description: 'Reviewed SHA-256 of .data/protocol_context.json', required: true}),
    'expected-wasm-sha256': Flags.string({description: 'Independently agreed Wasm SHA-256', required: true}),
    json: Flags.boolean({default: false}),
    'source-repo': Flags.string({description: 'Local Core repository containing both commits; no checkout or fetch is performed', required: true}),
    wasm: Flags.string({description: 'Existing Wasm path relative to the deployment directory', required: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(CubesignerPolicyImport)
    const output = new JsonOutputContext('setup cubesigner-policy import', flags.json)
    try {
      output.success(importCubesignerPolicy({buildScriptRevision: flags['build-script-revision'], coreRevision: flags['core-revision'], directory: flags.dir, expectedProtocolContextSha256: flags['expected-protocol-context-sha256'], expectedWasmSha256: flags['expected-wasm-sha256'], sourceRepo: flags['source-repo'], wasm: flags.wasm}))
    } catch (error) {output.error('E740_POLICY_BUILD_FAILED', error instanceof Error ? error.message : 'Unable to import external policy', 'CONFIGURATION', true)}
  }
}
