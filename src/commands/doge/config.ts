import * as toml from '@iarna/toml'
import { confirm, input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'child_process'
import * as crypto from 'node:crypto'
import type { DogeConfig } from '../../types/doge-config.js'
import { loadDogeConfig } from '../../utils/doge-config.js'
import { getSetupDefaultsPath, SETUP_DEFAULTS_TEMPLATE_PATH } from '../../config/constants.js'

export class DogeConfigCommand extends Command {
  static description = 'Configure Dogecoin settings for mainnet or testnet'

  static examples = [
    '$ scrollsdk doge:config',
    '$ scrollsdk doge:config --config .data/doge-config-mainnet.toml',
    '$ scrollsdk doge:config --config .data/doge-config-testnet.toml',
    '$ scrollsdk doge:config --setup-signers-only',
    '$ scrollsdk doge:config -s --config .data/doge-config-testnet.toml',
  ]

  static flags = {
    config: Flags.string({
      char: 'c',
      description: 'Path to config file (e.g., .data/doge-config-mainnet.toml or .data/doge-config-testnet.toml)',
    }),
    'setup-signers-only': Flags.boolean({
      char: 's',
      description: 'Skip config setup and go directly to dummy signers setup',
      default: false,
    }),
  }
  
  private dogeConfig: DogeConfig = {} as DogeConfig
  private configPath: string = ''

  // Helper methods for common operations
  private async promptForInput(message: string, defaultValue?: string, validator?: (value: string) => boolean | string, required: boolean = false): Promise<string> {
    return await input({
      message,
      default: defaultValue,
      validate: validator || (() => true),
      required
    })
  }

  // Common validators
  private validators = {
    required: (value: string) => value.length > 0 ? true : 'This field is required',
    chainId: (value: string) => /^(0x[\dA-Fa-f]+|\d+)$/.test(value) ? true : 'Chain ID must be decimal or hex with 0x prefix',
    evmAddress: (value: string) => /^0x[\dA-Fa-f]{40}$/.test(value) ? true : 'EVM Address must be 20 bytes (40 hex chars) with 0x prefix',
    dogeAddress: (value: string) => /^(D[1-9A-HJ-NP-Za-km-z]{33}|[mn][1-9A-HJ-NP-Za-km-z]{33})$/.test(value) ? true : 'Invalid Dogecoin address format',
    number: (value: string) => !isNaN(Number(value)) ? true : 'Must be a valid number',
    signerCount: (value: string) => {
      const num = parseInt(value)
      return num > 0 && num <= 10 ? true : 'Please enter a number between 1 and 10'
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

  private getDefaultSetupConfig(): any {
    return {
      network: 'testnet',
      seed_string: '',
      dogecoin_rpc_url: 'https://testnet.doge.xyz',
      dogecoin_rpc_user: 'user',
      dogecoin_rpc_pass: '',
      dogecoin_blockbook_url: 'https://dogebook-testnet.nownodes.io',
      dogecoin_blockbook_api_key: '',
      sequencer_threshold: 1,
      correctness_threshold: 2,
      attestation_threshold: 2,
      recovery_threshold: 2,
      correctness_key_count: 3,
      attestation_key_count: 3,
      recovery_key_count: 3,
      timelock_seconds: 3600,
      fee_rate_sat_per_kvb: 2000000,
      deposit_eth_recipient_address_hex: '0xbb8bc29695232088b1a2dbc117e8c6006478c295',
      sequencer_target_amount: 42069000,
      fee_wallet_target_amount: 1000000000,
      bridge_target_amount: 5000000000,
      confirmations_required: 1
    }
  }

  private async updateSetupDefaultsWithPublicKeys(publicKeys: string[]): Promise<void> {
    if (publicKeys.length === 0) {
      this.warn('No public keys were provided');
      return;
    }

    const tomlPath = getSetupDefaultsPath();
    this.ensureDirectoryExists(path.dirname(tomlPath));

    // Read existing TOML file or use default config
    let config: any = {};
    if (fs.existsSync(tomlPath)) {
      const tomlContent = fs.readFileSync(tomlPath, 'utf-8');
      config = toml.parse(tomlContent);
      this.log(`Loaded existing TOML config from ${tomlPath}`);
    } else {
      config = this.getDefaultSetupConfig();
      this.log('Created new TOML config with defaults');
    }

    // Update public keys
    config.correctness_pubkeys = publicKeys;

    // Save updated config
    const updatedToml = toml.stringify(config);
    fs.writeFileSync(tomlPath, updatedToml);

    this.log(`✅ Updated ${tomlPath} with ${publicKeys.length} public keys`);
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

  async run(): Promise<void> {
    const { flags } = await this.parse(DogeConfigCommand)
    let resolvedPath = "";

    if (!flags.config) {
      if (!fs.existsSync('.data')) {
        fs.mkdirSync('.data', { recursive: true });
      }
      const files = fs.readdirSync('.data')
      const configFiles = files.filter(file => file.endsWith('.toml'))
      const configFileChoices = configFiles.map(file => ({ name: file, value: file }))

      const fileSelection = await select({
        choices: [
          ...configFileChoices,
          { name: 'Create New Config', value: 'new' as const },
        ],
        message: 'Select config file to configure:',
      })

      if (fileSelection === 'new') {
        const newConfigName = await input({
          default: "doge-config.toml",
          message: 'Enter the name of the new config file:',
        })
        resolvedPath = path.resolve('.data/' + newConfigName);
      } else {
        const configPath = path.join('.data', fileSelection)
        resolvedPath = path.resolve(configPath)
      }

    } else {
      resolvedPath = path.resolve(flags.config);
      if (!fs.existsSync(resolvedPath)) {
        this.error(`Config file ${resolvedPath} does not exist`);
        return;
      }
    }

    this.configPath = resolvedPath
    const existingConfig = await loadDogeConfig(resolvedPath)
    let newConfig = await loadDogeConfig(resolvedPath);
    this.dogeConfig = newConfig

    // Check if user wants to skip to signers setup only
    if (flags['setup-signers-only']) {
      if (!fs.existsSync(resolvedPath)) {
        this.error(`Config file ${resolvedPath} does not exist. Please run without --setup-signers-only first to create the config.`);
        return;
      }
      
      this.log(chalk.blue('Skipping config setup, going directly to dummy signers setup...'))
      await this.setupDummySigners()
      return;
    }

    newConfig.rpc!.apiKey = await input({
      default: existingConfig.rpc?.apiKey,
      message: 'Enter your NowNodes API key (get one at nownodes.io):',
      validate: (value) => (value ? true : 'API key is required'),
    })

    newConfig.defaults!.chainId = await input({
      default: existingConfig.defaults?.chainId,
      message: 'Enter the Chain ID (hex with 0x prefix or decimal):',
      validate: (value) =>
        /^(0x[\dA-Fa-f]+|\d+)$/.test(value) ? true : 'Chain ID must be decimal or hex with 0x prefix',
    })

    newConfig.defaults!.evmAddress = await input({
      default: existingConfig.defaults?.evmAddress || '0x151a64570e4997739458455ba4ab5A535FD2E306',
      message: 'Enter the EVM Address (20 bytes):',
      validate: (value) =>
        /^0x[\dA-Fa-f]{40}$/.test(value) ? true : 'EVM Address must be 20 bytes (40 hex chars) with 0x prefix',
    })

    newConfig.defaults!.recipient = await input({
      default: existingConfig.defaults?.recipient || 'nmNf4f5kyvCFrfyUBoQU3TKN3Dyc5kcMoH',
      message: `Enter the Doge recipient Address:`,
      validate: (value) =>
        /^(D[1-9A-HJ-NP-Za-km-z]{33}|[mn][1-9A-HJ-NP-Za-km-z]{33})$/.test(value)
          ? true
          : 'Invalid Dogecoin address format',
    })

    newConfig.wallet!.path = await input({
      default: existingConfig.wallet?.path,
      message: `Enter the wallet file path:`,
    })

    newConfig.rpc!.url = await input({
      default: existingConfig.rpc?.url,
      message: `Enter the dogecoin RPC URL:`,
    });

    newConfig.rpc!.username = await input({
      default: existingConfig.rpc?.username,
      message: `Enter the dogecoin RPC user:`,
    });

    newConfig.rpc!.password = await input({
      default: existingConfig.rpc?.password,
      message: `Enter the dogecoin RPC password of user (for ${existingConfig.network} network):`,
    });

    newConfig.da!.tendermintRpcUrl = await input({
      default: existingConfig.da?.tendermintRpcUrl,
      message: `Enter the Celestia Tendermint RPC URL:`,
    });
    newConfig.da!.daNamespace = await input({
      default: existingConfig.da?.daNamespace,
      message: `Enter the Celestia DA Namespace:`,
    });
    newConfig.da!.signerAddress = await input({
      default: existingConfig.da?.signerAddress,
      message: `Enter the Celestia Signer Address:`,
    });
    newConfig.da!.genesisBlobCommitment = await input({
      default: existingConfig.da?.genesisBlobCommitment,
      message: `Enter the Celestia Genesis Blob Commitment:`,
    });

    newConfig.da!.celestiaIndexerStartBlock = String(await input({
      default: String(existingConfig.da?.celestiaIndexerStartBlock || 0),
      message: `Enter the Celestia Indexer Start Block:`,
      validate: (value) => !isNaN(Number(value)) ? true : 'Must be a valid number',
    }));

    newConfig.defaults!.dogecoinIndexerStartHeight = String(await input({
      default: String(existingConfig.defaults?.dogecoinIndexerStartHeight || 4000000),
      message: `Enter the Dogecoin Indexer Start Height:`,
      validate: (value) => !isNaN(Number(value)) ? true : 'Must be a valid number',
    }));

    const configDir = path.dirname(resolvedPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fs.writeFileSync(resolvedPath, toml.stringify(newConfig as any))

    this.log(chalk.green(`\nConfiguration for ${newConfig.network} network saved to ${resolvedPath}`))
    this.log(chalk.blue('\nConfiguration Summary:'))
    this.log(chalk.blue(`Network: ${newConfig.network}`))
    this.log(chalk.blue(`RPC URL: ${newConfig.rpc!.url}`))
    this.log(chalk.blue(`Blockbook API URL: ${newConfig.rpc!.blockbookAPIUrl}`))
    this.log(chalk.blue(`Wallet Path: ${newConfig.wallet.path}`))
    this.log(chalk.blue(`Chain ID: ${newConfig.defaults!.chainId}`))
    this.log(chalk.blue(`EVM Address: ${newConfig.defaults!.evmAddress}`))
    this.log(chalk.blue(`Doge Bridge Address: ${newConfig.defaults!.recipient}`))

    await this.generateSetupDefaultsToml(newConfig)
    
    // Ask if user wants to set up Dummy Signers
    const setupDummySigners = await confirm({
      message: 'Do you want to set up Dummy Signers (local Docker or AWS with KMS keys)?',
      default: true
    })
    
    if (setupDummySigners) {
      await this.setupDummySigners()
    }
  }


  async generateSetupDefaultsToml(newDogeConfig: DogeConfig): Promise<void> {
    // Create setup_defaults.toml in user's current working directory
    const setupDefaultsPath = getSetupDefaultsPath();

    if (!fs.existsSync(setupDefaultsPath)) {
      // Ensure the target directory exists
      const targetDir = path.dirname(setupDefaultsPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const templatePath = path.resolve(currentDir, '../../../', SETUP_DEFAULTS_TEMPLATE_PATH);
      this.log(chalk.blue(`Copying template file from ${templatePath} to ${setupDefaultsPath}`));
      fs.copyFileSync(templatePath, setupDefaultsPath);
    }
    //read existing config file from user's working directory
    const existingConfigStr = fs.readFileSync(setupDefaultsPath, 'utf-8');
    let newConfig = toml.parse(existingConfigStr);

    newConfig.network = newDogeConfig.network;

    const seedString = await input({
      message: 'Enter seed string for key derivation:',
      default: String(newConfig.seed_string || ''),
      validate: (value) => value.length > 0 ? true : 'Seed string cannot be empty'
    });
    newConfig.seed_string = seedString;

    newConfig.dogecoin_rpc_url = newDogeConfig.rpc?.url || 'https://testnet.doge.xyz';
    newConfig.dogecoin_rpc_user = newDogeConfig.rpc?.username || '';
    newConfig.dogecoin_rpc_pass = newDogeConfig.rpc?.password || '';
    const blockbookUrl = newDogeConfig.rpc?.blockbookAPIUrl?.replace('/api/v2', '') || '';
    newConfig.dogecoin_blockbook_url = blockbookUrl;
    newConfig.dogecoin_blockbook_api_key = newDogeConfig.rpc?.apiKey || '';
    newConfig.deposit_eth_recipient_address_hex = newDogeConfig.defaults?.evmAddress || '';

    // Write to setup_defaults.toml
    fs.writeFileSync(setupDefaultsPath, toml.stringify(newConfig));
  }

  private async setupDummySigners(): Promise<void> {
    this.log(chalk.blue('\nSetting up Dummy Signers...'))
    
    // Ask user to choose between local or AWS deployment
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
    
    // Save deployment type preference
    this.dogeConfig.deploymentType = deploymentType
    
    if (deploymentType === 'local') {
      await this.setupLocalSigners()
    } else {
      await this.setupAwsSigners()
    }
  }
  
  private async setupLocalSigners(): Promise<void> {
    this.log(chalk.blue('\nSetting up Local Dummy Signers...'))
    
    // Check Docker availability
    try {
      execSync('docker info', { stdio: 'pipe' })
    } catch (error) {
      this.error('Docker is not installed or not running. Please install Docker first.')
    }
    
    const NUM_SIGNERS = await this.promptForInput(
      'Number of signers to run locally',
      '3',
      this.validators.signerCount
    )
    
    const TSO_URL = await this.promptForInput(
      'TSO_URL',
      this.dogeConfig.awsSigner?.tsoUrl || 'https://tso.shude.unifra.xyz',
      this.validators.required,
      true
    )
    
    const NETWORK = this.dogeConfig.network
    
    const generateWifKeys = await confirm({
      message: 'Would you like to generate new WIF keys for the signers?',
      default: true
    })
    
    const signerConfigs = await this.collectSignerConfigs(parseInt(NUM_SIGNERS), generateWifKeys)
    
    // Pull and start containers
    const imageName = 'dogeos69/dummy-signer:1.0.5-test-local'
    await this.pullDockerImage(imageName)
    await this.stopAndRemoveContainers(parseInt(NUM_SIGNERS))
    await this.startSignerContainers(signerConfigs, NETWORK, TSO_URL, imageName)
    
    // Show status and commands
    this.showContainerStatus(signerConfigs)
    
    // Save configuration
    this.saveLocalSignerConfig(TSO_URL, NETWORK, signerConfigs)
    await this.updateSetupDefaultsWithLocalPublicKeys(signerConfigs)
    
    this.log(chalk.green('\n✅ Local dummy signers setup completed!'))
  }
  
  private async collectSignerConfigs(numSigners: number, generateWifKeys: boolean): Promise<Array<{wif: string, port: number, publicKey?: string}>> {
    const signerConfigs: Array<{wif: string, port: number, publicKey?: string}> = []
    
    for (let i = 0; i < numSigners; i++) {
      const port = 8080 + i
      
      if (generateWifKeys) {
        this.log(chalk.yellow(`Note: You need to generate WIF key for signer ${i}`))
      }
      
      const wif = await this.promptForInput(
        `Enter WIF private key for signer ${i}`,
        undefined,
        this.validators.required
      )
      
      signerConfigs.push({ wif, port })
    }
    
    return signerConfigs
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

  private saveLocalSignerConfig(tsoUrl: string, network: string, signerConfigs: any[]): void {
    if (!this.dogeConfig.localSigners) {
      this.dogeConfig.localSigners = {}
    }
    
    this.dogeConfig.localSigners = {
      tsoUrl,
      network,
      signers: signerConfigs.map((config, i) => ({
        index: i,
        port: config.port,
      }))
    }
    
    this.saveConfigToFile(this.dogeConfig, this.configPath)
  }
  
  private async setupAwsSigners(): Promise<void> {
    this.log(chalk.blue('\nSetting up AWS Dummy Signers...'))
    
    // Original AWS setup code
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

    const TSO_URL = await input({
      message: 'TSO_URL',
      required: true,
      default: this.dogeConfig.awsSigner?.tsoUrl || 'https://tso.shude.unifra.xyz'
    })

    const SUFFIXES = await input({
      message: 'Suffixes for dummy signers (space-separated)',
      default: this.dogeConfig.awsSigner?.suffixes || '00 01 02',
      required: false,
    })
    
    // Save the values to config
    await this.saveAwsSignerConfig({
      region: AWS_REGION,
      networkAlias: NETWORK_ALIAS,
      accountId: AWS_ACCOUNT_ID,
      tsoUrl: TSO_URL,
      suffixes: SUFFIXES
    })

    try {
      // Prepare the dummy image first
      this.prepareDummyImage(AWS_REGION, AWS_ACCOUNT_ID);

      // Then run the setup script
      // Find script path relative to project root
      let scriptPath = path.join(process.cwd(), 'src/config/setup_dummy_signers.sh');
      
      // If running from a subdirectory, try to find the script
      if (!fs.existsSync(scriptPath)) {
        // Try parent directory
        scriptPath = path.join(process.cwd(), '../src/config/setup_dummy_signers.sh');
        if (!fs.existsSync(scriptPath)) {
          // Try from workspace root (assuming we might be in local_deploy)
          scriptPath = path.join(path.dirname(process.cwd()), 'src/config/setup_dummy_signers.sh');
        }
      }
      
      if (!fs.existsSync(scriptPath)) {
        throw new Error(`Cannot find setup_dummy_signers.sh script. Expected at: ${scriptPath}`);
      }
      
      // Ensure script has execute permissions
      try {
        fs.chmodSync(scriptPath, 0o755);
      } catch (error) {
        this.warn(`Could not set execute permissions on script: ${error}`);
      }
      
      const cmd = `AWS_REGION=${AWS_REGION} NETWORK_ALIAS=${NETWORK_ALIAS} AWS_ACCOUNT_ID=${AWS_ACCOUNT_ID} IMAGE_URI=${IMAGE_URI} TSO_URL=${TSO_URL} SUFFIXES="${SUFFIXES}" bash ${scriptPath}`;
      execSync(cmd, { stdio: 'inherit' });
      this.log('Setup dummy signer completed successfully!');
      
      // Get public keys of newly created KMS keys
      await this.updateSetupDefaultsWithKMSPublicKeys(NETWORK_ALIAS, AWS_REGION, SUFFIXES);

    } catch (error) {
      this.error(`Setup failed: ${error}`);
    }
  }
  
  private async saveAwsSignerConfig(awsSignerConfig: {
    region: string
    networkAlias: string
    accountId: string
    tsoUrl: string
    suffixes: string
  }): Promise<void> {
    try {
      // Update the dogeConfig object
      if (!this.dogeConfig.awsSigner) {
        this.dogeConfig.awsSigner = {}
      }
      
      this.dogeConfig.awsSigner = {
        ...this.dogeConfig.awsSigner,
        ...awsSignerConfig
      }
      
      // Save to file
      const configContent = toml.stringify(this.dogeConfig as any)
      fs.writeFileSync(this.configPath, configContent)
      
      this.log(chalk.green(`AWS signer configuration saved to ${this.configPath}`))
    } catch (error) {
      this.warn(`Failed to save AWS signer config: ${error}`)
    }
  }

  private prepareDummyImage(awsRegion: string, awsAccountId: string): void {
    const repoName = 'dogeos/dummy-signer';
    const dockerHubImage = 'dogeos69/dummy-signer:v1.0.5-test';
    const ecrRegistry = `${awsAccountId}.dkr.ecr.${awsRegion}.amazonaws.com`;
    const ecrImage = `${ecrRegistry}/${repoName}:latest`;
    
    // 1. Check prerequisites
    this.log('Checking prerequisites...');

    // Check AWS CLI
    try {
      execSync('which aws', { stdio: 'pipe' });
      execSync('aws sts get-caller-identity', { stdio: 'pipe' });
    } catch (error) {
      throw new Error('AWS CLI is not installed or not configured. Please install and configure AWS CLI first.');
    }

    // Check Docker
    try {
      execSync('docker info', { stdio: 'pipe' });
    } catch (error) {
      throw new Error('Docker is not installed or not running. Please install and start Docker first.');
    }

    // 2. Check if ECR repository exists, create if not
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

    // 3. Log in Docker to ECR
    this.log('Logging in to ECR...');
    try {
      execSync(`aws ecr get-login-password --region ${awsRegion} | docker login --username AWS --password-stdin ${ecrRegistry}`, { stdio: 'pipe' });
      this.log('Successfully logged in to ECR.');
    } catch (error) {
      throw new Error(`Failed to log in to ECR: ${error}`);
    }

    // 4. Check if image already exists in ECR
    this.log('Checking if image exists in ECR...');
    let imageExistsInECR = false;
    try {
      execSync(`aws ecr describe-images --repository-name ${repoName} --image-ids imageTag=latest --region ${awsRegion}`, { stdio: 'pipe' });
      imageExistsInECR = true;
      this.log('Image already exists in ECR.');
    } catch (error) {
      this.log('Image does not exist in ECR. Will proceed to push.');
    }

    // 5. If ECR image doesn't exist
    if (!imageExistsInECR) {
      // 5a. Check if local image exists
      this.log('Checking local Docker images...');
      let localImageExists = false;
      try {
        const result = execSync(`docker images ${dockerHubImage} --format "{{.Repository}}:{{.Tag}}"`, { encoding: 'utf-8' });
        localImageExists = result.trim() === dockerHubImage;
      } catch (error) {
        localImageExists = false;
      }

      // 5b. If not exists locally, pull from Docker Hub
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

      // 5c. Tag for ECR
      this.log(`Tagging image for ECR...`);
      try {
        execSync(`docker tag ${dockerHubImage} ${ecrImage}`, { stdio: 'pipe' });
      } catch (error) {
        throw new Error(`Failed to tag image: ${error}`);
      }

      // 5d. Push to ECR
      this.log(`Pushing image to ECR...`);
      try {
        execSync(`docker push ${ecrImage}`, { stdio: 'inherit' });
        this.log('Successfully pushed image to ECR.');
      } catch (error) {
        throw new Error(`Failed to push image to ECR: ${error}`);
      }
    }

    // 6. Verify image exists in ECR
    this.log('Verifying image in ECR...');
    try {
      execSync(`aws ecr describe-images --repository-name ${repoName} --image-ids imageTag=latest --region ${awsRegion}`, { stdio: 'pipe' });
      this.log('✅ Image successfully verified in ECR.');
    } catch (error) {
      throw new Error('Failed to verify image in ECR after push.');
    }

    this.log('Dummy signer image preparation completed successfully!');
  }

  private async updateSetupDefaultsWithKMSPublicKeys(networkAlias: string, awsRegion: string, suffixesStr: string): Promise<void> {
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
      
      await this.updateSetupDefaultsWithPublicKeys(publicKeys);
      
    } catch (error) {
      this.error(`Failed to update setup defaults: ${error}`);
    }
  }
  
  private convertKMSPublicKeyToHex(base64PublicKey: string): string {
    // Decode base64
    const derBuffer = Buffer.from(base64PublicKey, 'base64');
    
    // Debug: log the DER buffer in hex
    this.log(`DER buffer (first 100 bytes): ${derBuffer.subarray(0, 100).toString('hex')}`);
    
    // AWS KMS returns DER-encoded public key
    // Structure:
    // SEQUENCE {
    //   SEQUENCE {
    //     OBJECT IDENTIFIER (ecPublicKey)
    //     OBJECT IDENTIFIER (secp256k1)
    //   }
    //   BIT STRING (public key)
    // }
    
    // Look for BIT STRING tag (0x03) which contains the public key
    let bitStringStart = -1;
    for (let i = 0; i < derBuffer.length - 2; i++) {
      // BIT STRING tag is 0x03
      if (derBuffer[i] === 0x03) {
        // Check if this looks like a valid BIT STRING containing a public key
        const length = derBuffer[i + 1];
        if (length === 0x42 || length === 0x43) { // 66 or 67 bytes (65 byte key + padding)
          bitStringStart = i;
          break;
        }
      }
    }
    
    if (bitStringStart === -1) {
      // Alternative: look for the uncompressed public key directly
      for (let i = 0; i < derBuffer.length - 65; i++) {
        if (derBuffer[i] === 0x04 && i + 65 <= derBuffer.length) {
          // Check if this looks like a valid public key
          // The next 64 bytes should be the x and y coordinates
          const possibleKey = Buffer.from(derBuffer.subarray(i, i + 65));
          // Basic validation: x and y should not be all zeros or all 0xFF
          const x = possibleKey.subarray(1, 33);
          const y = possibleKey.subarray(33, 65);
          
          const xSum = x.reduce((a, b) => a + b, 0);
          const ySum = y.reduce((a, b) => a + b, 0);
          
          if (xSum > 0 && xSum < 255 * 32 && ySum > 0 && ySum < 255 * 32) {
            // This looks like a valid public key
            // Convert to compressed format
            const prefix = (y[31] & 1) === 0 ? 0x02 : 0x03;
            const compressedKey = Buffer.concat([Buffer.from([prefix]), Buffer.from(x)]);
            return compressedKey.toString('hex');
          }
        }
      }
      
      throw new Error('Could not find valid public key in DER format');
    }
    
    // Extract public key from BIT STRING
    // Skip BIT STRING tag (1 byte), length (1 byte), and padding indicator (1 byte)
    const publicKeyStart = bitStringStart + 3;
    
    if (derBuffer[publicKeyStart] !== 0x04) {
      throw new Error('Expected uncompressed public key (0x04 prefix)');
    }
    
    // Extract the 65-byte uncompressed public key
    const uncompressedKey = Buffer.from(derBuffer.subarray(publicKeyStart, publicKeyStart + 65));
    
    // Convert to compressed format
    const x = uncompressedKey.subarray(1, 33);
    const y = uncompressedKey.subarray(33, 65);
    
    // Check parity of y coordinate
    const prefix = (y[31] & 1) === 0 ? 0x02 : 0x03;
    
    // Build compressed public key
    const compressedKey = Buffer.concat([Buffer.from([prefix]), Buffer.from(x)]);
    
    return compressedKey.toString('hex');
  }

  private async updateSetupDefaultsWithLocalPublicKeys(signerConfigs: Array<{wif: string, port: number, publicKey?: string}>): Promise<void> {
    try {
      this.log('Fetching public keys from WIF...');
      
      const publicKeys: string[] = [];
      
      for (const config of signerConfigs) {
        const publicKey = this.extractPublicKeyFromWIF(config.wif);
        publicKeys.push(publicKey);
      }
      
      await this.updateSetupDefaultsWithPublicKeys(publicKeys);
      
    } catch (error) {
      this.error(`Failed to update setup defaults: ${error}`);
    }
  }
  
  private extractPublicKeyFromWIF(wif: string): string {
    try {
      // Base58 alphabet
      const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      
      // Decode WIF from base58
      const decoded = this.base58Decode(wif, base58Alphabet);
      
      // WIF structure:
      // [version_byte][32_byte_private_key][compression_flag?][4_byte_checksum]
      
      // Verify minimum length (37 bytes for uncompressed, 38 for compressed)
      if (decoded.length < 37) {
        throw new Error('Invalid WIF length');
      }
      
      // Extract checksum and verify
      const payload = Buffer.from(decoded.subarray(0, -4));
      const checksum = Buffer.from(decoded.subarray(-4));
      const hash1 = crypto.createHash('sha256').update(payload).digest();
      const hash2 = crypto.createHash('sha256').update(hash1).digest();
      const expectedChecksum = Buffer.from(hash2.subarray(0, 4));
      
      if (!checksum.equals(expectedChecksum)) {
        throw new Error('Invalid WIF checksum');
      }
      
      // Extract private key (skip version byte)
      const privateKey = Buffer.from(payload.subarray(1, 33));
      
      // Check compression flag
      const isCompressed = payload.length === 34; // version + 32 bytes private key + 1 byte compression flag
      
      // Generate public key from private key using secp256k1
      const publicKey = this.generatePublicKeyFromPrivate(privateKey, isCompressed);
      
      return publicKey;
    } catch (error) {
      throw new Error(`Failed to extract public key from WIF: ${error}`);
    }
  }
  
  private base58Decode(input: string, alphabet: string): Buffer {
    const base = alphabet.length;
    let decoded = BigInt(0);
    let multi = BigInt(1);
    
    // Decode from base58
    for (let i = input.length - 1; i >= 0; i--) {
      const char = input[i];
      const index = alphabet.indexOf(char);
      if (index === -1) {
        throw new Error(`Invalid character in base58 string: ${char}`);
      }
      decoded += BigInt(index) * multi;
      multi *= BigInt(base);
    }
    
    // Convert to buffer
    const hex = decoded.toString(16);
    const paddedHex = hex.length % 2 === 0 ? hex : '0' + hex;
    let buffer = Buffer.from(paddedHex, 'hex');
    
    // Handle leading zeros
    for (let i = 0; i < input.length && input[i] === alphabet[0]; i++) {
      buffer = Buffer.concat([Buffer.from([0]), buffer]);
    }
    
    return buffer;
  }
  
  private generatePublicKeyFromPrivate(privateKey: Buffer, compressed: boolean = true): string {
    try {
      // Create ECDH object with secp256k1 curve
      const ecdh = crypto.createECDH('secp256k1');
      ecdh.setPrivateKey(privateKey);
      
      // Get public key
      const publicKey = ecdh.getPublicKey();
      
      if (compressed) {
        // Return compressed format (33 bytes)
        const x = Buffer.from(publicKey.subarray(1, 33));
        const y = Buffer.from(publicKey.subarray(33, 65));
        const prefix = (y[31] & 1) === 0 ? 0x02 : 0x03;
        const compressedKey = Buffer.concat([Buffer.from([prefix]), x]);
        return compressedKey.toString('hex');
      } else {
        // Return uncompressed format (65 bytes)
        return publicKey.toString('hex');
      }
    } catch (error) {
      throw new Error(`Failed to generate public key: ${error}`);
    }
  }
}

export default DogeConfigCommand
