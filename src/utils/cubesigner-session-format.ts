/** Read both cs CLI and TypeScript SDK session metadata without rewriting credentials. */
export function cubesignerSessionExpiration(session: {expiration?: unknown; session_exp?: unknown}): number | undefined {
  const values = [session.session_exp, session.expiration].filter(value => value !== undefined && value !== null)
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Invalid CubeSigner session expiration metadata')
  }

  if (values.length === 2 && values[0] !== values[1]) {
    throw new Error('Conflicting CubeSigner session expiration metadata')
  }

  // The SDK also permits legacy session files without local expiration metadata.
  // Callers accepting that format must verify the session against the provider.
  return values[0] as number | undefined
}
