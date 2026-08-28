import fs from 'node:fs'
import path from 'node:path'

import type {DerivedValue} from './proof-signer-policy-input.js'

import { parseTomlConfig } from './config-parser.js'

/** Path emitted next to protocol_context.json by generate_protocol_context. */
export function protocolIdSidecarPath(protocolContextPath: string): string {
  const parsed = path.parse(path.resolve(protocolContextPath))
  return path.join(parsed.dir, `${parsed.name}.protocol_id`)
}

/**
 * The TSO ingress host is the one address signers are told to call back —
 * exactly what prep-charts wires into the tso-service ingress.
 */
export function deriveTsoUrl(configPath = 'config.toml'): DerivedValue | undefined {
  const file = path.resolve(configPath)
  if (!fs.existsSync(file)) return undefined
  const host = parseTomlConfig(file)?.ingress?.TSO_HOST
  if (typeof host !== 'string' || host.trim() === '') return undefined
  return { source: `${file} [ingress].TSO_HOST`, value: `https://${host.trim()}` }
}
