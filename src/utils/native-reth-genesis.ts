/**
 * Drop the retired buffer flag. Every DogeOS Reth release treats an absent flag
 * as disabled, and releases with a strict chainspec schema reject the field.
 */
export function dropRetiredL1DataFeeBufferCheck(scroll: {l1DataFeeBufferCheck?: unknown}): void {
  const flag = scroll.l1DataFeeBufferCheck
  if (flag !== undefined && flag !== false) throw new Error('config.scroll.l1DataFeeBufferCheck is retired in DogeOS Reth; refusing to discard an enabled or invalid setting')
  delete scroll.l1DataFeeBufferCheck
}

/** Drop disabled legacy metadata that native DogeOS Reth no longer accepts. */
export function normalizeNativeRethGenesis<T extends {config?: {scroll?: {l1DataFeeBufferCheck?: unknown}; systemContract?: unknown}}>(source: T): T {
  const genesis = structuredClone(source)
  const {config} = genesis
  if (config?.systemContract !== undefined || !config?.scroll) return genesis
  dropRetiredL1DataFeeBufferCheck(config.scroll)
  return genesis
}
