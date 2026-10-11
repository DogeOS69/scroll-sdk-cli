import type {AwsCliRunner} from './aws-cli.js'

export const PRIVATE_ARTIFACT_PUBLIC_ACCESS_BLOCK = {
  BlockPublicAcls: true,
  BlockPublicPolicy: true,
  IgnorePublicAcls: true,
  RestrictPublicBuckets: true,
} as const

export const PRIVATE_ARTIFACT_ACCESS_MODE = 'private-s3' as const

export function assertPrivateArtifactMode(mode: unknown): void {
  if (mode !== PRIVATE_ARTIFACT_ACCESS_MODE) throw new Error('Proof artifacts must use private-s3. Only the DA blob archive may allow public reads; direct-s3, existing-public-s3 and anonymous gateways are not supported.')
}

/** Fail closed on public/ambiguous grants before changing a shared bucket. */
export function assertPrivateArtifactPolicy(policy: Record<string, any>): void {
  const statements = Array.isArray(policy.Statement) ? policy.Statement : policy.Statement ? [policy.Statement] : []
  for (const statement of statements) {
    if (statement?.Effect !== 'Allow') continue
    const principal = statement.Principal
    const principals = [principal?.AWS, principal?.Service].flat().filter(Boolean)
    const wildcard = principal === '*' || principals.some(value => typeof value === 'string' && /[*?]/.test(value))
    const vpce = statement.Condition?.StringEquals?.['aws:SourceVpce']
    const privateRoute = typeof vpce === 'string' && /^vpce-[\da-f]+$/i.test(vpce)
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action]
    const privateReadOnly = privateRoute && statement.NotAction === undefined && actions.length === 1 && actions[0] === 's3:GetObject'
    if (statement.NotPrincipal !== undefined || statement.NotResource !== undefined || wildcard && !privateReadOnly
      || principals.includes('cloudfront.amazonaws.com')) {
      throw new Error(`Artifact bucket statement ${String(statement.Sid ?? '<without Sid>')} permits public or unverified external delivery. Use a dedicated private bucket or review/remove that operator-owned grant; the CLI will not silently change other deployments.`)
    }
  }
}

/** Reuse and readback must verify the provider, not trust a local receipt. */
export function assertPrivateArtifactBucket(aws: Pick<AwsCliRunner, 'json' | 'text'>, bucket: string, region: string): void {
  const block = aws.json(['s3api', 'get-public-access-block', '--bucket', bucket], {region}).PublicAccessBlockConfiguration
  if (!Object.keys(PRIVATE_ARTIFACT_PUBLIC_ACCESS_BLOCK).every(key => block?.[key] === true)) {
    throw new Error('Private artifact bucket requires all four S3 Public Access Block settings enabled; reuse never changes AWS permissions')
  }

  let policy: Record<string, any>
  try {
    policy = JSON.parse(aws.text(['s3api', 'get-bucket-policy', '--bucket', bucket], {query: 'Policy', region}))
  } catch (error) {
    if (String(error).includes('NoSuchBucketPolicy')) return
    throw error
  }

  assertPrivateArtifactPolicy(policy)
}
