/**
 * The frontend appends `/tx/<txid>` to these base URLs and uses them as menu
 * links. An empty value renders the hash as plain text.
 */
const ETHEREUM_EXPLORERS: Record<string, string> = {
  devnet: '',
  mainnet: 'https://etherscan.io',
  sepolia: 'https://sepolia.etherscan.io',
}

const PLACEHOLDER_HOST = /(?:^|\.)(?:example\.com|example|invalid|localhost|test)$/i

/** A local devnet has no public explorer, so its links stay plain text. */
export function defaultEthereumExplorer(chain: string): string {
  return ETHEREUM_EXPLORERS[chain] ?? ''
}

/** Return the problem with a frontend explorer base URL, if there is one. */
export function frontendExplorerUrlProblem(field: string, value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  const shape = `${field} must be an http(s) base URL that serves <base>/tx/<txid>, or empty to show hashes as plain text`
  if (typeof value !== 'string') return shape
  let url: URL
  try {url = new URL(value)} catch {return shape}
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || value.includes('?') || value.includes('#')) return shape
  // Not every frontend link strips it, and `<base>//tx/<txid>` is a 404 on an explorer such as SoChain.
  if (value.endsWith('/')) return `${shape}; remove the trailing slash`
  if (PLACEHOLDER_HOST.test(url.hostname)) return `${shape}; ${url.hostname} is a placeholder host`
  return undefined
}
