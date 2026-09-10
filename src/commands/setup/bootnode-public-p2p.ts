import { select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'

import type {DogeConfig} from '../../types/doge-config.js'

import {
  AWSNodeLBProvider,
  GCPNodeStaticIPProvider,
  PROVIDER_DISPLAY_NAMES,
  SUPPORTED_PROVIDERS,
  type SupportedProvider
} from '../../providers/index.js'
import {loadDogeConfigWithSelection} from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'

export default class SetupBootnodeStaticIP extends Command {
  static override description = 'Enable external nodes to form P2P network with cluster bootnodes by setting up static IPs and LoadBalancer services'

  static override examples = [
    '# Setup static IPs with interactive provider selection',
    '<%= config.bin %> <%= command.id %>',
    '',
    '# Setup static IPs for AWS with specific cluster and region',
    '<%= config.bin %> <%= command.id %> --provider=aws --cluster-name=my-cluster --region=us-west-2',
    '',
    '# Setup with custom values directory',
    '<%= config.bin %> <%= command.id %> --values-dir=./custom-values',
    '',
    '# Non-interactive mode (requires --provider)',
    '<%= config.bin %> <%= command.id %> --non-interactive --provider=aws --cluster-name=my-cluster --region=us-west-2',
    '',
    '# JSON output mode',
    '<%= config.bin %> <%= command.id %> --non-interactive --json --provider=aws --cluster-name=my-cluster --region=us-west-2',
  ]

  static override flags = {
    'cluster-name': Flags.string({
      description: 'Kubernetes cluster name for resource tagging and identification',
      required: false
    }),
    'doge-config': Flags.string({description: 'Path to Reth node configuration (defaults to .data/doge-config.toml)'}),
    'json': Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)'
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts. Requires --provider flag.'
    }),
    provider: Flags.string({
      description: 'Cloud provider for static IP allocation (aws, gcp)',
      options: [...SUPPORTED_PROVIDERS],
      required: false
    }),
    region: Flags.string({
      description: 'Cloud provider region where resources will be created',
      required: false
    }),
    'values-dir': Flags.string({
      default: './values',
      description: 'Directory containing Helm values files for configuration'
    })
  }

  private jsonCtx!: JsonOutputContext
  private jsonMode: boolean = false
  private nonInteractive: boolean = false

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupBootnodeStaticIP)

    this.nonInteractive = flags['non-interactive']
    this.jsonMode = flags.json
    this.jsonCtx = new JsonOutputContext('setup bootnode-public-p2p', this.jsonMode)

    // In non-interactive mode, require --provider
    if (this.nonInteractive && !flags.provider) {
      this.jsonCtx.error(
        'E601_MISSING_FIELD',
        '--provider flag is required in non-interactive mode',
        'CONFIGURATION',
        true,
        { flag: '--provider', options: [...SUPPORTED_PROVIDERS] }
      )
    }

    this.jsonCtx.info('Bootnode P2P Network Setup')
    this.jsonCtx.info('==============================')
    this.jsonCtx.info('This command enables external nodes to form P2P networks with your cluster bootnodes.')
    this.jsonCtx.info('It configures static IPs and LoadBalancer services to ensure consistent peer discovery from outside the cluster.')

    // Provider selection
    let provider = flags.provider as SupportedProvider
    if (!provider) {
      provider = await select({
        choices: SUPPORTED_PROVIDERS.map(p => ({
          name: PROVIDER_DISPLAY_NAMES[p],
          value: p
        })),
        message: 'Select your cloud provider:'
      })
    }

    this.jsonCtx.info(`Selected provider: ${PROVIDER_DISPLAY_NAMES[provider]}`)

    // Get provider instance
    const providerInstance = this.getProviderInstance(provider)

    try {
      // Check prerequisites
      this.jsonCtx.info('Step 1: Checking prerequisites...')
      const prerequisitesMet = await providerInstance.checkPrerequisites()

      if (!prerequisitesMet) {
        this.jsonCtx.error(
          'E100_PREREQUISITES_NOT_MET',
          `Prerequisites not met for ${PROVIDER_DISPLAY_NAMES[provider]}. Please install required tools and configure credentials.`,
          'PREREQUISITE',
          true,
          { provider }
        )
      }

      this.jsonCtx.info('Step 2: Setting up static IPs...')

      const {config} = await loadDogeConfigWithSelection(flags['doge-config'], 'scrollsdk setup doge-config')
      const bootnodeIndices = getRethBootnodeIndices(config)
      await providerInstance.setupLb(flags, bootnodeIndices)

      // JSON success output
      this.jsonCtx.success({
        bootnodeCount: bootnodeIndices.length,
        bootnodeIndices,
        clusterName: flags['cluster-name'],
        provider,
        region: flags.region,
        valuesDir: flags['values-dir']
      })
    } catch (error) {
      this.jsonCtx.error(
        'E900_BOOTNODE_SETUP_FAILED',
        `Bootnode P2P network setup failed: ${error instanceof Error ? error.message : String(error)}`,
        'INTERNAL',
        false,
        { error: String(error) }
      )
    }
  }


  private getProviderInstance(provider: SupportedProvider) {
    switch (provider) {
      case 'aws': {
        return new AWSNodeLBProvider()
      }

      case 'gcp': {
        return new GCPNodeStaticIPProvider()
      }

      default: {
        throw new Error(`Unsupported provider: ${provider}`)
      }
    }
  }

}

export function getRethBootnodeIndices(config: DogeConfig): number[] {
  const indices = config.bootnodeReth?.instances?.map(instance => instance.index) || []
  if (indices.length === 0 || indices.some(index => !Number.isSafeInteger(index) || index < 0) || new Set(indices).size !== indices.length) {
    throw new Error('Configure unique Reth bootnode indices with setup l2-bootnode-reth before exposing public P2P services.')
  }

  return indices.sort((a, b) => a - b)
}
