/**
 * DeploymentSpec Generator
 *
 * Generates config.toml, doge-config.toml, setup_defaults.toml, and
 * other configuration files from a DeploymentSpec.
 */

import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {
  DeploymentSpec,
  ValidationError,
  ValidationResult,
  ValidationWarning
} from '../types/deployment-spec.js'

/**
 * Load and parse a DeploymentSpec from a YAML file
 */
export function loadDeploymentSpec(filePath: string): DeploymentSpec {
  const content = fs.readFileSync(filePath, 'utf8')
  const spec = yaml.load(content) as DeploymentSpec

  if (!spec.version) {
    throw new Error('DeploymentSpec must have a version field')
  }

  return spec
}

/**
 * Resolve inline environment variable references within a string.
 * Unlike resolveEnvValue() in non-interactive.ts (which requires the entire
 * value to be a $ENV:VAR reference), this function supports multiple inline
 * references within a single string.
 *
 * Note: Variable names match word characters (a-z, A-Z, 0-9, _), so use a
 * non-word delimiter after the variable name. Examples:
 * - "prefix-$ENV:VAR-suffix" → works (hyphen is non-word)
 * - "prefix/$ENV:VAR/suffix" → works (slash is non-word)
 * - "prefix_$ENV:VAR_suffix" → VAR_suffix is captured (underscore is word char)
 *
 * @throws {Error} if any referenced environment variable is not set
 */
export function resolveInlineEnvRefs(value: string): string {
  if (typeof value !== 'string') return value

  const envPattern = /\$ENV:(\w+)/g
  return value.replaceAll(envPattern, (_match, varName) => {
    const envValue = process.env[varName]
    if (envValue === undefined) {
      throw new Error(`Environment variable ${varName} is not set`)
    }

    return envValue
  })
}

/**
 * Check if a value contains an environment variable reference.
 * Matches $ENV: followed by word characters (alphanumeric plus underscore).
 */
export function hasEnvRef(value: string): boolean {
  if (typeof value !== 'string') return false
  return /\$ENV:\w+/.test(value)
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
      code: 'E001_UNSUPPORTED_VERSION',
      message: `Unsupported version: ${spec.version}. Expected: 1.0`,
      path: 'version'
    })
  }

  // Metadata validation
  if (!spec.metadata?.name) {
    errors.push({
      code: 'E002_MISSING_REQUIRED_FIELD',
      message: 'Deployment name is required',
      path: 'metadata.name'
    })
  }

  if (!spec.metadata?.environment) {
    errors.push({
      code: 'E002_MISSING_REQUIRED_FIELD',
      message: 'Environment is required (mainnet, testnet, devnet)',
      path: 'metadata.environment'
    })
  }

  // Infrastructure validation
  if (!spec.infrastructure?.provider) {
    errors.push({
      code: 'E002_MISSING_REQUIRED_FIELD',
      message: 'Infrastructure provider is required',
      path: 'infrastructure.provider'
    })
  }

  if (spec.infrastructure?.provider === 'aws' && !spec.infrastructure.aws) {
    errors.push({
      code: 'E003_MISSING_PROVIDER_CONFIG',
      message: 'AWS configuration is required when provider is aws',
      path: 'infrastructure.aws'
    })
  }

  // Network validation
  if (!spec.network?.l1ChainId || !spec.network?.l2ChainId) {
    errors.push({
      code: 'E002_MISSING_REQUIRED_FIELD',
      message: 'L1 and L2 chain IDs are required',
      path: 'network'
    })
  }

  // Accounts validation
  if (!spec.accounts?.deployer?.address) {
    errors.push({
      code: 'E002_MISSING_REQUIRED_FIELD',
      message: 'Deployer address is required',
      path: 'accounts.deployer.address'
    })
  }

  // Validate Ethereum addresses
  const ethAddressPattern = /^0x[\dA-Fa-f]{40}$/
  const addressFields = [
    { path: 'accounts.deployer.address', value: spec.accounts?.deployer?.address },
    { path: 'accounts.owner.address', value: spec.accounts?.owner?.address },
    { path: 'accounts.l1CommitSender.address', value: spec.accounts?.l1CommitSender?.address },
    { path: 'accounts.l1FinalizeSender.address', value: spec.accounts?.l1FinalizeSender?.address },
  ]

  for (const field of addressFields) {
    if (field.value && !ethAddressPattern.test(field.value)) {
      errors.push({
        code: 'E004_INVALID_ADDRESS',
        message: `Invalid Ethereum address: ${field.value}`,
        path: field.path
      })
    }
  }

  // Dogecoin network validation
  if (spec.dogecoin?.network && spec.metadata.environment === 'mainnet' && spec.dogecoin.network !== 'mainnet') {
      warnings.push({
        message: 'Deployment environment is mainnet but dogecoin network is not mainnet',
        path: 'dogecoin.network',
        suggestion: 'Ensure this is intentional'
      })
    }

  // Signing validation
  if (!spec.signing?.method) {
    errors.push({
      code: 'E002_MISSING_REQUIRED_FIELD',
      message: 'Signing method is required (local, cubesigner, aws-kms)',
      path: 'signing.method'
    })
  }

  if (spec.signing?.method === 'cubesigner' && (!spec.signing.cubesigner?.roles || spec.signing.cubesigner.roles.length === 0)) {
    errors.push({
      code: 'E003_MISSING_PROVIDER_CONFIG',
      message: 'CubeSigner roles are required when using cubesigner signing method',
      path: 'signing.cubesigner.roles'
    })
  }

  // Bridge thresholds validation
  if (spec.bridge?.thresholds) {
    const { attestation } = spec.bridge.thresholds
    const attestationKeyCount = spec.bridge.keyCounts?.attestation || 0
    if (attestation > attestationKeyCount) {
      errors.push({
        code: 'E005_INVALID_THRESHOLD',
        message: `Attestation threshold (${attestation}) cannot exceed key count (${attestationKeyCount})`,
        path: 'bridge.thresholds.attestation'
      })
    }
  }

  // Images validation
  if (spec.images) {
    const validPullPolicies = ['Always', 'IfNotPresent', 'Never']

    // Validate default pullPolicy if specified
    if (spec.images.defaults?.pullPolicy && !validPullPolicies.includes(spec.images.defaults.pullPolicy)) {
      errors.push({
        code: 'E006_INVALID_IMAGE_CONFIG',
        message: `Invalid default pullPolicy: ${spec.images.defaults.pullPolicy}. Must be one of: ${validPullPolicies.join(', ')}`,
        path: 'images.defaults.pullPolicy'
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
            code: 'E006_INVALID_IMAGE_CONFIG',
            message: `Invalid pullPolicy: ${imageConfig.pullPolicy}. Must be one of: ${validPullPolicies.join(', ')}`,
            path: `images.services.${serviceName}.pullPolicy`
          })
        }

        // Validate tag format (should not contain spaces or invalid characters)
        if (imageConfig.tag && !hasEnvRef(imageConfig.tag)) {
          const tagPattern = /^[\w.-]+$/
          if (!tagPattern.test(imageConfig.tag)) {
            errors.push({
              code: 'E006_INVALID_IMAGE_CONFIG',
              message: `Invalid image tag format: ${imageConfig.tag}. Tags should contain only alphanumeric characters, dots, underscores, and hyphens`,
              path: `images.services.${serviceName}.tag`
            })
          }
        }

        // Validate repository format (basic check for container image reference)
        if (imageConfig.repository) {
          const repoPattern = /^[\da-z][\d./_a-z-]*$/
          if (!repoPattern.test(imageConfig.repository)) {
            errors.push({
              code: 'E006_INVALID_IMAGE_CONFIG',
              message: `Invalid repository format: ${imageConfig.repository}`,
              path: `images.services.${serviceName}.repository`
            })
          }
        }

        // Warn if only tag is specified without repository (might be intentional to just override tag)
        if (imageConfig.tag && !imageConfig.repository) {
          warnings.push({
            message: `Image tag specified without repository for ${serviceName}`,
            path: `images.services.${serviceName}`,
            suggestion: 'This will only override the tag while keeping the default repository'
          })
        }
      }
    }
  }

  return {
    errors,
    valid: errors.length === 0,
    warnings
  }
}

/**
 * Generate config.toml content from DeploymentSpec
 */
export function generateConfigToml(spec: DeploymentSpec): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dynamic config building
  const config: Record<string, any> = {}

  // [general] section
  config.general = {
    BEACON_RPC_ENDPOINT: spec.network.beaconRpcEndpoint || '',
    CHAIN_ID_L1: spec.network.l1ChainId,
    CHAIN_ID_L2: spec.network.l2ChainId,
    CHAIN_NAME_L1: spec.network.l1ChainName,
    CHAIN_NAME_L2: spec.network.l2ChainName,
    DA_PUBLISHER_ENDPOINT: spec.network.daPublisherEndpoint,
    L1_CONTRACT_DEPLOYMENT_BLOCK: spec.contracts.l1DeploymentBlock || 0,
    L1_RPC_ENDPOINT: spec.network.l1RpcEndpoint,
    L1_RPC_ENDPOINT_WEBSOCKET: spec.network.l1RpcEndpointWebsocket || '',
    L2_RPC_ENDPOINT: spec.network.l2RpcEndpoint,
  }

  if (spec.rollup.verifierDigests) {
    config.general.VERIFIER_DIGEST_1 = spec.rollup.verifierDigests.digest1
    config.general.VERIFIER_DIGEST_2 = spec.rollup.verifierDigests.digest2
  }

  // [accounts] section
  config.accounts = {
    DEPLOYER_ADDR: spec.accounts.deployer.address,
    DEPLOYER_PRIVATE_KEY: spec.accounts.deployer.privateKey,
    L1_COMMIT_SENDER_ADDR: spec.accounts.l1CommitSender.address,
    L1_COMMIT_SENDER_PRIVATE_KEY: spec.accounts.l1CommitSender.privateKey,
    L1_FINALIZE_SENDER_ADDR: spec.accounts.l1FinalizeSender.address,
    L1_FINALIZE_SENDER_PRIVATE_KEY: spec.accounts.l1FinalizeSender.privateKey,
    L1_GAS_ORACLE_SENDER_ADDR: spec.accounts.l1GasOracleSender.address,
    L1_GAS_ORACLE_SENDER_PRIVATE_KEY: spec.accounts.l1GasOracleSender.privateKey,
    L2_GAS_ORACLE_SENDER_ADDR: spec.accounts.l2GasOracleSender.address,
    L2_GAS_ORACLE_SENDER_PRIVATE_KEY: spec.accounts.l2GasOracleSender.privateKey,
    OWNER_ADDR: spec.accounts.owner.address,
  }

  // [db] section
  const dbAdmin = spec.database.admin
  const dbHost = dbAdmin?.vpcHost || dbAdmin?.host || 'localhost'
  const dbPort = dbAdmin?.vpcPort || dbAdmin?.port || 5432

  config.db = {
    ADMIN_SYSTEM_BACKEND_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.adminSystem,
      'admin_system', spec.database.credentials.adminSystemPassword
    ),
    BLOCKSCOUT_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.blockscout,
      'blockscout', spec.database.credentials.blockscoutPassword
    ),
    BRIDGE_HISTORY_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.bridgeHistory,
      'bridge_history', spec.database.credentials.bridgeHistoryPassword
    ),
    CHAIN_MONITOR_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.chainMonitor,
      'chain_monitor', spec.database.credentials.chainMonitorPassword
    ),
    COORDINATOR_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.coordinator,
      'coordinator', spec.database.credentials.coordinatorPassword
    ),
    GAS_ORACLE_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.gasOracle,
      'gas_oracle', spec.database.credentials.gasOraclePassword
    ),
    ROLLUP_EXPLORER_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.rollupExplorer,
      'rollup_explorer', spec.database.credentials.rollupExplorerPassword
    ),
    ROLLUP_NODE_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, spec.database.databases.rollupNode,
      'rollup_node', spec.database.credentials.rollupNodePassword
    ),
  }

  // Add SCROLL_DB_CONNECTION_STRING as alias
  config.db.SCROLL_DB_CONNECTION_STRING = config.db.ROLLUP_NODE_DB_CONNECTION_STRING

  // [gas-token] section
  config['gas-token'] = {
    ALTERNATIVE_GAS_TOKEN_ENABLED: spec.contracts.alternativeGasToken?.enabled || false,
    EXCHANGE_RATE_UPDATE_MODE: spec.contracts.alternativeGasToken?.exchangeRateMode || 'Fixed',
    FIXED_EXCHANGE_RATE: spec.contracts.alternativeGasToken?.fixedExchangeRate || '1',
    GAS_ORACLE_INCORPORATE_TOKEN_EXCHANGE_RATE_ENANBLED: false,
    TOKEN_SYMBOL_PAIR: spec.contracts.alternativeGasToken?.tokenSymbolPair || '',
  }

  if (spec.contracts.alternativeGasToken?.tokenAddress) {
    config['gas-token'].L1_GAS_TOKEN = spec.contracts.alternativeGasToken.tokenAddress
  }

  // [rollup] section
  config.rollup = {
    FINALIZE_BATCH_DEADLINE_SEC: spec.rollup.finalization.batchDeadlineSec,
    MAX_BATCH_IN_BUNDLE: spec.rollup.maxBatchInBundle,
    MAX_BLOCK_IN_CHUNK: spec.rollup.maxBlockInChunk,
    MAX_L1_MESSAGE_GAS_LIMIT: spec.rollup.maxL1MessageGasLimit,
    MAX_TX_IN_CHUNK: spec.rollup.maxTxInChunk,
    RELAY_MESSAGE_DEADLINE_SEC: spec.rollup.finalization.relayMessageDeadlineSec,
    TEST_ENV_MOCK_FINALIZE_ENABLED: spec.test?.mockFinalizeEnabled || false,
    TEST_ENV_MOCK_FINALIZE_TIMEOUT_SEC: spec.test?.mockFinalizeTimeoutSec || 0,
  }

  // [frontend] section
  config.frontend = {
    BASE_CHAIN: spec.network.tokenSymbol,
    BRIDGE_API_URI: spec.frontend.externalUrls.bridgeApi,
    CONNECT_WALLET_PROJECT_ID: spec.frontend.walletConnectProjectId || '',
    ETH_SYMBOL: spec.network.tokenSymbol,
    EXTERNAL_EXPLORER_URI_L1: spec.frontend.externalUrls.l1Explorer,
    EXTERNAL_EXPLORER_URI_L2: spec.frontend.externalUrls.l2Explorer,
    EXTERNAL_RPC_URI_L1: spec.frontend.externalUrls.l1Rpc,
    EXTERNAL_RPC_URI_L2: spec.frontend.externalUrls.l2Rpc,
    ROLLUPSCAN_API_URI: spec.frontend.externalUrls.rollupScanApi,
  }

  // [genesis] section
  config.genesis = {
    BASE_FEE_PER_GAS: spec.genesis.baseFeePerGas,
    L2_DEPLOYER_INITIAL_BALANCE: spec.genesis.deployerInitialBalance,
    L2_MAX_ETH_SUPPLY: spec.genesis.maxEthSupply,
  }

  // [contracts] section
  config.contracts = {
    BLOB_SCALAR: spec.contracts.gasOracle.blobScalar,
    DEPLOYMENT_SALT: spec.contracts.deploymentSalt,
    DEPOSIT_FEE: spec.bridge.fees.deposit,
    L1_FEE_VAULT_ADDR: spec.contracts.l1FeeVaultAddr,
    L2_BRIDGE_FEE_RECIPIENT_ADDR: spec.bridge.feeRecipient,
    MIN_WITHDRAWAL_AMOUNT: spec.bridge.fees.minWithdrawalAmount,
    PENALTY_FACTOR: spec.contracts.gasOracle.penaltyFactor,
    PENALTY_THRESHOLD: spec.contracts.gasOracle.penaltyThreshold,
    SCALAR: spec.contracts.gasOracle.scalar,
    WITHDRAWAL_FEE: spec.bridge.fees.withdrawal,
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
      EXPLORER_API_KEY_L1: spec.contracts.verification.l1ApiKey || '',
      EXPLORER_API_KEY_L2: spec.contracts.verification.l2ApiKey || '',
      EXPLORER_URI_L1: spec.contracts.verification.l1ExplorerUri,
      EXPLORER_URI_L2: spec.contracts.verification.l2ExplorerUri,
      RPC_URI_L1: spec.frontend.externalUrls.l1Rpc,
      RPC_URI_L2: spec.frontend.externalUrls.l2Rpc,
      VERIFIER_TYPE_L1: spec.contracts.verification.l1VerifierType,
      VERIFIER_TYPE_L2: spec.contracts.verification.l2VerifierType,
    }
  }

  // [coordinator] section
  config.coordinator = {
    BATCH_COLLECTION_TIME_SEC: spec.rollup.coordinator.batchCollectionTimeSec,
    BUNDLE_COLLECTION_TIME_SEC: spec.rollup.coordinator.bundleCollectionTimeSec,
    CHUNK_COLLECTION_TIME_SEC: spec.rollup.coordinator.chunkCollectionTimeSec,
    COORDINATOR_JWT_SECRET_KEY: spec.rollup.coordinator.jwtSecretKey,
  }

  // [ingress] section
  config.ingress = {
    ADMIN_SYSTEM_DASHBOARD_HOST: spec.frontend.hosts.adminDashboard,
    BLOCKSCOUT_HOST: spec.frontend.hosts.blockscout,
    BRIDGE_HISTORY_API_HOST: spec.frontend.hosts.bridgeHistoryApi,
    COORDINATOR_API_HOST: spec.frontend.hosts.coordinatorApi,
    FRONTEND_HOST: spec.frontend.hosts.frontend,
    GRAFANA_HOST: spec.frontend.hosts.grafana,
    ROLLUP_EXPLORER_API_HOST: spec.frontend.hosts.rollupExplorerApi,
    RPC_GATEWAY_HOST: spec.frontend.hosts.rpcGateway,
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

  return toml.stringify(config as toml.JsonMap)
}

/**
 * Generate doge-config.toml content from DeploymentSpec
 */
export function generateDogeConfigToml(spec: DeploymentSpec): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dynamic config building
  const config: Record<string, any> = {
    network: spec.dogecoin.network,
  }

  config.rpc = {
    password: spec.dogecoin.rpc.password,
    url: spec.dogecoin.rpc.url,
    username: spec.dogecoin.rpc.username,
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
    celestiaMnemonic: spec.celestia.mnemonic,
    daNamespace: spec.celestia.namespace,
    signerAddress: spec.celestia.signerAddress,
    tendermintRpcUrl: spec.celestia.tendermintRpcUrl,
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
        keys: role.keys.map(key => ({
          key_id: key.keyId,
          key_type: key.keyType,
          material_id: key.materialId,
          public_key: key.publicKey,
        })),
        name: role.name,
        role_id: role.roleId
      }))
    }
  }

  if (spec.signing.method === 'aws-kms' && spec.signing.awsKms) {
    config.awsSigner = {
      accountId: spec.signing.awsKms.accountId,
      networkAlias: spec.signing.awsKms.networkAlias,
      region: spec.signing.awsKms.region,
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

  return toml.stringify(config as toml.JsonMap)
}

/**
 * Generate setup_defaults.toml content from DeploymentSpec
 */
export function generateSetupDefaultsToml(spec: DeploymentSpec): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dynamic config building
  const config: Record<string, any> = {
    attestation_key_count: spec.bridge.keyCounts.attestation,
    attestation_threshold: spec.bridge.thresholds.attestation,
    bridge_target_amount: spec.bridge.targetAmounts.bridge,
    confirmations_required: spec.bridge.confirmationsRequired,
    correctness_key_count: spec.bridge.keyCounts.correctness,
    correctness_threshold: spec.bridge.thresholds.correctness,
    deposit_eth_recipient_address_hex: spec.accounts.deployer.address,
    dogecoin_rpc_pass: spec.dogecoin.rpc.password,
    dogecoin_rpc_url: spec.dogecoin.rpc.url,
    dogecoin_rpc_user: spec.dogecoin.rpc.username,
    fee_rate_sat_per_kvb: spec.bridge.feeRateSatPerKvb,
    fee_wallet_target_amount: spec.bridge.targetAmounts.feeWallet,
    network: spec.dogecoin.network,
    recovery_key_count: spec.bridge.keyCounts.recovery,
    recovery_threshold: spec.bridge.thresholds.recovery,
    seed_string: spec.bridge.seedString,
    sequencer_target_amount: spec.bridge.targetAmounts.sequencer,
    sequencer_threshold: spec.bridge.thresholds.sequencer,
    timelock_seconds: spec.bridge.timelockSeconds,
  }

  // Add attestation public keys from cubesigner roles
  if (spec.signing.method === 'cubesigner' && spec.signing.cubesigner) {
    config.attestation_pubkeys = spec.signing.cubesigner.roles.map(role => {
      const key = role.keys[0]
      return key?.publicKey?.replace(/^0x/, '') || ''
    }).filter(Boolean)
  }

  return toml.stringify(config as toml.JsonMap)
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
