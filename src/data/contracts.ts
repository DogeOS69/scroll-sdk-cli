/* eslint-disable perfectionist/sort-objects */
import {GENESIS_PREDEPLOYS} from '../constants/deployment.js'

export type DeployedContract = {
  address?: string
  initialization?: {byteOffset: number} | {expectedAddress: string; getter: string}
  name: string
  optional?: boolean
  owned: boolean
  requiredWhen?: string
}

// scroll-contracts bdbe658: docker/scripts/deploy.sh -> DeployScroll.run("L2", ...).
// Includes contracts used by deployL2Contracts1stPass/2ndPass and the two
// additional genesis-only contracts from GenerateGenesis.generateGenesisAlloc.
// The first five entries can already exist in genesis and are reused by deploy.sh.
// Constructor-owned contracts do not have an Initializable flag. For the queue,
// gas oracle and fee vault, check the address wired by initializeL2Contracts.
export const contracts: DeployedContract[] = [
  {name: 'L2_MESSAGE_QUEUE_ADDR', owned: true, initialization: {getter: 'messenger', expectedAddress: 'L2_DOGEOS_MESSENGER_PROXY_ADDR'}},
  {name: 'L1_GAS_PRICE_ORACLE_ADDR', owned: true, initialization: {getter: 'whitelist', expectedAddress: 'L2_WHITELIST_ADDR'}},
  {name: 'L2_WHITELIST_ADDR', owned: true},
  {name: 'L2_WDOGE_ADDR', owned: false},
  {name: 'L2_TX_FEE_VAULT_ADDR', owned: true, initialization: {getter: 'messenger', expectedAddress: 'L2_FEE_VAULT_MOAT_ADAPTER_ADDR'}},
  {name: 'L2_PROXY_ADMIN_ADDR', owned: true},
  {name: 'L2_PROXY_IMPLEMENTATION_PLACEHOLDER_ADDR', owned: false},
  {name: 'L2_DOGEOS_MESSENGER_PROXY_ADDR', owned: true, initialization: {byteOffset: 0}},
  {name: 'L2_MOAT_PROXY_ADDR', owned: true, initialization: {byteOffset: 20}},
  {name: 'L2_SYSTEM_CONFIG_IMPLEMENTATION_ADDR', owned: false},
  {name: 'L2_SYSTEM_CONFIG_PROXY_ADDR', owned: true, initialization: {byteOffset: 0}},
  {name: 'L2_DOGEOS_MESSENGER_IMPLEMENTATION_ADDR', owned: false},
  {name: 'L2_FEE_VAULT_MOAT_ADAPTER_ADDR', owned: false},
  {name: 'L2_MOAT_IMPLEMENTATION_ADDR', owned: false},
  // Genesis-only runtime contracts: no operator owner or proxy initializer.
  {name: 'L2_NATIVE_DOGE_TOKEN_ADDR', address: GENESIS_PREDEPLOYS.L2_NATIVE_DOGE_TOKEN, owned: false},
  {name: 'BLOCK_HASH_HISTORY_ADDR', address: '0x0000f90827f1c53a10cb7a02335b175320002935', owned: false},
]
