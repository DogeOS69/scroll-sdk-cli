export const MAX_U32 = 4_294_967_295

export const PRE_TSUKI_DIRECT_SIGN_TSO_ENV =
  'TSO_PRE_TSUKI_DIRECT_SIGN_MAX_END_BATCH_HEIGHT'

export const PRE_TSUKI_DIRECT_SIGN_ATTESTATION_SIGNER_ENV =
  'ATTESTATION_SIGNER_PRE_TSUKI_DIRECT_SIGN_MAX_END_BATCH_HEIGHT'

export interface PreTsukiDirectSignIntent {
  maxEndBatchHeight: number
}

export function normalizePreTsukiDirectSignIntent(
  raw: { maxEndBatchHeight?: unknown } | undefined,
  label: string,
): PreTsukiDirectSignIntent | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`)
  }

  const value = raw.maxEndBatchHeight
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_U32) {
    throw new Error(`${label}.maxEndBatchHeight must be an integer in 1..=${MAX_U32}`)
  }

  return {maxEndBatchHeight: value as number}
}

export function assertPreTsukiDirectSignPosture(options: {
  mode: string
  network?: string
  preTsukiDirectSign?: PreTsukiDirectSignIntent
  source: string
}): void {
  if (!options.preTsukiDirectSign) return
  const {maxEndBatchHeight} = options.preTsukiDirectSign
  if (!Number.isSafeInteger(maxEndBatchHeight)
    || maxEndBatchHeight < 1
    || maxEndBatchHeight > MAX_U32) {
    throw new Error(`${options.source}: preTsukiDirectSign.maxEndBatchHeight must be an integer in 1..=${MAX_U32}`)
  }

  if (options.mode !== 'disabled') {
    throw new Error(`${options.source}: proofTopology.recovery requires proofTopology.mode disabled`)
  }

  const network = options.network?.trim().toLowerCase()
  if (!network) {
    throw new Error(`${options.source}: preTsukiDirectSign requires an explicit non-mainnet Dogecoin network`)
  }

  if (network === 'mainnet' || network === 'dogecoin') {
    throw new Error(`${options.source}: preTsukiDirectSign is testnet-only and cannot be enabled on Dogecoin mainnet`)
  }
}
