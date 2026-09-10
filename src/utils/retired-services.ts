import * as fs from 'node:fs'
import * as path from 'node:path'

function isRetiredKey(key: string, parent = ''): boolean {
  if (parent === 'rollup' && ['FINALIZE_BATCH_DEADLINE_SEC', 'MAX_BATCH_IN_BUNDLE', 'MAX_BLOCK_IN_CHUNK', 'MAX_L1_MESSAGE_GAS_LIMIT', 'MAX_TX_IN_CHUNK', 'RELAY_MESSAGE_DEADLINE_SEC', 'TEST_ENV_MOCK_FINALIZE_ENABLED', 'TEST_ENV_MOCK_FINALIZE_TIMEOUT_SEC', 'finalization', 'maxBatchInBundle', 'maxBlockInChunk', 'maxL1MessageGasLimit', 'maxTxInChunk'].includes(key)) return true
  if (['TEST_ENV_MOCK_FINALIZE_ENABLED', 'TEST_ENV_MOCK_FINALIZE_TIMEOUT_SEC'].includes(key)) return true
  if (parent === 'test' && ['mockFinalizeEnabled', 'mockFinalizeTimeout', 'mockFinalizeTimeoutSec'].includes(key)) return true
  if (['ADMIN_SYSTEM_DASHBOARD_HOST', 'ADMIN_SYSTEM_DASHBOARD_URI', 'BLOCKSCOUT_BACKEND_HOST', 'COORDINATOR_API_HOST', 'L1_EXPLORER_HOST', 'REACT_APP_ROLLUPSCAN_API_URI', 'ROLLUP_EXPLORER_API_HOST', 'ROLLUPSCAN_API_URI'].includes(key)) return true
  if (['hosts', 'subdomains'].includes(parent) && ['adminDashboard', 'blockscoutBackend', 'coordinatorApi', 'l1Explorer', 'rollupExplorerApi'].includes(key)) return true
  if (parent === 'externalUrls' && ['adminDashboard', 'rollupScanApi'].includes(key)) return true
  if (key === 'gas-token' || (parent === 'contracts' && key === 'alternativeGasToken')) return true
  if (['BRIDGE_API_URI', 'BRIDGE_HISTORY_API_HOST', 'REACT_APP_BRIDGE_API_URI', 'bridgeApi', 'bridgeHistoryApi'].includes(key)) return true
  if (key.endsWith('_DB_CONNECTION_STRING') && key !== 'BLOCKSCOUT_DB_CONNECTION_STRING') return true
  if (/^SCROLL_.*_DB_(?:CONFIG_)?DSN$/.test(key)) return true
  if (parent === 'db' && (key.startsWith('CREATE_') || (key.endsWith('_PASSWORD') && key !== 'BLOCKSCOUT_PASSWORD'))) return true
  if (/blockbook/i.test(key) || /^(?:BRIDGE_HISTORY|CHAIN_MONITOR|L1_EXPLORER)_(?:DB_CONNECTION_STRING|PASSWORD)$/.test(key)
    || /^SCROLL_(?:BRIDGE_HISTORY|CHAIN_MONITOR)_DB_/.test(key) || key === 'CREATE_L1_EXPLORER_DB') return true
  if (parent === 'rpc' && key === 'apiKey') return true
  if (parent === 'credentials') return ['adminSystemPassword', 'bridgeHistoryPassword', 'chainMonitorPassword', 'coordinatorPassword', 'gasOraclePassword', 'l1ExplorerPassword', 'rollupExplorerPassword', 'rollupNodePassword'].includes(key)
  if (parent === 'databases') return ['adminSystem', 'bridgeHistory', 'chainMonitor', 'coordinator', 'gasOracle', 'l1Explorer', 'rollupExplorer', 'rollupNode'].includes(key)
  if (parent === 'services') return ['adminSystemDashboard', 'bridgeHistoryApi', 'bridgeHistoryFetcher', 'chainMonitor', 'coordinatorApi', 'rollupExplorerBackend'].includes(key)
  return false
}

/** Drop retired service projections without modifying the input configuration. */
export function stripRetiredServiceConfig<T>(config: T): T {
  function strip(value: unknown, parent = ''): unknown {
    if (Array.isArray(value)) return value.filter(item => {
      if (!item || typeof item !== 'object') return true
      const entry = item as {name?: unknown; secretKey?: unknown}
      return ![entry.name, entry.secretKey].some(key => typeof key === 'string' && isRetiredKey(key))
    }).map(item => strip(item))
    if (!value || typeof value !== 'object' || value instanceof Date) return value
    return Object.fromEntries(Object.entries(value).filter(([key]) =>
      !isRetiredKey(key, parent))
      .map(([key, item]) => [key, strip(item, key)])
      .filter(([key, item]) => !(['rollup', 'test'].includes(key as string) && item && typeof item === 'object' && Object.keys(item).length === 0)))
  }

  return strip(config) as T
}

/** Preserve old local files outside active deployment and upload paths. */
export function archiveRetiredServiceFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  const files = fs.readdirSync(directory).filter(file => isRetiredServiceFile(file))
  if (files.length === 0) return []
  const archiveRoot = path.join(directory, '.retired-services')
  fs.mkdirSync(archiveRoot, {mode: 0o700, recursive: true})
  const archive = fs.mkdtempSync(path.join(archiveRoot, 'backup-'))
  return files.map(file => {
    const destination = path.join(archive, `${file}.bak`)
    fs.renameSync(path.join(directory, file), destination)
    return destination
  })
}

export function isRetiredServiceFile(file: string): boolean {
  return /^(?:blockbook|bridge-history(?:-api|-fetcher)?|chain-monitor|l1-explorer|coordinator-(?:api|cron)|admin-system-(?:backend|cron|dashboard)|rollup-explorer-backend|gas-oracle)(?:[.-].*)?\.(?:ya?ml|env|json)$/.test(path.basename(file))
}
