import type {ProofWorkersConfig} from '../types/proof-workers.js'

export const GPU_ARCHITECTURES = {A100: '80', A6000: '86', RTX3090: '86', RTX4090: '89'} as const
export const PROOF_WORKER_DEFAULTS: Required<ProofWorkersConfig> = {
  backend: 'vastai', count: 1, cpu: 8, diskGb: 200, gpu: 'RTX3090', idleTimeoutMinutes: 5,
  maxDurationHours: 2, maxPricePerHourUsd: 0.8, memoryGb: 64, minReliability: 0.95,
  regions: ['us-texas', 'us-colorado', 'us-washington'], rentalBudgetUsd: 3,
  startupTimeoutMinutes: 30, stopTimeoutMinutes: 13,
}

export function resolveProofWorkers(input: ProofWorkersConfig): Required<ProofWorkersConfig> {
  const config = {...PROOF_WORKER_DEFAULTS, ...input}
  if (config.backend !== 'vastai' || !(config.gpu in GPU_ARCHITECTURES)) throw new Error('proofWorkers requires Vast.ai and an explicitly supported GPU model')
  const integer = (key: keyof ProofWorkersConfig, min: number, max: number) => {
    const value = config[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`proofWorkers.${key} must be an integer from ${min} to ${max}`)
  }

  integer('count', 1, 8); integer('cpu', 8, 256); integer('memoryGb', 64, 2048); integer('diskGb', 200, 4096)
  integer('startupTimeoutMinutes', 5, 60); integer('stopTimeoutMinutes', 13, 30); integer('idleTimeoutMinutes', 1, 10)
  if (!Number.isFinite(config.maxDurationHours) || config.maxDurationHours < 0.25 || config.maxDurationHours > 48) throw new Error('proofWorkers.maxDurationHours must be between 0.25 and 48')
  if (!Number.isFinite(config.minReliability) || config.minReliability < 0.95 || config.minReliability > 1) throw new Error('proofWorkers.minReliability must be between 0.95 and 1')
  for (const key of ['maxPricePerHourUsd', 'rentalBudgetUsd'] as const) if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`proofWorkers.${key} must be positive`)
  if (!Array.isArray(config.regions) || config.regions.length === 0 || config.regions.some(r => typeof r !== 'string' || !/^[a-z][\da-z-]+$/.test(r))) throw new Error('proofWorkers.regions must contain explicit Vast.ai region names')
  const estimate = rentalEnvelope(config)
  if (estimate > config.rentalBudgetUsd) throw new Error(`proofWorkers rental envelope USD ${estimate.toFixed(2)} exceeds rentalBudgetUsd; include startup, drain, idle and two cleanup polling minutes`)
  return config
}

export function rentalSeconds(config: Required<ProofWorkersConfig>): number {
  return Math.ceil(config.maxDurationHours * 3600 + (config.startupTimeoutMinutes + config.stopTimeoutMinutes + config.idleTimeoutMinutes + 2) * 60)
}

export function rentalEnvelope(config: Required<ProofWorkersConfig>): number {
  return Math.ceil(config.count * config.maxPricePerHourUsd * rentalSeconds(config) / 3600 * 100) / 100
}
