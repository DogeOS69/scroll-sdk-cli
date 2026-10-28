import {Command, Flags} from '@oclif/core'

import {importAwsSpec} from '../../utils/aws-spec-import.js'
import {DEFAULT_SPEC} from '../../utils/deployment-paths.js'
import {JsonOutputContext} from '../../utils/json-output.js'

export default class ImportAws extends Command {
  static description = 'Import external CloudFormation resource references into an operator spec; preview by default, no AWS mutations'
  static flags = {
    json: Flags.boolean({default: false}),
    manifest: Flags.string({description: 'YAML source manifest: explicit stack names or saved outputs files', required: true}),
    profile: Flags.string({description: 'AWS CLI profile for read-only DescribeStacks calls'}),
    replace: Flags.boolean({default: false, description: 'Allow replacing different existing spec values when writing'}),
    spec: Flags.string({default: DEFAULT_SPEC, description: 'Operator-owned DeploymentSpec; environment references remain unresolved'}),
    write: Flags.boolean({default: false, description: 'Back up and atomically update the spec; otherwise only preview changed field names'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ImportAws)
    const output = new JsonOutputContext('setup import-aws', flags.json)
    try {
      const result = importAwsSpec(flags)
      if (!flags.json) {
        for (const change of result.changes) output.info(`${change.conflict ? 'REPLACE' : 'SET'} ${change.path}`)
        output.info(result.written ? `Spec updated; backup: ${result.backup}` : result.changes.length > 0 ? 'Preview only. Use --write to apply; differing existing values also require --replace.' : 'No changes; spec already matches the selected outputs.')
      }

      output.success(result)
    } catch (error) {output.error('E760_AWS_SPEC_IMPORT_FAILED', error instanceof Error ? error.message : 'AWS spec import failed', 'CONFIGURATION', true)}
  }
}
