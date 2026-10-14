/** Persistent, queue-driven capacity. Mutually exclusive with bounded proofWorkers sessions. */
export interface CapacityManagerConfig {
  fleets: string[]
  gpu: 'A100' | 'A6000' | 'L4' | 'L40S' | 'RTX3090' | 'RTX4090'
  image: {digest: string; repository: string}
  instanceTypes?: string[]
  maxHourlyCostUsd?: number
  maxPricePerHourUsd?: number
  maxWorkers?: number
  minWorkers?: number
  /** A dedicated, already configured dstack project and fleet. */
  project: string
  provider: 'aws' | 'vastai'
  regions: string[]
  scaleDownTtlSeconds?: number
  targetDrainSeconds?: number
  workerIdPrefix?: string
}
