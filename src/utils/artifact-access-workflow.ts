import type {ArchiveStoreKind} from './artifact-access.js'

import {applyArtifactAccess, checkArtifactAccess, planArtifactAccess} from './artifact-access.js'
import {readArtifactStore, readOptionalArtifactStore} from './artifact-stores.js'
import {AwsCliRunner} from './aws-cli.js'
import {readOptionalProofAwsConfig} from './proof-aws-config.js'

export interface ArtifactAccessOptions {
  allowBucketPublicPolicy?: boolean; awsProfile?: string; deploymentDir: string; dogeConfig?: string;
  proofAwsConfig?: string; publicRead?: boolean; store: ArchiveStoreKind; vpcEndpointId?: string; writerRoleArn?: string
}

/** Policies are planned once and checked again immediately before writes. */
export function runArtifactAccess(action: 'apply' | 'check' | 'plan', options: ArtifactAccessOptions, aws = new AwsCliRunner(options.awsProfile)) {
  const {store} = readArtifactStore(options.store, options.deploymentDir, options.dogeConfig)
  const proofAws = readOptionalProofAwsConfig(options.deploymentDir, options.proofAwsConfig)?.config
  const vpcEndpointId = options.vpcEndpointId ?? (proofAws?.kubernetes.awsRegion === store.region ? proofAws.artifactReadTransport.vpcEndpoint?.vpcEndpointId : undefined)
  const warnings: string[] = []
  if (!vpcEndpointId) warnings.push(`No S3 Gateway VPC endpoint for ${store.region} recorded or supplied; the existing VPC endpoint read statement is kept and must be usable whenever public read is off`)
  const sidecarStore = options.store === 'da' && options.writerRoleArn ? readOptionalArtifactStore('proof', options.deploymentDir, options.dogeConfig) : undefined
  if (options.store === 'da' && options.writerRoleArn && !sidecarStore) warnings.push('proofArtifacts.s3 is not configured; the DA writer gets no segmentation-sidecar grant')
  const plan = planArtifactAccess(aws, options.store, store, {...options, sidecarStore, vpcEndpointId})
  if (action === 'check') checkArtifactAccess(aws, plan)
  if (action === 'apply') applyArtifactAccess(aws, plan)
  warnings.push('Policy checks do not certify live access: verify unsigned reads of actual objects and writes from the workload; explicit denies, endpoint policies and KMS can still block access.')
  return {action: action === 'apply' ? 'applied' : action === 'check' ? 'checked' : 'plan', plan, warnings}
}
