import * as toml from '@iarna/toml'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {rotationProtocolOpeningId} from './bridge-rotation-runtime.js'
import {resolveProofReceiptSelection} from './proof-deployment-contract.js'
import {DEFAULT_PROOF_MATERIALS_RECEIPT, readProofMaterials} from './proof-materials.js'
import {stripRetiredServiceConfig} from './retired-services.js'
import {protocolIdSidecarPath} from './signer-policy-derivation.js'

export const FRONTEND_DEPOSIT_API_PATH = '/api/deposit'
export const FRONTEND_L1_UPSTREAM = 'l1-interface:9090'
export const FRONTEND_COMMAND = ['/bin/sh', '-ec',
  `grep -v '^#' /app/conf/frontend-config | awk -F' = ' 'NF==2 {printf "export %s=\\"%s\\"\\n", $1, $2}' | sed 's/""/"/g' > /usr/share/nginx/html/.env
. /usr/share/nginx/html/.env
exec /usr/local/bin/entrypoint.sh`]

export interface FrontendDepositIdentity {genesisStateHash: string; protocolId: string}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0x)?[\dA-Fa-f]{64}$/.test(value) || /^0+$/.test(value.replace(/^0x/, ''))) throw new Error('Invalid frontend deployment identity hash')
  return `0x${value.replace(/^0x/, '').toLowerCase()}`
}

/** Resolve identity exclusively from local, checksum-validated deployment material. */
export function readFrontendDepositIdentity(root: string, options: {dogecoinChainId?: number; l2ChainId?: number; materialsReceipt?: string; required?: boolean} = {}): FrontendDepositIdentity | undefined {
  const contextPath = path.resolve(root, '.data/protocol_context.json')
  const selected = resolveProofReceiptSelection(root, {materialsReceipt: options.materialsReceipt})
  const receiptPath = path.resolve(root, selected.materialsReceipt ?? DEFAULT_PROOF_MATERIALS_RECEIPT)
  const missing = (): undefined => {
    if (options.required) throw new Error('Frontend deposit identity requires prepared Bridge proof materials; complete proof preparation before prep-charts')

  }

  if (!fs.existsSync(receiptPath)) {
    if (selected.materialsReceipt) throw new Error('Selected frontend proof materials receipt is missing')
    return missing()
  }

  const receipt = readProofMaterials(receiptPath, root)
  if (!receipt.bridge) return missing()
  // Release preparation may bind a snapshot under .data/proof-release-preparation.
  // Match its content to the active context rather than requiring the same path.
  const contextBytes = fs.readFileSync(contextPath)
  if (createHash('sha256').update(contextBytes).digest('hex') !== receipt.bridge.protocolContextSha256) throw new Error('Frontend Bridge material is bound to a different protocol context')
  const context = JSON.parse(contextBytes.toString('utf8'))
  if (options.dogecoinChainId !== undefined && context.protocol?.dogecoin_chain_id !== options.dogecoinChainId) throw new Error('Frontend Dogecoin chain ID differs from the prepared protocol context')
  if (options.l2ChainId !== undefined && context.protocol?.l2_chain_id !== options.l2ChainId) throw new Error('Frontend L2 chain ID differs from the prepared protocol context')
  const protocolId = hash(rotationProtocolOpeningId(context))
  const sidecar = protocolIdSidecarPath(contextPath)
  if (fs.existsSync(sidecar) && hash(fs.readFileSync(sidecar, 'utf8').trim()) !== protocolId) throw new Error('Frontend protocol ID sidecar differs from the protocol context')
  const genesisStateHash = hash(receipt.bridge.genesisStateHash)
  const manifest = JSON.parse(fs.readFileSync(path.resolve(root, receipt.bridge.artifacts.nativeManifest.path), 'utf8'))
  if (hash(manifest.genesis_state_hash) !== genesisStateHash) throw new Error('Frontend protocol genesis state hash differs from the Bridge manifest')
  return {genesisStateHash, protocolId}
}

export function frontendDepositEnv(identity?: FrontendDepositIdentity): Record<string, string> {
  return {
    REACT_APP_DEPOSIT_API_PATH: FRONTEND_DEPOSIT_API_PATH,
    REACT_APP_DOGEOS_GENESIS_STATE_HASH: identity?.genesisStateHash ?? '',
    REACT_APP_DOGEOS_PROTOCOL_ID: identity?.protocolId ?? '',
  }
}

/** The frontend chart owns one ConfigMap through scrollConfig. Normalize older CLI output. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Helm values are operator-owned documents.
export function reconcileFrontendConfig(values: any, updates: Record<string, unknown>): void {
  let config: Record<string, unknown> = {}
  if (typeof values.scrollConfig === 'string') {
    try {config = toml.parse(values.scrollConfig)} catch {throw new Error('Invalid frontend scrollConfig TOML')}
  }

  const old = values.configMaps?.['frontend-config']?.data?.['frontend-config']
  if (typeof old === 'string') {
    for (const line of old.split('\n')) {
      const entry = line.match(/^([A-Z][\dA-Z_]*)\s*=\s*(.*)$/)
      if (!entry) continue
      let value = entry[2].trim()
      if (value.startsWith('"') && value.endsWith('"')) {
        try {value = JSON.parse(value)} catch {throw new Error('Invalid frontend environment value')}
      }

      config[entry[1]] = value
    }
  }

  config = stripRetiredServiceConfig(config)
  delete config.REACT_APP_DOGE_BRIDGE_ADDRESS
  for (const [key, value] of Object.entries(updates)) if (value !== undefined && value !== null) config[key] = String(value)
  values.scrollConfig = toml.stringify(config as toml.JsonMap)
  if (values.configMaps?.['frontend-config']) {
    delete values.configMaps['frontend-config']
    if (Object.keys(values.configMaps).length === 0) delete values.configMaps
  }
}

/** Merge frontend environment fields, not whole TOML strings. */
export function mergeFrontendConfigDocuments(...sources: unknown[]): Record<string, unknown> {
  let values: Record<string, unknown> = {}
  let config: Record<string, unknown> = {}
  for (const source of sources) {
    if (source === undefined || source === null) continue
    if (typeof source !== 'object' || Array.isArray(source)) throw new Error('Frontend values must be a mapping')
    const next = JSON.parse(JSON.stringify(source))
    reconcileFrontendConfig(next, {})
    config = {...config, ...toml.parse(next.scrollConfig)}
    values = {...values, ...next}
  }

  reconcileFrontendConfig(values, config)
  return values
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Common-chart environment supports a mapping.
export function reconcileFrontendProduction(values: any): void {
  values.env ??= {}
  if (typeof values.env !== 'object' || Array.isArray(values.env)) throw new Error('Frontend env must be a mapping')
  values.env.L1_INTERFACE_UPSTREAM ??= FRONTEND_L1_UPSTREAM
  const upstream = values.env.L1_INTERFACE_UPSTREAM
  if (typeof upstream !== 'string' || !/^[\dA-Za-z][\d.A-Za-z-]*:\d{1,5}$/.test(upstream) || Number(upstream.split(':')[1]) < 1 || Number(upstream.split(':')[1]) > 65_535) throw new Error('Frontend L1_INTERFACE_UPSTREAM must be an internal host:port')
  // Upgrade the SDK's old loader without replacing an operator's custom command.
  if (!values.command || Array.isArray(values.command) && values.command.some((part: unknown) => typeof part === 'string' && part.includes('/app/conf/frontend-config') && part.includes('awk'))) values.command = [...FRONTEND_COMMAND]
}
