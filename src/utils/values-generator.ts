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

import * as yaml from 'js-yaml'
import type { DeploymentSpec, ImageConfig, ImagesConfig } from '../types/deployment-spec.js'

export interface GeneratedValuesFiles {
  [filename: string]: string
}

/**
 * Secret provider configuration derived from DeploymentSpec
 */
interface SecretProviderConfig {
  provider: 'aws' | 'gcp' | 'kubernetes'
  prefix: string
  // AWS-specific
  awsRegion?: string
  // GCP-specific
  gcpProject?: string
}

/**
 * Get secret provider configuration from spec
 */
function getSecretProviderConfig(spec: DeploymentSpec): SecretProviderConfig {
  switch (spec.infrastructure.provider) {
    case 'aws':
      return {
        provider: 'aws',
        prefix: spec.infrastructure.aws?.secretsPrefix || 'scroll',
        awsRegion: spec.infrastructure.aws?.region || 'us-west-2'
      }
    case 'gcp':
      return {
        provider: 'gcp',
        prefix: spec.infrastructure.gcp?.secretsProject || spec.infrastructure.gcp?.project || 'default-project',
        gcpProject: spec.infrastructure.gcp?.project
      }
    case 'local':
    default:
      return {
        provider: spec.infrastructure.local?.useK8sSecrets === false ? 'aws' : 'kubernetes',
        prefix: 'scroll'
      }
  }
}

/**
 * Generate external secrets block based on provider
 */
function generateExternalSecrets(
  secretName: string,
  secretConfig: SecretProviderConfig,
  secretData: Array<{ remoteKey: string; property: string; secretKey: string }>
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
        provider: 'aws',
        data,
        refreshInterval: '2m',
        serviceAccount: 'external-secrets',
        ...(secretConfig.awsRegion && { secretRegion: secretConfig.awsRegion })
      }
    }
  }

  if (secretConfig.provider === 'gcp') {
    return {
      [secretName]: {
        provider: 'gcpsm', // GCP Secret Manager provider name for external-secrets
        data,
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
  defaults: { repository: string; tag: string; pullPolicy?: 'Always' | 'IfNotPresent' | 'Never' }
): { repository: string; tag: string; pullPolicy: 'Always' | 'IfNotPresent' | 'Never' } {
  const imagesConfig = spec.images
  const serviceConfig = imagesConfig?.services?.[serviceKey]
  const defaultPullPolicy = imagesConfig?.defaults?.pullPolicy || defaults.pullPolicy || 'IfNotPresent'

  return {
    repository: serviceConfig?.repository || defaults.repository,
    tag: serviceConfig?.tag || defaults.tag,
    pullPolicy: serviceConfig?.pullPolicy || defaultPullPolicy
  }
}

/**
 * Generate all Helm values files from a DeploymentSpec
 */
export function generateValuesFiles(spec: DeploymentSpec): GeneratedValuesFiles {
  const files: GeneratedValuesFiles = {}

  // Core L2 infrastructure
  files['l2-sequencer-production.yaml'] = generateL2SequencerValues(spec)
  files['l2-bootnode-production.yaml'] = generateL2BootnodeValues(spec)
  files['l2-rpc-production.yaml'] = generateL2RpcValues(spec)

  // L1 interface
  files['l1-interface-production.yaml'] = generateL1InterfaceValues(spec)

  // DA and Dogecoin
  files['celestia-node-production.yaml'] = generateCelestiaNodeValues(spec)
  files['dogecoin-production.yaml'] = generateDogecoinValues(spec)
  files['da-publisher-production.yaml'] = generateDaPublisherValues(spec)

  // Bridge and signing
  files['tso-service-production.yaml'] = generateTsoServiceValues(spec)
  files['withdrawal-processor-production.yaml'] = generateWithdrawalProcessorValues(spec)

  // Generate cubesigner values if using cubesigner
  if (spec.signing.method === 'cubesigner') {
    files['cubesigner-signer-production.yaml'] = generateCubesignerValues(spec)
  }

  // Rollup services
  files['rollup-relayer-production.yaml'] = generateRollupRelayerValues(spec)
  files['coordinator-api-production.yaml'] = generateCoordinatorApiValues(spec)
  files['coordinator-cron-production.yaml'] = generateCoordinatorCronValues(spec)
  files['gas-oracle-production.yaml'] = generateGasOracleValues(spec)
  files['fee-oracle-production.yaml'] = generateFeeOracleValues(spec)
  files['chain-monitor-production.yaml'] = generateChainMonitorValues(spec)

  // Frontend and explorers
  files['frontends-production.yaml'] = generateFrontendsValues(spec)
  files['frontends-config.yaml'] = generateFrontendsConfigValues(spec)
  files['blockscout-production.yaml'] = generateBlockscoutValues(spec)
  files['rollup-explorer-backend-production.yaml'] = generateRollupExplorerBackendValues(spec)
  files['bridge-history-api-production.yaml'] = generateBridgeHistoryApiValues(spec)
  files['bridge-history-fetcher-production.yaml'] = generateBridgeHistoryFetcherValues(spec)

  // Admin and monitoring
  files['admin-system-backend-production.yaml'] = generateAdminSystemBackendValues(spec)
  files['admin-system-cron-production.yaml'] = generateAdminSystemCronValues(spec)
  files['admin-system-dashboard-production.yaml'] = generateAdminSystemDashboardValues(spec)

  // Contracts deployment
  files['contracts-production.yaml'] = generateContractsValues(spec)

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
    repository: 'scrolltech/l2geth',
    tag: 'scroll-v5.9.6',
    pullPolicy: 'IfNotPresent'
  })

  const values: Record<string, any> = {
    image,
    global: {
      fullnameOverride: 'l2-sequencer-__INSTANCE_INDEX__'
    },
    resources: {
      requests: { memory: '150Mi', cpu: '50m' },
      limits: { memory: '8Gi', cpu: '4' }
    },
    envFrom: [
      { configMapRef: { name: 'l2-sequencer-__INSTANCE_INDEX__-env' } },
      { secretRef: { name: 'l2-sequencer-__INSTANCE_INDEX__-secret-env' } }
    ],
    initContainers: {
      'wait-for-l1': {
        image: 'scrolltech/scroll-alpine:v0.0.1',
        command: ['/bin/sh', '-c', '/wait-for-l1.sh $L2GETH_L1_ENDPOINT'],
        envFrom: [{ configMapRef: { name: 'l2-sequencer-__INSTANCE_INDEX__-env' } }],
        volumeMounts: [{
          name: 'wait-for-l1-script',
          mountPath: '/wait-for-l1.sh',
          subPath: 'wait-for-l1.sh'
        }]
      }
    },
    configMaps: {
      env: {
        enabled: true,
        data: {
          CHAIN_ID: String(spec.network.l2ChainId),
          L2GETH_L1_ENDPOINT: spec.network.l1RpcEndpoint,
          L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK: String(spec.contracts.l1DeploymentBlock || 0),
          L2GETH_SIGNER_ADDRESS: getSignerAddress(),
          L2GETH_PEER_LIST: JSON.stringify(peerList.length > 0 ? peerList : [])
        }
      }
    },
    persistence: {
      env: {
        enabled: true,
        type: 'configMap',
        name: 'l2-sequencer-__INSTANCE_INDEX__-env'
      },
      data: {
        size: '1000Gi',
        retain: true
      }
    }
  }

  // Add external secrets if not using k8s secrets directly
  const externalSecrets = generateExternalSecrets(
    'l2-sequencer-__INSTANCE_INDEX__-secret-env',
    secretConfig,
    [
      { remoteKey: 'l2-sequencer-__INSTANCE_INDEX__-secret-env', property: 'L2GETH_KEYSTORE', secretKey: 'L2GETH_KEYSTORE' },
      { remoteKey: 'l2-sequencer-__INSTANCE_INDEX__-secret-env', property: 'L2GETH_PASSWORD', secretKey: 'L2GETH_PASSWORD' },
      { remoteKey: 'l2-sequencer-__INSTANCE_INDEX__-secret-env', property: 'L2GETH_NODEKEY', secretKey: 'L2GETH_NODEKEY' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  // Add sequencer instance metadata as comments for reference
  if (spec.infrastructure.sequencers && spec.infrastructure.sequencers.length > 0) {
    values._sequencerInstances = spec.infrastructure.sequencers.map(s => ({
      index: s.index,
      signerAddress: s.signerAddress,
      enodeUrl: s.enodeUrl || 'generated-during-deployment'
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
    repository: 'scrolltech/l2geth',
    tag: 'scroll-v5.9.6',
    pullPolicy: 'IfNotPresent'
  })

  const values: Record<string, any> = {
    image,
    global: {
      fullnameOverride: 'l2-bootnode-__INSTANCE_INDEX__'
    },
    envFrom: [
      { configMapRef: { name: 'l2-bootnode-__INSTANCE_INDEX__-env' } },
      { secretRef: { name: 'l2-bootnode-__INSTANCE_INDEX__-secret-env' } }
    ],
    initContainers: {
      'wait-for-l1': {
        image: 'scrolltech/scroll-alpine:v0.0.1',
        command: ['/bin/sh', '-c', '/wait-for-l1.sh $L2GETH_L1_ENDPOINT'],
        envFrom: [{ configMapRef: { name: 'l2-bootnode-__INSTANCE_INDEX__-env' } }],
        volumeMounts: [{
          name: 'wait-for-l1-script',
          mountPath: '/wait-for-l1.sh',
          subPath: 'wait-for-l1.sh'
        }]
      }
    },
    persistence: {
      env: {
        enabled: true,
        type: 'configMap',
        mountPath: '/config/',
        name: 'l2-bootnode-__INSTANCE_INDEX__-env'
      },
      data: {
        size: '1000Gi',
        retain: true
      }
    },
    configMaps: {
      env: {
        enabled: true,
        data: {
          CHAIN_ID: String(spec.network.l2ChainId),
          L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK: String(spec.contracts.l1DeploymentBlock || 0),
          L2GETH_L1_ENDPOINT: spec.network.l1RpcEndpoint,
          L2GETH_DA_BLOB_BEACON_NODE: spec.network.beaconRpcEndpoint || '',
          L2GETH_PEER_LIST: JSON.stringify(peerList.length > 0 ? peerList : [])
        }
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
      { remoteKey: 'l2-bootnode-__INSTANCE_INDEX__', property: 'L2GETH_NODEKEY', secretKey: 'L2GETH_NODEKEY' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  // Add bootnode instance metadata for reference
  if (spec.infrastructure.bootnodes && spec.infrastructure.bootnodes.length > 0) {
    values._bootnodeInstances = spec.infrastructure.bootnodes.map(b => ({
      index: b.index,
      enodeUrl: b.enodeUrl || 'generated-during-deployment',
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
    repository: 'scrolltech/l2geth',
    tag: 'scroll-v5.9.6',
    pullPolicy: 'IfNotPresent'
  })

  const values = {
    image,
    global: {
      fullnameOverride: 'l2-rpc'
    },
    envFrom: [
      { configMapRef: { name: 'l2-rpc-env' } }
    ],
    configMaps: {
      env: {
        enabled: true,
        data: {
          CHAIN_ID: String(spec.network.l2ChainId),
          L2GETH_L1_ENDPOINT: spec.network.l1RpcEndpoint,
          L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK: String(spec.contracts.l1DeploymentBlock || 0),
          L2GETH_DA_BLOB_BEACON_NODE: spec.network.beaconRpcEndpoint || '',
          L2GETH_PEER_LIST: JSON.stringify(peerList.length > 0 ? peerList : [])
        }
      }
    },
    persistence: {
      data: {
        size: '1000Gi',
        retain: true
      }
    },
    ingress: {
      main: {
        ingressClassName: 'nginx',
        hosts: [{
          host: spec.frontend.hosts.rpcGateway,
          paths: [{ path: '/', pathType: 'Prefix' }]
        }],
        tls: [{
          secretName: 'l2-rpc-tls',
          hosts: [spec.frontend.hosts.rpcGateway]
        }]
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

  const image = resolveImage(spec, 'l1Interface', {
    repository: 'dogeos69/l1-interface',
    tag: '0.2.0-rc.4',
    pullPolicy: 'Always'
  })

  const values: Record<string, any> = {
    image,
    env: [
      { name: 'L1_INTERFACE_DOGECOIN_RPC', value: 'http://dogecoin:22555' },
      { name: 'L1_INTERFACE_DOGECOIN_RPC_USER', value: spec.dogecoin.rpc.username },
      { name: 'L1_INTERFACE_DOGECOIN_RPC_PASS', valueFrom: { secretKeyRef: { name: 'l1-interface-secret-env', key: 'L1_INTERFACE_DOGECOIN_RPC_PASS' } } },
      { name: 'L1_INTERFACE_CELESTIA_DA_RPC', value: 'http://celestia-node:26658' },
      { name: 'L1_INTERFACE_CELESTIA_AUTH_TOKEN', valueFrom: { secretKeyRef: { name: 'l1-interface-secret-env', key: 'L1_INTERFACE_CELESTIA_AUTH_TOKEN' } } },
      { name: 'L1_INTERFACE_CELESTIA_NAMESPACE', value: spec.celestia.namespace },
      { name: 'L1_INTERFACE_CHAIN_ID', value: String(spec.network.l1ChainId) },
      { name: 'L1_INTERFACE_PORT', value: '8545' },
      { name: 'RUST_LOG', value: 'info' }
    ],
    resources: {
      requests: { memory: '256Mi', cpu: '100m' },
      limits: { memory: '1Gi', cpu: '1000m' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'l1-interface-secret-env',
    secretConfig,
    [
      { remoteKey: 'l1-interface-secret-env', property: 'L1_INTERFACE_DOGECOIN_RPC_PASS', secretKey: 'L1_INTERFACE_DOGECOIN_RPC_PASS' },
      { remoteKey: 'l1-interface-secret-env', property: 'L1_INTERFACE_CELESTIA_AUTH_TOKEN', secretKey: 'L1_INTERFACE_CELESTIA_AUTH_TOKEN' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate Celestia Node values
 */
function generateCelestiaNodeValues(spec: DeploymentSpec): string {
  const values = {
    image: {
      repository: 'ghcr.io/celestiaorg/celestia-node',
      pullPolicy: 'IfNotPresent',
      tag: 'v0.15.0'
    },
    env: [
      { name: 'CELESTIA_NETWORK', value: spec.dogecoin.network === 'mainnet' ? 'celestia' : 'mocha' },
      { name: 'CELESTIA_NODE_TYPE', value: 'light' }
    ],
    persistence: {
      data: {
        size: '100Gi',
        retain: true
      }
    },
    resources: {
      requests: { memory: '2Gi', cpu: '500m' },
      limits: { memory: '8Gi', cpu: '2000m' }
    }
  }

  return yaml.dump(values)
}

/**
 * Generate Dogecoin node values
 */
function generateDogecoinValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const values: Record<string, any> = {
    image: {
      repository: 'dogeos69/dogecoin',
      pullPolicy: 'IfNotPresent',
      tag: '1.14.7-alpine'
    },
    env: [
      { name: 'DOGE_NETWORK', value: spec.dogecoin.network },
      { name: 'DOGE_RPC_USER', value: spec.dogecoin.rpc.username },
      { name: 'DOGE_RPC_PASSWORD', valueFrom: { secretKeyRef: { name: 'dogecoin-secret-env', key: 'DOGE_RPC_PASSWORD' } } },
      { name: 'DOGE_TXINDEX', value: '1' },
      { name: 'DOGE_RPC_ALLOW_IP', value: '0.0.0.0/0' }
    ],
    persistence: {
      data: {
        size: '500Gi',
        retain: true
      }
    },
    resources: {
      requests: { memory: '4Gi', cpu: '1000m' },
      limits: { memory: '16Gi', cpu: '4000m' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'dogecoin-secret-env',
    secretConfig,
    [
      { remoteKey: 'dogecoin-secret-env', property: 'DOGE_RPC_PASSWORD', secretKey: 'DOGE_RPC_PASSWORD' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate DA Publisher values
 */
function generateDaPublisherValues(spec: DeploymentSpec): string {
  const image = resolveImage(spec, 'daPublisher', {
    repository: 'scrolltech/da-codec',
    tag: 'da-codec-v0.0.8',
    pullPolicy: 'IfNotPresent'
  })

  const values = {
    image,
    env: [
      { name: 'DA_CODEC_HTTP_PORT', value: '8545' },
      { name: 'DA_CODEC_L2_RPC_URL', value: spec.network.l2RpcEndpoint },
      { name: 'DA_CODEC_SCROLL_CHAIN_URL', value: spec.network.l1RpcEndpoint }
    ],
    resources: {
      requests: { memory: '256Mi', cpu: '100m' },
      limits: { memory: '2Gi', cpu: '1000m' }
    }
  }

  return yaml.dump(values)
}

/**
 * Generate TSO Service values
 */
function generateTsoServiceValues(spec: DeploymentSpec): string {
  const image = resolveImage(spec, 'tsoService', {
    repository: 'dogeos69/tso-service',
    tag: '0.2.0-rc.4',
    pullPolicy: 'Always'
  })

  const values = {
    image,
    env: [
      { name: 'PORT', value: '3000' },
      { name: 'DOGE_NETWORK', value: spec.dogecoin.network },
      { name: 'WITHDRAWAL_PROCESSOR_URL', value: 'http://withdrawal-processor:3000' },
      { name: 'RUST_LOG', value: 'debug' }
    ],
    ingress: {
      main: {
        ingressClassName: 'nginx',
        hosts: [{
          host: spec.frontend.hosts.tso || '',
          paths: [{ path: '/', pathType: 'Prefix' }]
        }],
        tls: spec.frontend.hosts.tso ? [{
          secretName: 'tso-tls',
          hosts: [spec.frontend.hosts.tso]
        }] : []
      }
    },
    resources: {
      requests: { memory: '256Mi', cpu: '200m' },
      limits: { memory: '1Gi', cpu: '1000m' }
    },
    serviceMonitor: {
      main: { enabled: true }
    },
    defaultProbes: { enabled: false }
  }

  return yaml.dump(values)
}

/**
 * Generate Withdrawal Processor values
 */
function generateWithdrawalProcessorValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const image = resolveImage(spec, 'withdrawalProcessor', {
    repository: 'dogeos69/withdrawal-processor',
    tag: '0.2.0-rc.4',
    pullPolicy: 'Always'
  })

  const values: Record<string, any> = {
    image,
    env: [
      { name: 'DOGEOS_WITHDRAWAL_NETWORK_STR', value: spec.dogecoin.network },
      { name: 'DOGEOS_WITHDRAWAL_DATABASE_URL', valueFrom: { secretKeyRef: { name: 'withdrawal-processor-secret-env', key: 'DOGEOS_WITHDRAWAL_DATABASE_URL' } } },
      { name: 'DOGEOS_WITHDRAWAL_API_PORT', value: '3000' },
      { name: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_URL', value: 'http://dogecoin:22555' },
      { name: 'DOGEOS_WITHDRAWAL_TSO_URL', value: 'http://tso-service:3000' },
      { name: 'DOGEOS_WITHDRAWAL_BRIDGE_ADDRESS', value: '' },
      { name: 'DOGEOS_WITHDRAWAL_BRIDGE_SCRIPT_HEX', value: '' },
      { name: 'DOGEOS_WITHDRAWAL_MAX_WITHDRAWAL_OUTPUTS_PER_TX', value: '1024' },
      { name: 'DOGEOS_WITHDRAWAL_FEE_RATE_SAT_PER_KVB', value: String(spec.bridge.feeRateSatPerKvb) },
      { name: 'DOGEOS_WITHDRAWAL_COORDINATOR_POLL_INTERVAL_SECS', value: '10' },
      { name: 'DOGEOS_WITHDRAWAL_DEBUG_SKIP_BROADCAST', value: 'false' },
      // Dogecoin Indexer
      { name: 'DOGEOS_WITHDRAWAL_DOGECOIN_INDEXER__START_HEIGHT', value: String(spec.dogecoin.indexerStartHeight) },
      { name: 'DOGEOS_WITHDRAWAL_DOGECOIN_INDEXER__CONFIRMATIONS', value: String(spec.bridge.confirmationsRequired) },
      { name: 'DOGEOS_WITHDRAWAL_DOGECOIN_INDEXER__POLL_INTERVAL_MS', value: '60000' },
      // DogeOS Indexer
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__RPC_URL', value: spec.network.l2RpcEndpoint },
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__START_BLOCK', value: '0' },
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__CONFIRMATIONS', value: '12' },
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__POLL_INTERVAL_MS', value: '60000' },
      { name: 'DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__LOG_QUERY_BATCH_SIZE', value: '10000' },
      // Celestia Indexer
      { name: 'DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__DA_RPC_URL', value: spec.network.beaconRpcEndpoint || '' },
      { name: 'DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__DA_NAMESPACE', value: spec.celestia.namespace },
      { name: 'DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__START_BLOCK', value: String(spec.celestia.indexerStartBlock) },
      { name: 'DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__CONFIRMATIONS', value: '6' },
      { name: 'DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__POLL_INTERVAL_MS', value: '60000' },
      { name: 'DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__SIGNER_ADDRESS', value: spec.celestia.signerAddress },
      { name: 'DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__FETCH_AND_DECODE_BLOBS', value: 'true' },
      { name: 'RUST_LOG', value: 'info,withdrawal_processor=info' }
    ],
    envFrom: [
      { secretRef: { name: 'withdrawal-processor-secret-env' } }
    ],
    resources: {
      requests: { memory: '512Mi', cpu: '200m' },
      limits: { memory: '2Gi', cpu: '1000m' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'withdrawal-processor-secret-env',
    secretConfig,
    [
      { remoteKey: 'withdrawal-processor-secret-env', property: 'DOGEOS_WITHDRAWAL_DATABASE_URL', secretKey: 'DOGEOS_WITHDRAWAL_DATABASE_URL' },
      { remoteKey: 'withdrawal-processor-secret-env', property: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_USER', secretKey: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_USER' },
      { remoteKey: 'withdrawal-processor-secret-env', property: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_PASS', secretKey: 'DOGEOS_WITHDRAWAL_DOGECOIN_RPC_PASS' }
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
    repository: 'dogeos69/cubesigner-signer',
    tag: '0.2.0-rc.4',
    pullPolicy: 'IfNotPresent'
  })

  const values: Record<string, any> = {
    image,
    global: {
      fullnameOverride: 'cubesigner-signer-__INSTANCE_INDEX__'
    },
    env: [
      { name: 'DOGEOS_CUBESIGNER_SIGNER_PORT', value: '3000' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_NETWORK', value: spec.dogecoin.network },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_TSO_URL', value: 'http://tso-service:3000' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_SIGNATURE_DELAY', value: '0' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_POLL_INTERVAL', value: '5000' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', valueFrom: { secretKeyRef: { name: 'cubesigner-signer-__INSTANCE_INDEX__-env', key: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID' } } },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_CS_SESSION_PATH', value: '/etc/cubesigner/session.json' },
      { name: 'DOGEOS_CUBESIGNER_SIGNER_BODY_LIMIT', value: '5mb' }
    ],
    persistence: {
      session: {
        name: 'cubesigner-signer-__INSTANCE_INDEX__-session',
        enabled: true,
        type: 'secret',
        secretName: 'cubesigner-signer-__INSTANCE_INDEX__-session',
        mountPath: '/etc/cubesigner',
        readOnly: true
      }
    },
    volumeClaimTemplates: [{
      name: 'session-cache-__INSTANCE_INDEX__',
      accessMode: 'ReadWriteOnce',
      size: '1Gi',
      mountPath: '/app/.sessions'
    }],
    resources: {
      requests: { memory: '128Mi', cpu: '50m' },
      limits: { memory: '512Mi', cpu: '1000m' }
    },
    serviceMonitor: {
      main: { enabled: false }
    }
  }

  // Generate external secrets for both env and session
  const envSecrets = generateExternalSecrets(
    'cubesigner-signer-__INSTANCE_INDEX__-env',
    secretConfig,
    [
      { remoteKey: 'cubesigner-signer-__INSTANCE_INDEX__-env', property: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', secretKey: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID' }
    ]
  )

  const sessionSecrets = generateExternalSecrets(
    'cubesigner-signer-__INSTANCE_INDEX__-session',
    secretConfig,
    [
      { remoteKey: 'cubesigner-signer-__INSTANCE_INDEX__-session', property: 'session.json', secretKey: 'session.json' }
    ]
  )

  if (envSecrets || sessionSecrets) {
    values.externalSecrets = {
      ...(envSecrets || {}),
      ...(sessionSecrets || {})
    }
  }

  return yaml.dump(values)
}

/**
 * Generate Rollup Relayer values
 */
function generateRollupRelayerValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const image = resolveImage(spec, 'rollupRelayer', {
    repository: 'scrolltech/rollup-relayer',
    tag: 'v4.4.83',
    pullPolicy: 'IfNotPresent'
  })

  const values: Record<string, any> = {
    image,
    envFrom: [
      { configMapRef: { name: 'rollup-relayer-env' } },
      { secretRef: { name: 'rollup-relayer-secret-env' } }
    ],
    configMaps: {
      env: {
        enabled: true,
        data: {
          SCROLL_ROLLUP_L1_RPC_URL: spec.network.l1RpcEndpoint,
          SCROLL_ROLLUP_L2_RPC_URL: spec.network.l2RpcEndpoint,
          SCROLL_ROLLUP_BUNDLE_COLLECTION_TIME_SEC: String(spec.rollup.coordinator.bundleCollectionTimeSec),
          SCROLL_ROLLUP_BATCH_COLLECTION_TIME_SEC: String(spec.rollup.coordinator.batchCollectionTimeSec),
          SCROLL_ROLLUP_CHUNK_COLLECTION_TIME_SEC: String(spec.rollup.coordinator.chunkCollectionTimeSec)
        }
      }
    },
    resources: {
      requests: { memory: '512Mi', cpu: '100m' },
      limits: { memory: '4Gi', cpu: '1000m' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'rollup-relayer-secret-env',
    secretConfig,
    [
      { remoteKey: 'rollup-relayer-secret-env', property: 'SCROLL_ROLLUP_DB_DSN', secretKey: 'SCROLL_ROLLUP_DB_DSN' },
      { remoteKey: 'rollup-relayer-secret-env', property: 'SCROLL_ROLLUP_L1_COMMIT_SENDER_PRIVATE_KEY', secretKey: 'SCROLL_ROLLUP_L1_COMMIT_SENDER_PRIVATE_KEY' },
      { remoteKey: 'rollup-relayer-secret-env', property: 'SCROLL_ROLLUP_L1_FINALIZE_SENDER_PRIVATE_KEY', secretKey: 'SCROLL_ROLLUP_L1_FINALIZE_SENDER_PRIVATE_KEY' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}

/**
 * Generate Coordinator API values
 */
function generateCoordinatorApiValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const image = resolveImage(spec, 'coordinator', {
    repository: 'scrolltech/coordinator-api',
    tag: 'v4.4.83',
    pullPolicy: 'IfNotPresent'
  })

  const values: Record<string, any> = {
    image,
    resources: {
      requests: { memory: '2Gi', cpu: '50m' },
      limits: { memory: '24Gi', cpu: '200m' }
    },
    controller: {
      replicas: 2
    },
    envFrom: [
      { secretRef: { name: 'coordinator-api-secret-env' } }
    ],
    ingress: {
      main: {
        ingressClassName: 'nginx',
        hosts: [{
          host: spec.frontend.hosts.coordinatorApi,
          paths: [{ path: '/', pathType: 'Prefix' }]
        }]
      }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'coordinator-api-secret-env',
    secretConfig,
    [
      { remoteKey: 'coordinator-api-secret-env', property: 'SCROLL_COORDINATOR_DB_DSN', secretKey: 'SCROLL_COORDINATOR_DB_DSN' },
      { remoteKey: 'coordinator-api-secret-env', property: 'SCROLL_COORDINATOR_AUTH_SECRET', secretKey: 'SCROLL_COORDINATOR_AUTH_SECRET' }
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
      requests: { memory: '256Mi', cpu: '50m' },
      limits: { memory: '2Gi', cpu: '500m' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'coordinator-cron-secret-env',
    secretConfig,
    [
      { remoteKey: 'coordinator-cron-secret-env', property: 'SCROLL_COORDINATOR_DB_DSN', secretKey: 'SCROLL_COORDINATOR_DB_DSN' },
      { remoteKey: 'coordinator-cron-secret-env', property: 'SCROLL_COORDINATOR_AUTH_SECRET', secretKey: 'SCROLL_COORDINATOR_AUTH_SECRET' }
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
    repository: 'scrolltech/gas-oracle',
    tag: 'gas-oracle-v4.4.83',
    pullPolicy: 'IfNotPresent'
  })

  const values: Record<string, any> = {
    image,
    envFrom: [
      { configMapRef: { name: 'gas-oracle-env' } },
      { secretRef: { name: 'gas-oracle-secret-env' } }
    ],
    configMaps: {
      env: {
        enabled: true,
        data: {
          SCROLL_GAS_ORACLE_L1_RPC_URL: spec.network.l1RpcEndpoint,
          SCROLL_GAS_ORACLE_L2_RPC_URL: spec.network.l2RpcEndpoint,
          SCROLL_GAS_ORACLE_BLOB_SCALAR: String(spec.contracts.gasOracle.blobScalar),
          SCROLL_GAS_ORACLE_SCALAR: String(spec.contracts.gasOracle.scalar)
        }
      }
    },
    resources: {
      requests: { memory: '256Mi', cpu: '50m' },
      limits: { memory: '2Gi', cpu: '500m' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'gas-oracle-secret-env',
    secretConfig,
    [
      { remoteKey: 'gas-oracle-secret-env', property: 'SCROLL_GAS_ORACLE_DB_DSN', secretKey: 'SCROLL_GAS_ORACLE_DB_DSN' },
      { remoteKey: 'gas-oracle-secret-env', property: 'SCROLL_GAS_ORACLE_L1_SENDER_PRIVATE_KEY', secretKey: 'SCROLL_GAS_ORACLE_L1_SENDER_PRIVATE_KEY' },
      { remoteKey: 'gas-oracle-secret-env', property: 'SCROLL_GAS_ORACLE_L2_SENDER_PRIVATE_KEY', secretKey: 'SCROLL_GAS_ORACLE_L2_SENDER_PRIVATE_KEY' }
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
    repository: 'dogeos69/fee-oracle',
    tag: '0.2.0-rc.4',
    pullPolicy: 'Always'
  })

  const values = {
    image,
    env: [
      { name: 'FEE_ORACLE_PORT', value: '3000' },
      { name: 'FEE_ORACLE_L2_RPC_URL', value: spec.network.l2RpcEndpoint },
      { name: 'FEE_ORACLE_DOGE_RPC_URL', value: 'http://dogecoin:22555' },
      { name: 'FEE_ORACLE_UPDATE_INTERVAL_SECS', value: '60' }
    ],
    resources: {
      requests: { memory: '128Mi', cpu: '50m' },
      limits: { memory: '512Mi', cpu: '500m' }
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
    repository: 'scrolltech/chain-monitor',
    tag: 'chain-monitor-v4.4.83',
    pullPolicy: 'IfNotPresent'
  })

  const values: Record<string, any> = {
    image,
    envFrom: [
      { configMapRef: { name: 'chain-monitor-env' } },
      { secretRef: { name: 'chain-monitor-secret-env' } }
    ],
    configMaps: {
      env: {
        enabled: true,
        data: {
          SCROLL_CHAIN_MONITOR_L1_RPC_URL: spec.network.l1RpcEndpoint,
          SCROLL_CHAIN_MONITOR_L2_RPC_URL: spec.network.l2RpcEndpoint
        }
      }
    },
    resources: {
      requests: { memory: '256Mi', cpu: '50m' },
      limits: { memory: '2Gi', cpu: '500m' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'chain-monitor-secret-env',
    secretConfig,
    [
      { remoteKey: 'chain-monitor-secret-env', property: 'SCROLL_CHAIN_MONITOR_DB_DSN', secretKey: 'SCROLL_CHAIN_MONITOR_DB_DSN' }
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
    repository: 'dogeos69/scroll-sdk-frontends',
    tag: '3.0.2-beta.1',
    pullPolicy: 'Always'
  })

  const values = {
    image,
    persistence: {
      frontends: {
        enabled: true,
        type: 'configMap',
        mountPath: '/app/conf/',
        name: 'frontends-config'
      }
    },
    command: [
      '/bin/bash',
      '-cx',
      `grep -v '^#' /app/conf/frontend-config | awk -F' = ' 'NF==2 {printf "export %s=\\"%s\\"\\n", $1, $2}' | sed 's/""/"/g' > /usr/share/nginx/html/.env
cat /usr/share/nginx/html/.env
source /usr/share/nginx/html/.env
sed -i "s|src=\\"/runtime-env.js\\"|src=\\"/runtime-env.js?rand=$RANDOM\\"|" index.html
exec /usr/local/bin/entrypoint.sh`
    ],
    ingress: {
      main: {
        ingressClassName: 'nginx',
        hosts: [{
          host: spec.frontend.hosts.frontend,
          paths: [{ path: '/', pathType: 'Prefix' }]
        }],
        tls: [{
          secretName: 'frontends-tls',
          hosts: [spec.frontend.hosts.frontend]
        }]
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
        enabled: true,
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
        }
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
          ETHEREUM_JSONRPC_HTTP_URL: 'http://l2-rpc:8545',
          ETHEREUM_JSONRPC_TRACE_URL: 'http://l2-rpc:8545',
          ETHEREUM_JSONRPC_VARIANT: 'geth',
          ETHEREUM_JSONRPC_WS_URL: 'ws://l2-rpc:8546',
          INDEXER_DISABLE_PENDING_TRANSACTIONS_FETCHER: true,
          CHAIN_TYPE: 'scroll',
          COIN: spec.network.tokenSymbol,
          COIN_NAME: spec.network.tokenSymbol,
          INDEXER_SCROLL_L1_CHAIN_CONTRACT: '',
          INDEXER_SCROLL_L1_BATCH_START_BLOCK: String(spec.contracts.l1DeploymentBlock || 0),
          INDEXER_SCROLL_L1_MESSENGER_CONTRACT: '',
          INDEXER_SCROLL_L1_MESSENGER_START_BLOCK: String(spec.contracts.l1DeploymentBlock || 0),
          INDEXER_SCROLL_L2_MESSENGER_CONTRACT: '',
          INDEXER_SCROLL_L2_GAS_ORACLE_CONTRACT: '',
          INDEXER_SCROLL_L1_RPC: spec.network.l1RpcEndpoint,
          INDEXER_SCROLL_L2_MESSENGER_START_BLOCK: 0,
          INDEXER_SCROLL_L1_ETH_GET_LOGS_RANGE_SIZE: 500,
          INDEXER_SCROLL_L2_ETH_GET_LOGS_RANGE_SIZE: 500,
          SCROLL_L2_CURIE_UPGRADE_BLOCK: 0,
          ECTO_USE_SSL: true,
          ETHEREUM_JSONRPC_HTTP_INSECURE: false
        },
        envFrom: [
          { secretRef: { name: 'blockscout-secret-env' } }
        ],
        extraEnv: [
          { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'blockscout-secret-env', key: 'DATABASE_URL' } } }
        ],
        ingress: {
          enabled: true,
          className: 'nginx',
          annotations: {
            'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
            'nginx.ingress.kubernetes.io/enable-cors': 'true',
            'nginx.ingress.kubernetes.io/cors-allow-origin': `https://${spec.frontend.hosts.blockscout}`,
            'nginx.ingress.kubernetes.io/cors-allow-headers': 'updated-gas-oracle, Content-Type, Authorization',
            'nginx.ingress.kubernetes.io/cors-allow-methods': 'GET, POST, OPTIONS',
            'nginx.ingress.kubernetes.io/cors-max-age': '86400'
          },
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
          NEXT_PUBLIC_API_PROTOCOL: 'https',
          NEXT_PUBLIC_API_WEBSOCKET_PROTOCOL: 'wss',
          NEXT_PUBLIC_API_HOST: spec.frontend.hosts.blockscout,
          NEXT_PUBLIC_APP_PROTOCOL: 'https',
          NEXT_PUBLIC_NETWORK_ID: String(spec.network.l2ChainId),
          NEXT_PUBLIC_NETWORK_NAME: spec.network.l2ChainName,
          NEXT_PUBLIC_NETWORK_SHORT_NAME: 'DogeOS',
          NEXT_PUBLIC_NETWORK_CURRENCY_NAME: 'Dogecoin',
          NEXT_PUBLIC_NETWORK_CURRENCY_SYMBOL: spec.network.tokenSymbol,
          NEXT_PUBLIC_NETWORK_CURRENCY_DECIMALS: '18',
          PROMETHEUS_METRICS_ENABLED: 'false',
          NEXT_PUBLIC_AD_BANNER_PROVIDER: 'none',
          NEXT_PUBLIC_AD_TEXT_PROVIDER: 'none'
        },
        ingress: {
          enabled: true,
          className: 'nginx',
          annotations: {
            'cert-manager.io/cluster-issuer': 'letsencrypt-prod'
          },
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
      { remoteKey: 'blockscout-secret-env', property: 'DATABASE_URL', secretKey: 'DATABASE_URL' }
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
    repository: 'scrolltech/rollup-explorer-backend',
    tag: 'rollup-explorer-backend-v4.4.83',
    pullPolicy: 'IfNotPresent'
  })

  const values: Record<string, any> = {
    image,
    envFrom: [
      { secretRef: { name: 'rollup-explorer-backend-secret-env' } }
    ],
    ingress: {
      main: {
        ingressClassName: 'nginx',
        hosts: [{
          host: spec.frontend.hosts.rollupExplorerApi,
          paths: [{ path: '/', pathType: 'Prefix' }]
        }]
      }
    },
    resources: {
      requests: { memory: '256Mi', cpu: '50m' },
      limits: { memory: '2Gi', cpu: '500m' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'rollup-explorer-backend-secret-env',
    secretConfig,
    [
      { remoteKey: 'rollup-explorer-backend-secret-env', property: 'SCROLL_ROLLUP_EXPLORER_DB_DSN', secretKey: 'SCROLL_ROLLUP_EXPLORER_DB_DSN' }
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
    repository: 'scrolltech/bridge-history-api',
    tag: 'bridge-history-api-v4.4.83',
    pullPolicy: 'IfNotPresent'
  })

  const values: Record<string, any> = {
    image,
    envFrom: [
      { secretRef: { name: 'bridge-history-api-secret-env' } }
    ],
    ingress: {
      main: {
        ingressClassName: 'nginx',
        hosts: [{
          host: spec.frontend.hosts.bridgeHistoryApi,
          paths: [{ path: '/', pathType: 'Prefix' }]
        }]
      }
    },
    resources: {
      requests: { memory: '256Mi', cpu: '50m' },
      limits: { memory: '2Gi', cpu: '500m' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'bridge-history-api-secret-env',
    secretConfig,
    [
      { remoteKey: 'bridge-history-api-secret-env', property: 'SCROLL_BRIDGE_HISTORY_DB_DSN', secretKey: 'SCROLL_BRIDGE_HISTORY_DB_DSN' }
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
    repository: 'scrolltech/bridge-history-fetcher',
    tag: 'bridge-history-fetcher-v4.4.83',
    pullPolicy: 'IfNotPresent'
  })

  const values: Record<string, any> = {
    image,
    envFrom: [
      { configMapRef: { name: 'bridge-history-fetcher-env' } },
      { secretRef: { name: 'bridge-history-fetcher-secret-env' } }
    ],
    configMaps: {
      env: {
        enabled: true,
        data: {
          SCROLL_BRIDGE_HISTORY_L1_RPC_URL: spec.network.l1RpcEndpoint,
          SCROLL_BRIDGE_HISTORY_L2_RPC_URL: spec.network.l2RpcEndpoint,
          SCROLL_BRIDGE_HISTORY_L1_START_HEIGHT: String(spec.contracts.l1DeploymentBlock || 0)
        }
      }
    },
    resources: {
      requests: { memory: '512Mi', cpu: '100m' },
      limits: { memory: '4Gi', cpu: '1000m' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'bridge-history-fetcher-secret-env',
    secretConfig,
    [
      { remoteKey: 'bridge-history-fetcher-secret-env', property: 'SCROLL_BRIDGE_HISTORY_DB_DSN', secretKey: 'SCROLL_BRIDGE_HISTORY_DB_DSN' }
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
    image: {
      repository: 'scrolltech/admin-system-backend',
      pullPolicy: 'IfNotPresent',
      tag: 'admin-system-backend-v4.4.83'
    },
    envFrom: [
      { configMapRef: { name: 'admin-system-backend-env' } },
      { secretRef: { name: 'admin-system-backend-secret-env' } }
    ],
    configMaps: {
      env: {
        enabled: true,
        data: {
          SCROLL_ADMIN_L1_RPC_URL: spec.network.l1RpcEndpoint,
          SCROLL_ADMIN_L2_RPC_URL: spec.network.l2RpcEndpoint
        }
      }
    },
    resources: {
      requests: { memory: '256Mi', cpu: '50m' },
      limits: { memory: '2Gi', cpu: '500m' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'admin-system-backend-secret-env',
    secretConfig,
    [
      { remoteKey: 'admin-system-backend-secret-env', property: 'SCROLL_ADMIN_DB_DSN', secretKey: 'SCROLL_ADMIN_DB_DSN' }
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
    image: {
      repository: 'scrolltech/admin-system-cron',
      pullPolicy: 'IfNotPresent',
      tag: 'admin-system-cron-v4.4.83'
    },
    envFrom: [
      { secretRef: { name: 'admin-system-cron-secret-env' } }
    ],
    resources: {
      requests: { memory: '128Mi', cpu: '50m' },
      limits: { memory: '1Gi', cpu: '500m' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'admin-system-cron-secret-env',
    secretConfig,
    [
      { remoteKey: 'admin-system-cron-secret-env', property: 'SCROLL_ADMIN_DB_DSN', secretKey: 'SCROLL_ADMIN_DB_DSN' }
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
      repository: 'scrolltech/admin-system-dashboard',
      pullPolicy: 'IfNotPresent',
      tag: 'admin-system-dashboard-v4.4.83'
    },
    ingress: {
      main: {
        ingressClassName: 'nginx',
        hosts: [{
          host: spec.frontend.hosts.adminDashboard,
          paths: [{ path: '/', pathType: 'Prefix' }]
        }],
        tls: [{
          secretName: 'admin-dashboard-tls',
          hosts: [spec.frontend.hosts.adminDashboard]
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
    image: {
      repository: 'scrolltech/scroll-contracts',
      pullPolicy: 'IfNotPresent',
      tag: 'scroll-contracts-v0.1.0'
    },
    envFrom: [
      { configMapRef: { name: 'contracts-env' } },
      { secretRef: { name: 'contracts-secret-env' } }
    ],
    configMaps: {
      env: {
        enabled: true,
        data: {
          SCROLL_L1_RPC: spec.network.l1RpcEndpoint,
          SCROLL_L2_RPC: spec.network.l2RpcEndpoint,
          SCROLL_CHAIN_ID_L1: String(spec.network.l1ChainId),
          SCROLL_CHAIN_ID_L2: String(spec.network.l2ChainId),
          SCROLL_DEPLOYMENT_SALT: spec.contracts.deploymentSalt,
          SCROLL_L1_FEE_VAULT_ADDR: spec.contracts.l1FeeVaultAddr,
          SCROLL_OWNER_ADDR: spec.accounts.owner.address
        }
      }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'contracts-secret-env',
    secretConfig,
    [
      { remoteKey: 'contracts-secret-env', property: 'SCROLL_DEPLOYER_PRIVATE_KEY', secretKey: 'SCROLL_DEPLOYER_PRIVATE_KEY' }
    ]
  )

  if (externalSecrets) {
    values.externalSecrets = externalSecrets
  }

  return yaml.dump(values)
}
