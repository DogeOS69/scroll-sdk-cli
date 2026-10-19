/** Persistent, queue-driven capacity. Mutually exclusive with bounded proofWorkers sessions. */
export interface CapacityManagerConfig {
  /** Explicit transport selection. Omit only for legacy prepared HTTPS values. */
  connection?: {
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
    mode: 'existing-https' | 'internal-alb'
    serverUrl?: string
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
  gpu: 'A100' | 'A6000' | 'L4' | 'L40S' | 'RTX3090' | 'RTX4090'
  image: {digest: string; repository: string}
  instanceTypes?: string[]
  maxHourlyCostUsd?: number
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
  targetDrainSeconds?: number
  workerIdPrefix?: string
}
