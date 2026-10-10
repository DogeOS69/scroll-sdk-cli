import bitcore from 'bitcore-lib-doge'
import fs from 'node:fs'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {AwaitingInput, localPath, writeJson} from './preparation-io.js'

export const FEE_WALLET_KEY_ENV = 'DOGECOIN_FEE_WALLET_KEY'

/** Derive public funding identity locally; never copy WIF into workflow records. */
export function productionFeeWallet(root: string, spec: DeploymentSpec): {address: string; publicKey: string} {
  const value = process.env[FEE_WALLET_KEY_ENV]
  const {network} = spec.dogecoin
  const selectedNetwork = network === 'mainnet' ? bitcore.Networks.livenet : network === 'testnet' ? bitcore.Networks.testnet : bitcore.Networks.regtest
  let publicKey: string
  let address: string
  try {
    if (!value) throw new Error('Missing key')
    const key = bitcore.PrivateKey.fromWIF(value)
    publicKey = key.toPublicKey().toString()
    if (!/^(02|03)[\da-f]{64}$/.test(publicKey) || new bitcore.PrivateKey(key.toString(), selectedNetwork).toWIF() !== value) throw new Error('Invalid key network or compression')
    address = key.toPublicKey().toAddress(selectedNetwork).toString()
  } catch {
    throw new AwaitingInput({message: `Set ${FEE_WALLET_KEY_ENV} in the private deployment.env to a valid compressed ${network} Dogecoin WIF, then rerun apply. Its public key and funding address are derived automatically.`})
  }

  const file = localPath(root, '.data/bridge-fee-wallet.json')
  const record = {address, network, publicKey, schema: 'dogeos/bridge-fee-wallet/v1'}
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (saved.schema !== record.schema || saved.network !== network || saved.publicKey !== publicKey || saved.address !== address) throw new Error('Fee-wallet identity differs from the prepared deployment; restore its original DOGECOIN_FEE_WALLET_KEY. Do not replace a funded wallet on resume.')
  } else writeJson(file, record)
  return {address, publicKey}
}
