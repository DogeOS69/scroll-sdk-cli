/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic TOML config operations */
import * as toml from '@iarna/toml'
import { input } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { DogeConfig } from '../../types/doge-config.js'

import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'

export default class SetupGenRpcPackage extends Command {
  static override description = 'Generate configuration files for dogeos-rpc-package to enable external RPC nodes'

  static override examples = [
    '# Generate RPC package (dogeos-rpc-package directory is required)',
    '<%= config.bin %> <%= command.id %> -d ~/github/dogeos-rpc-package/',
    '',
    '# Generate mainnet RPC package with specific config and namespace',
    '<%= config.bin %> <%= command.id %> --doge-config .data/doge-config.toml -d ~/github/dogeos-rpc-package/ -n scroll-mainnet',
    '',
    '# First clone the project: git clone https://github.com/dogeos69/dogeos-rpc-package',
    '<%= config.bin %> <%= command.id %> -d ./dogeos-rpc-package/ --namespace default',
  ]

  static override flags = {
    'config-path': Flags.string({
      default: './config.toml',
      description: 'Path to config.toml file containing cluster configuration',
      required: false,
    }),
    'doge-config': Flags.string({
      description: 'Path to Dogecoin config file; network is read from config.toml [dogecoin].network',
      required: false,
    }),
    'dogeos-rpc-package-dir': Flags.string({
      char: 'd',
      description: 'Path to dogeos-rpc-package project directory (clone from https://github.com/dogeos69/dogeos-rpc-package)',
      required: true,
    }),
    namespace: Flags.string({
      char: 'n',
      description: 'Kubernetes namespace',
    }),
    'values-dir': Flags.string({
      default: './values',
      description: 'Directory containing Helm values files (must include genesis.yaml)',
      required: false,
    }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupGenRpcPackage)

    try {
      this.log(chalk.blue('🚀 Starting RPC package generation...'))
      this.log('')

      // Get namespace interactively if not provided
      let {namespace} = flags
      if (!namespace) {
        namespace = await input({
          default: 'default',
          message: 'Enter Kubernetes namespace:',
          validate(value: string) {
            if (!value || value.trim() === '') {
              return 'Namespace cannot be empty'
            }

            return true
          }
        })
      }

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
        `${this.config.bin} ${this.id}`,
        flags['config-path']
      )
      this.log(chalk.blue(`Using DogeConfig file: ${dogeConfigPath}`))

      // Step 2: Load config.toml
      const config = this.loadConfig(flags['config-path'])
      this.log(chalk.green('Successfully loaded config.toml'))

      // Step 3: Determine network type
      const {network} = dogeConfig
      if (network !== 'mainnet' && network !== 'testnet' && network !== 'regtest') {
        throw new Error(`Invalid network type in dogeConfig: '${network}'. Expected 'mainnet', 'testnet', or 'regtest'.`)
      }

      this.log(chalk.blue(`Network type: ${network}`))

      // Step 4: Setup directory structure  
      this.log(chalk.blue(`RPC package directory: ${rpcPackageDir}`))

      // Step 5: Get LoadBalancer domains
      this.log(chalk.blue('Step 1: Getting LoadBalancer domains...'))
      const loadBalancerDomains = await this.getLoadBalancerDomains(namespace)
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

      const envFilePath = this.generateL2GethEnvFile(config, dogeConfig, rpcPackageDir, loadBalancerDomains, namespace)
      this.log(chalk.green(`✓ Generated .env at: ${envFilePath}`))

      // Step 7: Extract genesis.json from genesis.yaml
      this.log(chalk.blue('Step 3: Extracting genesis.json from genesis.yaml...'))
      const genesisJsonPath = this.extractGenesisJson(flags['values-dir'], rpcPackageDir, network, dogeConfig)
      this.log(chalk.green(`✓ Extracted genesis.json at: ${genesisJsonPath}`))

      // Step 8: Generate l1-interface.env file
      this.log(chalk.blue('Step 4: Generating l1-interface.env file...'))
      const l1InterfaceEnvPath = this.generateL1InterfaceEnvFile(flags['values-dir'], rpcPackageDir, network, config)
      this.log(chalk.green(`✓ Generated l1-interface.env at: ${l1InterfaceEnvPath}`))

      this.log('')
      this.log(chalk.green('🎉 RPC package generation completed successfully!'))
      this.log('')
      this.log(chalk.blue('Generated files:'))
      this.log(chalk.cyan(`  - ${envFilePath}`))
      this.log(chalk.cyan(`  - ${genesisJsonPath}`))
      this.log(chalk.cyan(`  - ${l1InterfaceEnvPath}`))
      this.log('')
      if (Object.keys(loadBalancerDomains).length > 0) {
        this.log(chalk.green('✅ LoadBalancer domains have been automatically resolved and applied.'))
      } else {
        this.log(chalk.yellow('⚠️  LoadBalancer domains could not be automatically resolved.'))
        this.log(chalk.yellow('The generated l2geth.env contains placeholder domains that need to be replaced.'))
        this.log(chalk.yellow('Run the following command to get the actual LoadBalancer domains:'))
        this.log(chalk.cyan(`kubectl get svc -n ${namespace} | grep p2p`))
        this.log('')
        this.log(chalk.yellow('Then replace the placeholders in l2geth.env with the actual EXTERNAL-IP domains.'))
        this.error(`LoadBalancer domains generate fail`);
      }

    } catch (error) {
      this.log('')
      this.log(chalk.red('❌ RPC package generation failed:'))
      this.log(chalk.red(error instanceof Error ? error.message : String(error)))
      this.exit(1)
    }
  }

  private capitalize(str: string): string {
    if (!str) return ''
    return str.charAt(0).toUpperCase() + str.slice(1)
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

  private extractGenesisJson(valuesDir: string, rpcPackageDir: string, network: string, dogeConfig: DogeConfig): string {
    const genesisYamlPath = path.resolve(valuesDir, 'genesis.yaml')

    if (!fs.existsSync(genesisYamlPath)) {
      throw new Error(`genesis.yaml not found at: ${genesisYamlPath}`)
    }

    try {
      // Read and parse genesis.yaml
      const genesisYamlContent = fs.readFileSync(genesisYamlPath, 'utf8')
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
          throw new TypeError('Invalid genesis format in genesis.yaml - expected string or object')
        }
      } else {
        // If no 'genesis' key, assume the entire YAML is the genesis data
        genesisJson = genesisYaml
      }

      // Create target directory
      const targetDirectory = path.resolve(rpcPackageDir, 'configs', network)
      fs.mkdirSync(targetDirectory, { recursive: true })


      // Write genesis.json
      const genesisJsonPath = path.join(targetDirectory, 'l2geth-genesis.json')
      const genesisJsonContent = JSON.stringify(genesisJson, null, 2)
      fs.writeFileSync(genesisJsonPath, genesisJsonContent)

      // genesisJson for reth
      const genesisJsonForReth = JSON.parse(JSON.stringify(genesisJson));
      genesisJsonForReth.config.scroll.l1Config.startL1Block = dogeConfig.defaults?.dogecoinIndexerStartHeight;
      genesisJsonForReth.config.scroll.l1Config.systemContractAddress = genesisJsonForReth.config.systemContract.system_contract_address;
      fs.writeFileSync(path.join(targetDirectory, 'l2reth-genesis.json'), JSON.stringify(genesisJsonForReth, null, 2))

      return genesisJsonPath

    } catch (error) {
      if (error instanceof Error && error.message.includes('Failed to parse genesis')) {
        throw error
      }

      throw new Error(`Failed to extract genesis.json: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private generateL1InterfaceEnvFile(
    valuesDir: string,
    rpcPackageDir: string,
    network: string,
    _config: any,
  ): string {
    const l1InterfaceYamlPath = path.resolve(valuesDir, 'l1-interface-production.yaml')

    if (!fs.existsSync(l1InterfaceYamlPath)) {
      throw new Error(`l1-interface-production.yaml not found at: ${l1InterfaceYamlPath}`)
    }

    try {
      // Read and parse l1-interface-production.yaml
      const l1InterfaceYamlContent = fs.readFileSync(l1InterfaceYamlPath, 'utf8')
      const l1InterfaceYaml = yaml.load(l1InterfaceYamlContent) as any

      if (!l1InterfaceYaml) {
        throw new Error('Failed to parse l1-interface-production.yaml - file appears to be empty or invalid')
      }

      // Extract environment variables from configMaps.env.data
      const envData = l1InterfaceYaml.configMaps?.env?.data || {}

      // Create target directory
      const targetDirectory = path.resolve(rpcPackageDir, 'envs', network)
      fs.mkdirSync(targetDirectory, { recursive: true })

      // Generate env file path
      const envFilePath = path.join(targetDirectory, 'l1-interface.env')

      // Check if file exists and load existing content
      let existingLines: string[] = []
      const existingVars: Record<string, string> = {}
      let fileExists = false

      if (fs.existsSync(envFilePath)) {
        fileExists = true
        const existingContent = fs.readFileSync(envFilePath, 'utf8')
        existingLines = existingContent.split('\n')

        // Parse existing variables
        for (const line of existingLines) {
          const trimmedLine = line.trim()
          if (trimmedLine && !trimmedLine.startsWith('#') && trimmedLine.includes('=')) {
            const [key, ...valueParts] = trimmedLine.split('=')
            if (key && valueParts.length > 0) {
              existingVars[key.trim()] = valueParts.join('=').trim()
            }
          }
        }
      }

      // Prepare new variables to update
      const newVars: Record<string, string> = {}
      const updatedVars: string[] = []

      // Define fields that should not be updated (keep existing values)
      const excludeFields = new Set([
        'DOGEOS_L1_INTERFACE_DOGECOIN_RPC__URL',
        'DOGEOS_L1_INTERFACE_DOGECOIN_RPC__USER',
        'DOGEOS_L1_INTERFACE_DOGECOIN_RPC__PASS',
      ])

      // this token is private, keep it empty as a place holder

      // Process each environment variable from the YAML
      for (const [key, value] of Object.entries(envData)) {
        // Skip excluded fields
        if (excludeFields.has(key)) {
          continue
        }

        const newValue = String(value)
        if (existingVars[key] !== newValue) {
          newVars[key] = newValue
          updatedVars.push(key)
        }
      }

      newVars.DOGEOS_L1_INTERFACE_CELESTIA_INDEXER__DISCOVERY_MODE = "on_demand";
      newVars.DOGEOS_L1_INTERFACE_CELESTIA_INDEXER__STORE_RAW_BLOB_DATA = "true";

      // If no updates needed, return early
      if (Object.keys(newVars).length === 0) {
        this.log(chalk.green('✓ No changes detected in l1-interface.env - file is up to date'))
        return envFilePath
      }

      // Generate new content
      let newLines: string[] = []

      if (fileExists) {
        // Start with existing content
        newLines = [...existingLines]
      } else {
        // Create new file with header
        newLines.push(`# L1 Interface ${this.capitalize(network)} Configuration`, '')
      }

      // Update or add variables
      for (const [key, value] of Object.entries(newVars)) {
        let updated = false

        // Try to update existing line
        for (let i = 0; i < newLines.length; i++) {
          const line = newLines[i].trim()
          if (line.startsWith(key + '=')) {
            newLines[i] = `${key}=${value}`
            updated = true
            break
          }
        }

        // If not found, add new line
        if (!updated) {
          // Find appropriate place to insert (at the end for new variables)
          newLines.push(`${key}=${value}`)
        }
      }

      const envContent = newLines.join('\n') + '\n'
      fs.writeFileSync(envFilePath, envContent)

      // Log what was updated
      if (updatedVars.length > 0) {
        this.log(chalk.green(`✓ Updated variables in l1-interface.env: ${updatedVars.join(', ')}`))
      }

      return envFilePath

    } catch (error) {
      throw new Error(`Failed to generate l1-interface.env: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private generateL2GethEnvFile(
    config: any,
    dogeConfig: DogeConfig,
    rpcPackageDir: string,
    loadBalancerDomains: Record<string, string> = {},
    namespace: string,
  ): string[] {
    const {network} = dogeConfig
    const networkTitleCase = this.capitalize(network)
    const targetDirectory = path.resolve(rpcPackageDir, 'envs', network)
    const envFilePath = path.join(targetDirectory, 'l2geth.env')
    const envFilePathReth = path.join(targetDirectory, 'l2reth.env')

    // Create directory structure
    fs.mkdirSync(targetDirectory, { recursive: true })

    // Check if file exists and load existing content
    let existingLines: string[] = []
    const existingVars: Record<string, string> = {}
    let fileExists = false

    if (fs.existsSync(envFilePath)) {
      fileExists = true
      const existingContent = fs.readFileSync(envFilePath, 'utf8')
      existingLines = existingContent.split('\n')

      // Parse existing variables
      for (const line of existingLines) {
        const trimmedLine = line.trim()
        if (trimmedLine && !trimmedLine.startsWith('#') && trimmedLine.includes('=')) {
          const [key, ...valueParts] = trimmedLine.split('=')
          if (key && valueParts.length > 0) {
            existingVars[key.trim()] = valueParts.join('=').trim()
          }
        }
      }
    }

    // Prepare new variables to update
    const newVars: Record<string, string> = {}
    const updatedVars: string[] = []

    // Network specific settings
    if (config?.general?.CHAIN_ID_L2 !== undefined) {
      const newValue = config.general.CHAIN_ID_L2.toString()
      if (existingVars.CHAIN_ID !== newValue) {
        newVars.CHAIN_ID = newValue
        updatedVars.push('CHAIN_ID')
      }
    }

    if (dogeConfig?.defaults?.dogecoinIndexerStartHeight) {
      const newValue = dogeConfig.defaults.dogecoinIndexerStartHeight
      if (existingVars.L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK !== newValue) {
        newVars.L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK = newValue
        updatedVars.push('L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK')
      }
    }

    // Peer list
    let peerListValue: string | undefined
    if (config?.bootnode?.L2_GETH_PUBLIC_PEERS && Array.isArray(config.bootnode.L2_GETH_PUBLIC_PEERS)) {
      const externalPeers = this.convertPeersToExternalDomains(config.bootnode.L2_GETH_PUBLIC_PEERS, loadBalancerDomains)
      peerListValue = JSON.stringify(externalPeers)
    } else if (config?.sequencer?.L2_GETH_PUB_PEERS && Array.isArray(config.sequencer.L2_GETH_PUB_PEERS)) {
      const externalPeers = this.convertPeersToExternalDomains(config.sequencer.L2_GETH_PUB_PEERS, loadBalancerDomains)
      peerListValue = JSON.stringify(externalPeers)
    }

    if (peerListValue && existingVars.L2GETH_PEER_LIST !== peerListValue) {
      newVars.L2GETH_PEER_LIST = peerListValue
      updatedVars.push('L2GETH_PEER_LIST')
    }

    if (config?.sequencer?.L2GETH_SIGNER_ADDRESS) {
      newVars.L2RETH_VALID_SIGNER = config.sequencer.L2GETH_SIGNER_ADDRESS;
      updatedVars.push('L2RETH_VALID_SIGNER')
    } else {
      this.error('Missing required configuration: sequencer.L2GETH_SIGNER_ADDRESS in config.toml');
    }

    // If no updates needed, return early
    if (Object.keys(newVars).length === 0) {
      this.log(chalk.green('✓ No changes detected in l2geth.env - file is up to date'))
      return [envFilePath, envFilePathReth]
    }

    // Generate new content
    let newLines: string[] = []

    if (fileExists) {
      // Start with existing content
      newLines = [...existingLines]
    } else {
      // Create new file with header
      newLines.push(`# L2Geth ${networkTitleCase} Configuration`, `# Generated for external RPC package usage`, '', `# Network specific settings`)
    }

    // Update or add variables
    for (const [key, value] of Object.entries(newVars)) {
      let updated = false

      // Try to update existing line
      for (let i = 0; i < newLines.length; i++) {
        const line = newLines[i].trim()
        if (line.startsWith(key + '=')) {
          newLines[i] = `${key}=${value}`
          updated = true
          break
        }
      }

      // If not found, add new line
      if (!updated) {
        // Find appropriate place to insert
        let insertIndex = newLines.length

        // Try to insert after network specific settings section
        for (const [i, newLine] of newLines.entries()) {
          if (newLine.includes('# Network specific settings')) {
            insertIndex = i + 1
            break
          }
        }

        // If no section found, insert at the end
        if (insertIndex === newLines.length) {
          newLines.push('', `# ${networkTitleCase} bootnode peer list`)
        }

        newLines.splice(insertIndex, 0, `${key}=${value}`)
      }
    }

    // Add LoadBalancer domain comments if needed
    const hasRealDomains = Object.keys(loadBalancerDomains).length > 0

    for (let i = 0; i < newLines.length; i++) {
      if (newLines[i].includes('# bootnode peer list')) {
        if (hasRealDomains) {
          if (!newLines.some(line => line.includes('LoadBalancer domains have been automatically resolved'))) {
            newLines.splice(i + 1, 0, `# LoadBalancer domains have been automatically resolved`)
          }
        } else if (!newLines.some(line => line.includes('Placeholder domains need to be replaced'))) {
            newLines.splice(i + 1, 0, `# NOTE: Placeholder domains need to be replaced with actual LoadBalancer domains`)
            newLines.splice(i + 2, 0, `# Run: kubectl get svc -n ${namespace} | grep p2p`)
            newLines.splice(i + 3, 0, `# Replace <LoadBalancer-Domain-For-l2-bootnode-X> with actual EXTERNAL-IP domains`)
          }

        break
      }
    }

    const envContent = newLines.join('\n') + '\n'
    fs.writeFileSync(envFilePath, envContent)
    fs.writeFileSync(envFilePathReth, envContent)

    // Log what was updated
    if (updatedVars.length > 0) {
      this.log(chalk.green(`✓ Updated variables in l2geth.env: ${updatedVars.join(', ')}`))
    }

    return [envFilePath, envFilePathReth]
  }

  private async getLoadBalancerDomains(namespace: string): Promise<Record<string, string>> {
    try {
      const { execSync } = await import('node:child_process')

      // Run kubectl command to get LoadBalancer services
      const output = execSync(`kubectl get svc -n ${namespace} -o json`, {
        encoding: 'utf8',
        timeout: 10_000 // 10 second timeout
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
            const {hostname} = service.status.loadBalancer.ingress[0]
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

  private loadConfig(configPath: string): any {
    const resolvedPath = path.resolve(configPath)

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`config.toml not found at: ${resolvedPath}`)
    }

    try {
      const configContent = fs.readFileSync(resolvedPath, 'utf8')
      return toml.parse(configContent) as any
    } catch (error) {
      throw new Error(`Failed to parse config.toml: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
