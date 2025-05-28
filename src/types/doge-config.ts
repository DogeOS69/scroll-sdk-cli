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
    password?: string
    url?: string
    username?: string
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
    rpcUrl: string,
    tendermintRpcUrl: string,
    daNamespace: string,
    signerAddress: string,
    genesisBlobCommitment: string
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
