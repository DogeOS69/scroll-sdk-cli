import type {ValidationError} from '../types/deployment-spec.js'

import {deploymentSpecFields} from '../generated/deployment-spec-fields.js'

const derivedProofFields = new Set([
  ...['bucket', 'region', 'keyPrefix', 'endpointUrl', 'forcePathStyle'].map(field => `proofCoordinator.artifactStore.${field}`),
  ...['bucket', 'region', 'keyPrefix', 'endpointUrl', 'forcePathStyle'].map(field => `proofTopology.active.artifactStore.${field}`),
  'proofTopology.deployment.artifactKeyPrefix',
])

/** Role selection inputs: the CLI derives and owns every workload IAM role. */
const removedRoleFields = new Set([
  ...['$.identities.ethDaSubmitter.kms', '$.identities.feeOracle.kms', '$.identities.sequencers[].signer.kms'].flatMap(parent => [`${parent}.roleArn`, `${parent}.serviceAccount`]),
  '$.preparation.archive.writerRoleArn',
  '$.preparation.bridge.production.sequencerKms.roleArn',
  '$.preparation.dstack.aws.controllerRoleName',
  '$.preparation.proofAws.coordinatorRoleName',
  '$.preparation.proofAws.withdrawalRoleName',
])
const movedBridgeFields: Record<string, string> = {
  attestationSigners: 'bridge.attestation.signers',
  'bridge.attestation.initialKeyset': 'bridge.attestation.signers in initial member order and bridge.attestation.threshold',
  'bridge.initialAttestationKeyset': 'bridge.attestation.signers and bridge.attestation.threshold',
  'bridge.keyCounts': 'list lengths (counts are derived)',
  'bridge.teePubkey': 'bridge.cubesigner.publicKey',
  'bridge.thresholds': 'bridge.attestation.threshold and bridge.recovery.threshold',
  'bridge.timelock': 'bridge.recovery.timelock',
  'preparation.bridge.production.recoveryPublicKeys': 'bridge.recovery.publicKeys',
  signing: 'bridge.cubesigner',
}
const removedRoleMessage = 'has been removed; the CLI derives and owns this workload IAM role. Delete the field: setup aws prepares the CLI role, render binds the ServiceAccount to it, and the previously selected role is reported as unreferenced for you to delete after rollout'

export class DeploymentSpecFieldError extends Error {}

/** Field/structure validation only; semantic and required-input checks remain in the generator. */
export function validateDeploymentSpecFields(value: unknown): ValidationError[] {
  const errors: ValidationError[] = []
  const error = (path: string, message: string): void => {
    // Preserve the established error contract for the controller's strict input schema.
    const code = path === 'dstackController' || path.startsWith('dstackController.')
      ? 'E015_INVALID_DSTACK_CONTROLLER_CONFIG' : 'E016_INVALID_SPEC_FIELD'
    errors.push({code, message, path})
  }

  function visit(input: unknown, schemaPath: string, displayPath: string): void {
    if (input === undefined) return
    const shape = deploymentSpecFields[schemaPath]
    if (!shape) {
      if (input !== null && typeof input === 'object') error(displayPath, 'must be a scalar value')
      return
    }

    if (shape.kind === 'array') {
      if (Array.isArray(input)) {input.forEach((item, index) => visit(item, `${schemaPath}[]`, `${displayPath}[${index}]`))}
      else {error(displayPath, 'must be an array')}

      return
    }

    if (!input || typeof input !== 'object' || Array.isArray(input) || input instanceof Date) {
      error(displayPath || '$', 'must be an object')
      return
    }

    for (const [key, item] of Object.entries(input)) {
      const child = displayPath ? `${displayPath}.${key}` : key
      if (shape.kind === 'record') visit(item, `${schemaPath}.*`, child)
      else if (shape.keys?.includes(key)) visit(item, `${schemaPath}.${key}`, child)
      else if (movedBridgeFields[child]) error(child, `has been removed; use ${movedBridgeFields[child]}`)
      else if (removedRoleFields.has(`${schemaPath}.${key}`)) error(child, removedRoleMessage)
      else if (derivedProofFields.has(child)) error(child, 'is derived; configure proof storage only at proofArtifacts.s3')
      else if (child === 'network.l1ChainId') error(child, 'has been removed; select dogecoin.network (mainnet, testnet or regtest) and the L1 chain ID is derived automatically')
      else error(child, child === 'proofSystem' ? 'proofSystem has been removed; use compiler-backed proofTopology' : 'is not a supported DeploymentSpec field')
    }
  }

  visit(value, '$', '')
  const signing = (value as {signing?: {tsoServiceUrl?: unknown}} | null)?.signing
  if (signing?.tsoServiceUrl !== undefined) {
    error('signing.tsoServiceUrl', 'is not supported; configure frontend.hosts.tso for the public signer endpoint. In-cluster services use the internal TSO service address')
  }

  return errors
}

export function assertDeploymentSpecFields(value: unknown): void {
  const errors = validateDeploymentSpecFields(value)
  if (errors.length > 0) throw new DeploymentSpecFieldError(errors.map(({message, path}) => `${path}: ${message}`).join('; '))
}
