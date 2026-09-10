/**
 * Helm Values Generator
 *
 * Generates values/*.yaml files for all Helm charts from a DeploymentSpec.
 * These files configure each Kubernetes service with the correct settings.
 *
 * Supports multiple secret providers:
 * - AWS Secrets Manager (provider: 'aws')
 * - GCP Secret Manager (provider: 'gcp')
 * - Kubernetes Secrets directly (provider: 'local')
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic YAML/JSON config building requires any */

import * as yaml from 'js-yaml'

import type { DeploymentSpec, ImagesConfig } from '../types/deployment-spec.js'

import {
  L1_INTERFACE_RPC_ENDPOINT,
  L2_RPC_ENDPOINT,
} from '../config/constants.js'
import {CONTRACTS_DOCKER_DEFAULT_TAG, DOCKER_REPOSITORY} from '../constants/docker.js'
import {
  getBridgeFeeRateSatsPerKvb,
  getDogecoinIndexerStartHeight,
  getL1GenesisBlock,
  normalizeDeploymentSpec,
} from './deployment-spec-generator.js'
import {
  resolveDogecoinKubernetesEndpoints,
} from './kubernetes-endpoints.js'
import {buildProofCoordinatorIngress} from './proof-coordinator-ingress.js'
import {
  ensureWithdrawalChartWiring,
  ensureWithdrawalProofActivationSwitch,
} from './withdrawal-config.js'

export interface GeneratedValuesFiles {
  [filename: string]: string
}

/**
 * Secret provider configuration derived from DeploymentSpec
 */
interface SecretProviderConfig {
  // AWS-specific
  awsRegion?: string
  // GCP-specific
  gcpProject?: string
  prefix: string
  provider: 'aws' | 'gcp' | 'kubernetes'
}

/**
 * Get secret provider configuration from spec
 */
function getSecretProviderConfig(spec: DeploymentSpec): SecretProviderConfig {
  switch (spec.infrastructure.provider) {
    case 'aws': {
      return {
        awsRegion: spec.infrastructure.aws?.region || 'us-west-2',
        prefix: spec.infrastructure.aws?.secretsPrefix || 'scroll',
        provider: 'aws'
      }
    }

    case 'gcp': {
      return {
        gcpProject: spec.infrastructure.gcp?.project,
        prefix: spec.infrastructure.gcp?.secretsProject || spec.infrastructure.gcp?.project || 'default-project',
        provider: 'gcp'
      }
    }

    default: {
      return {
        prefix: 'scroll',
        provider: spec.infrastructure.local?.useK8sSecrets === false ? 'aws' : 'kubernetes'
      }
    }
  }
}

/**
 * Generate external secrets block based on provider
 */
function generateExternalSecrets(
  secretName: string,
  secretConfig: SecretProviderConfig,
  secretData: Array<{ property: string; remoteKey: string; secretKey: string }>
): Record<string, any> | null {
  // For local k8s secrets, we don't generate external secrets
  if (secretConfig.provider === 'kubernetes' || secretData.length === 0) {
    return null
  }

  const data = secretData.map(item => ({
    remoteRef: {
      key: `${secretConfig.prefix}/${item.remoteKey}`,
      property: item.property
    },
    secretKey: item.secretKey
  }))

  if (secretConfig.provider === 'aws') {
    return {
      [secretName]: {
        data,
        provider: 'aws',
        refreshInterval: '2m',
        serviceAccount: 'external-secrets',
        ...(secretConfig.awsRegion && { secretRegion: secretConfig.awsRegion })
      }
    }
  }

  if (secretConfig.provider === 'gcp') {
    return {
      [secretName]: {
        data,
        provider: 'gcpsm', // GCP Secret Manager provider name for external-secrets
        refreshInterval: '2m',
        serviceAccount: 'external-secrets',
        ...(secretConfig.gcpProject && { projectID: secretConfig.gcpProject })
      }
    }
  }

  return null
}

/**
 * Service name to DeploymentSpec image key mapping
 */
type ServiceImageKey = keyof NonNullable<ImagesConfig['services']>

const DEFAULT_L1_FEE_VAULT_ADDR = '0x1111111111111111111111111111111111111111'

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
    submitterRpcUrl: 'https://gateway.tenderly.co/public/sepolia',
  },
} as const

function getEthereumDaConfig(spec: DeploymentSpec): NonNullable<DeploymentSpec['ethereumDa']> {
  return spec.ethereumDa ?? {}
}

function getEthereumDaChain(spec: DeploymentSpec): keyof typeof ETHEREUM_DA_DEFAULTS {
  return getEthereumDaConfig(spec).chain || (spec.metadata.environment === 'mainnet' ? 'mainnet' : 'sepolia')
}

function getEthereumDaChainId(spec: DeploymentSpec): number {
  return getEthereumDaConfig(spec).chainId || ETHEREUM_DA_DEFAULTS[getEthereumDaChain(spec)].chainId
}

function getEthereumDaSubmitterRpcUrl(spec: DeploymentSpec): string {
  const ethereumDa = getEthereumDaConfig(spec)
  return ethereumDa.l1RpcUrl || ETHEREUM_DA_DEFAULTS[getEthereumDaChain(spec)].submitterRpcUrl
}

function getEthereumDaBeaconRpcUrl(spec: DeploymentSpec): string {
  return getEthereumDaConfig(spec).beaconRpcUrl || ETHEREUM_DA_DEFAULTS[getEthereumDaChain(spec)].beaconRpcUrl
}

function getDogecoinClusterRpc(spec: DeploymentSpec): NonNullable<DeploymentSpec['dogecoin']['clusterRpc']> {
  return spec.dogecoin.clusterRpc ?? {
    password: spec.dogecoin.rpc?.password ?? '',
    username: spec.dogecoin.rpc?.username ?? '',
  }
}

function getEthereumDaMinFinality(spec: DeploymentSpec): string {
  return getEthereumDaConfig(spec).minFinality || ETHEREUM_DA_DEFAULTS[getEthereumDaChain(spec)].minFinality
}

function getEthereumDaBatchConfig(spec: DeploymentSpec): NonNullable<NonNullable<DeploymentSpec['ethereumDa']>['batch']> {
  return getEthereumDaConfig(spec).batch ?? {}
}

function getEthereumDaS3ArchiveConfig(spec: DeploymentSpec): NonNullable<NonNullable<NonNullable<DeploymentSpec['ethereumDa']>['blobArchive']>['s3']> {
  return getEthereumDaConfig(spec).blobArchive?.s3 ?? {}
}

function isEthereumDaS3ArchiveEnabled(spec: DeploymentSpec): boolean {
  return getEthereumDaS3ArchiveConfig(spec).enabled === true
}

function getEthereumDaInboxWorkerStartBlock(spec: DeploymentSpec): number {
  return getEthereumDaConfig(spec).inboxWorker?.startBlock ?? 0
}

function getEthereumDaL2StartBlockNumber(spec: DeploymentSpec): number | undefined {
  return getEthereumDaConfig(spec).l2StartBlockNumber
}

function addStringEnvIfDefined(target: Record<string, string>, key: string, value: unknown): void {
  if (value === undefined || value === null) return
  target[key] = String(value)
}

function buildEthDaSubmitterBatchEnv(spec: DeploymentSpec): Record<string, string> {
  const batch = getEthereumDaBatchConfig(spec)
  const {cutover} = batch
  const env: Record<string, string> = {
    DOGEOS_ETH_DA_SUBMITTER_BATCH__COMPRESSION: batch.compression ?? 'auto',
    DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_JSON_PATH: '/app/genesis/genesis.json',
    DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_BLOCKS_PER_CHUNK: String(batch.maxBlocksPerChunk ?? 128),
    DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_CHUNKS_PER_BATCH: String(batch.maxChunksPerBatch ?? 1),
    DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_L2_GAS_PER_CHUNK: String(batch.maxL2GasPerChunk ?? 6_000_000),
    DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_UNCOMPRESSED_BATCH_BYTES_SIZE: String(batch.maxUncompressedBatchBytesSize ?? 131_072),
  }

  if (cutover) {
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__LAST_BATCH_HASH = cutover.lastBatchHash
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__LAST_BATCH_INDEX = String(cutover.lastBatchIndex)
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__NEXT_RELAYED_DEPOSIT_INDEX = String(cutover.nextRelayedDepositIndex)
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__NEXT_WITHDRAW_INDEX = String(cutover.nextWithdrawIndex)
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__RELAYED_DEPOSIT_QUEUE_HASH = cutover.relayedDepositQueueHash
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__STATE_ROOT = cutover.stateRoot
    env.DOGEOS_ETH_DA_SUBMITTER_BATCH__CUTOVER__WITHDRAW_ROOT = cutover.withdrawRoot
  }

  return env
}

function buildEthDaSubmitterPublishEnv(spec: DeploymentSpec): Record<string, string> {
  const {publish} = getEthereumDaConfig(spec)
  if (!publish) return {}

  const env: Record<string, string> = {}
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_PUBLISH__ALLOW_LIVENESS_BUDGET_OVERRIDE', publish.allowLivenessBudgetOverride)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_PUBLISH__BUDGET_WINDOW', publish.budgetWindow)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_PUBLISH__HIGH_BACKLOG_THRESHOLD', publish.highBacklogThreshold)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_PUBLISH__MAX_BATCH_WAIT', publish.maxBatchWait)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_PUBLISH__MAX_BLOBS_PER_TX', publish.maxBlobsPerTx)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_PUBLISH__MAX_LIVENESS_DELAY', publish.maxLivenessDelay)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_PUBLISH__MAX_PENDING_BLOB_TXS', publish.maxPendingBlobTxs)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_PUBLISH__TARGET_BLOBS_PER_TX', publish.targetBlobsPerTx)

  return env
}

function buildFeeOracleEthereumDaEnv(spec: DeploymentSpec): Record<string, string> {
  return {
    DOGEOS_FEE_ORACLE_ETHEREUM_DA__ETH_RPC_URL: getEthereumDaSubmitterRpcUrl(spec),
  }
}

function buildEthDaSubmitterS3Env(spec: DeploymentSpec): Record<string, string> {
  const s3 = getEthereumDaS3ArchiveConfig(spec)
  const env: Record<string, string> = {
    DOGEOS_ETH_DA_SUBMITTER_S3__ENABLED: isEthereumDaS3ArchiveEnabled(spec) ? 'true' : 'false',
  }

  if (!isEthereumDaS3ArchiveEnabled(spec)) return env

  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_S3__BUCKET', s3.bucket)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_S3__REGION', s3.region)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_S3__KEY_PREFIX', s3.keyPrefix)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_S3__ENDPOINT_URL', s3.endpointUrl)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_S3__FORCE_PATH_STYLE', s3.forcePathStyle)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_S3__POLL_INTERVAL_MS', s3.pollIntervalMs)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_S3__INITIAL_BACKOFF_MS', s3.initialBackoffMs)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_S3__MAX_BACKOFF_MS', s3.maxBackoffMs)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_S3__MAX_RETRIES', s3.maxRetries)
  addStringEnvIfDefined(env, 'DOGEOS_ETH_DA_SUBMITTER_S3__UPLOADING_TIMEOUT_MS', s3.uploadingTimeoutMs)

  return env
}

function buildEthereumDaS3BlobSourceEnv(prefix: string, spec: DeploymentSpec): Record<string, string> {
  const s3 = getEthereumDaS3ArchiveConfig(spec)
  if (!isEthereumDaS3ArchiveEnabled(spec) || !s3.publicBaseUrl) return {}

  const env: Record<string, string> = {
    [`${prefix}__BLOB_SOURCE__AWS_S3__URL`]: s3.publicBaseUrl,
  }

  addStringEnvIfDefined(env, `${prefix}__BLOB_SOURCE__AWS_S3__KEY_PREFIX`, s3.keyPrefix)
  addStringEnvIfDefined(env, `${prefix}__BLOB_SOURCE__AWS_S3__TIMEOUT_MS`, s3.timeoutMs)
  addStringEnvIfDefined(env, `${prefix}__BLOB_SOURCE__AWS_S3__TREAT_FORBIDDEN_AS_MISSING`, s3.treatForbiddenAsMissing)

  return env
}

/**
 * Resolve image configuration for a service
 *
 * Priority:
 * 1. Service-specific override from spec.images.services
 * 2. Default pullPolicy from spec.images.defaults
 * 3. Provided default values
 *
 * @param spec - The deployment spec
 * @param serviceKey - The service key in spec.images.services (e.g., 'l2Sequencer')
 * @param defaults - Default image configuration if not overridden
 * @returns Image configuration object with repository, tag, pullPolicy
 */
function resolveImage(
  spec: DeploymentSpec,
  serviceKey: ServiceImageKey,
  defaults: { pullPolicy?: 'Always' | 'IfNotPresent' | 'Never'; repository: string; tag: string }
): { pullPolicy: 'Always' | 'IfNotPresent' | 'Never'; repository: string; tag: string } {
  const imagesConfig = spec.images
  const serviceConfig = imagesConfig?.services?.[serviceKey]
  const defaultPullPolicy = imagesConfig?.defaults?.pullPolicy || defaults.pullPolicy || 'IfNotPresent'

  return {
    pullPolicy: serviceConfig?.pullPolicy || defaultPullPolicy,
    repository: serviceConfig?.repository || defaults.repository,
    tag: serviceConfig?.tag || defaults.tag
  }
}

/**
 * Generate all Helm values files from a DeploymentSpec
 */
export function generateValuesFiles(spec: DeploymentSpec): GeneratedValuesFiles {
  const normalizedSpec = normalizeDeploymentSpec(spec)
  if (normalizedSpec.proofTopology?.enforcement === 'enforce' && (
    normalizedSpec.proofTopology.mode !== 'active'
    || normalizedSpec.proofTopology.generation !== 'real'
  )) throw new Error('DeploymentSpec proof enforcement requires active real proving')

  const files: GeneratedValuesFiles = {}

  // Core L2 infrastructure
  files['l2-reth-sequencer-production.yaml'] = generateL2RethValues(normalizedSpec, 'sequencer')
  files['l2-reth-bootnode-production.yaml'] = generateL2RethValues(normalizedSpec, 'bootnode')
  files['l2-reth-rpc-production.yaml'] = generateL2RethValues(normalizedSpec, 'rpc')
  files['l2-reth-rpc-public-production.yaml'] = generateL2RethValues(normalizedSpec, 'rpc', true)

  // L1 interface and private Ethereum DA devnet
  files['l1-devnet-production.yaml'] = generateL1DevnetValues(normalizedSpec)
  files['l1-interface-production.yaml'] = generateL1InterfaceValues(normalizedSpec)

  // DA and Dogecoin
  files['eth-da-submitter-production.yaml'] = generateEthDaSubmitterValues(normalizedSpec)
  files['dogecoin-production.yaml'] = generateDogecoinValues(normalizedSpec)

  // Bridge and signing
  files['tso-service-production.yaml'] = generateTsoServiceValues(normalizedSpec)
  files['withdrawal-processor-production.yaml'] = generateWithdrawalProcessorValues(normalizedSpec)

  // CubeSigner provides the TEE key. Attestation signers provide attestation keys.
  if (normalizedSpec.signing.cubesigner) {
    files['cubesigner-signer-production.yaml'] = generateCubesignerValues(normalizedSpec)
  }

  // Proof coordination is the only coordinator role in the O3O topology.
  // Legacy coordinator-api/coordinator-cron values are intentionally retired.
  if (normalizedSpec.proofCoordinator && normalizedSpec.proofCoordinator.enabled !== false) {
    files['proof-coordinator-production.yaml'] = generateProofCoordinatorValues(normalizedSpec)
  }

  files['fee-oracle-production.yaml'] = generateFeeOracleValues(normalizedSpec)

  // Frontend and explorers
  files['frontends-production.yaml'] = generateFrontendsValues(normalizedSpec)
  files['frontends-config.yaml'] = generateFrontendsConfigValues(normalizedSpec)
  files['blockscout-production.yaml'] = generateBlockscoutValues(normalizedSpec)

  // Contracts deployment
  files['contracts-production.yaml'] = generateContractsValues(normalizedSpec)

  return files
}

/** Generate native Reth chart values. Node identities are supplied by the Reth setup commands. */
function generateL2RethValues(spec: DeploymentSpec, role: 'bootnode' | 'rpc' | 'sequencer', publicRpc = false): string {
  const serviceKey = {bootnode: 'l2Bootnode', rpc: 'l2Rpc', sequencer: 'l2Sequencer'} as const
  const image = resolveImage(spec, serviceKey[role], {
    repository: 'dogeos69/rollup-node',
    tag: 'TODO_TAG_TO_REPLACE',
  })
  if (/(?:^|\/)l2geth$/.test(image.repository)) {
    throw new Error(`images.services.${serviceKey[role]} must reference a Reth image; l2geth is retired`)
  }

  const sequencer = role === 'sequencer'
  return yaml.dump({
    controller: {replicas: 1, strategy: 'RollingUpdate', type: 'statefulset'},
    image,
    role,
    waitForL1: {image: 'scrolltech/scroll-alpine:v0.0.1'},
    ...(role === 'rpc' && {nodeKeyGenerator: {image: 'scrolltech/scroll-alpine:v0.0.1'}}),
    env: [{name: 'RUST_BACKTRACE', value: '1'}],
    ...(publicRpc && {ingress: {
      main: {
        enabled: true, hosts: [{host: spec.frontend.hosts.rpcGateway, paths: [{path: '/', pathType: 'Prefix'}]}], ingressClassName: 'nginx',
        primary: true,
      },
      websocket: {
        enabled: true, hosts: [{host: spec.frontend.hosts.rpcGatewayWs || spec.frontend.hosts.rpcGateway, paths: [{path: '/', pathType: 'Prefix', service: {port: 8546}}]}],
        ingressClassName: 'nginx',
      },
    }}),
    externalSecrets: {},
    resources: {limits: {cpu: '8', memory: '32Gi'}, requests: {cpu: '1', memory: '2Gi'}},
    reth: {
      blobS3Url: '',
      builderGasLimit: '10000000',
      data: {accessMode: 'ReadWriteOnce', mountPath: '/data', retain: true, size: '1000Gi'},
      engineLegacyStateRoot: true,
      engineSyncAtStartup: 'true',
      extraArgs: ['--network.legacy-geth-header-transform', 'false', ...(role === 'rpc' && !publicRpc ? ['--rpc.eth-proof-window', '100000'] : [])],
      genesis: {chainPath: '/app/genesis/genesis.json', configMapName: 'genesis-config', mountPath: '/app/genesis/genesis.json', subPath: 'genesis.json'},
      http: {addr: '0.0.0.0', api: role === 'rpc' && !publicRpc ? 'eth,net,web3,rpc,debug' : 'eth,net,web3,rpc', corsDomain: '*', enabled: true},
      ipcPath: '/tmp/reth.ipc',
      ipcPermissions: '0600',
      l1LivenessCheckInterval: '3600',
      l1LivenessThreshold: '2147483647',
      l1Url: L1_INTERFACE_RPC_ENDPOINT,
      logFormat: 'log-fmt',
      networkId: String(spec.network.l2ChainId),
      nodeKey: {
        generatedPath: '/data/nodekey',
        mode: role === 'rpc' ? 'pvcAutoGenerate' : 'secret', path: '/keys/nodekey',
        secretKey: 'RETH_NODEKEY', secretName: '',
      },
      ports: {http: 8545, metrics: 6060, p2p: 30_303, ws: 8546},
      rpc: {rollupNode: role !== 'bootnode', rollupNodeAdmin: false, trustedOnly: false},
      sequencer: {
        allowEmptyBlocks: sequencer, autoStart: true, blockTimeMs: '3000',
        enabled: sequencer, feeRecipient: spec.contracts.overrides?.l2TxFeeVault || '0x5300000000000000000000000000000000000005',
        l1InclusionMode: sequencer ? 'finalized:0' : 'finalized:2',
        payloadBuildingDurationMs: '800',
      },
      service: {extra: {}, p2p: {enabled: role !== 'rpc'}},
      signer: {
        awsKmsKeyId: '',
        localFile: {path: '/signer/sequencer-key', secretKey: 'RETH_SEQUENCER_SIGNER_PRIVATE_KEY', secretName: ''},
        type: sequencer ? 'localFile' : 'none',
      },
      trustedPeers: '',
      verbosity: 3,
      ws: {addr: '0.0.0.0', api: 'eth,net,web3,rpc', enabled: role !== 'bootnode'},
    },
    service: {main: {annotations: {}, type: 'ClusterIP', ...(role === 'rpc' && !publicRpc && {fullname: 'l2-rpc'})}},
  })
}

/**
 * Generate L1 Interface values
 */
function generateL1InterfaceValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)
  const dogecoinEndpoints = resolveDogecoinKubernetesEndpoints(spec.dogecoin)
  const l2StartBlockNumber = getEthereumDaL2StartBlockNumber(spec)

  const image = resolveImage(spec, 'l1Interface', {
    pullPolicy: 'Always',
    repository: 'dogeos69/l1-interface',
    tag: '0.2.0-rc.4'
  })

  const values: Record<string, any> = {
    configMaps: {
      env: {
        data: {
          DOGEOS_L1_INTERFACE_API_BIND_ADDRESS: '0.0.0.0:8545',
          DOGEOS_L1_INTERFACE_BEACON_API_LISTEN_ADDRESS: '0.0.0.0:5052',
          DOGEOS_L1_INTERFACE_DATABASE_URL: 'sqlite:///data/l1-interface.sqlite',
          DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__CONFIRMATIONS: String(spec.bridge.confirmationsRequired),
          DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__INDEX_DEPOSITS: 'false',
          DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__INDEX_UTXOS: 'false',
          DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__POLL_INTERVAL_MS: '10000',
          DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__START_HEIGHT: String(getDogecoinIndexerStartHeight(spec)),
          DOGEOS_L1_INTERFACE_DOGECOIN_RPC__URL: dogecoinEndpoints.rpcUrl,
          DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL: getEthereumDaBeaconRpcUrl(spec),
          DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__TIMEOUT_MS: '10000',
          ...buildEthereumDaS3BlobSourceEnv('DOGEOS_L1_INTERFACE_ETHEREUM_DA', spec),
          DOGEOS_L1_INTERFACE_ETHEREUM_DA__L1_RPC_URL: getEthereumDaSubmitterRpcUrl(spec),
          DOGEOS_L1_INTERFACE_GENESIS_JSON_PATH: '/app/genesis/genesis.json',
          DOGEOS_L1_INTERFACE_HEALTH_LISTEN_ADDRESS: '0.0.0.0:9090',
          DOGEOS_L1_INTERFACE_L1_GAS_LIMIT: '30000000',
          DOGEOS_L1_INTERFACE_L1_GENESIS_BLOCK: String(getL1GenesisBlock(spec)),
          DOGEOS_L1_INTERFACE_NETWORK_STR: spec.dogecoin.network,
          DOGEOS_L1_INTERFACE_REPLAY_READ__ENABLED: 'true',
          DOGEOS_L1_INTERFACE_REPLAY_READ__MAINTAINER_ENABLED: 'true',
          DOGEOS_L1_INTERFACE_REPLAY_READ__PROTOCOL_CONTEXT_JSON: '/app/protocol_context.json',
          DOGEOS_L1_INTERFACE_REPLAY_READ__REQUIRE_FULL_VALIDATION: 'false',
          DOGEOS_L1_INTERFACE_REPLAY_READ__SQLITE_PATH: '/data/replay.sqlite',
          ...(l2StartBlockNumber === undefined ? {} : {
            DOGEOS_L1_INTERFACE_REPLAY_READ__L2_BOOTSTRAP_NEXT_STARTING_BLOCK_HEIGHT: String(l2StartBlockNumber),
          })
        },
        enabled: true
      }
    },
    env: [
      { name: 'RUST_LOG', value: 'info' }
    ],
    envFrom: [
      { secretRef: { name: 'l1-interface-secret-env' } },
      { configMapRef: { name: 'l1-interface-env' } }
    ],
    image,
    persistence: {
      data: {
        enabled: true,
        mountPath: '/data',
        name: 'l1-interface-data-pvc',
        retain: true,
        size: '100Gi',
        type: 'pvc',
      },
      genesis: {
        enabled: true,
        mountPath: '/app/genesis/genesis.json',
        name: 'genesis-config',
        readOnly: true,
        subPath: 'genesis.json',
        type: 'configMap',
      },
      'protocol-context': {
        enabled: true,
        mountPath: '/app/protocol_context.json',
        name: 'protocol-context-config',
        readOnly: true,
        subPath: 'protocol_context.json',
        type: 'configMap',
      },
    },
    resources: {
      limits: { cpu: '1000m', memory: '1Gi' },
      requests: { cpu: '100m', memory: '256Mi' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'l1-interface-secret-env',
    secretConfig,
    [
      { property: 'DOGEOS_L1_INTERFACE_DOGECOIN_RPC__USER', remoteKey: 'l1-interface-secret-env', secretKey: 'DOGEOS_L1_INTERFACE_DOGECOIN_RPC__USER' },
      { property: 'DOGEOS_L1_INTERFACE_DOGECOIN_RPC__PASS', remoteKey: 'l1-interface-secret-env', secretKey: 'DOGEOS_L1_INTERFACE_DOGECOIN_RPC__PASS' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate private Ethereum DA devnet values.
 *
 * The Ethereum PoS devnet was folded into the l1-devnet Helm chart. Keep the
 * image override keys stable for existing DeploymentSpec files, but emit values
 * for l1-devnet-production.yaml.
 */
function generateL1DevnetValues(spec: DeploymentSpec): string {
  const imageGenesisGenerator = resolveImage(spec, 'ethereumGenesisGenerator', {
    pullPolicy: 'IfNotPresent',
    repository: 'ethpandaops/ethereum-genesis-generator',
    tag: '3.4.1'
  })
  const imageGeth = resolveImage(spec, 'ethereumGeth', {
    pullPolicy: 'IfNotPresent',
    repository: 'ethereum/client-go',
    tag: 'v1.14.13'
  })
  const imageLighthouse = resolveImage(spec, 'ethereumLighthouse', {
    pullPolicy: 'IfNotPresent',
    repository: 'sigp/lighthouse',
    tag: 'latest'
  })

  const chainId = getEthereumDaChainId(spec)
  const values = {
    global: {
      fullnameOverride: 'l1-devnet',
    },
    images: {
      genesisGenerator: imageGenesisGenerator,
      geth: imageGeth,
      lighthouse: imageLighthouse,
    },
    network: {
      chainId,
      networkId: chainId,
    },
  }

  if (spec.frontend.hosts.l1Devnet) {
    Object.assign(values, {
      ingress: {
        main: {
          hosts: [{
            host: spec.frontend.hosts.l1Devnet,
            paths: [{ path: '/', pathType: 'Prefix' }],
          }],
          ingressClassName: 'nginx',
        },
      },
    })
  }

  return yaml.dump(values)
}

/**
 * Generate Ethereum DA Submitter values
 */
function generateEthDaSubmitterValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)
  const ethereumDa = getEthereumDaConfig(spec)
  const l2StartBlockNumber = getEthereumDaL2StartBlockNumber(spec)

  const image = resolveImage(spec, 'ethDaSubmitter', {
    pullPolicy: 'IfNotPresent',
    repository: 'dogeos69/eth-da-submitter',
    tag: 'latest'
  })

  const values: Record<string, any> = {
    configMaps: {
      env: {
        data: {
          ...buildEthDaSubmitterBatchEnv(spec),
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__CONFIRMATION_DEPTH: String(ethereumDa.confirmationDepth ?? 1),
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__CONFIRMER_POLL_INTERVAL_MS: String(ethereumDa.confirmerPollIntervalMs ?? 12_000),
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__FINALIZATION_DEPTH: String(ethereumDa.finalizationDepth ?? 64),
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__MAX_BLOB_BASE_FEE_WEI: ethereumDa.maxBlobBaseFeeWei || '50000000000',
          DOGEOS_ETH_DA_SUBMITTER_PROTOCOL_CONTEXT_JSON: '/app/protocol_context.json',
          ...(ethereumDa.maxFeePerGasWei ? {
            DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__MAX_FEE_PER_GAS_WEI: ethereumDa.maxFeePerGasWei,
          } : {}),
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__MIN_PRIORITY_FEE_WEI: ethereumDa.minPriorityFeeWei || '2000000000',
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__RPC_URL: getEthereumDaSubmitterRpcUrl(spec),
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__SIGNER_BACKEND: 'local',
          DOGEOS_ETH_DA_SUBMITTER_L2__CONFIRMATIONS: String(ethereumDa.l2Confirmations ?? 0),
          DOGEOS_ETH_DA_SUBMITTER_L2__FETCH_LIMIT: String(ethereumDa.fetchLimit ?? 128),
          DOGEOS_ETH_DA_SUBMITTER_L2__RPC_URL: ethereumDa.l2RpcUrl || L2_RPC_ENDPOINT,
          ...(l2StartBlockNumber === undefined ? {} : {
            DOGEOS_ETH_DA_SUBMITTER_L2__START_BLOCK_NUMBER: String(l2StartBlockNumber),
          }),
          ...buildEthDaSubmitterPublishEnv(spec),
          ...buildEthDaSubmitterS3Env(spec),
          DOGEOS_ETH_DA_SUBMITTER_SERVICE__CYCLE_INTERVAL_MS: '1000',
          DOGEOS_ETH_DA_SUBMITTER_SERVICE__LISTEN_ADDRESS: '0.0.0.0',
          DOGEOS_ETH_DA_SUBMITTER_SERVICE__LISTEN_PORT: '3004',
          DOGEOS_ETH_DA_SUBMITTER_SERVICE__SHUTDOWN_GRACE_PERIOD_SEC: '30',
          DOGEOS_ETH_DA_SUBMITTER_SERVICE__STATUS_POLL_INTERVAL_MS: '5000',
          DOGEOS_ETH_DA_SUBMITTER_STORE__LIFECYCLE_DB_PATH: ethereumDa.lifecycleDbPath || ethereumDa.submitterDbPath || '/app/data/submitter.sqlite',
          DOGEOS_ETH_DA_SUBMITTER_STORE__SUBMITTER_DB_PATH: ethereumDa.submitterDbPath || '/app/data/submitter.sqlite'
        },
        enabled: true
      }
    },
    env: [
      { name: 'RUST_LOG', value: 'info,eth_da_submitter=info' }
    ],
    envFrom: [
      { configMapRef: { name: 'eth-da-submitter-env' } },
      { secretRef: { name: 'eth-da-submitter-secret-env' } }
    ],
    image,
    persistence: {
      data: {
        retain: true,
        size: '10Gi'
      },
      genesis: {
        enabled: true,
        mountPath: '/app/genesis/genesis.json',
        name: 'genesis-config',
        readOnly: true,
        subPath: 'genesis.json',
        type: 'configMap',
      },
      'protocol-context': {
        enabled: true,
        mountPath: '/app/protocol_context.json',
        name: 'protocol-context-config',
        readOnly: true,
        subPath: 'protocol_context.json',
        type: 'configMap',
      },
    },
    resources: {
      limits: { cpu: '1000m', memory: '1Gi' },
      requests: { cpu: '200m', memory: '256Mi' }
    }
  }

  const externalSecrets = generateExternalSecrets(
      'eth-da-submitter-secret-env',
      secretConfig,
      [
        {
          property: 'DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__SUBMITTER_PRIVATE_KEY',
          remoteKey: 'eth-da-submitter-secret-env',
          secretKey: 'DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__SUBMITTER_PRIVATE_KEY'
        }
      ]
    )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate Dogecoin node values
 */
function generateDogecoinValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)
  const dogecoinEndpoints = resolveDogecoinKubernetesEndpoints(spec.dogecoin)
  const clusterRpc = getDogecoinClusterRpc(spec)
  const isRegtest = spec.dogecoin.network === 'regtest'
  const isTestnet = spec.dogecoin.network === 'testnet'

  const values: Record<string, any> = {
    dogecoinConf: {
      disablewallet: 0,
      regtest: isRegtest ? 1 : 0,
      rpcallowip: ['0.0.0.0/0'],
      rpcuser: clusterRpc.username,
      rpcworkqueue: 128,
      server: 1,
      testnet: isTestnet ? 1 : 0,
      txindex: 1,
      zmqpubhashblock: `tcp://0.0.0.0:${dogecoinEndpoints.zmqHashBlockPort}`,
      zmqpubhashtx: `tcp://0.0.0.0:${dogecoinEndpoints.zmqHashTxPort}`,
      zmqpubrawblock: `tcp://0.0.0.0:${dogecoinEndpoints.zmqRawBlockPort}`,
      zmqpubrawtx: `tcp://0.0.0.0:${dogecoinEndpoints.zmqRawTxPort}`
    },
    fullnameOverride: dogecoinEndpoints.serviceName,
    image: {
      pullPolicy: 'IfNotPresent',
      repository: 'dogeos69/dogecoin',
      tag: '1.14.7-alpine'
    },
    resources: {
      limits: { cpu: '2000m', memory: isRegtest || isTestnet ? '30Gi' : '32Gi' },
      requests: { cpu: '500m', memory: isTestnet ? '16Gi' : '16Gi' }
    },
    rpcPassword: {
      secretKey: 'password',
      value: clusterRpc.password
    },
    service: {
      port: dogecoinEndpoints.p2pPort,
      rpcPort: dogecoinEndpoints.rpcPort,
      zmqHashBlockPort: dogecoinEndpoints.zmqHashBlockPort,
      zmqHashTxPort: dogecoinEndpoints.zmqHashTxPort,
      zmqRawBlockPort: dogecoinEndpoints.zmqRawBlockPort,
      zmqRawTxPort: dogecoinEndpoints.zmqRawTxPort
    },
    storage: {
      retainPvcOnUninstall: true,
      size: isTestnet ? '50Gi' : '250Gi'
    }
  }

  const externalSecrets = generateExternalSecrets(
    'dogecoin-secret-env',
    secretConfig,
    [
      { property: 'DOGECOIN_RPC_PASSWORD', remoteKey: 'dogecoin-secret-env', secretKey: 'password' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate TSO Service values
 */
function generateTsoServiceValues(spec: DeploymentSpec): string {
  const image = resolveImage(spec, 'tsoService', {
    pullPolicy: 'Always',
    repository: 'dogeos69/tso-service',
    tag: '0.2.0-rc.4'
  })

  const values = {
    defaultProbes: { enabled: false },
    env: [
      { name: 'PORT', value: '3000' },
      { name: 'DOGE_NETWORK', value: spec.dogecoin.network },
      { name: 'WITHDRAWAL_PROCESSOR_URL', value: 'http://withdrawal-processor:3000' },
      { name: 'TIMEOUT_CHECK_INTERVAL_SECONDS', value: '60' },
      { name: 'TSO_CORRECTNESS_MAX_PSBT_BASE64_LEN', value: '130048' },
      { name: 'TSO_CUBESIGNER_MAX_PSBT_BASE64_LEN', value: '130048' },
      { name: 'RUST_LOG', value: 'debug' }
    ],
    image,
    ingress: {
      main: {
        hosts: [{
          host: spec.frontend.hosts.tso || '',
          paths: [{ path: '/', pathType: 'Prefix' }]
        }],
        ingressClassName: 'nginx',
        tls: spec.frontend.hosts.tso ? [{
          hosts: [spec.frontend.hosts.tso],
          secretName: 'tso-tls'
        }] : []
      }
    },
    resources: {
      limits: { cpu: '1000m', memory: '1Gi' },
      requests: { cpu: '200m', memory: '256Mi' }
    },
    serviceMonitor: {
      main: { enabled: true }
    }
  }

  return yaml.dump(values)
}

/**
 * Generate Withdrawal Processor values
 */
function generateWithdrawalProcessorValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)
  const dogecoinEndpoints = resolveDogecoinKubernetesEndpoints(spec.dogecoin)
  const ethereumDaSubmitterAddress = spec.accounts.l1CommitSender?.address
  const l2StartBlockNumber = getEthereumDaL2StartBlockNumber(spec)

  const image = resolveImage(spec, 'withdrawalProcessor', {
    pullPolicy: 'Always',
    repository: 'dogeos69/withdrawal-processor',
    tag: '0.2.0-rc.4'
  })

  const values: Record<string, any> = {
    env: [
      { name: 'DOGEOS_WITHDRAWAL_NETWORK_STR', value: spec.dogecoin.network },
      { name: 'DOGEOS_WITHDRAWAL_DATABASE_URL', value: 'sqlite:///app/data/withdrawal_processor.sqlite' },
      { name: 'DOGEOS_WITHDRAWAL_API_PORT', value: '3000' },
      { name: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_URL', value: dogecoinEndpoints.rpcUrl },
      { name: 'DOGEOS_WITHDRAWAL_TSO_URL', value: 'http://tso-service:3000' },
      { name: 'DOGEOS_WITHDRAWAL_INITIAL_BRIDGE_REDEEM_SCRIPT_HEX', value: '' },
      { name: 'DOGEOS_WITHDRAWAL_MAX_WITHDRAWAL_OUTPUTS_PER_TX', value: '256' },
      { name: 'DOGEOS_WITHDRAWAL_FEE_RATE_SAT_PER_KVB', value: String(getBridgeFeeRateSatsPerKvb(spec)) },
      { name: 'DOGEOS_WITHDRAWAL_DEBUG_SKIP_BROADCAST', value: 'false' },
      { name: 'DOGEOS_WITHDRAWAL_DEBUG_SKIP_TSO_POLLING', value: 'false' },
      { name: 'DOGEOS_WITHDRAWAL_TSO_TIMEOUT_MINUTES', value: '30' },
      { name: 'DOGEOS_WITHDRAWAL_CLEANUP_TIMEOUT_SECS', value: '3600' },
      { name: 'DOGEOS_WITHDRAWAL_ROTATE_KEY_V2', value: 'true' },
      { name: 'DOGEOS_WITHDRAWAL_ROTATE_SEQUENCER_SIGNER_V2', value: 'false' },
      { name: 'DOGEOS_WITHDRAWAL_ADVANCE_L1_BUILDER_V2', value: 'true' },
      { name: 'DOGEOS_WITHDRAWAL_ADVANCE_L2_BUILDER_V2', value: 'true' },
      { name: 'DOGEOS_WITHDRAWAL_WF_WITHDRAWAL_PARITY_V1', value: 'true' },
      { name: 'DOGEOS_WITHDRAWAL_REQUIRE_CHANGE_TRACKING', value: 'false' },
      { name: 'DOGEOS_WITHDRAWAL_STRICT_L2_VALIDATION', value: 'false' },
      { name: 'DOGEOS_WITHDRAWAL_STRICT_L1_VALIDATION', value: 'false' },
      { name: 'DOGEOS_WITHDRAWAL_LEAF_VERIFICATION_REQUIRED', value: 'false' },
      { name: 'DOGEOS_WITHDRAWAL_MAX_DEPOSITS_PER_ADVANCE_L1', value: '32' },
      { name: 'DOGEOS_WITHDRAWAL_REPLAY_SQLITE_PATH', value: '/app/data/replay.sqlite' },
      { name: 'DOGEOS_WITHDRAWAL_PROTOCOL_CONTEXT_JSON', value: '/app/protocol_context.json' },
      ...(l2StartBlockNumber === undefined ? [] : [{
        name: 'DOGEOS_WITHDRAWAL_L2_BOOTSTRAP_NEXT_STARTING_BLOCK_HEIGHT',
        value: String(l2StartBlockNumber),
      }]),
      // Dogecoin Indexer
      { name: 'DOGEOS_WITHDRAWAL_DOGECOIN_INDEXER__START_HEIGHT', value: String(getDogecoinIndexerStartHeight(spec)) },
      { name: 'DOGEOS_WITHDRAWAL_DOGECOIN_INDEXER__CONFIRMATIONS', value: String(spec.bridge.confirmationsRequired) },
      { name: 'DOGEOS_WITHDRAWAL_DOGECOIN_INDEXER__POLL_INTERVAL_MS', value: '1000' },
      // DogeOS Indexer
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__RPC_URL', value: L2_RPC_ENDPOINT },
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__START_BLOCK', value: '0' },
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__CONFIRMATIONS', value: '12' },
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__POLL_INTERVAL_MS', value: '1000' },
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__LOG_QUERY_BATCH_SIZE', value: '10000' },
      { name: 'DOGEOS_WITHDRAWAL_UTXO_MANAGER_INTERMEDIATE__HIGH_THRESH_SATS', value: '10000000000' },
      { name: 'DOGEOS_WITHDRAWAL_UTXO_MANAGER_INTERMEDIATE__BRIDGE_MIN_CONFIRMATIONS', value: '10' },
      { name: 'DOGEOS_WITHDRAWAL_UTXO_MANAGER_INTERMEDIATE__ALLOW_INFLIGHT_BRIDGE_OUTPUTS', value: 'true' },
      { name: 'DOGEOS_WITHDRAWAL_UTXO_MANAGER_INTERMEDIATE__PREFER_INFLIGHT_BRIDGE_OUTPUTS', value: 'false' },
      { name: 'DOGEOS_WITHDRAWAL_UTXO_MANAGER_INTERMEDIATE__BRIDGE_STRATEGY__STRATEGY', value: 'band' },
      { name: 'DOGEOS_WITHDRAWAL_UTXO_MANAGER_INTERMEDIATE__BRIDGE_STRATEGY__MAX_INPUTS', value: '60' },
      { name: 'DOGEOS_WITHDRAWAL_UTXO_MANAGER_INTERMEDIATE__BRIDGE_STRATEGY__DUST_FLOOR_SATS', value: '1000000' },
      { name: 'DOGEOS_WITHDRAWAL_UTXO_MANAGER_INTERMEDIATE__BRIDGE_STRATEGY__BAND__TARGET_ACTIVE_UTXOS', value: '100' },
      { name: 'DOGEOS_WITHDRAWAL_UTXO_MANAGER_INTERMEDIATE__BRIDGE_STRATEGY__BAND__TARGET_SIZE_RATIO', value: '1.0' },
      { name: 'DOGEOS_WITHDRAWAL_UTXO_MANAGER_INTERMEDIATE__BRIDGE_STRATEGY__BAND__SWEEP_FLOOR_RATIO', value: '0.5' },
      { name: 'DOGEOS_WITHDRAWAL_UTXO_MANAGER_INTERMEDIATE__BRIDGE_STRATEGY__BAND__BALANCE_BAND_RATIO', value: '0.10' },
      { name: 'DOGEOS_WITHDRAWAL_UTXO_MANAGER_INTERMEDIATE__BRIDGE_STRATEGY__BAND__MAX_BALANCE_ADDITIONS', value: '3' },
      { name: 'DOGEOS_WITHDRAWAL_UTXO_MANAGER_INTERMEDIATE__BRIDGE_STRATEGY__BAND__FLOOR_ABSOLUTE_SATS', value: '1000000' },
      // Ethereum DA resolver/indexer inputs for AdvanceL2 builder v2.
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__L1_RPC_URL', value: getEthereumDaSubmitterRpcUrl(spec) },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INDEXER_SQLITE_PATH', value: '/app/data/eth-da-indexer.sqlite' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__ARTIFACT_STORE_ROOT', value: '/app/data/eth-da-blob-artifacts' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__ARTIFACT_METADATA_SQLITE_PATH', value: '/app/data/eth-da-artifact-metadata.sqlite' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__MIN_FINALITY', value: getEthereumDaMinFinality(spec) },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__ENABLED', value: 'true' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__WRITER_ID', value: 'withdrawal-processor' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__CURSOR_ID', value: 'eth_da_inbox' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__START_BLOCK', value: String(getEthereumDaInboxWorkerStartBlock(spec)) },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__INGEST_DEPTH', value: '1' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__SAFE_DEPTH', value: '32' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__FINALIZED_DEPTH', value: '64' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__ROLLBACK_LOOKBACK', value: '128' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__POLL_INTERVAL_MS', value: '6000' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__MAX_BLOCKS_PER_CYCLE', value: '64' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__STATUS_POLL_INTERVAL_MS', value: '5000' },
      ...(ethereumDaSubmitterAddress ? [{
        name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__EXPECTED_BATCHERS',
        value: JSON.stringify([ethereumDaSubmitterAddress]),
      }] : []),
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL', value: getEthereumDaBeaconRpcUrl(spec) },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__TIMEOUT_MS', value: '10000' },
      ...Object.entries(buildEthereumDaS3BlobSourceEnv('DOGEOS_WITHDRAWAL_ETHEREUM_DA', spec)).map(([name, value]) => ({ name, value })),
      { name: 'RUST_LOG', value: 'info,withdrawal_processor=info' }
    ],
    envFrom: [
      { secretRef: { name: 'withdrawal-processor-secret-env' } }
    ],
    image,
    persistence: {
      data: {
        enabled: true,
        mountPath: '/app/data',
        name: 'withdrawal-processor-data-pvc',
        retain: true,
        size: '100Gi',
        type: 'pvc',
      },
      'protocol-context': {
        enabled: true,
        mountPath: '/app/protocol_context.json',
        name: 'protocol-context-config',
        readOnly: true,
        subPath: 'protocol_context.json',
        type: 'configMap',
      },
    },
    resources: {
      limits: { cpu: '1000m', memory: '2Gi' },
      requests: { cpu: '200m', memory: '512Mi' }
    }
  }

  ensureWithdrawalChartWiring(values)
  ensureWithdrawalProofActivationSwitch(
    values,
    spec.proofTopology?.mode ?? 'disabled',
  )

  const {proofCoordinator} = spec
  if (proofCoordinator && proofCoordinator.enabled !== false) {
    if (!proofCoordinator.s3AuthMode) {
      throw new Error('proofCoordinator.s3AuthMode is required when proofCoordinator is enabled')
    }

    values.withdrawalProof.s3AuthMode = proofCoordinator.s3AuthMode
    values.serviceAccount = {
      annotations: proofCoordinator.withdrawalProcessorServiceAccount?.annotations || {},
      create: true,
    }
    if (proofCoordinator.withdrawalProcessorServiceAccount?.name) {
      values.serviceAccount.name = proofCoordinator.withdrawalProcessorServiceAccount.name
    }
  }

  const externalSecrets = generateExternalSecrets(
    'withdrawal-processor-secret-env',
    secretConfig,
    [
      { property: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_USER', remoteKey: 'withdrawal-processor-secret-env', secretKey: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_USER' },
      { property: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_PASS', remoteKey: 'withdrawal-processor-secret-env', secretKey: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_PASS' },
      { property: 'DOGEOS_WITHDRAWAL_FEE_SIGNER_KEY', remoteKey: 'withdrawal-processor-secret-env', secretKey: 'DOGEOS_WITHDRAWAL_FEE_SIGNER_KEY' },
      { property: 'DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KEY', remoteKey: 'withdrawal-processor-secret-env', secretKey: 'DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KEY' },
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate CubeSigner Signer values
 */
function generateCubesignerValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)
  const productionPolicy = spec.signing?.cubesigner?.productionPolicy

  const image = resolveImage(spec, 'cubesignerSigner', {
    pullPolicy: 'IfNotPresent',
    repository: 'dogeos69/cubesigner-signer',
    tag: 'v0.3.0-beta.2'
  })

  const values: Record<string, any> = {
    env: [
      { name: 'DOGEOS_CUBESIGNER_SIGNER_LOG_LEVEL', value: 'info' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_PORT', value: '3000' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_NETWORK', value: spec.dogecoin.network },
      { name: 'NETWORK', value: spec.dogecoin.network },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_TSO_URL', value: 'http://tso-service:3000' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_PROTOCOL_CONTEXT_JSON', value: '/app/protocol_context.json' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_SIGNATURE_DELAY', value: '0' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_POLL_INTERVAL', value: '500' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_SESSION_KEEP_ALIVE_INTERVAL', value: '3600000' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_MAX_PSBT_BASE64_LEN', value: '130048' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_MAX_SIGN_REQUEST_JSON_BYTES', value: '262144' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_MAX_CUBESIGNER_REQUEST_JSON_BYTES', value: '393216' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_MAX_CUBESIGNER_RESPONSE_JSON_BYTES', value: '393216' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_MODE', value: 'production_verifier_key_policy' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_SDK_VERSION', value: '0.4.281' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_KEY_IDENTIFIER', valueFrom: { secretKeyRef: { key: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', name: 'cubesigner-signer-env' } } },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_IDENTIFIER', value: productionPolicy?.policyIdentifier || '' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_ARTIFACT_DIGEST', value: productionPolicy?.policyArtifactDigest || '' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_VERIFIER_IDENTITY_DIGEST', value: productionPolicy?.verifierIdentityDigest || '' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_PROGRAM_IDENTITY_DIGEST', value: productionPolicy?.programIdentityDigest || '' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_PROOF_RESOLVER_AUTHORITY', value: productionPolicy?.proofResolverAuthority || '' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_REQUEST_CONTRACT', value: 'dogeos-cubesigner-compact-psbt-bridge-proof-ref-v1-sign-all-scripts-false-unprefixed-hex-explain-v3' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_LIVE_EVIDENCE_REPORT_PATH', value: productionPolicy?.liveEvidenceReportPath || '' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_LIVE_EVIDENCE_REPORT_DIGEST', value: productionPolicy?.liveEvidenceReportDigest || '' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', valueFrom: { secretKeyRef: { key: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', name: 'cubesigner-signer-env' } } },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_CS_SESSION_PATH', value: '/etc/cubesigner/session.json' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_SIGNATURE_MODE', value: 'ecdsa' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_BODY_LIMIT', value: '5mb' },
      { name: 'CS_SESSIONS_DIR', value: '/app/.sessions' }
    ],
    global: {
      fullnameOverride: 'cubesigner-signer'
    },
    image,
    persistence: {
      'protocol-context': {
        enabled: true,
        mountPath: '/app/protocol_context.json',
        name: 'protocol-context-config',
        readOnly: true,
        subPath: 'protocol_context.json',
        type: 'configMap'
      },
      session: {
        enabled: true,
        mountPath: '/etc/cubesigner',
        name: 'cubesigner-signer-session',
        readOnly: true,
        secretName: 'cubesigner-signer-session',
        type: 'secret'
      }
    },
    // The generated production values own the service health contract. Do not
    // inherit these paths from a chart version: /health is process liveness,
    // while /ready includes CubeSigner session and production-policy gates.
    probes: {
      liveness: {
        custom: true,
        enabled: true,
        spec: {httpGet: {path: '/health', port: 'http'}}
      },
      readiness: {
        custom: true,
        enabled: true,
        spec: {httpGet: {path: '/ready', port: 'http'}}
      },
      startup: {
        custom: true,
        enabled: true,
        spec: {
          failureThreshold: 12,
          httpGet: {path: '/health', port: 'http'},
          initialDelaySeconds: 10,
          periodSeconds: 5
        }
      }
    },
    resources: {
      limits: { cpu: '1000m', memory: '512Mi' },
      requests: { cpu: '50m', memory: '128Mi' }
    },
    serviceMonitor: {
      main: {
        enabled: true,
        endpoints: [{ interval: '10s', port: 'http', scrapeTimeout: '5s' }],
        labels: { release: 'scroll-sdk' },
        serviceName: '{{ include "scroll.common.lib.chart.names.fullname" $ }}'
      }
    },
    volumeClaimTemplates: [{
      accessMode: 'ReadWriteOnce',
      mountPath: '/app/.sessions',
      name: 'session-cache',
      size: '1Gi'
    }]
  }

  // Generate external secrets for both env and session
  const envSecrets = generateExternalSecrets(
    'cubesigner-signer-env',
    secretConfig,
    [
      { property: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', remoteKey: 'cubesigner-signer-env', secretKey: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID' }
    ]
  )

  const sessionSecrets = generateExternalSecrets(
    'cubesigner-signer-session',
    secretConfig,
    [
      { property: 'session.json', remoteKey: 'cubesigner-signer-session', secretKey: 'session.json' }
    ]
  )

  if (envSecrets || sessionSecrets) {
    values.externalSecrets = {
      ...envSecrets,
      ...sessionSecrets
    }
  }

  return yaml.dump(values)
}

function isNonLoopbackPlainHttp(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:') return false

    return !['[::1]', '127.0.0.1', 'localhost'].includes(url.hostname)
  } catch {
    return false
  }
}

/**
 * Generate Proof Coordinator values
 */
function generateProofCoordinatorValues(spec: DeploymentSpec): string {
  const { proofCoordinator } = spec
  if (!proofCoordinator || proofCoordinator.enabled === false) {
    throw new Error('proofCoordinator values requested but proofCoordinator is not enabled')
  }

  if (!proofCoordinator.s3AuthMode) {
    throw new Error('proofCoordinator.s3AuthMode is required when proofCoordinator is enabled')
  }

  const secretConfig = getSecretProviderConfig(spec)
  const { artifactStore } = proofCoordinator
  const proofWorkBaseUrl = proofCoordinator.proofWorkBaseUrl || 'http://withdrawal-processor:9300'
  const explicitSecretName = proofCoordinator.secrets?.name
  const localSecretKey = explicitSecretName || 'secrets'
  const remoteSecretKey = proofCoordinator.secrets?.remoteKey || explicitSecretName || 'proof-coordinator-secrets'
  const serviceAccountName = proofCoordinator.serviceAccount?.name
  const forcePathStyle = artifactStore.forcePathStyle ?? Boolean(artifactStore.endpointUrl)

  const image = resolveImage(spec, 'proofCoordinator', {
    pullPolicy: 'IfNotPresent',
    repository: 'dogeos69/proof-coordinator',
    tag: '0.3.0-beta.1d-rc2'
  })

  const env: Array<Record<string, any>> = [
    { name: 'DOGEOS_PROOF_COORDINATOR_PROOF_WORK_BASE_URL', value: proofWorkBaseUrl },
    { name: 'DOGEOS_PROOF_COORDINATOR_PROTOCOL_CONTEXT_JSON', value: '/app/protocol_context.json' },
    {
      name: 'DOGEOS_PROOF_COORDINATOR_ALLOW_INSECURE_HTTP',
      value: String(proofCoordinator.allowInsecureHttp ?? isNonLoopbackPlainHttp(proofWorkBaseUrl))
    },
    { name: 'DOGEOS_PROOF_COORDINATOR_COORDINATOR_ID', value: proofCoordinator.coordinatorId || 'proof-coordinator' },
    { name: 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__BUCKET', value: artifactStore.bucket },
    { name: 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__REGION', value: artifactStore.region },
    { name: 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__KEY_PREFIX', value: artifactStore.keyPrefix || 'proof-topology' },
    { name: 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__FORCE_PATH_STYLE', value: String(forcePathStyle) },
  ]

  if (artifactStore.endpointUrl) {
    env.push({
      name: 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__ENDPOINT_URL',
      value: artifactStore.endpointUrl
    })
  }

  if (artifactStore.maxReadBodyBytes !== undefined) {
    env.push({
      name: 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__MAX_READ_BODY_BYTES',
      value: String(artifactStore.maxReadBodyBytes)
    })
  }

  if (artifactStore.publicS3EndpointUrl) {
    env.push({
      name: 'DOGEOS_PROOF_COORDINATOR_PROVER_API__PUBLIC_S3_ENDPOINT_URL',
      value: artifactStore.publicS3EndpointUrl
    })
  }

  const values: Record<string, any> = {
    controller: {
      replicas: 1
    },
    env,
    image,
    ingress: {
      main: spec.proofTopology?.mode === 'active' && spec.frontend.hosts.proofCoordinator
        ? buildProofCoordinatorIngress(spec.frontend.hosts.proofCoordinator)
        : {enabled: false},
    },
    persistence: {
      genesis: {
        enabled: true,
        mountPath: '/app/genesis/genesis.json',
        name: 'genesis-config',
        readOnly: true,
        subPath: 'genesis.json',
        type: 'configMap'
      },
      'protocol-context': {
        enabled: true,
        mountPath: '/app/protocol_context.json',
        name: 'protocol-context-config',
        readOnly: true,
        subPath: 'protocol_context.json',
        type: 'configMap'
      },
      secrets: {
        enabled: true,
        mountPath: '/app/secrets',
        readOnly: true,
        type: 'secret'
      }
    },
    proofCoordinator: {
      config: {
        required: true
      }
    },
    service: {
      main: {
        enabled: true,
        ports: {
          http: {enabled: false},
          prover: {
            enabled: true,
            port: 7788,
            primary: true,
            protocol: 'TCP',
            targetPort: 7788
          }
        }
      }
    },
    serviceAccount: {
      annotations: proofCoordinator.serviceAccount?.annotations || {},
      create: true,
    }
  }

  if (explicitSecretName) values.persistence.secrets.name = explicitSecretName
  if (serviceAccountName) values.serviceAccount.name = serviceAccountName

  const externalSecrets = generateExternalSecrets(
    localSecretKey,
    secretConfig,
    [
      {
        property: proofCoordinator.secrets?.proofWorkTokenProperty || 'proof-work-token',
        remoteKey: remoteSecretKey,
        secretKey: 'proof-work-token'
      },
      {
        property: proofCoordinator.secrets?.proverWorkerTokenProperty || 'prover-worker-token',
        remoteKey: remoteSecretKey,
        secretKey: 'prover-worker-token'
      },
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate Fee Oracle values
 */
function generateFeeOracleValues(spec: DeploymentSpec): string {
  const image = resolveImage(spec, 'feeOracle', {
    pullPolicy: 'IfNotPresent',
    repository: 'dogeos69/fee-oracle',
    tag: 'TODO_TAG_TO_REPLACE'
  })

  const values = {
    configMaps: {
      env: {
        data: {
          DOGEOS_FEE_ORACLE_DATABASE__CONNECTION_POOL_SIZE: '10',
          DOGEOS_FEE_ORACLE_DATABASE__SQLITE_PATH: '/data/fee_oracle.db',
          ...buildFeeOracleEthereumDaEnv(spec),
          DOGEOS_FEE_ORACLE_L2__CHAIN_ID: String(spec.network.l2ChainId),
          DOGEOS_FEE_ORACLE_L2__CONFIRMATIONS: '3',
          DOGEOS_FEE_ORACLE_L2__GAS_ORACLE_CONTRACT: spec.contracts.overrides?.l1GasPriceOracle || '<TODO>',
          DOGEOS_FEE_ORACLE_L2__MAX_GAS_PRICE: '1000000000000',
          DOGEOS_FEE_ORACLE_L2__PRIORITY_FEE: '1000000000',
          DOGEOS_FEE_ORACLE_L2__RPC_URL: L2_RPC_ENDPOINT,
          DOGEOS_FEE_ORACLE_MONITORING__HEALTH_BIND_ADDRESS: '0.0.0.0',
          DOGEOS_FEE_ORACLE_MONITORING__HEALTH_CHECK_PORT: '8080',
          DOGEOS_FEE_ORACLE_MONITORING__METRICS_PORT: '9090',
          DOGEOS_FEE_ORACLE_PRICE_ORACLE__CACHE_DURATION: '30',
          DOGEOS_FEE_ORACLE_PRICE_ORACLE__COINBASE_ENABLED: 'true',
          DOGEOS_FEE_ORACLE_PRICE_ORACLE__COINGECKO_ENABLED: 'false',
          DOGEOS_FEE_ORACLE_PRICE_ORACLE__GATEIO_ENABLED: 'true',
          DOGEOS_FEE_ORACLE_PRICE_ORACLE__KRAKEN_ENABLED: 'true',
          DOGEOS_FEE_ORACLE_PRICE_ORACLE__MAX_RETRIES: '3',
          DOGEOS_FEE_ORACLE_PRICE_ORACLE__REQUEST_TIMEOUT: '30',
          DOGEOS_FEE_ORACLE_WALLET__PRIVATE_KEY_ENV: 'DOGEOS_FEE_ORACLE_PRIVATE_KEY',
          DOGEOS_FEE_ORACLE_WALLET__SIGNER_BACKEND: 'local',
        },
        enabled: true
      }
    },
    env: [
      { name: 'RUST_LOG', value: 'info' }
    ],
    envFrom: [
      { configMapRef: { name: 'fee-oracle-env' } },
      { secretRef: { name: 'fee-oracle-secret-env' } },
    ],
    image,
    resources: {
      limits: { cpu: '1', memory: '512Mi' },
      requests: { cpu: '50m', memory: '256Mi' }
    }
  }

  return yaml.dump(values)
}

/**
 * Generate Frontends values
 */
function generateFrontendsValues(spec: DeploymentSpec): string {
  const image = resolveImage(spec, 'frontends', {
    pullPolicy: 'Always',
    repository: 'dogeos69/scroll-sdk-frontends',
    tag: '3.0.2-beta.1'
  })

  const values = {
    command: [
      '/bin/bash',
      '-cx',
      `grep -v '^#' /app/conf/frontend-config | awk -F' = ' 'NF==2 {printf "export %s=\\"%s\\"\\n", $1, $2}' | sed 's/""/"/g' > /usr/share/nginx/html/.env
cat /usr/share/nginx/html/.env
source /usr/share/nginx/html/.env
sed -i "s|src=\\"/runtime-env.js\\"|src=\\"/runtime-env.js?rand=$RANDOM\\"|" index.html
exec /usr/local/bin/entrypoint.sh`
    ],
    image,
    ingress: {
      main: {
        hosts: [{
          host: spec.frontend.hosts.frontend,
          paths: [{ path: '/', pathType: 'Prefix' }]
        }],
        ingressClassName: 'nginx',
        tls: [{
          hosts: [spec.frontend.hosts.frontend],
          secretName: 'frontends-tls'
        }]
      }
    },
    persistence: {
      frontends: {
        enabled: true,
        mountPath: '/app/conf/',
        name: 'frontends-config',
        type: 'configMap'
      }
    }
  }

  return yaml.dump(values)
}

/**
 * Generate Frontends Config values (the configmap content)
 */
function generateFrontendsConfigValues(spec: DeploymentSpec): string {
  const values = {
    configMaps: {
      'frontend-config': {
        data: {
          'frontend-config': `# Frontend Configuration
REACT_APP_CHAIN_ID_L1 = ${spec.network.l1ChainId}
REACT_APP_CHAIN_ID_L2 = ${spec.network.l2ChainId}
REACT_APP_CHAIN_NAME_L1 = ${spec.network.l1ChainName}
REACT_APP_CHAIN_NAME_L2 = ${spec.network.l2ChainName}
REACT_APP_ETH_SYMBOL = ${spec.network.tokenSymbol}
REACT_APP_EXTERNAL_RPC_URI_L1 = ${spec.frontend.externalUrls.l1Rpc}
REACT_APP_EXTERNAL_RPC_URI_L2 = ${spec.frontend.externalUrls.l2Rpc}
REACT_APP_EXTERNAL_EXPLORER_URI_L1 = ${spec.frontend.externalUrls.l1Explorer}
REACT_APP_EXTERNAL_EXPLORER_URI_L2 = ${spec.frontend.externalUrls.l2Explorer}
REACT_APP_CONNECT_WALLET_PROJECT_ID = ${spec.frontend.walletConnectProjectId || ''}`
        },
        enabled: true
      }
    }
  }

  return yaml.dump(values)
}

/**
 * Generate Blockscout values
 */
function generateBlockscoutValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const values: Record<string, any> = {
    'blockscout-stack': {
      blockscout: {
        env: {
          CHAIN_TYPE: 'scroll',
          COIN: spec.network.tokenSymbol,
          COIN_NAME: spec.network.tokenSymbol,
          ECTO_USE_SSL: true,
          ETHEREUM_JSONRPC_HTTP_INSECURE: false,
          ETHEREUM_JSONRPC_HTTP_URL: 'http://l2-rpc:8545',
          ETHEREUM_JSONRPC_TRACE_URL: 'http://l2-rpc:8545',
          ETHEREUM_JSONRPC_VARIANT: 'geth',
          ETHEREUM_JSONRPC_WS_URL: 'ws://l2-rpc:8546',
          INDEXER_DISABLE_PENDING_TRANSACTIONS_FETCHER: true,
          INDEXER_SCROLL_L1_BATCH_START_BLOCK: String(spec.contracts.l1DeploymentBlock || 0),
          INDEXER_SCROLL_L1_CHAIN_CONTRACT: '',
          INDEXER_SCROLL_L1_ETH_GET_LOGS_RANGE_SIZE: 500,
          INDEXER_SCROLL_L1_MESSENGER_CONTRACT: '',
          INDEXER_SCROLL_L1_MESSENGER_START_BLOCK: String(spec.contracts.l1DeploymentBlock || 0),
          INDEXER_SCROLL_L1_RPC: L1_INTERFACE_RPC_ENDPOINT,
          INDEXER_SCROLL_L2_ETH_GET_LOGS_RANGE_SIZE: 500,
          INDEXER_SCROLL_L2_GAS_ORACLE_CONTRACT: '',
          INDEXER_SCROLL_L2_MESSENGER_CONTRACT: '',
          INDEXER_SCROLL_L2_MESSENGER_START_BLOCK: 0,
          SCROLL_L2_CURIE_UPGRADE_BLOCK: 0
        },
        envFrom: [
          { secretRef: { name: 'blockscout-secret-env' } }
        ],
        extraEnv: [
          { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { key: 'DATABASE_URL', name: 'blockscout-secret-env' } } }
        ],
        ingress: {
          annotations: {
            'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
            'nginx.ingress.kubernetes.io/cors-allow-headers': 'updated-gas-oracle, Content-Type, Authorization',
            'nginx.ingress.kubernetes.io/cors-allow-methods': 'GET, POST, OPTIONS',
            'nginx.ingress.kubernetes.io/cors-allow-origin': `https://${spec.frontend.hosts.blockscout}`,
            'nginx.ingress.kubernetes.io/cors-max-age': '86400',
            'nginx.ingress.kubernetes.io/enable-cors': 'true'
          },
          className: 'nginx',
          enabled: true,
          hostname: spec.frontend.hosts.blockscout,
          paths: [{ path: '/api', pathType: 'Prefix' }],
          tls: {
            enabled: true,
            secretName: 'blockscout-tls'
          }
        }
      },
      frontend: {
        env: {
          NEXT_PUBLIC_AD_BANNER_PROVIDER: 'none',
          NEXT_PUBLIC_AD_TEXT_PROVIDER: 'none',
          NEXT_PUBLIC_API_HOST: spec.frontend.hosts.blockscout,
          NEXT_PUBLIC_API_PROTOCOL: 'https',
          NEXT_PUBLIC_API_WEBSOCKET_PROTOCOL: 'wss',
          NEXT_PUBLIC_APP_PROTOCOL: 'https',
          NEXT_PUBLIC_NETWORK_CURRENCY_DECIMALS: '18',
          NEXT_PUBLIC_NETWORK_CURRENCY_NAME: 'Dogecoin',
          NEXT_PUBLIC_NETWORK_CURRENCY_SYMBOL: spec.network.tokenSymbol,
          NEXT_PUBLIC_NETWORK_ID: String(spec.network.l2ChainId),
          NEXT_PUBLIC_NETWORK_NAME: spec.network.l2ChainName,
          NEXT_PUBLIC_NETWORK_SHORT_NAME: 'DogeOS',
          PROMETHEUS_METRICS_ENABLED: 'false'
        },
        ingress: {
          annotations: {
            'cert-manager.io/cluster-issuer': 'letsencrypt-prod'
          },
          className: 'nginx',
          enabled: true,
          hostname: spec.frontend.hosts.blockscout,
          paths: [{ path: '/', pathType: 'Prefix' }],
          tls: {
            enabled: true,
            secretName: 'blockscout-front-tls'
          }
        }
      }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'blockscout-secret-env',
    secretConfig,
    [
      { property: 'DATABASE_URL', remoteKey: 'blockscout-secret-env', secretKey: 'DATABASE_URL' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate Contracts deployment values
 */
function generateContractsValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const values: Record<string, any> = {
    configMaps: {
      env: {
        data: {
          SCROLL_CHAIN_ID_L1: String(spec.network.l1ChainId),
          SCROLL_CHAIN_ID_L2: String(spec.network.l2ChainId),
          SCROLL_DEPLOYMENT_SALT: spec.contracts.deploymentSalt,
          SCROLL_L1_FEE_VAULT_ADDR: DEFAULT_L1_FEE_VAULT_ADDR,
          SCROLL_L1_RPC: L1_INTERFACE_RPC_ENDPOINT,
          SCROLL_L2_RPC: L2_RPC_ENDPOINT,
          SCROLL_OWNER_ADDR: spec.accounts.owner.address
        },
        enabled: true
      }
    },
    envFrom: [
      { configMapRef: { name: 'contracts-env' } },
      { secretRef: { name: 'contracts-secret-env' } }
    ],
    image: {
      pullPolicy: 'IfNotPresent',
      repository: DOCKER_REPOSITORY,
      tag: `deploy-${CONTRACTS_DOCKER_DEFAULT_TAG}`
    }
  }

  const externalSecrets = generateExternalSecrets(
    'contracts-secret-env',
    secretConfig,
    [
      { property: 'SCROLL_DEPLOYER_PRIVATE_KEY', remoteKey: 'contracts-secret-env', secretKey: 'SCROLL_DEPLOYER_PRIVATE_KEY' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}
