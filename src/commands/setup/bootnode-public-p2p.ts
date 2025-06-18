import { Command, Flags } from '@oclif/core'
import { select, confirm } from '@inquirer/prompts'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as toml from '@iarna/toml'
import chalk from 'chalk'
import {
  AWSNodeStaticIPProvider,
  GCPNodeStaticIPProvider,
  SUPPORTED_PROVIDERS,
  PROVIDER_DISPLAY_NAMES,
  type SupportedProvider
} from '../../providers/index.js'

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
    })
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupBootnodeStaticIP)

    this.log('')
    this.log(chalk.blue('🔧 Bootnode P2P Network Setup'))
    this.log(chalk.blue('=============================='))
    this.log('')
    this.log('This command enables external nodes to form P2P networks with your cluster bootnodes.')
    this.log('It configures static IPs and LoadBalancer services to ensure consistent peer discovery from outside the cluster.')
    this.log('')

    const confirmation = await confirm({
      message: `This command is intended for development use only. 
Production environments may require more complex network configuration.
Do you want to continue?`,
      default: false
    })
    
    if (!confirmation) {
      this.log(chalk.yellow('Exiting...'))
      return;
    }

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

    this.log(`Selected provider: ${chalk.cyan(PROVIDER_DISPLAY_NAMES[provider])}`)
    this.log('')

    // Get provider instance
    const providerInstance = this.getProviderInstance(provider)

    try {
      // Check prerequisites
      this.log(chalk.blue('Step 1: Checking prerequisites...'))
      const prerequisitesMet = await providerInstance.checkPrerequisites()

      if (!prerequisitesMet) {
        this.error(`Prerequisites not met for ${PROVIDER_DISPLAY_NAMES[provider]}. Please install required tools and configure credentials.`)
      }

      this.log('')
      this.log('')
      this.log(chalk.blue('Step 2: Setting up static IPs...'))

      // Load config once and extract bootnode count
      let config: any
      let bootnodeCount: number
      try {
        config = this.loadConfig()
        bootnodeCount = this.getBootnodeCountFromConfig(config)
      } catch (error) {
        this.log(chalk.yellow(`Warning: ${error instanceof Error ? error.message : String(error)}`))
        this.log(chalk.yellow('Defaulting to 2 bootnodes'))
        bootnodeCount = 2
        config = null
      }

      // Actually perform the static IP setup
      const bootnodeDomains = await providerInstance.setupStaticIP(flags, bootnodeCount)
    } catch (error) {
      this.log('')
      this.log(chalk.red('❌ Bootnode P2P network setup failed:'))
      this.log(chalk.red(error instanceof Error ? error.message : String(error)))
      this.exit(1)
    }
  }

  private getProviderInstance(provider: SupportedProvider) {
    switch (provider) {
      case 'aws':
        return new AWSNodeStaticIPProvider()
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
      this.log(chalk.yellow('No [bootnode] section found in config.toml, defaulting to 2 bootnodes'))
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

    this.log(chalk.blue(`Found ${count} bootnode(s) in config.toml`))
    return count
  }


} 