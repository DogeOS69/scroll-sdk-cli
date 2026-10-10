import bitcore from 'bitcore-lib-doge'

/** Contracts encode a Dogecoin P2PKH hash160 as an EVM-sized address. */
export function feeVaultRecipientHash(address: string, network: 'mainnet' | 'regtest' | 'testnet'): string {
  try {
    const selected = network === 'mainnet' ? bitcore.Networks.livenet : network === 'testnet' ? bitcore.Networks.testnet : bitcore.Networks.regtest
    const parsed = bitcore.Address.fromString(address, selected)
    if (parsed.type !== 'pubkeyhash' || parsed.hashBuffer.length !== 20 || parsed.hashBuffer.every((byte: number) => byte === 0)) throw new Error('Invalid recipient')
    return `0x${parsed.hashBuffer.toString('hex')}`
  } catch {
    throw new Error('contracts.feeVaultDogeRecipientAddress must be a nonzero Dogecoin P2PKH address for the selected network')
  }
}
