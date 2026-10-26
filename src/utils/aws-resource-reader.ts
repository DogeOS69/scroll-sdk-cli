/* eslint-disable @typescript-eslint/no-explicit-any -- AWS resource metadata. */
import type {AwsCliRunner} from './aws-cli.js'

/** Read configuration facts. Infrastructure permission and compliance checks belong outside the CLI. */
export function readAwsResource(aws: Pick<AwsCliRunner, 'json'>, args: string[], region: string): any {
  if (!/^(describe|get|list)-/.test(args[1])) throw new Error('Resource discovery only supports Describe/Get/List operations')
  try {return aws.json(args, {region})} catch {throw new Error(`Cannot read AWS resource (${args.slice(0, 2).join(' ')}); check its reference, region and operator read access (provider details omitted)`)}
}

export function readExternalRole(aws: Pick<AwsCliRunner, 'json'>, arn: string, region: string): string {
  const role = readAwsResource(aws, ['iam', 'get-role', '--role-name', arn.split('/').at(-1)!], region).Role
  if (!role?.Arn) throw new Error('IAM role metadata is missing its ARN')
  if (role.Arn !== arn) throw new Error('IAM role reference resolves to a different ARN; check its account and path')
  return role.Arn
}

export function readBucketRegion(aws: Pick<AwsCliRunner, 'json'>, bucket: string, region: string): string {
  const location = readAwsResource(aws, ['s3api', 'get-bucket-location', '--bucket', bucket], region).LocationConstraint
  return location === 'EU' ? 'eu-west-1' : location || 'us-east-1'
}
