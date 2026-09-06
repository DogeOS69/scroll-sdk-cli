import * as fs from 'node:fs'
import * as path from 'node:path'

import type {
  ProofArtifactReadTransportResult,
  ProofAwsIdentity,
  ProofAwsProvisionResult,
  ProofAwsValuesProjection,
} from './proof-aws-provisioner.js'

import {
  normalizeProofArtifactPublicEndpoint,
  normalizeProofBucketName,
  normalizeProofKeyPrefix,
  proofArtifactS3Endpoint,
} from './proof-aws-provisioner.js'

export const DEFAULT_PROOF_AWS_CONFIG = '.data/proof-aws.json'
export const LEGACY_SHARED_PROOF_SECRET_NAME = 'scroll/proof-coordinator-secrets'
export const PROOF_AWS_CONFIG_SCHEMA = 'dogeos/proof-aws/v4'

export interface ProofAwsConfig {
  artifactReadTransport: ProofArtifactReadTransportResult
  artifactStore: {
    bucket: string
    keyPrefix: string
    region: string
  }
  kubernetes: {
    awsRegion: string
    deploymentAlias: string
    eksCluster: string
    namespace: string
  }
  schema: typeof PROOF_AWS_CONFIG_SCHEMA
  secret: {
    name: string
    region: string
  }
  serviceAccounts: {
    proofCoordinator: {
      name: string
      roleArn: string
    }
    withdrawalProcessor: {
      name: string
      roleArn: string
    }
  }
}

export interface ProofAwsConfigInput {
  artifactRegion?: string
  coordinatorServiceAccount: string
  identity: ProofAwsIdentity
  keyPrefix: string
  provisioned: ProofAwsProvisionResult
  withdrawalServiceAccount: string
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`)
  }

  return value.trim()
}

export function defaultProofSecretName(normalizedDeploymentAlias: string): string {
  const alias = requiredString(normalizedDeploymentAlias, 'proof AWS deployment alias')
  if (!/^[\da-z](?:[\da-z-]*[\da-z])?$/.test(alias)) {
    throw new Error('proof AWS deployment alias must already be normalized for AWS resource names')
  }

  return `scroll/${alias}/proof-coordinator-secrets`
}

function requiredRoleArn(value: unknown, label: string): string {
  const arn = requiredString(value, label)
  if (!/^arn:aws:iam::\d{12}:role\/[\w+,./=@-]+$/.test(arn)) {
    throw new Error(`${label} must be an AWS IAM role ARN`)
  }

  return arn
}

function normalizeArtifactReadTransport(
  raw: unknown,
  label: string,
): ProofArtifactReadTransportResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`)
  }

  const value = raw as Partial<ProofArtifactReadTransportResult>
  const {publicReadMode} = value
  if (publicReadMode !== 'direct-s3' && publicReadMode !== 'existing-gateway') {
    throw new Error(`${label}.publicReadMode must be direct-s3 or existing-gateway`)
  }

  const expectedStatus = publicReadMode === 'direct-s3'
    ? 'configured-unverified'
    : 'operator-managed-unverified'
  if (value.publicStatus !== expectedStatus) {
    throw new Error(`${label}.publicStatus must be ${expectedStatus} for ${publicReadMode}`)
  }

  const normalized: ProofArtifactReadTransportResult = {
    publicEndpointUrl: normalizeProofArtifactPublicEndpoint(
      requiredString(value.publicEndpointUrl, `${label}.publicEndpointUrl`),
    ),
    publicReadMode,
    publicStatus: expectedStatus,
  }
  if (!value.vpcEndpoint) return normalized

  const vpcEndpointId = requiredString(
    value.vpcEndpoint.vpcEndpointId,
    `${label}.vpcEndpoint.vpcEndpointId`,
  )
  if (!/^vpce-[\da-f]+$/i.test(vpcEndpointId)) {
    throw new Error(`${label}.vpcEndpoint.vpcEndpointId is invalid`)
  }

  if (value.vpcEndpoint.status !== 'configured-unverified') {
    throw new Error(`${label}.vpcEndpoint.status must be configured-unverified`)
  }

  if (typeof value.vpcEndpoint.created !== 'boolean') {
    throw new TypeError(`${label}.vpcEndpoint.created must be a boolean`)
  }

  const routeTableIds = [...new Set((value.vpcEndpoint.routeTableIds || []).map((item, index) => {
    const routeTableId = requiredString(item, `${label}.vpcEndpoint.routeTableIds[${index}]`)
    if (!/^rtb-[\da-f]+$/i.test(routeTableId)) {
      throw new Error(`${label}.vpcEndpoint.routeTableIds[${index}] is invalid`)
    }

    return routeTableId
  }))].sort()
  if (routeTableIds.length === 0) {
    throw new Error(`${label}.vpcEndpoint.routeTableIds must contain at least one route table`)
  }

  return {
    ...normalized,
    vpcEndpoint: {
      created: value.vpcEndpoint.created,
      routeTableIds,
      status: 'configured-unverified',
      vpcEndpointId,
    },
  }
}

export function buildProofAwsConfig(input: ProofAwsConfigInput): ProofAwsConfig {
  const {identity, provisioned} = input
  return {
    artifactReadTransport: normalizeArtifactReadTransport(
      provisioned.artifactReadTransport,
      'proof AWS artifactReadTransport',
    ),
    artifactStore: {
      bucket: normalizeProofBucketName(requiredString(provisioned.bucket, 'proof AWS bucket')),
      keyPrefix: normalizeProofKeyPrefix(input.keyPrefix),
      region: requiredString(input.artifactRegion || identity.artifactRegion || identity.awsRegion, 'proof artifact AWS region'),
    },
    kubernetes: {
      awsRegion: requiredString(identity.awsRegion, 'proof EKS AWS region'),
      deploymentAlias: requiredString(identity.deploymentAlias, 'proof AWS deployment alias'),
      eksCluster: requiredString(identity.eksCluster, 'proof AWS EKS cluster'),
      namespace: requiredString(identity.namespace, 'proof AWS namespace'),
    },
    schema: PROOF_AWS_CONFIG_SCHEMA,
    secret: {
      name: requiredString(provisioned.secretName, 'proof AWS secret name'),
      region: requiredString(identity.awsRegion, 'proof AWS secret region'),
    },
    serviceAccounts: {
      proofCoordinator: {
        name: requiredString(input.coordinatorServiceAccount, 'proof coordinator service account'),
        roleArn: requiredRoleArn(provisioned.coordinatorRoleArn, 'proof coordinator role ARN'),
      },
      withdrawalProcessor: {
        name: requiredString(input.withdrawalServiceAccount, 'withdrawal processor service account'),
        roleArn: requiredRoleArn(provisioned.withdrawalRoleArn, 'withdrawal processor role ARN'),
      },
    },
  }
}

export function validateProofAwsConfig(raw: unknown, label: string): ProofAwsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} must be a JSON object`)
  }

  const value = raw as Partial<ProofAwsConfig>
  if (value.schema !== PROOF_AWS_CONFIG_SCHEMA) {
    throw new Error(`${label}.schema must be ${PROOF_AWS_CONFIG_SCHEMA}`)
  }

  const artifactRegion = requiredString(
    value.artifactStore?.region,
    `${label}.artifactStore.region`,
  )
  const secretRegion = requiredString(value.secret?.region, `${label}.secret.region`)
  const kubernetesRegion = requiredString(value.kubernetes?.awsRegion, `${label}.kubernetes.awsRegion`)
  if (secretRegion !== kubernetesRegion) {
    throw new Error(`${label}.secret.region must match ${label}.kubernetes.awsRegion`)
  }

  const artifactReadTransport = normalizeArtifactReadTransport(
    value.artifactReadTransport,
    `${label}.artifactReadTransport`,
  )
  if (
    artifactReadTransport.publicReadMode === 'direct-s3'
    && artifactReadTransport.publicEndpointUrl !== proofArtifactS3Endpoint(artifactRegion)
  ) {
    throw new Error(
      `${label}.artifactReadTransport.publicEndpointUrl must match artifactStore.region in direct-s3 mode`,
    )
  }

  return buildProofAwsConfig({
    artifactRegion,
    coordinatorServiceAccount: requiredString(
      value.serviceAccounts?.proofCoordinator?.name,
      `${label}.serviceAccounts.proofCoordinator.name`,
    ),
    identity: {
      artifactRegion,
      awsRegion: kubernetesRegion,
      deploymentAlias: requiredString(value.kubernetes?.deploymentAlias, `${label}.kubernetes.deploymentAlias`),
      eksCluster: requiredString(value.kubernetes?.eksCluster, `${label}.kubernetes.eksCluster`),
      namespace: requiredString(value.kubernetes?.namespace, `${label}.kubernetes.namespace`),
    },
    keyPrefix: requiredString(value.artifactStore?.keyPrefix, `${label}.artifactStore.keyPrefix`),
    provisioned: {
      artifactReadTransport,
      bucket: requiredString(value.artifactStore?.bucket, `${label}.artifactStore.bucket`),
      bucketCreated: false,
      coordinatorRoleArn: requiredRoleArn(
        value.serviceAccounts?.proofCoordinator?.roleArn,
        `${label}.serviceAccounts.proofCoordinator.roleArn`,
      ),
      secretAction: 'reused',
      secretName: requiredString(value.secret?.name, `${label}.secret.name`),
      withdrawalRoleArn: requiredRoleArn(
        value.serviceAccounts?.withdrawalProcessor?.roleArn,
        `${label}.serviceAccounts.withdrawalProcessor.roleArn`,
      ),
    },
    withdrawalServiceAccount: requiredString(
      value.serviceAccounts?.withdrawalProcessor?.name,
      `${label}.serviceAccounts.withdrawalProcessor.name`,
    ),
  })
}

export function readProofAwsConfig(
  deploymentDir = '.',
  configPath = DEFAULT_PROOF_AWS_CONFIG,
): {config: ProofAwsConfig; configPath: string} {
  const resolved = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(deploymentDir, configPath)
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `proof AWS config not found: ${resolved}; run scrollsdk setup proof-aws-init first`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'))
  } catch (error) {
    throw new Error(
      `${resolved}: failed to read proof AWS config: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return {config: validateProofAwsConfig(parsed, resolved), configPath: resolved}
}

export function readOptionalProofAwsConfig(
  deploymentDir = '.',
  configPath = DEFAULT_PROOF_AWS_CONFIG,
): {config: ProofAwsConfig; configPath: string} | undefined {
  const resolved = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(deploymentDir, configPath)
  return fs.existsSync(resolved)
    ? readProofAwsConfig(deploymentDir, resolved)
    : undefined
}

export function proofAwsValuesProjection(config: ProofAwsConfig): ProofAwsValuesProjection {
  return {
    artifactRegion: config.artifactStore.region,
    bucket: config.artifactStore.bucket,
    coordinatorRoleArn: config.serviceAccounts.proofCoordinator.roleArn,
    coordinatorServiceAccount: config.serviceAccounts.proofCoordinator.name,
    keyPrefix: config.artifactStore.keyPrefix,
    secretName: config.secret.name,
    secretRegion: config.secret.region,
    withdrawalRoleArn: config.serviceAccounts.withdrawalProcessor.roleArn,
    withdrawalServiceAccount: config.serviceAccounts.withdrawalProcessor.name,
  }
}

export function writeProofAwsConfig(
  filePath: string,
  config: ProofAwsConfig,
): {changed: boolean; config: ProofAwsConfig; filePath: string} {
  const resolved = path.resolve(filePath)
  const normalized = validateProofAwsConfig(config, resolved)
  const rendered = `${JSON.stringify(normalized, null, 2)}\n`
  if (fs.existsSync(resolved) && fs.readFileSync(resolved, 'utf8') === rendered) {
    return {changed: false, config: normalized, filePath: resolved}
  }

  fs.mkdirSync(path.dirname(resolved), {recursive: true})
  const temporary = `${resolved}.tmp-${process.pid}`
  try {
    fs.writeFileSync(temporary, rendered, {mode: 0o644})
    fs.renameSync(temporary, resolved)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }

  return {changed: true, config: normalized, filePath: resolved}
}
