import {AwsCliRunner} from './aws-cli.js'
import {PROVER_WORKER_MASTER_PROPERTY} from './proof-aws-provisioner.js'

/**
 * Read the coordinator-only worker-credential master from the proof
 * coordinator JSON secret. Callers mint per-worker credentials from it and must
 * never write the master itself to a worker host, bundle or run spec.
 */
export function readProverWorkerMasterFromSecretsManager(options: {
  awsProfile?: string
  awsRegion?: string
  secretName: string
}): string {
  const aws = new AwsCliRunner(options.awsProfile)
  const secretString = aws.text(
    ['secretsmanager', 'get-secret-value', '--secret-id', options.secretName],
    {query: 'SecretString', region: options.awsRegion},
  )
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(secretString)
  } catch {
    // JSON.parse errors can quote secret plaintext; never surface them.
    throw new TypeError(`Secrets Manager secret ${options.secretName} is not a JSON property map (contents omitted)`)
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new TypeError(`Secrets Manager secret ${options.secretName} is not a JSON property map`)
  }

  const master = parsed[PROVER_WORKER_MASTER_PROPERTY]
  if (typeof master !== 'string' || master.trim() === '') {
    throw new Error(`Secrets Manager secret ${options.secretName} has no ${PROVER_WORKER_MASTER_PROPERTY} property; run setup proof-aws-init to add a fresh coordinator-only master`)
  }

  return master.trim()
}
