/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values use dynamic maps. */
import type {DeploymentSpec} from '../types/deployment-spec.js'

export type AwsWorkloadIdentity = 'irsa' | 'pod-identity'
export const IRSA_ROLE_ANNOTATION = 'eks.amazonaws.com/role-arn'

/** Omitted values preserve existing deployments; new AWS examples select Pod Identity. */
export function awsWorkloadIdentity(spec: DeploymentSpec): AwsWorkloadIdentity {
  const mode = spec.infrastructure.aws?.workloadIdentity ?? 'irsa'
  if (mode !== 'irsa' && mode !== 'pod-identity') throw new Error('infrastructure.aws.workloadIdentity must be irsa or pod-identity')
  return mode
}

export function bindAwsServiceAccount(values: any, name: string, roleArn: string | undefined, mode: AwsWorkloadIdentity = 'irsa'): void {
  values.serviceAccount ??= {}
  values.serviceAccount.create = true
  values.serviceAccount.name = name
  values.serviceAccount.annotations ??= {}
  if (mode === 'pod-identity') delete values.serviceAccount.annotations[IRSA_ROLE_ANNOTATION]
  else if (roleArn) values.serviceAccount.annotations[IRSA_ROLE_ANNOTATION] = roleArn
}
