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

import type { DeploymentSpec, ImagesConfig } from '../types/deployment-spec.js'

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
          L2GETH_L1_ENDPOINT: spec.network.l1RpcEndpoint,
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
          L2GETH_DA_BLOB_BEACON_NODE: spec.network.beaconRpcEndpoint || '',
          L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK: String(spec.contracts.l1DeploymentBlock || 0),
          L2GETH_L1_ENDPOINT: spec.network.l1RpcEndpoint,
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
          L2GETH_DA_BLOB_BEACON_NODE: spec.network.beaconRpcEndpoint || '',
          L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK: String(spec.contracts.l1DeploymentBlock || 0),
          L2GETH_L1_ENDPOINT: spec.network.l1RpcEndpoint,
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

  const image = resolveImage(spec, 'l1Interface', {
    pullPolicy: 'Always',
    repository: 'dogeos69/l1-interface',
    tag: '0.2.0-rc.4'
  })

  const values: Record<string, any> = {
    env: [
      { name: 'L1_INTERFACE_DOGECOIN_RPC', value: 'http://dogecoin:22555' },
      { name: 'L1_INTERFACE_DOGECOIN_RPC_USER', value: spec.dogecoin.rpc.username },
      { name: 'L1_INTERFACE_DOGECOIN_RPC_PASS', valueFrom: { secretKeyRef: { key: 'L1_INTERFACE_DOGECOIN_RPC_PASS', name: 'l1-interface-secret-env' } } },
      { name: 'L1_INTERFACE_CELESTIA_DA_RPC', value: 'http://celestia-node:26658' },
      { name: 'L1_INTERFACE_CELESTIA_AUTH_TOKEN', valueFrom: { secretKeyRef: { key: 'L1_INTERFACE_CELESTIA_AUTH_TOKEN', name: 'l1-interface-secret-env' } } },
      { name: 'L1_INTERFACE_CELESTIA_NAMESPACE', value: spec.celestia.namespace },
      { name: 'L1_INTERFACE_CHAIN_ID', value: String(spec.network.l1ChainId) },
      { name: 'L1_INTERFACE_PORT', value: '8545' },
      { name: 'RUST_LOG', value: 'info' }
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
      { property: 'L1_INTERFACE_DOGECOIN_RPC_PASS', remoteKey: 'l1-interface-secret-env', secretKey: 'L1_INTERFACE_DOGECOIN_RPC_PASS' },
      { property: 'L1_INTERFACE_CELESTIA_AUTH_TOKEN', remoteKey: 'l1-interface-secret-env', secretKey: 'L1_INTERFACE_CELESTIA_AUTH_TOKEN' }
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
    env: [
      { name: 'CELESTIA_NETWORK', value: spec.dogecoin.network === 'mainnet' ? 'celestia' : 'mocha' },
      { name: 'CELESTIA_NODE_TYPE', value: 'light' }
    ],
    image: {
      pullPolicy: 'IfNotPresent',
      repository: 'ghcr.io/celestiaorg/celestia-node',
      tag: 'v0.15.0'
    },
    persistence: {
      data: {
        retain: true,
        size: '100Gi'
      }
    },
    resources: {
      limits: { cpu: '2000m', memory: '8Gi' },
      requests: { cpu: '500m', memory: '2Gi' }
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
    env: [
      { name: 'DOGE_NETWORK', value: spec.dogecoin.network },
      { name: 'DOGE_RPC_USER', value: spec.dogecoin.rpc.username },
      { name: 'DOGE_RPC_PASSWORD', valueFrom: { secretKeyRef: { key: 'DOGE_RPC_PASSWORD', name: 'dogecoin-secret-env' } } },
      { name: 'DOGE_TXINDEX', value: '1' },
      { name: 'DOGE_RPC_ALLOW_IP', value: '0.0.0.0/0' }
    ],
    image: {
      pullPolicy: 'IfNotPresent',
      repository: 'dogeos69/dogecoin',
      tag: '1.14.7-alpine'
    },
    persistence: {
      data: {
        retain: true,
        size: '500Gi'
      }
    },
    resources: {
      limits: { cpu: '4000m', memory: '16Gi' },
      requests: { cpu: '1000m', memory: '4Gi' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'dogecoin-secret-env',
    secretConfig,
    [
      { property: 'DOGE_RPC_PASSWORD', remoteKey: 'dogecoin-secret-env', secretKey: 'DOGE_RPC_PASSWORD' }
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
    pullPolicy: 'IfNotPresent',
    repository: 'scrolltech/da-codec',
    tag: 'da-codec-v0.0.8'
  })

  const values = {
    env: [
      { name: 'DA_CODEC_HTTP_PORT', value: '8545' },
      { name: 'DA_CODEC_L2_RPC_URL', value: spec.network.l2RpcEndpoint },
      { name: 'DA_CODEC_SCROLL_CHAIN_URL', value: spec.network.l1RpcEndpoint }
    ],
    image,
    resources: {
      limits: { cpu: '1000m', memory: '2Gi' },
      requests: { cpu: '100m', memory: '256Mi' }
    }
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
 * Generate Rollup Relayer values
 */
function generateRollupRelayerValues(spec: DeploymentSpec): string {
  const secretConfig = getSecretProviderConfig(spec)

  const image = resolveImage(spec, 'rollupRelayer', {
    pullPolicy: 'IfNotPresent',
    repository: 'scrolltech/rollup-relayer',
    tag: 'v4.4.83'
  })

  const values: Record<string, any> = {
    configMaps: {
      env: {
        data: {
          SCROLL_ROLLUP_BATCH_COLLECTION_TIME_SEC: String(spec.rollup.coordinator.batchCollectionTimeSec),
          SCROLL_ROLLUP_BUNDLE_COLLECTION_TIME_SEC: String(spec.rollup.coordinator.bundleCollectionTimeSec),
          SCROLL_ROLLUP_CHUNK_COLLECTION_TIME_SEC: String(spec.rollup.coordinator.chunkCollectionTimeSec),
          SCROLL_ROLLUP_L1_RPC_URL: spec.network.l1RpcEndpoint,
          SCROLL_ROLLUP_L2_RPC_URL: spec.network.l2RpcEndpoint
        },
        enabled: true
      }
    },
    envFrom: [
      { configMapRef: { name: 'rollup-relayer-env' } },
      { secretRef: { name: 'rollup-relayer-secret-env' } }
    ],
    image,
    resources: {
      limits: { cpu: '1000m', memory: '4Gi' },
      requests: { cpu: '100m', memory: '512Mi' }
    }
  }

  const externalSecrets = generateExternalSecrets(
    'rollup-relayer-secret-env',
    secretConfig,
    [
      { property: 'SCROLL_ROLLUP_DB_DSN', remoteKey: 'rollup-relayer-secret-env', secretKey: 'SCROLL_ROLLUP_DB_DSN' },
      { property: 'SCROLL_ROLLUP_L1_COMMIT_SENDER_PRIVATE_KEY', remoteKey: 'rollup-relayer-secret-env', secretKey: 'SCROLL_ROLLUP_L1_COMMIT_SENDER_PRIVATE_KEY' },
      { property: 'SCROLL_ROLLUP_L1_FINALIZE_SENDER_PRIVATE_KEY', remoteKey: 'rollup-relayer-secret-env', secretKey: 'SCROLL_ROLLUP_L1_FINALIZE_SENDER_PRIVATE_KEY' }
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
          SCROLL_GAS_ORACLE_L1_RPC_URL: spec.network.l1RpcEndpoint,
          SCROLL_GAS_ORACLE_L2_RPC_URL: spec.network.l2RpcEndpoint,
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
    pullPolicy: 'Always',
    repository: 'dogeos69/fee-oracle',
    tag: '0.2.0-rc.4'
  })

  const values = {
    env: [
      { name: 'FEE_ORACLE_PORT', value: '3000' },
      { name: 'FEE_ORACLE_L2_RPC_URL', value: spec.network.l2RpcEndpoint },
      { name: 'FEE_ORACLE_DOGE_RPC_URL', value: 'http://dogecoin:22555' },
      { name: 'FEE_ORACLE_UPDATE_INTERVAL_SECS', value: '60' }
    ],
    image,
    resources: {
      limits: { cpu: '500m', memory: '512Mi' },
      requests: { cpu: '50m', memory: '128Mi' }
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
          SCROLL_CHAIN_MONITOR_L1_RPC_URL: spec.network.l1RpcEndpoint,
          SCROLL_CHAIN_MONITOR_L2_RPC_URL: spec.network.l2RpcEndpoint
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
          INDEXER_SCROLL_L1_RPC: spec.network.l1RpcEndpoint,
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
          SCROLL_BRIDGE_HISTORY_L1_RPC_URL: spec.network.l1RpcEndpoint,
          SCROLL_BRIDGE_HISTORY_L1_START_HEIGHT: String(spec.contracts.l1DeploymentBlock || 0),
          SCROLL_BRIDGE_HISTORY_L2_RPC_URL: spec.network.l2RpcEndpoint
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
          SCROLL_ADMIN_L1_RPC_URL: spec.network.l1RpcEndpoint,
          SCROLL_ADMIN_L2_RPC_URL: spec.network.l2RpcEndpoint
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
          SCROLL_L1_FEE_VAULT_ADDR: spec.contracts.l1FeeVaultAddr,
          SCROLL_L1_RPC: spec.network.l1RpcEndpoint,
          SCROLL_L2_RPC: spec.network.l2RpcEndpoint,
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
