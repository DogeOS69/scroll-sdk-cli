import type {EthereumDaConfig} from '../types/deployment-spec.js'

/** Shared submitter settings carried by DeploymentSpec and doge-config. */
export interface EthereumDaRuntimeConfig {
  confirmationDepth?: number | string
  confirmerPollIntervalMs?: number | string
  fetchLimit?: number | string
  finalizationDepth?: number | string
  l2Confirmations?: number | string
  l2RpcUrl?: string
  lifecycleDbPath?: string
  maxBlobBaseFeeWei?: string
  maxFeePerGasWei?: string
  minPriorityFeeWei?: string
  submitterDbPath?: string
}

export const ETHEREUM_DA_RUNTIME_FIELDS = [
  'confirmationDepth', 'confirmerPollIntervalMs', 'fetchLimit', 'finalizationDepth',
  'l2Confirmations', 'l2RpcUrl', 'lifecycleDbPath', 'maxBlobBaseFeeWei',
  'maxFeePerGasWei', 'minPriorityFeeWei', 'submitterDbPath',
] as const satisfies readonly (keyof EthereumDaRuntimeConfig)[]

/** Emit only explicit intent; an absent field must not reset existing values. */
export function ethereumDaRuntimeEnv(config: EthereumDaRuntimeConfig): Record<string, string> {
  const fields = {
    confirmationDepth: 'ETHEREUM__CONFIRMATION_DEPTH',
    confirmerPollIntervalMs: 'ETHEREUM__CONFIRMER_POLL_INTERVAL_MS',
    fetchLimit: 'L2__FETCH_LIMIT',
    finalizationDepth: 'ETHEREUM__FINALIZATION_DEPTH',
    l2Confirmations: 'L2__CONFIRMATIONS',
    l2RpcUrl: 'L2__RPC_URL',
    lifecycleDbPath: 'STORE__LIFECYCLE_DB_PATH',
    maxBlobBaseFeeWei: 'ETHEREUM__MAX_BLOB_BASE_FEE_WEI',
    maxFeePerGasWei: 'ETHEREUM__MAX_FEE_PER_GAS_WEI',
    minPriorityFeeWei: 'ETHEREUM__MIN_PRIORITY_FEE_WEI',
    submitterDbPath: 'STORE__SUBMITTER_DB_PATH',
  } as const
  const env: Record<string, string> = {}
  for (const key of ETHEREUM_DA_RUNTIME_FIELDS) {
    const value = config[key]
    if (value !== undefined) env[`DOGEOS_ETH_DA_SUBMITTER_${fields[key]}`] = String(value)
  }

  if (config.submitterDbPath !== undefined && config.lifecycleDbPath === undefined) {
    env.DOGEOS_ETH_DA_SUBMITTER_STORE__LIFECYCLE_DB_PATH = config.submitterDbPath
  }

  return env
}

/** Fixed mainnet policy, shared by spec validation and legacy chart preparation. */
export function ethereumDaMainnetPolicyErrors(
  chain: EthereumDaConfig['chain'],
  runtime: EthereumDaRuntimeConfig = {},
  maxPendingBlobTxs?: number | string,
): Array<{message: string; path: string}> {
  if (chain !== 'mainnet') return []
  return ([
    ['publish.maxPendingBlobTxs', maxPendingBlobTxs, 10],
    ['confirmationDepth', runtime.confirmationDepth, 8],
    ['finalizationDepth', runtime.finalizationDepth, 8],
  ] as const).flatMap(([field, value, required]) => value === undefined || value === required || value === String(required)
    ? [] : [{message: `ethereumDa.${field} must be ${required} when ethereumDa.chain is mainnet`, path: `ethereumDa.${field}`}])
}

/** Omitted mainnet fields are filled; explicit conflicts must never be overwritten. */
export function resolveEthereumDaSubmitterPolicy(
  chain: EthereumDaConfig['chain'],
  runtime: EthereumDaRuntimeConfig = {},
  maxPendingBlobTxs?: number | string,
): {maxPendingBlobTxs: number | string | undefined; runtime: EthereumDaRuntimeConfig} {
  const errors = ethereumDaMainnetPolicyErrors(chain, runtime, maxPendingBlobTxs)
  if (errors.length > 0) throw new Error(errors.map(error => error.message).join('; '))
  return {
    maxPendingBlobTxs: maxPendingBlobTxs ?? (chain === undefined ? undefined : 10),
    runtime: chain === 'mainnet' ? {...runtime, confirmationDepth: 8, finalizationDepth: 8} : runtime,
  }
}
