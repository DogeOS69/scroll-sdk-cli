import {Wallet, ZeroAddress, getAddress} from 'ethers'

import {resolveEnvValue} from './non-interactive.js'

export interface ContractOwnerCheck {
  address: string
  signingSource: 'deployer' | 'external' | 'owner-private-key'
  warnings: string[]
}

/** Never change a configured owner. External wallets/multisigs remain supported;
 * report explicitly when this machine has no matching signing key. */
export function inspectContractOwner(accounts: Record<string, unknown> = {}): ContractOwnerCheck {
  const value = (name: string): string | undefined => {
    const raw = accounts[name]
    if (raw === undefined || raw === '') return undefined
    if (typeof raw !== 'string') throw new Error(`${name} must be a string`)
    const resolved = resolveEnvValue(raw)
    if (!resolved) throw new Error(`${name} references an unset environment variable`)
    return resolved
  }

  const address = (name: string): string => {
    try {
      const result = getAddress(value(name) || '')
      if (result !== ZeroAddress) return result
    } catch { /* Do not include raw configuration or ethers error objects. */ }

    throw new Error(`${name} must be a nonzero EVM address controlled by the operator`)
  }

  const owner = address('OWNER_ADDR')
  const keyAddress = (name: string): string | undefined => {
    const key = value(name)
    if (!key) return undefined
    try {return new Wallet(key).address} catch {throw new Error(`${name} is not a valid private key; contents omitted`)}
  }

  const ownerKey = keyAddress('OWNER_PRIVATE_KEY')
  if (ownerKey && ownerKey !== owner) throw new Error('OWNER_PRIVATE_KEY does not match OWNER_ADDR')
  const deployerKey = keyAddress('DEPLOYER_PRIVATE_KEY')
  if (deployerKey && deployerKey !== address('DEPLOYER_ADDR')) throw new Error('DEPLOYER_PRIVATE_KEY does not match DEPLOYER_ADDR')
  if (ownerKey) return {address: owner, signingSource: 'owner-private-key', warnings: []}
  if (deployerKey === owner) return {address: owner, signingSource: 'deployer', warnings: []}
  return {address: owner, signingSource: 'external', warnings: [
    `OWNER_ADDR ${owner} has no matching local owner/deployer private key. Confirm access to its external wallet or multisig before deploying; deployment can transfer ownership without the recipient signing. Changing config.toml later does not change on-chain ownership.`,
  ]}
}
