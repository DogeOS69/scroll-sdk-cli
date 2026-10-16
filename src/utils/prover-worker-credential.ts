import {createHmac} from 'node:crypto'

/**
 * Per-worker proof-coordinator credentials (dogeos-core #1591).
 *
 * The coordinator holds one coordinator-only MASTER secret
 * (`prover_api.worker_auth_token_file`). A worker authenticates with
 * `<name>.<hex HMAC-SHA256(master, "dogeos-prover-worker-v1" || 0x00 || name)>`,
 * and its worker id must equal `name`. This mirrors
 * `dogeos_proof_work_api::auth::mint_worker_credential` byte for byte; keep the
 * two in sync. Never copy the master to a worker: anyone holding it can mint a
 * credential for any worker name.
 */
const DOMAIN = 'dogeos-prover-worker-v1\0'

/** `dogeos_proof_worker_contract::DENIED_WORKER_ID_SUBSTRINGS`. */
const DENIED_WORKER_ID_SUBSTRINGS = ['local-mock-verifier', 'local-mock', 'dev-mock', 'dev_simulated', 'local-dev-simulated']

/** Core's `BearerTokenSecret::MIN_TOKEN_LEN`, applied to the master. */
const MIN_MASTER_LENGTH = 32

export function validateWorkerName(name: string): void {
  if (!/^[\w.-]{1,256}$/.test(name)) throw new Error('worker name must be 1..=256 ASCII letters, digits, \'-\', \'_\', or \'.\'')
  if (DENIED_WORKER_ID_SUBSTRINGS.some(denied => name.includes(denied))) throw new Error('worker name contains a denied dev/mock substring')
}

/** Shape check only, like core's `worker_credential_name`; returns the embedded worker name. */
export function workerCredentialName(credential: string): string {
  const dot = credential.lastIndexOf('.')
  if (dot < 0) throw new Error('invalid worker credential: expected <worker-name>.<hmac>; never give a worker the master secret')
  const name = credential.slice(0, dot)
  validateWorkerName(name)
  if (!/^[\da-f]{64}$/.test(credential.slice(dot + 1))) throw new Error('invalid worker credential MAC')
  return name
}

/**
 * Mint the credential for one worker name. `master` is trimmed exactly as the
 * coordinator trims `worker_auth_token_file`, so a trailing newline in the
 * stored secret cannot produce a credential the coordinator rejects.
 */
export function mintWorkerCredential(master: string, name: string): string {
  const key = master.trim()
  if (key.length < MIN_MASTER_LENGTH || !/^[\u0021-\u007E]+$/.test(key)) throw new Error(`worker-credential master must be at least ${MIN_MASTER_LENGTH} printable non-whitespace ASCII characters`)
  validateWorkerName(name)
  return `${name}.${createHmac('sha256', key).update(DOMAIN).update(name).digest('hex')}`
}
