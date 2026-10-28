/* eslint-disable @typescript-eslint/no-explicit-any -- Existing contract TOML boundary. */
import * as toml from '@iarna/toml'
import {Wallet, ZeroAddress} from 'ethers'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'
import type {Invoke} from './preparation-runner.js'

import {CONTRACTS_DOCKER_DEFAULT_TAG} from '../constants/docker.js'
import {writeConfigs} from './config-writer.js'
import {inspectContractOwner} from './contract-owner.js'
import {normalizeNativeRethGenesis} from './native-reth-genesis.js'
import {resolveEnvValue} from './non-interactive.js'
import {digest, localPath, privateWrite, writeJson} from './preparation-io.js'

/** rc.6 does not authorize runtime signers in genesis. Its shared config reader
 * still requires a Fee Oracle address. Supply the deployer only in an isolated
 * generator input; never project this value into runtime config or IAM intent. */
export async function prepareLocalGenesis(root: string, spec: DeploymentSpec, invoke: Invoke): Promise<void> {
  const configPath = localPath(root, 'config.toml')
  const config = toml.parse(fs.readFileSync(configPath, 'utf8')) as any
  config.accounts ??= {}
  const {accounts} = config
  const supplied = accounts.DEPLOYER_PRIVATE_KEY
  let wallet: ReturnType<typeof Wallet.createRandom> | Wallet
  try {
    if (!supplied && accounts.DEPLOYER_ADDR) throw new Error('missing key')
    wallet = supplied ? new Wallet(resolveEnvValue(supplied) || '') : Wallet.createRandom()
    if (accounts.DEPLOYER_ADDR && accounts.DEPLOYER_ADDR.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('mismatch')
  } catch {throw new Error('Deployer private key is missing, invalid or does not match its address (contents omitted)')}

  accounts.DEPLOYER_PRIVATE_KEY = supplied || wallet.privateKey
  accounts.DEPLOYER_ADDR = wallet.address
  accounts.OWNER_ADDR ||= wallet.address
  inspectContractOwner(accounts)
  if (!writeConfigs(config, localPath(root, 'config.public.toml'), configPath, true)) throw new Error('Cannot save genesis deployer identity')
  fs.chmodSync(configPath, 0o600)

  const stage = localPath(root, '.scrollsdk/genesis-build')
  fs.mkdirSync(stage, {mode: 0o700, recursive: true})
  const input = structuredClone(config)
  input.accounts.L2_GAS_ORACLE_SENDER_ADDR = wallet.address
  delete input.accounts.L2_GAS_ORACLE_SENDER_PRIVATE_KEY
  input.sequencer = {...input.sequencer, L2GETH_SIGNER_ADDRESS: ZeroAddress}
  privateWrite(localPath(stage, 'config.toml'), toml.stringify(input))
  // Remove outputs from an interrupted attempt so stale files cannot pass checks.
  for (const name of ['genesis.yaml', 'values/genesis.yaml', 'config-contracts.toml', 'frontend-config.yaml']) fs.rmSync(localPath(stage, name), {force: true})
  const source = spec.preparation?.genesis?.contractsSource
  await invoke(stage, 'genesis-local', ['gen-l2-artifacts', '-N', '--skip-deployment-salt-update', '--skip-l1-fee-vault-update',
    ...(source ? ['--contracts-source', path.resolve(root, source)] : []),
  ])
  let wrapped = fs.readFileSync(localPath(stage, 'values/genesis.yaml'), 'utf8')
  const document = yaml.load(wrapped) as {scrollConfig?: unknown}
  let genesis = typeof document.scrollConfig === 'string' ? JSON.parse(document.scrollConfig) : document.scrollConfig
  if (!genesis || typeof genesis !== 'object' || !genesis.alloc || genesis.config?.chainId !== spec.network.l2ChainId) throw new Error('Genesis generator returned invalid genesis or the wrong chain ID')
  genesis = normalizeNativeRethGenesis(genesis)
  document.scrollConfig = typeof document.scrollConfig === 'string' ? JSON.stringify(genesis, null, 2) : genesis
  wrapped = yaml.dump(document, {lineWidth: -1, noRefs: true})
  for (const file of ['genesis.yaml', 'values/genesis.yaml']) privateWrite(localPath(root, file), wrapped)
  const json = JSON.stringify(genesis, null, 2) + '\n'
  for (const file of ['genesis.json', '.data/genesis.json']) privateWrite(localPath(root, file), json)
  privateWrite(localPath(root, 'config-contracts.toml'), fs.readFileSync(localPath(stage, 'config-contracts.toml')))
  writeJson(localPath(root, '.data/genesis-generation.json'), {
    deployerAddress: wallet.address, generator: source ? {contractsSource: path.resolve(root, source)} : {imageTag: `gen-configs-${CONTRACTS_DOCKER_DEFAULT_TAG}`}, genesisSha256: digest(json),
    note: 'Runtime Fee Oracle and sequencer identities are prepared separately; generator-only inputs are not service identities.',
    schema: 'scrollsdk/genesis-generation/v1',
  })
}
