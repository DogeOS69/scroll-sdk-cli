/** Optional, separately applied GPU capacity. All prices are USD rental ceilings, not quotations. */
export interface ProofWorkersConfig {
  backend?: 'aws' | 'vastai'
  count?: number
  /** One GPU per worker. Minimum host resources. */
  cpu?: number
  diskGb?: number
  gpu?: 'A100' | 'A6000' | 'L4' | 'RTX3090' | 'RTX4090'
  idleTimeoutMinutes?: number
  maxDurationHours?: number
  maxPricePerHourUsd?: number
  memoryGb?: number
  minReliability?: number
  regions?: string[]
  /** Admission budget for bounded instance rental, excluding storage/network/tax. */
  rentalBudgetUsd?: number
  startupTimeoutMinutes?: number
  stopTimeoutMinutes?: number
}
