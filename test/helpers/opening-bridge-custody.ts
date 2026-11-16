import {Transaction} from 'bitcoinjs-lib'
import {createHash} from 'node:crypto'

/** A synthetic marked Bridge funding transaction paying the P2SH of `redeemScriptHex` at output 0. */
export function openingCustodyFixture(redeemScriptHex: string): {tx_hex: string; vout: number} {
  const redeem = Buffer.from(redeemScriptHex, 'hex')
  const scriptHash = createHash('ripemd160').update(createHash('sha256').update(redeem).digest()).digest('hex')
  const funding = new Transaction()
  funding.addInput(Buffer.alloc(32, 7), 0)
  funding.addOutput(Buffer.from(`a914${scriptHash}87`, 'hex'), 1_000_000_000n)
  funding.addOutput(Buffer.from('6a4901' + '00'.repeat(72), 'hex'), 0n)
  return {tx_hex: funding.toHex(), vout: 0}
}
