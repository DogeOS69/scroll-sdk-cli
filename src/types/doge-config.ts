export type Network = 'mainnet' | 'regtest' | 'testnet'

export interface CubesignerKey {
  key_id: string
  key_type: string
  material_id: string
  public_key: string
  purpose: string
}

export interface CubesignerRole {
  keys: CubesignerKey[]
  name: string
  role_id: string
}

export interface DogeConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
  awsSigner?: {
    accountId?: string
    ecsClusterName?: string
    imageSource?: 'dockerhub' | 'ecr' | 'ecr-sync'
    imageUri?: string
    networkAlias?: string
    region?: string
  }
  cubesigner?: {
    roles: CubesignerRole[]
  }
  da?: {
    celestiaIndexerStartBlock: string,
    celestiaMnemonic: string,
    daNamespace: string,
    signerAddress: string,
    // rpcUrl: string,
    tendermintRpcUrl: string,
  }
  defaults?: {
    dogecoinIndexerStartHeight?: string
    ethereumDaEmbeddedIndexerStartBlock?: string
    l1GenesisBlock?: string
  }
  dogecoinClusterRpc?: {
    password?: string // for dogecoin that deploy on cluster
    username?: string // for dogecoin that deploy on cluster
  }
  /** Dummy signer runtime provider. This is independent from the Kubernetes infrastructure provider. */
  dummySigner?: {
    provider?: 'aws' | 'local'
  }
  ethereumDa?: {
    beaconRpcUrl?: string
    chain?: 'devnet' | 'mainnet' | 'sepolia'
    chainId?: string
    minFinality?: 'finalized' | 'safe'
    signer?: {
      backend?: 'aws_kms' | 'local'
      expectedAddress?: string
      kmsKeyArn?: string
      kmsKeyId?: string
      kmsRegion?: string
      namespace?: string
      serviceAccountName?: string
      serviceAccountRoleArn?: string
    }
    submitterRpcUrl?: string
  }

  frontend?: {
    bridgeUrl?: string
    l2Explorer?: string
    l2Url?: string
  }
  kubernetes?: {
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
  localSigners?: {
    signers?: Array<{
      index: number
      port: number
    }>
  }
  network: Network
  rpc?: {
    apiKey?: string
    blockbookAPIUrl?: string
    l2Url?: string
    password?: string // for send/sync on dogocoin
    url?: string // for send/sync on dogocoin like: https://testnet.doge.xyz/
    username?: string // for send/sync on dogocoin
  }
  signerUrls?: string[]
  test?: {
    mockFinalizeEnabled?: boolean
    mockFinalizeTimeout?: number
  }
  wallet: {
    path: string
  }
}

export interface DogeWallet {
  address: string
  network?: Network
  privateKey: string
  utxos: DogeUTXO[]
}

export interface DogeUTXO {
  satoshis: number
  script: string
  txid: string
  vout: number
}
