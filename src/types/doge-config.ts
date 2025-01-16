export interface DogeConfig {
  defaults?: {
    chainId?: string
    evmAddress?: string
    recipient?: string
  }
  network: 'doge' | 'dogeRegtest' | 'dogeTestnet'
  rpc: {
    apiKey?: string
    password?: string
    url: string
    username?: string
  }
  wallet: {
    path: string
  }
}

export interface DogeWallet {
  address: string
  privateKey: string
  utxos: Array<{
    satoshis: number
    script: string
    txid: string
    vout: number
  }>
}
