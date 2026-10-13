/**
 * WP parses `tsoSigners[].network` as a nintondo Dogecoin `Network`, whose
 * serde names are lowercase variant names: mainnet is `dogecoin`, not
 * `mainnet`. Other services keep reading the DogeConfig spelling.
 */
export function tsoSignerNetwork(network: string): string {
  return network === 'mainnet' ? 'dogecoin' : network
}
