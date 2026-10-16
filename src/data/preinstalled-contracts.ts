/* eslint-disable perfectionist/sort-objects */
import {DeployedContract} from './contracts.js'

// Required canonical addresses and the Arachnid genesis prerequisite match
// dogeos-preinstalls v0.2.2, lib/verify.sh. Legacy Safe EIP-155 contracts remain
// optional even when their factory exists: v0.2.2 does not deploy that set.
// These are shared contracts, not operator-owned instances: check code presence,
// not owner() or proxy initialization. Full runtime codehash verification remains
// available through dogeos-preinstalls `make verify`.
export const preinstalledContracts: DeployedContract[] = [
  {name: 'Multicall3', address: '0xcA11bde05977b3631167028862bE2a173976CA11', owned: false},
  {name: 'CreateX', address: '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed', owned: false},
  {name: 'Arachnid', address: '0x4e59b44847b379578588920cA78FbF26c0B4956C', owned: false},
  {name: 'Permit2', address: '0x000000000022D473030F116dDEE9F6B43aC78BA3', owned: false},
  {name: 'GnosisSafeCanon', address: '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552', owned: false},
  {name: 'GnosisSafeL2Canon', address: '0x3E5c63644E683549055b9Be8653de26E0B4CD36E', owned: false},
  {name: 'MultiSendCanon', address: '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761', owned: false},
  {name: 'MultiSendCallOnlyCanon', address: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D', owned: false},
  {name: 'SafeProxyFactoryCanon', address: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2', owned: false},
  {name: 'SafeCompatFallbackCanon', address: '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4', owned: false},
  {name: 'CreateCallCanon', address: '0x7cbB62EaA69F79e6873cD1ecB2392971036cFAa4', owned: false},
  {name: 'SignMessageLibCanon', address: '0xA65387F16B013cf2Af4605Ad8aA5ec25a2cbA3a2', owned: false},
  {name: 'SimulateTxAccessorCanon', address: '0x59AD6735bCd8152B84860Cb256dD9e96b85F69Da', owned: false},
  {name: 'EntryPointV06', address: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789', owned: false},
  {name: 'SenderCreatorV06', address: '0x7fc98430eAEdbb6070B35B39D798725049088348', owned: false},
  {name: 'EntryPointV07', address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032', owned: false},
  {name: 'SenderCreatorV07', address: '0xEFC2c1444eBCC4Db75e7613d20C6a62fF67A167C', owned: false},
  {name: 'EntryPointV08', address: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108', owned: false},
  {name: 'SenderCreatorV08', address: '0x449ED7C3e6Fee6a97311d4b55475DF59C44AdD33', owned: false},
  {name: 'EntryPointV09', address: '0x433709009B8330FDa32311DF1C2AFA402eD8D009', owned: false},
  {name: 'SenderCreatorV09', address: '0x0A630a99Df908A81115A3022927Be82f9299987e', owned: false},
  {name: 'SafeSingletonFactory', address: '0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7', owned: false, optional: true},
  {name: 'GnosisSafe', address: '0x69f4D1788e39c87893C980c06EdF4b7f686e2938', owned: false, optional: true},
  {name: 'GnosisSafeL2', address: '0xfb1bffC9d739B8D520DaF37dF666da4C687191EA', owned: false, optional: true},
  {name: 'MultiSend', address: '0x998739BFdAAdde7C933B942a68053933098f9EDa', owned: false, optional: true},
  {name: 'MultiSendCallOnly', address: '0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B', owned: false, optional: true},
  {name: 'SafeProxyFactory', address: '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC', owned: false, optional: true},
  {name: 'SafeCompatFallback', address: '0x017062a1dE2FE6b99BE3d9d37841FeD19F573804', owned: false, optional: true},
]
