/**
 * DeploymentSpec Generator
 *
 * Generates config.toml, doge-config.toml, setup_defaults.toml,
 * protocol_seed.toml, and
 * other configuration files from a DeploymentSpec.
 */

import * as toml from '@iarna/toml'
import { Wallet } from 'ethers'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {
  AccountsConfig,
  DeploymentSpec,
  FrontendSubdomains,
  ValidationError,
  ValidationResult,
  ValidationWarning
} from '../types/deployment-spec.js'
import type { DogeConfig } from '../types/doge-config.js'

import {
  L1_INTERFACE_RPC_ENDPOINT,
  L1_INTERFACE_RPC_WEBSOCKET_ENDPOINT,
  L2_RPC_ENDPOINT,
} from '../config/constants.js'

const ETHEREUM_DA_DEFAULTS = {
  devnet: {
    beaconRpcUrl: 'http://l1-devnet-lighthouse:5052',
    chainId: 32_382,
    minFinality: 'safe',
    submitterRpcUrl: 'http://l1-devnet:8545',
  },
  mainnet: {
    beaconRpcUrl: 'https://ethereum-beacon-api.publicnode.com',
    chainId: 1,
    minFinality: 'finalized',
    submitterRpcUrl: 'https://eth.drpc.org',
  },
  sepolia: {
    beaconRpcUrl: 'https://ethereum-sepolia-beacon-api.publicnode.com',
    chainId: 11_155_111,
    minFinality: 'safe',
    submitterRpcUrl: 'https://sepolia.drpc.org',
  },
} as const

/**
 * Load and parse a DeploymentSpec from a YAML file
 */
export function loadDeploymentSpec(filePath: string): DeploymentSpec {
  const content = fs.readFileSync(filePath, 'utf8')
  const spec = yaml.load(content) as DeploymentSpec

  if (!spec.version) {
    throw new Error('DeploymentSpec must have a version field')
  }

  return normalizeDeploymentSpec(spec)
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

function resolveEnvRefsDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return hasEnvRef(value) ? resolveInlineEnvRefs(value) : value
  }

  if (Array.isArray(value)) {
    return value.map(item => resolveEnvRefsDeep(item))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveEnvRefsDeep(item)])
    )
  }

  return value
}

const DEFAULT_FRONTEND_SUBDOMAINS = {
  adminDashboard: 'admin-system-dashboard',
  blockbook: 'blockbook',
  blockscout: 'blockscout',
  blockscoutBackend: 'blockscout-backend',
  bridgeHistoryApi: 'bridge-history-api',
  coordinatorApi: 'coordinator-api',
  dogecoin: 'dogecoin',
  frontend: 'portal',
  grafana: 'grafana',
  rollupExplorerApi: 'rollup-explorer-backend',
  rpcGateway: 'rpc',
  rpcGatewayWs: 'ws-rpc',
  tso: 'tso',
} as const

type FrontendHosts = DeploymentSpec['frontend']['hosts']
type FrontendHostKey = keyof FrontendHosts
type FrontendExternalUrls = DeploymentSpec['frontend']['externalUrls']
type PrivateKeyAccountKey =
  | 'deployer'
  | 'l1CommitSender'
  | 'l1FinalizeSender'
  | 'l1GasOracleSender'
  | 'l2GasOracleSender'

const PRIVATE_KEY_ACCOUNT_KEYS = [
  'deployer',
  'l1CommitSender',
  'l1FinalizeSender',
  'l1GasOracleSender',
  'l2GasOracleSender',
] as const satisfies readonly PrivateKeyAccountKey[]

const EXACT_ENV_REF_PATTERN = /^\$ENV:(\w+)$/

function buildHost(baseDomain: string, subdomainOrHost: string | undefined): string {
  if (!subdomainOrHost || subdomainOrHost === '@') return baseDomain
  if (subdomainOrHost.includes('.') || subdomainOrHost.includes(':')) return subdomainOrHost
  return `${subdomainOrHost}.${baseDomain}`
}

function inferFrontendProtocol(frontend: Partial<DeploymentSpec['frontend']>, baseDomain: string): 'http' | 'https' {
  if (frontend.protocol === 'http' || frontend.protocol === 'https') {
    return frontend.protocol
  }

  const externalUrls = frontend.externalUrls || {}
  for (const value of Object.values(externalUrls)) {
    if (typeof value === 'string' && value.startsWith('http://')) return 'http'
    if (typeof value === 'string' && value.startsWith('https://')) return 'https'
  }

  return baseDomain === 'localhost' || baseDomain.endsWith('.localhost') ? 'http' : 'https'
}

function publicUrl(protocol: 'http' | 'https', host: string, suffix = ''): string {
  return `${protocol}://${host}${suffix}`
}

function normalizePrivateKeyForWallet(privateKey: string): string {
  const trimmed = privateKey.trim()
  return /^[\dA-Fa-f]{64}$/.test(trimmed) ? `0x${trimmed}` : trimmed
}

function privateKeyForAddressDerivation(privateKey: string | undefined): string | undefined {
  if (!privateKey) return undefined

  const exactEnvRef = privateKey.match(EXACT_ENV_REF_PATTERN)
  if (exactEnvRef) {
    const envValue = process.env[exactEnvRef[1]]
    return envValue && envValue.trim() !== '' ? envValue : undefined
  }

  if (hasEnvRef(privateKey)) return undefined
  return privateKey
}

function addressForValidation(address: string | undefined): string | undefined {
  if (!address) return undefined

  const exactEnvRef = address.match(EXACT_ENV_REF_PATTERN)
  if (exactEnvRef) {
    const envValue = process.env[exactEnvRef[1]]
    return envValue && envValue.trim() !== '' ? envValue : undefined
  }

  if (hasEnvRef(address)) return undefined
  return address
}

function deriveAddressFromPrivateKey(privateKey: string | undefined): { address?: string; error?: string } {
  const resolvedPrivateKey = privateKeyForAddressDerivation(privateKey)
  if (!resolvedPrivateKey) return {}

  try {
    return { address: new Wallet(normalizePrivateKeyForWallet(resolvedPrivateKey)).address }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function normalizeAccounts(accounts: AccountsConfig | undefined): AccountsConfig | undefined {
  if (!accounts) return accounts

  const normalized = { ...accounts }

  for (const key of PRIVATE_KEY_ACCOUNT_KEYS) {
    const account = accounts[key]
    if (!account?.privateKey) continue

    const derived = deriveAddressFromPrivateKey(account.privateKey)
    normalized[key] = {
      ...account,
      ...(derived.address ? { address: derived.address } : {}),
    }
  }

  return normalized
}

function optionalAccountAddress(spec: DeploymentSpec, key: PrivateKeyAccountKey): string {
  return spec.accounts[key]?.address || ''
}

function optionalAccountPrivateKey(spec: DeploymentSpec, key: PrivateKeyAccountKey): string {
  return spec.accounts[key]?.privateKey || ''
}

export function getDogecoinIndexerStartHeight(spec: DeploymentSpec): number {
  return spec.dogecoin.indexerStartHeight ?? 0
}

export function getL1GenesisBlock(spec: DeploymentSpec): number {
  return spec.dogecoin.l1GenesisBlock ?? Math.max(0, getDogecoinIndexerStartHeight(spec) + 1)
}

export function getBridgeFeeRateSatsPerKvb(spec: DeploymentSpec): number {
  return spec.bridge.feeRateSatsPerKvb ?? spec.bridge.feeRateSatPerKvb ?? 0
}

function getBridgeTargetAmountsSats(spec: DeploymentSpec): { bridge: number; feeWallet: number; sequencer: number } {
  return spec.bridge.targetAmountsSats ?? spec.bridge.targetAmounts ?? {
    bridge: 0,
    feeWallet: 0,
    sequencer: 0,
  }
}

function getBridgeFees(spec: DeploymentSpec): { depositFeeSats: string; minWithdrawalAmountWei: string; withdrawalFeeWei: string } {
  return {
    depositFeeSats: spec.bridge.fees.depositFeeSats ?? spec.bridge.fees.deposit ?? '0',
    minWithdrawalAmountWei: spec.bridge.fees.minWithdrawalAmountWei ?? spec.bridge.fees.minWithdrawalAmount ?? '0',
    withdrawalFeeWei: spec.bridge.fees.withdrawalFeeWei ?? spec.bridge.fees.withdrawal ?? '0',
  }
}

function getGenesisValues(spec: DeploymentSpec): { baseFeePerGasWei: number; deployerInitialBalanceWei: string; maxEthSupplyWei: string } {
  return {
    baseFeePerGasWei: spec.genesis.baseFeePerGasWei ?? spec.genesis.baseFeePerGas ?? 0,
    deployerInitialBalanceWei: spec.genesis.deployerInitialBalanceWei ?? spec.genesis.deployerInitialBalance ?? '0',
    maxEthSupplyWei: spec.genesis.maxEthSupplyWei ?? spec.genesis.maxEthSupply ?? '0',
  }
}

function getDogecoinExternalRpc(spec: DeploymentSpec): NonNullable<DeploymentSpec['dogecoin']['externalRpc']> {
  return spec.dogecoin.externalRpc ?? {
    password: spec.dogecoin.rpc?.password ?? '',
    url: spec.dogecoin.rpc?.url ?? '',
    username: spec.dogecoin.rpc?.username ?? '',
  }
}

function getDogecoinClusterRpc(spec: DeploymentSpec): NonNullable<DeploymentSpec['dogecoin']['clusterRpc']> {
  return spec.dogecoin.clusterRpc ?? {
    password: spec.dogecoin.rpc?.password ?? '',
    username: spec.dogecoin.rpc?.username ?? '',
  }
}

const DEFAULT_DATABASE_NAMES = {
  adminSystem: 'admin_system',
  blockscout: 'blockscout',
  bridgeHistory: 'bridge_history',
  chainMonitor: 'chain_monitor',
  coordinator: 'coordinator',
  gasOracle: 'gas_oracle',
  rollupExplorer: 'rollup_explorer',
  rollupNode: 'rollup_node',
} as const

const DEFAULT_L1_FEE_VAULT_ADDR = '0x1111111111111111111111111111111111111111'
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000'
const PLACEHOLDER_L1_SCROLL_MESSENGER_ADDRESS = '0x0000000000000000000000000000000000000001'
const PLACEHOLDER_L2_MESSENGER_ADDRESS = '0x0000000000000000000000000000000000000002'
const PLACEHOLDER_MOAT_ADDRESS = '0x0000000000000000000000000000000000000003'

function getDbPassword(spec: DeploymentSpec, key: keyof NonNullable<DeploymentSpec['database']['credentials']>): string {
  return spec.database.credentials?.[key] || ''
}

function deriveNetworkAlias(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[^\da-z-]/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '') || 'devnet'
}

function resolveDogecoinChainId(network: DeploymentSpec['dogecoin']['network']): number {
  switch (network) {
    case 'mainnet': {
      return 1
    }

    case 'testnet': {
      return 111_111
    }

    case 'regtest': {
      return 5_555_555
    }
  }
}

function assertGeneratedDataNetworkConsistency(configs: GeneratedConfigs): void {
  const dogeConfig = toml.parse(configs['doge-config.toml']) as toml.JsonMap
  const setupDefaults = toml.parse(configs['setup_defaults.toml']) as toml.JsonMap
  const protocolSeed = toml.parse(configs['protocol_seed.toml']) as toml.JsonMap

  const dogeNetwork = dogeConfig.network
  const setupNetwork = setupDefaults.network
  if (dogeNetwork !== setupNetwork) {
    throw new Error(
      `.data network mismatch: doge-config.toml network=${String(dogeNetwork)} but setup_defaults.toml network=${String(setupNetwork)}`
    )
  }

  if (dogeNetwork !== 'mainnet' && dogeNetwork !== 'testnet' && dogeNetwork !== 'regtest') {
    throw new Error(`.data network mismatch: unsupported doge-config.toml network=${String(dogeNetwork)}`)
  }

  const expectedDogecoinChainId = resolveDogecoinChainId(dogeNetwork as DeploymentSpec['dogecoin']['network'])
  const protocol = protocolSeed.protocol as toml.JsonMap | undefined
  const actualDogecoinChainId = protocol?.dogecoin_chain_id
  if (actualDogecoinChainId !== expectedDogecoinChainId) {
    throw new Error(
      `.data network mismatch: ${dogeNetwork} requires protocol_seed.toml dogecoin_chain_id=${expectedDogecoinChainId}, got ${String(actualDogecoinChainId)}`
    )
  }
}

function getEthereumDaChain(rawSpec: DeploymentSpec): keyof typeof ETHEREUM_DA_DEFAULTS {
  return rawSpec.ethereumDa?.chain || (rawSpec.metadata.environment === 'mainnet' ? 'mainnet' : 'sepolia')
}

function getEthereumDaChainId(rawSpec: DeploymentSpec): number {
  const ethereumDaChain = getEthereumDaChain(rawSpec)
  return rawSpec.ethereumDa?.chainId || ETHEREUM_DA_DEFAULTS[ethereumDaChain].chainId
}

export function getAwsSignerConfigFromSpec(spec: DeploymentSpec): NonNullable<DogeConfig['awsSigner']> | undefined {
  if (!spec.signing.awsKms) {
    return undefined
  }

  const { accountId, region } = spec.signing.awsKms
  if (!accountId || !region) {
    return undefined
  }

  return {
    accountId,
    ecsClusterName: spec.signing.awsKms?.ecsClusterName || 'default',
    networkAlias: spec.signing.awsKms?.networkAlias || deriveNetworkAlias(spec.metadata.name),
    region,
  }
}

export function getDummySignerProviderFromSpec(spec: DeploymentSpec): NonNullable<NonNullable<DogeConfig['dummySigner']>['provider']> | undefined {
  if (spec.signing.awsKms) {
    return 'aws'
  }

  if (spec.signing.local) {
    return 'local'
  }

  return undefined
}

/**
 * Fill fields that are mechanically derived from higher-level DeploymentSpec
 * intent. Explicit non-account values win, so existing fully-expanded specs keep
 * working. Account addresses are derived from resolvable private keys because
 * the private key is the source of truth for those public addresses.
 */
export function normalizeDeploymentSpec(spec: DeploymentSpec): DeploymentSpec {
  const frontend = (spec.frontend ?? {}) as Partial<DeploymentSpec['frontend']>
  const accounts = normalizeAccounts(spec.accounts)
  const baseDomain = frontend.baseDomain || spec.metadata?.name || 'localhost'
  const protocol = inferFrontendProtocol(frontend, baseDomain)
  const existingHosts = (frontend.hosts || {}) as Partial<FrontendHosts>
  const subdomains = {
    ...DEFAULT_FRONTEND_SUBDOMAINS,
    ...frontend.subdomains,
  } as Partial<Record<FrontendHostKey, string>>
  const shouldDeriveOptionalHosts = !frontend.hosts

  const hostFor = (key: FrontendHostKey): string =>
    existingHosts[key] || buildHost(baseDomain, subdomains[key])

  const optionalHostFor = (key: FrontendHostKey): string | undefined => {
    if (existingHosts[key]) return existingHosts[key]
    if ((frontend.subdomains as FrontendSubdomains | undefined)?.[key] || shouldDeriveOptionalHosts) {
      return buildHost(baseDomain, subdomains[key])
    }

    return undefined
  }

  const hosts: FrontendHosts = {
    adminDashboard: hostFor('adminDashboard'),
    blockscout: hostFor('blockscout'),
    bridgeHistoryApi: hostFor('bridgeHistoryApi'),
    coordinatorApi: hostFor('coordinatorApi'),
    frontend: hostFor('frontend'),
    grafana: hostFor('grafana'),
    rollupExplorerApi: hostFor('rollupExplorerApi'),
    rpcGateway: hostFor('rpcGateway'),
  }

  for (const key of [
    'blockbook',
    'blockscoutBackend',
    'celestia',
    'dogecoin',
    'l1Devnet',
    'l1Explorer',
    'rpcGatewayWs',
    'tso',
  ] as FrontendHostKey[]) {
    const host = optionalHostFor(key)
    if (host) {
      hosts[key] = host
    }
  }

  const existingExternalUrls = (frontend.externalUrls || {}) as Partial<FrontendExternalUrls>
  const externalUrls = {
    adminDashboard: existingExternalUrls.adminDashboard || publicUrl(protocol, hosts.adminDashboard),
    bridgeApi: existingExternalUrls.bridgeApi || publicUrl(protocol, hosts.bridgeHistoryApi, '/api'),
    grafana: existingExternalUrls.grafana || publicUrl(protocol, hosts.grafana),
    l1Explorer: existingExternalUrls.l1Explorer || publicUrl(protocol, hosts.blockbook || hosts.blockscout),
    l1Rpc: existingExternalUrls.l1Rpc || publicUrl(protocol, hosts.rpcGateway),
    l2Explorer: existingExternalUrls.l2Explorer || publicUrl(protocol, hosts.blockscout),
    l2Rpc: existingExternalUrls.l2Rpc || publicUrl(protocol, hosts.rpcGateway),
    rollupScanApi: existingExternalUrls.rollupScanApi || publicUrl(protocol, hosts.rollupExplorerApi, '/api'),
  }

  const verification = spec.contracts?.verification
    ? {
      ...spec.contracts.verification,
      l1ExplorerUri: spec.contracts.verification.l1ExplorerUri || externalUrls.l1Explorer,
      l2ExplorerUri: spec.contracts.verification.l2ExplorerUri || externalUrls.l2Explorer,
    }
    : undefined

  return {
    ...spec,
    ...(accounts ? { accounts } : {}),
    contracts: {
      ...spec.contracts,
      ...(verification ? { verification } : {}),
    },
    frontend: {
      ...spec.frontend,
      baseDomain,
      externalUrls,
      hosts,
      protocol,
    },
  }
}

/**
 * Validate a DeploymentSpec
 */
export function validateDeploymentSpec(rawSpec: DeploymentSpec): ValidationResult {
  const spec = normalizeDeploymentSpec(rawSpec)
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

  if (spec.dogecoin?.network && spec.network?.l1ChainId) {
    const expectedDogecoinChainId = resolveDogecoinChainId(spec.dogecoin.network)
    if (spec.network.l1ChainId !== expectedDogecoinChainId) {
      errors.push({
        code: 'E010_DOGECOIN_NETWORK_MISMATCH',
        message: `network.l1ChainId (${spec.network.l1ChainId}) does not match dogecoin.network ${spec.dogecoin.network} (${expectedDogecoinChainId})`,
        path: 'network.l1ChainId',
      })
    }
  }

  // Accounts validation
  if (!spec.accounts?.owner?.address) {
    errors.push({
      code: 'E002_MISSING_REQUIRED_FIELD',
      message: 'Owner address is required',
      path: 'accounts.owner.address'
    })
  }

  for (const key of PRIVATE_KEY_ACCOUNT_KEYS) {
    const rawAccount = rawSpec.accounts?.[key]
    const normalizedAccount = spec.accounts?.[key]

    if (!rawAccount?.privateKey) {
      warnings.push({
        message: `${key} key is not set in the spec`,
        path: `accounts.${key}`,
        suggestion: 'Run setup gen-keystore to generate this internal service account before gen-l2-artifacts.'
      })
      continue
    }

    const derived = deriveAddressFromPrivateKey(rawAccount.privateKey)
    if (derived.error) {
      errors.push({
        code: 'E008_INVALID_PRIVATE_KEY',
        message: `Invalid private key for ${key}: ${derived.error}`,
        path: `accounts.${key}.privateKey`
      })
    }

    const explicitAddress = addressForValidation(rawAccount.address)
    if (explicitAddress && derived.address && explicitAddress.toLowerCase() !== derived.address.toLowerCase()) {
      errors.push({
        code: 'E009_ACCOUNT_ADDRESS_MISMATCH',
        message: `${key} address does not match the provided private key`,
        path: `accounts.${key}.address`
      })
    }

    if (!normalizedAccount?.address) {
      warnings.push({
        message: `${key} address cannot be derived yet`,
        path: `accounts.${key}.address`,
        suggestion: 'Set the referenced environment variable or let setup gen-keystore generate the account later.'
      })
    }
  }

  // Validate Ethereum addresses
  const ethAddressPattern = /^0x[\dA-Fa-f]{40}$/
  const addressFields = [
    { path: 'accounts.deployer.address', value: spec.accounts?.deployer?.address },
    { path: 'accounts.owner.address', value: spec.accounts?.owner?.address },
    { path: 'accounts.l1CommitSender.address', value: spec.accounts?.l1CommitSender?.address },
    { path: 'accounts.l1FinalizeSender.address', value: spec.accounts?.l1FinalizeSender?.address },
    { path: 'accounts.l1GasOracleSender.address', value: spec.accounts?.l1GasOracleSender?.address },
    { path: 'accounts.l2GasOracleSender.address', value: spec.accounts?.l2GasOracleSender?.address },
  ]

  for (const field of addressFields) {
    const value = addressForValidation(field.value)
    if (value && !ethAddressPattern.test(value)) {
      errors.push({
        code: 'E004_INVALID_ADDRESS',
        message: `Invalid Ethereum address: ${value}`,
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

  // Signing validation. CubeSigner provides the TEE key; dummy-signers provides attestation keys.
  if (!spec.signing?.cubesigner?.roles || spec.signing.cubesigner.roles.length === 0) {
    warnings.push({
      message: 'CubeSigner TEE role is not set yet',
      path: 'signing.cubesigner.roles',
      suggestion: 'Run setup cubesigner-init to create or select the TEE role before bridge/signing artifacts are finalized',
    })
  }

  if (spec.signing?.awsKms) {
    if (!spec.signing.awsKms.accountId) {
      errors.push({
        code: 'E002_MISSING_REQUIRED_FIELD',
        message: 'AWS account ID is required for ECS Express dummy-signers',
        path: 'signing.awsKms.accountId',
      })
    }

    if (!spec.signing.awsKms.region) {
      errors.push({
        code: 'E002_MISSING_REQUIRED_FIELD',
        message: 'AWS region is required for ECS Express dummy-signers',
        path: 'signing.awsKms.region',
      })
    }
  }

  if (!getDummySignerProviderFromSpec(spec)) {
    warnings.push({
      message: 'Attestation signer configuration is not set yet',
      path: 'signing',
      suggestion: 'Configure signing.awsKms for ECS Express dummy-signers or signing.local for locally-run dummy-signers.',
    })
  }

  const ethereumDaChain = spec.ethereumDa?.chain || (spec.metadata.environment === 'mainnet' ? 'mainnet' : 'sepolia')
  if ((ethereumDaChain === 'mainnet' || ethereumDaChain === 'sepolia') && !spec.ethereumDa?.beaconRpcUrl) {
    errors.push({
      code: 'E002_MISSING_REQUIRED_FIELD',
      message: 'ethereumDa.beaconRpcUrl is required for mainnet/sepolia deployments',
      path: 'ethereumDa.beaconRpcUrl',
    })
  }

  if ((ethereumDaChain === 'mainnet' || ethereumDaChain === 'sepolia') && !spec.ethereumDa?.l1RpcUrl) {
    errors.push({
      code: 'E002_MISSING_REQUIRED_FIELD',
      message: 'ethereumDa.l1RpcUrl is required for mainnet/sepolia deployments',
      path: 'ethereumDa.l1RpcUrl',
    })
  }

  if (spec.dogecoin?.indexerStartHeight !== undefined) {
    if (!Number.isSafeInteger(spec.dogecoin.indexerStartHeight) || spec.dogecoin.indexerStartHeight < 0) {
      errors.push({
        code: 'E011_INVALID_DOGECOIN_HEIGHT',
        message: 'dogecoin.indexerStartHeight must be a non-negative integer',
        path: 'dogecoin.indexerStartHeight',
      })
    }

    warnings.push({
      message: 'dogecoin.indexerStartHeight is deprecated',
      path: 'dogecoin.indexerStartHeight',
      suggestion: 'Omit it from the spec; bridge-init derives and writes the start height.',
    })
  }

  if (spec.dogecoin?.l1GenesisBlock !== undefined) {
    if (!Number.isSafeInteger(spec.dogecoin.l1GenesisBlock) || spec.dogecoin.l1GenesisBlock < 0) {
      errors.push({
        code: 'E011_INVALID_DOGECOIN_HEIGHT',
        message: 'dogecoin.l1GenesisBlock must be a non-negative integer',
        path: 'dogecoin.l1GenesisBlock',
      })
    } else if (
      spec.dogecoin.indexerStartHeight !== undefined &&
      spec.dogecoin.l1GenesisBlock > 0 &&
      spec.dogecoin.indexerStartHeight >= spec.dogecoin.l1GenesisBlock
    ) {
      errors.push({
        code: 'E011_INVALID_DOGECOIN_HEIGHT',
        message: 'dogecoin.indexerStartHeight must be lower than dogecoin.l1GenesisBlock because l1-interface starts scanning from start_height + 1',
        path: 'dogecoin.indexerStartHeight',
      })
    }
  }

  if (spec.dogecoin?.rpc !== undefined) {
    warnings.push({
      message: 'dogecoin.rpc is deprecated because it mixed external and K8s-internal RPC semantics',
      path: 'dogecoin.rpc',
      suggestion: 'Use dogecoin.externalRpc for operator-side RPC and dogecoin.clusterRpc for K8s-internal credentials.',
    })
  }

  if (!spec.dogecoin?.externalRpc && !spec.dogecoin?.rpc) {
    errors.push({
      code: 'E002_MISSING_REQUIRED_FIELD',
      message: 'External Dogecoin RPC is required',
      path: 'dogecoin.externalRpc',
    })
  }

  if (spec.bridge?.feeRateSatPerKvb !== undefined) {
    warnings.push({
      message: 'bridge.feeRateSatPerKvb is deprecated',
      path: 'bridge.feeRateSatPerKvb',
      suggestion: 'Use bridge.feeRateSatsPerKvb so the unit is explicit.',
    })
  }

  if (spec.bridge?.targetAmounts) {
    warnings.push({
      message: 'bridge.targetAmounts is deprecated',
      path: 'bridge.targetAmounts',
      suggestion: 'Use bridge.targetAmountsSats so the unit is explicit.',
    })
  }

  if (spec.bridge?.fees?.deposit !== undefined || spec.bridge?.fees?.withdrawal !== undefined || spec.bridge?.fees?.minWithdrawalAmount !== undefined) {
    warnings.push({
      message: 'legacy bridge fee fields are deprecated',
      path: 'bridge.fees',
      suggestion: 'Use depositFeeSats, withdrawalFeeWei, and minWithdrawalAmountWei.',
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

  if (spec.bridge?.teePubkey) {
    const teePubkeyPattern = /^(?:0x)?[\dA-Fa-f]{66}$/
    if (!teePubkeyPattern.test(spec.bridge.teePubkey)) {
      errors.push({
        code: 'E007_INVALID_TEE_PUBKEY',
        message: 'TEE public key must be a compressed 33-byte hex string',
        path: 'bridge.teePubkey'
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
export function generateConfigToml(rawSpec: DeploymentSpec): string {
  const spec = normalizeDeploymentSpec(rawSpec)
  const bridgeFees = getBridgeFees(spec)
  const genesis = getGenesisValues(spec)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dynamic config building
  const config: Record<string, any> = {}

  // [general] section
  config.general = {
    CHAIN_ID_L1: spec.network.l1ChainId,
    CHAIN_ID_L2: spec.network.l2ChainId,
    CHAIN_NAME_L1: spec.network.l1ChainName,
    CHAIN_NAME_L2: spec.network.l2ChainName,
    L1_CONTRACT_DEPLOYMENT_BLOCK: spec.contracts.l1DeploymentBlock || 0,
    L1_RPC_ENDPOINT: L1_INTERFACE_RPC_ENDPOINT,
    L1_RPC_ENDPOINT_WEBSOCKET: L1_INTERFACE_RPC_WEBSOCKET_ENDPOINT,
    L2_RPC_ENDPOINT,
  }

  if (spec.rollup.verifierDigests) {
    config.general.VERIFIER_DIGEST_1 = spec.rollup.verifierDigests.digest1
    config.general.VERIFIER_DIGEST_2 = spec.rollup.verifierDigests.digest2
  }

  // [accounts] section
  config.accounts = {
    DEPLOYER_ADDR: optionalAccountAddress(spec, 'deployer'),
    DEPLOYER_PRIVATE_KEY: optionalAccountPrivateKey(spec, 'deployer'),
    L1_COMMIT_SENDER_ADDR: optionalAccountAddress(spec, 'l1CommitSender'),
    L1_COMMIT_SENDER_PRIVATE_KEY: optionalAccountPrivateKey(spec, 'l1CommitSender'),
    L1_FINALIZE_SENDER_ADDR: optionalAccountAddress(spec, 'l1FinalizeSender'),
    L1_FINALIZE_SENDER_PRIVATE_KEY: optionalAccountPrivateKey(spec, 'l1FinalizeSender'),
    L1_GAS_ORACLE_SENDER_ADDR: optionalAccountAddress(spec, 'l1GasOracleSender'),
    L1_GAS_ORACLE_SENDER_PRIVATE_KEY: optionalAccountPrivateKey(spec, 'l1GasOracleSender'),
    L2_GAS_ORACLE_SENDER_ADDR: optionalAccountAddress(spec, 'l2GasOracleSender'),
    L2_GAS_ORACLE_SENDER_PRIVATE_KEY: optionalAccountPrivateKey(spec, 'l2GasOracleSender'),
    OWNER_ADDR: spec.accounts.owner.address,
  }

  // [db] section
  const dbAdmin = spec.database.admin
  const dbHost = dbAdmin?.vpcHost || dbAdmin?.host || 'localhost'
  const dbPort = dbAdmin?.vpcPort || dbAdmin?.port || 5432

  config.db = {
    ADMIN_SYSTEM_BACKEND_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, DEFAULT_DATABASE_NAMES.adminSystem,
      'admin_system', getDbPassword(spec, 'adminSystemPassword')
    ),
    BLOCKSCOUT_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, DEFAULT_DATABASE_NAMES.blockscout,
      'blockscout', getDbPassword(spec, 'blockscoutPassword')
    ),
    BRIDGE_HISTORY_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, DEFAULT_DATABASE_NAMES.bridgeHistory,
      'bridge_history', getDbPassword(spec, 'bridgeHistoryPassword')
    ),
    CHAIN_MONITOR_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, DEFAULT_DATABASE_NAMES.chainMonitor,
      'chain_monitor', getDbPassword(spec, 'chainMonitorPassword')
    ),
    COORDINATOR_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, DEFAULT_DATABASE_NAMES.coordinator,
      'coordinator', getDbPassword(spec, 'coordinatorPassword')
    ),
    GAS_ORACLE_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, DEFAULT_DATABASE_NAMES.gasOracle,
      'gas_oracle', getDbPassword(spec, 'gasOraclePassword')
    ),
    ROLLUP_EXPLORER_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, DEFAULT_DATABASE_NAMES.rollupExplorer,
      'rollup_explorer', getDbPassword(spec, 'rollupExplorerPassword')
    ),
    ROLLUP_NODE_DB_CONNECTION_STRING: buildDbConnectionString(
      dbHost, dbPort, DEFAULT_DATABASE_NAMES.rollupNode,
      'rollup_node', getDbPassword(spec, 'rollupNodePassword')
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
    ADMIN_SYSTEM_DASHBOARD_URI: spec.frontend.externalUrls.adminDashboard || '',
    BASE_CHAIN: spec.network.tokenSymbol,
    BRIDGE_API_URI: spec.frontend.externalUrls.bridgeApi,
    CONNECT_WALLET_PROJECT_ID: spec.frontend.walletConnectProjectId || '',
    ETH_SYMBOL: spec.network.tokenSymbol,
    EXTERNAL_EXPLORER_URI_L1: spec.frontend.externalUrls.l1Explorer,
    EXTERNAL_EXPLORER_URI_L2: spec.frontend.externalUrls.l2Explorer,
    EXTERNAL_RPC_URI_L1: spec.frontend.externalUrls.l1Rpc,
    EXTERNAL_RPC_URI_L2: spec.frontend.externalUrls.l2Rpc,
    GRAFANA_URI: spec.frontend.externalUrls.grafana || '',
    ROLLUPSCAN_API_URI: spec.frontend.externalUrls.rollupScanApi,
  }

  // [genesis] section
  config.genesis = {
    BASE_FEE_PER_GAS: genesis.baseFeePerGasWei,
    L2_DEPLOYER_INITIAL_BALANCE: genesis.deployerInitialBalanceWei,
    L2_MAX_ETH_SUPPLY: genesis.maxEthSupplyWei,
  }

  // [contracts] section
  config.contracts = {
    BLOB_SCALAR: spec.contracts.gasOracle.blobScalar,
    DEPLOYMENT_SALT: spec.contracts.deploymentSalt,
    DEPOSIT_FEE: bridgeFees.depositFeeSats,
    L1_FEE_VAULT_ADDR: DEFAULT_L1_FEE_VAULT_ADDR,
    L2_BRIDGE_FEE_RECIPIENT_ADDR: spec.bridge.feeRecipient,
    MIN_WITHDRAWAL_AMOUNT: bridgeFees.minWithdrawalAmountWei,
    PENALTY_FACTOR: spec.contracts.gasOracle.penaltyFactor,
    PENALTY_THRESHOLD: spec.contracts.gasOracle.penaltyThreshold,
    SCALAR: spec.contracts.gasOracle.scalar,
    WITHDRAWAL_FEE: bridgeFees.withdrawalFeeWei,
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

    if (spec.contracts.overrides.l2Wdoge) {
      config.contracts.overrides.L2_WDOGE = spec.contracts.overrides.l2Wdoge
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

  if (spec.infrastructure.sequencers?.length) {
    const sequencers = [...spec.infrastructure.sequencers].sort((a, b) => a.index - b.index)
    const primarySequencer = sequencers.find(sequencer => sequencer.index === 0) || sequencers[0]

    config.sequencer = {
      L2_GETH_STATIC_PEERS: sequencers.map(sequencer => sequencer.enodeUrl).filter(Boolean),
    }

    if (primarySequencer.signerAddress) {
      config.sequencer.L2GETH_SIGNER_ADDRESS = primarySequencer.signerAddress
    }

    for (const sequencer of sequencers) {
      if (sequencer.index === 0) continue
      const section = `sequencer-${sequencer.index}`
      config.sequencer[section] = {}
      if (sequencer.signerAddress) {
        config.sequencer[section].L2GETH_SIGNER_ADDRESS = sequencer.signerAddress
      }
    }
  }

  // [coordinator] section
  config.coordinator = {
    BATCH_COLLECTION_TIME_SEC: spec.rollup.coordinator.batchCollectionTimeSec,
    BUNDLE_COLLECTION_TIME_SEC: spec.rollup.coordinator.bundleCollectionTimeSec,
    CHUNK_COLLECTION_TIME_SEC: spec.rollup.coordinator.chunkCollectionTimeSec,
    COORDINATOR_JWT_SECRET_KEY: spec.rollup.coordinator.jwtSecretKey || '',
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

  if (spec.frontend.hosts.dogecoin) {
    config.ingress.DOGECOIN_HOST = spec.frontend.hosts.dogecoin
  }

  if (spec.frontend.hosts.blockbook) {
    config.ingress.BLOCKBOOK_HOST = spec.frontend.hosts.blockbook
  }

  return toml.stringify(resolveEnvRefsDeep(config) as toml.JsonMap)
}

/**
 * Generate doge-config.toml content from DeploymentSpec
 */
export function generateDogeConfigToml(rawSpec: DeploymentSpec): string {
  const spec = normalizeDeploymentSpec(rawSpec)
  const externalRpc = getDogecoinExternalRpc(spec)
  const clusterRpc = getDogecoinClusterRpc(spec)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dynamic config building
  const config: Record<string, any> = {}
  const ethereumDaChain = getEthereumDaChain(spec)
  const ethereumDaDefaults = ETHEREUM_DA_DEFAULTS[ethereumDaChain]

  config.network = spec.dogecoin.network

  config.rpc = {
    password: externalRpc.password || '',
    url: externalRpc.url,
    username: externalRpc.username || '',
  }

  config.dogecoinClusterRpc = {
    password: clusterRpc.password,
    username: clusterRpc.username,
  }

  config.ethereumDa = {
    beaconRpcUrl: spec.ethereumDa?.beaconRpcUrl || ethereumDaDefaults.beaconRpcUrl,
    chain: ethereumDaChain,
    chainId: spec.ethereumDa?.chainId || ethereumDaDefaults.chainId,
    minFinality: spec.ethereumDa?.minFinality || ethereumDaDefaults.minFinality,
    submitterRpcUrl: spec.ethereumDa?.l1RpcUrl || ethereumDaDefaults.submitterRpcUrl,
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
    dogecoinIndexerStartHeight: String(getDogecoinIndexerStartHeight(spec)),
    l1GenesisBlock: String(getL1GenesisBlock(spec)),
  }

  config.frontend = {
    bridgeUrl: publicUrl(spec.frontend.protocol || 'https', spec.frontend.hosts.frontend),
    l2Explorer: spec.frontend.externalUrls.l2Explorer,
    l2Url: spec.frontend.externalUrls.l2Rpc,
  }

  // Add signing configuration
  if (spec.signing.cubesigner) {
    config.cubesigner = {
      roles: (spec.signing.cubesigner.roles || []).map(role => ({
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

  const awsSignerConfig = getAwsSignerConfigFromSpec(spec)
  if (awsSignerConfig) {
    config.awsSigner = awsSignerConfig
  }

  if (spec.signing.local) {
    config.localSigners = {
      signers: spec.signing.local.signers,
    }
  }

  if (spec.signing.tsoServiceUrl) {
    config.signerUrls = [spec.signing.tsoServiceUrl]
  }

  const dummySignerProvider = getDummySignerProviderFromSpec(spec)
  if (dummySignerProvider) {
    config.dummySigner = {
      provider: dummySignerProvider,
    }
  }

  if (spec.test) {
    config.test = {
      mockFinalizeEnabled: spec.test.mockFinalizeEnabled,
      mockFinalizeTimeout: spec.test.mockFinalizeTimeoutSec,
    }
  }

  return toml.stringify(resolveEnvRefsDeep(config) as toml.JsonMap)
}

/**
 * Generate setup_defaults.toml content from DeploymentSpec
 */
export function generateSetupDefaultsToml(rawSpec: DeploymentSpec): string {
  const spec = normalizeDeploymentSpec(rawSpec)
  const externalRpc = getDogecoinExternalRpc(spec)
  const targetAmountsSats = getBridgeTargetAmountsSats(spec)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dynamic config building
  const config: Record<string, any> = {
    attestation_key_count: spec.bridge.keyCounts.attestation,
    attestation_threshold: spec.bridge.thresholds.attestation,
    bridge_target_amount: targetAmountsSats.bridge,
    confirmations_required: spec.bridge.confirmationsRequired,
    deposit_eth_recipient_address_hex: optionalAccountAddress(spec, 'deployer'),
    dogecoin_rpc_pass: externalRpc.password || '',
    dogecoin_rpc_url: externalRpc.url,
    dogecoin_rpc_user: externalRpc.username || '',
    fee_rate_sat_per_kvb: getBridgeFeeRateSatsPerKvb(spec),
    fee_wallet_target_amount: targetAmountsSats.feeWallet,
    network: spec.dogecoin.network,
    recovery_key_count: spec.bridge.keyCounts.recovery,
    recovery_threshold: spec.bridge.thresholds.recovery,
    seed_string: spec.bridge.seedString,
    sequencer_target_amount: targetAmountsSats.sequencer,
    timelock: spec.bridge.timelock,
  }

  if (spec.bridge.teePubkey) {
    config.tee_pubkey = spec.bridge.teePubkey.replace(/^0x/, '')
  } else if (spec.signing.cubesigner?.roles?.length) {
    const key = spec.signing.cubesigner.roles[0].keys[0]
    const teePubkey = key?.publicKey?.replace(/^0x/, '')
    if (teePubkey) {
      config.tee_pubkey = teePubkey
    }
  }

  return `${toml.stringify(resolveEnvRefsDeep(config) as toml.JsonMap)}
[[base_funding_utxos]]
txid = "<txid of the DOGE sent to the helper address>"
vout = 0
amount_sats = 7_000_000_000
prev_tx_hex = "<raw tx hex of the funding tx>"
`
}

/**
 * Generate protocol_seed.toml content from DeploymentSpec
 */
export function generateProtocolSeedToml(rawSpec: DeploymentSpec): string {
  const spec = normalizeDeploymentSpec(rawSpec)
  const ethChainId = getEthereumDaChainId(spec)

  const protocol: toml.JsonMap = {}
  protocol.protocol_version = 2
  protocol.dogecoin_chain_id = resolveDogecoinChainId(spec.dogecoin.network)
  protocol.l2_chain_id = spec.network.l2ChainId
  protocol.eth_chain_id = ethChainId

  const chainAnchors: toml.JsonMap = {}
  chainAnchors.initial_ethereum_block_hash = ZERO_BYTES32
  chainAnchors.initial_tx_index = 0
  chainAnchors.initial_tx_blob_index = 0
  chainAnchors.genesis_batch_hash = ZERO_BYTES32
  chainAnchors.genesis_state_root = ZERO_BYTES32

  const depositQueueTransform: toml.JsonMap = {}
  depositQueueTransform.l1_scroll_messenger_address = PLACEHOLDER_L1_SCROLL_MESSENGER_ADDRESS
  depositQueueTransform.l2_messenger_address = PLACEHOLDER_L2_MESSENGER_ADDRESS
  depositQueueTransform.moat_address = PLACEHOLDER_MOAT_ADDRESS
  depositQueueTransform.message_queue_gas_limit = spec.rollup.maxL1MessageGasLimit

  const protocolConfig: toml.JsonMap = {}
  protocolConfig.l2_chain_id = spec.network.l2ChainId
  protocolConfig.eth_chain_id = ethChainId
  protocolConfig.key_rotation_min_grace_wf_txs = 100
  protocolConfig.min_deposit_sats = 100_000
  protocolConfig.deposit_queue_transform = depositQueueTransform

  const protocolConfigSeed: toml.JsonMap = {}
  protocolConfigSeed.protocol_config = protocolConfig

  const config: toml.JsonMap = {}
  config.protocol = protocol
  config.chain_anchors = chainAnchors
  config.protocol_config_seed = protocolConfigSeed

  return toml.stringify(resolveEnvRefsDeep(config) as toml.JsonMap)
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
  'protocol_seed.toml': string
  'setup_defaults.toml': string
}

export function generateAllConfigs(spec: DeploymentSpec): GeneratedConfigs {
  const configs = {
    'config.toml': generateConfigToml(spec),
    'doge-config.toml': generateDogeConfigToml(spec),
    'protocol_seed.toml': generateProtocolSeedToml(spec),
    'setup_defaults.toml': generateSetupDefaultsToml(spec),
  }

  assertGeneratedDataNetworkConsistency(configs)
  return configs
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

  // Write protocol_seed.toml to .data directory
  fs.writeFileSync(path.join(dogeConfigDir, 'protocol_seed.toml'), configs['protocol_seed.toml'])
}
