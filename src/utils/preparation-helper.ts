/* eslint-disable @typescript-eslint/no-explicit-any -- Core construction manifests and RPC responses. */
import * as toml from '@iarna/toml'
import fs from 'node:fs'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'
import type {Rpc} from './preparation-funding.js'

import {bridgeSetupHelperAddress} from '../commands/setup/bridge-init.js'
import {GENESIS_SEQUENCER_AMOUNT_SATS, coreHelperNetwork} from './bridge-constants.js'
import {FEE_WALLET_KEY_ENV, productionFeeWallet} from './preparation-fee-wallet.js'
import {checkPrivateKey, fundingInput, inspectFunding, publicKeyAddress, verifyDogecoinNetwork, verifyProductionBridge} from './preparation-funding.js'
import {helperSeed, usesManagedHelper} from './preparation-helper-identity.js'
import {AwaitingInput, privateWrite, writeJson} from './preparation-io.js'
import {productionSequencer} from './preparation-sequencer-kms.js'
import {resolveSpecAttestationSigners} from './spec-attestation-signers.js'

/** This immutable release emits a 71-byte marker rejected by its own 73-byte decoder. */
export function assertHelperFundingImage(image: string): void {
  if (image.endsWith('@sha256:27e646fd5d9c340926df82f47f7d352fd5333de4e6178c5a8c56aa9637769262')) throw new Error('The selected beta.6 bridge-genesis-tools image emits an invalid 71-byte Bridge funding marker; Core requires 73 bytes. Select a reviewed fixed image before helper funding. No helper transaction was sent.')
}

const readToml = (root: string, file: string): any => toml.parse(fs.readFileSync(path.join(root, '.data', file), 'utf8'))
const readJson = (root: string, file: string): any => JSON.parse(fs.readFileSync(path.join(root, '.data', file), 'utf8'))

export function prepareManagedHelper(root: string, spec: DeploymentSpec): void {
  const policy = spec.preparation!.bridge.production!
  const sequencer = productionSequencer(root, spec)
  if (!sequencer.kms) checkPrivateKey(sequencer.publicKey, policy.sequencerKeyEnv!)
  const fee = productionFeeWallet(root, spec)
  if (sequencer.publicKey === fee.publicKey) throw new Error('Sequencer and fee wallet must have different keys')
  const config = readToml(root, 'setup_defaults.toml')
  const topology = resolveSpecAttestationSigners(spec, true)!
  const active = topology.external.filter(signer => topology.activeSignerIds.includes(signer.id))
  Object.assign(config, {
    attestation_key_count: active.length, attestation_pubkeys: active.map(signer => signer.publicKey),
    attestation_threshold: topology.threshold,
    bridge_funding_target_amount: config.bridge_target_amount,
    bridge_funding_tx_count: 1,
    confirmations_required: spec.bridge.confirmationsRequired,
    enable_deposit_seed_txs: false, network: coreHelperNetwork(spec.dogecoin.network),
    recovery_key_count: policy.recoveryPublicKeys.length, recovery_pubkeys: policy.recoveryPublicKeys,
    recovery_threshold: spec.bridge.thresholds.recovery, seed_string: helperSeed(root),
    sequencer_pubkey: sequencer.publicKey,
    sequencer_target_amount: GENESIS_SEQUENCER_AMOUNT_SATS, tee_pubkey: spec.bridge.teePubkey,
    timelock: spec.bridge.timelock, watch_derived_addresses_in_wallet: false,
  })
  // Omission deliberately asks Core to derive this wallet from the helper seed.
  if (process.env[FEE_WALLET_KEY_ENV]) config.fee_wallet_pubkey = fee.publicKey
  else delete config.fee_wallet_pubkey
  helperFundingAmount(config) // Reject invalid budgets before asking for a payment.
  privateWrite(path.join(root, '.data/setup_defaults.toml'), toml.stringify(config))
}

/** Match the pinned Core helper's fee estimator for one input and one bridge tx. */
export function helperFundingAmount(config: any): number {
  for (const key of ['fee_wallet_target_amount', 'bridge_funding_target_amount', 'fee_rate_sat_per_kvb']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`Helper requires a positive integer ${key}`)
  }

  if (Math.floor(config.fee_wallet_target_amount / 10) < 1_000_000 || config.bridge_funding_target_amount < 1_000_000) throw new Error('Helper wallet/bridge outputs must satisfy the Core dust minimum (fee wallet is split into 10 outputs)')
  const fee = (vbytes: number) => Math.ceil(vbytes * config.fee_rate_sat_per_kvb / 1000)
  // setup: 1 input, 13 P2PKH outputs (sequencer, 10 fee, 1 prep, change).
  // fund-bridge: 1 input, P2PKH change, P2SH, marker, per Core calculate_fee.
  const amount = GENESIS_SEQUENCER_AMOUNT_SATS + Math.floor(config.fee_wallet_target_amount / 10) * 10 + config.bridge_funding_target_amount + fee(600) + fee(256)
  if (!Number.isSafeInteger(amount)) throw new Error('Helper funding budget exceeds safe integer range')
  return amount
}

export async function prepareManagedHelperFunding(root: string, spec: DeploymentSpec, rpc: Rpc): Promise<void> {
  const {data, file} = fundingInput(root, spec)
  const inputTemplate = {helper: {txid: 'REPLACE_WITH_HELPER_FUNDING_TXID', vout: 'REPLACE_WITH_OUTPUT_INDEX'}}
  if (Object.keys(data).length === 0) {
    Object.assign(data, inputTemplate)
    writeJson(file, data)
  }

  const address = bridgeSetupHelperAddress(helperSeed(root), spec.dogecoin.network)
  const config = readToml(root, 'setup_defaults.toml')
  const amountSats = helperFundingAmount(config)
  await verifyDogecoinNetwork(spec.dogecoin.network, rpc)
  if (await rpc('getblockcount', []) >= spec.bridge.timelock) throw new AwaitingInput({message: 'Recovery timelock is no longer in the future'})
  try {
    const fact = await inspectFunding(data.helper, {address, confirmations: spec.bridge.confirmationsRequired, minimumSats: amountSats}, rpc)
    config.base_funding_utxos = [{amount_sats: fact.amountSats, prev_tx_hex: fact.rawTransaction, txid: fact.txid, vout: fact.vout}]
    privateWrite(path.join(root, '.data/setup_defaults.toml'), toml.stringify(config))
    writeJson(path.join(root, '.data/helper-funding.json'), fact)
  } catch (error) {
    if (error instanceof AwaitingInput) throw new AwaitingInput({...error.details, address, amountSats, file,
      inputTemplate,
      message: `${error.message}. Edit helper.txid and helper.vout in ${file}; vout must be the numeric output index paying the displayed helper address. Core distributes the funds and adds the Bridge marker automatically`})
    throw error
  }
}

/** Core rewrites its construction manifest; restore runtime key backends after each action. */
export function bindManagedHelperWallets(root: string, spec: DeploymentSpec): void {
  if (!usesManagedHelper(spec)) throw new Error('Managed helper wallet binding requires production.funding: helper')
  const policy = spec.preparation!.bridge.production!
  const sequencer = productionSequencer(root, spec)
  const fee = productionFeeWallet(root, spec)
  const data = readJson(root, 'output-test-data.json')
  if (data.sequencer_address !== publicKeyAddress(sequencer.publicKey, spec.dogecoin.network) || data.fee_wallet_address !== fee.address || data.sequencer_utxo_vout !== 0) throw new Error('Core helper output identities do not match the prepared deployment')
  const config = readToml(root, 'output-withdrawal-processor.toml')
  if (config.genesis_sequencer_txid !== data.sequencer_utxo_txid || config.genesis_sequencer_vout !== 0) throw new Error('Core helper manifests disagree on the sequencer outpoint')
  config.fee_signer_key = `$ENV:${FEE_WALLET_KEY_ENV}`
  if (sequencer.kms) {config.sequencer_signer_kms = sequencer.kms; delete config.sequencer_signer_key}
  else {checkPrivateKey(sequencer.publicKey, policy.sequencerKeyEnv!); config.sequencer_signer_key = `$ENV:${policy.sequencerKeyEnv}`}

  privateWrite(path.join(root, '.data/output-withdrawal-processor.toml'), toml.stringify(config))
}

export async function verifyManagedHelperFunding(root: string, spec: DeploymentSpec, rpc: Rpc): Promise<void> {
  await verifyDogecoinNetwork(spec.dogecoin.network, rpc)
  const data = readJson(root, 'output-test-data.json')
  const bridge = readJson(root, 'bridge.json')
  const setup = readToml(root, 'setup_defaults.toml')
  const sequencer = await inspectFunding({txid: data.sequencer_utxo_txid, vout: data.sequencer_utxo_vout}, {address: publicKeyAddress(productionSequencer(root, spec).publicKey, spec.dogecoin.network), confirmations: spec.bridge.confirmationsRequired, exact: true, minimumSats: GENESIS_SEQUENCER_AMOUNT_SATS}, rpc)
  verifyProductionBridge(bridge, sequencer)
  if (sequencer.blockHash !== data.confirmed_block_hash || sequencer.blockHeight !== data.confirmed_block_height) throw new Error('Helper sequencer confirmation anchor changed')
  const feeWallet = productionFeeWallet(root, spec)
  if (!Array.isArray(data.fee_wallet_utxos) || data.fee_wallet_utxos.length !== 10) throw new Error('Expected ten helper fee-wallet outputs')
  const feeFacts = []
  for (const [index, point] of data.fee_wallet_utxos.entries()) {
    if (point.txid !== sequencer.txid || point.vout !== index + 1) throw new Error('Unexpected helper fee-wallet outpoint')
    feeFacts.push(await inspectFunding(point, {address: feeWallet.address, confirmations: spec.bridge.confirmationsRequired, exact: true, minimumSats: Math.floor(setup.fee_wallet_target_amount / 10)}, rpc))
  }

  const funding = data.initial_bridge_funding_utxos
  if (!Array.isArray(funding) || funding.length !== 1) throw new Error('Expected one marked Bridge funding output from Core')
  const bridgeFact = await inspectFunding(funding[0], {address: bridge.p2sh_address, confirmations: spec.bridge.confirmationsRequired, marker: true, minimumSats: setup.bridge_funding_target_amount}, rpc)
  if (await rpc('getblockcount', []) >= spec.bridge.timelock) throw new AwaitingInput({message: 'Recovery timelock is no longer in the future'})
  writeJson(path.join(root, '.data/production-wallet-funding.json'), {feeWalletOutputs: feeFacts, sequencer})
  writeJson(path.join(root, '.data/production-bridge-funding.json'), bridgeFact)
  const config = readToml(root, 'doge-config.toml')
  config.defaults ??= {}
  if (config.defaults.l2BootstrapNextStartingBlockHeight !== undefined) throw new Error('Helper genesis cannot initialize a snapshot continuation')
  config.defaults.dogecoinIndexerStartHeight = String(Math.max(0, sequencer.blockHeight - 1))
  config.defaults.l1GenesisBlock = String(sequencer.blockHeight)
  config.defaults.freshGenesisInit = true
  // Keep the previously validated Ethereum boundary instead of setup's latest tip.
  const anchor = readJson(root, 'production-ethereum-anchor.json')
  config.defaults.ethereumDaEmbeddedIndexerStartBlock = String(anchor.blockNumber)
  privateWrite(path.join(root, '.data/doge-config.toml'), toml.stringify(config))
}
