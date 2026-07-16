/**
 * Attestation-signer descriptor — the exchange contract between a signer
 * operator (a partner deploying attestation_signer on their own
 * infrastructure) and the bridge operator (who generates the bridge from the
 * collected descriptors and wires the endpoints into TSO).
 *
 * The descriptor is deployment-agnostic: it carries only what the bridge
 * operator needs — a stable id, the network, the signer HTTP endpoint, and
 * the compressed secp256k1 public key that enters the bridge redeem script.
 * How the signer is hosted (docker-compose, Kubernetes, bare metal) is the
 * operator's concern and never appears here.
 */
import bitcore from 'bitcore-lib-doge'
import fs from 'node:fs'

const { PublicKey } = bitcore

export const ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA = 'dogeos/attestation-signer-descriptor/v1'

export const ATTESTATION_SIGNER_NETWORKS = ['mainnet', 'regtest', 'testnet'] as const

export interface AttestationSignerDescriptor {
  /** Signer HTTP base URL, e.g. https://signer.partner.example:4040 (no path). */
  endpoint: string
  /** Stable operator-chosen identifier (DNS-label shaped, unique per bridge). */
  id: string
  network: (typeof ATTESTATION_SIGNER_NETWORKS)[number]
  /** Compressed secp256k1 public key, 66 hex chars starting 02/03. */
  publicKey: string
  schema: typeof ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA
}

const ID_PATTERN = /^[\da-z]([\da-z-]{0,62}[\da-z])?$/

export function assertCompressedSecp256k1PublicKey(value: string, source: string): string {
  const normalized = value.toLowerCase()
  if (!/^0[23][\da-f]{64}$/.test(normalized)) {
    throw new Error(`${source}: publicKey must be a compressed secp256k1 key (66 hex chars starting 02/03)`)
  }

  // bitcore silently reduces out-of-range x coordinates mod p, so parsing
  // alone is not enough: require the parsed point to round-trip to the exact
  // input bytes, otherwise a corrupted key could normalize to a DIFFERENT
  // point and end up in the bridge redeem script unnoticed.
  let roundTrip: string
  try {
    const parsed = PublicKey.fromString(normalized)
    if (!parsed.compressed) throw new Error('not compressed')
    roundTrip = parsed.toString().toLowerCase()
  } catch (error) {
    throw new Error(`${source}: publicKey is not a valid secp256k1 point: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (roundTrip !== normalized) {
    throw new Error(`${source}: publicKey is not a valid secp256k1 point (does not round-trip: parsed as ${roundTrip})`)
  }

  return normalized
}

/**
 * Placeholder written by `signer init` when --endpoint is not known yet.
 * It is a syntactically valid URL, so validation must reject it explicitly —
 * otherwise a forgotten placeholder descriptor would import cleanly and put
 * a junk endpoint into tsoSigners.
 */
export const ENDPOINT_PLACEHOLDER = 'https://REPLACE-WITH-YOUR-SIGNER-ENDPOINT'

export function normalizeSignerEndpoint(value: string, source: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${source}: endpoint must be an absolute http(s) URL`)
  }

  if (url.hostname === new URL(ENDPOINT_PLACEHOLDER).hostname) {
    throw new Error(`${source}: endpoint is still the signer-init placeholder; run scrollsdk signer preflight --endpoint <real-url> to finalize the descriptor`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${source}: endpoint must use http or https (got ${url.protocol.replace(':', '')})`)
  }

  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) {
    throw new Error(`${source}: endpoint must be a bare base URL without path, query, or credentials`)
  }

  return url.origin
}

export function validateAttestationSignerDescriptor(raw: unknown, source: string): AttestationSignerDescriptor {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${source}: descriptor must be a JSON object`)
  }

  const value = raw as Record<string, unknown>
  if (value.schema !== ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA) {
    throw new Error(`${source}: schema must be ${ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA} (got ${JSON.stringify(value.schema)})`)
  }

  for (const field of ['endpoint', 'id', 'network', 'publicKey'] as const) {
    if (typeof value[field] !== 'string' || value[field].trim() === '') {
      throw new Error(`${source}: ${field} must be a non-empty string`)
    }
  }

  const id = (value.id as string).trim()
  if (!ID_PATTERN.test(id)) {
    throw new Error(`${source}: id must be DNS-label shaped (lowercase letters, digits, dashes; max 64 chars)`)
  }

  const network = (value.network as string).trim()
  if (!(ATTESTATION_SIGNER_NETWORKS as readonly string[]).includes(network)) {
    throw new Error(`${source}: network must be one of ${ATTESTATION_SIGNER_NETWORKS.join(', ')}`)
  }

  return {
    endpoint: normalizeSignerEndpoint((value.endpoint as string).trim(), source),
    id,
    network: network as AttestationSignerDescriptor['network'],
    publicKey: assertCompressedSecp256k1PublicKey((value.publicKey as string).trim(), source),
    schema: ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA,
  }
}

export function loadAttestationSignerDescriptor(filePath: string): AttestationSignerDescriptor {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`${filePath}: failed to read descriptor: ${error instanceof Error ? error.message : String(error)}`)
  }

  return validateAttestationSignerDescriptor(parsed, filePath)
}

export interface SignerHealthReport {
  network?: string
  publicKey: string
  raw: Record<string, unknown>
}

/**
 * Probe a running attestation_signer's /health endpoint and extract the
 * runtime public key. Used by `signer preflight` (operator side) and the
 * optional --probe cross-check at descriptor import (bridge-operator side).
 */
export async function fetchSignerHealth(endpoint: string, timeoutMs = 10_000): Promise<SignerHealthReport> {
  const url = `${normalizeSignerEndpoint(endpoint, 'endpoint')}/health`
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  const body = await response.json() as Record<string, unknown>
  const publicKey = body.public_key
  if (typeof publicKey !== 'string' || publicKey === '') {
    throw new Error(`${url} response is missing public_key`)
  }

  return {
    network: typeof body.network === 'string' ? body.network : undefined,
    publicKey: assertCompressedSecp256k1PublicKey(publicKey, url),
    raw: body,
  }
}
