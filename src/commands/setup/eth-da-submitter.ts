import { Command, Flags } from '@oclif/core'

import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import { setupManagedSigner } from '../../utils/managed-signer-setup.js'
import { createNonInteractiveContext } from '../../utils/non-interactive.js'

export default class SetupEthDaSubmitter extends Command {
  static override description = 'Configure the eth-da-submitter L1_COMMIT_SENDER signer'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --signer-backend aws-kms --aws-region us-west-2 --eks-cluster dogeos-testnet --network-alias testnet',
    '<%= config.bin %> <%= command.id %> --non-interactive --json --signer-backend local',
  ]

  static override flags = {
    'archive-bucket': Flags.string({
      description: 'S3 bucket whose read/write permissions should be granted to the eth-da-submitter KMS IAM role.',
    }),
    'archive-key-prefix': Flags.string({
      description: 'Object key prefix under the archive bucket.',
    }),
    'archive-region': Flags.string({
      description: 'Region that owns the archive bucket (defaults to --aws-region).',
    }),
    'aws-profile': Flags.string({
      description: 'AWS CLI profile to use for KMS signer provisioning.',
    }),
    'aws-region': Flags.string({
      description: 'AWS region for the EKS cluster and KMS key.',
    }),
    'create-archive-bucket': Flags.boolean({
      allowNo: true,
      default: true,
      description: 'Create the archive bucket if --archive-bucket is set and the bucket does not exist.',
    }),
    'disable-archive': Flags.boolean({
      default: false,
      description: 'Skip S3 blob archive setup for the eth-da-submitter KMS signer.',
    }),
    'doge-config': Flags.string({
      description: 'Path to Dogecoin config file (defaults to .data/doge-config.toml)',
    }),
    'eks-cluster': Flags.string({
      description: 'EKS cluster name or ARN used for IRSA trust binding.',
    }),
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    'kms-key-id': Flags.string({
      description: 'Existing KMS key id, ARN, or alias for L1_COMMIT_SENDER / eth-da-submitter.',
    }),
    namespace: Flags.string({
      default: 'default',
      description: 'Kubernetes namespace for the KMS signer service account.',
    }),
    'network-alias': Flags.string({
      description: 'Resource alias used to derive deterministic KMS aliases and IAM role names.',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts. Uses existing config or provided flags.',
    }),
    'role-arn': Flags.string({
      description: 'Existing IAM role ARN to annotate on the eth-da-submitter service account.',
    }),
    'service-account': Flags.string({
      default: 'eth-da-submitter',
      description: 'Kubernetes service account used by eth-da-submitter.',
    }),
    'signer-backend': Flags.string({
      description: 'Signer backend for L1_COMMIT_SENDER / eth-da-submitter.',
      options: ['local', 'aws-kms'],
    }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupEthDaSubmitter) as any
    const nonInteractive = flags['non-interactive']
    const jsonMode = flags.json
    createNonInteractiveContext('setup eth-da-submitter', nonInteractive, jsonMode)
    const jsonCtx = new JsonOutputContext('setup eth-da-submitter', jsonMode)

    const { config: dogeConfig, configPath } = await loadDogeConfigWithSelection(
      flags['doge-config'],
      'scrollsdk setup doge-config'
    )
    jsonCtx.info(`Using Dogecoin config file: ${configPath}`)

    const result = await setupManagedSigner({
      dogeConfig,
      dogeConfigPath: configPath,
      flags,
      hasFlag: (name: string) => this.hasFlag(name),
      jsonCtx,
      jsonMode,
      nonInteractive,
      signerKey: 'l1CommitSender',
    })

    if (jsonMode) {
      jsonCtx.success({
        address: result.address,
        dogeConfigPath: configPath,
        signer: result.signerConfig,
      })
    }
  }

  private hasFlag(name: string): boolean {
    return this.argv.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`))
  }
}
