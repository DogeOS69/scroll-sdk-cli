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
import { getAwsSignerConfigFromSpec, getDummySignerProviderFromSpec, loadDeploymentSpec } from '../../utils/deployment-spec-generator.js'
import { dogeConfigToToml, loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import { resolveEnvValue } from '../../utils/non-interactive.js'
const { Networks, PrivateKey } = bitcore
const defaultTag = 'newda'
const awsImageSources = ['dockerhub', 'ecr', 'ecr-sync'] as const
const ATTESTATION_SIGNER_COUNT = 3
const ATTESTATION_SIGNER_SUFFIXES = Array.from({ length: ATTESTATION_SIGNER_COUNT }, (_value, index) =>
  index.toString().padStart(2, '0')
)

type AwsImageSource = typeof awsImageSources[number]
type DummySignerProvider = 'aws' | 'local'

function getConfiguredDummySignerProvider(config: DogeConfig): DummySignerProvider | undefined {
  return config.dummySigner?.provider
}

function setConfiguredDummySignerProvider(config: DogeConfig, provider: DummySignerProvider): void {
  config.dummySigner = {
    ...config.dummySigner,
    provider,
  }
}

function getDefaultAttestationThreshold(keyCount: number): number {
  if (keyCount === 1) return 1
  if (keyCount === 2) return 2
  return Math.ceil(keyCount * 2 / 3)
}

export interface NonInteractiveOptions {
  awsAccountId?: string
  awsEcsClusterName?: string
  awsImageSource?: AwsImageSource
  awsImageUri?: string
  awsNetworkAlias?: string
  awsRegion?: string
  generateWifKeys?: boolean
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

    let dummySignerProvider: DummySignerProvider
    const configuredProvider = getConfiguredDummySignerProvider(this.dogeConfig)
    if (this.nonInteractive) {
      dummySignerProvider = configuredProvider || 'local'
      this.log(chalk.blue(`Non-interactive mode: Using dummy signer provider '${dummySignerProvider}'`))
    } else {
      dummySignerProvider = await select({
        choices: [
          {
            description: 'Run attestation signers locally using Docker with WIF keys',
            name: 'Local (Docker) - For development/testing',
            value: 'local'
          },
          {
            description: 'Deploy attestation signers to AWS ECS Express Mode with KMS key management',
            name: 'AWS (ECS Express + KMS)',
            value: 'aws'
          }
        ],
        default: configuredProvider || 'local',
        message: 'How would you like to run the dummy attestation signers?'
      })
    }

    setConfiguredDummySignerProvider(this.dogeConfig, dummySignerProvider)

    await (dummySignerProvider === 'local' ? this.setupLocalSigners(availableTags) : this.setupAwsSigners(availableTags));
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

  private buildDockerHubImage(): string {
    return `dogeos69/dummy-signer:${this.imageTag}`
  }

  private buildEcrImage(awsRegion: string, awsAccountId: string): string {
    const repoName = 'dogeos/dummy-signer';
    const ecrRegistry = `${awsAccountId}.dkr.ecr.${awsRegion}.amazonaws.com`;

    return `${ecrRegistry}/${repoName}:${this.imageTag}`;
  }

  private checkEcrImageExists(awsRegion: string, repoName: string): boolean {
    try {
      execFileSync('aws', ['ecr', 'describe-images', '--repository-name', repoName, '--image-ids', `imageTag=${this.imageTag}`, '--region', awsRegion], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  private async collectSignerConfigs(numSigners: number, generateWifKeys: boolean): Promise<Array<{ port: number, publicKey?: string, wif: string }>> {
    const signerConfigs: Array<{ port: number, publicKey?: string, wif: string }> = []

    const selectedNetwork = this.dogeConfig.network
    if (generateWifKeys) {
      this.log(chalk.blue(`Using WIF network '${selectedNetwork}' from config.toml`))
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

  private async confirmDockerHubTagIfKnown(availableTags: string[]): Promise<void> {
    if (availableTags.length === 0) {
      this.warn(chalk.yellow(`Skipping Docker Hub tag validation for '${this.imageTag}' because the tag list is unavailable.`))
      return
    }

    if (availableTags.includes(this.imageTag)) {
      this.log(chalk.green(`✅ Verified image tag '${this.imageTag}' exists in Docker Hub.`))
      return
    }

    this.warn(chalk.yellow(`⚠️  Warning: Image tag '${this.imageTag}' not found in Docker Hub.`))
    this.log(chalk.blue(`Available tags: ${availableTags.slice(0, 10).join(', ')}${availableTags.length > 10 ? '...' : ''}`))

    if (this.nonInteractive) {
      this.warn(chalk.yellow('Non-interactive mode: Proceeding with unverified image tag'))
      return
    }

    const proceedAnyway = await confirm({
      default: false,
      message: 'The specified image tag was not found in Docker Hub. Do you want to proceed anyway?'
    })

    if (!proceedAnyway) {
      throw new Error('AWS deployment cancelled.')
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

  private ensureAwsCliConfigured(): void {
    try {
      execFileSync('which', ['aws'], { stdio: 'pipe' });
      execFileSync('aws', ['sts', 'get-caller-identity'], { stdio: 'pipe' });
    } catch {
      throw new Error('AWS CLI is not installed or not configured. Please install and configure AWS CLI first.');
    }
  }

  private ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
  }

  private ensureDockerRunning(): void {
    try {
      execFileSync('docker', ['info'], { stdio: 'pipe' });
    } catch {
      throw new Error('Docker is not installed or not running. Please install and start Docker first.');
    }
  }

  private ensureEcrImageAvailable(awsRegion: string, awsAccountId: string): void {
    const repoName = 'dogeos/dummy-signer';
    const ecrImage = this.buildEcrImage(awsRegion, awsAccountId);

    this.log('Checking prerequisites...');
    this.ensureAwsCliConfigured();
    this.ensureEcrRepository(awsRegion, repoName);

    this.log('Checking if image exists in ECR...');
    if (this.checkEcrImageExists(awsRegion, repoName)) {
      this.log(`Image ${ecrImage} already exists in ECR.`);
      return;
    }

    throw new Error(`Image ${ecrImage} does not exist in ECR. Push the image first or use --aws-image-source dockerhub/ecr-sync.`);
  }

  private ensureEcrRepository(awsRegion: string, repoName: string): void {
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
      this.warn(`Could not fetch Docker tags, skipping tag validation: ${error}`)
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

  private async getAwsServiceUrls(networkAlias: string, awsRegion: string, signerIds: string[], ecsCluster: string): Promise<void> {
    try {
      this.log('Fetching AWS ECS Express Mode service URLs...');

      const urls: string[] = [];

      for (const signerId of signerIds) {
        const serviceName = `${networkAlias}-dummy-signer-${signerId}`;
        const maxAttempts = 60;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            // Get the service ARN first
            const serviceListOutput = execFileSync('aws', [
              'ecs', 'list-services',
              '--cluster', ecsCluster,
              '--region', awsRegion,
              '--query', `serviceArns[?ends_with(@, '/${serviceName}')]`,
              '--output', 'text'
            ], { encoding: 'utf8' }).trim();

            if (serviceListOutput) {
              // Get the service URL using the ARN
              const serviceUrlOutput = execFileSync('aws', [
                'ecs', 'describe-express-gateway-service',
                '--service-arn', serviceListOutput,
                '--region', awsRegion,
                '--query', 'service.activeConfigurations[-1].ingressPaths[?accessType==`PUBLIC`].endpoint | [0]',
                '--output', 'text'
              ], { encoding: 'utf8' }).trim();

              if (serviceUrlOutput && serviceUrlOutput !== 'None') {
                const fullUrl = serviceUrlOutput.startsWith('https://') ? serviceUrlOutput : `https://${serviceUrlOutput}`;
                urls.push(fullUrl);
                this.log(`✅ Got service URL for ${serviceName}: ${fullUrl}`);
                break;
              }
            }

            if (attempt < maxAttempts) {
              this.log(`Waiting for ECS Express endpoint for ${serviceName} (${attempt}/${maxAttempts})...`);
              await new Promise(resolve => {
                setTimeout(resolve, 10_000);
              });
            } else {
              this.warn(`Service URL not found for ${serviceName}`);
            }
          } catch (error) {
            if (attempt < maxAttempts) {
              this.warn(`Failed to get service URL for ${serviceName}: ${error}`);
              await new Promise(resolve => {
                setTimeout(resolve, 10_000);
              });
            } else {
              this.warn(`Failed to get service URL for ${serviceName}: ${error}`);
            }
          }
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

  private getConfiguredAwsImageSource(): AwsImageSource {
    const configuredSource = this.nonInteractiveOptions.awsImageSource || this.dogeConfig.awsSigner?.imageSource

    if (configuredSource && awsImageSources.includes(configuredSource as AwsImageSource)) {
      return configuredSource as AwsImageSource
    }

    if (configuredSource) {
      this.warn(`Unsupported AWS image source "${configuredSource}", using dockerhub.`)
    }

    return 'dockerhub'
  }

  private getConfiguredAwsImageUri(): string | undefined {
    if (this.nonInteractiveOptions.awsImageUri) {
      return this.nonInteractiveOptions.awsImageUri
    }

    if (this.nonInteractiveOptions.awsImageSource) {
      return undefined
    }

    return this.dogeConfig.awsSigner?.imageUri
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
      `${baseTag}-local`,
      baseTag.replace('-test', '-test-local'),
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
    const dockerHubImage = this.buildDockerHubImage();
    const ecrRegistry = `${awsAccountId}.dkr.ecr.${awsRegion}.amazonaws.com`;
    const ecrImage = this.buildEcrImage(awsRegion, awsAccountId);

    this.log('Checking prerequisites...');
    this.ensureAwsCliConfigured();
    this.ensureEcrRepository(awsRegion, repoName);

    this.log('Checking if image exists in ECR...');
    const imageExistsInECR = this.checkEcrImageExists(awsRegion, repoName);
    if (imageExistsInECR) {
      this.log(`Image ${ecrImage} already exists in ECR.`);
      this.log('Dummy signer image preparation completed successfully!');
      return;
    }

    this.log(`Image ${ecrImage} does not exist in ECR. Will proceed to push.`);
    this.ensureDockerRunning();

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

    this.log('Verifying image in ECR...');
    if (this.checkEcrImageExists(awsRegion, repoName)) {
      this.log('Image successfully verified in ECR.');
    } else {
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
    ecsClusterName: string
    imageSource?: AwsImageSource
    imageUri?: null | string
    networkAlias: string
    region: string
  }): Promise<void> {
    try {
      if (!this.dogeConfig.awsSigner) {
        this.dogeConfig.awsSigner = {}
      }

      const { imageUri, ...awsSignerConfigWithoutImageUri } = awsSignerConfig
      const updatedAwsSigner = {
        ...this.dogeConfig.awsSigner,
        ...awsSignerConfigWithoutImageUri
      }

      if (imageUri === null) {
        delete updatedAwsSigner.imageUri
      } else if (imageUri !== undefined) {
        updatedAwsSigner.imageUri = imageUri
      }

      this.dogeConfig.awsSigner = updatedAwsSigner

      const configContent = dogeConfigToToml(this.dogeConfig)
      fs.writeFileSync(this.configPath, configContent)

      this.log(chalk.green(`AWS signer configuration saved to ${this.configPath}`))
    } catch (error) {
      this.warn(`Failed to save AWS signer config: ${error}`)
    }
  }

  private saveConfigToFile(config: any, filePath: string): void {
    this.ensureDirectoryExists(path.dirname(filePath))
    fs.writeFileSync(filePath, dogeConfigToToml(config as DogeConfig))
  }

  private saveLocalSignerConfig(signerConfigs: any[]): void {
    if (!this.dogeConfig.localSigners) {
      this.dogeConfig.localSigners = {}
    }

    this.dogeConfig.localSigners = {
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

    let AWS_REGION: string
    let NETWORK_ALIAS: string
    let AWS_ACCOUNT_ID: string
    let ECS_CLUSTER: string

    if (this.nonInteractive) {
      AWS_REGION = this.nonInteractiveOptions.awsRegion || this.dogeConfig.awsSigner?.region || 'us-east-1'
      NETWORK_ALIAS = this.nonInteractiveOptions.awsNetworkAlias || this.dogeConfig.awsSigner?.networkAlias || 'devnet'
      AWS_ACCOUNT_ID = this.nonInteractiveOptions.awsAccountId || this.dogeConfig.awsSigner?.accountId || ''
      ECS_CLUSTER = this.nonInteractiveOptions.awsEcsClusterName || this.dogeConfig.awsSigner?.ecsClusterName || 'default'

      if (!AWS_ACCOUNT_ID) {
        this.error('AWS_ACCOUNT_ID is required for AWS deployment in non-interactive mode. Use --aws-account-id flag.')
        return
      }

      this.log(chalk.blue(`Non-interactive mode: AWS_REGION=${AWS_REGION}, NETWORK_ALIAS=${NETWORK_ALIAS}, AWS_ACCOUNT_ID=${AWS_ACCOUNT_ID}, ECS_CLUSTER=${ECS_CLUSTER}`))
    } else {
      AWS_REGION = this.nonInteractiveOptions.awsRegion || this.dogeConfig.awsSigner?.region || await input({
        default: 'us-east-1',
        message: 'AWS_REGION',
        required: true,
      })

      NETWORK_ALIAS = this.nonInteractiveOptions.awsNetworkAlias || this.dogeConfig.awsSigner?.networkAlias || await input({
        default: 'devnet',
        message: 'NETWORK_ALIAS',
        required: true,
      })

      AWS_ACCOUNT_ID = this.nonInteractiveOptions.awsAccountId || this.dogeConfig.awsSigner?.accountId || await input({
        message: 'AWS_ACCOUNT_ID',
        required: true,
      })

      ECS_CLUSTER = this.nonInteractiveOptions.awsEcsClusterName || this.dogeConfig.awsSigner?.ecsClusterName || 'default'
    }

    const awsImageSource = this.getConfiguredAwsImageSource()
    const customAwsImageUri = this.getConfiguredAwsImageUri()
    const IMAGE_URI = customAwsImageUri || (
      awsImageSource === 'dockerhub'
        ? this.buildDockerHubImage()
        : this.buildEcrImage(AWS_REGION, AWS_ACCOUNT_ID)
    )

    this.log(chalk.blue(`Using AWS signer image source: ${customAwsImageUri ? 'custom' : awsImageSource}`))
    this.log(chalk.blue(`Using AWS signer image URI: ${IMAGE_URI}`))

    if (!customAwsImageUri && availableTags.length > 0 && (awsImageSource === 'dockerhub' || awsImageSource === 'ecr-sync')) {
      await this.confirmDockerHubTagIfKnown(availableTags)
    }

    const TSO_URL = this.readTsoUrlFromConfig()
    if (!TSO_URL) {
      this.error('TSO_HOST not found in config.toml. Please run "scrollsdk setup domains" first.')
      return
    }

    this.log(chalk.cyan(`You will have ${ATTESTATION_SIGNER_COUNT} attestation signer keys.`))

    const awsSignerConfig: {
      accountId: string
      ecsClusterName: string
      imageSource: AwsImageSource
      imageUri?: null | string
      networkAlias: string
      region: string
    } = {
      accountId: AWS_ACCOUNT_ID,
      ecsClusterName: ECS_CLUSTER,
      imageSource: awsImageSource,
      networkAlias: NETWORK_ALIAS,
      region: AWS_REGION,
    }

    if (customAwsImageUri) {
      awsSignerConfig.imageUri = customAwsImageUri
    } else if (this.nonInteractiveOptions.awsImageSource) {
      awsSignerConfig.imageUri = null
    }

    await this.saveAwsSignerConfig(awsSignerConfig)

    try {
      if (customAwsImageUri) {
        this.log('Using custom image URI; skipping automatic ECR image preparation.');
      } else if (awsImageSource === 'ecr-sync') {
        this.prepareDummyImage(AWS_REGION, AWS_ACCOUNT_ID);
      } else if (awsImageSource === 'ecr') {
        this.ensureEcrImageAvailable(AWS_REGION, AWS_ACCOUNT_ID);
      } else {
        this.log('Using Docker Hub image directly; skipping ECR image preparation.');
      }

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
        env: { ...process.env, AWS_ACCOUNT_ID, AWS_REGION, ECS_CLUSTER, IMAGE_URI, NETWORK_ALIAS, TEE_SIGNER_ID: ATTESTATION_SIGNER_SUFFIXES.join(' '), TSO_URL },
        stdio: 'inherit',
      });

      this.log('Setup dummy attestation signers completed successfully!');

      await this.updateSetupDefaultsWithKMSPublicKeys(NETWORK_ALIAS, AWS_REGION, ATTESTATION_SIGNER_SUFFIXES);

      // Get AWS service URLs
      await this.getAwsServiceUrls(NETWORK_ALIAS, AWS_REGION, ATTESTATION_SIGNER_SUFFIXES, ECS_CLUSTER);

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

    const numSigners: number = ATTESTATION_SIGNER_COUNT;
    this.log(chalk.cyan(`You will have ${ATTESTATION_SIGNER_COUNT} local attestation signer keys.`))

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
        message: 'Would you like to generate new WIF keys for the attestation signers?'
      })
    }

    const signerConfigs = await this.collectSignerConfigs(numSigners, generateWifKeys)

    const localImageTag = await this.getLocalImageTag(availableTags)
    const imageName = `dogeos69/dummy-signer:${localImageTag}`
    await this.pullDockerImage(imageName)
    await this.stopAndRemoveContainers(numSigners)
    await this.startSignerContainers(signerConfigs, NETWORK, TSO_URL, imageName)

    this.showContainerStatus(signerConfigs)

    this.saveLocalSignerConfig(signerConfigs)
    await this.updateSetupDefaultsWithLocalPublicKeys(signerConfigs)

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

  private async updateSetupDefaultsWithKMSPublicKeys(networkAlias: string, awsRegion: string, signerIds: string[]): Promise<void> {
    try {
      this.log('Fetching attestation KMS public keys...');

      const publicKeys: string[] = [];

      for (const signerId of signerIds) {
        const aliasName = `alias/${networkAlias}-dummy-signer-${signerId}-key`;

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

      await this.updateSetupDefaultsWithPublicKeys(publicKeys);

    } catch (error) {
      this.error(`Failed to update setup defaults: ${error}`);
    }
  }

  private async updateSetupDefaultsWithLocalPublicKeys(signerConfigs: Array<{ port: number, publicKey?: string, wif: string }>): Promise<void> {
    try {
      this.log('Fetching attestation public keys from WIF...');

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

  private async updateSetupDefaultsWithPublicKeys(publicKeys: string[]): Promise<void> {
    if (publicKeys.length === 0) {
      this.warn('No attestation public keys were provided');
      return;
    }

    if (publicKeys.length !== ATTESTATION_SIGNER_COUNT) {
      this.error(`Expected ${ATTESTATION_SIGNER_COUNT} attestation public keys, got ${publicKeys.length}`);
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
      this.error('setup_defaults.toml not found. Please run "scrollsdk setup doge-config" first.')
    }

    const threshold = getDefaultAttestationThreshold(publicKeys.length);
    config.attestation_pubkeys = publicKeys;
    config.attestation_key_count = publicKeys.length;
    config.attestation_threshold = threshold;

    const updatedToml = toml.stringify(config);
    fs.writeFileSync(tomlPath, updatedToml);

    this.log(`✅ Updated ${tomlPath} with ${publicKeys.length} attestation public keys`);
    this.log(`Attestation threshold: ${threshold}`);
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
  static description = 'Set up three dummy attestation signers (local Docker or AWS with KMS)'

  static examples = [
    '$ scrollsdk setup dummy-signers',
    '$ scrollsdk setup dummy-signers --config .data/doge-config.toml',
    '$ scrollsdk setup dummy-signers --local-only',
    '$ scrollsdk setup dummy-signers --aws-only',
    '$ scrollsdk setup dummy-signers --image-tag newda',
    '$ scrollsdk setup dummy-signers --aws-only --aws-image-source ecr-sync',
    '$ scrollsdk setup dummy-signers --aws-only --aws-image-uri dogeos69/dummy-signer:newda',
  ]

  static flags = {
    'aws-account-id': Flags.string({
      description: 'AWS account ID',
    }),
    'aws-ecs-cluster': Flags.string({
      description: 'ECS cluster for AWS ECS Express dummy attestation signer services. Defaults to awsSigner.ecsClusterName or "default".',
    }),
    'aws-image-source': Flags.string({
      description: 'AWS attestation signer image source: dockerhub uses the public image directly, ecr requires an existing ECR image, ecr-sync syncs Docker Hub to ECR from this machine',
      options: [...awsImageSources],
    }),
    'aws-image-uri': Flags.string({
      description: 'Full container image URI for AWS attestation signers. Overrides --aws-image-source.',
    }),
    'aws-network-alias': Flags.string({
      description: 'Network alias for AWS resources',
    }),
    'aws-only': Flags.boolean({
      char: 'a',
      default: false,
      description: 'Set up AWS KMS attestation signers only',
    }),
    // AWS signer options
    'aws-region': Flags.string({
      description: 'AWS region for KMS attestation signers',
    }),
    config: Flags.string({
      char: 'c',
      description: 'Path to Dogecoin config file',
    }),
    'from-spec': Flags.string({
      description: 'Path to DeploymentSpec YAML. Uses dummy attestation signer defaults from signing.awsKms or signing.local.',
    }),
    'generate-wif-keys': Flags.boolean({
      allowNo: true,
      default: true,
      description: 'Generate new attestation WIF keys (non-interactive mode)',
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
      description: 'Set up local Docker attestation signers only',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts. Uses config values or sensible defaults.',
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
    this.jsonCtx = new JsonOutputContext('setup dummy-signers', this.jsonMode)

    let specAwsSignerConfig: DogeConfig['awsSigner'] | undefined
    let specDummySignerProvider: DummySignerProvider | undefined
    const specPath = flags['from-spec'] ? path.resolve(flags['from-spec']) : undefined
    if (specPath) {
      try {
        const spec = loadDeploymentSpec(specPath)
        specAwsSignerConfig = getAwsSignerConfigFromSpec(spec)
        specDummySignerProvider = getDummySignerProviderFromSpec(spec)
        this.jsonCtx.info(`Loaded DeploymentSpec defaults from ${specPath}`)
      } catch (error) {
        this.jsonCtx.error(
          'E602_INVALID_CONFIG_FORMAT',
          `Failed to load DeploymentSpec: ${error instanceof Error ? error.message : String(error)}`,
          'CONFIGURATION',
          true,
          { specPath }
        )
      }
    }

    // Load config - use flags.config (not flags['doge-config'])
    const { config, configPath } = await loadDogeConfigWithSelection(
      flags.config,
      'scrollsdk setup doge-config'
    )

    try {
      this.dogeConfig = config;
      this.configPath = configPath;

      if (specAwsSignerConfig) {
        this.dogeConfig.awsSigner = {
          ...this.dogeConfig.awsSigner,
          ...specAwsSignerConfig,
        }
      }

      if (specDummySignerProvider) {
        setConfiguredDummySignerProvider(this.dogeConfig, specDummySignerProvider)
      }

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

    // Override dummy signer provider if flags are specified
    if (flags['local-only']) {
      setConfiguredDummySignerProvider(this.dogeConfig, 'local')
    } else if (flags['aws-only']) {
      setConfiguredDummySignerProvider(this.dogeConfig, 'aws')
    }

    // Get image tag
    const imageTag = await this.getDockerImageTag(flags['image-tag'])
    this.jsonCtx.info(`Using Docker image tag: ${imageTag}`)

    // Build non-interactive options from flags
    const nonInteractiveOptions: NonInteractiveOptions = {
      awsAccountId: resolveEnvValue(flags['aws-account-id']),
      awsEcsClusterName: resolveEnvValue(flags['aws-ecs-cluster']),
      awsImageSource: flags['aws-image-source'] as AwsImageSource | undefined,
      awsImageUri: resolveEnvValue(flags['aws-image-uri']),
      awsNetworkAlias: resolveEnvValue(flags['aws-network-alias']),
      awsRegion: resolveEnvValue(flags['aws-region']),
      generateWifKeys: flags['generate-wif-keys'],
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
      const dummySignerProvider = getConfiguredDummySignerProvider(this.dogeConfig)
      const shouldFetchDockerTags = dummySignerProvider === 'local'
      const availableTags = shouldFetchDockerTags ? await this.fetchDockerTags() : []
      await dummySignersManager.setupDummySigners(availableTags)

      // JSON output
      if (this.jsonMode) {
        this.jsonCtx.success({
          attestationKeyCount: ATTESTATION_SIGNER_COUNT,
          attestationThreshold: getDefaultAttestationThreshold(ATTESTATION_SIGNER_COUNT),
          dummySignerProvider: getConfiguredDummySignerProvider(this.dogeConfig),
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
      this.warn(`Could not fetch Docker tags, skipping tag validation: ${error}`)
      return []
    }
  }

  private async getDockerImageTag(providedTag: string | undefined): Promise<string> {
    if (!providedTag) {
      return defaultTag
    }

    const tags = await this.fetchDockerTags()

    if (tags.length === 0) {
      this.warn(`Could not verify Docker image tag "${providedTag}", using it as provided.`)
      return providedTag
    }

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
