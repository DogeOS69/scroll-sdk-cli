/* eslint-disable @typescript-eslint/no-explicit-any -- deployment TOML artifacts expose dynamic values */
import * as toml from '@iarna/toml'
import fs from 'node:fs'
import path from 'node:path'

import type { DerivedValue } from './proof-configurator.js'

import { parseTomlConfig } from './config-parser.js'
import { normalizeCompressedSecp256k1PublicKey } from './secp256k1-public-key.js'

/**
 * dogeos-core `generate_protocol_context` writes the canonical protocol
 * opening hash (the protocol instance id) as bare hex to the --output path
 * with its extension replaced by `.protocol_id`; bridge-init step
 * 5-protocol-context therefore leaves the sidecar next to
 * protocol_context.json.
 */
export function protocolIdSidecarPath(protocolContextPath: string): string {
  const parsed = path.parse(path.resolve(protocolContextPath))
  return path.join(parsed.dir, `${parsed.name}.protocol_id`)
}

export function deriveProtocolInstanceId(protocolContextPath: string): DerivedValue | undefined {
  const sidecar = protocolIdSidecarPath(protocolContextPath)
  if (!fs.existsSync(sidecar)) return undefined
  const raw = fs.readFileSync(sidecar, 'utf8').trim().toLowerCase()
  const normalized = raw.startsWith('0x') ? raw : `0x${raw}`
  if (!/^0x[\da-f]{64}$/.test(normalized)) {
    throw new Error(`${sidecar} does not contain a 32-byte hex protocol_id; re-run scrollsdk setup bridge-init --step 5-protocol-context or pass --protocol-instance-id`)
  }

  return { source: sidecar, value: normalized }
}

/**
 * bridge-init step 3 writes GenerateBridgeInfo.toml via
 * generate-bridge-info-cli, which nests the config under a figment profile
 * table (`[default]`) and serializes `namespace_id` as an array of 20 bytes.
 * Flat tables and hex-string values are accepted for hand-maintained files.
 */
export function deriveBridgeNamespaceId(generateBridgeInfoPath = '.data/GenerateBridgeInfo.toml'): DerivedValue | undefined {
  const file = path.resolve(generateBridgeInfoPath)
  if (!fs.existsSync(file)) return undefined
  const data = toml.parse(fs.readFileSync(file, 'utf8')) as any
  const table = typeof data?.default === 'object' && data.default !== null ? data.default : data
  const value = table?.namespace_id ?? table?.namespaceId
  const source = `${file} namespace_id`
  if (Array.isArray(value)) {
    const bytes = value.map(item => (typeof item === 'bigint' ? Number(item) : item))
    if (bytes.length !== 20 || bytes.some(item => typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 255)) {
      throw new Error(`${source} must be an array of 20 bytes; pass --bridge-namespace-id explicitly`)
    }

    return { source, value: `0x${Buffer.from(bytes).toString('hex')}` }
  }

  if (typeof value === 'string' && value.trim() !== '') return { source, value: value.trim() }
  return undefined
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

/**
 * cubesigner-init records the bridge's own TEE signing key in
 * setup_defaults.toml; that key is the deployment's TEE signer allowlist
 * unless the operator overrides it.
 */
export function deriveTeeAllowedSignerIds(setupDefaultsPath = '.data/setup_defaults.toml'): DerivedValue | undefined {
  const file = path.resolve(setupDefaultsPath)
  if (!fs.existsSync(file)) return undefined
  const teePubkey = (toml.parse(fs.readFileSync(file, 'utf8')) as any)?.tee_pubkey
  if (typeof teePubkey !== 'string' || teePubkey.trim() === '') return undefined
  return {
    source: `${file} tee_pubkey`,
    value: normalizeCompressedSecp256k1PublicKey(teePubkey, `${file} tee_pubkey`),
  }
}
