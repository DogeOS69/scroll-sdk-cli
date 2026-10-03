import {Command, Flags} from '@oclif/core'

import {exportCubesignerCheckpoint, importCubesignerCheckpoint} from '../../utils/cubesigner-checkpoint.js'
import {JsonOutputContext} from '../../utils/json-output.js'

export default class CubesignerCheckpoint extends Command {
  static description = 'Export/import a private, instance-bound checkpoint of an existing CLI-created CubeSigner identity and signing session without management login or provider mutations'
  static flags = {
    action: Flags.string({options: ['export', 'import'], required: true}),
    'deployment-dir': Flags.string({default: '.'}),
    directory: Flags.string({description: 'Private checkpoint directory; export requires a new path; keep it outside version control', required: true}),
    instance: Flags.string({description: 'Exact deployment instance binding', required: true}),
    json: Flags.boolean({default: false}),
    organization: Flags.string({description: 'Expected CubeSigner organization ID', required: true}),
    'signer-api-root': Flags.string({description: 'Expected HTTPS signing API origin (for example https://gamma.signer.cubist.dev)', required: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(CubesignerCheckpoint)
    const output = new JsonOutputContext('cubesigner checkpoint', flags.json)
    try {
      const options = {deploymentDir: flags['deployment-dir'], directory: flags.directory, instance: flags.instance, organization: flags.organization, signerApiRoot: flags['signer-api-root']}
      const receipt = (flags.action === 'export' ? exportCubesignerCheckpoint : importCubesignerCheckpoint)(options)
      output.addWarning('Checkpoint validation is local; it does not prove provider availability or that the session has not been revoked. The checkpoint contains signing credentials; keep it private and outside version control.')
      output.success({action: flags.action, directory: flags.directory, receipt})
    } catch (error) {
      output.error('E819_CUBESIGNER_CHECKPOINT', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
