import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import * as toml from '@iarna/toml'
import type { DogeConfig } from '../../types/doge-config.js'
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'

export default class SetupGenRpcPackage extends Command {
  static override description = 'Generate configuration files for dogeos-rpc-package to enable external RPC nodes'

  static override examples = [
    '# Generate RPC package (dogeos-rpc-package directory is required)',
    '<%= config.bin %> <%= command.id %> -d ~/github/dogeos-rpc-package/',
    '',
    '# Generate mainnet RPC package with specific config',
    '<%= config.bin %> <%= command.id %> --doge-config .data/doge-config-mainnet.toml -d ~/github/dogeos-rpc-package/',
    '',
    '# First clone the project: git clone https://github.com/dogeos69/dogeos-rpc-package',
    '<%= config.bin %> <%= command.id %> -d ./dogeos-rpc-package/',
  ]

  static override flags = {
    'doge-config': Flags.string({
      description: 'Path to doge config file to determine network type (mainnet/testnet)',
      required: false,
    }),
    'dogeos-rpc-package-dir': Flags.string({
      char: 'd',
      description: 'Path to dogeos-rpc-package project directory (clone from https://github.com/dogeos69/dogeos-rpc-package)',
      required: true,
    }),
    'config-path': Flags.string({
      description: 'Path to config.toml file containing cluster configuration',
      default: './config.toml',
      required: false,
    }),
    'values-dir': Flags.string({
      description: 'Directory containing Helm values files (must include genesis.yaml)',
      default: './values',
      required: false,
    }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupGenRpcPackage)

    try {
      this.log(chalk.blue('🚀 Starting RPC package generation...'))
      this.log('')

      // Verify dogeos-rpc-package directory exists
      const rpcPackageDir = path.resolve(flags['dogeos-rpc-package-dir'])
      if (!fs.existsSync(rpcPackageDir)) {
        this.log(chalk.red(`❌ dogeos-rpc-package directory not found: ${rpcPackageDir}`))
        this.log('')
        this.log(chalk.yellow('Please clone the dogeos-rpc-package project first:'))
        this.log(chalk.cyan('git clone https://github.com/dogeos69/dogeos-rpc-package'))
        this.log('')
        this.exit(1)
      }
      this.log(chalk.green(`✓ Using dogeos-rpc-package directory: ${rpcPackageDir}`))
      this.log('')

      // Step 1: Load DogeConfig
      const { config: dogeConfig, configPath: dogeConfigPath } = await loadDogeConfigWithSelection(
        flags['doge-config'],
        `${this.config.bin} ${this.id}`
      )
      this.log(chalk.blue(`Using DogeConfig file: ${dogeConfigPath}`))

      // Step 2: Load config.toml
      const config = this.loadConfig(flags['config-path'])
      this.log(chalk.green('Successfully loaded config.toml'))

      // Step 3: Determine network type
      const network = dogeConfig.network
      if (network !== 'mainnet' && network !== 'testnet') {
        throw new Error(`Invalid network type in dogeConfig: '${network}'. Expected 'mainnet' or 'testnet'.`)
      }
      this.log(chalk.blue(`Network type: ${network}`))

      // Step 4: Setup directory structure  
      this.log(chalk.blue(`RPC package directory: ${rpcPackageDir}`))

      // Step 5: Get LoadBalancer domains
      this.log(chalk.blue('Step 1: Getting LoadBalancer domains...'))
      const loadBalancerDomains = await this.getLoadBalancerDomains()
      if (Object.keys(loadBalancerDomains).length > 0) {
        this.log(chalk.green(`✓ Found ${Object.keys(loadBalancerDomains).length} LoadBalancer domains`))
        for (const [service, domain] of Object.entries(loadBalancerDomains)) {
          this.log(chalk.cyan(`  ${service}: ${domain}`))
        }
      } else {
        this.log(chalk.yellow('⚠️  No LoadBalancer domains found - using placeholders'))
      }

      // Step 6: Generate l2geth.env file
      this.log(chalk.blue('Step 2: Generating l2geth.env file...'))

      // Log which L1 RPC URL will be used
      if (config?.frontend?.EXTERNAL_RPC_URI_L1) {
        this.log(chalk.cyan(`  Using external L1 RPC: ${config.frontend.EXTERNAL_RPC_URI_L1}`))
      } else if (config?.general?.L1_RPC_ENDPOINT) {
        this.log(chalk.yellow(`  Warning: Using internal L1 RPC: ${config.general.L1_RPC_ENDPOINT}`))
        this.log(chalk.yellow(`  This may not be accessible from outside the cluster`))
      } else {
        this.log(chalk.red(`  Warning: No L1 RPC endpoint found in config`))
      }

      const envFilePath = this.generateL2GethEnvFile(config, dogeConfig, rpcPackageDir, loadBalancerDomains)
      this.log(chalk.green(`✓ Generated l2geth.env at: ${envFilePath}`))

      // Step 7: Extract genesis.json from genesis.yaml
      this.log(chalk.blue('Step 3: Extracting genesis.json from genesis.yaml...'))
      const genesisJsonPath = this.extractGenesisJson(flags['values-dir'], rpcPackageDir, network)
      this.log(chalk.green(`✓ Extracted genesis.json at: ${genesisJsonPath}`))

      this.log('')
      this.log(chalk.green('🎉 RPC package generation completed successfully!'))
      this.log('')
      this.log(chalk.blue('Generated files:'))
      this.log(chalk.cyan(`  - ${envFilePath}`))
      this.log(chalk.cyan(`  - ${genesisJsonPath}`))
      this.log('')
      if (Object.keys(loadBalancerDomains).length > 0) {
        this.log(chalk.green('✅ LoadBalancer domains have been automatically resolved and applied.'))
      } else {
        this.log(chalk.yellow('⚠️  LoadBalancer domains could not be automatically resolved.'))
        this.log(chalk.yellow('The generated l2geth.env contains placeholder domains that need to be replaced.'))
        this.log(chalk.yellow('Run the following command to get the actual LoadBalancer domains:'))
        this.log(chalk.cyan('kubectl get svc | grep p2p'))
        this.log('')
        this.log(chalk.yellow('Then replace the placeholders in l2geth.env with the actual EXTERNAL-IP domains.'))
      }

    } catch (error) {
      this.log('')
      this.log(chalk.red('❌ RPC package generation failed:'))
      this.log(chalk.red(error instanceof Error ? error.message : String(error)))
      this.exit(1)
    }
  }

  private loadConfig(configPath: string): any {
    const resolvedPath = path.resolve(configPath)

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`config.toml not found at: ${resolvedPath}`)
    }

    try {
      const configContent = fs.readFileSync(resolvedPath, 'utf-8')
      return toml.parse(configContent) as any
    } catch (error) {
      throw new Error(`Failed to parse config.toml: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private capitalize(str: string): string {
    if (!str) return ''
    return str.charAt(0).toUpperCase() + str.slice(1)
  }

  private async getLoadBalancerDomains(): Promise<Record<string, string>> {
    try {
      const { execSync } = await import('node:child_process')

      // Run kubectl command to get LoadBalancer services
      const output = execSync('kubectl get svc -o json', {
        encoding: 'utf-8',
        timeout: 10000 // 10 second timeout
      })

      const services = JSON.parse(output)
      const loadBalancerDomains: Record<string, string> = {}

      // Filter LoadBalancer services matching l2-bootnode-{N}-p2p pattern
      for (const service of services.items) {
        if (service.spec?.type === 'LoadBalancer' &&
          service.status?.loadBalancer?.ingress?.[0]?.hostname) {

          const serviceName = service.metadata?.name
          // Match l2-bootnode-{N}-p2p pattern only
          if (serviceName && /^l2-bootnode-\d+-p2p$/.test(serviceName)) {
            const hostname = service.status.loadBalancer.ingress[0].hostname
            loadBalancerDomains[serviceName] = hostname
          }
        }
      }

      return loadBalancerDomains
    } catch (error) {
      this.log(chalk.yellow(`Warning: Failed to get LoadBalancer domains: ${error instanceof Error ? error.message : String(error)}`))
      return {}
    }
  }

  private convertPeersToExternalDomains(peers: string[], loadBalancerDomains: Record<string, string> = {}): string[] {
    return peers.map(peer => {
      // Convert internal cluster addresses to LoadBalancer domains
      // Format: enode://nodekey@hostname:port

      if (peer.includes('@l2-bootnode-')) {
        // Extract bootnode index from hostname like l2-bootnode-0:30303
        const match = peer.match(/@l2-bootnode-(\d+):(\d+)/)
        if (match) {
          const bootnodeIndex = match[1]
          const port = match[2]
          const serviceName = `l2-bootnode-${bootnodeIndex}-p2p`

          // Use real LoadBalancer domain if available, otherwise use placeholder
          const domain = loadBalancerDomains[serviceName] || `<LoadBalancer-Domain-For-l2-bootnode-${bootnodeIndex}>`
          return peer.replace(`@l2-bootnode-${bootnodeIndex}:${port}`, `@${domain}:${port}`)
        }
      }



      // If no match found, return original peer (might already be external)
      return peer
    })
  }

  private generateL2GethEnvFile(
    config: any,
    dogeConfig: DogeConfig,
    rpcPackageDir: string,
    loadBalancerDomains: Record<string, string> = {},
  ): string {
    const network = dogeConfig.network
    const networkTitleCase = this.capitalize(network)
    const envLines: string[] = []

    envLines.push(`# L2Geth ${networkTitleCase} Configuration`)
    envLines.push(`# Generated for external RPC package usage`)
    envLines.push('')
    envLines.push(`# Network specific settings`)

    if (config?.general?.CHAIN_ID_L2 !== undefined) {
      envLines.push(`CHAIN_ID=${config.general.CHAIN_ID_L2}`)
    }

    // Use external L1 RPC URL instead of cluster internal URL
    if (config?.frontend?.EXTERNAL_RPC_URI_L1) {
      envLines.push(`L2GETH_L1_ENDPOINT=${config.frontend.EXTERNAL_RPC_URI_L1}`)
    } else if (config?.general?.L1_RPC_ENDPOINT) {
      this.error('No L1 RPC endpoint found in config')
    }

    if (config?.general?.L1_CONTRACT_DEPLOYMENT_BLOCK !== undefined) {
      envLines.push(`L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK=${config.general.L1_CONTRACT_DEPLOYMENT_BLOCK}`)
    }

    envLines.push('')
    envLines.push(`# ${networkTitleCase} bootnode peer list`)

    const hasRealDomains = Object.keys(loadBalancerDomains).length > 0
    if (hasRealDomains) {
      envLines.push(`# LoadBalancer domains have been automatically resolved`)
    } else {
      envLines.push(`# NOTE: Placeholder domains need to be replaced with actual LoadBalancer domains`)
      envLines.push(`# Run: kubectl get svc | grep p2p`)
      envLines.push(`# Replace <LoadBalancer-Domain-For-l2-bootnode-X> with actual EXTERNAL-IP domains`)
    }

    if (config?.bootnode?.L2_GETH_PUBLIC_PEERS && Array.isArray(config.bootnode.L2_GETH_PUBLIC_PEERS)) {
      const externalPeers = this.convertPeersToExternalDomains(config.bootnode.L2_GETH_PUBLIC_PEERS, loadBalancerDomains)
      envLines.push(`L2GETH_PEER_LIST=${JSON.stringify(externalPeers)}`)
    } else if (config?.sequencer?.L2_GETH_PUB_PEERS && Array.isArray(config.sequencer.L2_GETH_PUB_PEERS)) {
      // Fallback to sequencer peers if bootnode peers not found
      const externalPeers = this.convertPeersToExternalDomains(config.sequencer.L2_GETH_PUB_PEERS, loadBalancerDomains)
      envLines.push(`L2GETH_PEER_LIST=${JSON.stringify(externalPeers)}`)
    }

    const envContent = envLines.join('\n') + '\n'
    const targetDirectory = path.resolve(rpcPackageDir, 'envs', network)
    const envFilePath = path.join(targetDirectory, 'l2geth.env')

    // Create directory structure
    fs.mkdirSync(targetDirectory, { recursive: true })

    // Write env file
    fs.writeFileSync(envFilePath, envContent)

    return envFilePath
  }

  private extractGenesisJson(valuesDir: string, rpcPackageDir: string, network: string): string {
    const genesisYamlPath = path.resolve(valuesDir, 'genesis.yaml')

    if (!fs.existsSync(genesisYamlPath)) {
      throw new Error(`genesis.yaml not found at: ${genesisYamlPath}`)
    }

    try {
      // Read and parse genesis.yaml
      const genesisYamlContent = fs.readFileSync(genesisYamlPath, 'utf-8')
      const genesisYaml = yaml.load(genesisYamlContent) as any

      if (!genesisYaml) {
        throw new Error('Failed to parse genesis.yaml - file appears to be empty or invalid')
      }

      // Extract genesis.json from the YAML structure
      // The structure might be: { genesis: "JSON_STRING" } or { genesis: JSON_OBJECT }
      let genesisJson: any

      if (genesisYaml.scrollConfig) {
        if (typeof genesisYaml.scrollConfig === 'string') {
          // If genesis is a JSON string, parse it
          try {
            genesisJson = JSON.parse(genesisYaml.scrollConfig)
          } catch (parseError) {
            throw new Error(`Failed to parse genesis JSON string: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
          }
        } else if (typeof genesisYaml.scrollConfig === 'object') {
          // If genesis is already an object, use it directly
          genesisJson = genesisYaml.scrollConfig
        } else {
          throw new Error('Invalid genesis format in genesis.yaml - expected string or object')
        }
      } else {
        // If no 'genesis' key, assume the entire YAML is the genesis data
        genesisJson = genesisYaml
      }

      // Create target directory
      const targetDirectory = path.resolve(rpcPackageDir, 'configs', network)
      fs.mkdirSync(targetDirectory, { recursive: true })

      // Write genesis.json
      const genesisJsonPath = path.join(targetDirectory, 'genesis.json')
      const genesisJsonContent = JSON.stringify(genesisJson, null, 2)
      fs.writeFileSync(genesisJsonPath, genesisJsonContent)

      return genesisJsonPath

    } catch (error) {
      if (error instanceof Error && error.message.includes('Failed to parse genesis')) {
        throw error
      }
      throw new Error(`Failed to extract genesis.json: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
} 