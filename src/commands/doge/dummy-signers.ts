/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic TOML config operations */
import * as toml from '@iarna/toml'
import { confirm, input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import bitcore from 'bitcore-lib-doge'
import chalk from 'chalk'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import * as os from 'node:os'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { DogeConfig } from '../../types/doge-config.js'

import { getSetupDefaultsPath } from '../../config/constants.js'
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import { resolveEnvValue } from '../../utils/non-interactive.js'
const { Networks, PrivateKey } = bitcore
const defaultTag = '0.2.0-rc.7'

export interface NonInteractiveOptions {
  awsAccountId?: string
  awsNetworkAlias?: string
  awsRegion?: string
  awsSuffixes?: string
  generateWifKeys?: boolean
  numSigners?: number
  threshold?: number
  wifNetwork?: 'mainnet' | 'regtest' | 'testnet'
}

export class DummySignersManager {
  private _error: (message: string) => void
  private _log: (message: string) => void
  private _warn: (message: string) => void
  private configPath: string
  private dogeConfig: DogeConfig
  private imageTag: string
  private jsonCtx?: JsonOutputContext
  private jsonMode: boolean
  private nonInteractive: boolean
  private nonInteractiveOptions: NonInteractiveOptions

  private validators = {
    required: (value: string) => value.length > 0 ? true : 'This field is required',
    signerCount(value: string) {
      const num = Number.parseInt(value, 10)
      return num > 0 && num <= 10 ? true : 'Please enter a number between 1 and 10'
    }
  }

  constructor(
    dogeConfig: DogeConfig,
    configPath: string,
    imageTag: string,
    logger: {
      error: (message: string) => void
      log: (message: string) => void
      warn: (message: string) => void
    },
    nonInteractive: boolean = false,
    nonInteractiveOptions: NonInteractiveOptions = {},
    jsonMode: boolean = false,
    jsonCtx?: JsonOutputContext
  ) {
    this.dogeConfig = dogeConfig
    this.configPath = configPath
    this.imageTag = imageTag
    this._log = logger.log
    this._warn = logger.warn
    this._error = logger.error
    this.nonInteractive = nonInteractive
    this.nonInteractiveOptions = nonInteractiveOptions
    this.jsonMode = jsonMode
    this.jsonCtx = jsonCtx
  }

  async setupDummySigners(availableTags: string[]): Promise<void> {
    this.log(chalk.blue('\nSetting up Dummy Signers...'))

    let deploymentType: string
    if (this.nonInteractive) {
      // In non-interactive mode, use existing deploymentType from config or default to 'local'
      deploymentType = this.dogeConfig.deploymentType || 'local'
      this.log(chalk.blue(`Non-interactive mode: Using deployment type '${deploymentType}'`))
    } else {
      deploymentType = await select({
        choices: [
          {
            description: 'Run signers locally using Docker with WIF keys',
            name: 'Local (Docker) - For development/testing',
            value: 'local'
          },
          {
            description: 'Deploy signers to AWS App Runner with KMS key management',
            name: 'AWS (App Runner + KMS)',
            value: 'aws'
          }
        ],
        default: this.dogeConfig.deploymentType || 'local',
        message: 'How would you like to run the dummy signers?'
      })
    }

    this.dogeConfig.deploymentType = deploymentType as 'aws' | 'local'

    await (deploymentType === 'local' ? this.setupLocalSigners(availableTags) : this.setupAwsSigners(availableTags));
  }

  private buildDockerArgs(index: number, config: any, network: string, tsoUrl: string, imageName: string): string[] {
    return [
      'run', '-d',
      '--name', `dummy-signer-${index}`,
      '-p', `${config.port}:8080`,
      '-e', `DUMMY_SIGNER_WIF=${config.wif}`,
      '-e', `DUMMY_SIGNER_NETWORK=${network}`,
      '-e', `DUMMY_SIGNER_TSO_URL=${tsoUrl}`,
      '-e', 'PORT=8080',
      '-e', 'RUST_LOG=info',
      '-e', 'RUST_BACKTRACE=1',
      imageName
    ]
  }

  private async collectSignerConfigs(numSigners: number, generateWifKeys: boolean): Promise<Array<{ port: number, publicKey?: string, wif: string }>> {
    const signerConfigs: Array<{ port: number, publicKey?: string, wif: string }> = []

    // Let user choose network type if generating WIF keys
    let selectedNetwork = 'testnet'
    if (generateWifKeys) {
      if (this.nonInteractive) {
        selectedNetwork = this.nonInteractiveOptions.wifNetwork || 'regtest'
        this.log(chalk.blue(`Non-interactive mode: Using WIF network '${selectedNetwork}'`))
      } else {
        selectedNetwork = await select({
          choices: [
            {
              description: 'Local regression test network for development',
              name: 'Regtest (Local development)',
              value: 'regtest'
            },
            {
              description: 'Public Dogecoin test network',
              name: 'Testnet (Public test network)',
              value: 'testnet'
            },
            {
              description: 'Production Dogecoin network',
              name: 'Mainnet (Production network)',
              value: 'mainnet'
            }
          ],
          default: 'regtest',
          message: 'Choose network type for WIF generation'
        })
      }
    }

    for (let i = 0; i < numSigners; i++) {
      const port = 4000 + i

      let wif: string

      if (generateWifKeys) {
        wif = this.generateWIF(selectedNetwork)
        this.log(chalk.green(`Generated WIF for signer ${i}: ${wif}`))
      } else if (this.nonInteractive) {
          this.error(`WIF key for signer ${i} required when not generating keys in non-interactive mode`)
          wif = '' // Will fail but we need to continue for type safety
        } else {
          wif = await input({
            message: `Enter WIF private key for signer ${i}`,
            validate: this.validators.required
          })
        }

      signerConfigs.push({ port, wif })
    }

    return signerConfigs
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
            // eslint-disable-next-line no-bitwise
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

    // eslint-disable-next-line no-bitwise
    const prefix = (y[31] & 1) === 0 ? 0x02 : 0x03;

    const compressedKey = Buffer.concat([Buffer.from([prefix]), Buffer.from(x)]);

    return compressedKey.toString('hex');
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

  private ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
  }

  private error(message: string): void {
    if (this.jsonMode && this.jsonCtx) {
      // For errors, we still need to throw/exit, so use the original error
      // but also log to stderr
      console.error(message)
    }

    this._error(message)
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

  private async getAwsServiceUrls(networkAlias: string, awsRegion: string, suffixesStr: string): Promise<void> {
    try {
      this.log('Fetching AWS App Runner service URLs...');

      const suffixes = suffixesStr.split(' ').filter(s => s.trim());
      const urls: string[] = [];

      for (const suffix of suffixes) {
        const serviceName = `${networkAlias}-dummy-signer-${suffix}`;

        try {
          // Get the service ARN first
          const serviceListOutput = execFileSync('aws', [
            'apprunner', 'list-services',
            '--region', awsRegion,
            '--query', `ServiceSummaryList[?ServiceName=='${serviceName}'].ServiceArn`,
            '--output', 'text'
          ], { encoding: 'utf8' }).trim();

          if (serviceListOutput) {
            // Get the service URL using the ARN
            const serviceUrlOutput = execFileSync('aws', [
              'apprunner', 'describe-service',
              '--service-arn', serviceListOutput,
              '--region', awsRegion,
              '--query', 'Service.ServiceUrl',
              '--output', 'text'
            ], { encoding: 'utf8' }).trim();

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

  private getDockerGatewayIP(): null | string {
    try {
      // Get Docker bridge network gateway IP
      const gatewayIP = execFileSync('docker', [
        'network', 'inspect', 'bridge',
        '-f', '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
      ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 }).trim()

      if (gatewayIP && this.isValidIP(gatewayIP)) {
        return gatewayIP
      }
    } catch {
      // Docker not available
    }

    return null
  }

  private getHostNetworkIP(): null | string {
    try {
      const networkInterfaces = os.networkInterfaces()

      // Prefer common private network ranges in order of preference
      const preferredRanges = ['192.168.', '10.', '172.']

      for (const range of preferredRanges) {
        for (const interfaces of Object.values(networkInterfaces)) {
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
      for (const interfaces of Object.values(networkInterfaces)) {
        if (!interfaces) continue

        for (const iface of interfaces) {
          if (!iface.internal && iface.family === 'IPv4') {
            return iface.address
          }
        }
      }

    } catch {
      // Network interface detection failed
    }

    return null
  }

  private getKubernetesNodeIP(): null | string {
    try {
      // Check if kubectl is available and we can get node info
      const nodeIP = execFileSync('kubectl', [
        'get', 'nodes',
        '-o', 'jsonpath={.items[0].status.addresses[?(@.type==\'InternalIP\')].address}'
      ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 }).trim()

      if (nodeIP && this.isValidIP(nodeIP)) {
        return nodeIP
      }
    } catch {
      // kubectl not available or not in K8s environment
    }

    return null
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

  private isValidIP(ip: string): boolean {
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/
    if (!ipRegex.test(ip)) return false

    const parts = ip.split('.')
    return parts.every(part => {
      const num = Number.parseInt(part, 10)
      return num >= 0 && num <= 255
    })
  }

  // JSON-aware logging methods - route to stderr in JSON mode
  private log(message: string): void {
    if (this.jsonMode && this.jsonCtx) {
      this.jsonCtx.info(message)
    } else {
      this._log(message)
    }
  }

  private prepareDummyImage(awsRegion: string, awsAccountId: string): void {
    const repoName = 'dogeos/dummy-signer';
    const dockerHubImage = `dogeos69/dummy-signer:${this.imageTag}`;
    const ecrRegistry = `${awsAccountId}.dkr.ecr.${awsRegion}.amazonaws.com`;
    const ecrImage = `${ecrRegistry}/${repoName}:latest`;

    this.log('Checking prerequisites...');

    try {
      execFileSync('which', ['aws'], { stdio: 'pipe' });
      execFileSync('aws', ['sts', 'get-caller-identity'], { stdio: 'pipe' });
    } catch {
      throw new Error('AWS CLI is not installed or not configured. Please install and configure AWS CLI first.');
    }

    try {
      execFileSync('docker', ['info'], { stdio: 'pipe' });
    } catch {
      throw new Error('Docker is not installed or not running. Please install and start Docker first.');
    }

    this.log('Checking ECR repository...');
    try {
      execFileSync('aws', ['ecr', 'describe-repositories', '--repository-names', repoName, '--region', awsRegion], { stdio: 'pipe' });
      this.log(`Repository ${repoName} already exists.`);
    } catch {
      this.log(`Repository ${repoName} does not exist. Creating...`);
      try {
        execFileSync('aws', ['ecr', 'create-repository', '--repository-name', repoName, '--region', awsRegion], { stdio: 'pipe' });
        this.log(`Repository ${repoName} created successfully.`);
      } catch (createError) {
        throw new Error(`Failed to create ECR repository: ${createError}`);
      }
    }

    this.log('Logging in to ECR...');
    try {
      const loginPassword = execFileSync('aws', ['ecr', 'get-login-password', '--region', awsRegion], { encoding: 'utf8' }).trim();
      const child = spawnSync('docker', ['login', '--username', 'AWS', '--password-stdin', ecrRegistry], {
        input: loginPassword,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (child.status !== 0) {
        throw new Error(child.stderr?.toString() || 'docker login failed');
      }

      this.log('Successfully logged in to ECR.');
    } catch (error) {
      throw new Error(`Failed to log in to ECR: ${error}`);
    }

    this.log('Checking if image exists in ECR...');
    let imageExistsInECR = false;
    try {
      execFileSync('aws', ['ecr', 'describe-images', '--repository-name', repoName, '--image-ids', 'imageTag=latest', '--region', awsRegion], { stdio: 'pipe' });
      imageExistsInECR = true;
      this.log('Image already exists in ECR.');
    } catch {
      this.log('Image does not exist in ECR. Will proceed to push.');
    }

    if (!imageExistsInECR) {
      this.log('Checking local Docker images...');
      let localImageExists = false;
      try {
        const result = execFileSync('docker', ['images', dockerHubImage, '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' });
        localImageExists = result.trim() === dockerHubImage;
      } catch {
        localImageExists = false;
      }

      if (localImageExists) {
        this.log('Image already exists locally.');
      } else {
        this.log(`Pulling ${dockerHubImage} from Docker Hub...`);
        try {
          execFileSync('docker', ['pull', dockerHubImage], { stdio: 'inherit' });
        } catch (error) {
          throw new Error(`Failed to pull image from Docker Hub: ${error}`);
        }
      }

      this.log(`Tagging image for ECR...`);
      try {
        execFileSync('docker', ['tag', dockerHubImage, ecrImage], { stdio: 'pipe' });
      } catch (error) {
        throw new Error(`Failed to tag image: ${error}`);
      }

      this.log(`Pushing image to ECR...`);
      try {
        execFileSync('docker', ['push', ecrImage], { stdio: 'inherit' });
        this.log('Successfully pushed image to ECR.');
      } catch (error) {
        throw new Error(`Failed to push image to ECR: ${error}`);
      }
    }

    this.log('Verifying image in ECR...');
    try {
      execFileSync('aws', ['ecr', 'describe-images', '--repository-name', repoName, '--image-ids', 'imageTag=latest', '--region', awsRegion], { stdio: 'pipe' });
      this.log('Image successfully verified in ECR.');
    } catch {
      throw new Error('Failed to verify image in ECR after push.');
    }

    this.log('Dummy signer image preparation completed successfully!');
  }

  private async pullDockerImage(imageName: string): Promise<void> {
    this.log(chalk.blue('Pulling dummy-signer image...'))
    try {
      execFileSync('docker', ['pull', imageName], { stdio: 'inherit' })
      this.log(chalk.green('Successfully pulled image'))
    } catch (pullError) {
      this.warn(`Warning: Could not pull image: ${pullError}`)
      // Verify local image exists before proceeding
      try {
        execFileSync('docker', ['image', 'inspect', imageName], { stdio: 'pipe' })
        this.log(chalk.yellow('Using existing local image'))
      } catch {
        throw new Error(`Image ${imageName} not available: pull failed and image not found locally`)
      }
    }
  }

  private readTsoUrlFromConfig(): string | undefined {
    try {
      const configPath = path.resolve(process.cwd(), 'config.toml')
      if (!fs.existsSync(configPath)) {
        return undefined
      }

      const configContent = fs.readFileSync(configPath, 'utf8')
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

  private async saveAwsSignerConfig(awsSignerConfig: {
    accountId: string
    networkAlias: string
    region: string
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

  private saveConfigToFile(config: any, filePath: string): void {
    this.ensureDirectoryExists(path.dirname(filePath))
    fs.writeFileSync(filePath, toml.stringify(config))
  }

  private saveLocalSignerConfig(network: string, signerConfigs: any[]): void {
    if (!this.dogeConfig.localSigners) {
      this.dogeConfig.localSigners = {}
    }

    this.dogeConfig.localSigners = {
      network,
      signers: signerConfigs.map((config, _i) => ({
        index: _i,
        port: config.port,
      }))
    }

    // Auto-detect the best host for the current environment
    const detectedHost = this.detectOptimalHost()

    // Generate signer URLs with the detected host
    this.dogeConfig.signerUrls = signerConfigs.map((config) =>
      `http://${detectedHost}:${config.port}`
    )

    this.saveConfigToFile(this.dogeConfig, this.configPath)

    this.log(chalk.green(`\n📍 Signer URLs saved: ${this.dogeConfig.signerUrls.join(', ')}`))
    this.log(chalk.blue(`   Using detected host: ${detectedHost}`))

    if (detectedHost !== 'localhost') {
      this.log(chalk.yellow(`💡 Note: Make sure ports ${signerConfigs.map(c => c.port).join(', ')} are accessible from your Kubernetes cluster to ${detectedHost}`))
    }
  }

  private async setupAwsSigners(availableTags: string[]): Promise<void> {
    this.log(chalk.blue('\nSetting up AWS Dummy Signers...'))

    // Validate that the specified image tag exists in the registry
    if (availableTags.includes(this.imageTag)) {
      this.log(chalk.green(`✅ Verified image tag '${this.imageTag}' exists in registry.`))
    } else {
      this.warn(chalk.yellow(`⚠️  Warning: Image tag '${this.imageTag}' not found in Docker registry.`))
      this.log(chalk.blue(`Available tags: ${availableTags.slice(0, 10).join(', ')}${availableTags.length > 10 ? '...' : ''}`))

      if (this.nonInteractive) {
        this.warn(chalk.yellow('Non-interactive mode: Proceeding with unverified image tag'))
      } else {
        const proceedAnyway = await confirm({
          default: false,
          message: 'The specified image tag was not found in the registry. Do you want to proceed anyway?'
        })

        if (!proceedAnyway) {
          this.log(chalk.yellow('AWS deployment cancelled.'))
          return
        }
      }
    }

    let AWS_REGION: string
    let NETWORK_ALIAS: string
    let AWS_ACCOUNT_ID: string
    let SUFFIXES: string

    if (this.nonInteractive) {
      AWS_REGION = this.nonInteractiveOptions.awsRegion || this.dogeConfig.awsSigner?.region || 'us-east-1'
      NETWORK_ALIAS = this.nonInteractiveOptions.awsNetworkAlias || this.dogeConfig.awsSigner?.networkAlias || 'devnet'
      AWS_ACCOUNT_ID = this.nonInteractiveOptions.awsAccountId || this.dogeConfig.awsSigner?.accountId || ''
      SUFFIXES = this.nonInteractiveOptions.awsSuffixes || this.dogeConfig.awsSigner?.suffixes || '00 01 02'

      if (!AWS_ACCOUNT_ID) {
        this.error('AWS_ACCOUNT_ID is required for AWS deployment in non-interactive mode. Use --aws-account-id flag.')
        return
      }

      this.log(chalk.blue(`Non-interactive mode: AWS_REGION=${AWS_REGION}, NETWORK_ALIAS=${NETWORK_ALIAS}, AWS_ACCOUNT_ID=${AWS_ACCOUNT_ID}, SUFFIXES=${SUFFIXES}`))
    } else {
      AWS_REGION = await input({
        default: this.dogeConfig.awsSigner?.region || 'us-east-1',
        message: 'AWS_REGION',
        required: true,
      })

      NETWORK_ALIAS = await input({
        default: this.dogeConfig.awsSigner?.networkAlias || 'devnet',
        message: 'NETWORK_ALIAS',
        required: true,
      })

      AWS_ACCOUNT_ID = await input({
        default: this.dogeConfig.awsSigner?.accountId || '',
        message: 'AWS_ACCOUNT_ID',
        required: true,
      })

      SUFFIXES = await input({
        default: this.dogeConfig.awsSigner?.suffixes || '00',
        message: `Enter suffixes for dummy signer instances (space-separated)
  Each suffix creates a complete AWS service set:
    • App Runner service: ${NETWORK_ALIAS}-dummy-signer-{suffix}
    • KMS key with alias: alias/${NETWORK_ALIAS}-dummy-signer-{suffix}-key
    • IAM role: ${NETWORK_ALIAS}-dummy-signer-{suffix}-role

  Examples: "00 01 02" = 3 signers, "00" = 1 signer, "a b c" = 3 signers with custom suffixes`,
        required: false,
      })
    }

    const IMAGE_URI = `${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/dogeos/dummy-signer:latest`

    const TSO_URL = this.readTsoUrlFromConfig()
    if (!TSO_URL) {
      this.error('TSO_HOST not found in config.toml. Please run "scrollsdk setup domains" first.')
      return
    }

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

    let threshold: number
    if (this.nonInteractive) {
      threshold = this.nonInteractiveOptions.threshold || defaultThreshold
      this.log(chalk.blue(`Non-interactive mode: Using threshold ${threshold}`))
    } else {
      const thresholdStr = await input({
        default: defaultThreshold.toString(),
        message: chalk.cyan(`Enter correctness threshold (how many signatures required, 1-${numSigners}):`),
        validate(value: string) {
          const num = Number.parseInt(value, 10)
          if (Number.isNaN(num) || num < 1 || num > numSigners) {
            return `Please enter a number between 1 and ${numSigners}`
          }

          return true
        }
      })
      threshold = Number.parseInt(thresholdStr, 10)
    }

    await this.saveAwsSignerConfig({
      accountId: AWS_ACCOUNT_ID,
      networkAlias: NETWORK_ALIAS,
      region: AWS_REGION,
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

      // Execute the script with environment variables passed via env option (avoids shell injection)
      this.log(chalk.blue('Executing AWS setup script...'));
      execFileSync('bash', [scriptPath], {
        env: { ...process.env, AWS_ACCOUNT_ID, AWS_REGION, IMAGE_URI, NETWORK_ALIAS, SUFFIXES, TSO_URL },
        stdio: 'inherit',
      });

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

  private async setupLocalSigners(availableTags: string[]): Promise<void> {
    this.log(chalk.blue('\nSetting up Local Dummy Signers...'))

    try {
      execFileSync('docker', ['info'], { stdio: 'pipe' })
    } catch {
      this.error('Docker is not installed or not running. Please install Docker first.')
      return
    }

    let numSigners: number
    if (this.nonInteractive) {
      numSigners = this.nonInteractiveOptions.numSigners || 3
      this.log(chalk.blue(`Non-interactive mode: Using ${numSigners} signers`))
    } else {
      const NUM_SIGNERS = await input({
        default: '3',
        message: 'Number of signers to run locally',
        validate: this.validators.signerCount
      })
      numSigners = Number.parseInt(NUM_SIGNERS, 10)
    }

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

    let threshold: number
    if (this.nonInteractive) {
      threshold = this.nonInteractiveOptions.threshold || defaultThreshold
      this.log(chalk.blue(`Non-interactive mode: Using threshold ${threshold}`))
    } else {
      const thresholdStr = await input({
        default: defaultThreshold.toString(),
        message: chalk.cyan(`Enter correctness threshold (how many signatures required, 1-${numSigners}):`),
        validate(value: string) {
          const num = Number.parseInt(value, 10)
          if (Number.isNaN(num) || num < 1 || num > numSigners) {
            return `Please enter a number between 1 and ${numSigners}`
          }

          return true
        }
      })
      threshold = Number.parseInt(thresholdStr, 10)
    }

    const TSO_URL = this.readTsoUrlFromConfig()
    if (!TSO_URL) {
      this.error('TSO_HOST not found in config.toml. Please run "scrollsdk setup domains" first.')
      return
    }

    const NETWORK = this.dogeConfig.network

    let generateWifKeys: boolean
    if (this.nonInteractive) {
      generateWifKeys = this.nonInteractiveOptions.generateWifKeys !== false // default true
      this.log(chalk.blue(`Non-interactive mode: Generate WIF keys = ${generateWifKeys}`))
    } else {
      generateWifKeys = await confirm({
        default: true,
        message: 'Would you like to generate new WIF keys for the signers?'
      })
    }

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

  private showContainerStatus(signerConfigs: any[]): void {
    this.log(chalk.blue('\n📊 Status Summary:'))
    try {
      const runningContainers = execFileSync('docker', [
        'ps', '--filter', 'name=dummy-signer',
        '--format', 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'
      ], { encoding: 'utf8' })
      this.log(runningContainers)
    } catch {
      this.warn('Could not get container status')
    }

    this.log(chalk.blue('\n🔍 Health check endpoints:'))
    for (const [i, config] of signerConfigs.entries()) {
      this.log(chalk.blue(`  Signer ${i}: curl http://localhost:${config.port}/health`))
    }

    this.log(chalk.blue('\n📋 Useful commands:'))
    this.log(chalk.blue('  View all containers: docker ps | grep dummy-signer'))
    this.log(chalk.blue('  View logs: docker logs -f dummy-signer-0'))
    this.log(chalk.blue('  Stop all: docker stop $(docker ps -q --filter name=dummy-signer)'))
  }

  private showSignerUrlsSummary(): void {
    this.log(chalk.blue('\n📊 Signer URLs Summary:'))
    if (this.dogeConfig.signerUrls && this.dogeConfig.signerUrls.length > 0) {
      for (const [index, url] of this.dogeConfig.signerUrls.entries()) {
        this.log(chalk.blue(`  Signer ${index}: ${url}`))
      }
    } else {
      this.log(chalk.yellow('  No signer URLs found'))
    }
  }

  private async startSignerContainers(signerConfigs: any[], network: string, tsoUrl: string, imageName: string): Promise<void> {
    this.log(chalk.blue(`Starting ${signerConfigs.length} dummy signers...`))

    for (const [i, config] of signerConfigs.entries()) {
      const dockerArgs = this.buildDockerArgs(i, config, network, tsoUrl, imageName)

      try {
        const containerId = execFileSync('docker', dockerArgs, { encoding: 'utf8' }).trim()
        this.log(chalk.green(`✅ Started dummy-signer-${i} on port ${config.port} (container: ${containerId.slice(0, 12)})`))
      } catch (error) {
        this.error(`Failed to start dummy-signer-${i}: ${error}`)
      }
    }
  }

  private async stopAndRemoveContainers(numSigners: number): Promise<void> {
    this.log(chalk.blue('Cleaning up existing containers...'))
    for (let i = 0; i < numSigners; i++) {
      try {
        execFileSync('docker', ['stop', `dummy-signer-${i}`], { stdio: 'pipe' })
        this.log(`Stopped dummy-signer-${i}`)
      } catch {
        // Container might not exist, ignore
      }

      try {
        execFileSync('docker', ['rm', `dummy-signer-${i}`], { stdio: 'pipe' })
        this.log(`Removed dummy-signer-${i}`)
      } catch {
        // Container might not exist, ignore
      }
    }
  }

  private async updateSetupDefaultsWithKMSPublicKeys(networkAlias: string, awsRegion: string, suffixesStr: string, threshold: number): Promise<void> {
    try {
      this.log('Fetching KMS public keys...');

      const suffixes = suffixesStr.split(' ').filter(s => s.trim());
      const publicKeys: string[] = [];

      for (const suffix of suffixes) {
        const aliasName = `alias/${networkAlias}-dummy-signer-${suffix}-key`;

        try {
          const keyIdOutput = execFileSync('aws', [
            'kms', 'describe-key',
            '--key-id', aliasName,
            '--region', awsRegion,
            '--query', 'KeyMetadata.KeyId',
            '--output', 'text'
          ], { encoding: 'utf8' }).trim();

          const publicKeyOutput = execFileSync('aws', [
            'kms', 'get-public-key',
            '--key-id', keyIdOutput,
            '--region', awsRegion,
            '--query', 'PublicKey',
            '--output', 'text'
          ], { encoding: 'utf8' }).trim();

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

  private async updateSetupDefaultsWithLocalPublicKeys(signerConfigs: Array<{ port: number, publicKey?: string, wif: string }>, threshold: number): Promise<void> {
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

  private async updateSetupDefaultsWithPublicKeys(publicKeys: string[], threshold: number): Promise<void> {
    if (publicKeys.length === 0) {
      this.warn('No public keys were provided');
      return;
    }

    const tomlPath = getSetupDefaultsPath();
    this.ensureDirectoryExists(path.dirname(tomlPath));

    let config: any = {};
    if (fs.existsSync(tomlPath)) {
      const tomlContent = fs.readFileSync(tomlPath, 'utf8');
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

  private warn(message: string): void {
    if (this.jsonMode && this.jsonCtx) {
      this.jsonCtx.addWarning(message)
    } else {
      this._warn(message)
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
    'aws-account-id': Flags.string({
      description: 'AWS account ID',
    }),
    'aws-network-alias': Flags.string({
      description: 'Network alias for AWS resources',
    }),
    'aws-only': Flags.boolean({
      char: 'a',
      default: false,
      description: 'Set up AWS KMS signers only',
    }),
    // AWS signer options
    'aws-region': Flags.string({
      description: 'AWS region for KMS signers',
    }),
    'aws-suffixes': Flags.string({
      description: 'Space-separated suffixes for AWS signers (e.g., "00 01 02")',
    }),
    config: Flags.string({
      char: 'c',
      description: 'Path to config file (e.g., .data/doge-config-mainnet.toml or .data/doge-config-testnet.toml)',
    }),
    'generate-wif-keys': Flags.boolean({
      allowNo: true,
      default: true,
      description: 'Generate new WIF keys (non-interactive mode)',
    }),
    'image-tag': Flags.string({
      description: 'Specify the Docker image tag to use',
      required: false,
    }),
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    'local-only': Flags.boolean({
      char: 'l',
      default: false,
      description: 'Set up local Docker signers only',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts. Uses config values or sensible defaults.',
    }),
    // Local signer options
    'num-signers': Flags.integer({
      default: 3,
      description: 'Number of signers (non-interactive mode)',
    }),
    threshold: Flags.integer({
      description: 'Correctness threshold (non-interactive mode). Defaults to 2/3 majority.',
    }),
    'wif-network': Flags.string({
      default: 'regtest',
      description: 'Network for WIF generation: regtest, testnet, or mainnet',
      options: ['regtest', 'testnet', 'mainnet'],
    }),
  }

  private configPath: string = ''
  private dogeConfig: DogeConfig = {} as DogeConfig
  private jsonCtx!: JsonOutputContext
  private jsonMode: boolean = false
  private nonInteractive: boolean = false

  async run(): Promise<void> {
    const { flags } = await this.parse(DummySignersCommand)

    // Setup non-interactive/JSON mode
    this.nonInteractive = flags['non-interactive']
    this.jsonMode = flags.json
    this.jsonCtx = new JsonOutputContext('doge dummy-signers', this.jsonMode)

    // In non-interactive mode, --config is required to avoid prompts in loadDogeConfigWithSelection
    if (this.nonInteractive && !flags.config) {
      this.jsonCtx.error(
        'E601_MISSING_FIELD',
        '--config flag is required in non-interactive mode to specify the doge config file path',
        'CONFIGURATION',
        true,
        { flag: '--config' }
      )
    }

    // Load config - use flags.config (not flags['doge-config'])
    const { config, configPath } = await loadDogeConfigWithSelection(
      flags.config,
      'scrollsdk doge:config'
    )

    try {
      this.dogeConfig = config;
      this.configPath = configPath;
      this.jsonCtx.info(`Loaded configuration for ${this.dogeConfig.network} network from ${configPath}`)
    } catch (error) {
      this.jsonCtx.error(
        'E602_INVALID_CONFIG_FORMAT',
        `Failed to load config: ${error}`,
        'CONFIGURATION',
        false
      )
      // jsonCtx.error throws, so this is unreachable
    }

    // Validate flags
    if (flags['local-only'] && flags['aws-only']) {
      this.jsonCtx.error(
        'E601_INVALID_VALUE',
        'Cannot use both --local-only and --aws-only flags together',
        'CONFIGURATION',
        true
      )
      // jsonCtx.error throws, so this is unreachable
    }

    // Override deployment type if flags are specified
    if (flags['local-only']) {
      this.dogeConfig.deploymentType = 'local'
    } else if (flags['aws-only']) {
      this.dogeConfig.deploymentType = 'aws'
    }

    // Get image tag
    const imageTag = await this.getDockerImageTag(flags['image-tag'])
    this.jsonCtx.info(`Using Docker image tag: ${imageTag}`)

    // Build non-interactive options from flags
    const nonInteractiveOptions: NonInteractiveOptions = {
      awsAccountId: resolveEnvValue(flags['aws-account-id']),
      awsNetworkAlias: resolveEnvValue(flags['aws-network-alias']),
      awsRegion: resolveEnvValue(flags['aws-region']),
      awsSuffixes: resolveEnvValue(flags['aws-suffixes']),
      generateWifKeys: flags['generate-wif-keys'],
      numSigners: flags['num-signers'],
      threshold: flags.threshold,
      wifNetwork: flags['wif-network'] as 'mainnet' | 'regtest' | 'testnet',
    }

    // Set up dummy signers
    const dummySignersManager = new DummySignersManager(
      this.dogeConfig,
      this.configPath,
      imageTag,
      {
        error: this.error.bind(this),
        log: this.log.bind(this),
        warn: this.warn.bind(this)
      },
      this.nonInteractive,
      nonInteractiveOptions,
      this.jsonMode,
      this.jsonCtx
    )

    try {
      await dummySignersManager.setupDummySigners(await this.fetchDockerTags())

      // JSON output
      if (this.jsonMode) {
        this.jsonCtx.success({
          deploymentType: this.dogeConfig.deploymentType,
          imageTag,
          network: this.dogeConfig.network,
          signerUrls: this.dogeConfig.signerUrls,
        })
      }
    } catch (error) {
      if (this.jsonMode) {
        this.jsonCtx.error(
          'E900_UNEXPECTED_ERROR',
          `Dummy signers setup failed: ${error}`,
          'INTERNAL',
          false
        )
      }

      this.error(`Dummy signers setup failed: ${error}`)
    }
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

  private async getDockerImageTag(providedTag: string | undefined): Promise<string> {
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

    // In non-interactive mode, use the provided tag or default
    if (this.nonInteractive) {
      this.jsonCtx.addWarning(`Provided tag "${providedTag}" not found, using default: ${defaultTag}`)
      return defaultTag
    }

    const selectedTag = await select({
      choices: tags.map((tag: string) => ({ name: tag, value: tag })),
      message: 'Select a Docker image tag:',
    })

    return selectedTag
  }
}

// Export the command as default for oclif
export default DummySignersCommand 