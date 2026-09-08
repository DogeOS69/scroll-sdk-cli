/* eslint-disable @typescript-eslint/no-explicit-any -- Reads deployment TOML sections. */
import {getRequiredManagedSignerAddress} from './signer-roles.js'

// Public test vector, NOT a service identity. Never fund or authorize it.
export const CONTRACTS_PLACEHOLDER_PRIVATE_KEY = `0x${'0'.repeat(63)}1`
export const CONTRACTS_PLACEHOLDER_ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'

/** Opt-in compatibility for legacy contracts images in DogeOS L2-only deployment. */
export function getContractsPlaceholderKey(config: any, dogeConfig: any): string | undefined {
  if (config.contracts?.LEGACY_COMMIT_SENDER_PLACEHOLDER !== true) return undefined
  if (dogeConfig.network !== 'testnet' && dogeConfig.network !== 'regtest') {
    throw new Error('Contracts placeholder is restricted to Dogecoin testnet/regtest L2-only deployments')
  }

  const actualAddress = getRequiredManagedSignerAddress(dogeConfig, 'l1CommitSender')
  if (actualAddress.toLowerCase() === CONTRACTS_PLACEHOLDER_ADDRESS.toLowerCase()) {
    throw new Error('Contracts placeholder must not be the actual eth-da-submitter signer')
  }

  if (config.accounts?.L1_COMMIT_SENDER_ADDR?.toLowerCase() !== CONTRACTS_PLACEHOLDER_ADDRESS.toLowerCase()
    || config.accounts?.L1_COMMIT_SENDER_PRIVATE_KEY !== CONTRACTS_PLACEHOLDER_PRIVATE_KEY) {
    throw new Error('LEGACY_COMMIT_SENDER_PLACEHOLDER requires the documented public placeholder key/address pair in config.toml')
  }

  return CONTRACTS_PLACEHOLDER_PRIVATE_KEY
}

export function assertNoPlaceholderFunding(config: any, layer?: string, fundDeployer?: boolean): void {
  if (config.contracts?.LEGACY_COMMIT_SENDER_PLACEHOLDER === true && layer !== '2' && !fundDeployer) {
    throw new Error('Refusing to fund the contracts placeholder. Fund the actual Ethereum DA signer from doge-config on its configured DA network; use --layer 2 for L2 accounts.')
  }
}
