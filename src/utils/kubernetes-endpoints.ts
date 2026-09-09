export type DogecoinNetwork = 'mainnet' | 'regtest' | 'testnet'

export interface DogecoinKubernetesConfig {
  blockbookPublicPort?: number
  blockbookServiceName?: string
  p2pPort?: number
  rpcPort?: number
  /** Explicit in-cluster consumer RPC URL; useful for an isolated shadowfork proxy. */
  rpcUrl?: string
  serviceName?: string
  zmqHashBlockPort?: number
  zmqHashTxPort?: number
  zmqRawBlockPort?: number
  zmqRawTxPort?: number
}

export interface DogecoinEndpointConfig {
  kubernetes?: DogecoinKubernetesConfig
  network?: DogecoinNetwork
}

export interface DogecoinKubernetesEndpoints {
  p2pPort: number
  rpcPort: number
  rpcUrl: string
  serviceName: string
  zmqHashBlockPort: number
  zmqHashBlockUrl: string
  zmqHashTxPort: number
  zmqHashTxUrl: string
  zmqRawBlockPort: number
  zmqRawBlockUrl: string
  zmqRawTxPort: number
  zmqRawTxUrl: string
}

export interface BlockbookKubernetesEndpoints {
  apiUrl: string
  publicPort: number
  serviceName: string
}

export function resolveDogecoinKubernetesEndpoints(config: DogecoinEndpointConfig): DogecoinKubernetesEndpoints {
  if (!config.network) {
    throw new Error('Dogecoin network is required. Read it from doge-config.toml network before resolving endpoints.')
  }

  const { network } = config
  const kubernetes = config.kubernetes || {}
  const serviceName = kubernetes.serviceName || (network === 'testnet' ? 'dogecoin-testnet' : 'dogecoin')
  const defaultRpcPort = network === 'mainnet' ? 22_555 : network === 'regtest' ? 18_332 : 44_555
  const defaultP2pPort = network === 'mainnet' ? 22_556 : network === 'regtest' ? 18_444 : 44_556
  const rpcPort = kubernetes.rpcPort || defaultRpcPort
  const p2pPort = kubernetes.p2pPort || defaultP2pPort
  const rpcUrl = kubernetes.rpcUrl?.trim() || `http://${serviceName}:${rpcPort}`
  let parsedRpcUrl: URL
  try {
    parsedRpcUrl = new URL(rpcUrl)
  } catch {
    throw new Error('kubernetes.rpcUrl must be a valid http(s) URL when set')
  }

  if (!['http:', 'https:'].includes(parsedRpcUrl.protocol)) {
    throw new Error('kubernetes.rpcUrl must be a valid http(s) URL when set')
  }

  const zmqRawBlockPort = kubernetes.zmqRawBlockPort || 28_332
  const zmqRawTxPort = kubernetes.zmqRawTxPort || 28_333
  const zmqHashTxPort = kubernetes.zmqHashTxPort || 28_334
  const zmqHashBlockPort = kubernetes.zmqHashBlockPort || 28_335

  return {
    p2pPort,
    rpcPort,
    rpcUrl,
    serviceName,
    zmqHashBlockPort,
    zmqHashBlockUrl: `tcp://${serviceName}:${zmqHashBlockPort}`,
    zmqHashTxPort,
    zmqHashTxUrl: `tcp://${serviceName}:${zmqHashTxPort}`,
    zmqRawBlockPort,
    zmqRawBlockUrl: `tcp://${serviceName}:${zmqRawBlockPort}`,
    zmqRawTxPort,
    zmqRawTxUrl: `tcp://${serviceName}:${zmqRawTxPort}`,
  }
}

/**
 * Return the stable in-cluster Dogecoin JSON-RPC endpoint for native service
 * configs that keep credentials outside the URL.
 *
 * `kubernetes.rpcUrl` may be an operator-facing proxy URL containing a query
 * parameter such as a shadowfork API key. The proof-topology contract rejects
 * URL-embedded credentials, queries, and fragments, so Proof Coordinator uses
 * the Kubernetes Service and its dedicated RPC username/password fields.
 */
export function resolveDogecoinServiceRpcUrl(config: DogecoinEndpointConfig): string {
  const endpoints = resolveDogecoinKubernetesEndpoints(config)
  return `http://${endpoints.serviceName}:${endpoints.rpcPort}`
}

export function resolveBlockbookKubernetesEndpoints(config: DogecoinEndpointConfig): BlockbookKubernetesEndpoints {
  const kubernetes = config.kubernetes || {}
  const serviceName = kubernetes.blockbookServiceName || 'blockbook'
  const publicPort = kubernetes.blockbookPublicPort || 19_139

  return {
    apiUrl: `http://${serviceName}:${publicPort}`,
    publicPort,
    serviceName,
  }
}
