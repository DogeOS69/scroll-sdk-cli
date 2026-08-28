import * as toml from '@iarna/toml'

export const DEFAULT_PROOF_COORDINATOR_CONFIG = 'proof-coordinator/ProofCoordinator.toml'

export interface DerivedValue {
  source: string
  value: string
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
