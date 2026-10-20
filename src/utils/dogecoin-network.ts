/** Core #1627's network names. Accept the legacy Dogecoin mainnet alias only on input. */
export function canonicalDogecoinNetwork(network: string): 'mainnet' | 'regtest' | 'testnet' {
  if (network === 'dogecoin' || network === 'mainnet') return 'mainnet'
  if (network === 'testnet' || network === 'regtest') return network
  throw new Error('Unsupported Dogecoin network; expected mainnet, dogecoin, testnet or regtest')
}
