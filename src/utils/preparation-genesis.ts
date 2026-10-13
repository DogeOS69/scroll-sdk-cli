/* eslint-disable @typescript-eslint/no-explicit-any -- Adapter for generated deployment TOML. */
import * as toml from '@iarna/toml'
import {isAddress} from 'ethers'
import * as yaml from 'js-yaml'
import fs from 'node:fs'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {generateConfigToml, resolveDeploymentSpecEnvRefs, validateDeploymentSpec} from './deployment-spec-generator.js'
import {localPath, privateWrite} from './preparation-io.js'
import {resolveSpecIdentities} from './spec-identities.js'

/** Only inputs needed by the contracts generator and its real signing identities.
 * Do not resolve unrelated environment references or contact external providers.
 */
export function genesisIntent(input: DeploymentSpec): DeploymentSpec {
  const primary = input.identities?.sequencers?.find(node => node.index === 0)
  if (!primary) throw new Error('Genesis requires identities.sequencers index 0')
  const spec = resolveDeploymentSpecEnvRefs({
    accounts: {owner: input.accounts?.owner, ...(input.accounts?.deployer ? {deployer: input.accounts.deployer} : {}), ...(input.accounts?.l2GasOracleSender ? {l2GasOracleSender: input.accounts.l2GasOracleSender} : {})},
    bridge: {feeRecipient: input.bridge?.feeRecipient, fees: input.bridge?.fees},
    contracts: {...input.contracts, verification: undefined},
    database: {},
    dogecoin: {network: input.dogecoin?.network},
    frontend: {},
    genesis: input.genesis,
    identities: {bootnodes: [], ethDaSubmitter: {action: 'create', backend: 'local'}, feeOracle: input.identities!.feeOracle, sequencers: [primary]},
    infrastructure: {...input.infrastructure, bootnodeCount: 0, sequencerCount: 1},
    metadata: input.metadata,
    network: input.network,
    signing: {},
    templates: input.templates,
    version: input.version,
    ...(input.rollup?.verifierDigests ? {rollup: {verifierDigests: input.rollup.verifierDigests}} : {}),
    preparation: {genesis: input.preparation?.genesis},
  } as unknown as DeploymentSpec)
  if (spec.version !== '1.0') throw new Error('Genesis requires spec version 1.0')
  if (!spec.metadata?.name || !Number.isSafeInteger(spec.network?.l2ChainId) || spec.network.l2ChainId <= 0) throw new Error('Genesis requires metadata.name and a positive network.l2ChainId')
  if (!['mainnet', 'regtest', 'testnet'].includes(spec.dogecoin.network)) throw new Error('Genesis requires dogecoin.network')
  if (!isAddress(spec.accounts.owner?.address ?? '') || /^0x0{40}$/i.test(spec.accounts.owner.address)) throw new Error('Genesis requires accounts.owner.address')
  if (!spec.contracts?.deploymentSalt || /replace|todo|\$env:/i.test(spec.contracts.deploymentSalt)) throw new Error('Genesis requires contracts.deploymentSalt')
  if (!spec.contracts.feeVaultDogeRecipientAddress) throw new Error('Genesis requires contracts.feeVaultDogeRecipientAddress')
  if (!isAddress(spec.bridge.feeRecipient ?? '')) throw new Error('Genesis requires bridge.feeRecipient')
  if (!spec.genesis || !spec.contracts.gasOracle || !spec.bridge.fees) throw new Error('Genesis requires genesis, contracts.gasOracle and bridge.fees')
  // Reuse the shared numeric/account/fee validation; ignore only unrelated stages.
  const checked = {...spec, bridge: {...spec.bridge, keyCounts: {attestation: 1, recovery: 1}, thresholds: {attestation: 1, recovery: 1}}, preparation: undefined} as DeploymentSpec
  const errors = validateDeploymentSpec(checked).errors.filter(error => /^(accounts|genesis|contracts|network|dogecoin.network|bridge.fees|rollup.verifierDigests)(\.|$)/.test(error.path))
  if (errors.length > 0) throw new Error(`Invalid genesis inputs: ${errors.map(error => `${error.path} (${error.code})`).join(', ')}`)
  generateConfigToml(spec) // Also validates the Dogecoin recipient and fee conversion.
  return spec
}

export function writeGenesisInputs(root: string, input: DeploymentSpec): void {
  const spec = genesisIntent(input)
  privateWrite(localPath(root, 'config.toml'), generateConfigToml(spec))
  privateWrite(localPath(root, '.data/doge-config.toml'), toml.stringify({identityIntent: resolveSpecIdentities(spec), network: spec.dogecoin.network, wallet: {path: '.data/doge-wallet.json'}} as any))
}

/** The generator emits a Helm wrapper; export the exact payload without Bridge work. */
export function exportGenesisJson(root: string): void {
  const document = yaml.load(fs.readFileSync(localPath(root, 'values/genesis.yaml'), 'utf8')) as {scrollConfig: unknown}
  const genesis = typeof document?.scrollConfig === 'string' ? JSON.parse(document.scrollConfig) : document?.scrollConfig
  if (!genesis || typeof genesis !== 'object' || Array.isArray(genesis) || !('alloc' in genesis) || !('config' in genesis)) throw new Error('Generator did not produce a valid genesis object')
  privateWrite(localPath(root, '.data/genesis.json'), JSON.stringify(genesis, null, 2) + '\n')
}
