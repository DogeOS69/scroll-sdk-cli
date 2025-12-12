import { Command, Flags } from '@oclif/core'
import { select, confirm } from '@inquirer/prompts'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as toml from '@iarna/toml'
import chalk from 'chalk'
import {
  AWSNodeLBProvider,
  GCPNodeStaticIPProvider,
  SUPPORTED_PROVIDERS,
  PROVIDER_DISPLAY_NAMES,
  type SupportedProvider
} from '../../providers/index.js'
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
    provider: Flags.string({
      description: 'Cloud provider for static IP allocation (aws, gcp)',
      options: [...SUPPORTED_PROVIDERS],
      required: false
    }),
    'cluster-name': Flags.string({
      description: 'Kubernetes cluster name for resource tagging and identification',
      required: false
    }),
    region: Flags.string({
      description: 'Cloud provider region where resources will be created',
      required: false
    }),
    'values-dir': Flags.string({
      description: 'Directory containing Helm values files for configuration',
      default: './values'
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      description: 'Run without prompts. Requires --provider flag.',
      default: false
    }),
    'json': Flags.boolean({
      description: 'Output in JSON format (stdout for data, stderr for logs)',
      default: false
    })
  }

  private nonInteractive: boolean = false
  private jsonMode: boolean = false
  private jsonCtx!: JsonOutputContext

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
        message: 'Select your cloud provider:',
        choices: SUPPORTED_PROVIDERS.map(p => ({
          name: PROVIDER_DISPLAY_NAMES[p],
          value: p
        }))
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

      // Load config once and extract bootnode count
      let config: any
      let bootnodeCount: number
      try {
        config = this.loadConfig()
        bootnodeCount = this.getBootnodeCountFromConfig(config)
      } catch (error) {
        this.jsonCtx.addWarning(`${error instanceof Error ? error.message : String(error)}`)
        this.jsonCtx.info('Defaulting to 2 bootnodes')
        bootnodeCount = 2
        config = null
      }

      // Actually perform the static IP setup
      await providerInstance.setupLb(flags, bootnodeCount)

      // JSON success output
      this.jsonCtx.success({
        provider,
        bootnodeCount,
        valuesDir: flags['values-dir'],
        clusterName: flags['cluster-name'],
        region: flags.region
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
      case 'aws':
        return new AWSNodeLBProvider()
      case 'gcp':
        return new GCPNodeStaticIPProvider()
      default:
        throw new Error(`Unsupported provider: ${provider}`)
    }
  }

  private capitalize(str: string): string {
    if (!str) return ''
    return str.charAt(0).toUpperCase() + str.slice(1)
  }

  private loadConfig(): any {
    const configPath = path.join(process.cwd(), 'config.toml')

    if (!fs.existsSync(configPath)) {
      throw new Error(`config.toml not found in current directory: ${process.cwd()}`)
    }

    try {
      const configContent = fs.readFileSync(configPath, 'utf-8')
      return toml.parse(configContent) as any
    } catch (error) {
      throw new Error(`Failed to parse config.toml: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private getBootnodeCountFromConfig(config: any): number {
    if (!config.bootnode) {
      this.jsonCtx.info('No [bootnode] section found in config.toml, defaulting to 2 bootnodes')
      return 2
    }

    // Count bootnodes (bootnode-0, bootnode-1, etc.)
    let count = 0

    if (config.bootnode && typeof config.bootnode === 'object') {
      Object.keys(config.bootnode).forEach(key => {
        if (key.startsWith('bootnode-') && config.bootnode[key] &&
          typeof config.bootnode[key] === 'object' &&
          Object.values(config.bootnode[key]).some(value => value !== '')) {
          count++
        }
      })
    }

    // If no bootnode subsections found, default to 2
    if (count === 0) {
      count = 2
    }

    this.jsonCtx.info(`Found ${count} bootnode(s) in config.toml`)
    return count
  }
} 