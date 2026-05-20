export type Network = 'mainnet' | 'testnet'

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
    networkAlias?: string
    region?: string
    suffixes?: string
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
  }
  deploymentType?: 'aws' | 'local'
  dogecoinClusterRpc?: {
    password?: string // for dogecoin that deploy on cluster
    username?: string // for dogecoin that deploy on cluster
  }

  frontend?: {
    bridgeUrl?: string
    l2Explorer?: string
    l2Url?: string
  }
  localSigners?: {
    network?: string
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
