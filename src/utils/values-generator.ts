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
  L1_INTERFACE_BEACON_API_ENDPOINT,
  L1_INTERFACE_RPC_ENDPOINT,
  L2_RPC_ENDPOINT,
} from '../config/constants.js'
import {
  getBridgeFeeRateSatsPerKvb,
  getDogecoinIndexerStartHeight,
  getL1GenesisBlock,
  normalizeDeploymentSpec,
} from './deployment-spec-generator.js'
import {
  resolveDogecoinKubernetesEndpoints,
} from './kubernetes-endpoints.js'

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
  if (secretConfig.provider === 'kubernetes') {
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
 * Build peer list from sequencer and bootnode configs
 */
function buildPeerList(spec: DeploymentSpec): string[] {
  const peers: string[] = []

  // Add sequencer enodes
  if (spec.infrastructure.sequencers) {
    for (const seq of spec.infrastructure.sequencers) {
      if (seq.enodeUrl) {
        peers.push(seq.enodeUrl)
      }
    }
  }

  // Add bootnode enodes
  if (spec.infrastructure.bootnodes) {
    for (const bn of spec.infrastructure.bootnodes) {
      if (bn.enodeUrl) {
        peers.push(bn.enodeUrl)
      }
    }
  }

  return peers
}

/**
 * Service name to DeploymentSpec image key mapping
 */
type ServiceImageKey = keyof NonNullable<ImagesConfig['services']>

const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'
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
    submitterRpcUrl: 'https://sepolia.drpc.org',
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

  const files: GeneratedValuesFiles = {}

  // Core L2 infrastructure
  files['l2-sequencer-production.yaml'] = generateL2SequencerValues(normalizedSpec)
  files['l2-bootnode-production.yaml'] = generateL2BootnodeValues(normalizedSpec)
  files['l2-rpc-production.yaml'] = generateL2RpcValues(normalizedSpec)

  // L1 interface and private Ethereum DA devnet
  files['l1-devnet-production.yaml'] = generateL1DevnetValues(normalizedSpec)
  files['l1-interface-production.yaml'] = generateL1InterfaceValues(normalizedSpec)

  // DA and Dogecoin
  files['eth-da-submitter-production.yaml'] = generateEthDaSubmitterValues(normalizedSpec)
  files['dogecoin-production.yaml'] = generateDogecoinValues(normalizedSpec)

  // Bridge and signing
  files['tso-service-production.yaml'] = generateTsoServiceValues(normalizedSpec)
  files['withdrawal-processor-production.yaml'] = generateWithdrawalProcessorValues(normalizedSpec)

  // CubeSigner provides the TEE key. Dummy signers provide attestation keys.
  if (normalizedSpec.signing.cubesigner) {
    files['cubesigner-signer-production.yaml'] = generateCubesignerValues(normalizedSpec)
  }

  // Rollup services
  files['coordinator-api-production.yaml'] = generateCoordinatorApiValues(normalizedSpec)
  files['coordinator-cron-production.yaml'] = generateCoordinatorCronValues(normalizedSpec)
  files['gas-oracle-production.yaml'] = generateGasOracleValues(normalizedSpec)
  files['fee-oracle-production.yaml'] = generateFeeOracleValues(normalizedSpec)
  files['chain-monitor-production.yaml'] = generateChainMonitorValues(normalizedSpec)

  // Frontend and explorers
  files['frontends-production.yaml'] = generateFrontendsValues(normalizedSpec)
  files['frontends-config.yaml'] = generateFrontendsConfigValues(normalizedSpec)
  files['blockscout-production.yaml'] = generateBlockscoutValues(normalizedSpec)
  files['rollup-explorer-backend-production.yaml'] = generateRollupExplorerBackendValues(normalizedSpec)
  files['bridge-history-api-production.yaml'] = generateBridgeHistoryApiValues(normalizedSpec)
  files['bridge-history-fetcher-production.yaml'] = generateBridgeHistoryFetcherValues(normalizedSpec)

  // Admin and monitoring
  files['admin-system-backend-production.yaml'] = generateAdminSystemBackendValues(normalizedSpec)
  files['admin-system-cron-production.yaml'] = generateAdminSystemCronValues(normalizedSpec)
  files['admin-system-dashboard-production.yaml'] = generateAdminSystemDashboardValues(normalizedSpec)

  // Contracts deployment
  files['contracts-production.yaml'] = generateContractsValues(normalizedSpec)

  return files
}

/**
 * Generate L2 Sequencer values
 */
function generateL2SequencerValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)
  const peerList = buildPeerList(spec)

  // Get signer address for this instance (uses __INSTANCE_INDEX__ placeholder)
  // The actual address will be filled by the deployment process based on instance index
  const getSignerAddress = (): string => {
    if (spec.infrastructure.sequencers && spec.infrastructure.sequencers.length > 0) {
      // Return placeholder that references the sequencer config
      // In practice, this gets replaced during chart preparation
      return '__SEQUENCER_SIGNER_ADDRESS__'
    }

    return ''
  }

  const image = resolveImage(spec, 'l2Sequencer', {
    pullPolicy: 'IfNotPresent',
    repository: 'scrolltech/l2geth',
    tag: 'scroll-v5.9.6'
  })

  const values: Record<string, any> = {
    configMaps: {
      env: {
        data: {
          CHAIN_ID: String(spec.network.l2ChainId),
          L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK: String(spec.contracts.l1DeploymentBlock || 0),
          L2GETH_L1_ENDPOINT: L1_INTERFACE_RPC_ENDPOINT,
          L2GETH_PEER_LIST: JSON.stringify(peerList.length > 0 ? peerList : []),
          L2GETH_SIGNER_ADDRESS: getSignerAddress()
        },
        enabled: true
      }
    },
    envFrom: [
      { configMapRef: { name: 'l2-sequencer-__INSTANCE_INDEX__-env' } },
      { secretRef: { name: 'l2-sequencer-__INSTANCE_INDEX__-secret-env' } }
    ],
    global: {
      fullnameOverride: 'l2-sequencer-__INSTANCE_INDEX__'
    },
    image,
    initContainers: {
      'wait-for-l1': {
        command: ['/bin/sh', '-c', '/wait-for-l1.sh $L2GETH_L1_ENDPOINT'],
        envFrom: [{ configMapRef: { name: 'l2-sequencer-__INSTANCE_INDEX__-env' } }],
        image: 'scrolltech/scroll-alpine:v0.0.1',
        volumeMounts: [{
          mountPath: '/wait-for-l1.sh',
          name: 'wait-for-l1-script',
          subPath: 'wait-for-l1.sh'
        }]
      }
    },
    persistence: {
      data: {
        retain: true,
        size: '1000Gi'
      },
      env: {
        enabled: true,
        name: 'l2-sequencer-__INSTANCE_INDEX__-env',
        type: 'configMap'
      }
    },
    resources: {
      limits: { cpu: '4', memory: '8Gi' },
      requests: { cpu: '50m', memory: '150Mi' }
    }
  }

  // Add external secrets if not using k8s secrets directly
  const externalSecrets = generateExternalSecrets(
    'l2-sequencer-__INSTANCE_INDEX__-secret-env',
    secretConfig,
    [
      { property: 'L2GETH_KEYSTORE', remoteKey: 'l2-sequencer-__INSTANCE_INDEX__-secret-env', secretKey: 'L2GETH_KEYSTORE' },
      { property: 'L2GETH_PASSWORD', remoteKey: 'l2-sequencer-__INSTANCE_INDEX__-secret-env', secretKey: 'L2GETH_PASSWORD' },
      { property: 'L2GETH_NODEKEY', remoteKey: 'l2-sequencer-__INSTANCE_INDEX__-secret-env', secretKey: 'L2GETH_NODEKEY' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  // Add sequencer instance metadata as comments for reference
  if (spec.infrastructure.sequencers && spec.infrastructure.sequencers.length > 0) {
    values._sequencerInstances = spec.infrastructure.sequencers.map(s => ({
      enodeUrl: s.enodeUrl || 'generated-during-deployment',
      index: s.index,
      signerAddress: s.signerAddress
    }))
  }

  return yaml.dump(values)
}

/**
 * Generate L2 Bootnode values
 */
function generateL2BootnodeValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)
  const peerList = buildPeerList(spec)

  const image = resolveImage(spec, 'l2Bootnode', {
    pullPolicy: 'IfNotPresent',
    repository: 'scrolltech/l2geth',
    tag: 'scroll-v5.9.6'
  })

  const values: Record<string, any> = {
    configMaps: {
      env: {
        data: {
          CHAIN_ID: String(spec.network.l2ChainId),
          L2GETH_DA_BLOB_BEACON_NODE: L1_INTERFACE_BEACON_API_ENDPOINT,
          L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK: String(spec.contracts.l1DeploymentBlock || 0),
          L2GETH_L1_ENDPOINT: L1_INTERFACE_RPC_ENDPOINT,
          L2GETH_PEER_LIST: JSON.stringify(peerList.length > 0 ? peerList : [])
        },
        enabled: true
      }
    },
    envFrom: [
      { configMapRef: { name: 'l2-bootnode-__INSTANCE_INDEX__-env' } },
      { secretRef: { name: 'l2-bootnode-__INSTANCE_INDEX__-secret-env' } }
    ],
    global: {
      fullnameOverride: 'l2-bootnode-__INSTANCE_INDEX__'
    },
    image,
    initContainers: {
      'wait-for-l1': {
        command: ['/bin/sh', '-c', '/wait-for-l1.sh $L2GETH_L1_ENDPOINT'],
        envFrom: [{ configMapRef: { name: 'l2-bootnode-__INSTANCE_INDEX__-env' } }],
        image: 'scrolltech/scroll-alpine:v0.0.1',
        volumeMounts: [{
          mountPath: '/wait-for-l1.sh',
          name: 'wait-for-l1-script',
          subPath: 'wait-for-l1.sh'
        }]
      }
    },
    persistence: {
      data: {
        retain: true,
        size: '1000Gi'
      },
      env: {
        enabled: true,
        mountPath: '/config/',
        name: 'l2-bootnode-__INSTANCE_INDEX__-env',
        type: 'configMap'
      }
    },
    service: {
      p2p: { enabled: true }
    }
  }

  // Add external secrets if not using k8s secrets directly
  const externalSecrets = generateExternalSecrets(
    'l2-bootnode-__INSTANCE_INDEX__-secret-env',
    secretConfig,
    [
      { property: 'L2GETH_NODEKEY', remoteKey: 'l2-bootnode-__INSTANCE_INDEX__', secretKey: 'L2GETH_NODEKEY' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  // Add bootnode instance metadata for reference
  if (spec.infrastructure.bootnodes && spec.infrastructure.bootnodes.length > 0) {
    values._bootnodeInstances = spec.infrastructure.bootnodes.map(b => ({
      enodeUrl: b.enodeUrl || 'generated-during-deployment',
      index: b.index,
      publicEndpoint: b.publicEndpoint
    }))
  }

  return yaml.dump(values)
}

/**
 * Generate L2 RPC values
 */
function generateL2RpcValues(spec: DeploymentSpec): string {
  const peerList = buildPeerList(spec)

  const image = resolveImage(spec, 'l2Rpc', {
    pullPolicy: 'IfNotPresent',
    repository: 'scrolltech/l2geth',
    tag: 'scroll-v5.9.6'
  })

  const values = {
    configMaps: {
      env: {
        data: {
          CHAIN_ID: String(spec.network.l2ChainId),
          L2GETH_DA_BLOB_BEACON_NODE: L1_INTERFACE_BEACON_API_ENDPOINT,
          L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK: String(spec.contracts.l1DeploymentBlock || 0),
          L2GETH_L1_ENDPOINT: L1_INTERFACE_RPC_ENDPOINT,
          L2GETH_PEER_LIST: JSON.stringify(peerList.length > 0 ? peerList : [])
        },
        enabled: true
      }
    },
    envFrom: [
      { configMapRef: { name: 'l2-rpc-env' } }
    ],
    global: {
      fullnameOverride: 'l2-rpc'
    },
    image,
    ingress: {
      main: {
        hosts: [{
          host: spec.frontend.hosts.rpcGateway,
          paths: [{ path: '/', pathType: 'Prefix' }]
        }],
        ingressClassName: 'nginx',
        tls: [{
          hosts: [spec.frontend.hosts.rpcGateway],
          secretName: 'l2-rpc-tls'
        }]
      }
    },
    persistence: {
      data: {
        retain: true,
        size: '1000Gi'
      }
    }
  }

  return yaml.dump(values)
}

/**
 * Generate L1 Interface values
 */
function generateL1InterfaceValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)
  const dogecoinEndpoints = resolveDogecoinKubernetesEndpoints(spec.dogecoin)

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
          DOGEOS_L1_INTERFACE_CHAIN_ID: String(spec.network.l2ChainId),
          DOGEOS_L1_INTERFACE_DATABASE_URL: 'sqlite:///data/l1-interface.sqlite',
          DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__CONFIRMATIONS: String(spec.bridge.confirmationsRequired),
          DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__INDEX_DEPOSITS: 'false',
          DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__INDEX_UTXOS: 'false',
          DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__INDEX_WITHDRAWALS: 'false',
          DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__POLL_INTERVAL_MS: '10000',
          DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__START_HEIGHT: String(getDogecoinIndexerStartHeight(spec)),
          DOGEOS_L1_INTERFACE_DOGECOIN_RPC__URL: dogecoinEndpoints.rpcUrl,
          DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL: getEthereumDaBeaconRpcUrl(spec),
          DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__TIMEOUT_MS: '10000',
          DOGEOS_L1_INTERFACE_ETHEREUM_DA__ETH_CHAIN_ID: String(getEthereumDaChainId(spec)),
          DOGEOS_L1_INTERFACE_ETHEREUM_DA__L1_RPC_URL: getEthereumDaSubmitterRpcUrl(spec),
          DOGEOS_L1_INTERFACE_ETHEREUM_DA__L2_CHAIN_ID: String(spec.network.l2ChainId),
          DOGEOS_L1_INTERFACE_GENESIS_JSON_PATH: '/app/genesis/genesis.json',
          DOGEOS_L1_INTERFACE_HEALTH_LISTEN_ADDRESS: '0.0.0.0:9090',
          DOGEOS_L1_INTERFACE_L1_CHAIN_ID: String(spec.network.l1ChainId),
          DOGEOS_L1_INTERFACE_L1_GENESIS_BLOCK: String(getL1GenesisBlock(spec)),
          DOGEOS_L1_INTERFACE_NETWORK_STR: spec.dogecoin.network,
          DOGEOS_L1_INTERFACE_REPLAY_READ__ENABLED: 'true',
          DOGEOS_L1_INTERFACE_REPLAY_READ__PROTOCOL_CONTEXT_JSON: '/app/protocol_context.json',
          DOGEOS_L1_INTERFACE_REPLAY_READ__SQLITE_PATH: '/data/replay.sqlite'
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
  const batch = getEthereumDaBatchConfig(spec)
  const { signer } = ethereumDa
  const isAwsKmsSigner = signer?.backend === 'aws_kms'

  const image = resolveImage(spec, 'ethDaSubmitter', {
    pullPolicy: 'IfNotPresent',
    repository: 'dogeos69/eth-da-submitter',
    tag: 'latest'
  })

  const values: Record<string, any> = {
    configMaps: {
      env: {
        data: {
          DOGEOS_ETH_DA_SUBMITTER_BATCH__COMPRESSION: batch.compression || 'none',
          DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_BATCH_HASH: batch.genesisBatchHash || ZERO_HASH,
          DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_NEXT_RELAYED_DEPOSIT_INDEX: String(batch.genesisNextRelayedDepositIndex ?? 0),
          DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_NEXT_WITHDRAW_INDEX: String(batch.genesisNextWithdrawIndex ?? 0),
          DOGEOS_ETH_DA_SUBMITTER_BATCH__GENESIS_STATE_ROOT: batch.genesisStateRoot || ZERO_HASH,
          DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_BLOCKS_PER_CHUNK: String(batch.maxBlocksPerChunk ?? 128),
          DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_CHUNKS_PER_BATCH: String(batch.maxChunksPerBatch ?? 1),
          DOGEOS_ETH_DA_SUBMITTER_BATCH__MAX_UNCOMPRESSED_BATCH_BYTES_SIZE: String(batch.maxUncompressedBatchBytesSize ?? 131_072),
          DOGEOS_ETH_DA_SUBMITTER_BATCH__MIN_CODEC_VERSION: String(batch.minCodecVersion ?? 10),
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__CONFIRMATION_DEPTH: String(ethereumDa.confirmationDepth ?? 1),
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__CONFIRMER_POLL_INTERVAL_MS: String(ethereumDa.confirmerPollIntervalMs ?? 12_000),
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__ETH_CHAIN_ID: String(getEthereumDaChainId(spec)),
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__FINALIZATION_DEPTH: String(ethereumDa.finalizationDepth ?? 64),
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__L2_CHAIN_ID: String(spec.network.l2ChainId),
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__MAX_BLOB_BASE_FEE_WEI: ethereumDa.maxBlobBaseFeeWei || '50000000000',
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__MAX_FEE_PER_GAS_WEI: ethereumDa.maxFeePerGasWei || '',
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__MIN_PRIORITY_FEE_WEI: ethereumDa.minPriorityFeeWei || '2000000000',
          DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__RPC_URL: getEthereumDaSubmitterRpcUrl(spec),
          ...(isAwsKmsSigner ? {
            DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__KMS_EXPECTED_ADDRESS: signer?.expectedAddress || '',
            DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__KMS_KEY_ID: signer?.kmsKeyId || '',
            DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__KMS_REGION: signer?.kmsRegion || '',
            DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__SIGNER_BACKEND: 'aws_kms',
          } : {
            DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__SIGNER_BACKEND: 'local',
          }),
          DOGEOS_ETH_DA_SUBMITTER_L2__CONFIRMATIONS: String(ethereumDa.l2Confirmations ?? 0),
          DOGEOS_ETH_DA_SUBMITTER_L2__FETCH_LIMIT: String(ethereumDa.fetchLimit ?? 128),
          DOGEOS_ETH_DA_SUBMITTER_L2__RPC_URL: ethereumDa.l2RpcUrl || L2_RPC_ENDPOINT,
          DOGEOS_ETH_DA_SUBMITTER_S3__ENABLED: 'false',
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
      ...(isAwsKmsSigner ? [] : [{ secretRef: { name: 'eth-da-submitter-secret-env' } }])
    ],
    image,
    persistence: {
      data: {
        retain: true,
        size: '10Gi'
      }
    },
    resources: {
      limits: { cpu: '1000m', memory: '1Gi' },
      requests: { cpu: '200m', memory: '256Mi' }
    }
  }

  if (isAwsKmsSigner) {
    values.serviceAccount = {
      annotations: signer?.serviceAccountRoleArn ? {
        'eks.amazonaws.com/role-arn': signer.serviceAccountRoleArn,
      } : {},
      create: true,
      name: signer?.serviceAccountName || 'eth-da-submitter',
    }
  }

  const externalSecrets = isAwsKmsSigner ? undefined : generateExternalSecrets(
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
  const ethereumDaSigner = getEthereumDaConfig(spec).signer

  const image = resolveImage(spec, 'withdrawalProcessor', {
    pullPolicy: 'Always',
    repository: 'dogeos69/withdrawal-processor',
    tag: '0.2.0-rc.4'
  })

  const values: Record<string, any> = {
    env: [
      { name: 'DOGEOS_WITHDRAWAL_NETWORK_STR', value: spec.dogecoin.network },
      { name: 'DOGEOS_WITHDRAWAL_DATABASE_URL', valueFrom: { secretKeyRef: { key: 'DOGEOS_WITHDRAWAL_DATABASE_URL', name: 'withdrawal-processor-secret-env' } } },
      { name: 'DOGEOS_WITHDRAWAL_API_PORT', value: '3000' },
      { name: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_URL', value: dogecoinEndpoints.rpcUrl },
      { name: 'DOGEOS_WITHDRAWAL_TSO_URL', value: 'http://tso-service:3000' },
      { name: 'DOGEOS_WITHDRAWAL_BRIDGE_ADDRESS', value: '' },
      { name: 'DOGEOS_WITHDRAWAL_BRIDGE_SCRIPT_HEX', value: '' },
      { name: 'DOGEOS_WITHDRAWAL_MAX_WITHDRAWAL_OUTPUTS_PER_TX', value: '1024' },
      { name: 'DOGEOS_WITHDRAWAL_FEE_RATE_SAT_PER_KVB', value: String(getBridgeFeeRateSatsPerKvb(spec)) },
      { name: 'DOGEOS_WITHDRAWAL_COORDINATOR_POLL_INTERVAL_SECS', value: '10' },
      { name: 'DOGEOS_WITHDRAWAL_DEBUG_SKIP_BROADCAST', value: 'false' },
      { name: 'DOGEOS_WITHDRAWAL_ROTATE_KEY_V2', value: 'true' },
      { name: 'DOGEOS_WITHDRAWAL_ADVANCE_L1_BUILDER_V2', value: 'true' },
      { name: 'DOGEOS_WITHDRAWAL_ADVANCE_L2_BUILDER_V2', value: 'true' },
      { name: 'DOGEOS_WITHDRAWAL_REPLAY_SQLITE_PATH', value: '/app/data/replay.sqlite' },
      { name: 'DOGEOS_WITHDRAWAL_PROTOCOL_CONTEXT_JSON', value: '/app/protocol_context.json' },
      // Dogecoin Indexer
      { name: 'DOGEOS_WITHDRAWAL_DOGECOIN_INDEXER__START_HEIGHT', value: String(getDogecoinIndexerStartHeight(spec)) },
      { name: 'DOGEOS_WITHDRAWAL_DOGECOIN_INDEXER__CONFIRMATIONS', value: String(spec.bridge.confirmationsRequired) },
      { name: 'DOGEOS_WITHDRAWAL_DOGECOIN_INDEXER__POLL_INTERVAL_MS', value: '60000' },
      // DogeOS Indexer
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__RPC_URL', value: L2_RPC_ENDPOINT },
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__START_BLOCK', value: '0' },
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__CONFIRMATIONS', value: '12' },
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__POLL_INTERVAL_MS', value: '60000' },
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__LOG_QUERY_BATCH_SIZE', value: '10000' },
      // Ethereum DA resolver/indexer inputs for AdvanceL2 builder v2.
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__L1_RPC_URL', value: getEthereumDaSubmitterRpcUrl(spec) },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__ETH_CHAIN_ID', value: String(getEthereumDaChainId(spec)) },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__L2_CHAIN_ID', value: String(spec.network.l2ChainId) },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INDEXER_SQLITE_PATH', value: '/app/data/eth-da-indexer.sqlite' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__ARTIFACT_STORE_ROOT', value: '/app/data/eth-da-blob-artifacts' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__ARTIFACT_METADATA_SQLITE_PATH', value: '/app/data/eth-da-artifact-metadata.sqlite' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__MIN_FINALITY', value: getEthereumDaMinFinality(spec) },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__ENABLED', value: 'true' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__WRITER_ID', value: 'withdrawal-processor' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__CURSOR_ID', value: 'eth_da_inbox' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__START_BLOCK', value: String(getDogecoinIndexerStartHeight(spec)) },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__INGEST_DEPTH', value: '1' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__SAFE_DEPTH', value: '32' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__FINALIZED_DEPTH', value: '64' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__ROLLBACK_LOOKBACK', value: '128' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__POLL_INTERVAL_MS', value: '6000' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__MAX_BLOCKS_PER_CYCLE', value: '64' },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__STATUS_POLL_INTERVAL_MS', value: '5000' },
      ...(ethereumDaSigner?.expectedAddress ? [{
        name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__INBOX_WORKER__EXPECTED_BATCHERS',
        value: JSON.stringify([ethereumDaSigner.expectedAddress]),
      }] : []),
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL', value: getEthereumDaBeaconRpcUrl(spec) },
      { name: 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__TIMEOUT_MS', value: '10000' },
      { name: 'RUST_LOG', value: 'info,withdrawal_processor=info' }
    ],
    envFrom: [
      { secretRef: { name: 'withdrawal-processor-secret-env' } }
    ],
    image,
    resources: {
      limits: { cpu: '1000m', memory: '2Gi' },
      requests: { cpu: '200m', memory: '512Mi' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'withdrawal-processor-secret-env',
    secretConfig,
    [
      { property: 'DOGEOS_WITHDRAWAL_DATABASE_URL', remoteKey: 'withdrawal-processor-secret-env', secretKey: 'DOGEOS_WITHDRAWAL_DATABASE_URL' },
      { property: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_USER', remoteKey: 'withdrawal-processor-secret-env', secretKey: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_USER' },
      { property: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_PASS', remoteKey: 'withdrawal-processor-secret-env', secretKey: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_PASS' }
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

  const image = resolveImage(spec, 'cubesignerSigner', {
    pullPolicy: 'IfNotPresent',
    repository: 'dogeos69/cubesigner-signer',
    tag: '0.2.0-rc.4'
  })

  const values: Record<string, any> = {
    env: [
      { name: 'DOGEOS_CUBESIGNER_SIGNER_PORT', value: '3000' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_NETWORK', value: spec.dogecoin.network },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_TSO_URL', value: 'http://tso-service:3000' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_SIGNATURE_DELAY', value: '0' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_POLL_INTERVAL', value: '5000' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', valueFrom: { secretKeyRef: { key: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', name: 'cubesigner-signer-__INSTANCE_INDEX__-env' } } },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_CS_SESSION_PATH', value: '/etc/cubesigner/session.json' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_BODY_LIMIT', value: '5mb' }
    ],
    global: {
      fullnameOverride: 'cubesigner-signer-__INSTANCE_INDEX__'
    },
    image,
    persistence: {
      session: {
        enabled: true,
        mountPath: '/etc/cubesigner',
        name: 'cubesigner-signer-__INSTANCE_INDEX__-session',
        readOnly: true,
        secretName: 'cubesigner-signer-__INSTANCE_INDEX__-session',
        type: 'secret'
      }
    },
    resources: {
      limits: { cpu: '1000m', memory: '512Mi' },
      requests: { cpu: '50m', memory: '128Mi' }
    },
    serviceMonitor: {
      main: { enabled: false }
    },
    volumeClaimTemplates: [{
      accessMode: 'ReadWriteOnce',
      mountPath: '/app/.sessions',
      name: 'session-cache-__INSTANCE_INDEX__',
      size: '1Gi'
    }]
  }

  // Generate external secrets for both env and session
  const envSecrets = generateExternalSecrets(
    'cubesigner-signer-__INSTANCE_INDEX__-env',
    secretConfig,
    [
      { property: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', remoteKey: 'cubesigner-signer-__INSTANCE_INDEX__-env', secretKey: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID' }
    ]
  )

  const sessionSecrets = generateExternalSecrets(
    'cubesigner-signer-__INSTANCE_INDEX__-session',
    secretConfig,
    [
      { property: 'session.json', remoteKey: 'cubesigner-signer-__INSTANCE_INDEX__-session', secretKey: 'session.json' }
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

/**
 * Generate Coordinator API values
 */
function generateCoordinatorApiValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const image = resolveImage(spec, 'coordinator', {
    pullPolicy: 'IfNotPresent',
    repository: 'scrolltech/coordinator-api',
    tag: 'v4.4.83'
  })

  const values: Record<string, any> = {
    controller: {
      replicas: 2
    },
    envFrom: [
      { secretRef: { name: 'coordinator-api-secret-env' } }
    ],
    image,
    ingress: {
      main: {
        hosts: [{
          host: spec.frontend.hosts.coordinatorApi,
          paths: [{ path: '/', pathType: 'Prefix' }]
        }],
        ingressClassName: 'nginx'
      }
    },
    resources: {
      limits: { cpu: '200m', memory: '24Gi' },
      requests: { cpu: '50m', memory: '2Gi' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'coordinator-api-secret-env',
    secretConfig,
    [
      { property: 'SCROLL_COORDINATOR_DB_DSN', remoteKey: 'coordinator-api-secret-env', secretKey: 'SCROLL_COORDINATOR_DB_DSN' },
      { property: 'SCROLL_COORDINATOR_AUTH_SECRET', remoteKey: 'coordinator-api-secret-env', secretKey: 'SCROLL_COORDINATOR_AUTH_SECRET' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate Coordinator Cron values
 */
function generateCoordinatorCronValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const values: Record<string, any> = {
    envFrom: [
      { secretRef: { name: 'coordinator-cron-secret-env' } }
    ],
    resources: {
      limits: { cpu: '500m', memory: '2Gi' },
      requests: { cpu: '50m', memory: '256Mi' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'coordinator-cron-secret-env',
    secretConfig,
    [
      { property: 'SCROLL_COORDINATOR_DB_DSN', remoteKey: 'coordinator-cron-secret-env', secretKey: 'SCROLL_COORDINATOR_DB_DSN' },
      { property: 'SCROLL_COORDINATOR_AUTH_SECRET', remoteKey: 'coordinator-cron-secret-env', secretKey: 'SCROLL_COORDINATOR_AUTH_SECRET' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate Gas Oracle values
 */
function generateGasOracleValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const image = resolveImage(spec, 'gasOracle', {
    pullPolicy: 'IfNotPresent',
    repository: 'scrolltech/gas-oracle',
    tag: 'gas-oracle-v4.4.83'
  })

  const values: Record<string, any> = {
    configMaps: {
      env: {
        data: {
          SCROLL_GAS_ORACLE_BLOB_SCALAR: String(spec.contracts.gasOracle.blobScalar),
          SCROLL_GAS_ORACLE_L1_RPC_URL: L1_INTERFACE_RPC_ENDPOINT,
          SCROLL_GAS_ORACLE_L2_RPC_URL: L2_RPC_ENDPOINT,
          SCROLL_GAS_ORACLE_SCALAR: String(spec.contracts.gasOracle.scalar)
        },
        enabled: true
      }
    },
    envFrom: [
      { configMapRef: { name: 'gas-oracle-env' } },
      { secretRef: { name: 'gas-oracle-secret-env' } }
    ],
    image,
    resources: {
      limits: { cpu: '500m', memory: '2Gi' },
      requests: { cpu: '50m', memory: '256Mi' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'gas-oracle-secret-env',
    secretConfig,
    [
      { property: 'SCROLL_GAS_ORACLE_DB_DSN', remoteKey: 'gas-oracle-secret-env', secretKey: 'SCROLL_GAS_ORACLE_DB_DSN' },
      { property: 'SCROLL_GAS_ORACLE_L1_SENDER_PRIVATE_KEY', remoteKey: 'gas-oracle-secret-env', secretKey: 'SCROLL_GAS_ORACLE_L1_SENDER_PRIVATE_KEY' },
      { property: 'SCROLL_GAS_ORACLE_L2_SENDER_PRIVATE_KEY', remoteKey: 'gas-oracle-secret-env', secretKey: 'SCROLL_GAS_ORACLE_L2_SENDER_PRIVATE_KEY' }
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
          DOGEOS_FEE_ORACLE_ETHEREUM_DA__CONTRACT_WRITE_MODE: 'dry_run',
          DOGEOS_FEE_ORACLE_ETHEREUM_DA__ETH_RPC_URL: getEthereumDaSubmitterRpcUrl(spec),
          DOGEOS_FEE_ORACLE_ETHEREUM_DA__MIN_PRIORITY_FEE_PER_GAS_WEI: '"0"',
          DOGEOS_FEE_ORACLE_L2__CHAIN_ID: String(spec.network.l2ChainId),
          DOGEOS_FEE_ORACLE_L2__CONFIRMATIONS: '3',
          DOGEOS_FEE_ORACLE_L2__GAS_ORACLE_CONTRACT: spec.contracts.overrides?.l1GasPriceOracle || '<TODO>',
          DOGEOS_FEE_ORACLE_L2__MAX_GAS_PRICE: '1000000000000',
          DOGEOS_FEE_ORACLE_L2__PRIORITY_FEE: '1000000000',
          DOGEOS_FEE_ORACLE_L2__RPC_URL: L2_RPC_ENDPOINT,
          DOGEOS_FEE_ORACLE_MONITORING__HEALTH_BIND_ADDRESS: '0.0.0.0',
          DOGEOS_FEE_ORACLE_MONITORING__HEALTH_CHECK_PORT: '8080',
          DOGEOS_FEE_ORACLE_MONITORING__METRICS_PORT: '9090',
          DOGEOS_FEE_ORACLE_PRICE_ORACLE__CACHE_DURATION: '60',
          DOGEOS_FEE_ORACLE_PRICE_ORACLE__COINBASE_ENABLED: 'true',
          DOGEOS_FEE_ORACLE_PRICE_ORACLE__COINGECKO_ENABLED: 'false',
          DOGEOS_FEE_ORACLE_PRICE_ORACLE__GATEIO_ENABLED: 'true',
          DOGEOS_FEE_ORACLE_PRICE_ORACLE__KRAKEN_ENABLED: 'true',
          DOGEOS_FEE_ORACLE_PRICE_ORACLE__MAX_RETRIES: '3',
          DOGEOS_FEE_ORACLE_PRICE_ORACLE__REQUEST_TIMEOUT: '30',
          DOGEOS_FEE_ORACLE_WALLET__PRIVATE_KEY_ENV: 'DOGEOS_FEE_ORACLE_PRIVATE_KEY',
        },
        enabled: true
      }
    },
    env: [
      { name: 'RUST_LOG', value: 'info' }
    ],
    envFrom: [
      { configMapRef: { name: 'fee-oracle-env' } }
    ],
    image,
    probes: {
      liveness: {
        custom: true,
        enabled: true,
        spec: {
          failureThreshold: 3,
          httpGet: { path: '/health', port: 'http' },
          initialDelaySeconds: 60,
          periodSeconds: 30,
          timeoutSeconds: 30,
        }
      },
      readiness: {
        custom: true,
        enabled: true,
        spec: {
          failureThreshold: 3,
          httpGet: { path: '/health', port: 'http' },
          initialDelaySeconds: 30,
          periodSeconds: 10,
          timeoutSeconds: 30,
        }
      },
      startup: {
        custom: true,
        enabled: true,
        spec: {
          failureThreshold: 12,
          httpGet: { path: '/health', port: 'http' },
          initialDelaySeconds: 30,
          periodSeconds: 10,
          timeoutSeconds: 30,
        }
      }
    },
    resources: {
      limits: { cpu: '1', memory: '512Mi' },
      requests: { cpu: '50m', memory: '256Mi' }
    }
  }

  return yaml.dump(values)
}

/**
 * Generate Chain Monitor values
 */
function generateChainMonitorValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const image = resolveImage(spec, 'chainMonitor', {
    pullPolicy: 'IfNotPresent',
    repository: 'scrolltech/chain-monitor',
    tag: 'chain-monitor-v4.4.83'
  })

  const values: Record<string, any> = {
    configMaps: {
      env: {
        data: {
          SCROLL_CHAIN_MONITOR_L1_RPC_URL: L1_INTERFACE_RPC_ENDPOINT,
          SCROLL_CHAIN_MONITOR_L2_RPC_URL: L2_RPC_ENDPOINT
        },
        enabled: true
      }
    },
    envFrom: [
      { configMapRef: { name: 'chain-monitor-env' } },
      { secretRef: { name: 'chain-monitor-secret-env' } }
    ],
    image,
    resources: {
      limits: { cpu: '500m', memory: '2Gi' },
      requests: { cpu: '50m', memory: '256Mi' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'chain-monitor-secret-env',
    secretConfig,
    [
      { property: 'SCROLL_CHAIN_MONITOR_DB_DSN', remoteKey: 'chain-monitor-secret-env', secretKey: 'SCROLL_CHAIN_MONITOR_DB_DSN' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
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
REACT_APP_BRIDGE_API_URI = ${spec.frontend.externalUrls.bridgeApi}
REACT_APP_ROLLUPSCAN_API_URI = ${spec.frontend.externalUrls.rollupScanApi}
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
 * Generate Rollup Explorer Backend values
 */
function generateRollupExplorerBackendValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const image = resolveImage(spec, 'rollupExplorerBackend', {
    pullPolicy: 'IfNotPresent',
    repository: 'scrolltech/rollup-explorer-backend',
    tag: 'rollup-explorer-backend-v4.4.83'
  })

  const values: Record<string, any> = {
    envFrom: [
      { secretRef: { name: 'rollup-explorer-backend-secret-env' } }
    ],
    image,
    ingress: {
      main: {
        hosts: [{
          host: spec.frontend.hosts.rollupExplorerApi,
          paths: [{ path: '/', pathType: 'Prefix' }]
        }],
        ingressClassName: 'nginx'
      }
    },
    resources: {
      limits: { cpu: '500m', memory: '2Gi' },
      requests: { cpu: '50m', memory: '256Mi' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'rollup-explorer-backend-secret-env',
    secretConfig,
    [
      { property: 'SCROLL_ROLLUP_EXPLORER_DB_DSN', remoteKey: 'rollup-explorer-backend-secret-env', secretKey: 'SCROLL_ROLLUP_EXPLORER_DB_DSN' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate Bridge History API values
 */
function generateBridgeHistoryApiValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const image = resolveImage(spec, 'bridgeHistoryApi', {
    pullPolicy: 'IfNotPresent',
    repository: 'scrolltech/bridge-history-api',
    tag: 'bridge-history-api-v4.4.83'
  })

  const values: Record<string, any> = {
    envFrom: [
      { secretRef: { name: 'bridge-history-api-secret-env' } }
    ],
    image,
    ingress: {
      main: {
        hosts: [{
          host: spec.frontend.hosts.bridgeHistoryApi,
          paths: [{ path: '/', pathType: 'Prefix' }]
        }],
        ingressClassName: 'nginx'
      }
    },
    resources: {
      limits: { cpu: '500m', memory: '2Gi' },
      requests: { cpu: '50m', memory: '256Mi' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'bridge-history-api-secret-env',
    secretConfig,
    [
      { property: 'SCROLL_BRIDGE_HISTORY_DB_DSN', remoteKey: 'bridge-history-api-secret-env', secretKey: 'SCROLL_BRIDGE_HISTORY_DB_DSN' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate Bridge History Fetcher values
 */
function generateBridgeHistoryFetcherValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const image = resolveImage(spec, 'bridgeHistoryFetcher', {
    pullPolicy: 'IfNotPresent',
    repository: 'scrolltech/bridge-history-fetcher',
    tag: 'bridge-history-fetcher-v4.4.83'
  })

  const values: Record<string, any> = {
    configMaps: {
      env: {
        data: {
          SCROLL_BRIDGE_HISTORY_L1_RPC_URL: L1_INTERFACE_RPC_ENDPOINT,
          SCROLL_BRIDGE_HISTORY_L1_START_HEIGHT: String(spec.contracts.l1DeploymentBlock || 0),
          SCROLL_BRIDGE_HISTORY_L2_RPC_URL: L2_RPC_ENDPOINT
        },
        enabled: true
      }
    },
    envFrom: [
      { configMapRef: { name: 'bridge-history-fetcher-env' } },
      { secretRef: { name: 'bridge-history-fetcher-secret-env' } }
    ],
    image,
    resources: {
      limits: { cpu: '1000m', memory: '4Gi' },
      requests: { cpu: '100m', memory: '512Mi' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'bridge-history-fetcher-secret-env',
    secretConfig,
    [
      { property: 'SCROLL_BRIDGE_HISTORY_DB_DSN', remoteKey: 'bridge-history-fetcher-secret-env', secretKey: 'SCROLL_BRIDGE_HISTORY_DB_DSN' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate Admin System Backend values
 */
function generateAdminSystemBackendValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const values: Record<string, any> = {
    configMaps: {
      env: {
        data: {
          SCROLL_ADMIN_L1_RPC_URL: L1_INTERFACE_RPC_ENDPOINT,
          SCROLL_ADMIN_L2_RPC_URL: L2_RPC_ENDPOINT
        },
        enabled: true
      }
    },
    envFrom: [
      { configMapRef: { name: 'admin-system-backend-env' } },
      { secretRef: { name: 'admin-system-backend-secret-env' } }
    ],
    image: {
      pullPolicy: 'IfNotPresent',
      repository: 'scrolltech/admin-system-backend',
      tag: 'admin-system-backend-v4.4.83'
    },
    resources: {
      limits: { cpu: '500m', memory: '2Gi' },
      requests: { cpu: '50m', memory: '256Mi' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'admin-system-backend-secret-env',
    secretConfig,
    [
      { property: 'SCROLL_ADMIN_DB_DSN', remoteKey: 'admin-system-backend-secret-env', secretKey: 'SCROLL_ADMIN_DB_DSN' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate Admin System Cron values
 */
function generateAdminSystemCronValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const values: Record<string, any> = {
    envFrom: [
      { secretRef: { name: 'admin-system-cron-secret-env' } }
    ],
    image: {
      pullPolicy: 'IfNotPresent',
      repository: 'scrolltech/admin-system-cron',
      tag: 'admin-system-cron-v4.4.83'
    },
    resources: {
      limits: { cpu: '500m', memory: '1Gi' },
      requests: { cpu: '50m', memory: '128Mi' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'admin-system-cron-secret-env',
    secretConfig,
    [
      { property: 'SCROLL_ADMIN_DB_DSN', remoteKey: 'admin-system-cron-secret-env', secretKey: 'SCROLL_ADMIN_DB_DSN' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate Admin System Dashboard values
 */
function generateAdminSystemDashboardValues(spec: DeploymentSpec): string {
  const values = {
    image: {
      pullPolicy: 'IfNotPresent',
      repository: 'scrolltech/admin-system-dashboard',
      tag: 'admin-system-dashboard-v4.4.83'
    },
    ingress: {
      main: {
        hosts: [{
          host: spec.frontend.hosts.adminDashboard,
          paths: [{ path: '/', pathType: 'Prefix' }]
        }],
        ingressClassName: 'nginx',
        tls: [{
          hosts: [spec.frontend.hosts.adminDashboard],
          secretName: 'admin-dashboard-tls'
        }]
      }
    }
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
      repository: 'scrolltech/scroll-contracts',
      tag: 'scroll-contracts-v0.1.0'
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
