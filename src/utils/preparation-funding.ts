/* eslint-disable @typescript-eslint/no-explicit-any -- Dogecoin RPC and deployment TOML boundaries. */
import * as toml from '@iarna/toml'
import {Transaction} from 'bitcoinjs-lib'
import bitcore from 'bitcore-lib-doge'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {bridgeSetupHelperAddress} from '../commands/setup/bridge-init.js'
import {GENESIS_SEQUENCER_AMOUNT_SATS} from './bridge-constants.js'
import {resolveEnvValue} from './non-interactive.js'
import {AwaitingInput, localPath, privateWrite, writeJson} from './preparation-io.js'

export const BRIDGE_FUNDING_MARKER = '6a4901' + '00'.repeat(72)
export type Rpc = (method: string, params: unknown[]) => Promise<any>
export interface FundingFact {amountSats: number; blockHash: string; blockHeight: number; rawTransaction: string; txid: string; vout: number}
const networkOf = (network: string): any => network === 'mainnet' ? bitcore.Networks.livenet : network === 'regtest' ? bitcore.Networks.regtest : bitcore.Networks.testnet
export function publicKeyAddress(publicKey: string, network: string): string {
  return new bitcore.PublicKey(publicKey).toAddress(networkOf(network)).toString()
}

export function dogecoinRpc(root: string): Rpc {
  const config = toml.parse(fs.readFileSync(path.join(root, '.data/setup_defaults.toml'), 'utf8')) as any
  return async (method, params) => {
    try {
      const headers: Record<string, string> = {'content-type': 'application/json'}
      const user = resolveEnvValue(config.dogecoin_rpc_user) ?? ''
      const password = resolveEnvValue(config.dogecoin_rpc_pass) ?? ''
      if (user || password) headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
      const response = await fetch(resolveEnvValue(config.dogecoin_rpc_url)!, {body: JSON.stringify({id: 'scrollsdk-preparation', jsonrpc: '1.0', method, params}), headers, method: 'POST', signal: AbortSignal.timeout(15_000)})
      const data = await response.json() as any
      if (!response.ok || data.error || data.result === undefined) throw new Error('RPC failed')
      return data.result
    } catch {throw new AwaitingInput({message: `Dogecoin ${method} failed; check RPC availability and credentials, then rerun apply`})}
  }
}

/** Bind raw bytes, live unspent output and canonical confirmation block to the request. */
export async function inspectFunding(input: unknown, request: {address: string; confirmations: number; exact?: boolean; marker?: boolean; minimumSats: number}, rpc: Rpc): Promise<FundingFact> {
  const point = input as any
  if (!point || typeof point.txid !== 'string' || !/^[\da-f]{64}$/i.test(point.txid) || !Number.isSafeInteger(point.vout) || point.vout < 0 || point.vout > 0xFF_FF_FF_FF) throw new AwaitingInput({message: 'Supply a valid funding txid and vout'})
  const txid = point.txid.toLowerCase()
  const live = await rpc('gettxout', [txid, point.vout, true])
  if (!live) throw new AwaitingInput({message: 'Funding output is absent or already spent'})
  if (!Number.isSafeInteger(live.confirmations) || live.confirmations < request.confirmations) throw new AwaitingInput({message: `Funding output needs at least ${request.confirmations} confirmations`})
  const raw = await rpc('getrawtransaction', [txid, true])
  let transaction: Transaction
  try {transaction = Transaction.fromHex(raw.hex)} catch {throw new Error('RPC returned invalid funding transaction bytes')}
  if (transaction.getId() !== txid || !transaction.outs[point.vout]) throw new Error('Funding raw transaction does not match the selected outpoint')
  const output = transaction.outs[point.vout]
  const amountSats = Number(output.value)
  const script = Buffer.from(output.script).toString('hex')
  if (script !== bitcore.Script.fromAddress(request.address).toHex() || live.scriptPubKey?.hex !== script) throw new AwaitingInput({message: 'Funding output pays a different address'})
  if (!Number.isSafeInteger(amountSats) || amountSats < request.minimumSats || request.exact && amountSats !== request.minimumSats) throw new AwaitingInput({message: `Funding output must contain ${request.exact ? 'exactly' : 'at least'} ${request.minimumSats} satoshis`})
  if (Math.round(Number(live.value) * 100_000_000) !== amountSats) throw new Error('Funding amount disagrees between live UTXO and raw transaction')
  if (request.marker) {
    const returns = transaction.outs.filter(out => out.script[0] === 0x6A)
    if (returns.length !== 1 || returns[0].value !== 0n || Buffer.from(returns[0].script).toString('hex') !== BRIDGE_FUNDING_MARKER) throw new AwaitingInput({markerScript: BRIDGE_FUNDING_MARKER, message: 'Bridge funding requires exactly one zero-value OP_RETURN with the displayed bridge-funding marker; a plain payment or deposit is not accepted'})
  }

  if (typeof raw.blockhash !== 'string' || !/^[\da-f]{64}$/i.test(raw.blockhash)) throw new AwaitingInput({message: 'Funding transaction has no confirmed block'})
  const header = await rpc('getblockheader', [raw.blockhash])
  if (!Number.isSafeInteger(header.height) || header.height < 0 || !Number.isSafeInteger(header.confirmations) || header.confirmations < request.confirmations || await rpc('getblockhash', [header.height]) !== raw.blockhash) throw new AwaitingInput({message: 'Funding block is not sufficiently confirmed on the active chain'})
  return {amountSats, blockHash: raw.blockhash, blockHeight: header.height, rawTransaction: raw.hex, txid, vout: point.vout}
}

export function fundingInput(root: string, spec: DeploymentSpec): {data: any; file: string} {
  const file = localPath(root, spec.preparation!.bridge.fundingFile ?? '.scrollsdk/inputs/bridge-funding.json')
  if (!fs.existsSync(file)) writeJson(file, {})
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected an object')
    return {data, file}
  } catch {throw new AwaitingInput({file, message: 'Funding input must be valid JSON'})}
}

export function checkPrivateKey(publicKey: string, variable: string): void {
  const value = process.env[variable]
  if (!value) throw new AwaitingInput({message: `Set ${variable} to the externally managed wallet key before continuing`})
  try {
    const key = new bitcore.PrivateKey(value)
    if (key.toPublicKey().toString() !== publicKey.toLowerCase()) throw new Error('mismatch')
  } catch {throw new AwaitingInput({message: `Wallet key in ${variable} does not match its declared compressed public key`})}
}

export async function verifyDogecoinNetwork(network: string, rpc: Rpc): Promise<void> {
  const expected = network === 'mainnet' ? 'main' : network === 'testnet' ? 'test' : 'regtest'
  const info = await rpc('getblockchaininfo', [])
  if (info?.chain !== expected) throw new AwaitingInput({message: 'Dogecoin RPC network does not match the selected spec network'})
}

export async function prepareProductionWallets(root: string, spec: DeploymentSpec, rpc: Rpc): Promise<void> {
  const policy = spec.preparation!.bridge.production!
  await verifyDogecoinNetwork(spec.dogecoin.network, rpc)
  checkPrivateKey(policy.sequencerPublicKey, policy.sequencerKeyEnv)
  checkPrivateKey(policy.feeWalletPublicKey, policy.feeWalletKeyEnv)
  if (await rpc('getblockcount', []) >= spec.bridge.timelock) throw new AwaitingInput({message: 'Recovery timelock is not in the future; use a reviewed future block height in a new plan'})
  const {data, file} = fundingInput(root, spec)
  const addresses = {feeWallet: publicKeyAddress(policy.feeWalletPublicKey, spec.dogecoin.network), sequencer: publicKeyAddress(policy.sequencerPublicKey, spec.dogecoin.network)}
  const setupPath = path.join(root, '.data/setup_defaults.toml')
  const setup = toml.parse(fs.readFileSync(setupPath, 'utf8')) as any
  const facts: Record<string, FundingFact> = {}
  for (const role of ['sequencer', 'feeWallet'] as const) {
    const amount = role === 'sequencer' ? GENESIS_SEQUENCER_AMOUNT_SATS : setup.fee_wallet_target_amount
    try {facts[role] = await inspectFunding(data[role], {address: addresses[role], confirmations: spec.bridge.confirmationsRequired, exact: role === 'sequencer', minimumSats: amount}, rpc)} catch (error) {
      if (error instanceof AwaitingInput) throw new AwaitingInput({...error.details, address: addresses[role], amountSats: amount, file, fundingRequests: [
        {address: addresses.sequencer, amountSats: GENESIS_SEQUENCER_AMOUNT_SATS, role: 'sequencer'},
        {address: addresses.feeWallet, amountSats: setup.fee_wallet_target_amount, role: 'feeWallet'},
      ], inputTemplate: {feeWallet: {txid: 'REPLACE_WITH_FEE_WALLET_TXID', vout: 'REPLACE_WITH_OUTPUT_INDEX'}, sequencer: {txid: 'REPLACE_WITH_SEQUENCER_TXID', vout: 'REPLACE_WITH_OUTPUT_INDEX'}}, message: `${role}: ${error.message}. Record ${role}.txid and ${role}.vout in the funding input`})
      throw error
    }
  }

  if (facts.sequencer.txid === facts.feeWallet.txid && facts.sequencer.vout === facts.feeWallet.vout) throw new Error('Sequencer and fee wallet must use distinct outpoints')
  if (!Array.isArray(setup.attestation_pubkeys) || setup.attestation_pubkeys.length === 0) throw new AwaitingInput({message: 'Import the selected attestation descriptors before Bridge preparation'})
  writeJson(path.join(root, '.data/production-wallet-funding.json'), facts)
  privateWrite(path.join(root, '.data/GenerateBridgeInfo.toml'), toml.stringify({default: {
    attestation: {pubkeys: setup.attestation_pubkeys, threshold: setup.attestation_threshold},
    namespace_id: Array.from({length: 20}, () => 0), network: spec.dogecoin.network === 'mainnet' ? 'dogecoin' : spec.dogecoin.network,
    recovery: {pubkeys: policy.recoveryPublicKeys, threshold: spec.bridge.thresholds.recovery},
    tee_pubkey: spec.bridge.teePubkey!,
    timelock: spec.bridge.timelock,
  }}))
  privateWrite(path.join(root, '.data/output-withdrawal-processor.toml'), toml.stringify({
    bridge_address: '', bridge_script_hex: '',
    fee_signer_key: `$ENV:${policy.feeWalletKeyEnv}`, genesis_sequencer_tx_hex: facts.sequencer.rawTransaction,
    genesis_sequencer_txid: facts.sequencer.txid, genesis_sequencer_vout: facts.sequencer.vout, network_str: spec.dogecoin.network,
    sequencer_signer_key: `$ENV:${policy.sequencerKeyEnv}`,
  }))
  writeJson(path.join(root, '.data/output-test-data.json'), {
    confirmed_block_hash: facts.sequencer.blockHash, confirmed_block_height: facts.sequencer.blockHeight,
    fee_wallet_address: addresses.feeWallet, sequencer_address: addresses.sequencer,
  })
}

/** Revalidate the anchors immediately before accepting the final Bridge inventory. */
export async function prepareProductionBridgeFunding(root: string, spec: DeploymentSpec, rpc: Rpc): Promise<void> {
  const {data, file} = fundingInput(root, spec)
  const bridge = JSON.parse(fs.readFileSync(path.join(root, '.data/bridge.json'), 'utf8'))
  const setup = toml.parse(fs.readFileSync(path.join(root, '.data/setup_defaults.toml'), 'utf8')) as any
  const facts = JSON.parse(fs.readFileSync(path.join(root, '.data/production-wallet-funding.json'), 'utf8'))
  const policy = spec.preparation!.bridge.production!
  await verifyDogecoinNetwork(spec.dogecoin.network, rpc)
  verifyProductionBridge(bridge, facts.sequencer)
  const current = await inspectFunding(facts.sequencer, {address: publicKeyAddress(policy.sequencerPublicKey, spec.dogecoin.network), confirmations: spec.bridge.confirmationsRequired, exact: true, minimumSats: GENESIS_SEQUENCER_AMOUNT_SATS}, rpc)
  if (current.blockHash !== facts.sequencer.blockHash) throw new Error('Sequencer confirmation anchor changed; review the reorganization before continuing')
  await inspectFunding(facts.feeWallet, {address: publicKeyAddress(policy.feeWalletPublicKey, spec.dogecoin.network), confirmations: spec.bridge.confirmationsRequired, minimumSats: setup.fee_wallet_target_amount}, rpc)
  if (await rpc('getblockcount', []) >= spec.bridge.timelock) throw new AwaitingInput({message: 'Recovery timelock is no longer in the future'})
  let funded: FundingFact
  try {funded = await inspectFunding(data.bridge, {address: bridge.p2sh_address, confirmations: spec.bridge.confirmationsRequired, marker: true, minimumSats: setup.bridge_target_amount}, rpc)} catch (error) {
    if (error instanceof AwaitingInput) throw new AwaitingInput({...error.details, address: bridge.p2sh_address, amountSats: setup.bridge_target_amount, file, inputTemplate: {bridge: {txid: 'REPLACE_WITH_BRIDGE_FUNDING_TXID', vout: 'REPLACE_WITH_OUTPUT_INDEX'}}, markerScript: BRIDGE_FUNDING_MARKER, message: `${error.message}. Record bridge.txid and bridge.vout in the funding input`})
    throw error
  }

  writeJson(path.join(root, '.data/production-bridge-funding.json'), funded)
  const manifestPath = path.join(root, '.data/output-withdrawal-processor.toml')
  const manifest = toml.parse(fs.readFileSync(manifestPath, 'utf8')) as any
  manifest.bridge_address = bridge.p2sh_address
  manifest.bridge_script_hex = bridge.redeem_script_hex
  privateWrite(manifestPath, toml.stringify(manifest))
  const configPath = path.join(root, '.data/doge-config.toml')
  const config = toml.parse(fs.readFileSync(configPath, 'utf8')) as any
  config.defaults ??= {}
  if (config.defaults.l2BootstrapNextStartingBlockHeight !== undefined) throw new Error('Production genesis cannot initialize a snapshot continuation')
  const firstHeight = Math.min(facts.sequencer.blockHeight, facts.feeWallet.blockHeight, funded.blockHeight)
  config.defaults.dogecoinIndexerStartHeight = String(Math.max(0, firstHeight - 1))
  config.defaults.l1GenesisBlock = String(facts.sequencer.blockHeight)
  config.defaults.freshGenesisInit = true
  privateWrite(configPath, toml.stringify(config))
}

export async function prepareHelperFunding(root: string, spec: DeploymentSpec, rpc: Rpc): Promise<void> {
  const {data, file} = fundingInput(root, spec)
  const address = bridgeSetupHelperAddress(spec.bridge.seedString!, spec.dogecoin.network)
  if (!Array.isArray(data.helper) || data.helper.length === 0) throw new AwaitingInput({address, file, message: 'Fund the test helper and supply helper: [{txid, vout}] in the funding input'})
  const facts: FundingFact[] = []
  for (const point of data.helper) facts.push(await inspectFunding(point, {address, confirmations: spec.bridge.confirmationsRequired, minimumSats: 1}, rpc))
  if (new Set(facts.map(f => `${f.txid}:${f.vout}`)).size !== facts.length) throw new Error('Duplicate helper funding outpoint')
  const configPath = path.join(root, '.data/setup_defaults.toml')
  const config = toml.parse(fs.readFileSync(configPath, 'utf8')) as any
  config.base_funding_utxos = facts.map(f => ({amount_sats: f.amountSats, prev_tx_hex: f.rawTransaction, txid: f.txid, vout: f.vout}))
  privateWrite(configPath, toml.stringify(config))
}


export function verifyProductionBridge(bridge: any, point: {txid: string; vout: number}): void {
  const index = Buffer.alloc(4); index.writeUInt32BE(point.vout)
  const hash160 = (bytes: Buffer) => createHash('ripemd160').update(createHash('sha256').update(bytes).digest()).digest('hex')
  const namespace = hash160(Buffer.concat([Buffer.from('dogeos-bridge-namespace-v1'), Buffer.from(point.txid, 'hex'), index]))
  if (typeof bridge.redeem_script_hex !== 'string' || !/^[\da-f]+$/i.test(bridge.redeem_script_hex) || !bridge.redeem_script_hex.toLowerCase().startsWith(`14${namespace}75`)) throw new Error('Bridge script namespace does not bind the selected genesis sequencer outpoint')
  const script = `a914${hash160(Buffer.from(bridge.redeem_script_hex, 'hex'))}87`
  if (bridge.script_pubkey_hex !== script || bitcore.Script.fromAddress(bridge.p2sh_address).toHex() !== script) throw new Error('Bridge address, scriptPubKey and redeem script disagree')
}

export async function prepareEthereumAnchor(root: string, spec: DeploymentSpec, injectedRpc?: Rpc): Promise<void> {
  const anchor = spec.preparation!.bridge.production!.ethereumAnchor
  const endpoint = spec.ethereumDa!.l1RpcUrl
  const rpc = injectedRpc ?? (async (method: string, params: unknown[]): Promise<any> => {
    try {
      const response = await fetch(endpoint!, {body: JSON.stringify({id: 1, jsonrpc: '2.0', method, params}), headers: {'content-type': 'application/json'}, method: 'POST', signal: AbortSignal.timeout(15_000)})
      const body = await response.json() as any
      if (!response.ok || body.error || body.result === undefined) throw new Error('RPC failure')
      return body.result
    } catch {throw new AwaitingInput({message: `Ethereum ${method} failed; check the selected RPC`})}
  })

  if (Number.parseInt(await rpc('eth_chainId', []), 16) !== spec.ethereumDa!.chainId) throw new Error('Ethereum RPC chain ID does not match spec')
  const receiptPath = path.join(root, '.data/production-ethereum-anchor.json')
  const saved = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : undefined
  if (saved && (saved.chainId !== spec.ethereumDa!.chainId || !Number.isSafeInteger(saved.blockNumber) || saved.blockNumber < 0
    || !Number.isSafeInteger(saved.transactionIndex) || saved.transactionIndex < 0 || !/^0x[\da-f]{64}$/i.test(saved.blockHash))) throw new Error('Saved Ethereum anchor is invalid')
  const selectedNumber = saved?.blockNumber ?? anchor.blockNumber
  const selector = selectedNumber === undefined ? 'finalized' : `0x${selectedNumber.toString(16)}`
  const transactionIndex = saved?.transactionIndex ?? anchor.transactionIndex ?? 0
  const block = await rpc('eth_getBlockByNumber', [selector, false])
  const blockNumber = Number.parseInt(block?.number, 16)
  if (!block || !/^0x[\da-f]{64}$/i.test(block.hash) || !Number.isSafeInteger(blockNumber) || blockNumber < 0
    || selectedNumber !== undefined && blockNumber !== selectedNumber || !Array.isArray(block.transactions)
    || transactionIndex > Math.max(0, block.transactions.length - 1)) throw new AwaitingInput({message: 'Ethereum DA anchor is unavailable or has an invalid transaction index; finalized selection requires an RPC supporting the finalized tag'})
  if (saved && saved.blockHash !== block.hash) throw new Error('Saved Ethereum anchor is no longer canonical; reconcile before continuing')
  if (!saved && anchor.blockTag === 'finalized') {
    const canonical = await rpc('eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false])
    if (canonical?.hash !== block.hash) throw new AwaitingInput({message: 'Finalized Ethereum anchor changed during selection; retry with a consistent RPC'})
  }

  // Persist before updating derived files so a partial retry cannot move the boundary.
  if (!saved) writeJson(receiptPath, {blockHash: block.hash, blockNumber, chainId: spec.ethereumDa!.chainId, transactionIndex})
  const file = path.join(root, '.data/protocol_seed.toml')
  const seed = toml.parse(fs.readFileSync(file, 'utf8')) as any
  seed.chain_anchors.initial_ethereum_block_hash = block.hash
  seed.chain_anchors.initial_tx_index = transactionIndex
  delete seed.chain_anchors.initial_tx_blob_index
  privateWrite(file, toml.stringify(seed))
  const configPath = path.join(root, '.data/doge-config.toml')
  const config = toml.parse(fs.readFileSync(configPath, 'utf8')) as any
  config.defaults ??= {}
  config.defaults.ethereumDaEmbeddedIndexerStartBlock = String(blockNumber)
  privateWrite(configPath, toml.stringify(config))
}
