/** Persistent, queue-driven capacity. Mutually exclusive with bounded proofWorkers sessions. */
export interface CapacityManagerConfig {
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
  minWorkers?: number
  /** Dedicated dstack project; defaults the imported controller project to this name. */
  project: string
  provider: 'aws' | 'vastai'
  regions: string[]
  scaleDownTtlSeconds?: number
  targetDrainSeconds?: number
  workerIdPrefix?: string
}
