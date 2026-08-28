/* eslint-disable @typescript-eslint/no-explicit-any -- dogeos-core TOML is a dynamic deployment artifact. */
import * as toml from '@iarna/toml'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const DEFAULT_PROOF_COORDINATOR_CONFIG = 'proof-coordinator/ProofCoordinator.toml'

const ENVELOPE_PROOF_IDENTITIES = [
  ['scroll_bridge_verifier_identity', 'openvm_state_transition'],
  ['scroll_batch_verifier_identity', 'scroll_batch'],
] as const

export interface DerivedValue {
  source: string
  value: string
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value) > 256) {
    throw new Error(`${label} must be a non-empty string no longer than 256 bytes`)
  }

  return value.trim()
}

function bareHash(value: unknown, label: string): string {
  const normalized = nonEmpty(value, label).toLowerCase().replace(/^0x/, '')
  if (!/^[\da-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a 32-byte lowercase hexadecimal value`)
  }

  return normalized
}

export function normalizeSignerProofArtifactBaseUrl(value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error('a proof artifact public base URL is required for bridge proof evidence')
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (error) {
    throw new Error(
      `proof artifact base URL must be an absolute URL: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('proof artifact base URL must not contain credentials, a query, or a fragment')
  }

  const hostname = parsed.hostname.replaceAll(/^\[|]$/g, '').toLowerCase()
  const loopback = hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('proof artifact base URL must use https:// (loopback http:// is allowed for dev/test)')
  }

  parsed.pathname = parsed.pathname.replaceAll(/\/+$/g, '') || '/'
  return parsed.toString().replaceAll(/\/$/g, '')
}

/** Read the signer-visible accepted-proof root emitted by the dogeos-core compiler. */
export function readStagedSignerProofArtifactBaseUrl(
  withdrawalConfigSource: string,
): string | undefined {
  const parsed = toml.parse(withdrawalConfigSource) as any
  const value = parsed?.proof_system?.signer_proof_artifact_base_url
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Derive the signer envelope allowlist from the exact compiler-rendered PC
 * verifier identities. There is intentionally no release-manifest fallback:
 * the compiled service configuration is the sole deployed authority.
 */
export function deriveAllowedProofTriples(
  coordinatorConfigPath = DEFAULT_PROOF_COORDINATOR_CONFIG,
): DerivedValue | undefined {
  const configFile = path.resolve(coordinatorConfigPath)
  if (!fs.existsSync(configFile)) return undefined

  const parsed = toml.parse(fs.readFileSync(configFile, 'utf8')) as any
  const verifier = parsed?.verifier
  const triples = ENVELOPE_PROOF_IDENTITIES.map(([identityName, proofKind]) => {
    const identity = verifier?.[identityName]
    const verifierId = nonEmpty(identity?.verifier_id, `${identityName}.verifier_id`)
    if (/[,:]/.test(verifierId)) {
      throw new Error(`${identityName}.verifier_id must not contain ':' or ','`)
    }

    const vkHash = bareHash(
      identity?.expected_verification_key_hash_hex,
      `${identityName}.expected_verification_key_hash_hex`,
    )
    return `${proofKind}:${verifierId}:${vkHash}`
  })
  return {source: configFile, value: triples.join(',')}
}
