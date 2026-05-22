export type DogecoinNetwork = 'mainnet' | 'testnet'

export interface DogecoinKubernetesConfig {
  blockbookPublicPort?: number
  blockbookServiceName?: string
  p2pPort?: number
  rpcPort?: number
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
  const network = config.network || 'testnet'
  const kubernetes = config.kubernetes || {}
  const serviceName = kubernetes.serviceName || 'dogecoin'
  const rpcPort = kubernetes.rpcPort || (network === 'mainnet' ? 22_555 : 44_555)
  const p2pPort = kubernetes.p2pPort || (network === 'mainnet' ? 22_556 : 44_556)
  const zmqRawBlockPort = kubernetes.zmqRawBlockPort || 28_332
  const zmqRawTxPort = kubernetes.zmqRawTxPort || 28_333
  const zmqHashTxPort = kubernetes.zmqHashTxPort || 28_334
  const zmqHashBlockPort = kubernetes.zmqHashBlockPort || 28_335

  return {
    p2pPort,
    rpcPort,
    rpcUrl: `http://${serviceName}:${rpcPort}`,
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
