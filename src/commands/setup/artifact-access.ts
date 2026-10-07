import {Command, Flags} from '@oclif/core'

import {applyArtifactAccess, checkArtifactWriter, planArtifactAccess} from '../../utils/artifact-access.js'
import {AwsCliRunner} from '../../utils/aws-cli.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {readSharedArtifactStore} from '../../utils/proof-shared-artifact-store.js'

export default class ArtifactAccess extends Command {
  static description = 'Plan, explicitly apply, or check current-instance S3 public reads and archive writer IAM grants; preserve existing policies and Public Access Block'
  static flags = {
    apply: Flags.boolean({default: false, description: 'Apply the displayed prefix-scoped additions and verify AWS readback', exclusive: ['check']}),
    'aws-profile': Flags.string({description: 'AWS CLI profile'}),
    check: Flags.boolean({default: false, description: 'Fail if the public-read statement is absent or writer IAM simulation denies access; no writes'}),
    'deployment-dir': Flags.string({default: '.', description: 'Deployment root'}),
    'doge-config': Flags.string({default: '.data/doge-config.toml', description: 'Canonical shared artifact store config'}),
    json: Flags.boolean({default: false}),
    'public-read': Flags.boolean({default: false, description: 'Add/check an anonymous GetObject grant for this prefix\'s public artifact namespaces'}),
    'writer-role-arn': Flags.string({description: 'Existing eth-da-submitter (or other archive writer) IAM role ARN; its trust and other policies are preserved'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ArtifactAccess)
    const output = new JsonOutputContext('setup artifact-access', flags.json)
    try {
      const {store} = readSharedArtifactStore(flags['deployment-dir'], flags['doge-config'])
      const aws = new AwsCliRunner(flags['aws-profile'])
      const plan = planArtifactAccess(aws, store, {publicRead: flags['public-read'], writerRoleArn: flags['writer-role-arn']})
      if (flags.check) {
        if (plan.bucketPolicy?.changed) throw new Error('Current prefix lacks the CLI public-read statement; review artifact-access --public-read, then --apply (operator-equivalent grants are not inferred)')
        checkArtifactWriter(aws, plan)
      }

      if (flags.apply) applyArtifactAccess(aws, plan)
      output.addWarning('Policy checks do not certify live access: verify unsigned reads of actual artifacts and writes from the workload; explicit denies, endpoint policies and KMS can still block access.')
      output.success({action: flags.apply ? 'applied' : flags.check ? 'checked' : 'plan', plan})
    } catch (error) {
      output.error('E816_ARTIFACT_ACCESS', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
