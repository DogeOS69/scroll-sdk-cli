/* eslint-disable @typescript-eslint/no-explicit-any -- Read-only AWS responses and IAM policy documents. */
import type {DeploymentSpec} from '../types/deployment-spec.js'

import {resolveSpecIdentities} from './spec-identities.js'

/** Stable workload-to-reference mapping; never derive an IAM role name. */
export function externalRoleArn(spec: DeploymentSpec, entry: string): string {
  const {aws} = spec.infrastructure
  const roles = aws?.roles
  const fields: Record<string, keyof NonNullable<typeof roles>> = {'dstack-controller': 'dstackController', 'eth-da-submitter': 'ethDaSubmitter', 'external-secrets': 'externalSecrets', 'fee-oracle': 'feeOracle', 'proof-coordinator': 'proofCoordinator', 'withdrawal-processor': 'withdrawalProcessor'}
  const field = fields[entry]
  const index = /^sequencer-reth-(\d+)$/.exec(entry)?.[1]
  const arn = index === undefined ? field && roles?.[field] : roles?.sequencers?.[index]
  if (typeof arn !== 'string' || !/^arn:aws:iam::\d{12}:role\/[\w+,./=@-]+$/.test(arn) || arn.split(':')[4] !== aws?.accountId) throw new Error(`infrastructure.aws.roles must supply an existing same-account role ARN for ${entry}`)
  return arn
}

export function validateExternalAwsRoles(spec: DeploymentSpec): void {
  const identities = resolveSpecIdentities(spec)
  for (const [field, entry] of [['ethDaSubmitter', 'eth-da-submitter'], ['feeOracle', 'fee-oracle']] as const) if (identities?.[field].backend === 'aws_kms') externalRoleArn(spec, entry)
  for (const node of identities?.sequencers ?? []) if (node.signer.backend === 'aws_kms') externalRoleArn(spec, `sequencer-reth-${node.index}`)
  if (spec.preparation?.proofAws) {
    externalRoleArn(spec, 'proof-coordinator')
    externalRoleArn(spec, 'withdrawal-processor')
  } else if (spec.preparation?.bridge.production?.sequencerKms) externalRoleArn(spec, 'withdrawal-processor')
  if (spec.preparation?.dstack?.mode === 'import' && spec.preparation.dstack.providers?.includes('aws')) externalRoleArn(spec, 'dstack-controller')
  if (spec.infrastructure.aws?.roles?.externalSecrets) externalRoleArn(spec, 'external-secrets')
  for (const [field, entry] of [['serviceAccount', 'proof-coordinator'], ['withdrawalProcessorServiceAccount', 'withdrawal-processor']] as const) {
    const annotation = spec.proofCoordinator?.[field]?.annotations?.['eks.amazonaws.com/role-arn']
    if (annotation && (spec.preparation?.proofAws || entry === 'withdrawal-processor' && spec.preparation?.bridge.production?.sequencerKms) && annotation !== externalRoleArn(spec, entry)) throw new Error(`proofCoordinator.${field} role conflicts with infrastructure.aws.roles`)
  }

  const legacy = spec.preparation?.awsIam
  if (legacy && ['path', 'permissionsBoundaryArn', 'roleNamePrefix', 'tags'].some(field => (legacy as any)[field] !== undefined)) throw new Error('Manage IAM role naming, boundaries and tags in the infrastructure templates; preparation.awsIam now selects only awsProfile')
}
