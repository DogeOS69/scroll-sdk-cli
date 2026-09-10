import type { JsonMap } from '@iarna/toml'

import * as toml from '@iarna/toml'
import { confirm, input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { DogeConfig } from '../../types/doge-config.js'
import type {
  ProofTopologyArtifactStoreConfig,
  ProofTopologySpec,
} from '../../types/proof-topology.js'

import { SETUP_DEFAULTS_TEMPLATE, getSetupDefaultsPath } from '../../config/constants.js'
import { Network } from '../../types/doge-config.js'
import { writeConfigs } from '../../utils/config-writer.js'
import {
  dogeConfigToToml,
  normalizeDogeNetwork,
} from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {sanitizeName} from '../../utils/kms-signer-provisioner.js'
import {
  resolveDogecoinServiceRpcUrl,
} from '../../utils/kubernetes-endpoints.js'
import {
  createNonInteractiveContext,
  resolveConfirm,
  resolveEnvValue,
  resolveFlagOrPrompt,
  resolveOrPrompt,
  resolveOrSelect,
  validateAndExit,
} from '../../utils/non-interactive.js'
import {readOptionalProofAwsConfig} from '../../utils/proof-aws-config.js'
import {
  DEFAULT_PROOF_MATERIALS_RECEIPT,
  readProofMaterials,
} from '../../utils/proof-materials.js'
import {
  compileProofTopology,
  proofTopologyEthereumDaBlobSource,
} from '../../utils/proof-topology-compiler.js'
import {
  awsS3Endpoint,
  buildProofTopology,
} from '../../utils/proof-topology-init.js'
import {stripRetiredServiceConfig} from '../../utils/retired-services.js'

type EthereumDaChain = 'devnet' | 'mainnet' | 'sepolia'

interface InitializeProofTopologyV2Options {
  artifactSource?: string
  bucket?: string
  compilerBinary?: string
  config: DogeConfig
  coordinatorUrl?: string
  endpointUrl?: string
  enforcement?: 'enforce' | 'observe'
  forcePathStyle?: boolean
  generation?: 'mock' | 'real'
  keyPrefix?: string
  log: (message: string) => void
  materialsPath?: string
  mode?: 'active' | 'disabled'
  nonInteractive: boolean
  observeRealProofDeadlineMs?: number
  publicS3Endpoint?: string
  region?: string
  witnessDir?: string
  witnessRpcUrl?: string
  witnessSource?: 'block_witness_dir' | 'rpc'
  workerDeploymentBackend?: 'docker_compose' | 'kubernetes'
  workerLaunch?: 'external' | 'local_cpu' | 'local_cuda'
}

interface InitializedProofTopology {
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
    '$ scrollsdk setup doge-config --proof-topology --proof-mode disabled --proof-generation mock --proof-enforcement observe',
    '$ scrollsdk setup doge-config --proof-topology --proof-mode active --proof-generation mock',
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
      description: 'HTTPS Proof Coordinator URL reachable by production Workers',
    }),
    'proof-endpoint-url': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Worker-visible S3-compatible endpoint root',
    }),
    'proof-enforcement': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Proof enforcement switch; keep observe until real proofs are validated',
      options: ['observe', 'enforce'],
    }),
    'proof-force-path-style': Flags.boolean({
      allowNo: true,
      dependsOn: ['proof-topology'],
      description: 'Use path-style S3 object URLs for an existing compatible store',
    }),
    'proof-generation': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Proof generation implementation selected for active services',
      options: ['mock', 'real'],
    }),
    'proof-key-prefix': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Base proof artifact key prefix before compiler digest scoping',
    }),
    'proof-materials': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Prepared proof-materials-v1.json receipt',
    }),
    'proof-mode': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Initial proof mode (default: existing value or disabled)',
      options: ['active', 'disabled'],
    }),
    'proof-observe-real-proof-deadline-ms': Flags.integer({
      dependsOn: ['proof-topology'],
      description: 'Required positive observe fallback deadline in milliseconds; also required for mock (no default)',
      min: 1,
    }),
    'proof-public-s3-endpoint': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'External Worker/signer-visible S3 endpoint when different from the store endpoint',
    }),
    'proof-region': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Existing S3-compatible proof artifact region',
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
      description: 'Production block witness directory relative to the prepared material root',
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
    'proof-worker-deployment-backend': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Deployment adapter backend for local_cpu/local_cuda Workers',
      options: ['docker_compose', 'kubernetes'],
    }),
    'proof-worker-launch': Flags.string({
      dependsOn: ['proof-topology'],
      description: 'Staged real Worker compute/ownership placement from the dogeos-core contract',
      options: ['external', 'local_cpu', 'local_cuda'],
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
    const newConfig = stripRetiredServiceConfig(toml.parse(existingConfigStr));

    newConfig.network = newDogeConfig.network;

    newConfig.dogecoin_rpc_url = newDogeConfig.rpc?.url || '';
    newConfig.dogecoin_rpc_user = newDogeConfig.rpc?.username || '';
    newConfig.dogecoin_rpc_pass = newDogeConfig.rpc?.password || '';
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
    const initializeTopology = (config: DogeConfig) => this.initializeProofTopologyV2({
      artifactSource: flags['proof-artifact-source'],
      bucket: flags['proof-bucket'],
      compilerBinary: flags['proof-topology-compiler-binary'],
      config,
      coordinatorUrl: flags['proof-coordinator-url'],
      endpointUrl: flags['proof-endpoint-url'],
      enforcement: flags['proof-enforcement'] as 'enforce' | 'observe' | undefined,
      forcePathStyle: flags['proof-force-path-style'],
      generation: flags['proof-generation'] as 'mock' | 'real' | undefined,
      keyPrefix: flags['proof-key-prefix'],
      log,
      materialsPath: flags['proof-materials'],
      mode: flags['proof-mode'] as 'active' | 'disabled' | undefined,
      nonInteractive: flags['non-interactive'],
      observeRealProofDeadlineMs: flags['proof-observe-real-proof-deadline-ms'],
      publicS3Endpoint: flags['proof-public-s3-endpoint'],
      region: flags['proof-region'],
      witnessDir: flags['proof-witness-dir'],
      witnessRpcUrl: flags['proof-witness-rpc-url'],
      witnessSource: flags['proof-witness-source'] as 'block_witness_dir' | 'rpc' | undefined,
      workerDeploymentBackend: flags['proof-worker-deployment-backend'] as
        | 'docker_compose'
        | 'kubernetes'
        | undefined,
      workerLaunch: flags['proof-worker-launch'] as
        | 'external'
        | 'local_cpu'
        | 'local_cuda'
        | undefined,
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
        if ((existingConfig as Record<string, unknown>).proofSystem !== undefined) {
          delete (existingConfig as Record<string, unknown>).proofSystem
          log(chalk.blue('Removed retired [proofSystem] after installing [proof_topology]'))
        }

        existingConfig.proof_topology = initialized.topology
        fs.writeFileSync(resolvedPath, dogeConfigToToml(existingConfig))
        log(chalk.green(`Proof topology saved to ${resolvedPath}`))
        log(chalk.blue(`Proof Mode: ${initialized.topology.mode}`))
        log(chalk.blue(`Proof Generation: ${initialized.topology.generation}`))
        log(chalk.blue(`Proof Enforcement: ${initialized.topology.enforcement}`))

        if (flags.json) {
          jsonCtx.success({
            configPath: resolvedPath,
            network: existingNetwork,
            proofTopology: {
              enforcement: initialized.topology.enforcement,
              generation: initialized.topology.generation,
              mode: initialized.topology.mode,
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
    // TOML permits an integer chainId; text prompts and environment references
    // require strings in both interactive and non-interactive setup.
    const ethereumDaFieldDefault = (field: 'beaconRpcUrl' | 'chainId' | 'submitterRpcUrl') =>
      String(shouldReuseExistingEthereumDaValues
        ? existingEthereumDa?.[field] || ethereumDaDefaults[field]
        : ethereumDaDefaults[field])

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
        message: 'Configure the compiler-backed proof topology now?',
      })
    )
    if (initializeProofTopology) {
      const initialized = await initializeTopology(newConfig)
      newConfig.proof_topology = initialized.topology
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
    log(chalk.blue(`Wallet Path: ${newConfig.wallet.path}`))
    if (newConfig.proof_topology) {
      log(chalk.blue(`Proof Mode: ${newConfig.proof_topology.mode}`))
      log(chalk.blue(`Proof Generation: ${newConfig.proof_topology.generation}`))
      log(chalk.blue(`Proof Enforcement: ${newConfig.proof_topology.enforcement}`))
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
                enforcement: newConfig.proof_topology.enforcement,
                generation: newConfig.proof_topology.generation,
                mode: newConfig.proof_topology.mode,
              },
            }
          : {}),
        rpc: {
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

  private async initializeProofTopologyV2(
    options: InitializeProofTopologyV2Options,
  ): Promise<InitializedProofTopology> {
    const deploymentDir = process.cwd()
    const existing = options.config.proof_topology
    const receiptPath = path.resolve(
      deploymentDir,
      options.materialsPath || DEFAULT_PROOF_MATERIALS_RECEIPT,
    )
    if (!fs.existsSync(receiptPath)) {
      throw new Error(
        `No prepared proof materials were found at ${receiptPath}. `
        + 'Run scrollsdk setup proof-materials first, or pass --proof-materials.',
      )
    }

    const materials = readProofMaterials(receiptPath, deploymentDir)
    options.log(chalk.blue(
      `Using validated proof materials from ${path.relative(deploymentDir, receiptPath)}`,
    ))

    const proofAws = readOptionalProofAwsConfig(deploymentDir)
    const deploymentAlias = sanitizeName(
      proofAws?.config.kubernetes.deploymentAlias || path.basename(deploymentDir),
    )
    const deploymentName = deploymentAlias.startsWith('dogeos-')
      ? deploymentAlias
      : `dogeos-${deploymentAlias}`
    const artifactSource = await resolveFlagOrPrompt(
      options.artifactSource,
      options.nonInteractive,
      proofAws ? 'prepared-aws' : 'existing-s3',
      () => select({
        choices: [
          ...(proofAws ? [{name: 'Prepared resources from .data/proof-aws.json', value: 'prepared-aws'}] : []),
          {name: 'Existing S3-compatible store', value: 'existing-s3'},
        ],
        default: proofAws ? 'prepared-aws' : 'existing-s3',
        message: 'Select the proof artifact resource source:',
      }),
    )
    if (artifactSource === 'prepared-aws' && !proofAws) {
      throw new Error('prepared-aws requires .data/proof-aws.json; run scrollsdk setup proof-aws-init first')
    }

    const required = async (
      explicit: string | undefined,
      defaultValue: string | undefined,
      message: string,
      flag: string,
    ): Promise<string> => {
      const selected = await resolveFlagOrPrompt(
        explicit,
        options.nonInteractive,
        defaultValue,
        () => input({
          default: defaultValue,
          message,
          validate: value => value.trim() ? true : `${flag} is required`,
        }),
      )
      if (!selected?.trim()) throw new Error(`${flag} is required`)
      return selected.trim()
    }

    const currentStore = existing?.active?.artifactStore
    let store: ProofTopologyArtifactStoreConfig
    let keyPrefix: string
    let publicEndpoint: string | undefined
    if (artifactSource === 'prepared-aws') {
      const prepared = proofAws!.config
      store = {
        bucket: prepared.artifactStore.bucket,
        endpointUrl: options.endpointUrl || awsS3Endpoint(prepared.artifactStore.region),
        forcePathStyle: false,
        kind: 's3_compatible',
        maxReadBodyBytes: 512 * 1024 * 1024,
        region: prepared.artifactStore.region,
      }
      keyPrefix = options.keyPrefix || prepared.artifactStore.keyPrefix
      publicEndpoint = options.publicS3Endpoint
        || prepared.artifactReadTransport.publicEndpointUrl
      options.log(chalk.blue(
        `Using s3://${store.bucket}/${keyPrefix} with external endpoint ${publicEndpoint}`,
      ))
    } else {
      const region = await required(options.region, currentStore?.region, 'Enter the proof artifact region:', '--proof-region')
      store = {
        bucket: await required(options.bucket, currentStore?.bucket, 'Enter the proof artifact bucket:', '--proof-bucket'),
        endpointUrl: await required(options.endpointUrl, currentStore?.endpointUrl || awsS3Endpoint(region), 'Enter the S3-compatible endpoint root:', '--proof-endpoint-url'),
        forcePathStyle: options.forcePathStyle ?? currentStore?.forcePathStyle ?? false,
        kind: 's3_compatible',
        maxReadBodyBytes: currentStore?.maxReadBodyBytes || 512 * 1024 * 1024,
        region,
      }
      keyPrefix = await required(options.keyPrefix, existing?.deployment.artifactKeyPrefix || 'proof-topology', 'Enter the proof artifact key prefix:', '--proof-key-prefix')
      publicEndpoint = options.publicS3Endpoint || store.endpointUrl
    }

    const mode = await resolveFlagOrPrompt(
      options.mode,
      options.nonInteractive,
      existing?.mode === 'active' || existing?.mode === 'disabled' ? existing.mode : 'disabled',
      () => select({
        choices: [
          {name: 'disabled (proof services off)', value: 'disabled'},
          {name: 'active (generate proofs)', value: 'active'},
        ],
        default: existing?.mode === 'active' ? 'active' : 'disabled',
        message: 'Should proof generation services be active?',
      }),
    ) as 'active' | 'disabled'
    const generation = await resolveFlagOrPrompt(
      options.generation,
      options.nonInteractive,
      existing?.generation || 'mock',
      () => select({
        choices: [
          {name: 'mock (non-cryptographic development proofs)', value: 'mock'},
          ...(materials.bridge && materials.software.artifacts && materials.images.productionWorker
            ? [{name: 'real (cryptographic production proofs)', value: 'real'}]
            : []),
        ],
        default: existing?.generation || 'mock',
        message: 'Select the proof generation implementation:',
      }),
    ) as 'mock' | 'real'
    if (generation === 'real' && (!materials.bridge || !materials.software.artifacts || !materials.images.productionWorker)) {
      throw new Error('real generation requires full software/Bridge materials and a production Worker image; rerun setup proof-materials --generation real')
    }

    const enforcement = await resolveFlagOrPrompt(
      options.enforcement,
      options.nonInteractive,
      existing?.enforcement || 'observe',
      () => select({
        choices: [
          {name: 'observe (generate and validate without gating service behavior)', value: 'observe'},
          ...(mode === 'active' && generation === 'real'
            ? [{name: 'enforce (require validated real proofs)', value: 'enforce'}]
            : []),
        ],
        default: existing?.enforcement || 'observe',
        message: 'Select proof enforcement:',
      }),
    ) as 'enforce' | 'observe'
    if (enforcement === 'enforce' && (mode !== 'active' || generation !== 'real')) {
      throw new Error('proof enforcement can be enabled only after active real proving is validated')
    }

    const coordinatorUrl = await required(
      options.coordinatorUrl,
      existing?.deployment.proverPublicUrl || this.proofCoordinatorUrlFromMainConfig(),
      'Enter the HTTPS Proof Coordinator URL reachable from proof Workers:',
      '--proof-coordinator-url',
    )
    const workerLaunch = await resolveFlagOrPrompt(
      options.workerLaunch,
      options.nonInteractive,
      existing?.active?.workerLaunch || 'external',
      () => select({
        choices: [
          {name: 'External server when generation becomes real', value: 'external'},
          {name: 'Adapter-managed CUDA Worker when generation becomes real', value: 'local_cuda'},
          {name: 'Adapter-managed CPU Worker when generation becomes real', value: 'local_cpu'},
        ],
        default: existing?.active?.workerLaunch || 'external',
        message: 'Select the staged real Worker compute/ownership placement:',
      }),
    ) as 'external' | 'local_cpu' | 'local_cuda'
    const workerDeploymentBackend = await resolveFlagOrPrompt(
      options.workerDeploymentBackend,
      options.nonInteractive,
      existing?.deployment.workerDeploymentBackend || 'docker_compose',
      () => select({
        choices: [
          {name: 'Docker Compose bundle (for an adapter-managed server such as EC2)', value: 'docker_compose'},
          {name: 'Kubernetes Deployment', value: 'kubernetes'},
        ],
        default: existing?.deployment.workerDeploymentBackend || 'docker_compose',
        message: 'How should scroll-sdk-cli deploy adapter-managed CPU/CUDA Workers?',
      }),
    ) as 'docker_compose' | 'kubernetes'
    if (generation === 'mock') options.log(chalk.blue('Mock proofs are produced inside Proof Coordinator; no mock Worker will be deployed.'))

    const deadline = Number(await required(
      options.observeRealProofDeadlineMs?.toString(),
      existing?.observeRealProofDeadlineMs?.toString(),
      'Observe real-proof deadline in milliseconds (for example 1800000 for 30 minutes):',
      '--proof-observe-real-proof-deadline-ms',
    ))
    if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error('observe real-proof deadline must be a positive safe integer')

    const witnessSource = options.witnessSource || existing?.active?.realScroll.chunkWitnessSource || 'rpc'
    const topology = buildProofTopology({
      artifactStore: store,
      deploymentName,
      enforcement,
      generation,
      materials,
      mode,
      runtime: {
        artifactKeyPrefix: keyPrefix,
        blockWitnessDir: options.witnessDir || existing?.active?.realScroll.chunkBlockWitnessDir,
        eagerMaterializer: existing?.deployment.eagerMaterializer,
        observeRealProofDeadlineMs: deadline,
        proofCoordinatorPublicUrl: coordinatorUrl,
        publicS3EndpointUrl: publicEndpoint,
        rpcWitnessUrl: options.witnessRpcUrl
          || existing?.active?.realScroll.chunkWitnessRpcUrl
          || options.config.rpc?.l2Url,
        witnessSource,
        workerDeploymentBackend,
        workerLaunch,
        workerNodeSelector: existing?.deployment.workerNodeSelector,
        workerResources: existing?.deployment.workerResources,
        workerRuntimeClassName: existing?.deployment.workerRuntimeClassName,
        workerSecretName: existing?.deployment.workerSecretName,
        workerTolerations: existing?.deployment.workerTolerations,
      },
    })
    const materialization = topology.active?.profile === 'withdrawal_mock_prover_real_materialize'
      || topology.generation === 'real'
      ? 'real segmentation and subprocess materializers'
      : 'development exact-mock one-chunk materialization'
    options.log(chalk.blue(`Proof materialization: ${materialization}`))
    await this.preflightProofTopologyV2(topology, options.config, deploymentName, options.log, options.compilerBinary)
    return {topology}
  }

  private async preflightProofTopologyV2(
    topology: ProofTopologySpec,
    config: DogeConfig,
    deploymentName: string,
    log: (message: string) => void,
    compilerBinary?: string,
  ): Promise<void> {
    const output = `.data/generated/.proof-topology-init-preflight-${topology.generation}-${process.pid}`
    const clusterRpc = config.dogecoinClusterRpc || {}
    try {
      compileProofTopology({
        bridge: {
          dogecoinNetwork: config.network,
          dogecoinRpcPassword: clusterRpc.password || '',
          dogecoinRpcUrl: resolveDogecoinServiceRpcUrl({kubernetes: config.kubernetes, network: config.network}),
          dogecoinRpcUser: clusterRpc.username || '',
        },
        compilerBinary,
        deploymentDir: process.cwd(),
        deploymentName,
        ethereumDaBlobSource: proofTopologyEthereumDaBlobSource(config.ethereumDa),
        ethereumL1RpcUrl: config.ethereumDa?.submitterRpcUrl,
        network: config.network,
        outputDir: output,
        preflightMode: topology.generation,
        proofTopology: topology,
      })
      log(chalk.green(`Proof topology ${topology.generation} preflight passed`))
    } finally {
      fs.rmSync(path.resolve(output), {force: true, recursive: true})
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

export default DogeConfigCommand
