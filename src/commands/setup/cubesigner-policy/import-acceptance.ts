import {Command, Flags} from '@oclif/core'

import {importLiveAcceptance} from '../../../utils/cubesigner-acceptance.js'
import {PolicyValidationError} from '../../../utils/cubesigner-governance.js'
import {DEFAULT_DEPLOYMENT} from '../../../utils/deployment-paths.js'
import {JsonOutputContext} from '../../../utils/json-output.js'

export default class ImportAcceptance extends Command {
  static description = 'Import a reviewed real signing/denial report and update only signer evidence references; does not sign or certify installation'
  static flags = {dir: Flags.string({default: DEFAULT_DEPLOYMENT}), json: Flags.boolean({default: false}), report: Flags.string({description: 'Actual reviewed exercise report; see docs/cubesigner-preparation.md', required: true})}
  async run(): Promise<void> {
    const {flags} = await this.parse(ImportAcceptance)
    const output = new JsonOutputContext('setup cubesigner-policy import-acceptance', flags.json)
    try {output.success(importLiveAcceptance(flags.dir, flags.report))}
    catch (error) {output.error('E748_ACCEPTANCE_INVALID', error instanceof PolicyValidationError ? error.message : 'Acceptance report or bindings are invalid; existing proof material was not regenerated.', 'VALIDATION', true)}
  }
}
