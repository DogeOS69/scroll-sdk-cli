export type Network = 'mainnet' | 'testnet'

export interface DogeConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
  defaults?: {
    chainId?: string
    evmAddress?: string
    recipient?: string
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
    genesisBlobCommitment: string
  }
  awsSigner?: {
    region?: string
    networkAlias?: string
    accountId?: string
    tsoUrl?: string
    suffixes?: string
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
