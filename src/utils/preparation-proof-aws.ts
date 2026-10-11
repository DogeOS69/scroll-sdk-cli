/* eslint-disable @typescript-eslint/no-explicit-any -- AWS CLI discovery responses. */
import * as toml from '@iarna/toml'
import fs from 'node:fs'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'
import type {ProofTopologySpec} from '../types/proof-topology.js'

import {readProofArtifactStore} from './artifact-stores.js'
import {AwsCliRunner} from './aws-cli.js'
import {sanitizeName, truncateIamRoleName} from './kms-signer-provisioner.js'
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

/** Existing-resource mode performs metadata queries only; never creates or repairs resources. */
export function reuseProofAws(root: string, spec: DeploymentSpec, aws = new AwsCliRunner(spec.preparation!.proofAws!.awsProfile)): void {
  const intent = spec.preparation!.proofAws!
  if (intent.action !== 'reuse' || intent.publicReadMode === 'direct-s3') throw new Error('Read-only discovery requires reuse and an existing public delivery mode')
  const infrastructure = spec.infrastructure.aws!
  const shared = readProofArtifactStore(root, '.data/doge-config.toml').store
  const identity = {artifactRegion: shared.region, awsRegion: infrastructure.region, deploymentAlias: spec.metadata.name, eksCluster: infrastructure.eksClusterName!, namespace: spec.infrastructure.namespace ?? 'default'}
  const alias = sanitizeName(identity.deploymentAlias)
  const cluster = sanitizeName(identity.eksCluster)
  const options = {region: identity.awsRegion}
  const account = aws.json(['sts', 'get-caller-identity'], options).Account
  if (!/^\d{12}$/.test(account) || infrastructure.accountId && account !== infrastructure.accountId) throw new Error('Proof AWS account does not match infrastructure.aws.accountId')
  const issuer = aws.json(['eks', 'describe-cluster', '--name', identity.eksCluster], options).cluster?.identity?.oidc?.issuer
  if (typeof issuer !== 'string' || !issuer.startsWith('https://')) throw new Error('Existing EKS cluster has no OIDC issuer')
  const issuerPath = issuer.slice('https://'.length)
  const provider = `arn:aws:iam::${account}:oidc-provider/${issuerPath}`
  aws.json(['iam', 'get-open-id-connect-provider', '--open-id-connect-provider-arn', provider], options)
  aws.json(['s3api', 'head-bucket', '--bucket', shared.bucket, '--expected-bucket-owner', account], {region: shared.region})
  const location = aws.json(['s3api', 'get-bucket-location', '--bucket', shared.bucket], {region: shared.region}).LocationConstraint
  if ((location === 'EU' ? 'eu-west-1' : location || 'us-east-1') !== shared.region) throw new Error('Existing proof bucket region differs from the declared store')
  const coordinatorServiceAccount = spec.proofCoordinator?.serviceAccount?.name ?? 'proof-coordinator'
  const withdrawalServiceAccount = spec.proofCoordinator?.withdrawalProcessorServiceAccount?.name ?? 'withdrawal-processor'
  const getRole = (name: string, serviceAccount: string): string => {
    const role = aws.json(['iam', 'get-role', '--role-name', name], options).Role
    const policy = typeof role?.AssumeRolePolicyDocument === 'string' ? JSON.parse(decodeURIComponent(role.AssumeRolePolicyDocument)) : role?.AssumeRolePolicyDocument
    const statements = Array.isArray(policy?.Statement) ? policy.Statement : [policy?.Statement]
    const contains = (value: unknown, expected: string) => value === expected || Array.isArray(value) && value.includes(expected)
    if (!role?.Arn?.startsWith(`arn:aws:iam::${account}:role/`) || !statements.some((statement: any) => statement?.Effect === 'Allow'
      && contains(statement.Action, 'sts:AssumeRoleWithWebIdentity') && contains(statement.Principal?.Federated, provider)
      && contains(statement.Condition?.StringEquals?.[`${issuerPath}:aud`], 'sts.amazonaws.com')
      && contains(statement.Condition?.StringEquals?.[`${issuerPath}:sub`], `system:serviceaccount:${identity.namespace}:${serviceAccount}`))) throw new Error(`Existing proof role ${name} does not bind the selected EKS service account`)
    return role.Arn
  }

  const coordinatorRoleArn = getRole(intent.coordinatorRoleName ?? truncateIamRoleName(`dogeos-${alias}-${cluster}-proof-coordinator`), coordinatorServiceAccount)
  const withdrawalRoleArn = getRole(intent.withdrawalRoleName ?? truncateIamRoleName(`dogeos-${alias}-${cluster}-wp-proof`), withdrawalServiceAccount)
  const secretName = intent.secretName ?? defaultProofSecretName(alias)
  const secret = aws.json(['secretsmanager', 'describe-secret', '--secret-id', secretName], options)
  if (secret.Name !== secretName || secret.DeletedDate || !Object.values(secret.VersionIdsToStages ?? {}).some(stages => Array.isArray(stages) && stages.includes('AWSCURRENT'))) throw new Error('Existing proof token secret must have a current version and must not be scheduled for deletion')
  writeProofAwsConfig(path.join(root, '.data/proof-aws.json'), buildProofAwsConfig({coordinatorServiceAccount, identity, keyPrefix: shared.keyPrefix, provisioned: {
    artifactReadTransport: {publicEndpointUrl: intent.publicReadMode === 'existing-gateway' ? intent.publicEndpointUrl! : proofArtifactS3Endpoint(shared.region), publicReadMode: intent.publicReadMode, publicStatus: 'operator-managed-unverified'},
    bucket: shared.bucket, bucketCreated: false, coordinatorRoleArn, secretAction: 'reused', secretName, withdrawalRoleArn,
  }, withdrawalServiceAccount}))
}
