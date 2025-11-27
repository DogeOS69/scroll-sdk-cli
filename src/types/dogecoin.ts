import * as bitcoin from 'bitcoinjs-lib'

// 1. Define Dogecoin testnet network parameters
export const dogecoinTestnet: bitcoin.Network = {
  messagePrefix: '\x19Dogecoin Testnet Signed Message:\n',
  bip32: {
    public: 0x04_35_87_CF, // tpub
    private: 0x04_35_83_94, // tprv
  },
  pubKeyHash: 0x71, // Addresses start with 'n' or 'm'
  scriptHash: 0xC4, // P2SH addresses start with '2'
  wif: 0xF1, // WIF private key prefix
  bech32: '', // Dogecoin does not support bech32, but the library requires this property
}
export const dogecoinMainnet: bitcoin.Network = {
  messagePrefix: '\x19Dogecoin Signed Message:\n',
  bip32: {
    public: 0x02_fa_ca_fd, // dgub
    private: 0x02_fa_c3_98, // dgpv
  },
  pubKeyHash: 0x1e, // Addresses start with 'D'
  scriptHash: 0x16, // P2SH addresses start with '9' or 'A'
  wif: 0x9e, // WIF private key prefix
  bech32: '', // Dogecoin does not support bech32, but the library requires this property
}

/**
 * Reverses the byte order of a hexadecimal string.
 * This is used to convert from internal little-endian format to the big-endian
 * format used in block explorers (txid).
 * @param hex The little-endian hex string to reverse.
 * @returns The big-endian hex string.
 */
export function reverseHex(hex: string): string {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string: must have an even number of characters.')
  }

  const buffer = Buffer.from(hex, 'hex')
  buffer.reverse()
  return buffer.toString('hex')
}

/**
 * Prints detailed information about a PSBT object to the console.
 * @param psbt The PSBT object to inspect.
 * @param id An optional identifier (e.g., a database row ID) to include in the output.
 */
export function printPsbtDetails(psbt: bitcoin.Psbt, id?: number | string): void {
  const inputsWithDetails = psbt.data.inputs.map((input, index) => {
    const txInput = psbt.txInputs[index]
    const littleEndianHash = Buffer.from(txInput.hash).toString('hex')
    const details: any = {
      ...txInput,
      hash: littleEndianHash,
      txid_for_explorer: reverseHex(littleEndianHash),
    }

    if (input.nonWitnessUtxo) details.nonWitnessUtxo = `Present (${input.nonWitnessUtxo.length} bytes)`
    if (input.witnessUtxo)
      details.witnessUtxo = {...input.witnessUtxo, script: Buffer.from(input.witnessUtxo.script).toString('hex')}
    if (input.partialSig)
      details.partialSigs = input.partialSig.map(sig => ({
        pubkey: Buffer.from(sig.pubkey).toString('hex'),
        signature: Buffer.from(sig.signature).toString('hex'),
      }))
    if (input.sighashType) details.sighashType = input.sighashType
    if (input.redeemScript) details.redeemScript = Buffer.from(input.redeemScript).toString('hex')
    if (input.witnessScript) details.witnessScript = Buffer.from(input.witnessScript).toString('hex')
    if (input.bip32Derivation)
      details.bip32Derivation = input.bip32Derivation.map(d => ({
        ...d,
        pubkey: Buffer.from(d.pubkey).toString('hex'),
        masterFingerprint: Buffer.from(d.masterFingerprint).toString('hex'),
      }))
    if (input.finalScriptSig) details.finalScriptSig = Buffer.from(input.finalScriptSig).toString('hex')
    if (input.finalScriptWitness) details.finalScriptWitness = Buffer.from(input.finalScriptWitness).toString('hex')

    return details
  })

  const outputsWithDetails = psbt.data.outputs.map((output, index) => {
    const txOutput = psbt.txOutputs[index]
    let address
    try {
      address = bitcoin.address.fromOutputScript(txOutput.script, dogecoinTestnet)
    } catch {
      address = 'Unable to decode address'
    }

    const details: any = {
      address,
      value: txOutput.value,
      script: Buffer.from(txOutput.script).toString('hex'),
    }

    if (output.redeemScript) details.redeemScript = Buffer.from(output.redeemScript).toString('hex')
    if (output.witnessScript) details.witnessScript = Buffer.from(output.witnessScript).toString('hex')
    if (output.bip32Derivation)
      details.bip32Derivation = output.bip32Derivation.map(d => ({
        ...d,
        pubkey: Buffer.from(d.pubkey).toString('hex'),
        masterFingerprint: Buffer.from(d.masterFingerprint).toString('hex'),
      }))

    return details
  })

  let fee: bigint | string = 'N/A'
  let feeRate: number | string = 'N/A'
  let feeError: string | undefined
  try {
    fee = psbt.getFee()
    feeRate = psbt.getFeeRate()
  } catch (error) {
    if (error instanceof Error) feeError = error.message
    // Ignore error if fee cannot be calculated
  }

  console.log(`\n--- PSBT Details ${id ? `for task id ${id}` : ''} ---`)
  console.log(`Version: ${psbt.version}, Locktime: ${psbt.locktime}, Fee: ${fee} (dogetoshis), Fee Rate: ${feeRate} (dogetoshis/vB)`)
  // Use JSON.stringify for pretty printing the detailed objects
  console.log('Inputs:', JSON.stringify(inputsWithDetails, null, 2))
  console.log('Outputs:', JSON.stringify(outputsWithDetails, null, 2))
  if (feeError) console.log(`Fee calculation error: ${feeError}`)
}
