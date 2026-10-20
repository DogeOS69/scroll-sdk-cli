import * as toml from '@iarna/toml'
import fs from 'node:fs'
import path from 'node:path'

import {contracts} from '../data/contracts.js'
import {preinstalledContracts} from '../data/preinstalled-contracts.js'
import {preparePreinstallsVerification} from './preinstalls-source-verification.js'

export interface VerificationTarget {address: string; name: string}
export interface VerificationStatus extends VerificationTarget {status: 'partial' | 'pending' | 'unavailable' | 'verified'}

export function verificationTargets(directory: string, includeContracts: boolean, includePreinstalls: boolean): {apiUrl: string; targets: VerificationTarget[]} {
  const {apiUrl} = preparePreinstallsVerification(directory)
  const targets: VerificationTarget[] = []
  if (includeContracts) {
    let main: toml.JsonMap
    let addresses: toml.JsonMap
    try {
      main = toml.parse(fs.readFileSync(path.join(directory, 'config.toml'), 'utf8'))
      addresses = toml.parse(fs.readFileSync(path.join(directory, 'config-contracts.toml'), 'utf8'))
    } catch {throw new Error('Cannot read verification configuration; contents omitted')}

    const overrides = (main.contracts as toml.JsonMap)?.overrides as toml.JsonMap | undefined
    for (const contract of contracts) {
      // This predeploy has no Solidity source; its bytecode is checked by the released verifier.
      if (contract.name === 'BLOCK_HASH_HISTORY_ADDR') continue
      const address = contract.name === 'L2_NATIVE_DOGE_TOKEN_ADDR' ? overrides?.L2_NATIVE_DOGE_TOKEN ?? contract.address : addresses[contract.name]
      if (address === undefined || address === '') continue
      if (typeof address !== 'string' || !/^0x[\da-f]{40}$/i.test(address) || /^0x0{40}$/i.test(address)) throw new Error(`Invalid verification target: ${contract.name}`)
      targets.push({address, name: contract.name})
    }
  }

  if (includePreinstalls) for (const contract of preinstalledContracts.filter(entry => !entry.optional)) targets.push({address: contract.address!, name: contract.name})
  if (targets.length === 0) throw new Error('No source-verification targets configured')
  return {apiUrl, targets}
}

/** A successful submission or partial match never counts as full verification. */
export async function readVerificationStatus(apiUrl: string, targets: VerificationTarget[], request: typeof fetch = fetch): Promise<VerificationStatus[]> {
  return Promise.all(targets.map(async target => {
    let status: VerificationStatus['status'] = 'unavailable'
    try {
      const response = await request(`${apiUrl.replace(/\/$/, '')}/v2/smart-contracts/${target.address}`, {signal: AbortSignal.timeout(10_000)})
      if (response.status === 404) status = 'pending'
      else if (response.ok) {
        const data = await response.json()
        status = data.is_partially_verified === true ? 'partial' : data.is_verified === true && data.is_fully_verified === true && data.is_partially_verified !== true ? 'verified' : 'pending'
      }
    } catch { /* Do not expose RPC URLs, provider bodies or credentials. */ }

    return {...target, status}
  }))
}

export async function awaitVerificationStatus(plan: {apiUrl: string; targets: VerificationTarget[]}, seconds: number): Promise<VerificationStatus[]> {
  const deadline = Date.now() + seconds * 1000
  let statuses: VerificationStatus[]
  do {
    statuses = await readVerificationStatus(plan.apiUrl, plan.targets)
    if (statuses.every(entry => entry.status === 'verified') || Date.now() >= deadline) return statuses
    await new Promise(resolve => {setTimeout(resolve, Math.min(3000, deadline - Date.now()))})
  } while (Date.now() < deadline)

  return statuses
}
