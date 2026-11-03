import {randomBytes} from 'node:crypto'

import type {AwsCliOptions} from './aws-cli.js'

/**
 * Secrets Manager property -> coordinator Kubernetes Secret key. The master
 * keeps the `prover-worker-token` key, so the coordinator's
 * `worker_auth_token_file` path (`/app/secrets/prover-worker-token`) is unchanged.
 */
export const PROOF_TOKEN_PROPERTIES = ['proof-work-token', 'prover-worker-master'] as const

export type ProofTokenSecretAction = 'created' | 'migrated' | 'reused' | 'rotated'

type Aws = {
  json(args: string[], options?: AwsCliOptions): unknown
  text(args: string[], options?: AwsCliOptions): string
}

/**
 * Create, complete or rotate the proof token Secret value. Writes only the
 * Secret value; the Secret's metadata and access policy belong to the
 * infrastructure templates. Never prints or echoes token values.
 */
export function ensureProofTokenSecret(aws: Aws, region: string, secretName: string, rotate: boolean, info: (message: string) => void): ProofTokenSecretAction {
  const fresh = (): string => randomBytes(32).toString('hex')
  const write = {contentWrite: 'secret-value', region} as const
  const secretString = JSON.stringify(Object.fromEntries(PROOF_TOKEN_PROPERTIES.map(property => [property, fresh()])))

  let exists = true
  try {
    aws.json(['secretsmanager', 'describe-secret', '--secret-id', secretName], {region})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('ResourceNotFoundException')) throw error
    exists = false
  }

  if (!exists) {
    aws.json(['secretsmanager', 'create-secret', '--name', secretName, '--secret-string', secretString], write)
    info(`proof tokens: created ${secretName}`)
    return 'created'
  }

  if (rotate) {
    // Also drops a legacy shared `prover-worker-token` property.
    aws.json(['secretsmanager', 'put-secret-value', '--secret-id', secretName, '--secret-string', secretString], write)
    info(`proof tokens: rotated ${secretName} (drain workers first; wait for ExternalSecrets and Kubernetes Secrets to synchronize; restart WP, the coordinator and capacity manager, then re-mint every worker credential)`)
    return 'rotated'
  }

  // Shared-token deployments predate the master. Add a fresh one instead of
  // promoting the old shared token, which every existing worker knows.
  let existing: unknown
  try {
    existing = JSON.parse(aws.text(['secretsmanager', 'get-secret-value', '--secret-id', secretName], {query: 'SecretString', region}))
  } catch {
    // JSON.parse errors can quote secret plaintext; never surface them.
    throw new Error(`proof tokens: ${secretName} could not be read as a JSON property map (contents omitted)`)
  }

  if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) throw new Error(`proof tokens: ${secretName} is not a JSON property map`)
  const current = existing as Record<string, unknown>
  const missing = PROOF_TOKEN_PROPERTIES.filter(property => typeof current[property] !== 'string' || !(current[property] as string).trim())
  if (missing.length > 0) {
    const merged = {...current, ...Object.fromEntries(missing.map(property => [property, fresh()]))}
    // Keep a legacy `prover-worker-token` until --rotate: a running
    // coordinator's ExternalSecret may still reference it until re-render.
    aws.json(['secretsmanager', 'put-secret-value', '--secret-id', secretName, '--secret-string', JSON.stringify(merged)], write)
    info(`proof tokens: added ${missing.join(', ')} to ${secretName}; drain shared-token workers, restart the coordinator, then mint per-worker credentials`)
    return 'migrated'
  }

  info(`proof tokens: reusing ${secretName} (pass --rotate to replace)`)
  return 'reused'
}
