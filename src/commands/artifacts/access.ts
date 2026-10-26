import {Command, Flags} from '@oclif/core'

import type {ArchiveStoreKind} from '../../utils/artifact-access.js'

import {runArtifactAccess} from '../../utils/artifact-access-workflow.js'
import {JsonOutputContext} from '../../utils/json-output.js'

export default class ArtifactAccess extends Command {
  static description = 'Plan, explicitly apply, or check the DA archive or bootstrap snapshot bucket: versioning, the keep-forever retention lifecycle rule, TLS-only, a read statement for the cluster\'s S3 VPC endpoint, an optional public read statement (the DA kill switch), and the writer role\'s IAM grant. Statements with other Sids are preserved. The proof artifact bucket is managed by setup aws.'
  static examples = [
    '<%= config.bin %> <%= command.id %> --store da --public-read --writer-role-arn arn:aws:iam::123456789012:role/eth-da-submitter --apply',
    '<%= config.bin %> <%= command.id %> --store da --no-public-read --apply',
    '<%= config.bin %> <%= command.id %> --store snapshot --writer-role-arn arn:aws:iam::123456789012:role/deploy --apply',
  ]

  static flags = {
    'allow-bucket-public-policy': Flags.boolean({default: false, description: 'Explicitly allow bucket public policies for --public-read; retain blocked ACLs and account-level protections'}),
    apply: Flags.boolean({default: false, description: 'Apply the displayed changes and verify AWS readback', exclusive: ['check']}),
    'aws-profile': Flags.string({description: 'AWS CLI profile'}),
    check: Flags.boolean({default: false, description: 'Fail if the bucket policy, versioning or retention lifecycle differ from the requested state or writer IAM simulation denies access; no writes'}),
    'deployment-dir': Flags.string({default: '.', description: 'Deployment root'}),
    'doge-config': Flags.string({default: '.data/doge-config.toml', description: 'doge-config holding ethereumDa.blobArchive.s3, proofArtifacts.s3 and snapshots.s3'}),
    json: Flags.boolean({default: false}),
    'proof-aws-config': Flags.string({default: '.data/proof-aws.json', description: 'proof-aws-init output; its S3 Gateway VPC endpoint is reused when --vpc-endpoint-id is omitted'}),
    'public-read': Flags.boolean({allowNo: true, description: 'Add (--public-read) or remove (--no-public-read) the anonymous GetObject statement; omitted leaves it unchanged. Removing it on the DA archive is the kill switch: our services keep reading through the VPC endpoint'}),
    store: Flags.string({description: 'Bucket to manage', options: ['da', 'snapshot'], required: true}),
    'vpc-endpoint-id': Flags.string({description: 'S3 Gateway VPC endpoint the cluster reads through (same region as the bucket)'}),
    'writer-role-arn': Flags.string({description: 'The only writer: the eth-da-submitter IRSA role (da) or the deploy role (snapshot); its trust and other policies are preserved'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ArtifactAccess)
    const output = new JsonOutputContext('artifacts access', flags.json)
    try {
      const result = runArtifactAccess(flags.apply ? 'apply' : flags.check ? 'check' : 'plan', {
        allowBucketPublicPolicy: flags['allow-bucket-public-policy'], awsProfile: flags['aws-profile'],
        deploymentDir: flags['deployment-dir'], dogeConfig: flags['doge-config'], proofAwsConfig: flags['proof-aws-config'],
        publicRead: flags['public-read'], store: flags.store as ArchiveStoreKind,
        vpcEndpointId: flags['vpc-endpoint-id'], writerRoleArn: flags['writer-role-arn'],
      })
      for (const warning of result.warnings) output.addWarning(warning)
      output.success({action: result.action, plan: result.plan})
    } catch (error) {
      output.error('E816_ARTIFACT_ACCESS', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
