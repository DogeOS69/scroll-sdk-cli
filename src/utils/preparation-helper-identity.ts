import bitcore from 'bitcore-lib-doge'
import {createHash, randomBytes} from 'node:crypto'
import fs from 'node:fs'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {localPath, privateWrite} from './preparation-io.js'

export function usesManagedHelper(spec: DeploymentSpec): boolean {
  return spec.preparation?.bridge.mode === 'production' && spec.preparation.bridge.production?.funding === 'helper'
}

/** A deployment-owned secret, never a public example seed or a new seed on resume. */
export function helperSeed(root: string): string {
  const file = localPath(root, '.data/bridge-helper-seed')
  if (!fs.existsSync(file)) privateWrite(file, randomBytes(32).toString('hex') + '\n')
  const seed = fs.readFileSync(file, 'utf8').trim()
  if (!/^[\da-f]{64}$/.test(seed)) throw new Error('Invalid saved helper seed; restore its original private file')
  return seed
}

/** Match Core derive_distribution_helper + derive_key(..., "fee_wallet"). */
export function helperFeeWalletWif(root: string, spec: DeploymentSpec): string {
  const base = createHash('sha256').update(helperSeed(root)).digest()
  const bytes = createHash('sha256').update(base).update('fee_wallet').digest('hex')
  const network = spec.dogecoin.network === 'mainnet' ? bitcore.Networks.livenet : spec.dogecoin.network === 'regtest' ? bitcore.Networks.regtest : bitcore.Networks.testnet
  return new bitcore.PrivateKey(bytes, network).toWIF()
}
