import {AwsCliRunner} from './aws-cli.js'

/** Read the prover-worker bearer token from the proof coordinator JSON secret. */
export function readProverWorkerTokenFromSecretsManager(options: {
  awsProfile?: string
  awsRegion?: string
  secretName: string
}): string {
  const aws = new AwsCliRunner(options.awsProfile)
  const secretString = aws.text(
    ['secretsmanager', 'get-secret-value', '--secret-id', options.secretName],
    {query: 'SecretString', region: options.awsRegion},
  )
  const parsed = JSON.parse(secretString) as Record<string, unknown>
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TypeError(`Secrets Manager secret ${options.secretName} is not a JSON property map`)
  }

  const token = parsed['prover-worker-token']
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error(`Secrets Manager secret ${options.secretName} has no prover-worker-token property`)
  }

  return token.trim()
}
