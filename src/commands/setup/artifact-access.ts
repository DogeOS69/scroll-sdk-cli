import {Command, Flags} from '@oclif/core'

import type {ArchiveStoreKind} from '../../utils/artifact-access.js'

import {applyArtifactAccess, checkArtifactWriter, planArtifactAccess} from '../../utils/artifact-access.js'
import {readArtifactStore, readOptionalArtifactStore} from '../../utils/artifact-stores.js'
import {AwsCliRunner} from '../../utils/aws-cli.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {readOptionalProofAwsConfig} from '../../utils/proof-aws-config.js'

export default class ArtifactAccess extends Command {
  static description = 'Plan, explicitly apply, or check the DA archive or bootstrap snapshot bucket: versioning, TLS-only, a read statement for the cluster\'s S3 VPC endpoint, an optional public read statement (the DA kill switch), and the writer role\'s IAM grant. Statements with other Sids are preserved. The proof artifact bucket is managed by setup proof-aws-init.'
  static examples = [
    '<%= config.bin %> <%= command.id %> --store da --public-read --writer-role-arn arn:aws:iam::123456789012:role/eth-da-submitter --apply',
    '<%= config.bin %> <%= command.id %> --store da --no-public-read --apply',
    '<%= config.bin %> <%= command.id %> --store snapshot --writer-role-arn arn:aws:iam::123456789012:role/deploy --apply',
  ]

  static flags = {
    apply: Flags.boolean({default: false, description: 'Apply the displayed changes and verify AWS readback', exclusive: ['check']}),
    'aws-profile': Flags.string({description: 'AWS CLI profile'}),
    check: Flags.boolean({default: false, description: 'Fail if the bucket policy or versioning differ from the requested state or writer IAM simulation denies access; no writes'}),
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
    const output = new JsonOutputContext('setup artifact-access', flags.json)
    try {
      const kind = flags.store as ArchiveStoreKind
      const {store} = readArtifactStore(kind, flags['deployment-dir'], flags['doge-config'])
      const proofAws = readOptionalProofAwsConfig(flags['deployment-dir'], flags['proof-aws-config'])?.config
      const recordedVpce = proofAws?.artifactReadTransport.vpcEndpoint?.vpcEndpointId
      // A gateway endpoint only serves buckets in its own region.
      const vpcEndpointId = flags['vpc-endpoint-id'] ?? (proofAws?.kubernetes.awsRegion === store.region ? recordedVpce : undefined)
      if (!vpcEndpointId) output.addWarning(`No S3 Gateway VPC endpoint for ${store.region}; the VPC endpoint read statement is left unchanged`)
      const sidecarStore = kind === 'da' && flags['writer-role-arn'] ? readOptionalArtifactStore('proof', flags['deployment-dir'], flags['doge-config']) : undefined
      if (kind === 'da' && flags['writer-role-arn'] && !sidecarStore) output.addWarning('proofArtifacts.s3 is not configured; the DA writer gets no segmentation-sidecar grant')
      const aws = new AwsCliRunner(flags['aws-profile'])
      const plan = planArtifactAccess(aws, kind, store, {publicRead: flags['public-read'], sidecarStore, vpcEndpointId, writerRoleArn: flags['writer-role-arn']})
      if (flags.check) {
        if (plan.bucketPolicy.changed || plan.versioning.changed) throw new Error('Bucket policy or versioning differs from the requested state; review the plan, then --apply')
        checkArtifactWriter(aws, plan)
      }

      if (flags.apply) applyArtifactAccess(aws, plan)
      output.addWarning('Policy checks do not certify live access: verify unsigned reads of actual objects and writes from the workload; explicit denies, endpoint policies and KMS can still block access.')
      output.success({action: flags.apply ? 'applied' : flags.check ? 'checked' : 'plan', plan})
    } catch (error) {
      output.error('E816_ARTIFACT_ACCESS', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
