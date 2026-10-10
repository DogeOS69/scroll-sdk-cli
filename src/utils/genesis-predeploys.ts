import * as yaml from 'js-yaml'
import * as fs from 'node:fs'

import {GENESIS_PREDEPLOYS} from '../constants/deployment.js'

// These addresses are hard-coded in Reth and its execution witnesses.
const requiredPredeploys = {
  BLOCK_HASH_HISTORY: '0x0000f90827f1c53a10cb7a02335b175320002935',
  L1_GAS_PRICE_ORACLE: GENESIS_PREDEPLOYS.L1_GAS_PRICE_ORACLE,
  L2_MESSAGE_QUEUE: GENESIS_PREDEPLOYS.L2_MESSAGE_QUEUE,
  L2_NATIVE_DOGE_TOKEN: GENESIS_PREDEPLOYS.L2_NATIVE_DOGE_TOKEN,
}

/** Reject unusable genesis output before Bridge funding or proof material generation. */
export function validateGenesisPredeploys(file: string): void {
  let alloc: Record<string, {code?: unknown}>
  try {
    const document = yaml.load(fs.readFileSync(file, 'utf8')) as {scrollConfig?: {alloc?: unknown} | string}
    const genesis = typeof document?.scrollConfig === 'string'
      ? JSON.parse(document.scrollConfig) : document?.scrollConfig
    if (!genesis?.alloc || typeof genesis.alloc !== 'object' || Array.isArray(genesis.alloc)) throw new Error('Invalid alloc')
    alloc = Object.fromEntries(Object.entries(genesis.alloc).map(([address, account]) => [
      address.toLowerCase().replace(/^0x/, ''), account,
    ])) as typeof alloc
  } catch {
    // YAML parser errors can include the input; never echo generated configuration.
    throw new Error('Generated genesis.yaml must contain scrollConfig with a valid genesis alloc')
  }

  for (const [name, address] of Object.entries(requiredPredeploys)) {
    const code = alloc[address.slice(2)]?.code
    if (typeof code !== 'string' || !/^0x(?:[\da-f]{2})+$/i.test(code) || /^0x0+$/i.test(code)) {
      throw new Error(`Generated genesis is missing executable ${name} at ${address}. Use the canonical contracts predeploy overrides and regenerate before preparing or funding the Bridge.`)
    }
  }
}
