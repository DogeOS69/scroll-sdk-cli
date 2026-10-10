import {L2_BASE_FEE_OVERHEAD_WEI} from '../constants/deployment.js'

/** Foundry estimates before L2SystemConfig activates the post-genesis fee floor. */
export function contractsDeploymentGasPrice(overhead: unknown = L2_BASE_FEE_OVERHEAD_WEI): string | undefined {
  if (!/^\d+$/.test(String(overhead))) throw new Error('Invalid L2 base fee overhead for contract deployment')
  const price = 2n * BigInt(String(overhead))
  return price > 0n ? price.toString() : undefined
}
