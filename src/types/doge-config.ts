export type Network = 'mainnet' | 'testnet'

export interface CubesignerKey {
  key_id: string
  key_type: string
  public_key: string
  material_id: string
  purpose: string
}

export interface CubesignerRole {
  role_id: string
  name: string
  keys: CubesignerKey[]
}

export interface DogeConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
  defaults?: {
    dogecoinIndexerStartHeight?: string
  }
  frontend?: {
    bridgeUrl?: string
    l2Explorer?: string
    l2Url?: string
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
  dogecoinClusterRpc?: {
    username?: string // for dogecoin that deploy on cluster
    password?: string // for dogecoin that deploy on cluster
  }

  test?: {
    mockFinalizeEnabled?: boolean
    mockFinalizeTimeout?: number
  }
  wallet: {
    path: string
  }
  da?: {
    celestiaIndexerStartBlock: string,
    //rpcUrl: string,
    tendermintRpcUrl: string,
    daNamespace: string,
    signerAddress: string,
    genesisBlobCommitment?: string,
    celestiaMnemonic: string,
  }
  awsSigner?: {
    region?: string
    networkAlias?: string
    accountId?: string
    suffixes?: string
  }
  localSigners?: {
    network?: string
    signers?: Array<{
      index: number
      port: number
    }>
  }
  deploymentType?: 'local' | 'aws'
  signerUrls?: string[]
  cubesigner?: {
    roles: CubesignerRole[]
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
