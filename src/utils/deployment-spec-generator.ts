/**
 * DeploymentSpec Generator
 *
 * Generates config.toml, doge-config.toml, setup_defaults.toml, and
 * other configuration files from a DeploymentSpec.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import * as toml from '@iarna/toml'
import type {
  DeploymentSpec,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  SequencerConfig,
  BootnodeConfig
} from '../types/deployment-spec.js'

/**
 * Load and parse a DeploymentSpec from a YAML file
 */
export function loadDeploymentSpec(filePath: string): DeploymentSpec {
  const content = fs.readFileSync(filePath, 'utf-8')
  const spec = yaml.load(content) as DeploymentSpec

  if (!spec.version) {
    throw new Error('DeploymentSpec must have a version field')
  }

  return spec
}

/**
 * Resolve environment variable references ($ENV:VAR_NAME) in a string
 */
export function resolveEnvValue(value: string): string {
  if (typeof value !== 'string') return value

  const envPattern = /\$ENV:([A-Z0-9_]+)/g
  return value.replace(envPattern, (match, varName) => {
    const envValue = process.env[varName]
    if (envValue === undefined) {
      throw new Error(`Environment variable ${varName} is not set`)
    }
    return envValue
  })
}

/**
 * Check if a value contains an environment variable reference
 */
export function hasEnvRef(value: string): boolean {
  if (typeof value !== 'string') return false
  return /\$ENV:[A-Z0-9_]+/.test(value)
}

/**
 * Validate a DeploymentSpec
 */
export function validateDeploymentSpec(spec: DeploymentSpec): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  // Version check
  if (spec.version !== '1.0') {
    errors.push({
      path: 'version',
      message: `Unsupported version: ${spec.version}. Expected: 1.0`,
      code: 'E001_UNSUPPORTED_VERSION'
    })
  }

  // Metadata validation
  if (!spec.metadata?.name) {
    errors.push({
      path: 'metadata.name',
      message: 'Deployment name is required',
      code: 'E002_MISSING_REQUIRED_FIELD'
    })
  }

  if (!spec.metadata?.environment) {
    errors.push({
      path: 'metadata.environment',
      message: 'Environment is required (mainnet, testnet, devnet)',
      code: 'E002_MISSING_REQUIRED_FIELD'
    })
  }

  // Infrastructure validation
  if (!spec.infrastructure?.provider) {
    errors.push({
      path: 'infrastructure.provider',
      message: 'Infrastructure provider is required',
      code: 'E002_MISSING_REQUIRED_FIELD'
    })
  }

  if (spec.infrastructure?.provider === 'aws' && !spec.infrastructure.aws) {
    errors.push({
      path: 'infrastructure.aws',
      message: 'AWS configuration is required when provider is aws',
      code: 'E003_MISSING_PROVIDER_CONFIG'
    })
  }

  // Network validation
  if (!spec.network?.l1ChainId || !spec.network?.l2ChainId) {
    errors.push({
      path: 'network',
      message: 'L1 and L2 chain IDs are required',
      code: 'E002_MISSING_REQUIRED_FIELD'
    })
  }

  // Accounts validation
  if (!spec.accounts?.deployer?.address) {
    errors.push({
      path: 'accounts.deployer.address',
      message: 'Deployer address is required',
      code: 'E002_MISSING_REQUIRED_FIELD'
    })
  }

  // Validate Ethereum addresses
  const ethAddressPattern = /^0x[a-fA-F0-9]{40}$/
  const addressFields = [
    { path: 'accounts.deployer.address', value: spec.accounts?.deployer?.address },
    { path: 'accounts.owner.address', value: spec.accounts?.owner?.address },
    { path: 'accounts.l1CommitSender.address', value: spec.accounts?.l1CommitSender?.address },
    { path: 'accounts.l1FinalizeSender.address', value: spec.accounts?.l1FinalizeSender?.address },
  ]

  for (const field of addressFields) {
    if (field.value && !ethAddressPattern.test(field.value)) {
      errors.push({
        path: field.path,
        message: `Invalid Ethereum address: ${field.value}`,
        code: 'E004_INVALID_ADDRESS'
      })
    }
  }

  // Dogecoin network validation
  if (spec.dogecoin?.network) {
    if (spec.metadata.environment === 'mainnet' && spec.dogecoin.network !== 'mainnet') {
      warnings.push({
        path: 'dogecoin.network',
        message: 'Deployment environment is mainnet but dogecoin network is not mainnet',
        suggestion: 'Ensure this is intentional'
      })
    }
  }

  // Signing validation
  if (!spec.signing?.method) {
    errors.push({
      path: 'signing.method',
      message: 'Signing method is required (local, cubesigner, aws-kms)',
      code: 'E002_MISSING_REQUIRED_FIELD'
    })
  }

  if (spec.signing?.method === 'cubesigner' && (!spec.signing.cubesigner?.roles || spec.signing.cubesigner.roles.length === 0)) {
    errors.push({
      path: 'signing.cubesigner.roles',
      message: 'CubeSigner roles are required when using cubesigner signing method',
      code: 'E003_MISSING_PROVIDER_CONFIG'
    })
  }

  // Bridge thresholds validation
  if (spec.bridge?.thresholds) {
    const { attestation } = spec.bridge.thresholds
    const attestationKeyCount = spec.bridge.keyCounts?.attestation || 0
    if (attestation > attestationKeyCount) {
      errors.push({
        path: 'bridge.thresholds.attestation',
        message: `Attestation threshold (${attestation}) cannot exceed key count (${attestationKeyCount})`,
        code: 'E005_INVALID_THRESHOLD'
      })
    }
  }

  // Images validation
  if (spec.images) {
    const validPullPolicies = ['Always', 'IfNotPresent', 'Never']

    // Validate default pullPolicy if specified
    if (spec.images.defaults?.pullPolicy && !validPullPolicies.includes(spec.images.defaults.pullPolicy)) {
      errors.push({
        path: 'images.defaults.pullPolicy',
        message: `Invalid default pullPolicy: ${spec.images.defaults.pullPolicy}. Must be one of: ${validPullPolicies.join(', ')}`,
        code: 'E006_INVALID_IMAGE_CONFIG'
      })
    }

    // Validate per-service image configs
    if (spec.images.services) {
      const serviceNames = Object.keys(spec.images.services) as Array<keyof typeof spec.images.services>

      for (const serviceName of serviceNames) {
        const imageConfig = spec.images.services[serviceName]
        if (!imageConfig) continue

        // Validate pullPolicy if specified
        if (imageConfig.pullPolicy && !validPullPolicies.includes(imageConfig.pullPolicy)) {
          errors.push({
            path: `images.services.${serviceName}.pullPolicy`,
            message: `Invalid pullPolicy: ${imageConfig.pullPolicy}. Must be one of: ${validPullPolicies.join(', ')}`,
            code: 'E006_INVALID_IMAGE_CONFIG'
          })
        }

        // Validate tag format (should not contain spaces or invalid characters)
        if (imageConfig.tag && !hasEnvRef(imageConfig.tag)) {
          const tagPattern = /^[a-zA-Z0-9._-]+$/
          if (!tagPattern.test(imageConfig.tag)) {
            errors.push({
              path: `images.services.${serviceName}.tag`,
              message: `Invalid image tag format: ${imageConfig.tag}. Tags should contain only alphanumeric characters, dots, underscores, and hyphens`,
              code: 'E006_INVALID_IMAGE_CONFIG'
            })
          }
        }

        // Validate repository format (basic check for container image reference)
        if (imageConfig.repository) {
          const repoPattern = /^[a-z0-9][a-z0-9._/-]*$/
          if (!repoPattern.test(imageConfig.repository)) {
            errors.push({
              path: `images.services.${serviceName}.repository`,
              message: `Invalid repository format: ${imageConfig.repository}`,
              code: 'E006_INVALID_IMAGE_CONFIG'
            })
          }
        }

        // Warn if only tag is specified without repository (might be intentional to just override tag)
        if (imageConfig.tag && !imageConfig.repository) {
          warnings.push({
            path: `images.services.${serviceName}`,
            message: `Image tag specified without repository for ${serviceName}`,
            suggestion: 'This will only override the tag while keeping the default repository'
          })
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  }
}

/**
 * Generate config.toml content from DeploymentSpec
 */
export function generateConfigToml(spec: DeploymentSpec): string {
  const config: Record<string, any> = {}

  // [general] section
  config.general = {
    DA_PUBLISHER_ENDPOINT: spec.network.daPublisherEndpoint,
    L1_RPC_ENDPOINT: spec.network.l1RpcEndpoint,
    L1_RPC_ENDPOINT_WEBSOCKET: spec.network.l1RpcEndpointWebsocket || '',
    BEACON_RPC_ENDPOINT: spec.network.beaconRpcEndpoint || '',
    L2_RPC_ENDPOINT: spec.network.l2RpcEndpoint,
    CHAIN_NAME_L1: spec.network.l1ChainName,
    CHAIN_NAME_L2: spec.network.l2ChainName,
    CHAIN_ID_L1: spec.network.l1ChainId,
    CHAIN_ID_L2: spec.network.l2ChainId,
    L1_CONTRACT_DEPLOYMENT_BLOCK: spec.contracts.l1DeploymentBlock || 0,
  }

  if (spec.rollup.verifierDigests) {
    config.general.VERIFIER_DIGEST_1 = spec.rollup.verifierDigests.digest1
    config.general.VERIFIER_DIGEST_2 = spec.rollup.verifierDigests.digest2
  }

  // [accounts] section
  config.accounts = {
    DEPLOYER_PRIVATE_KEY: spec.accounts.deployer.privateKey,
    DEPLOYER_ADDR: spec.accounts.deployer.address,
    OWNER_ADDR: spec.accounts.owner.address,
    L1_COMMIT_SENDER_PRIVATE_KEY: spec.accounts.l1CommitSender.privateKey,
    L1_COMMIT_SENDER_ADDR: spec.accounts.l1CommitSender.address,
    L1_FINALIZE_SENDER_PRIVATE_KEY: spec.accounts.l1FinalizeSender.privateKey,
    L1_FINALIZE_SENDER_ADDR: spec.accounts.l1FinalizeSender.address,
    L1_GAS_ORACLE_SENDER_PRIVATE_KEY: spec.accounts.l1GasOracleSender.privateKey,
    L1_GAS_ORACLE_SENDER_ADDR: spec.accounts.l1GasOracleSender.address,
    L2_GAS_ORACLE_SENDER_PRIVATE_KEY: spec.accounts.l2GasOracleSender.privateKey,
    L2_GAS_ORACLE_SENDER_ADDR: spec.accounts.l2GasOracleSender.address,
  }

  // [db] section
  const dbAdmin = spec.database.admin
  const dbHost = dbAdmin?.vpcHost || dbAdmin?.host || 'localhost'
  const dbPort = dbAdmin?.vpcPort || dbAdmin?.port || 5432

  config.db = {
    ROLLUP_NODE_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.rollupNode,
      'rollup_node', spec.database.credentials.rollupNodePassword
    ),
    BRIDGE_HISTORY_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.bridgeHistory,
      'bridge_history', spec.database.credentials.bridgeHistoryPassword
    ),
    GAS_ORACLE_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.gasOracle,
      'gas_oracle', spec.database.credentials.gasOraclePassword
    ),
    COORDINATOR_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.coordinator,
      'coordinator', spec.database.credentials.coordinatorPassword
    ),
    CHAIN_MONITOR_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.chainMonitor,
      'chain_monitor', spec.database.credentials.chainMonitorPassword
    ),
    ROLLUP_EXPLORER_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.rollupExplorer,
      'rollup_explorer', spec.database.credentials.rollupExplorerPassword
    ),
    BLOCKSCOUT_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.blockscout,
      'blockscout', spec.database.credentials.blockscoutPassword
    ),
    ADMIN_SYSTEM_BACKEND_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.adminSystem,
      'admin_system', spec.database.credentials.adminSystemPassword
    ),
  }

  // Add SCROLL_DB_CONNECTION_STRING as alias
  config.db.SCROLL_DB_CONNECTION_STRING = config.db.ROLLUP_NODE_DB_CONNECTION_STRING

  // [gas-token] section
  config['gas-token'] = {
    ALTERNATIVE_GAS_TOKEN_ENABLED: spec.contracts.alternativeGasToken?.enabled || false,
    GAS_ORACLE_INCORPORATE_TOKEN_EXCHANGE_RATE_ENANBLED: false,
    EXCHANGE_RATE_UPDATE_MODE: spec.contracts.alternativeGasToken?.exchangeRateMode || 'Fixed',
    FIXED_EXCHANGE_RATE: spec.contracts.alternativeGasToken?.fixedExchangeRate || '1',
    TOKEN_SYMBOL_PAIR: spec.contracts.alternativeGasToken?.tokenSymbolPair || '',
  }

  if (spec.contracts.alternativeGasToken?.tokenAddress) {
    config['gas-token'].L1_GAS_TOKEN = spec.contracts.alternativeGasToken.tokenAddress
  }

  // [rollup] section
  config.rollup = {
    MAX_TX_IN_CHUNK: spec.rollup.maxTxInChunk,
    MAX_BLOCK_IN_CHUNK: spec.rollup.maxBlockInChunk,
    MAX_BATCH_IN_BUNDLE: spec.rollup.maxBatchInBundle,
    MAX_L1_MESSAGE_GAS_LIMIT: spec.rollup.maxL1MessageGasLimit,
    TEST_ENV_MOCK_FINALIZE_ENABLED: spec.test?.mockFinalizeEnabled || false,
    TEST_ENV_MOCK_FINALIZE_TIMEOUT_SEC: spec.test?.mockFinalizeTimeoutSec || 0,
    FINALIZE_BATCH_DEADLINE_SEC: spec.rollup.finalization.batchDeadlineSec,
    RELAY_MESSAGE_DEADLINE_SEC: spec.rollup.finalization.relayMessageDeadlineSec,
  }

  // [frontend] section
  config.frontend = {
    EXTERNAL_RPC_URI_L1: spec.frontend.externalUrls.l1Rpc,
    EXTERNAL_RPC_URI_L2: spec.frontend.externalUrls.l2Rpc,
    BRIDGE_API_URI: spec.frontend.externalUrls.bridgeApi,
    ROLLUPSCAN_API_URI: spec.frontend.externalUrls.rollupScanApi,
    EXTERNAL_EXPLORER_URI_L1: spec.frontend.externalUrls.l1Explorer,
    EXTERNAL_EXPLORER_URI_L2: spec.frontend.externalUrls.l2Explorer,
    ETH_SYMBOL: spec.network.tokenSymbol,
    BASE_CHAIN: spec.network.tokenSymbol,
    CONNECT_WALLET_PROJECT_ID: spec.frontend.walletConnectProjectId || '',
  }

  // [genesis] section
  config.genesis = {
    L2_MAX_ETH_SUPPLY: spec.genesis.maxEthSupply,
    L2_DEPLOYER_INITIAL_BALANCE: spec.genesis.deployerInitialBalance,
    BASE_FEE_PER_GAS: spec.genesis.baseFeePerGas,
  }

  // [contracts] section
  config.contracts = {
    DEPLOYMENT_SALT: spec.contracts.deploymentSalt,
    L1_FEE_VAULT_ADDR: spec.contracts.l1FeeVaultAddr,
    L2_BRIDGE_FEE_RECIPIENT_ADDR: spec.bridge.feeRecipient,
    DEPOSIT_FEE: spec.bridge.fees.deposit,
    WITHDRAWAL_FEE: spec.bridge.fees.withdrawal,
    MIN_WITHDRAWAL_AMOUNT: spec.bridge.fees.minWithdrawalAmount,
    BLOB_SCALAR: spec.contracts.gasOracle.blobScalar,
    SCALAR: spec.contracts.gasOracle.scalar,
    PENALTY_THRESHOLD: spec.contracts.gasOracle.penaltyThreshold,
    PENALTY_FACTOR: spec.contracts.gasOracle.penaltyFactor,
  }

  if (spec.contracts.overrides) {
    config.contracts.overrides = {}
    if (spec.contracts.overrides.l2MessageQueue) {
      config.contracts.overrides.L2_MESSAGE_QUEUE = spec.contracts.overrides.l2MessageQueue
    }
    if (spec.contracts.overrides.l1GasPriceOracle) {
      config.contracts.overrides.L1_GAS_PRICE_ORACLE = spec.contracts.overrides.l1GasPriceOracle
    }
    if (spec.contracts.overrides.l2Whitelist) {
      config.contracts.overrides.L2_WHITELIST = spec.contracts.overrides.l2Whitelist
    }
    if (spec.contracts.overrides.l2Weth) {
      config.contracts.overrides.L2_WETH = spec.contracts.overrides.l2Weth
    }
    if (spec.contracts.overrides.l2TxFeeVault) {
      config.contracts.overrides.L2_TX_FEE_VAULT = spec.contracts.overrides.l2TxFeeVault
    }
  }

  if (spec.contracts.verification) {
    config.contracts.verification = {
      VERIFIER_TYPE_L1: spec.contracts.verification.l1VerifierType,
      VERIFIER_TYPE_L2: spec.contracts.verification.l2VerifierType,
      EXPLORER_URI_L1: spec.contracts.verification.l1ExplorerUri,
      EXPLORER_URI_L2: spec.contracts.verification.l2ExplorerUri,
      RPC_URI_L1: spec.frontend.externalUrls.l1Rpc,
      RPC_URI_L2: spec.frontend.externalUrls.l2Rpc,
      EXPLORER_API_KEY_L1: spec.contracts.verification.l1ApiKey || '',
      EXPLORER_API_KEY_L2: spec.contracts.verification.l2ApiKey || '',
    }
  }

  // [coordinator] section
  config.coordinator = {
    CHUNK_COLLECTION_TIME_SEC: spec.rollup.coordinator.chunkCollectionTimeSec,
    BATCH_COLLECTION_TIME_SEC: spec.rollup.coordinator.batchCollectionTimeSec,
    BUNDLE_COLLECTION_TIME_SEC: spec.rollup.coordinator.bundleCollectionTimeSec,
    COORDINATOR_JWT_SECRET_KEY: spec.rollup.coordinator.jwtSecretKey,
  }

  // [ingress] section
  config.ingress = {
    FRONTEND_HOST: spec.frontend.hosts.frontend,
    BRIDGE_HISTORY_API_HOST: spec.frontend.hosts.bridgeHistoryApi,
    ROLLUP_EXPLORER_API_HOST: spec.frontend.hosts.rollupExplorerApi,
    COORDINATOR_API_HOST: spec.frontend.hosts.coordinatorApi,
    RPC_GATEWAY_HOST: spec.frontend.hosts.rpcGateway,
    BLOCKSCOUT_HOST: spec.frontend.hosts.blockscout,
    ADMIN_SYSTEM_DASHBOARD_HOST: spec.frontend.hosts.adminDashboard,
    GRAFANA_HOST: spec.frontend.hosts.grafana,
  }

  if (spec.frontend.hosts.rpcGatewayWs) {
    config.ingress.RPC_GATEWAY_WS_HOST = spec.frontend.hosts.rpcGatewayWs
  }
  if (spec.frontend.hosts.blockscoutBackend) {
    config.ingress.BLOCKSCOUT_BACKEND_HOST = spec.frontend.hosts.blockscoutBackend
  }
  if (spec.frontend.hosts.l1Explorer) {
    config.ingress.L1_EXPLORER_HOST = spec.frontend.hosts.l1Explorer
  }
  if (spec.frontend.hosts.l1Devnet) {
    config.ingress.L1_DEVNET_HOST = spec.frontend.hosts.l1Devnet
  }
  if (spec.frontend.hosts.tso) {
    config.ingress.TSO_HOST = spec.frontend.hosts.tso
  }
  if (spec.frontend.hosts.celestia) {
    config.ingress.CELESTIA_HOST = spec.frontend.hosts.celestia
  }
  if (spec.frontend.hosts.dogecoin) {
    config.ingress.DOGECOIN_HOST = spec.frontend.hosts.dogecoin
  }
  if (spec.frontend.hosts.blockbook) {
    config.ingress.BLOCKBOOK_HOST = spec.frontend.hosts.blockbook
  }

  return toml.stringify(config as any)
}

/**
 * Generate doge-config.toml content from DeploymentSpec
 */
export function generateDogeConfigToml(spec: DeploymentSpec): string {
  const config: Record<string, any> = {
    network: spec.dogecoin.network,
  }

  config.rpc = {
    url: spec.dogecoin.rpc.url,
    username: spec.dogecoin.rpc.username,
    password: spec.dogecoin.rpc.password,
  }

  if (spec.dogecoin.blockbook) {
    config.rpc.blockbookAPIUrl = spec.dogecoin.blockbook.apiUrl
    if (spec.dogecoin.blockbook.apiKey) {
      config.rpc.apiKey = spec.dogecoin.blockbook.apiKey
    }
  }

  config.wallet = {
    path: spec.dogecoin.walletPath,
  }

  config.defaults = {
    dogecoinIndexerStartHeight: String(spec.dogecoin.indexerStartHeight),
  }

  config.da = {
    celestiaIndexerStartBlock: String(spec.celestia.indexerStartBlock),
    tendermintRpcUrl: spec.celestia.tendermintRpcUrl,
    daNamespace: spec.celestia.namespace,
    signerAddress: spec.celestia.signerAddress,
    celestiaMnemonic: spec.celestia.mnemonic,
  }

  config.frontend = {
    bridgeUrl: `https://${spec.frontend.hosts.frontend}`,
    l2Explorer: spec.frontend.externalUrls.l2Explorer,
    l2Url: spec.frontend.externalUrls.l2Rpc,
  }

  // Add signing configuration
  if (spec.signing.method === 'cubesigner' && spec.signing.cubesigner) {
    config.cubesigner = {
      roles: spec.signing.cubesigner.roles.map(role => ({
        role_id: role.roleId,
        name: role.name,
        keys: role.keys.map(key => ({
          key_id: key.keyId,
          key_type: key.keyType,
          public_key: key.publicKey,
          material_id: key.materialId,
        }))
      }))
    }
  }

  if (spec.signing.method === 'aws-kms' && spec.signing.awsKms) {
    config.awsSigner = {
      region: spec.signing.awsKms.region,
      accountId: spec.signing.awsKms.accountId,
      networkAlias: spec.signing.awsKms.networkAlias,
      suffixes: spec.signing.awsKms.suffixes.join(','),
    }
  }

  if (spec.signing.method === 'local' && spec.signing.local) {
    config.localSigners = {
      network: spec.dogecoin.network,
      signers: spec.signing.local.signers,
    }
  }

  if (spec.signing.tsoServiceUrl) {
    config.signerUrls = [spec.signing.tsoServiceUrl]
  }

  config.deploymentType = spec.infrastructure.provider === 'local' ? 'local' : 'aws'

  if (spec.test) {
    config.test = {
      mockFinalizeEnabled: spec.test.mockFinalizeEnabled,
      mockFinalizeTimeout: spec.test.mockFinalizeTimeoutSec,
    }
  }

  return toml.stringify(config as any)
}

/**
 * Generate setup_defaults.toml content from DeploymentSpec
 */
export function generateSetupDefaultsToml(spec: DeploymentSpec): string {
  const config: Record<string, any> = {
    network: spec.dogecoin.network,
    seed_string: spec.bridge.seedString,
    dogecoin_rpc_url: spec.dogecoin.rpc.url,
    dogecoin_rpc_user: spec.dogecoin.rpc.username,
    dogecoin_rpc_pass: spec.dogecoin.rpc.password,
    sequencer_threshold: spec.bridge.thresholds.sequencer,
    correctness_threshold: spec.bridge.thresholds.correctness,
    attestation_threshold: spec.bridge.thresholds.attestation,
    recovery_threshold: spec.bridge.thresholds.recovery,
    correctness_key_count: spec.bridge.keyCounts.correctness,
    attestation_key_count: spec.bridge.keyCounts.attestation,
    recovery_key_count: spec.bridge.keyCounts.recovery,
    timelock_seconds: spec.bridge.timelockSeconds,
    fee_rate_sat_per_kvb: spec.bridge.feeRateSatPerKvb,
    deposit_eth_recipient_address_hex: spec.accounts.deployer.address,
    sequencer_target_amount: spec.bridge.targetAmounts.sequencer,
    fee_wallet_target_amount: spec.bridge.targetAmounts.feeWallet,
    bridge_target_amount: spec.bridge.targetAmounts.bridge,
    confirmations_required: spec.bridge.confirmationsRequired,
  }

  // Add attestation public keys from cubesigner roles
  if (spec.signing.method === 'cubesigner' && spec.signing.cubesigner) {
    config.attestation_pubkeys = spec.signing.cubesigner.roles.map(role => {
      const key = role.keys[0]
      return key?.publicKey?.replace(/^0x/, '') || ''
    }).filter(k => k)
  }

  return toml.stringify(config as any)
}

/**
 * Helper to build PostgreSQL connection string
 */
function buildDbConnectionString(
  host: string,
  port: number,
  database: string,
  username: string,
  password: string
): string {
  // If password contains $ENV: reference, keep it as-is for later resolution
  if (hasEnvRef(password)) {
    return `postgres://${username}:${password}@${host}:${port}/${database}?sslmode=disable`
  }
  return `postgres://${username}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=disable`
}

/**
 * Generate all configuration files from a DeploymentSpec
 */
export interface GeneratedConfigs {
  'config.toml': string
  'doge-config.toml': string
  'setup_defaults.toml': string
}

export function generateAllConfigs(spec: DeploymentSpec): GeneratedConfigs {
  return {
    'config.toml': generateConfigToml(spec),
    'doge-config.toml': generateDogeConfigToml(spec),
    'setup_defaults.toml': generateSetupDefaultsToml(spec),
  }
}

/**
 * Write all generated configs to disk
 */
export function writeGeneratedConfigs(
  configs: GeneratedConfigs,
  outputDir: string,
  dogeConfigPath?: string
): void {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  // Write config.toml to output directory
  fs.writeFileSync(path.join(outputDir, 'config.toml'), configs['config.toml'])

  // Write doge-config to .data directory or specified path
  const dogeConfigDir = dogeConfigPath || path.join(outputDir, '.data')
  if (!fs.existsSync(dogeConfigDir)) {
    fs.mkdirSync(dogeConfigDir, { recursive: true })
  }
  fs.writeFileSync(path.join(dogeConfigDir, 'doge-config.toml'), configs['doge-config.toml'])

  // Write setup_defaults.toml to .data directory
  fs.writeFileSync(path.join(dogeConfigDir, 'setup_defaults.toml'), configs['setup_defaults.toml'])
}
