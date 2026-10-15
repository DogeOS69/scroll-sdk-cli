/* eslint-disable perfectionist/sort-objects */
export type DeployedContract = {
  address?: string
  initialization?: {byteOffset: number} | {expectedAddress: string; getter: string}
  name: string
  optional?: boolean
  owned: boolean
  requiredWhen?: string
}

// scroll-contracts bdbe658: docker/scripts/deploy.sh -> DeployScroll.run("L2", ...).
// Only contracts reachable from deployL2Contracts1stPass/2ndPass are required.
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
]
