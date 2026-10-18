/* eslint-disable @typescript-eslint/no-explicit-any -- Blockscout chart values are dynamic documents. */

/** The pinned chart emits network and metrics env itself; avoid duplicate names. */
export function reconcileBlockscoutFrontend(stack: Record<string, any>, host: string, chainName: string, chainId: number | string): boolean {
  if (!stack.frontend) return false
  const before = JSON.stringify(stack)
  stack.frontend.env ??= {}
  // Older ALB deployments used literal extraEnv entries to bypass duplicate
  // upstream variables. Fold those back into the canonical map before pruning.
  if (Array.isArray(stack.frontend.extraEnv)) {
    stack.frontend.extraEnv = stack.frontend.extraEnv.filter((entry: any) => {
      if (!entry || typeof entry.name !== 'string' || !Object.hasOwn(entry, 'value') || entry.valueFrom) return true
      stack.frontend.env[entry.name] = entry.value
      return false
    })
  }

  stack.config ??= {}
  stack.config.network ??= {}
  const {env} = stack.frontend
  const {config} = stack
  const {network} = config
  network.id = String(chainId)
  network.name = chainName
  network.shortname ??= env.NEXT_PUBLIC_NETWORK_SHORT_NAME ?? 'DogeOS'
  network.currency ??= {}
  for (const [field, key, fallback] of [
    ['name', 'NEXT_PUBLIC_NETWORK_CURRENCY_NAME', 'Dogecoin'],
    ['symbol', 'NEXT_PUBLIC_NETWORK_CURRENCY_SYMBOL', 'DOGE'],
    ['decimals', 'NEXT_PUBLIC_NETWORK_CURRENCY_DECIMALS', 18],
  ] as const) network.currency[field] ??= env[key] ?? fallback
  if (stack.blockscout?.env) {
    delete stack.blockscout.env.COIN
    delete stack.blockscout.env.COIN_NAME
  }

  for (const key of ['NEXT_PUBLIC_NETWORK_ID', 'NEXT_PUBLIC_NETWORK_NAME', 'NEXT_PUBLIC_NETWORK_SHORT_NAME', 'NEXT_PUBLIC_NETWORK_CURRENCY_NAME', 'NEXT_PUBLIC_NETWORK_CURRENCY_SYMBOL', 'NEXT_PUBLIC_NETWORK_CURRENCY_DECIMALS']) delete env[key]
  for (const [service, key] of [['blockscout', 'NEXT_PUBLIC_API_HOST'], ['frontend', 'NEXT_PUBLIC_APP_HOST']]) {
    if (stack[service]?.ingress?.enabled) delete env[key]
    else env[key] = host
  }

  if (config.prometheus?.enabled !== false) delete env.PROMETHEUS_METRICS_ENABLED
  return JSON.stringify(stack) !== before
}
