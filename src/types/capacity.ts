import type {CapacityManagerConfig} from './capacity-manager.js'

export const CAPACITY_API_VERSION = 'scrollsdk.dogeos/capacity/v1'

/** One dstack fleet and the selectors the manager uses for it. */
export interface CapacityPool {
  fleet: string
  gpu: CapacityManagerConfig['gpu']
  instanceTypes?: string[]
  /** The fleet's `max_price`; for the primary also the manager's per-run ceiling. */
  maxPricePerHourUsd: number
  /** Vast offer reliability floor, 0.95 to 1 (default 0.95). */
  minReliability?: number
  provider: 'aws' | 'vastai'
  regions: string[]
}

/**
 * Runtime GPU capacity of a prepared deployment (`capacity.yaml`). Not part of
 * the frozen intent: `scrollsdk capacity deploy` (or `render`) turns it into the dstack
 * config.yml and the chart values that change a running deployment.
 * Holds environment variable names, never credential values.
 */
export interface CapacityDocument {
  apiVersion: typeof CAPACITY_API_VERSION
  /** Used for 30 minutes after primary no-capacity failures or provisioning timeouts. */
  fallback?: CapacityPool
  primary: CapacityPool
  /** The dstack project; it must stay the controller's project. */
  project: string
  providers: {
    /** Uses the controller's workload role; requires the controller's AWS identity. */
    aws?: {iamInstanceProfile?: string; publicIps?: boolean; vpcIds: Record<string, string>}
    vastai?: {apiKeyEnv: string}
  }
  /** Shared by every fleet. */
  resources?: {cpus?: number; diskGiB?: number; idleSeconds?: number; memoryGiB?: number}
  runtimeEstimates?: CapacityManagerConfig['runtimeEstimates']
  scaling?: {
    maxHourlyCostUsd?: number
    maxWorkers?: number
    minWorkers?: number
    scaleDownTtlSeconds?: number
    /** Core `global.steady_state_floor` (default 1); 0 keeps no idle GPU. */
    steadyStateFloor?: number
    targetDrainSeconds?: number
    /** Core `pool.hourly_cost_usd_per_worker`; must cover both pool prices (default: the larger). */
    workerBudgetUsdPerHour?: number
  }
}
