import {Command, Flags} from '@oclif/core'
import fs from 'node:fs'

import {assertSeparateDaProofBuckets} from '../../utils/artifact-bucket-validation.js'
import {proofArtifactStoreFromDogeConfig} from '../../utils/artifact-stores.js'
import {dogeConfigToToml, loadDogeConfigWithSelection} from '../../utils/doge-config.js'
import {CliExitError, JsonOutputContext} from '../../utils/json-output.js'
import {KmsSignerProvisioner} from '../../utils/kms-signer-provisioner.js'
import {resolveBlobArchive} from '../../utils/managed-signer-setup.js'

export default class SetupEthDaSubmitter extends Command {
  static override description = 'Configure the eth-da-submitter S3 archive and optional writer IAM permissions'
  static override examples = [
    '<%= config.bin %> <%= command.id %> --archive-bucket dogeos-da --archive-region us-east-1 --archive-key-prefix devnet -N',
    '<%= config.bin %> <%= command.id %> --no-create-archive-bucket --role-arn arn:aws:iam::123456789012:role/archive-writer -N',
    '<%= config.bin %> <%= command.id %> --disable-archive -N',
  ]

  static override flags = {
    'archive-bucket': Flags.string({description: 'S3 blob archive bucket.'}),
    'archive-key-prefix': Flags.string({description: 'Deployment prefix for raw DA blobs; proof sidecars use proofArtifacts.s3. Core owns the relative object paths.'}),
    'archive-public-base-url': Flags.string({description: 'Public HTTPS base URL used by blob consumers.'}),
    'archive-region': Flags.string({description: 'Region owning the archive bucket.'}),
    'aws-profile': Flags.string({description: 'AWS profile for archive resource operations.'}),
    'aws-region': Flags.string({description: 'Fallback archive region; existing archive region takes precedence.'}),
    'create-archive-bucket': Flags.boolean({allowNo: true, description: 'Create/reuse the bucket. Defaults to enabled for a configured AWS KMS submitter, disabled for a local signer.'}),
    'disable-archive': Flags.boolean({default: false, description: 'Disable archive configuration without deleting buckets or IAM policies.'}),
    'doge-config': Flags.string({description: 'Dogecoin configuration file.'}),
    json: Flags.boolean({default: false}),
    'non-interactive': Flags.boolean({char: 'N', default: false}),
    'role-arn': Flags.string({description: 'Existing archive writer IAM role. Defaults to the submitter signer service-account role.'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(SetupEthDaSubmitter)
    const output = new JsonOutputContext('setup eth-da-submitter', flags.json)
    try {
      const {config, configPath} = await loadDogeConfigWithSelection(flags['doge-config'])
      const signer = config.signers?.l1CommitSender
      const archive = await resolveBlobArchive({dogeConfig: config, dogeConfigPath: configPath, flags, hasFlag: name => this.argv.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`)), jsonCtx: output, jsonMode: flags.json, nonInteractive: flags['non-interactive'], signerKey: 'l1CommitSender'}, flags['aws-region'] || signer?.kmsRegion)
      const roleArn = flags['role-arn'] || signer?.serviceAccountRoleArn
      const createBucket = flags['create-archive-bucket'] ?? signer?.backend === 'aws_kms'
      if (archive.enabled) {
        assertSeparateDaProofBuckets(config)
        // With a proof artifact store configured, the writer also gets its
        // segmentation-sidecar namespace there.
        const sidecar = config.proofArtifacts?.s3 ? {sidecarStore: proofArtifactStoreFromDogeConfig(config)} : {}
        await new KmsSignerProvisioner(output, flags['aws-profile']).provisionArchive(archive, {createBucket, roleArn, ...sidecar})
        if (!roleArn) output.addWarning('No archive writer IAM role selected; writer access must be provided separately.')
      }

      fs.writeFileSync(configPath, dogeConfigToToml(config), {mode: 0o600})
      fs.chmodSync(configPath, 0o600)
      output.logSuccess('Archive configuration saved. Signing identities are managed by setup gen-keystore --service eth-da-submitter.')
      output.success({archive, dogeConfigPath: configPath, writerRoleArn: roleArn})
    } catch (error) {
      if (error instanceof CliExitError) throw error
      output.error('E621_ARCHIVE_CONFIGURATION_FAILED', error instanceof Error ? error.message : 'Archive configuration failed', 'CONFIGURATION', true)
    }
  }
}
