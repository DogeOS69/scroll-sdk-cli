/** Drop disabled legacy metadata that native DogeOS Reth no longer accepts. */
export function normalizeNativeRethGenesis<T extends {config?: {scroll?: {l1DataFeeBufferCheck?: unknown}; systemContract?: unknown}}>(source: T): T {
  const genesis = structuredClone(source)
  const {config} = genesis
  if (config?.systemContract !== undefined || !config?.scroll) return genesis
  const flag = config.scroll.l1DataFeeBufferCheck
  if (flag !== undefined && flag !== false) throw new Error('Native DogeOS Reth does not support config.scroll.l1DataFeeBufferCheck; refusing to discard an enabled or invalid setting')
  delete config.scroll.l1DataFeeBufferCheck
  return genesis
}
