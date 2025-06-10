import * as toml from '@iarna/toml'
import { confirm, input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'child_process'
import * as os from 'node:os'
import bitcore from 'bitcore-lib-doge'
import type { DogeConfig } from '../../types/doge-config.js'
import { loadDogeConfig, selectDogeConfigFile } from '../../utils/doge-config.js'
import { getSetupDefaultsPath, SETUP_DEFAULTS_TEMPLATE } from '../../config/constants.js'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
const { Networks, PrivateKey } = bitcore

export class DummySignersManager {
  private dogeConfig: DogeConfig
  private configPath: string
  private imageTag: string
  private log: (message: string) => void
  private warn: (message: string) => void
  private error: (message: string) => void

  constructor(
    dogeConfig: DogeConfig,
    configPath: string,
    imageTag: string,
    logger: {
      log: (message: string) => void
      warn: (message: string) => void
      error: (message: string) => void
    }
  ) {
    this.dogeConfig = dogeConfig
    this.configPath = configPath
    this.imageTag = imageTag
    this.log = logger.log
    this.warn = logger.warn
    this.error = logger.error
  }

  private validators = {
    required: (value: string) => value.length > 0 ? true : 'This field is required',
    signerCount: (value: string) => {
      const num = parseInt(value)
      return num > 0 && num <= 10 ? true : 'Please enter a number between 1 and 10'
    }
  }

  private readTsoUrlFromConfig(): string | undefined {
    try {
      const configPath = path.resolve(process.cwd(), 'config.toml')
      if (!fs.existsSync(configPath)) {
        return undefined
      }
      
      const configContent = fs.readFileSync(configPath, 'utf-8')
      const config = toml.parse(configContent) as any
      
      const tsoHost = config.ingress?.TSO_HOST;
      
      if (tsoHost && typeof tsoHost === 'string') {
        this.log(chalk.blue(`Found TSO_HOST in config.toml: ${tsoHost}`))
        return "https://" + tsoHost;
      }
      
      return undefined
    } catch (error) {
      this.warn(`Failed to read TSO_HOST from config.toml: ${error}`)
      return undefined
    }
  }

  private ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
  }

  private saveConfigToFile(config: any, filePath: string): void {
    this.ensureDirectoryExists(path.dirname(filePath))
    fs.writeFileSync(filePath, toml.stringify(config))
  }

  private async updateSetupDefaultsWithPublicKeys(publicKeys: string[], threshold: number): Promise<void> {
    if (publicKeys.length === 0) {
      this.warn('No public keys were provided');
      return;
    }

    const tomlPath = getSetupDefaultsPath();
    this.ensureDirectoryExists(path.dirname(tomlPath));

    let config: any = {};
    if (fs.existsSync(tomlPath)) {
      const tomlContent = fs.readFileSync(tomlPath, 'utf-8');
      config = toml.parse(tomlContent);
      this.log(`Loaded existing TOML config from ${tomlPath}`);
    } else {
      this.error('setup_defaults.toml not found. Please run "scrollsdk doge:config" first.')
      
    }

    config.correctness_pubkeys = publicKeys;
    
    // Update correctness_key_count
    config.correctness_key_count = publicKeys.length;
    
    // Ask user to choose correctness_threshold
    const keyCount = publicKeys.length;
    this.log(chalk.cyan(`You have configured ${keyCount} correctness keys.`));
    
    config.correctness_threshold = threshold;

    const updatedToml = toml.stringify(config);
    fs.writeFileSync(tomlPath, updatedToml);

    this.log(`✅ Updated ${tomlPath} with ${publicKeys.length} correctness public keys`);
    this.log(`Updated correctness_key_count to ${keyCount} and correctness_threshold to ${threshold}`);
    this.log(`Public keys: ${publicKeys.join(', ')}`);
  }

  private async stopAndRemoveContainers(numSigners: number): Promise<void> {
    this.log(chalk.blue('Cleaning up existing containers...'))
    for (let i = 0; i < numSigners; i++) {
      try {
        execSync(`docker stop dummy-signer-${i}`, { stdio: 'pipe' })
        this.log(`Stopped dummy-signer-${i}`)
      } catch {
        // Container might not exist, ignore
      }
      
      try {
        execSync(`docker rm dummy-signer-${i}`, { stdio: 'pipe' })
        this.log(`Removed dummy-signer-${i}`)
      } catch {
        // Container might not exist, ignore
      }
    }
  }

  private buildDockerCommand(index: number, config: any, network: string, tsoUrl: string, imageName: string): string {
    return [
      'docker run -d',
      `--name dummy-signer-${index}`,
      `-p ${config.port}:8080`,
      `-e DUMMY_SIGNER_WIF="${config.wif}"`,
      `-e DUMMY_SIGNER_NETWORK="${network}"`,
      `-e DUMMY_SIGNER_TSO_URL="${tsoUrl}"`,
      `-e PORT="8080"`,
      `-e RUST_LOG="info"`,
      `-e RUST_BACKTRACE="1"`,
      imageName
    ].join(' ')
  }

  async setupDummySigners(availableTags: string[]): Promise<void> {
    this.log(chalk.blue('\nSetting up Dummy Signers...'))
    
    const deploymentType = await select({
      message: 'How would you like to run the dummy signers?',
      choices: [
        { 
          name: 'Local (Docker) - For development/testing', 
          value: 'local',
          description: 'Run signers locally using Docker with WIF keys'
        },
        { 
          name: 'AWS (App Runner + KMS)', 
          value: 'aws',
          description: 'Deploy signers to AWS App Runner with KMS key management'
        }
      ],
      default: this.dogeConfig.deploymentType || 'local'
    })
    
    this.dogeConfig.deploymentType = deploymentType as 'local' | 'aws'
    
    if (deploymentType === 'local') {
      await this.setupLocalSigners(availableTags)
    } else {
      await this.setupAwsSigners(availableTags)
    }
  }
  
  private async getLocalImageTag(availableTags: string[]): Promise<string> {
    // For local deployment, try to use -local suffix if available
    const baseTag = this.imageTag
    
    // If the user already specified a -local tag, use it
    if (baseTag.includes('-local')) {
      return baseTag
    }
    
    // Try different -local variants
    const localVariants = [
      `${baseTag}-local`,           // shu-test-0605 → shu-test-0605-local
      baseTag.replace('-test', '-test-local'), // shu-test-0605 → shu-test-0605-local
    ]
    
    // Remove duplicates
    const uniqueVariants = [...new Set(localVariants)]
    
    for (const variant of uniqueVariants) {
      if (availableTags.includes(variant)) {
        this.log(chalk.blue(`Found local variant: ${variant}, using it instead of ${baseTag}`))
        return variant
      }
    }
    
    // If no -local variant found, use the original tag
    this.log(chalk.yellow(`No -local variant found for ${baseTag}, using original tag`))
    return baseTag
  }

  private async fetchDockerTags(): Promise<string[]> {
    try {
      const response = await fetch(
        'https://registry.hub.docker.com/v2/repositories/dogeos69/dummy-signer/tags?page_size=100',
      )
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      return data.results.map((tag: any) => tag.name)
    } catch (error) {
      this.error(`Failed to fetch Docker tags: ${error}`)
      return []
    }
  }

  private async setupLocalSigners(availableTags: string[]): Promise<void> {
    this.log(chalk.blue('\nSetting up Local Dummy Signers...'))
    
    try {
      execSync('docker info', { stdio: 'pipe' })
    } catch (error) {
      this.error('Docker is not installed or not running. Please install Docker first.')
      return
    }
    
    const NUM_SIGNERS = await input({
      message: 'Number of signers to run locally',
      default: '3',
      validate: this.validators.signerCount
    })
    
    const numSigners = parseInt(NUM_SIGNERS)
    
    // Ask user to choose correctness_threshold right after number of signers
    this.log(chalk.cyan(`You will have ${numSigners} correctness signers.`))
    
    let defaultThreshold: number
    if (numSigners === 1) {
      defaultThreshold = 1
    } else if (numSigners === 2) {
      defaultThreshold = 2
    } else {
      defaultThreshold = Math.ceil(numSigners * 2 / 3) // 2/3 majority
    }
    
    const thresholdStr = await input({
      message: chalk.cyan(`Enter correctness threshold (how many signatures required, 1-${numSigners}):`),
      default: defaultThreshold.toString(),
      validate: (value: string) => {
        const num = parseInt(value)
        if (isNaN(num) || num < 1 || num > numSigners) {
          return `Please enter a number between 1 and ${numSigners}`
        }
        return true
      }
    })
    const threshold = parseInt(thresholdStr)
    
    const TSO_URL = this.readTsoUrlFromConfig()
    if (!TSO_URL) {
      this.error('TSO_HOST not found in config.toml. Please run "scrollsdk setup domains" first.')
      return
    }
    
    const NETWORK = this.dogeConfig.network
    
    const generateWifKeys = await confirm({
      message: 'Would you like to generate new WIF keys for the signers?',
      default: true
    })
    
    const signerConfigs = await this.collectSignerConfigs(numSigners, generateWifKeys)
    
    const localImageTag = await this.getLocalImageTag(availableTags)
    const imageName = `dogeos69/dummy-signer:${localImageTag}`
    await this.pullDockerImage(imageName)
    await this.stopAndRemoveContainers(numSigners)
    await this.startSignerContainers(signerConfigs, NETWORK, TSO_URL, imageName)
    
    this.showContainerStatus(signerConfigs)
    
    this.saveLocalSignerConfig(NETWORK, signerConfigs)
    await this.updateSetupDefaultsWithLocalPublicKeys(signerConfigs, threshold)
    
    this.showSignerUrlsSummary()
    
    this.log(chalk.green('\n✅ Local dummy signers setup completed!'))
  }
  
  private async collectSignerConfigs(numSigners: number, generateWifKeys: boolean): Promise<Array<{wif: string, port: number, publicKey?: string}>> {
    const signerConfigs: Array<{wif: string, port: number, publicKey?: string}> = []
    
    // Let user choose network type if generating WIF keys
    let selectedNetwork = 'testnet'
    if (generateWifKeys) {
      selectedNetwork = await select({
        message: 'Choose network type for WIF generation',
        choices: [
          { 
            name: 'Regtest (Local development)', 
            value: 'regtest',
            description: 'Local regression test network for development'
          },
          { 
            name: 'Testnet (Public test network)', 
            value: 'testnet',
            description: 'Public Dogecoin test network'
          },
          { 
            name: 'Mainnet (Production network)', 
            value: 'mainnet',
            description: 'Production Dogecoin network'
          }
        ],
        default: 'regtest'
      })
    }
    
    for (let i = 0; i < numSigners; i++) {
      const port = 4000 + i
      
      let wif: string
      
      if (generateWifKeys) {
        wif = this.generateWIF(selectedNetwork)
        this.log(chalk.green(`Generated WIF for signer ${i}: ${wif}`))
      } else {
        wif = await input({
          message: `Enter WIF private key for signer ${i}`,
          validate: this.validators.required
        })
      }
      
      signerConfigs.push({ wif, port })
    }
    
    return signerConfigs
  }

  private generateWIF(network: string): string {
    // Use bitcore-lib-doge for consistent WIF generation
    let bitcoreNetwork
    
    if (network === 'regtest') {
      // Check if regtest is available in Networks object
      const networksObj = Networks as any
      if (networksObj.regtest) {
        bitcoreNetwork = networksObj.regtest
        this.log(chalk.blue(`Using regtest network`))
      } else {
        // Create regtest network based on testnet but with regtest version byte
        const testnetNetwork = Networks.testnet as any
        bitcoreNetwork = {
          ...testnetNetwork,
          name: 'regtest',
          privatekey: 0xef  // regtest WIF version byte
        }
        this.log(chalk.blue(`Using custom regtest network configuration`))
      }
    } else if (network === 'mainnet') {
      bitcoreNetwork = Networks.livenet
      this.log(chalk.blue(`Using mainnet network`))
    } else {
      // Default to testnet
      bitcoreNetwork = Networks.testnet
      this.log(chalk.blue(`Using testnet network`))
    }
    
    // Generate private key using bitcore with selected network
    const privateKey = new PrivateKey(null, bitcoreNetwork)
    const wif = privateKey.toWIF()
    
    this.log(chalk.blue(`Generated private key: ${privateKey.toString()}`))
    this.log(chalk.blue(`Generated WIF (${network}): ${wif}`))
    
    return wif
  }

  private async pullDockerImage(imageName: string): Promise<void> {
    this.log(chalk.blue('Pulling dummy-signer image...'))
    try {
      execSync(`docker pull ${imageName}`, { stdio: 'inherit' })
      this.log(chalk.green('Successfully pulled image'))
    } catch (error) {
      this.warn(`Warning: Could not pull image, will try to use local image: ${error}`)
    }
  }

  private async startSignerContainers(signerConfigs: any[], network: string, tsoUrl: string, imageName: string): Promise<void> {
    this.log(chalk.blue(`Starting ${signerConfigs.length} dummy signers...`))
    
    for (let i = 0; i < signerConfigs.length; i++) {
      const config = signerConfigs[i]
      const dockerCmd = this.buildDockerCommand(i, config, network, tsoUrl, imageName)
      
      try {
        const containerId = execSync(dockerCmd, { encoding: 'utf-8' }).trim()
        this.log(chalk.green(`✅ Started dummy-signer-${i} on port ${config.port} (container: ${containerId.substring(0, 12)})`))
      } catch (error) {
        this.error(`Failed to start dummy-signer-${i}: ${error}`)
      }
    }
  }

  private showContainerStatus(signerConfigs: any[]): void {
    this.log(chalk.blue('\n📊 Status Summary:'))
    try {
      const runningContainers = execSync('docker ps --filter name=dummy-signer --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"', { encoding: 'utf-8' })
      this.log(runningContainers)
    } catch (error) {
      this.warn('Could not get container status')
    }
    
    this.log(chalk.blue('\n🔍 Health check endpoints:'))
    signerConfigs.forEach((config, i) => {
      this.log(chalk.blue(`  Signer ${i}: curl http://localhost:${config.port}/health`))
    })
    
    this.log(chalk.blue('\n📋 Useful commands:'))
    this.log(chalk.blue('  View all containers: docker ps | grep dummy-signer'))
    this.log(chalk.blue('  View logs: docker logs -f dummy-signer-0'))
    this.log(chalk.blue('  Stop all: docker stop $(docker ps -q --filter name=dummy-signer)'))
  }

  private saveLocalSignerConfig(network: string, signerConfigs: any[]): void {
    if (!this.dogeConfig.localSigners) {
      this.dogeConfig.localSigners = {}
    }
    
    this.dogeConfig.localSigners = {
      network,
      signers: signerConfigs.map((config, i) => ({
        index: i,
        port: config.port,
      }))
    }
    
    // Auto-detect the best host for the current environment
    const detectedHost = this.detectOptimalHost()
    
    // Generate signer URLs with the detected host
    this.dogeConfig.signerUrls = signerConfigs.map((config, i) => 
      `http://${detectedHost}:${config.port}`
    )
    
    this.saveConfigToFile(this.dogeConfig, this.configPath)
    
    this.log(chalk.green(`\n📍 Signer URLs saved: ${this.dogeConfig.signerUrls.join(', ')}`))
    this.log(chalk.blue(`   Using detected host: ${detectedHost}`))
    
    if (detectedHost !== 'localhost') {
      this.log(chalk.yellow(`💡 Note: Make sure ports ${signerConfigs.map(c => c.port).join(', ')} are accessible from your Kubernetes cluster to ${detectedHost}`))
    }
  }
  
  private detectOptimalHost(): string {
    try {
      // Method 1: Check if we're in a Kubernetes environment and get node IP
      const k8sNodeIP = this.getKubernetesNodeIP()
      if (k8sNodeIP) {
        this.log(chalk.blue(`🔍 Detected Kubernetes node IP: ${k8sNodeIP}`))
        return k8sNodeIP
      }

      // Method 2: Get Docker bridge gateway IP (the host IP from container perspective)
      const dockerGatewayIP = this.getDockerGatewayIP()
      if (dockerGatewayIP) {
        this.log(chalk.blue(`🔍 Detected Docker gateway IP: ${dockerGatewayIP}`))
        return dockerGatewayIP
      }

      // Method 3: Get the primary network interface IP
      const hostIP = this.getHostNetworkIP()
      if (hostIP) {
        this.log(chalk.blue(`🔍 Detected host network IP: ${hostIP}`))
        return hostIP
      }

    } catch (error) {
      this.warn(`Failed to detect optimal host: ${error}`)
    }

    // Fallback to localhost
    this.log(chalk.yellow(`🔍 Using fallback: localhost`))
    return 'localhost'
  }

  private getKubernetesNodeIP(): string | null {
    try {
      // Check if kubectl is available and we can get node info
      const nodeIP = execSync('kubectl get nodes -o jsonpath="{.items[0].status.addresses[?(@.type==\'InternalIP\')].address}" 2>/dev/null', 
        { encoding: 'utf8', timeout: 3000 }).trim()
      
      if (nodeIP && this.isValidIP(nodeIP)) {
        return nodeIP
      }
    } catch (error) {
      // kubectl not available or not in K8s environment
    }
    return null
  }

  private getDockerGatewayIP(): string | null {
    try {
      // Get Docker bridge network gateway IP
      const gatewayIP = execSync('docker network inspect bridge -f "{{range .IPAM.Config}}{{.Gateway}}{{end}}" 2>/dev/null', 
        { encoding: 'utf8', timeout: 3000 }).trim()
      
      if (gatewayIP && this.isValidIP(gatewayIP)) {
        return gatewayIP
      }
    } catch (error) {
      // Docker not available
    }
    return null
  }

  private getHostNetworkIP(): string | null {
    try {
      const networkInterfaces = os.networkInterfaces()
      
      // Prefer common private network ranges in order of preference
      const preferredRanges = ['192.168.', '10.', '172.']
      
      for (const range of preferredRanges) {
        for (const [name, interfaces] of Object.entries(networkInterfaces)) {
          if (!interfaces) continue
          
          for (const iface of interfaces) {
            if (!iface.internal && 
                iface.family === 'IPv4' && 
                iface.address.startsWith(range)) {
              return iface.address
            }
          }
        }
      }
      
      // If no preferred range found, get any non-internal IPv4
      for (const [name, interfaces] of Object.entries(networkInterfaces)) {
        if (!interfaces) continue
        
        for (const iface of interfaces) {
          if (!iface.internal && iface.family === 'IPv4') {
            return iface.address
          }
        }
      }
      
    } catch (error) {
      // Network interface detection failed
    }
    return null
  }

  private isValidIP(ip: string): boolean {
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/
    if (!ipRegex.test(ip)) return false
    
    const parts = ip.split('.')
    return parts.every(part => {
      const num = parseInt(part, 10)
      return num >= 0 && num <= 255
    })
  }

  private async setupAwsSigners(availableTags: string[]): Promise<void> {
    this.log(chalk.blue('\nSetting up AWS Dummy Signers...'))
    
    // Validate that the specified image tag exists in the registry
    if (!availableTags.includes(this.imageTag)) {
      this.warn(chalk.yellow(`⚠️  Warning: Image tag '${this.imageTag}' not found in Docker registry.`))
      this.log(chalk.blue(`Available tags: ${availableTags.slice(0, 10).join(', ')}${availableTags.length > 10 ? '...' : ''}`))
      
      const proceedAnyway = await confirm({
        message: 'The specified image tag was not found in the registry. Do you want to proceed anyway?',
        default: false
      })
      
      if (!proceedAnyway) {
        this.log(chalk.yellow('AWS deployment cancelled.'))
        return
      }
    } else {
      this.log(chalk.green(`✅ Verified image tag '${this.imageTag}' exists in registry.`))
    }
    
    const AWS_REGION = await input({
      message: 'AWS_REGION',
      default: this.dogeConfig.awsSigner?.region || 'us-east-1',
      required: true,
    })
    
    const NETWORK_ALIAS = await input({
      message: 'NETWORK_ALIAS',
      default: this.dogeConfig.awsSigner?.networkAlias || 'devnet',
      required: true,
    })

    const AWS_ACCOUNT_ID = await input({
      message: 'AWS_ACCOUNT_ID',
      required: true,
      default: this.dogeConfig.awsSigner?.accountId || '',
    })

    const IMAGE_URI = `${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/dogeos/dummy-signer:latest`

    const TSO_URL = this.readTsoUrlFromConfig()
    if (!TSO_URL) {
      this.error('TSO_HOST not found in config.toml. Please run "scrollsdk setup domains" first.')
      return
    }

    const SUFFIXES = await input({
      message: `Enter suffixes for dummy signer instances (space-separated)
  Each suffix creates a complete AWS service set:
    • App Runner service: ${NETWORK_ALIAS}-dummy-signer-{suffix}
    • KMS key with alias: alias/${NETWORK_ALIAS}-dummy-signer-{suffix}-key
    • IAM role: ${NETWORK_ALIAS}-dummy-signer-{suffix}-role
  
  Examples: "00 01 02" = 3 signers, "00" = 1 signer, "a b c" = 3 signers with custom suffixes`,
      default: this.dogeConfig.awsSigner?.suffixes || '00 01 02',
      required: false,
    })
    
    const suffixes = SUFFIXES.split(' ').filter(s => s.trim())
    const numSigners = suffixes.length
    
    // Ask user to choose correctness_threshold right after suffixes
    this.log(chalk.cyan(`You will have ${numSigners} correctness signers.`))
    
    let defaultThreshold: number
    if (numSigners === 1) {
      defaultThreshold = 1
    } else if (numSigners === 2) {
      defaultThreshold = 2
    } else {
      defaultThreshold = Math.ceil(numSigners * 2 / 3) // 2/3 majority
    }
    
    const thresholdStr = await input({
      message: chalk.cyan(`Enter correctness threshold (how many signatures required, 1-${numSigners}):`),
      default: defaultThreshold.toString(),
      validate: (value: string) => {
        const num = parseInt(value)
        if (isNaN(num) || num < 1 || num > numSigners) {
          return `Please enter a number between 1 and ${numSigners}`
        }
        return true
      }
    })
    const threshold = parseInt(thresholdStr)
    
    await this.saveAwsSignerConfig({
      region: AWS_REGION,
      networkAlias: NETWORK_ALIAS,
      accountId: AWS_ACCOUNT_ID,
      suffixes: SUFFIXES
    })

    try {
      this.prepareDummyImage(AWS_REGION, AWS_ACCOUNT_ID);

      // Get project root directory from current file location
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const projectRoot = path.resolve(__dirname, '../../../');
      const scriptPath = path.join(projectRoot, 'scripts/setup_dummy_signers.sh');
      
      // Check if script exists
      if (!fs.existsSync(scriptPath)) {
        throw new Error(`Setup script not found at ${scriptPath}`);
      }
      
      this.log(chalk.blue(`Using setup script: ${scriptPath}`));
      
      // Execute the script directly with environment variables
      const cmd = `AWS_REGION=${AWS_REGION} NETWORK_ALIAS=${NETWORK_ALIAS} AWS_ACCOUNT_ID=${AWS_ACCOUNT_ID} IMAGE_URI=${IMAGE_URI} TSO_URL=${TSO_URL} SUFFIXES="${SUFFIXES}" bash ${scriptPath}`;
      
      this.log(chalk.blue('Executing AWS setup script...'));
      execSync(cmd, { stdio: 'inherit' });
      
      this.log('Setup dummy signer completed successfully!');
      
      await this.updateSetupDefaultsWithKMSPublicKeys(NETWORK_ALIAS, AWS_REGION, SUFFIXES, threshold);
      
      // Get AWS service URLs
      await this.getAwsServiceUrls(NETWORK_ALIAS, AWS_REGION, SUFFIXES);
      
      this.showSignerUrlsSummary()
      
      this.log(chalk.green('\n✅ AWS dummy signers setup completed!'))

    } catch (error) {
      this.error(`Setup failed: ${error}`);
    }
  }
  
  private async saveAwsSignerConfig(awsSignerConfig: {
    region: string
    networkAlias: string
    accountId: string
    suffixes: string
  }): Promise<void> {
    try {
      if (!this.dogeConfig.awsSigner) {
        this.dogeConfig.awsSigner = {}
      }
      
      this.dogeConfig.awsSigner = {
        ...this.dogeConfig.awsSigner,
        ...awsSignerConfig
      }
      
      const configContent = toml.stringify(this.dogeConfig as any)
      fs.writeFileSync(this.configPath, configContent)
      
      this.log(chalk.green(`AWS signer configuration saved to ${this.configPath}`))
    } catch (error) {
      this.warn(`Failed to save AWS signer config: ${error}`)
    }
  }

  private prepareDummyImage(awsRegion: string, awsAccountId: string): void {
    const repoName = 'dogeos/dummy-signer';
    const dockerHubImage = `dogeos69/dummy-signer:${this.imageTag}`;
    const ecrRegistry = `${awsAccountId}.dkr.ecr.${awsRegion}.amazonaws.com`;
    const ecrImage = `${ecrRegistry}/${repoName}:latest`;
    
    this.log('Checking prerequisites...');

    try {
      execSync('which aws', { stdio: 'pipe' });
      execSync('aws sts get-caller-identity', { stdio: 'pipe' });
    } catch (error) {
      throw new Error('AWS CLI is not installed or not configured. Please install and configure AWS CLI first.');
    }

    try {
      execSync('docker info', { stdio: 'pipe' });
    } catch (error) {
      throw new Error('Docker is not installed or not running. Please install and start Docker first.');
    }

    this.log('Checking ECR repository...');
    try {
      execSync(`aws ecr describe-repositories --repository-names ${repoName} --region ${awsRegion}`, { stdio: 'pipe' });
      this.log(`Repository ${repoName} already exists.`);
    } catch (error) {
      this.log(`Repository ${repoName} does not exist. Creating...`);
      try {
        execSync(`aws ecr create-repository --repository-name ${repoName} --region ${awsRegion}`, { stdio: 'pipe' });
        this.log(`Repository ${repoName} created successfully.`);
      } catch (createError) {
        throw new Error(`Failed to create ECR repository: ${createError}`);
      }
    }

    this.log('Logging in to ECR...');
    try {
      execSync(`aws ecr get-login-password --region ${awsRegion} | docker login --username AWS --password-stdin ${ecrRegistry}`, { stdio: 'pipe' });
      this.log('Successfully logged in to ECR.');
    } catch (error) {
      throw new Error(`Failed to log in to ECR: ${error}`);
    }

    this.log('Checking if image exists in ECR...');
    let imageExistsInECR = false;
    try {
      execSync(`aws ecr describe-images --repository-name ${repoName} --image-ids imageTag=latest --region ${awsRegion}`, { stdio: 'pipe' });
      imageExistsInECR = true;
      this.log('Image already exists in ECR.');
    } catch (error) {
      this.log('Image does not exist in ECR. Will proceed to push.');
    }

    if (!imageExistsInECR) {
      this.log('Checking local Docker images...');
      let localImageExists = false;
      try {
        const result = execSync(`docker images ${dockerHubImage} --format "{{.Repository}}:{{.Tag}}"`, { encoding: 'utf-8' });
        localImageExists = result.trim() === dockerHubImage;
      } catch (error) {
        localImageExists = false;
      }

      if (!localImageExists) {
        this.log(`Pulling ${dockerHubImage} from Docker Hub...`);
        try {
          execSync(`docker pull ${dockerHubImage}`, { stdio: 'inherit' });
        } catch (error) {
          throw new Error(`Failed to pull image from Docker Hub: ${error}`);
        }
      } else {
        this.log('Image already exists locally.');
      }

      this.log(`Tagging image for ECR...`);
      try {
        execSync(`docker tag ${dockerHubImage} ${ecrImage}`, { stdio: 'pipe' });
      } catch (error) {
        throw new Error(`Failed to tag image: ${error}`);
      }

      this.log(`Pushing image to ECR...`);
      try {
        execSync(`docker push ${ecrImage}`, { stdio: 'inherit' });
        this.log('Successfully pushed image to ECR.');
      } catch (error) {
        throw new Error(`Failed to push image to ECR: ${error}`);
      }
    }

    this.log('Verifying image in ECR...');
    try {
      execSync(`aws ecr describe-images --repository-name ${repoName} --image-ids imageTag=latest --region ${awsRegion}`, { stdio: 'pipe' });
      this.log('✅ Image successfully verified in ECR.');
    } catch (error) {
      throw new Error('Failed to verify image in ECR after push.');
    }

    this.log('Dummy signer image preparation completed successfully!');
  }

  private async updateSetupDefaultsWithKMSPublicKeys(networkAlias: string, awsRegion: string, suffixesStr: string, threshold: number): Promise<void> {
    try {
      this.log('Fetching KMS public keys...');
      
      const suffixes = suffixesStr.split(' ').filter(s => s.trim());
      const publicKeys: string[] = [];
      
      for (const suffix of suffixes) {
        const aliasName = `alias/${networkAlias}-dummy-signer-${suffix}-key`;
        
        try {
          const keyIdOutput = execSync(
            `aws kms describe-key --key-id "${aliasName}" --region ${awsRegion} --query KeyMetadata.KeyId --output text`,
            { encoding: 'utf-8' }
          ).trim();
          
          const publicKeyOutput = execSync(
            `aws kms get-public-key --key-id "${keyIdOutput}" --region ${awsRegion} --query PublicKey --output text`,
            { encoding: 'utf-8' }
          ).trim();
          
          const publicKeyHex = this.convertKMSPublicKeyToHex(publicKeyOutput);
          publicKeys.push(publicKeyHex);
          
          this.log(`✅ Got public key for ${aliasName}: ${publicKeyHex}`);
        } catch (error) {
          this.warn(`Failed to get public key for ${aliasName}: ${error}`);
        }
      }
      
      await this.updateSetupDefaultsWithPublicKeys(publicKeys, threshold);
      
    } catch (error) {
      this.error(`Failed to update setup defaults: ${error}`);
    }
  }
  
  private convertKMSPublicKeyToHex(base64PublicKey: string): string {
    const derBuffer = Buffer.from(base64PublicKey, 'base64');
    
    this.log(`DER buffer (first 100 bytes): ${derBuffer.subarray(0, 100).toString('hex')}`);
    
    let bitStringStart = -1;
    for (let i = 0; i < derBuffer.length - 2; i++) {
      if (derBuffer[i] === 0x03) {
        const length = derBuffer[i + 1];
        if (length === 0x42 || length === 0x43) {
          bitStringStart = i;
          break;
        }
      }
    }
    
    if (bitStringStart === -1) {
      for (let i = 0; i < derBuffer.length - 65; i++) {
        if (derBuffer[i] === 0x04 && i + 65 <= derBuffer.length) {
          const possibleKey = Buffer.from(derBuffer.subarray(i, i + 65));
          const x = possibleKey.subarray(1, 33);
          const y = possibleKey.subarray(33, 65);
          
          const xSum = x.reduce((a, b) => a + b, 0);
          const ySum = y.reduce((a, b) => a + b, 0);
          
          if (xSum > 0 && xSum < 255 * 32 && ySum > 0 && ySum < 255 * 32) {
            const prefix = (y[31] & 1) === 0 ? 0x02 : 0x03;
            const compressedKey = Buffer.concat([Buffer.from([prefix]), Buffer.from(x)]);
            return compressedKey.toString('hex');
          }
        }
      }
      
      throw new Error('Could not find valid public key in DER format');
    }
    
    const publicKeyStart = bitStringStart + 3;
    
    if (derBuffer[publicKeyStart] !== 0x04) {
      throw new Error('Expected uncompressed public key (0x04 prefix)');
    }
    
    const uncompressedKey = Buffer.from(derBuffer.subarray(publicKeyStart, publicKeyStart + 65));
    
    const x = uncompressedKey.subarray(1, 33);
    const y = uncompressedKey.subarray(33, 65);
    
    const prefix = (y[31] & 1) === 0 ? 0x02 : 0x03;
    
    const compressedKey = Buffer.concat([Buffer.from([prefix]), Buffer.from(x)]);
    
    return compressedKey.toString('hex');
  }

  private async updateSetupDefaultsWithLocalPublicKeys(signerConfigs: Array<{wif: string, port: number, publicKey?: string}>, threshold: number): Promise<void> {
    try {
      this.log('Fetching public keys from WIF...');
      
      const publicKeys: string[] = [];
      
      for (const config of signerConfigs) {
        const publicKey = this.extractPublicKeyFromWIF(config.wif);
        publicKeys.push(publicKey);
      }
      
      await this.updateSetupDefaultsWithPublicKeys(publicKeys, threshold);
      
    } catch (error) {
      this.error(`Failed to update setup defaults: ${error}`);
    }
  }
  
  private extractPublicKeyFromWIF(wif: string): string {
    try {
      // Use bitcore-lib-doge for consistent WIF handling
      const privateKey = PrivateKey.fromWIF(wif)
      const publicKey = privateKey.toPublicKey()
      
      // Get compressed public key in hex format
      const compressedPublicKey = publicKey.toString()
      
      this.log(chalk.blue(`Extracted public key from WIF: ${compressedPublicKey}`))
      
      return compressedPublicKey
    } catch (error) {
      throw new Error(`Failed to extract public key from WIF: ${error}`)
    }
  }

  private async getAwsServiceUrls(networkAlias: string, awsRegion: string, suffixesStr: string): Promise<void> {
    try {
      this.log('Fetching AWS App Runner service URLs...');
      
      const suffixes = suffixesStr.split(' ').filter(s => s.trim());
      const urls: string[] = [];
      
      for (const suffix of suffixes) {
        const serviceName = `${networkAlias}-dummy-signer-${suffix}`;
        
        try {
          // Get the service ARN first
          const serviceListOutput = execSync(
            `aws apprunner list-services --region ${awsRegion} --query "ServiceSummaryList[?ServiceName=='${serviceName}'].ServiceArn" --output text`,
            { encoding: 'utf-8' }
          ).trim();
          
          if (serviceListOutput) {
            // Get the service URL using the ARN
            const serviceUrlOutput = execSync(
              `aws apprunner describe-service --service-arn "${serviceListOutput}" --region ${awsRegion} --query "Service.ServiceUrl" --output text`,
              { encoding: 'utf-8' }
            ).trim();
            
            if (serviceUrlOutput && serviceUrlOutput !== 'None') {
              const fullUrl = serviceUrlOutput.startsWith('https://') ? serviceUrlOutput : `https://${serviceUrlOutput}`;
              urls.push(fullUrl);
              this.log(`✅ Got service URL for ${serviceName}: ${fullUrl}`);
            } else {
              this.warn(`Service URL not found for ${serviceName}`);
            }
          } else {
            this.warn(`Service ${serviceName} not found`);
          }
        } catch (error) {
          this.warn(`Failed to get service URL for ${serviceName}: ${error}`);
        }
      }
      
      if (urls.length > 0) {
        this.dogeConfig.signerUrls = urls;
        this.saveConfigToFile(this.dogeConfig, this.configPath);
        this.log(chalk.green(`AWS service URLs saved: ${urls.join(', ')}`));
      } else {
        this.warn('No AWS service URLs found. Services may still be deploying.');
      }
      
    } catch (error) {
      this.error(`Failed to get AWS service URLs: ${error}`);
    }
  }

  private showSignerUrlsSummary(): void {
    this.log(chalk.blue('\n📊 Signer URLs Summary:'))
    if (this.dogeConfig.signerUrls && this.dogeConfig.signerUrls.length > 0) {
      this.dogeConfig.signerUrls.forEach((url, index) => {
        this.log(chalk.blue(`  Signer ${index}: ${url}`))
      })
    } else {
      this.log(chalk.yellow('  No signer URLs found'))
    }
  }
}

// Command class for oclif CLI
export class DummySignersCommand extends Command {
  static description = 'Set up dummy signers (local Docker or AWS with KMS keys)'

  static examples = [
    '$ scrollsdk doge:dummy-signers',
    '$ scrollsdk doge:dummy-signers --config .data/doge-config-testnet.toml',
    '$ scrollsdk doge:dummy-signers --local-only',
    '$ scrollsdk doge:dummy-signers --aws-only',
    '$ scrollsdk doge:dummy-signers --image-tag shu-test-0605',
  ]

  static flags = {
    config: Flags.string({
      char: 'c',
      description: 'Path to config file (e.g., .data/doge-config-mainnet.toml or .data/doge-config-testnet.toml)',
    }),
    'local-only': Flags.boolean({
      char: 'l',
      description: 'Set up local Docker signers only',
      default: false,
    }),
    'aws-only': Flags.boolean({
      char: 'a',
      description: 'Set up AWS KMS signers only',
      default: false,
    }),
    'image-tag': Flags.string({
      description: 'Specify the Docker image tag to use',
      required: false,
    }),
  }

  private dogeConfig: DogeConfig = {} as DogeConfig
  private configPath: string = ''

  private async fetchDockerTags(): Promise<string[]> {
    try {
      const response = await fetch(
        'https://registry.hub.docker.com/v2/repositories/dogeos69/dummy-signer/tags?page_size=100',
      )
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      return data.results.map((tag: any) => tag.name)
    } catch (error) {
      this.error(`Failed to fetch Docker tags: ${error}`)
      return []
    }
  }

  private async getDockerImageTag(providedTag: string | undefined): Promise<string> {
    const defaultTag = '060925-00'

    if (!providedTag) {
      return defaultTag
    }

    const tags = await this.fetchDockerTags()

    if (tags.includes(providedTag)) {
      return providedTag
    }

    if (providedTag.startsWith('v') && tags.includes(providedTag)) {
      return providedTag
    }

    if (/^\d+\.\d+\.\d+(-test)?(-local)?$/.test(providedTag)) {
      const variants = [
        `v${providedTag}`,
        `${providedTag}-test`,
        `${providedTag}-test-local`,
        `v${providedTag}-test`,
        `v${providedTag}-test-local`
      ]
      for (const variant of variants) {
        if (tags.includes(variant)) {
          return variant
        }
      }
    }

    const selectedTag = await select({
      choices: tags.map((tag: string) => ({ name: tag, value: tag })),
      message: 'Select a Docker image tag:',
    })

    return selectedTag
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(DummySignersCommand)

    // Use the new common function to resolve config path
    try {
      this.configPath = await selectDogeConfigFile(flags.config, 'scrollsdk doge:config')
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error))
      return
    }

    // Load config
    try {
      this.dogeConfig = await loadDogeConfig(this.configPath)
      this.log(chalk.blue(`Loaded configuration for ${this.dogeConfig.network} network`))
    } catch (error) {
      this.error(`Failed to load config: ${error}`)
      return
    }

    // Validate flags
    if (flags['local-only'] && flags['aws-only']) {
      this.error('Cannot use both --local-only and --aws-only flags together')
      return
    }

    // Override deployment type if flags are specified
    if (flags['local-only']) {
      this.dogeConfig.deploymentType = 'local'
    } else if (flags['aws-only']) {
      this.dogeConfig.deploymentType = 'aws'
    }

    // Get image tag
    const imageTag = await this.getDockerImageTag(flags['image-tag'])
    this.log(chalk.blue(`Using Docker image tag: ${imageTag}`))

    // Set up dummy signers
    const dummySignersManager = new DummySignersManager(
      this.dogeConfig,
      this.configPath,
      imageTag,
      {
        log: this.log.bind(this),
        warn: this.warn.bind(this),
        error: this.error.bind(this)
      }
    )
    
    try {
      await dummySignersManager.setupDummySigners(await this.fetchDockerTags())
    } catch (error) {
      this.error(`Dummy signers setup failed: ${error}`)
    }
  }
}

// Export the command as default for oclif
export default DummySignersCommand 