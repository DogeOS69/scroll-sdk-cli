/** Persistent, queue-driven remote GPU capacity managed by Core. */
export interface CapacityManagerConfig {
  /** Explicit transport selection. Omit only for legacy prepared HTTPS values. */
  connection?: {
    /** Independently managed internal ALB. No CloudFormation ownership is assumed. */
    existingAlb?: {listenerArn: string; loadBalancerArn: string; targetGroupArn: string}
    internalAlb?: {
      awsProfile?: string
      certificateArn: string
      hostname: string
      inboundCidrs: string[]
      region: string
      stackName: string
      subnets: string[]
      vpcId: string
    }
    mode: 'existing-alb' | 'existing-https' | 'internal-alb'
    serverUrl?: string
  }
  /**
   * Core #1612: a separately priced fleet used for 30 minutes after primary
   * no-capacity failures or provisioning timeouts. Any provider pair is accepted:
   * Core's fallback names only this fleet.
   */
  fallback?: {
    fleet: string
    gpu: 'A10G' | 'A100' | 'A6000' | 'L4' | 'L40S' | 'RTX3090' | 'RTX4090'
    /** Restrict the fallback fleet to these instance types (AWS); omit to match on GPU and resources. */
    instanceTypes?: string[]
    /** The fallback fleet's own `max_price`, independent of the primary price. */
    maxPricePerHourUsd: number
    /** Vast offer reliability floor; defaults to the primary value. */
    minReliability?: number
    provider: 'aws' | 'vastai'
    regions: string[]
  }
  /** Created empty by the install preflight, or checked without mutation when reusing. */
  fleet?: {
    action?: 'create' | 'reuse'
    cpus?: number
    diskSizeGiB?: number
    idleDurationSeconds?: number
    memoryGiB?: number
  }
  fleets: string[]
  gpu: 'A10G' | 'A100' | 'A6000' | 'L4' | 'L40S' | 'RTX3090' | 'RTX4090'
  image: {digest: string; repository: string}
  instanceTypes?: string[]
  maxHourlyCostUsd?: number
  /** The primary fleets' `max_price` and the manager's per-run price ceiling. */
  maxPricePerHourUsd?: number
  maxWorkers?: number
  /** Vast offer reliability floor, between 0.95 and 1 (default 0.95). */
  minReliability?: number
  minWorkers?: number
  /** Dedicated dstack project; defaults the imported controller project to this name. */
  project: string
  provider: 'aws' | 'vastai'
  regions: string[]
  /** Measured estimates used by Core's planner, not execution time limits. */
  runtimeEstimates?: {
    bridgeStateSeconds?: number
    l2RangeAggregationSeconds?: number
    scrollBatchSeconds?: number
    scrollChunkSeconds?: number
  }
  scaleDownTtlSeconds?: number
  /** Workers kept while work is queued but none is due (Core `global.steady_state_floor`, default 1); 0 keeps no idle GPU. */
  steadyStateFloor?: number
  targetDrainSeconds?: number
  /**
   * Planner estimate of one worker's hourly cost (Core `pool.hourly_cost_usd_per_worker`),
   * separate from any fleet's `max_price`. Must cover the primary and fallback
   * prices; defaults to the larger of the two.
   */
  workerBudgetUsdPerHour?: number
  workerIdPrefix?: string
}
