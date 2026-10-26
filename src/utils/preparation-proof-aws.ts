import * as toml from '@iarna/toml'
import fs from 'node:fs'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'
import type {ProofTopologySpec} from '../types/proof-topology.js'

import {readProofArtifactStore} from './artifact-stores.js'
import {AwsCliRunner} from './aws-cli.js'
import {readAwsResource, readBucketRegion} from './aws-resource-reader.js'
import {awsWorkloadIdentity} from './aws-workload-identity.js'
import {sanitizeName} from './kms-signer-provisioner.js'
import {privateWrite} from './preparation-io.js'
import {buildProofAwsConfig, defaultProofSecretName, readOptionalProofAwsConfig, writeProofAwsConfig} from './proof-aws-config.js'
import {proofArtifactS3Endpoint} from './proof-aws-provisioner.js'
import {assertProofAwsMatchesTopology} from './proof-kubernetes-reconciler.js'

/** Bind derived delivery facts after materialization, including on a resumed charts step. */
export function bindPreparedProofAws(root: string): void {
  const prepared = readOptionalProofAwsConfig(root)
  if (!prepared) return
  const file = path.join(root, '.data/doge-config.toml')
  const config = toml.parse(fs.readFileSync(file, 'utf8'))
  const topology = config.proof_topology as unknown as ProofTopologySpec | undefined
  if (topology?.active?.artifactStore?.kind !== 's3_compatible') return
  const missingEndpoint = topology.deployment.publicS3EndpointUrl === undefined
  if (missingEndpoint) topology.deployment.publicS3EndpointUrl = prepared.config.artifactReadTransport.publicEndpointUrl
  // Explicit intent and store coordinates must still match the provisioned facts.
  assertProofAwsMatchesTopology(topology, prepared.config)
  if (missingEndpoint) privateWrite(file, toml.stringify(config))
}

/** Read existing resource metadata; never change bucket policy, lifecycle or Secret contents. */
export function reuseProofAws(root: string, spec: DeploymentSpec, aws = new AwsCliRunner(spec.preparation!.proofAws!.awsProfile)): void {
  const intent = spec.preparation!.proofAws!
  if (intent.action !== 'reuse' || intent.publicReadMode === 'direct-s3') throw new Error('Read-only discovery requires reuse and an existing public delivery mode')
  const infrastructure = spec.infrastructure.aws!
  const shared = readProofArtifactStore(root, '.data/doge-config.toml').store
  const identity = {artifactRegion: shared.region, awsRegion: infrastructure.region, deploymentAlias: spec.metadata.name, eksCluster: infrastructure.eksClusterName!, namespace: spec.infrastructure.namespace ?? 'default'}
  const alias = sanitizeName(identity.deploymentAlias)
  identity.artifactRegion = readBucketRegion(aws, shared.bucket, shared.region)
  const coordinatorServiceAccount = spec.proofCoordinator?.serviceAccount?.name ?? 'proof-coordinator'
  const withdrawalServiceAccount = spec.proofCoordinator?.withdrawalProcessorServiceAccount?.name ?? 'withdrawal-processor'
  const secretName = intent.secretName ?? defaultProofSecretName(alias)
  const secret = readAwsResource(aws, ['secretsmanager', 'describe-secret', '--secret-id', secretName], identity.awsRegion)
  if (!secret.Name) throw new Error('Secret metadata is missing its name')
  // Bucket policy, retention and Secret contents are owned by the infrastructure/operator workflow.
  writeProofAwsConfig(path.join(root, '.data/proof-aws.json'), buildProofAwsConfig({coordinatorServiceAccount, identity, keyPrefix: shared.keyPrefix, provisioned: {
    artifactReadTransport: {publicEndpointUrl: intent.publicReadMode === 'existing-gateway' ? intent.publicEndpointUrl! : proofArtifactS3Endpoint(identity.artifactRegion), publicReadMode: intent.publicReadMode, publicStatus: 'operator-managed-unverified'},
    bucket: shared.bucket, bucketCreated: false, secretAction: 'reused', secretName: secret.Name,
  }, withdrawalServiceAccount, workloadIdentity: awsWorkloadIdentity(spec)}))
}
