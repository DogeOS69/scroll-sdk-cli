import type { JsonMap } from '@iarna/toml'

import * as toml from '@iarna/toml'
import { confirm, input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { DogeConfig } from '../../types/doge-config.js'
import type {ProofTopologyArtifactStoreConfig, ProofTopologySpec} from '../../types/proof-topology.js'

import { SETUP_DEFAULTS_TEMPLATE, getSetupDefaultsPath } from '../../config/constants.js'
import { Network } from '../../types/doge-config.js'
import { writeConfigs } from '../../utils/config-writer.js'
import {
  dogeConfigToToml,
  normalizeDogeNetwork,
} from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {
  resolveBlockbookKubernetesEndpoints,
  resolveDogecoinKubernetesEndpoints,
} from '../../utils/kubernetes-endpoints.js'
import {
  createNonInteractiveContext,
  resolveConfirm,
  resolveEnvValue,
  resolveOrPrompt,
  resolveOrSelect,
  validateAndExit,
} from '../../utils/non-interactive.js'
import {readOptionalProofAwsConfig} from '../../utils/proof-aws-config.js'
import {
  discoverProofRelease,
  proofReleaseManifestSha256,
  readProofRelease,
  verifyProofTopologyReleaseBinding,
} from '../../utils/proof-release.js'
import {compileProofTopology} from '../../utils/proof-topology-compiler.js'
import {
  awsS3Endpoint,
  buildProofTopologyFromRelease,
} from '../../utils/proof-topology-init.js'

type EthereumDaChain = 'devnet' | 'mainnet' | 'sepolia'

interface InitializeProofTopologyOptions {
  artifactSource?: string
  bucket?: string
  compilerBinary?: string
  config: DogeConfig
  coordinatorUrl?: string
  endpointUrl?: string
  forcePathStyle: boolean
  keyPrefix?: string
  log: (message: string) => void
  mode?: 'disabled' | 'mock' | 'production'
  nonInteractive: boolean
  productionWorkerLaunch?: 'external' | 'local_cpu' | 'local_cuda'
  publicS3Endpoint?: string
  region?: string
  releasePath?: string
  resourcesPersistentVolumeClaim?: string
  resourcesRoot?: string
  witnessDir?: string
  witnessRpcUrl?: string
  witnessSource?: 'block_witness_dir' | 'rpc'
}

interface InitializedProofTopology {
  release: NonNullable<DogeConfig['proof_release']>
  topology: ProofTopologySpec
}

const ETHEREUM_DA_DEFAULTS: Record<EthereumDaChain, {
  beaconRpcUrl: string
  chainId: string
  minFinality: 'finalized' | 'safe'
  submitterRpcUrl: string
}> = {
  devnet: {
    beaconRpcUrl: 'http://l1-devnet-lighthouse:5052',
    chainId: '32382',
    minFinality: 'safe',
    submitterRpcUrl: 'http://l1-devnet:8545',
  },
  mainnet: {
    beaconRpcUrl: 'https://ethereum-beacon-api.publicnode.com',
    chainId: '1',
    minFinality: 'finalized',
    submitterRpcUrl: 'https://eth.drpc.org',
  },
  sepolia: {
    beaconRpcUrl: 'https://ethereum-sepolia-beacon-api.publicnode.com',
    chainId: '11155111',
    minFinality: 'safe',
    submitterRpcUrl: 'https://gateway.tenderly.co/public/sepolia',
  },
}

function normalizeClusterLocalHttpUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.toLowerCase().startsWith('https://')) return trimmed

  try {
    const parsedUrl = new URL(trimmed)
    const hostname = parsedUrl.hostname.toLowerCase()
    const serviceHosts = ['l1-devnet', 'l1-devnet-geth', 'l1-devnet-lighthouse']
    if (serviceHosts.some(serviceHost => hostname === serviceHost || hostname.startsWith(`${serviceHost}.`))) {
      return trimmed.replace(/^https:\/\//i, 'http://')
    }
  } catch {
    return trimmed
  }

  return trimmed
}

export class DogeConfigCommand extends Command {
  static description = 'Configure Dogecoin/DA settings and optionally initialize compiler-backed proof topology'

  static examples = [
    '$ scrollsdk setup doge-config',
    '$ scrollsdk setup doge-config --config .data/doge-config.toml',
    '$ scrollsdk setup doge-config --proof-topology',
    '$ scrollsdk setup doge-config --proof-topology --proof-release .data/proof-release-v1.json',
    '$ scrollsdk setup doge-config --non-interactive',
    '$ scrollsdk setup doge-config --non-interactive --json',
  ]

  static flags = {
    config: Flags.string({
      char: 'c',
      description: 'Path to config file',
    }),
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts, using existing config values',
    }),
    'production-worker-launch': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Production Worker placement used by --proof-topology',
      options: ['external', 'local_cpu', 'local_cuda'],
    }),
    'proof-artifact-source': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Artifact resource source used by --proof-topology',
      options: ['existing-s3', 'prepared-aws'],
    }),
    'proof-bucket': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Existing S3-compatible proof artifact bucket',
    }),
    'proof-coordinator-url': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Proof Coordinator URL reachable by the selected Worker placement',
    }),
    'proof-endpoint-url': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Worker-visible S3-compatible endpoint root',
    }),
    'proof-force-path-style': Flags.boolean({
      default: false,
      dependsOn: ['proof-topology'],
      description: 'Use path-style S3 object URLs for an existing compatible store',
    }),
    'proof-key-prefix': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Base proof artifact key prefix before compiler digest scoping',
    }),
    'proof-mode': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Initial proof mode; new deployments default to disabled',
      options: ['disabled', 'mock', 'production'],
    }),
    'proof-public-s3-endpoint': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'External Worker/signer-visible S3 endpoint when different from the store endpoint',
    }),
    'proof-region': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Existing S3-compatible proof artifact region',
    }),
    'proof-release': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Versioned dogeos/proof-release/v1 manifest; conventional paths are auto-discovered',
    }),
    'proof-resources-pvc': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Advanced override for the pre-populated proof release PVC (default: dogeos-proof-release)',
    }),
    'proof-resources-root': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Advanced override for the deployment-relative proof release directory (default: proof-artifacts)',
    }),
    'proof-topology': Flags.boolean({
      default: false,
      description: 'Initialize or replace compiler-backed proof topology',
    }),
    'proof-topology-compiler-binary': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Development-only local dogeos-proof-topology binary used for both initialization preflights',
    }),
    'proof-witness-dir': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Block witness directory relative to --proof-resources-root',
    }),
    'proof-witness-rpc-url': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Scroll witness RPC URL used when --proof-witness-source=rpc',
    }),
    'proof-witness-source': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Chunk witness source used by real materialization',
      options: ['block_witness_dir', 'rpc'],
    }),
  }

  private configPath: string = ''
  private dogeConfig: DogeConfig = {} as DogeConfig

  async generateSetupDefaultsToml(newDogeConfig: DogeConfig): Promise<void> {
    // Create setup_defaults.toml in user's current working directory
    const setupDefaultsPath = getSetupDefaultsPath();

    if (!fs.existsSync(setupDefaultsPath)) {
      // Ensure the target directory exists
      const targetDir = path.dirname(setupDefaultsPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      this.log(chalk.blue(`Creating setup defaults from embedded template at ${setupDefaultsPath}`));
      fs.writeFileSync(setupDefaultsPath, SETUP_DEFAULTS_TEMPLATE);
    }

    // read existing config file from user's working directory
    const existingConfigStr = fs.readFileSync(setupDefaultsPath, 'utf8');
    const newConfig = toml.parse(existingConfigStr);

    newConfig.network = newDogeConfig.network;

    newConfig.dogecoin_rpc_url = newDogeConfig.rpc?.url || '';
    newConfig.dogecoin_rpc_user = newDogeConfig.rpc?.username || '';
    newConfig.dogecoin_rpc_pass = newDogeConfig.rpc?.password || '';
    newConfig.dogecoin_blockbook_url = newDogeConfig.rpc?.blockbookAPIUrl ||
      (newConfig.network === 'mainnet' ? 'https://dogebook.nownodes.io' :
        newConfig.network === 'testnet' ? 'https://dogebook-testnet.nownodes.io' : 'http://blockbook:19139');
    newConfig.dogecoin_blockbook_api_key = newDogeConfig.rpc?.apiKey || '';

    // Write to setup_defaults.toml
    fs.writeFileSync(setupDefaultsPath, toml.stringify(newConfig));
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(DogeConfigCommand)

    // Create non-interactive and JSON output contexts
    const niCtx = createNonInteractiveContext(
      'setup doge-config',
      flags['non-interactive'],
      flags.json
    )
    const jsonCtx = new JsonOutputContext('setup doge-config', flags.json)

    // Helper for logging
    const log = (msg: string) => jsonCtx.log(msg)
    const initializeTopology = (config: DogeConfig) => this.initializeProofTopology({
      artifactSource: flags['proof-artifact-source'],
      bucket: flags['proof-bucket'],
      compilerBinary: flags['proof-topology-compiler-binary'],
      config,
      coordinatorUrl: flags['proof-coordinator-url'],
      endpointUrl: flags['proof-endpoint-url'],
      forcePathStyle: flags['proof-force-path-style'],
      keyPrefix: flags['proof-key-prefix'],
      log,
      mode: flags['proof-mode'] as 'disabled' | 'mock' | 'production' | undefined,
      nonInteractive: flags['non-interactive'],
      productionWorkerLaunch: flags['production-worker-launch'] as
        | 'external'
        | 'local_cpu'
        | 'local_cuda'
        | undefined,
      publicS3Endpoint: flags['proof-public-s3-endpoint'],
      region: flags['proof-region'],
      releasePath: flags['proof-release'],
      resourcesPersistentVolumeClaim: flags['proof-resources-pvc'],
      resourcesRoot: flags['proof-resources-root'],
      witnessDir: flags['proof-witness-dir'],
      witnessRpcUrl: flags['proof-witness-rpc-url'],
      witnessSource: flags['proof-witness-source'] as 'block_witness_dir' | 'rpc' | undefined,
    })

    if (!fs.existsSync('.data')) {
      fs.mkdirSync('.data', { recursive: true })
    }

    const resolvedPath = flags.config ? path.resolve(flags.config as string) : path.resolve('.data/doge-config.toml')
    const mainConfigPath = path.join(process.cwd(), 'config.toml')
    const legacyMainConfig = this.getLegacyMainConfig()
    const legacyNetwork = this.getLegacyNetwork(legacyMainConfig)
    const legacyEthereumDa = (legacyMainConfig as Record<string, unknown>).ethereumDa as DogeConfig['ethereumDa'] | undefined
    let network: Network = legacyNetwork || 'testnet'

    const configExists = fs.existsSync(resolvedPath)
    let existingConfig: DogeConfig = {} as DogeConfig;

    if (configExists) {
      existingConfig = toml.parse(fs.readFileSync(resolvedPath, 'utf8')) as unknown as DogeConfig
      const existingNetwork = normalizeDogeNetwork(existingConfig.network)
      if (existingConfig.network && !existingNetwork) {
        this.error(`Invalid network in ${resolvedPath}: ${String(existingConfig.network)}. Must be 'mainnet', 'testnet', or 'regtest'.`)
      }

      if ((existingConfig.localSigners as Record<string, unknown> | undefined)?.network) {
        delete (existingConfig.localSigners as Record<string, unknown>).network
      }

      network = existingNetwork || legacyNetwork || network

      if (flags['proof-topology']) {
        if (!existingNetwork) {
          this.error(
            `${resolvedPath} must contain top-level network before proof topology initialization; `
            + 'run scrollsdk setup doge-config once to complete the base configuration',
          )
        }

        const initialized = await initializeTopology(existingConfig)
        existingConfig.proof_topology = initialized.topology
        existingConfig.proof_release = initialized.release
        fs.writeFileSync(resolvedPath, dogeConfigToToml(existingConfig))
        log(chalk.green(`Proof topology saved to ${resolvedPath}`))
        log(chalk.blue(`Proof Mode: ${initialized.topology.mode}`))
        log(chalk.blue(`Proof Release: ${initialized.release.releaseId}`))
        if (flags.json) {
          jsonCtx.success({
            configPath: resolvedPath,
            network: existingNetwork,
            proofTopology: {
              mode: initialized.topology.mode,
              releaseId: initialized.release.releaseId,
            },
          })
        }

        return
      }
    }

    const selectedNetwork = await resolveOrSelect<Network>(
      niCtx,
      () => select({
        choices: [
          { name: 'Dogecoin Testnet', value: 'testnet' },
          { name: 'Dogecoin Mainnet', value: 'mainnet' },
          { name: 'Dogecoin Regtest', value: 'regtest' },
        ],
        default: network,
        message: 'Select the Dogecoin network:',
      }),
      existingConfig.network || legacyNetwork || network,
      ['mainnet', 'testnet', 'regtest'],
      {
        configPath: 'network',
        description: 'Dogecoin network',
        field: 'network',
      },
    ) || network
    network = selectedNetwork

    const defaultConfig: DogeConfig = {
      defaults: {
        dogecoinIndexerStartHeight: '4000000',
        l1GenesisBlock: '4000001',
      },
      dogecoinClusterRpc: {
        password: "",
        username: "",
      },
      ethereumDa: legacyEthereumDa || {
        chain: this.getDefaultEthereumDaChain(network),
        ...ETHEREUM_DA_DEFAULTS[this.getDefaultEthereumDaChain(network)],
      },
      frontend: {},
      network: network as Network,
      rpc: {
        apiKey: '',
        blockbookAPIUrl: resolveBlockbookKubernetesEndpoints({
          kubernetes: existingConfig.kubernetes,
          network: network as Network,
        }).apiUrl,
        password: '',
        url: network === 'mainnet' ? 'https://dogecoin.mainnet.dogeos.com' :
          network === 'testnet' ? 'https://dogecoin.testnet.dogeos.com' : 'http://localhost:18332',
        username: '',
      },
      test: {},
      wallet: {
        path: `.data/doge-wallet-${network}.json`,
      }
    }
    if (!configExists) {
      // In non-interactive mode, always create default config
      const shouldCreate = await resolveConfirm(
        niCtx,
        () => confirm({
          default: true,
          message: `Config file not found at ${resolvedPath}. Would you like to create a default one now?`,
        }),
        true, // In non-interactive, always create
        true
      )

      if (!shouldCreate) {
        throw new Error(`Config file not found at ${resolvedPath}, and not created.`)
      }

      log('Creating a new default Dogecoin configuration file...')

      existingConfig = defaultConfig;
      fs.writeFileSync(resolvedPath, dogeConfigToToml(existingConfig))

      log(
        `Created new default ${network} config file at ${resolvedPath}. You can further customize it with 'scrollsdk setup doge-config'.`,
      )
    }

    const newConfig = existingConfig;
    newConfig.network = network
    if (!newConfig.rpc) {
      newConfig.rpc = {}
    }

    if (!newConfig.defaults) {
      newConfig.defaults = {}
    }

    if (!newConfig.dogecoinClusterRpc) {
      newConfig.dogecoinClusterRpc = {}
    }

    if (!newConfig.wallet) {
      newConfig.wallet = { path: `.data/doge-wallet-${network}.json` }
    }

    // Handle blockbook API URL with confirmation if different from default
    const defaultBlockbookUrl = network === 'mainnet' ? 'https://blockbook.mainnet.dogeos.com/' :
      network === 'testnet' ? 'https://blockbook.testnet.dogeos.com/' : 'http://blockbook:19139'
    const currentBlockbookUrl = existingConfig.rpc?.blockbookAPIUrl || defaultBlockbookUrl

    newConfig.rpc!.blockbookAPIUrl = await resolveOrPrompt(
      niCtx,
      () => input({
        default: currentBlockbookUrl,
        message: `Enter Internal Blockbook API URL:`,
      }),
      existingConfig.rpc?.blockbookAPIUrl || currentBlockbookUrl,
      {
        configPath: '[rpc].blockbookAPIUrl',
        description: 'Internal Blockbook API URL',
        field: 'blockbookAPIUrl',
      },
      false
    ) || currentBlockbookUrl

    newConfig.rpc!.apiKey = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.rpc?.apiKey,
        message: 'Enter your blockbook API key:',
      }),
      resolveEnvValue(existingConfig.rpc?.apiKey),
      {
        configPath: '[rpc].apiKey',
        description: 'Blockbook API key',
        field: 'apiKey',
      },
      false
    ) || ''

    // In non-interactive mode, auto-generate cluster RPC credentials if not set
    const generateClusterRpc: boolean = niCtx.enabled ? (!existingConfig.dogecoinClusterRpc?.username || !existingConfig.dogecoinClusterRpc?.password) : await confirm({
        default: false,
        message: `Do you want to automatically generate secure credentials for your Dogecoin RPC service that will be deployed?\n  (These will be used to authenticate access to your Dogecoin nodes)\n  Choose 'Yes' to auto-generate, 'No' to set manually`,
      })

    if (generateClusterRpc) {
      newConfig.dogecoinClusterRpc!.username = this.generateSecureRandomString(8);
      newConfig.dogecoinClusterRpc!.password = this.generateSecureRandomString(16);
      log(chalk.green(`✓ Generated secure random credentials for Dogecoin cluster RPC`));
    } else {
      newConfig.dogecoinClusterRpc!.username = await resolveOrPrompt(
        niCtx,
        () => input({
          default: existingConfig.dogecoinClusterRpc?.username,
          message: `Enter the username for your Dogecoin RPC service (will be used for authentication):`,
        }),
        existingConfig.dogecoinClusterRpc?.username,
        {
          configPath: '[dogecoinClusterRpc].username',
          description: 'Dogecoin RPC service username',
          field: 'username',
        },
        false
      ) || ''

      newConfig.dogecoinClusterRpc!.password = await resolveOrPrompt(
        niCtx,
        () => input({
          default: existingConfig.dogecoinClusterRpc?.password,
          message: `Enter the password for your Dogecoin RPC service (will be used for authentication):`,
        }),
        resolveEnvValue(existingConfig.dogecoinClusterRpc?.password),
        {
          configPath: '[dogecoinClusterRpc].password',
          description: 'Dogecoin RPC service password (use $ENV:VAR_NAME for secrets)',
          field: 'password',
        },
        false
      ) || ''
    }

    newConfig.wallet!.path = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.wallet?.path,
        message: `Enter the wallet file path:`,
      }),
      existingConfig.wallet?.path,
      {
        configPath: '[wallet].path',
        description: 'Wallet file path',
        field: 'path',
      },
      false
    ) || existingConfig.wallet?.path || ''

    newConfig.rpc!.url = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.rpc?.url || defaultConfig.rpc?.url || '',
        message: `Enter an external dogecoin RPC URL for wallet operations (send/sync):
      `,
      }),
      existingConfig.rpc?.url || defaultConfig.rpc?.url,
      {
        configPath: '[rpc].url',
        description: 'External Dogecoin RPC URL for wallet operations',
        field: 'url',
      },
      false
    ) || existingConfig.rpc?.url || ''

    newConfig.rpc!.username = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.rpc?.username,
        message: `Enter RPC username (leave empty for public RPC endpoints):`,
      }),
      existingConfig.rpc?.username,
      {
        configPath: '[rpc].username',
        description: 'RPC username (optional for public endpoints)',
        field: 'username',
      },
      false
    ) || ''

    newConfig.rpc!.password = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.rpc?.password,
        message: `Enter RPC password (leave empty for public RPC endpoints):`,
      }),
      resolveEnvValue(existingConfig.rpc?.password),
      {
        configPath: '[rpc].password',
        description: 'RPC password (optional, use $ENV:VAR_NAME for secrets)',
        field: 'password',
      },
      false
    ) || ''

    log("testing external dogecoin rpc...")

    // Test RPC connection and get latest block height
    let dogecoinCurrentHeight = 5_000_000;
    try {
      dogecoinCurrentHeight = await this.testRpcConnection(newConfig.rpc!.url!, newConfig.rpc!.username, newConfig.rpc!.password)
      log(chalk.green(`✓ RPC connection test successful! Current block height: ${dogecoinCurrentHeight}`))
    } catch (error) {
      log(chalk.red(`✗ RPC connection test failed: ${error instanceof Error ? error.message : String(error)}`))

      // In non-interactive mode, continue anyway with a warning
      const continueAnyway = await resolveConfirm(
        niCtx,
        () => confirm({
          default: false,
          message: 'RPC connection failed, continue with configuration anyway?'
        }),
        true, // In non-interactive mode, continue with warning
        false
      )

      if (!continueAnyway) {
        this.error('RPC connection failed, configuration cancelled')
        return
      }

      if (niCtx.enabled) {
        jsonCtx.addWarning('Dogecoin RPC connection test failed - configuration continued with warning')
      }
    }

    const existingEthereumDa = newConfig.ethereumDa || legacyEthereumDa || {}
    const existingEthereumDaChain = existingEthereumDa.chain as EthereumDaChain | undefined
    const defaultEthereumDaChain = existingEthereumDaChain || this.getDefaultEthereumDaChain(network)
    const ethereumDaChain = await resolveOrSelect<EthereumDaChain>(
      niCtx,
      () => select({
        choices: [
          { name: 'Sepolia testnet', value: 'sepolia' },
          { name: 'Ethereum mainnet', value: 'mainnet' },
          { name: 'Devnet / private Ethereum chain', value: 'devnet' },
        ],
        default: defaultEthereumDaChain,
        message: 'Select the Ethereum chain used as the DA layer ([ethereumDa].chain):',
      }),
      existingEthereumDa.chain || defaultEthereumDaChain,
      ['mainnet', 'sepolia', 'devnet'],
      {
        configPath: '[ethereumDa].chain',
        description: 'Ethereum DA chain',
        field: 'chain',
      },
    ) || defaultEthereumDaChain
    const ethereumDaDefaults = ETHEREUM_DA_DEFAULTS[ethereumDaChain]
    const shouldReuseExistingEthereumDaValues = niCtx.enabled || existingEthereumDaChain === ethereumDaChain
    const ethereumDaFieldDefault = (field: 'beaconRpcUrl' | 'chainId' | 'submitterRpcUrl') =>
      shouldReuseExistingEthereumDaValues
        ? existingEthereumDa?.[field] || ethereumDaDefaults[field]
        : ethereumDaDefaults[field]

    const ethereumDaSubmitterRpcUrl = normalizeClusterLocalHttpUrl(await resolveOrPrompt(
      niCtx,
      () => input({
        default: ethereumDaFieldDefault('submitterRpcUrl'),
        message: 'Enter the real Ethereum execution JSON-RPC endpoint used by eth-da-submitter ([ethereumDa].submitterRpcUrl):',
      }),
      ethereumDaFieldDefault('submitterRpcUrl'),
      {
        configPath: '[ethereumDa].submitterRpcUrl',
        description: 'Real Ethereum execution JSON-RPC endpoint used by eth-da-submitter',
        field: 'submitterRpcUrl',
      },
    ) || ethereumDaDefaults.submitterRpcUrl)

    const ethereumDaBeaconRpcUrl = normalizeClusterLocalHttpUrl(await resolveOrPrompt(
      niCtx,
      () => input({
        default: ethereumDaFieldDefault('beaconRpcUrl'),
        message: 'Enter the real Ethereum beacon API endpoint used as the DA data source ([ethereumDa].beaconRpcUrl):',
      }),
      ethereumDaFieldDefault('beaconRpcUrl'),
      {
        configPath: '[ethereumDa].beaconRpcUrl',
        description: 'Real Ethereum beacon API endpoint used as the DA data source',
        field: 'beaconRpcUrl',
      },
    ) || ethereumDaDefaults.beaconRpcUrl)

    const ethereumDaChainId = await resolveOrPrompt(
      niCtx,
      () => input({
        default: ethereumDaFieldDefault('chainId'),
        message: 'Enter the real Ethereum DA execution chain ID ([ethereumDa].chainId):',
      }),
      ethereumDaFieldDefault('chainId'),
      {
        configPath: '[ethereumDa].chainId',
        description: 'Real Ethereum DA execution chain ID',
        field: 'chainId',
      },
    ) || ethereumDaDefaults.chainId

    newConfig.ethereumDa = {
      beaconRpcUrl: ethereumDaBeaconRpcUrl,
      chain: ethereumDaChain,
      chainId: ethereumDaChainId,
      minFinality: ethereumDaDefaults.minFinality,
      submitterRpcUrl: ethereumDaSubmitterRpcUrl,
    }

    newConfig.defaults!.dogecoinIndexerStartHeight = existingConfig.defaults?.dogecoinIndexerStartHeight || String(dogecoinCurrentHeight)
    const indexerStartHeight = Number(newConfig.defaults!.dogecoinIndexerStartHeight)
    newConfig.defaults!.l1GenesisBlock = existingConfig.defaults?.l1GenesisBlock ||
      String(Number.isFinite(indexerStartHeight) ? Math.max(0, indexerStartHeight + 1) : 0)
    log(chalk.blue(`Dogecoin Indexer Start Height: ${newConfig.defaults!.dogecoinIndexerStartHeight}`))
    log(chalk.blue(`L1 Genesis Block: ${newConfig.defaults!.l1GenesisBlock}`))

    const initializeProofTopology = flags['proof-topology'] || (
      !flags['non-interactive']
      && !newConfig.proof_topology
      && await confirm({
        default: false,
        message: 'Configure staged disabled/mock/production proof topology now?',
      })
    )
    if (initializeProofTopology) {
      const initialized = await initializeTopology(newConfig)
      newConfig.proof_topology = initialized.topology
      newConfig.proof_release = initialized.release
    }

    // Validate any missing required fields before proceeding
    validateAndExit(niCtx)

    const mainConfig = toml.parse(fs.readFileSync(mainConfigPath, 'utf8')) as JsonMap
    if (!mainConfig.general) mainConfig.general = {}
    const generalConfig = mainConfig.general as JsonMap
    generalConfig.L1_CONTRACT_DEPLOYMENT_BLOCK = newConfig.defaults!.dogecoinIndexerStartHeight
    if (writeConfigs(mainConfig, undefined, undefined, flags.json)) {
      log(
        chalk.green(`L1_CONTRACT_DEPLOYMENT_BLOCK updated in config.toml`),
      )
    }

    const configDir = path.dirname(resolvedPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }

    fs.writeFileSync(resolvedPath, dogeConfigToToml(newConfig))
    this.removeLegacyDogeConfigFromMainConfig(mainConfigPath, flags.json, log)

    log(chalk.green(`\nConfiguration for ${newConfig.network} network saved to ${resolvedPath}`))
    log(chalk.blue('\nConfiguration Summary:'))
    log(chalk.blue(`Network: ${newConfig.network}`))
    log(chalk.blue(`RPC URL: ${newConfig.rpc!.url}`))
    log(chalk.blue(`Blockbook API URL: ${newConfig.rpc!.blockbookAPIUrl}`))
    log(chalk.blue(`Wallet Path: ${newConfig.wallet.path}`))
    if (newConfig.proof_topology) {
      log(chalk.blue(`Proof Mode: ${newConfig.proof_topology.mode}`))
      if (newConfig.proof_release) {
        log(chalk.blue(`Proof Release: ${newConfig.proof_release.releaseId}`))
      }
    }

    await this.generateSetupDefaultsToml(newConfig)

    // Output JSON response on success
    if (flags.json) {
      jsonCtx.success({
        configPath: resolvedPath,
        defaults: {
          dogecoinIndexerStartHeight: newConfig.defaults!.dogecoinIndexerStartHeight,
          l1GenesisBlock: newConfig.defaults!.l1GenesisBlock,
        },
        ethereumDa: newConfig.ethereumDa,
        network: newConfig.network,
        ...(newConfig.proof_topology
          ? {
              proofTopology: {
                mode: newConfig.proof_topology.mode,
                releaseId: newConfig.proof_release?.releaseId,
              },
            }
          : {}),
        rpc: {
          blockbookAPIUrl: newConfig.rpc!.blockbookAPIUrl,
          url: newConfig.rpc!.url,
        },
        wallet: {
          path: newConfig.wallet.path,
        },
      })
    }
  }

  private generateSecureRandomString(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let result = ''
    const randomBytes = crypto.randomBytes(length)

    for (let i = 0; i < length; i++) {
      result += chars[randomBytes[i] % chars.length]
    }

    return result
  }

  private getDefaultEthereumDaChain(network: Network): EthereumDaChain {
    if (network === 'mainnet') return 'mainnet'
    if (network === 'regtest') return 'devnet'
    return 'sepolia'
  }

  private getLegacyMainConfig(): JsonMap {
    const mainConfigPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(mainConfigPath)) return {} as JsonMap

    return toml.parse(fs.readFileSync(mainConfigPath, 'utf8')) as JsonMap
  }

  private getLegacyNetwork(mainConfig: JsonMap): Network | undefined {
    const { dogecoin } = mainConfig as Record<string, unknown>
    if (!dogecoin || typeof dogecoin !== 'object' || Array.isArray(dogecoin)) return undefined
    return normalizeDogeNetwork((dogecoin as Record<string, unknown>).network)
  }

  // The wizard deliberately keeps all prompt/default branches in one atomic flow.
  // eslint-disable-next-line complexity
  private async initializeProofTopology(
    options: InitializeProofTopologyOptions,
  ): Promise<InitializedProofTopology> {
    const deploymentDir = process.cwd()
    const existing = options.config.proof_topology
    let manifestPath = discoverProofRelease(
      deploymentDir,
      options.releasePath || options.config.proof_release?.manifestPath,
    )
    if (!manifestPath && !options.nonInteractive) {
      manifestPath = path.resolve(deploymentDir, await input({
        default: '.data/proof-release-v1.json',
        message: 'Enter the dogeos/proof-release/v1 manifest path:',
      }))
    }

    if (!manifestPath) {
      throw new Error(
        'No proof release manifest was found. Place the release-producer '
        + 'proof-release-v1.json at .data/proof-release-v1.json or pass --proof-release.',
      )
    }

    const release = readProofRelease(manifestPath)
    const manifestSha256 = proofReleaseManifestSha256(manifestPath)
    options.log(chalk.blue(`Using proof release ${release.releaseId} from ${manifestPath}`))
    const proofAws = readOptionalProofAwsConfig(deploymentDir)
    const availableArtifactSources = [
      ...(proofAws ? [{name: 'Prepared resources from .data/proof-aws.json', value: 'prepared-aws'}] : []),
      {name: 'Existing S3-compatible store', value: 'existing-s3'},
    ]
    const artifactSource = options.artifactSource || (
      options.nonInteractive
        ? proofAws ? 'prepared-aws' : 'existing-s3'
        : await select({
            choices: availableArtifactSources,
            default: proofAws ? 'prepared-aws' : 'existing-s3',
            message: 'Select the proof artifact resource source:',
          })
    )
    if (artifactSource === 'prepared-aws' && !proofAws) {
      throw new Error(
        '--proof-artifact-source=prepared-aws requires .data/proof-aws.json; '
        + 'run scrollsdk setup proof-aws-init first',
      )
    }

    const currentStore = existing?.production?.artifactStore
    let artifactStore: ProofTopologyArtifactStoreConfig
    if (artifactSource === 'prepared-aws') {
      const prepared = proofAws!.config.artifactStore
      artifactStore = {
        bucket: prepared.bucket,
        endpointUrl: options.endpointUrl || awsS3Endpoint(prepared.region),
        forcePathStyle: false,
        keyPrefix: prepared.keyPrefix,
        kind: 's3_compatible',
        maxReadBodyBytes: 512 * 1024 * 1024,
        region: prepared.region,
      }
      options.log(
        chalk.blue(
          `Using prepared proof artifact store s3://${prepared.bucket}/${prepared.keyPrefix} `
          + `with partner endpoint ${proofAws!.config.artifactReadTransport.publicEndpointUrl}`,
        ),
      )
    } else {
      const requiredInput = async (
        configured: string | undefined,
        message: string,
        label: string,
      ): Promise<string> => {
        if (options.nonInteractive) {
          if (!configured?.trim()) throw new Error(`${label} is required in non-interactive mode`)
          return configured.trim()
        }

        return input({
          default: configured,
          message,
          validate: value => value.trim() ? true : `${label} must not be empty`,
        })
      }

      const bucket = await requiredInput(
        options.bucket || currentStore?.bucket,
        'Enter the proof artifact bucket:',
        '--proof-bucket',
      )
      const region = await requiredInput(
        options.region || currentStore?.region,
        'Enter the proof artifact region:',
        '--proof-region',
      )
      artifactStore = {
        bucket,
        endpointUrl: await requiredInput(
          options.endpointUrl || currentStore?.endpointUrl || awsS3Endpoint(region),
          'Enter the Worker-visible S3-compatible endpoint root:',
          '--proof-endpoint-url',
        ),
        forcePathStyle: options.forcePathStyle || currentStore?.forcePathStyle || false,
        keyPrefix: await requiredInput(
          options.keyPrefix || currentStore?.keyPrefix || 'proof-topology',
          'Enter the base proof artifact key prefix:',
          '--proof-key-prefix',
        ),
        kind: 's3_compatible',
        maxReadBodyBytes: currentStore?.maxReadBodyBytes || 512 * 1024 * 1024,
        region,
      }
    }

    const mode = options.mode || existing?.mode || 'disabled'
    const selectedMode = options.nonInteractive
      ? mode
      : await select({
          choices: [
            {name: 'disabled (prepare resources without running proof services)', value: 'disabled'},
            {name: 'mock', value: 'mock'},
            {name: 'production', value: 'production'},
          ],
          default: mode,
          message: 'Select the initial proof mode:',
        }) as 'disabled' | 'mock' | 'production'
    const currentLaunch = existing?.production?.workerLaunch
    const launch = options.productionWorkerLaunch || currentLaunch || 'external'
    const productionWorkerLaunch = options.nonInteractive
      ? launch
      : await select({
          choices: [
            {name: 'External GPU server', value: 'external'},
            {name: 'Kubernetes CUDA node', value: 'local_cuda'},
            {name: 'Kubernetes CPU node', value: 'local_cpu'},
          ],
          default: launch,
          message: 'Select the production Worker placement:',
        }) as 'external' | 'local_cpu' | 'local_cuda'

    const currentReal = existing?.production?.realScroll
    const resourcesRoot = options.resourcesRoot
      || currentReal?.resourcesRoot
      || 'proof-artifacts'
    const resourcesPersistentVolumeClaim = options.resourcesPersistentVolumeClaim
      || existing?.deployment?.resourcesPersistentVolumeClaim
      || 'dogeos-proof-release'
    options.log(
      chalk.blue(
        `Using release materials from ${resourcesRoot}; Kubernetes services will mount `
        + `the pre-populated PVC ${resourcesPersistentVolumeClaim} read-only`,
      ),
    )

    const defaultWitnessSource = options.witnessSource
      || currentReal?.chunkWitnessSource
      || (fs.existsSync(path.resolve(deploymentDir, resourcesRoot, 'witnesses'))
        ? 'block_witness_dir'
        : options.config.rpc?.l2Url
          ? 'rpc'
          : 'block_witness_dir')
    const witnessSource = options.nonInteractive
      ? defaultWitnessSource
      : await select({
          choices: [
            {name: 'Prepared block witness directory', value: 'block_witness_dir'},
            {name: 'Scroll witness RPC', value: 'rpc'},
          ],
          default: defaultWitnessSource,
          message: 'Select the production chunk witness source:',
        }) as 'block_witness_dir' | 'rpc'
    let witnessDir: string | undefined
    let witnessRpcUrl: string | undefined
    if (witnessSource === 'block_witness_dir') {
      const current = options.witnessDir || currentReal?.chunkBlockWitnessDir || 'witnesses'
      witnessDir = options.nonInteractive
        ? current
        : await input({
            default: current,
            message: 'Enter the block witness directory relative to the release resources root:',
          })
    } else {
      const current = options.witnessRpcUrl
        || currentReal?.chunkWitnessRpcUrl
        || options.config.rpc?.l2Url
      if (options.nonInteractive && !current) {
        throw new Error('--proof-witness-rpc-url is required for RPC witness input')
      }

      witnessRpcUrl = options.nonInteractive
        ? current
        : await input({
            default: current,
            message: 'Enter the Scroll witness RPC URL:',
            validate: value => value.trim() ? true : 'Witness RPC URL must not be empty',
          })
    }

    const currentCoordinatorUrl = options.coordinatorUrl
      || existing?.deployment?.proverPublicUrl
      || this.proofCoordinatorUrlFromMainConfig()
      || (productionWorkerLaunch === 'external' ? undefined : 'http://proof-coordinator:7788')
    if (options.nonInteractive && !currentCoordinatorUrl) {
      throw new Error(
        '--proof-coordinator-url or config.toml [ingress].PROOF_COORDINATOR_HOST is required '
        + 'for an external production Worker',
      )
    }

    const coordinatorUrl = options.nonInteractive
      ? currentCoordinatorUrl
      : await input({
          default: currentCoordinatorUrl,
          message: productionWorkerLaunch === 'external'
            ? 'Enter the Proof Coordinator URL reachable from the external Worker:'
            : 'Enter the Proof Coordinator service URL:',
          validate: value => value.trim() ? true : 'Proof Coordinator URL must not be empty',
        })
    const publicS3Endpoint = options.publicS3Endpoint
      || currentReal?.s3PublicEndpointUrl
      || (artifactSource === 'prepared-aws'
        ? proofAws!.config.artifactReadTransport.publicEndpointUrl
        : undefined)
      || artifactStore.endpointUrl
    const topology = buildProofTopologyFromRelease({
      artifactStore,
      deploymentDir,
      deploymentName: `dogeos-${options.config.network}`,
      mode: selectedMode,
      productionWorkerLaunch,
      release,
      runtime: {
        ...(witnessDir ? {blockWitnessDir: witnessDir} : {}),
        proofCoordinatorPublicUrl: coordinatorUrl,
        ...(publicS3Endpoint ? {publicS3EndpointUrl: publicS3Endpoint} : {}),
        resourcesPersistentVolumeClaim,
        resourcesRoot,
        ...(witnessRpcUrl ? {rpcWitnessUrl: witnessRpcUrl} : {}),
        ...(existing?.deployment?.workerNodeSelector
          ? {workerNodeSelector: existing.deployment.workerNodeSelector}
          : {}),
        ...(existing?.deployment?.workerTolerations
          ? {workerTolerations: existing.deployment.workerTolerations}
          : {}),
        ...(existing?.deployment?.workerSecretName
          ? {workerSecretName: existing.deployment.workerSecretName}
          : {}),
        ...(productionWorkerLaunch === 'local_cuda'
          ? {
              workerResources: existing?.deployment?.workerResources || {
                limits: {'nvidia.com/gpu': 1},
                requests: {'nvidia.com/gpu': 1},
              },
              workerRuntimeClassName:
                existing?.deployment?.workerRuntimeClassName || 'nvidia',
            }
          : {}),
        witnessSource,
      },
    })

    await this.preflightProofTopology(
      topology,
      options.config,
      options.log,
      options.compilerBinary,
    )
    const currentManifestSha256 = proofReleaseManifestSha256(manifestPath)
    if (currentManifestSha256 !== manifestSha256) {
      throw new Error(
        `proof release manifest changed during initialization: ${manifestPath}; rerun preflight`,
      )
    }

    verifyProofTopologyReleaseBinding(topology, release, deploymentDir)
    const manifestRelative = path.relative(deploymentDir, manifestPath)
    const storedManifestPath = manifestRelative === '..'
      || manifestRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(manifestRelative)
      ? manifestPath
      : manifestRelative.replaceAll(path.sep, '/')
    return {
      release: {
        manifestPath: storedManifestPath,
        manifestSha256,
        releaseId: release.releaseId,
      },
      topology,
    }
  }

  private async preflightProofTopology(
    topology: ProofTopologySpec,
    config: DogeConfig,
    log: (message: string) => void,
    compilerBinary?: string,
  ): Promise<void> {
    const deploymentDir = process.cwd()
    const dogecoin = resolveDogecoinKubernetesEndpoints({
      kubernetes: config.kubernetes,
      network: config.network,
    })
    const clusterRpc = config.dogecoinClusterRpc || {}
    for (const mode of ['mock', 'production'] as const) {
      const output = `.data/generated/.proof-topology-init-preflight-${mode}-${process.pid}`
      try {
        const preflightTopology = compilerBinary
          ? {
              ...topology,
              deployment: {
                ...topology.deployment,
                resourcesMountPath: path.resolve(
                  deploymentDir,
                  topology.production!.realScroll.resourcesRoot,
                ),
              },
            }
          : topology
        compileProofTopology({
          bridge: {
            dogecoinNetwork: config.network,
            dogecoinRpcPassword: clusterRpc.password || '',
            dogecoinRpcUrl: dogecoin.rpcUrl,
            dogecoinRpcUser: clusterRpc.username || '',
          },
          compilerBinary,
          deploymentDir,
          deploymentName: `dogeos-${config.network}`,
          ethereumL1RpcUrl: config.ethereumDa?.submitterRpcUrl,
          network: config.network,
          outputDir: output,
          preflightMode: mode,
          proofTopology: preflightTopology,
        })
        log(chalk.green(`Proof topology ${mode} preflight passed`))
      } finally {
        fs.rmSync(path.resolve(deploymentDir, output), {force: true, recursive: true})
      }
    }
  }

  private proofCoordinatorUrlFromMainConfig(): string | undefined {
    const mainConfigPath = path.resolve('config.toml')
    if (!fs.existsSync(mainConfigPath)) return undefined
    const config = toml.parse(fs.readFileSync(mainConfigPath, 'utf8')) as JsonMap
    const {ingress} = config
    if (!ingress || typeof ingress !== 'object' || Array.isArray(ingress)) return undefined
    const host = (ingress as JsonMap).PROOF_COORDINATOR_HOST
    return typeof host === 'string' && host.trim() ? `https://${host.trim()}` : undefined
  }

  private removeLegacyDogeConfigFromMainConfig(mainConfigPath: string, jsonMode: boolean, log: (msg: string) => void): void {
    if (!fs.existsSync(mainConfigPath)) return

    const mainConfig = toml.parse(fs.readFileSync(mainConfigPath, 'utf8')) as JsonMap
    let changed = false
    if ((mainConfig as Record<string, unknown>).dogecoin !== undefined) {
      delete (mainConfig as Record<string, unknown>).dogecoin
      changed = true
    }

    if ((mainConfig as Record<string, unknown>).ethereumDa !== undefined) {
      delete (mainConfig as Record<string, unknown>).ethereumDa
      changed = true
    }

    if (changed && writeConfigs(mainConfig, undefined, undefined, jsonMode)) {
      log(chalk.green('Moved [dogecoin] and [ethereumDa] settings out of config.toml'))
    }
  }

  // Helper methods for common operations


  private async testRpcConnection(rpcUrl: string, username?: string, password?: string): Promise<number> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    // Handle different RPC URL formats
    if (rpcUrl.includes('nownodes.io')) {
      // NowNodes API format - use getblock API
      const infoUrl = `${rpcUrl.replace(/\/$/, '')}/`

      const response = await fetch(infoUrl, {
        headers,
        method: 'GET'
      })

      if (!response.ok) {
        throw new Error(`blockbook API connection failed: ${response.status} ${response.statusText}`)
      }

      const result = await response.json() as { blockbook: { bestHeight: number } }
      if (result.blockbook && typeof result.blockbook.bestHeight === 'number') {
        return result.blockbook.bestHeight
      }
 
        throw new Error('Unable to get block height from blockbook API')
      
    } else {
      // Standard Dogecoin RPC format
      if (username && password) {
        const credentials = Buffer.from(`${username}:${password}`).toString('base64')
        headers.Authorization = `Basic ${credentials}`
      }

      const body = JSON.stringify({
        id: 'test',
        jsonrpc: '1.0',
        method: 'getblockcount',
        params: [],
      })

      const response = await fetch(rpcUrl, {
        body,
        headers,
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error(`RPC connection failed: ${response.status} ${response.statusText}`)
      }

      const result = await response.json() as { error?: { code: number; message: string }; result?: number }

      if (result.error) {
        throw new Error(`RPC error: ${result.error.message} (Code: ${result.error.code})`)
      }

      if (typeof result.result === 'number') {
        return result.result
      }

      throw new Error('RPC response did not contain valid block height')
    }
  }
}

export default DogeConfigCommand
